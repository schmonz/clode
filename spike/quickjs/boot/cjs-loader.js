// Gate 4 boot harness — and the SEED of the eventual `node-shim` (the
// sibling of bun-shim.cjs, one layer down): a minimal CommonJS loader for
// txiki that runs clode's .cjs modules (and eventually the bundle) with
// every node builtin stubbed as a throwing Proxy. First touch of any
// missing API throws "WALL: <name>" — the ordered wall log generates
// itself. Structure is kept graduation-ready: one shims registry table,
// one real implementation per entry, no inline hacks. Graduation (move to
// libexec/, tests, wiring) is phase 2 — nothing here is imported by clode.
//
// Corrected against the pinned txiki.js v26.6.0 checkout (spike/quickjs/
// vendor/txiki.js; src/js/core/index.js is the ground truth for what's on
// the `tjs` global — NOT everything a C tjs__mod_*_init() registers ends up
// there, only what index.js's curated `exports` list re-copies):
//   - tjs.args under `tjs run boot/cjs-loader.js <target> [...args]` is
//     [tjsBinaryPath, 'run', <this file>, <target>, ...args] — target is
//     index 3, not 2 (one extra slot for the 'run' subcommand + this file).
//   - tjs.cwd, tjs.exePath, tjs.pid are already-evaluated VALUES (string /
//     number), not functions — index.js copies core's property descriptor
//     as-is, no function wrapping.
//   - tjs.platform does not exist on the global (mod_sys.c's TJS__PLATFORM
//     is set on an internal namespace index.js never re-exports).
//     navigator.platform ('MacIntel' / 'Linux x86_64' / 'Win32' / ...) IS
//     exported (src/js/polyfills/navigator.js) and is the closest real
//     signal, so it's used to derive process.platform.
//   - tjs.stdout / tjs.stderr are WritableStreams (no .write method) — you
//     must tjs.stdout.getWriter() once and call writer.write(bytes).
//   - wallProxy walls on CALL, not on property GET (found at gate 4 rung 3):
//     bun-shim.cjs's very first statement is `const _readSync = fs.readSync;`
//     — a bare property read to save the original before monkey-patching it,
//     never itself invoked. A get-throws proxy treats that read as "touched"
//     and wallStops immediately, which is real but far too pessimistic: it
//     never reveals whether readSync is actually CALLED anywhere reachable.
//     Walling on invocation instead lets read-only/monkey-patch/feature-
//     detection code (common in Bun/Node compat shims) pass through, and a
//     `set` trap on the backing store makes monkey-patches (fs.readSync = fn)
//     stick — so subsequent reads see the override, exactly like real Node.
const walls = [];
function wallProxy(ns) {
  const store = Object.create(null);
  return new Proxy(store, {
    get(target, prop) {
      if (prop === Symbol.toPrimitive || prop === 'then' || prop === Symbol.iterator) return undefined;
      if (prop in target) return target[prop]; // overridden (monkey-patched) or already-vivified
      const name = `${ns}.${String(prop)}`;
      const stub = (...args) => {
        walls.push(`${name}()`);
        throw new Error(`WALL: ${name}() called with ${args.length} arg(s)`);
      };
      target[prop] = stub; // memoize so repeated reads return the same identity
      return stub;
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  });
}

// -- the registry: real shims land here, one per entry; the rest are walls --
const shims = {
  'node:path': null, // real minimal impl below (pure JS, cheap, graduation-grade)
  'node:url': null, // real minimal impl below (fileURLToPath/pathToFileURL over global URL)
  'node:fs': wallProxy('node:fs'),
  'node:os': wallProxy('node:os'),
  'node:child_process': wallProxy('node:child_process'),
  'node:crypto': null, // real minimal impl below (randomUUID over the global WebCrypto; rest still walls)
  'node:zlib': wallProxy('node:zlib'),
  'node:vm': wallProxy('node:vm'),
  'node:module': wallProxy('node:module'),
  'node:sea': wallProxy('node:sea'),
  'node:events': wallProxy('node:events'),
  'node:util': wallProxy('node:util'),
  'node:net': wallProxy('node:net'),
  'node:tty': wallProxy('node:tty'),
  'node:stream': wallProxy('node:stream'),
  'node:v8': wallProxy('node:v8'),
  'node:buffer': wallProxy('node:buffer'),
  'node:process': null, // == the same object every module sees as its `process` param (real Node aliases these too)
};
const P = {
  sep: '/',
  join: (...a) => a.filter(Boolean).join('/').replace(/\/+/g, '/'),
  dirname: (p) => p.replace(/\/+$/, '').replace(/\/[^/]*$/, '') || '/',
  basename: (p) => p.replace(/\/+$/, '').split('/').pop(),
  resolve: (...a) => { let r = tjs.cwd; for (const s of a) r = s.startsWith('/') ? s : r + '/' + s; return P.join(r); },
  isAbsolute: (p) => p.startsWith('/'),
  extname: (p) => { const b = P.basename(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i) : ''; },
};
shims['node:path'] = P;

// Real minimal node:url — just enough for the loader's own prelude/PRELUDE
// callers (require('url').fileURLToPath / .pathToFileURL). Built on the
// global URL, which IS present under tjs (src/js/polyfills/url.js).
const URLMod = {
  URL,
  URLSearchParams,
  fileURLToPath: (u) => {
    const url = typeof u === 'string' ? new URL(u) : u;
    if (url.protocol !== 'file:') throw new TypeError('fileURLToPath: not a file:// URL');
    return decodeURIComponent(url.pathname);
  },
  pathToFileURL: (p) => new URL('file://' + (P.isAbsolute(p) ? p : P.resolve(p))),
};
shims['node:url'] = URLMod;

// Partial real impl of node:crypto: only randomUUID (found as a real, cheap-
// to-shim call-time wall at gate 4 rung 3) is backed by the global WebCrypto
// object (present under tjs, src/js/polyfills/crypto/crypto.js); everything
// else on this module is still a wall (wallProxy's `set` trap lets a plain
// property assignment override just this one method and nothing more).
shims['node:crypto'] = wallProxy('node:crypto');
shims['node:crypto'].randomUUID = () => crypto.randomUUID();

// process.platform: tjs has no direct signal, so derive it from
// navigator.platform (see file-header note above).
function detectPlatform() {
  const np = (typeof navigator !== 'undefined' && navigator.platform) || '';
  if (/^Mac/.test(np)) return 'darwin';
  if (/^Win/.test(np)) return 'win32';
  if (/^Linux/.test(np)) return 'linux';
  if (/FreeBSD/i.test(np)) return 'freebsd';
  if (/OpenBSD/i.test(np)) return 'openbsd';
  return 'linux';
}
const PLATFORM = detectPlatform();

// A single shared process object — every loaded module gets it as its
// `process` wrapper param AND as the result of require('process') /
// require('node:process'), matching real Node (both are the same object;
// found as a gap at gate 4 rung 3 when a bundled sub-module did a bare
// `require('process')` instead of using the ambient global).
const PROC = {
  argv: ['node', ...tjs.args.slice(3)],
  env: new Proxy({}, {
    get: (_, k) => tjs.env[String(k)],
    has: (_, k) => typeof k === 'string' && k in tjs.env,
  }),
  platform: PLATFORM,
  exit: (c) => { flush(); tjs.exit(c ?? 0); },
  versions: { node: '24.0.0-txiki-phase1' },
  stdout: { write: (s) => { writeBytes('out', new TextEncoder().encode(String(s))); return true; } },
  stderr: { write: (s) => { writeBytes('err', new TextEncoder().encode(String(s))); return true; } },
  execPath: tjs.exePath,
  pid: tjs.pid,
  cwd: () => tjs.cwd,
};
shims['node:process'] = PROC;

// Cached WritableStream writers (tjs.stdout/stderr have no .write; you must
// getWriter() once — see file-header note above).
let _stdoutWriter, _stderrWriter;
function writeBytes(which, bytes) {
  if (which === 'out') {
    if (!_stdoutWriter) _stdoutWriter = tjs.stdout.getWriter();
    return _stdoutWriter.write(bytes);
  }
  if (!_stderrWriter) _stderrWriter = tjs.stderr.getWriter();
  return _stderrWriter.write(bytes);
}

// -- static require() preloader ----------------------------------------
// require() inside a loaded module must be SYNCHRONOUS (that's the CJS
// contract), but every txiki I/O call is async. Rather than declare all
// relative/sibling requires a wall, statically scan the source for literal
// `require('./x')` and `require(__dirname + '/x')` calls (the two forms
// actually used by clode's .cjs files and the extracted bundle's prelude)
// and recursively await-load those dependencies BEFORE executing the
// module body — so by the time the body runs, require() for any of those
// ids is a synchronous cache hit. This is a loader capability, not a node
// builtin, so it lives here rather than in the `shims` registry; genuinely
// dynamic requires (a computed id with no static literal, or a bare
// package specifier) still fall through to req() below and wall normally.
const REQUIRE_LITERAL_RE = /\brequire\(\s*(['"])((?:\\.|(?!\1).)*)\1\s*\)/g;
const REQUIRE_DIRNAME_RE = /\brequire\(\s*__dirname\s*\+\s*(['"])((?:\\.|(?!\1).)*)\1\s*\)/g;

// Best-effort: blank out backtick template-literal bodies (same length, so
// offsets aren't needed elsewhere) before scanning for require() calls.
// Without this, a `...` string that merely QUOTES code — e.g.
// extract-claude-js.cjs's PRELUDE constant, which is literal text
// containing `require(__dirname + '/bun-shim.cjs')` destined for the
// *extracted bundle*, not a require this loader should ever execute — reads
// as a real require() to a naive regex scan and wrongly preloads (and runs
// the top-level code of) a file the module never actually requires. Found
// via gate 4 rung 2: this exact false positive eagerly ran libexec/
// bun-shim.cjs and mis-attributed its node:fs.readSync wall to extract-
// claude-js.cjs. Doesn't handle nested `${...}` specially; good enough for
// this corpus (worst case a residual false match fails resolveRelative and
// is silently skipped, or resolves to a real same-named file).
function blankTemplateLiterals(src) {
  return src.replace(/`(?:\\.|[^`\\])*`/g, (m) => ' '.repeat(m.length));
}

// Returns [{ key, rel }] where `key` is the exact string req(id) will be
// called with at runtime, and `rel` is a path (relative to `file`'s
// directory) to resolve on disk. For `require(__dirname + '/x')` these are
// the same string by construction: __dirname is passed to the module body
// as P.dirname(file), so the runtime concatenation and P.join(dirname, rel)
// land on the identical path (P.join collapses the doubled slash).
function staticRequireIds(file, src) {
  const scan = blankTemplateLiterals(src);
  const ids = [];
  let m;
  REQUIRE_DIRNAME_RE.lastIndex = 0;
  while ((m = REQUIRE_DIRNAME_RE.exec(scan))) {
    ids.push({ key: P.dirname(file) + m[2], rel: m[2] });
  }
  REQUIRE_LITERAL_RE.lastIndex = 0;
  while ((m = REQUIRE_LITERAL_RE.exec(scan))) {
    if (m[2].startsWith('.')) ids.push({ key: m[2], rel: m[2] });
  }
  return ids;
}

async function resolveRelative(fromFile, rel) {
  const base = P.join(P.dirname(fromFile), rel);
  const candidates = [base, `${base}.js`, `${base}.cjs`, P.join(base, 'index.js'), P.join(base, 'index.cjs')];
  for (const c of candidates) {
    try { await tjs.stat(c); return c; } catch (_e) { /* try next candidate */ }
  }
  throw new Error(`cannot resolve relative module '${rel}' from '${fromFile}'`);
}

const cache = {};
async function loadCjs(file) {
  if (cache[file]) return cache[file].exports;
  const bytes = await tjs.readFile(file);
  let src = new TextDecoder().decode(bytes);
  // Node's module loader strips a leading shebang line before compiling (so
  // `#!/usr/bin/env node`-headed CJS files, like extract-claude-js.cjs, stay
  // runnable both standalone and via require()). `new Function` does not —
  // QuickJS parses a bare leading `#` as an (invalid) private-name token —
  // so replicate the strip here; this is a loader fix, not a wall.
  if (src.startsWith('#!')) src = src.slice(src.indexOf('\n') + 1);
  const module = { exports: {} };
  cache[file] = module;

  // Preload every statically-literal relative require so req() below can be
  // a synchronous cache lookup when the module body actually runs.
  const localMap = {}; // runtime require() id -> resolved absolute path
  for (const { key, rel } of staticRequireIds(file, src)) {
    if (key in localMap) continue;
    try {
      const abs = await resolveRelative(file, rel);
      await loadCjs(abs);
      localMap[key] = abs;
    } catch (_e) {
      // Leave unresolved — req() will wall on it if the module body actually
      // reaches this require() at runtime (some are behind feature checks).
    }
  }

  const req = (id) => {
    if (id in localMap) return cache[localMap[id]].exports;
    if (id.startsWith('.') || id.startsWith('/')) {
      walls.push(`require(${id}) [unresolved-relative]`);
      throw new Error(`WALL: require(${id}) — not statically preloadable (computed id, or resolve failed)`);
    }
    const key = id.startsWith('node:') ? id : (('node:' + id) in shims ? 'node:' + id : id);
    if (key in shims) return shims[key];
    walls.push(`require(${id})`);
    throw new Error(`WALL: require(${id})`);
  };

  const fn = new Function('exports', 'require', 'module', '__filename', '__dirname', 'process', src);
  fn(module.exports, req, module, file, P.dirname(file), PROC);
  return module.exports;
}

function flush() {
  console.log('--- WALL LOG (first-touch order) ---');
  walls.forEach((w, i) => console.log(`WALL ${i + 1}: ${w}`));
  if (!walls.length) console.log('(no walls hit)');
}

const target = tjs.args[3];
loadCjs(target)
  .then(() => { console.log(`BOOT-OK ${target}`); flush(); })
  .catch((e) => { console.log(`BOOT-STOP ${target}: ${e.message}`); flush(); });
