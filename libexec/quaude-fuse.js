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
//   extras.json: node-side fields (role, bundleVersion, clodeVersion, hooks,
//     template sha, quaude schema) PLUS `deps` — the ext-dep closure to embed.
//     The closure travels as DATA precisely because this worker runs under tjs
//     and cannot require() the node-side module that derives it.
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

// The ext-dep closure: package.json's `dependencies` plus their transitive
// closure, computed by clode-fuse.cjs (node side) and handed here as DATA —
// this worker runs UNDER TJS and cannot require() a shared node module to
// recompute it itself. This used to be a hardcoded list living right here,
// which silently drifted from package.json whenever a dependency was added
// without a matching edit to this file (duplication audit §1: a transitive
// bump or a new direct dep rotted the list identically, with no signal until
// a user hit "Cannot find module" deep in a session). A missing/empty deps
// array means an old clode-fuse.cjs fused this worker — fail loud rather than
// silently ship a quaude with an empty ext-dep closure.
const DEPS = extras.deps;
if (!Array.isArray(DEPS) || DEPS.length === 0) {
  console.error('quaude-fuse: extras.json has no non-empty "deps" array (the ext-dep closure) — built by a stale clode-fuse.cjs?');
  tjs.exit(1);
}

if (role === 'builder') {
  members.push({ name: entryName, data: await mustRead(path.join(stageDir, 'clode-main.bundle.cjs'), 'esbuilt clode-main bundle') });
  // The naude entry point: pre-esbuilt off the user path (Task 4), staged
  // alongside clode-main.bundle.cjs by clode-fuse.cjs's --self staging step.
  // Carried here (not built at naude-assembly time) so a later task can build
  // a naude without esbuild present on the user side.
  members.push({ name: 'naude-entry.bundle.cjs', data: await mustRead(path.join(stageDir, 'naude-entry.bundle.cjs'), 'esbuilt naude-entry bundle') });
  const libexecDir = path.dirname(shimDir);
  // The naude ASSEMBLER: scripts/build-naude.mjs (spawned under the fetched
  // pinned node), its one repo-local require scripts/platform-tag.cjs, and
  // scripts/sea-sign.cjs (which build-naude execs to unsign/re-sign the SEA — on
  // macOS the ad-hoc re-sign after postject is MANDATORY or the binary won't
  // run). A fused builder ships no scripts/ dir, so `clode build --naude` under
  // clode-native materializes these (clode-fuse.cjs's materializeFusedPayload)
  // and spawns the copy. Member names keep their scripts/ path (re-joined onto
  // the payload dir verbatim). Committed files that always exist → mustRead.
  for (const f of ['build-naude.mjs', 'platform-tag.cjs', 'sea-sign.cjs']) {
    members.push({ name: `scripts/${f}`, data: await mustRead(path.join(path.dirname(libexecDir), 'scripts', f), `naude assembler member scripts/${f}`) });
  }
  for (const f of ['bun-shim.cjs', 'extract-claude-js.cjs', 'quaude-fuse.js', 'quaude-bootstrap.mjs', 'host-provision.cjs']) {
    members.push({ name: `libexec/${f}`, data: await mustRead(path.join(libexecDir, f), `libexec member ${f}`) });
  }
  // target-env.cjs member name is BARE (no libexec/ prefix), matching how
  // node-shim/* is stored below: the node-shim loader (SHIM_DIR =
  // '/quaude/node-shim/modules' when fused) requires it via a relative
  // '../../target-env.cjs' from modules/, which only lands on the archive
  // root — a 'libexec/' prefix here would 404 that require. clode-fuse.cjs's
  // materialization step special-cases this bare name back onto disk at
  // libexec/target-env.cjs (sibling to node-shim/, matching this repo's own
  // layout) for the self-fuse path.
  members.push({ name: 'target-env.cjs', data: await mustRead(path.join(libexecDir, 'target-env.cjs'), 'target-env.cjs member') });
  // deps/claude/package.json, member name matches its real repo path (unlike
  // target-env.cjs, no bare-root special-casing needed — clode-fuse.cjs's
  // materialization step just re-joins `mat` + this name verbatim): the ext-dep
  // closure's SOURCE OF TRUTH — Claude Code's runtime deps, NOT clode's own
  // (clode has none). A fused builder ships no repo checkout, so when IT later
  // runs `clode build`, its clode-fuse.cjs needs this manifest on disk to walk
  // `dependencies` from (duplication audit §1 — the closure is derived, never
  // hand-listed).
  members.push({ name: 'deps/claude/package.json', data: await mustRead(path.join(path.dirname(libexecDir), 'deps', 'claude', 'package.json'), 'deps/claude/package.json member') });
  // deps/claude/package-lock.json, same reasoning as package.json just above:
  // the lockfile gate's (assertClosureMatchesLockfile, clode-fuse.cjs) SOURCE
  // OF TRUTH. A fused builder ships no repo checkout, so when it later runs
  // `clode build`, its clode-fuse.cjs needs this on disk to verify
  // node_modules matches the lockfile before embedding.
  members.push({ name: 'deps/claude/package-lock.json', data: await mustRead(path.join(path.dirname(libexecDir), 'deps', 'claude', 'package-lock.json'), 'deps/claude/package-lock.json member') });
  // postject's pure-JS pieces (dist/api.js does the actual SEA-blob inject;
  // dist/cli.js + package.json ride along for completeness) — so a fused
  // builder can eventually assemble a naude without a host esbuild/postject
  // toolchain (mirrors how clode-main.bundle.cjs / naude-entry.bundle.cjs,
  // above, are carried as our-source-only members). Resolved from the
  // checkout's deps/clode/node_modules/postject — the SAME tree
  // `npm ci --prefix deps/clode` populates and scripts/build-naude.mjs's
  // --postject default reads (one code path, two resolutions — checkout vs a
  // future fused-payload materialization — exactly like the deps/claude/
  // package.json member above, which resolves the same way in both cases
  // because libexecDir itself is already rebound upstream).
  //
  // Deliberately NOT a hard requirement yet (unlike deps/claude/package.json,
  // a committed file that must always exist): no CI job runs
  // `npm ci --prefix deps/clode` today — that lands with the fetch/materialize
  // wiring (a later task). A missing directory here just means this fused
  // builder was minted on a host that hasn't provisioned postject, and won't
  // be able to assemble a naude until it is (or until a later task teaches it
  // to fetch one) — skip with a loud warning instead of failing the whole
  // fuse over a capability nothing yet exercises end-to-end.
  const postjectDir = path.join(path.dirname(libexecDir), 'deps', 'clode', 'node_modules', 'postject');
  let postjectPresent = false;
  try { postjectPresent = (await tjs.stat(postjectDir)).isDirectory; } catch { /* not provisioned on this host */ }
  if (postjectPresent) {
    for (const f of ['package.json', 'dist/cli.js', 'dist/api.js']) {
      members.push({
        name: `deps/clode/node_modules/postject/${f}`,
        data: await mustRead(path.join(postjectDir, f), `postject member ${f}`),
      });
    }
  } else {
    console.log(`quaude-fuse: ${postjectDir} not provisioned — carrying no postject (this builder cannot assemble a naude until 'npm ci --prefix deps/clode' has been run somewhere in its lineage)`);
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

  // bun-shim from the extracted stage (version-locked to the bundle by the
  // cache). scripts/build-naude.mjs reads it from this same staged location
  // (stagedBunShim) for the same reason — both build targets bake the shim the
  // bundle was extracted with, never one reached back for from the repo
  // (duplication audit §5: naude used to read REPO/libexec/bun-shim.cjs and
  // agreed with this only by accident, because clode-extract.cjs re-copies the
  // shim over the cached one on every cache hit).
  members.push({ name: 'bun-shim.cjs', data: await mustRead(path.join(stageDir, 'bun-shim.cjs'), 'staged bun-shim') });

  // The env contract the bootstrap applies before booting the bundle.
  // BARE member name (no libexec/ prefix) — see the builder branch's comment
  // above for why: the node-shim loader's fused SHIM_DIR has no 'libexec'
  // ancestor in the archive namespace, so process.cjs's relative require must
  // find this at the archive root.
  members.push({ name: 'target-env.cjs', data: await mustRead(path.join(path.dirname(shimDir), 'target-env.cjs'), 'target-env.cjs member') });
}

// node-shim tree: THE committed loader + modules + internal (the loader's VFS
// seam activates when the bootstrap mounts the archive).
members.push({ name: 'node-shim/loader.cjs', data: await mustRead(path.join(shimDir, 'loader.cjs'), 'node-shim loader') });
await collect(path.join(shimDir, 'modules'), 'node-shim/modules', members);
await collect(path.join(shimDir, 'internal'), 'node-shim/internal', members);

// ext-dep closure (DEPS = extras.deps, derived node-side — see above). The
// node side already fails the build if a listed package is missing from
// node_modules, so this guard is the belt to that braces: it catches a package
// whose dir exists but is EMPTY (nothing collected), which the manifest-only
// check up there cannot see.
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
  // The declared bill of materials, name@version, computed node-side
  // (clode-fuse.cjs's computeDepClosure) and carried verbatim — answers "what
  // is in this quaude?" from manifest.json alone, without cross-referencing
  // package.json + node_modules. Distinct from DEPS (bare names, above,
  // consumed only to collect members) — never itself re-emitted.
  bom: extras.bom,
  // The clode that built this quaude (clode-fuse.cjs's opts.self, rides in via
  // extras.json). Read by the bootstrap (quaude-bootstrap.mjs) to bake
  // CLODE_SELF, so the patched in-app updater can call back to a real builder
  // instead of the baked binary trying (and failing) to rebuild itself.
  builder: extras.builder ?? null,
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
