// quaude fuse worker — the tjs-side half of `clode build` (driven by
// libexec/clode-fuse.cjs). Runs under the SAME tjs binary that becomes the
// quaude template: the runtime-compiles-for-itself rule makes the quickjs
// BC_VERSION/config lockstep automatic (bytecode written by any OTHER build is
// undefined behavior — design memo §6.2).
//
// Usage (spawned by clode-fuse.cjs, not by hand):
//   tjs run quaude-fuse.js <signed-base> <stage-dir> <node-shim-dir> \
//     <node_modules-dir> <bootstrap.mjs> <extras.json> <out>
//
//   signed-base: a COPY of the running tjs template, ALREADY ad-hoc re-signed
//     (sign-then-append discipline: appending invalidates strict Mach-O
//     validation, so signing must happen while the copy is still a plain
//     binary; the kernel only validates mapped code pages, so the fused
//     result executes fine — memo §6.1).
//   stage-dir:   quaude role — the extracted+hooked cache entry (cli.cjs +
//     bun-shim.cjs); builder role — a staging dir with clode-main.bundle.cjs.
//   extras.json: node-side manifest fields (role, bundleVersion, clodeVersion,
//     hooks, template sha, quaude schema).
//
// Output layout (memo §2):
//   [signed-base][members...][index JSON][quaude footer 32B][bootstrap bc][tx1k1.js 12B]
import path from 'tjs:path';

const [signedBase, stageDir, shimDir, nmDir, bootstrapPath, extrasPath, out, templatePath] = tjs.args.slice(3);
if (!out) {
  console.error('usage: tjs run quaude-fuse.js <signed-base> <stage-dir> <node-shim-dir> <node_modules-dir> <bootstrap.mjs> <extras.json> <out> [pristine-template]');
  tjs.exit(64);
}

const enc = new TextEncoder();
const dec = new TextDecoder();

// The ext-dep closure the loader can require at runtime: the shipped deps from
// the root package.json (string-width, strip-ansi, wrap-ansi, semver, ws, yaml,
// buffer) plus their runtime closure (ansi-regex, ansi-styles,
// get-east-asian-width, base64-js, ieee754) — the exact set clode's launch
// path stages via NODE_PATH today.
const DEPS = ['string-width', 'strip-ansi', 'wrap-ansi', 'semver', 'ws', 'yaml',
  'ansi-regex', 'ansi-styles', 'get-east-asian-width', 'buffer', 'base64-js', 'ieee754'];

async function sha256hex(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function mustRead(file, what) {
  try { return await tjs.readFile(file); }
  catch (e) { console.error(`quaude-fuse: cannot read ${what}: ${file} (${e.message ?? e})`); tjs.exit(1); }
}

async function collect(dir, prefix, outArr) {
  for await (const item of await tjs.readDir(dir)) {
    const full = path.join(dir, item.name);
    const rel = `${prefix}/${item.name}`;
    let { isDirectory, isFile } = item;
    if (!isDirectory && !isFile) {
      // SunOS dirents carry no d_type — libuv reports every entry UNKNOWN
      // there, so both flags are false and the walk would silently collect
      // NOTHING (matrix solaris leg, dispatch #7 2026-07-10). stat() the
      // entry instead; on d_type platforms this branch never runs.
      const st = await tjs.stat(full);
      isDirectory = st.isDirectory;
      isFile = st.isFile;
    }
    if (isDirectory) {
      if (item.name === 'node_modules' || item.name === '.bin') continue;
      await collect(full, rel, outArr);
    } else if (isFile && !item.name.startsWith('._') && !item.name.startsWith('.DS_')) {
      outArr.push({ name: rel, data: await tjs.readFile(full) });
    }
  }
}

// Derived IDNA level of THIS build's URL host mapping (manifest field; the
// spike hardcoded it). Full UTS-46 (the pinned ada build) maps fullwidth
// compatibility characters; an ASCII+punycode-passthrough implementation
// (wurl L1') does not.
function deriveIdnaLevel() {
  try { if (new URL('http://ＡＢＣ.example/').hostname === 'abc.example') return 'uts46'; } catch { /* fall through */ }
  try { if (new URL('http://xn--nxasmq6b.example/').hostname === 'xn--nxasmq6b.example') return 'l1'; } catch { /* fall through */ }
  return 'unknown';
}

// ---- 1) members ------------------------------------------------------------
// The extras file (written by clode-fuse.cjs) names the payload ROLE:
//   quaude (default): the product — compiled Claude Code bundle + its runtime.
//   builder: a native clode — the esbuilt clode-main bundle as a SOURCE entry
//     (measured: 65KB, 0.24s boot under tjs — bytecode would force strict mode
//     on the whole esbuild output for no meaningful parse win), plus the
//     libexec support files `clode build` must materialize at fuse time
//     (extractor, bun-shim, this worker, the bootstrap).
// Both roles ship the node-shim tree and the ext-dep closure: the builder needs
// the deps NOT for itself (clode-main imports node builtins only) but as the
// member INPUTS for the quaude it fuses.
const extras = JSON.parse(dec.decode(await mustRead(extrasPath, 'manifest extras')));
const role = extras.role ?? 'quaude';
const entryName = role === 'builder' ? 'clode-main.bundle.cjs' : 'cli.qbc';
const members = [];

if (role === 'builder') {
  members.push({ name: entryName, data: await mustRead(path.join(stageDir, 'clode-main.bundle.cjs'), 'esbuilt clode-main bundle') });
  const libexecDir = path.dirname(shimDir);
  for (const f of ['bun-shim.cjs', 'extract-claude-js.cjs', 'quaude-fuse.js', 'quaude-bootstrap.mjs']) {
    members.push({ name: `libexec/${f}`, data: await mustRead(path.join(libexecDir, f), `libexec member ${f}`) });
  }
  // The PRISTINE tjs template rides along (Q2 Decision 2): a shipped builder
  // must be able to fuse with NOTHING on disk — `clode build` materializes this
  // member when no CLODE_TJS/build-tree template exists. Pristine = the
  // pre-signing bytes, so it matches the manifest's template identity exactly.
  members.push({ name: 'template/tjs', data: await mustRead(templatePath, 'pristine tjs template') });
} else {
  // cli.cjs -> cli.qbc: replicate the loader's ENTRY transforms (shebang strip +
  // dynamic-import rewrite; fixVFlagPropertyEscapes self-gates off for >1MB
  // entries), wrap in the CJS wrapper as a module (=> strict), compile+serialize
  // under this very runtime. Keep the transform set in lockstep with
  // libexec/node-shim/loader.cjs — the transforms are frozen into the bytecode.
  let src = dec.decode(await mustRead(path.join(stageDir, 'cli.cjs'), 'staged bundle'));
  if (src.startsWith('#!')) src = src.slice(src.indexOf('\n') + 1);
  src = src.replace(/(^|[^\w$.])import(\s*\()/g, '$1__tjsDynImport$2');
  const wrapped = 'globalThis.__quaude_entry = function (exports, require, module, __filename, __dirname) {\n' + src + '\n};\n';
  const t0 = performance.now();
  const bc = tjs.engine.serialize(tjs.engine.compile(enc.encode(wrapped), '/quaude/cli.cjs'));
  console.log(`quaude-fuse: compiled cli.cjs -> cli.qbc (${bc.length} bytes, ${(performance.now() - t0).toFixed(0)}ms)`);
  members.push({ name: 'cli.qbc', data: bc });

  // bun-shim from the extracted stage (version-locked to the bundle by the cache).
  members.push({ name: 'bun-shim.cjs', data: await mustRead(path.join(stageDir, 'bun-shim.cjs'), 'staged bun-shim') });
}

// node-shim tree: THE committed loader + modules + internal (the loader's VFS
// seam activates when the bootstrap mounts the archive).
members.push({ name: 'node-shim/loader.cjs', data: await mustRead(path.join(shimDir, 'loader.cjs'), 'node-shim loader') });
await collect(path.join(shimDir, 'modules'), 'node-shim/modules', members);
await collect(path.join(shimDir, 'internal'), 'node-shim/internal', members);

// ext-dep closure.
for (const dep of DEPS) {
  const before = members.length;
  try { await collect(path.join(nmDir, dep), `node_modules/${dep}`, members); }
  catch { /* missing dir caught below */ }
  if (members.length === before) {
    console.error(`quaude-fuse: dependency '${dep}' not found under ${nmDir} (run clode once, or npm install)`);
    tjs.exit(1);
  }
}

// ---- 2) manifest (single hashing pass: these shas feed BOTH the manifest and
// the index; the index stays authoritative for offsets, the manifest is the
// attestation identity) --------------------------------------------------------
const memberShas = {};
for (const m of members) {
  m.sha256 = await sha256hex(m.data);
  memberShas[m.name] = { len: m.data.length, sha256: m.sha256 };
}
const manifest = {
  quaude: extras.quaude,
  role,
  entry: entryName,
  bundleVersion: extras.bundleVersion,
  clodeVersion: extras.clodeVersion,
  engine: { ...tjs.engine.versions },
  idna: deriveIdnaLevel(),
  template: extras.template,
  hooks: extras.hooks,
  fusedAt: new Date().toISOString(),
  members: memberShas,
};
const manifestData = enc.encode(JSON.stringify(manifest, null, 2) + '\n');
members.push({ name: 'manifest.json', data: manifestData, sha256: await sha256hex(manifestData) });

// ---- 3) assemble -------------------------------------------------------------
const exe = await mustRead(signedBase, 'signed template copy');
let off = exe.length;
const chunks = [exe];
const index = { version: 0, members: [] };
for (const m of members) {
  index.members.push({ name: m.name, offset: off, len: m.data.length, sha256: m.sha256 });
  chunks.push(m.data);
  off += m.data.length;
}
const indexBytes = enc.encode(JSON.stringify(index));
const indexOff = off;
chunks.push(indexBytes); off += indexBytes.length;

const footer = new Uint8Array(32);
footer.set(enc.encode('QAUDEv0\0'), 0);
const fdv = new DataView(footer.buffer);
fdv.setBigUint64(8, BigInt(indexOff), true);
fdv.setBigUint64(16, BigInt(indexBytes.length), true);
chunks.push(footer); off += 32;

// Bootstrap bytecode, compiled by THIS runtime (same lockstep rule as cli.qbc).
const bootBc = tjs.engine.serialize(tjs.engine.compile(await mustRead(bootstrapPath, 'bootstrap'), '<quaude-boot>'));
const bcOffset = off;
if (bcOffset > 0xFFFFFFFF) { console.error('quaude-fuse: bootstrap offset exceeds the tx1k1 u32 trailer limit (4GiB)'); tjs.exit(1); }
chunks.push(bootBc); off += bootBc.length;

const tx = new Uint8Array(12);
tx.set(enc.encode('tx1k1.js'), 0);
new DataView(tx.buffer).setUint32(8, bcOffset, true);
chunks.push(tx); off += 12;

const total = new Uint8Array(off);
{ let o = 0; for (const c of chunks) { total.set(c, o); o += c.length; } }
await tjs.writeFile(out, total, { mode: 0o755 });
console.log(`quaude-fuse: wrote ${out} (${total.length} bytes, ${members.length} members, index ${indexBytes.length}B, bootstrap ${bootBc.length}B)`);
