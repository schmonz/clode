// quaude first-stage bootstrap. Compiled to quickjs bytecode at fuse time
// (libexec/clode-fuse.cjs -> libexec/quaude-fuse.js) and appended to a copy of
// the tjs binary under the stock `tx1k1.js` 12-byte trailer, so the UNMODIFIED
// pinned tjs runs it at startup, before any CLI parsing (txiki's standalone
// detection in run-main). ES module (=> strict), no imports.
//
// Fused-file layout (all offsets absolute file coordinates):
//   [tjs binary, ad-hoc signed BEFORE anything is appended]
//   [member data ...]
//   [index JSON: {version, members:[{name, offset, len, sha256}]}]
//   [quaude footer, 32B: "QAUDEv0\0" + u64LE indexOff + u64LE indexLen + 8B zero]
//   [this bootstrap, as serialized quickjs bytecode]
//   [tx1k1.js trailer, 12B: "tx1k1.js" + u32LE offset-of-bootstrap-bytecode]
//
// Responsibilities: locate + parse the archive; boot-verify the manifest +
// loader members (cheap; FULL verification of every member is
// --quaude-attest's job — policy per the Q1a design memo §5); for the quaude
// role, carve --quaude-* out of argv BEFORE any bundle-visible code runs (the
// reserved namespace — everything else belongs to Claude Code), while the
// BUILDER role (a fused native clode) owns its whole argv and gets no carve;
// mount globalThis.__quaudeVFS; evaluate the archived node-shim loader, which
// boots the manifest's entry member (cli.qbc for quaude, the esbuilt
// clode-main bundle for the builder).

// The reserved argv namespace. quaude owns every `--quaude-*` flag; an unknown
// one is an ERROR here (it must never reach the bundle). Pure + exported so the
// carve is unit-testable under host node (test/quaude-argv.test.cjs).
export const QUAUDE_FLAGS = ['--quaude-attest'];
export function carveQuaudeArgs(args, known = QUAUDE_FLAGS) {
  const quaude = [], rest = [], unknown = [];
  for (const a of args) {
    if (typeof a === 'string' && a.startsWith('--quaude-')) {
      (known.includes(a) ? quaude : unknown).push(a);
    } else rest.push(a);
  }
  return { quaude, rest, unknown };
}

async function sha256hex(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

// tjs -> node spelling. Same mapping the node-shim's detectPlatform uses
// (libexec/node-shim/modules/process.cjs:46); tjs.system.platform is EMPTY, so
// navigator.userAgentData.platform is the only source this early.
function tjsPlatform(uaPlatform) {
  switch (uaPlatform) {
    case 'macOS': return 'darwin';
    case 'Windows': return 'win32';
    case 'Linux': return 'linux';
    case 'FreeBSD': return 'freebsd';
    case 'OpenBSD': return 'openbsd';
    default: return uaPlatform ? String(uaPlatform).toLowerCase() : 'linux';
  }
}

// The env contract every built target applies to itself. ASYNC because tjs has
// no statSync: probe every candidate target-env can ask about (probePaths), then
// answer synchronously from the result. Exported + primitive-injected so it
// unit-tests under host node — the file's existing carveQuaudeArgs pattern.
export async function bootstrapTargetEnv(tjs, opts) {
  const {
    builder,
    shape = globalThis.__clodeShapeTargetEnv,
    probe = globalThis.__clodeProbePaths,
    uaPlatform = (typeof navigator !== 'undefined' && navigator.userAgentData && navigator.userAgentData.platform),
  } = opts;
  const platform = tjsPlatform(uaPlatform);
  const delimiter = platform === 'win32' ? ';' : ':';
  const sep = platform === 'win32' ? '\\' : '/';

  const present = new Set();
  for (const p of probe({ env: tjs.env, platform, delimiter })) {
    try { await tjs.stat(p); present.add(p); } catch { /* absent */ }
  }

  return shape({
    env: tjs.env,
    self: builder,
    platform,
    delimiter,
    exists: (p) => present.has(p),
    dirname: (p) => { const i = p.lastIndexOf(sep); return i <= 0 ? sep : p.slice(0, i); },
  });
}

async function main() {
  const dec = new TextDecoder();
  const die = (msg, code) => { console.error(`quaude: ${msg}`); tjs.exit(code); };

  const exef = await tjs.open(tjs.exePath, 'rb');
  const exeSize = (await exef.stat()).size;

  // 1) tx1k1 trailer -> where our bootstrap bytecode starts.
  const trailer = new Uint8Array(12);
  await exef.read(trailer, exeSize - 12);
  if (dec.decode(trailer.subarray(0, 8)) !== 'tx1k1.js') die('missing tx1k1.js trailer (not a fused binary?)', 70);
  const bcOffset = new DataView(trailer.buffer, 8, 4).getUint32(0, true);

  // 2) quaude footer: the 32 bytes immediately before the bootstrap bytecode.
  const footer = new Uint8Array(32);
  await exef.read(footer, bcOffset - 32);
  if (dec.decode(footer.subarray(0, 8)) !== 'QAUDEv0\0') die('bad archive footer magic', 70);
  const fdv = new DataView(footer.buffer);
  const indexOff = Number(fdv.getBigUint64(8, true));
  const indexLen = Number(fdv.getBigUint64(16, true));

  // 3) index.
  const indexBuf = new Uint8Array(indexLen);
  await exef.read(indexBuf, indexOff);
  const index = JSON.parse(dec.decode(indexBuf));

  // 4) members (eager read; lazy/mmap is a rung-2 optimization).
  const files = new Map();
  for (const m of index.members) {
    const buf = new Uint8Array(m.len);
    await exef.read(buf, m.offset);
    files.set(m.name, buf);
  }
  await exef.close();

  // 5) boot-verify (fast integrity gate): the manifest we are about to trust
  // and the loader we are about to evaluate must hash to what the index
  // promises. Full per-member verification runs on --quaude-attest only
  // (design memo §5 policy).
  for (const name of ['manifest.json', 'node-shim/loader.cjs']) {
    const m = index.members.find((x) => x.name === name);
    if (!m || !files.get(name)) die(`archive is missing ${name}`, 70);
    if ((await sha256hex(files.get(name))) !== m.sha256) die(`${name} failed integrity check (corrupt fuse?)`, 70);
  }

  // 6) role (manifest, just verified): quaude reserves the --quaude-* argv
  // namespace; the BUILDER role (a fused native clode, Q1c) owns its whole
  // argv — clode's own flags are all --clode-*/subcommands, so nothing is
  // carved and there is no --quaude-attest short-circuit for it.
  const manifest = JSON.parse(dec.decode(files.get('manifest.json')));
  let rest = tjs.args.slice(1);
  if ((manifest.role ?? 'quaude') !== 'builder') {
    // argv carve-out: strip --quaude-* BEFORE any bundle code can observe argv.
    const { quaude, rest: carved, unknown } = carveQuaudeArgs(rest);
    if (unknown.length) {
      die(`unknown option '${unknown[0]}' (the --quaude-* namespace is reserved; known: ${QUAUDE_FLAGS.join(', ')})`, 64);
    }
    rest = carved;

    // 7) --quaude-attest: manifest verbatim, then recompute EVERY member hash
    // from the trailer being executed and compare against the index.
    if (quaude.includes('--quaude-attest')) {
      console.log(dec.decode(files.get('manifest.json')).replace(/\n$/, ''));
      let ok = true;
      for (const m of index.members) {
        const got = await sha256hex(files.get(m.name));
        if (got !== m.sha256) ok = false;
        console.log(`${got === m.sha256 ? 'ok  ' : 'FAIL'} ${m.name} (${m.len} bytes)`);
      }
      console.log(ok ? 'quaude-attest: all members verified' : 'quaude-attest: VERIFICATION FAILED');
      tjs.exit(ok ? 0 : 1);
    }
  }

  // 7.5) Apply the target env contract before ANY bundle code runs. target-env.cjs
  // is a member: evaluate it the same way the loader is evaluated below (it is
  // CJS, so hand it a module shim), then adapt it to tjs primitives.
  const tem = { exports: {} };
  (0, new Function('module', 'exports', dec.decode(files.get('libexec/target-env.cjs'))))(tem, tem.exports);
  globalThis.__clodeShapeTargetEnv = tem.exports.shapeTargetEnv;
  globalThis.__clodeProbePaths = tem.exports.probePaths;
  await bootstrapTargetEnv(tjs, { builder: manifest.builder || null });

  // 8) mount + boot: the archived loader resolves everything under /quaude/;
  // the manifest rides along so the loader picks the role's entry member.
  globalThis.__quaudeVFS = { files, index, manifest };
  globalThis.__quaudeArgs = rest;
  // Pre-load tjs:sqlite for the node-shim's node:sqlite provider (which bun:sqlite
  // maps onto): node's DatabaseSync is sync but import('tjs:sqlite') is async, so
  // await it HERE (before the loader boots the cli) and stash the module;
  // node-shim/modules/sqlite.cjs reads it sync. Non-fatal — a build without
  // tjs:sqlite just leaves node:sqlite (and bun:sqlite) fail-loud on use.
  try { globalThis.__clodeTjsSqlite = await import('tjs:sqlite'); } catch (_) { /* no sqlite in this engine */ }
  (0, new Function(dec.decode(files.get('node-shim/loader.cjs'))))();
}

// Under tjs (the fused binary) run; under host node (unit tests importing the
// carve function) do nothing.
if (globalThis.tjs) await main();
