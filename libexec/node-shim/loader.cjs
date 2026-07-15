'use strict';
/* node-shim loader — the CommonJS host for running clode's toolchain (and,
 * in M2+, the extracted bundle) under txiki. Graduated from
 * spike/quickjs/boot/cjs-loader.js (gate 4). Contract:
 *   tjs run libexec/node-shim/loader.cjs <entry.cjs> [args...]
 * Builtins resolve lazily from ./modules/<name>.cjs; anything absent is a
 * throwing wallProxy: `node-shim: <name>.<prop> not implemented`.
 * Ordering: process + globals are wired BEFORE any module loads; modules may
 * therefore use globalThis.process freely.
 *
 * tjs.args layout (verified empirically against the pinned tjs v26.6.0
 * binary AND against gate 4's spike/quickjs/boot/cjs-loader.js, which
 * documents the same finding): under `tjs run <this file> <entry> [args]`,
 *   tjs.args = [tjsBinaryPath, 'run', <this file>, <entry>, ...args]
 *                 [0]           [1]      [2]         [3]      [4:]
 * So the loader's own path is tjs.args[2] (used to derive SHIM_DIR), the
 * entry is tjs.args[3], and extra argv is tjs.args.slice(4).
 *
 * Also verified empirically (differs from a naive Node-alike assumption):
 *   - tjs.cwd, tjs.exePath, tjs.pid are already-evaluated VALUES, not
 *     functions.
 *   - tjs.platform does not exist; navigator.platform ('MacIntel' / 'Linux
 *     x86_64' / 'Win32' / ...) is the real signal (used in modules/process.cjs).
 *   - tjs.stdout / tjs.stderr are WritableStreams with no .write method; you
 *     must tjs.stdout.getWriter() once and call writer.write(bytes) (used in
 *     modules/process.cjs).
 */

const FSS = globalThis.__tjs_fs_sync;
if (!FSS) { console.error('node-shim: this tjs lacks the sync-fs patch (run scripts/build-tjs.mjs)'); tjs.exit(2); }

/* ---- tiny path helpers (self-contained; modules/path.cjs is the real one).
 * Windows: the non-fused loader derives SHIM_DIR/entryAbs from real C:\ paths
 * (tjs.args), so P must accept drive/UNC/backslash and preserve the drive.
 * VFS paths (/quaude/...) never contain \ or a drive, so the fused path is
 * untouched. process isn't built yet here — detect Windows via navigator, the
 * same signal modules/process.cjs uses. Markers delimit the block for the
 * extraction unit test (test/win-shim-guards.test.cjs). */
/* @loader-paths-start */
const IS_WIN = (() => {
  const nav = (typeof navigator !== 'undefined' && navigator) || {};
  const ua = (nav.userAgentData && nav.userAgentData.platform) || nav.platform || '';
  return ua === 'Windows' || /^Win/.test(ua);
})();
const toSlash = IS_WIN ? (s) => String(s).replace(/\\/g, '/') : (s) => String(s);
const NODE_PATH_DELIM = IS_WIN ? ';' : ':';
const P = {
  isAbs: (p) => IS_WIN
    ? /^([a-zA-Z]:[\\/]|[\\/]{2}|[\\/])/.test(p)
    : p.startsWith('/'),
  dirname: (p) => { const s = toSlash(p).replace(/\/+$/, ''); const i = s.lastIndexOf('/'); return i > 0 ? s.slice(0, i) : i === 0 ? '/' : '.'; },
  join: (...a) => toSlash(a.filter(Boolean).join('/')).replace(/\/{2,}/g, '/'),
  normalize(p) {
    p = toSlash(p);
    let drive = '';
    if (IS_WIN) { const m = /^([a-zA-Z]:)/.exec(p); if (m) { drive = m[1]; p = p.slice(drive.length); } }
    const rooted = p.startsWith('/');
    const abs = rooted || (!drive && P.isAbs(p));
    const out = [];
    for (const seg of p.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else if (!abs) out.push('..'); }
      else out.push(seg);
    }
    const body = out.join('/');
    const root = drive + (rooted ? '/' : '');
    return (root + body) || (root || (abs ? '/' : '.'));
  },
  resolve: (...a) => {
    let r = toSlash(tjs.cwd);
    for (const s of a) r = P.isAbs(s) ? toSlash(s) : r + '/' + toSlash(s);
    return P.normalize(r);
  },
};
/* @loader-paths-end */

/* ---- quaude VFS seam ---------------------------------------------------------
 * When this loader boots inside a FUSED quaude binary, the first-stage bootstrap
 * (libexec/quaude-bootstrap.mjs) has already read the archive appended to the
 * executable and mounted it as globalThis.__quaudeVFS = { files: Map(relName ->
 * Uint8Array), index } BEFORE evaluating this file. Every path under /quaude/
 * then resolves from the archive; everything else falls through to the real fs.
 * With no VFS mounted (`tjs run loader.cjs <entry>`), __QVFS is null and every
 * seam below is a no-op — behavior is byte-identical to the unfused loader
 * (regression net: the whole node-shim suite). Tests: test/node-shim-vfs.test.cjs. */
const __QVFS = globalThis.__quaudeVFS || null;
function __vfsGet(p) {
  if (!__QVFS || typeof p !== 'string' || !p.startsWith('/quaude/')) return null;
  return __QVFS.files.get(p.slice(8)) ?? null;
}

/* ---- read file as utf8 via sync fs */
const td = new TextDecoder();
function readTextSync(file) {
  const vb = __vfsGet(file);
  if (vb) return td.decode(vb);
  const fd = FSS.open(file, 'r');
  try {
    const size = FSS.fstat(fd).size;
    const chunks = []; let got = 0;
    while (got < size) {
      const ab = FSS.read(fd, Math.min(1 << 20, size - got), got);
      if (ab.byteLength === 0) break;
      chunks.push(new Uint8Array(ab)); got += ab.byteLength;
    }
    const all = new Uint8Array(got); let o = 0;
    for (const c of chunks) { all.set(c, o); o += c.length; }
    return td.decode(all);
  } finally { FSS.close(fd); }
}
function existsFileSync(p) { if (__vfsGet(p)) return true; try { return FSS.stat(p).kind === 'file'; } catch { return false; } }

/* ---- read file as bytes via sync fs (or the VFS) — for .qbc bytecode entries */
function readBinSync(file) {
  const vb = __vfsGet(file);
  if (vb) return vb;
  const fd = FSS.open(file, 'r');
  try {
    const size = FSS.fstat(fd).size;
    const all = new Uint8Array(size); let got = 0;
    while (got < size) {
      const ab = FSS.read(fd, Math.min(1 << 20, size - got), got);
      if (ab.byteLength === 0) break;
      all.set(new Uint8Array(ab), got); got += ab.byteLength;
    }
    return all.subarray(0, got);
  } finally { FSS.close(fd); }
}

/* ---- wall proxy */
function wallProxy(ns) {
  return new Proxy({}, {
    get(_, prop) {
      // Interop/introspection probes must read as a plain CJS module would (a
      // real builtin has no __esModule and no Symbol.toStringTag), so ESM-interop
      // helpers (`__toESM`) and Promise-unwrapping don't trip the wall on a
      // module that is merely CAPTURED but never CALLED on this path. Any real
      // API access still walls loudly.
      if (prop === Symbol.toPrimitive || prop === 'then' || prop === Symbol.iterator
          || prop === 'default' || prop === '__esModule' || prop === Symbol.toStringTag) return undefined;
      if (globalThis.process?.env?.CLODE_SHIM_TRACE) { try { console.error('[wall]', ns + '.' + String(prop)); } catch { /* best effort */ } }
      throw new Error(`node-shim: ${ns}.${String(prop)} not implemented`);
    },
  });
}

/* ---- property-granular wall for SEALED builtins ------------------------------
 * A sealed builtin has a small, fully-enumerated surface: a GET of an
 * unimplemented string key throws the branded wall instead of returning
 * undefined (M2 entry gate #1). Introspection/interop keys are allowlisted so
 * Promise-unwrapping, ESM interop, and console.log don't trip the wall. Only
 * curated tiny shims opt in (SEALED) — broad modules keep Node's missing-prop
 * = undefined idiom, which the bundle's feature-detection depends on. */
const SEALED = new Set(['module', 'vm']);
const SEAL_ALLOW = new Set(['then', 'default', '__esModule', 'constructor', 'prototype',
  'toJSON', 'toString', 'valueOf', 'inspect', Symbol.toPrimitive, Symbol.iterator,
  Symbol.toStringTag, Symbol.for('nodejs.util.inspect.custom')]);
function sealSurface(ns, exportsVal) {
  return new Proxy(exportsVal, {
    get(target, prop) {
      if (prop in target || SEAL_ALLOW.has(prop) || typeof prop === 'symbol') return target[prop];
      if (globalThis.process?.env?.CLODE_SHIM_TRACE) { try { console.error('[wall]', ns + '.' + String(prop)); } catch { /* best effort */ } }
      throw new Error(`node-shim: ${ns}.${String(prop)} not implemented`);
    },
  });
}

/* ---- builtin registry (lazy) */
const SHIM_DIR = __QVFS
  ? '/quaude/node-shim/modules'                                // fused: shims are archive members
  : P.join(P.dirname(P.resolve(tjs.args[2] ?? '')), 'modules'); // loader.cjs lives beside modules/
const builtinCache = new Map();
const KNOWN = ['assert','buffer','child_process','crypto','events','fs','fs/promises','module','net','os','path','path/win32','path/posix','process','stream','stream/consumers','stream/promises','string_decoder','tls','tty','url','util','v8','vm','zlib','sea','readline','http','https','dgram','worker_threads','async_hooks','inspector','constants','querystring','timers','timers/promises','dns','dns/promises','http2','perf_hooks','diagnostics_channel','sqlite'];
function loadBuiltin(name) {
  if (builtinCache.has(name)) return builtinCache.get(name);
  // Builtin subpaths (`<mod>/<sub>`: fs/promises, timers/promises, path/win32,
  // path/posix) live in <mod>.cjs and expose the sub-surface as the module's
  // `.<sub>` export — the same shape Node uses (path.win32, fs.promises, ...).
  const slash = name.indexOf('/');
  const base = slash === -1 ? name : name.slice(0, slash);
  const sub = slash === -1 ? null : name.slice(slash + 1);
  const file = P.join(SHIM_DIR, `${base}.cjs`);
  let exportsVal;
  if (existsFileSync(file)) {
    const mod = evalModule(file);
    exportsVal = sub ? mod[sub] : mod;
  } else {
    exportsVal = wallProxy(name);
  }
  if (SEALED.has(name) && exportsVal && typeof exportsVal === 'object') {
    exportsVal = sealSurface(name, exportsVal);
  }
  builtinCache.set(name, exportsVal);
  return exportsVal;
}

/* ---- CJS module machinery */
const moduleCache = new Map();
// Node semantics: require.main is the ENTRY module object, shared across every
// require(). The entry sees require.main === module; a required child sees
// require.main !== module. extract-claude-js.cjs gates main() on exactly this.
let mainModule = null;
function resolveRequest(request, fromDir) {
  const bare = request.startsWith('node:') ? request.slice(5) : request;
  if (KNOWN.includes(bare)) return { builtin: bare };
  if (request.startsWith('./') || request.startsWith('../') || P.isAbs(request)) {
    const base = P.isAbs(request) ? P.normalize(request) : P.normalize(P.join(fromDir, request));
    for (const c of [base, base + '.js', base + '.cjs', base + '.json', P.join(base, 'index.js'), P.join(base, 'index.cjs')]) {
      if (existsFileSync(c)) return { file: c };
    }
    throw new Error(`node-shim: cannot resolve '${request}' from ${fromDir}`);
  }
  // bare specifier: walk up node_modules, then NODE_PATH roots (the dep store).
  const roots = [];
  let dir = fromDir;
  for (;;) { roots.push(P.join(dir, 'node_modules')); const p = P.dirname(dir); if (p === dir) break; dir = p; }
  for (const r of (globalThis.process && process.env.NODE_PATH || '').split(NODE_PATH_DELIM)) if (r) roots.push(r);
  for (const nm of roots) {
    const pkgDir = P.join(nm, request);
    const pkgJson = P.join(pkgDir, 'package.json');
    if (existsFileSync(pkgJson)) {
      const main = JSON.parse(readTextSync(pkgJson)).main || 'index.js';
      const entry = P.normalize(P.join(pkgDir, main));
      for (const c of [entry, entry + '.js', entry + '.cjs', P.join(entry, 'index.js')]) if (existsFileSync(c)) return { file: c };
    }
    for (const c of [P.join(pkgDir, 'index.js'), P.join(pkgDir, 'index.cjs')]) if (existsFileSync(c)) return { file: c };
  }
  throw new Error(`node-shim: cannot resolve package '${request}' from ${fromDir}`);
}

// The canonical resolver: builtin | json | evaluated CJS. Exposed so
// modules/module.cjs can implement Module._load over it, and so require()
// routes through the CURRENT Module._load (a monkeypatch therefore intercepts).
function moduleLoad(request, fromDir) {
  const r = resolveRequest(request, fromDir);
  if (r.builtin) return loadBuiltin(r.builtin);
  if (r.file.endsWith('.json')) return JSON.parse(readTextSync(r.file));
  return evalModule(r.file);
}

function makeRequire(fromDir) {
  const req = (request) => {
    // Route through Module._load so a monkeypatch (bun-shim's bun:ffi/ws/undici
    // hook) intercepts. module.cjs's _load calls back into moduleLoad for the
    // real resolution; before module.cjs loads, __nodeShim.moduleLoad is the
    // resolver directly (bootstrap: require('module') itself must not recurse).
    const M = builtinCache.get('module');
    if (M && typeof M._load === 'function' && request !== 'module' && request !== 'node:module') {
      return M._load(request, { filename: P.join(fromDir, '<require>') }, false);
    }
    return moduleLoad(request, fromDir);
  };
  req.resolve = (request) => {
    const r = resolveRequest(request, fromDir);
    return r.builtin ? `node:${r.builtin}` : r.file;
  };
  // Live getter: mainModule is null until the entry module object is created,
  // so every require() (whenever called) observes the same entry module.
  Object.defineProperty(req, 'main', { configurable: true, enumerable: true, get: () => mainModule });
  return req;
}

/* ---- minimal ESM -> CJS transpile -------------------------------------------
 * The bundle's text-rendering deps (string-width / strip-ansi / wrap-ansi and
 * their graph: ansi-regex, get-east-asian-width, ansi-styles) are ESM-only
 * (package "type":"module"). Host node's require() loads ESM; this loader's
 * new Function() host does not. Rather than a full ESM engine, transpile the
 * static import/export forms these well-behaved (Prettier-formatted, no TLA, no
 * import.meta) packages use into CJS. Validated against the real packages: the
 * transpiled string-width/strip-ansi/wrap-ansi produce byte-identical results
 * (test/node-shim-esm.test.cjs). NOT a general ESM implementation — dynamic
 * import(), top-level await, live-binding re-exports, and import.meta are NOT
 * handled; a module needing them is a genuine later wall. */
function esmDetect(src) {
  return /(^|\n)[ \t]*export\s+(default|const|let|var|function|class|\{|async|\*)/.test(src)
    || /(^|\n)[ \t]*import\s+[\s\S]*?from\s*['"]/.test(src)
    || /(^|\n)[ \t]*import\s*['"]/.test(src);
}
let _esmN = 0;
function esmCompileImport(clause, spec) {
  clause = clause.trim();
  const req = `require(${JSON.stringify(spec)})`;
  if (clause.startsWith('* as ')) return `const ${clause.slice(5).trim()} = ${req};`;
  const id = `__esm_${_esmN++}`;
  const braceIdx = clause.indexOf('{');
  let def = null, named = null;
  if (braceIdx === -1) { def = clause.trim(); }
  else {
    const before = clause.slice(0, braceIdx).replace(/,\s*$/, '').trim();
    if (before) def = before;
    named = clause.slice(braceIdx + 1, clause.lastIndexOf('}'));
  }
  const out = [`const ${id} = ${req};`];
  if (def) out.push(`const ${def} = __esmDefault(${id});`);
  if (named) {
    const parts = named.split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
      const mm = x.split(/\s+as\s+/); return mm.length === 2 ? `${mm[0]}: ${mm[1]}` : mm[0];
    });
    out.push(`const { ${parts.join(', ')} } = ${id};`);
  }
  return out.join(' ');
}
function esmToCjs(src) {
  const collected = [];
  let s = src;
  s = s.replace(/(^|\n)([ \t]*)import\s+([\s\S]*?)\s+from\s*(['"])([^'"]+)\4\s*;?/g,
    (m, nl, ind, clause, q, spec) => nl + ind + esmCompileImport(clause, spec));
  s = s.replace(/(^|\n)([ \t]*)import\s*(['"])([^'"]+)\3\s*;?/g,
    (m, nl, ind, q, spec) => `${nl}${ind}require(${JSON.stringify(spec)});`);
  s = s.replace(/(^|\n)([ \t]*)export\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\4\s*;?/g,
    (m, nl, ind, names, q, spec) => {
      const id = `__reexp_${_esmN++}`;
      const assigns = names.split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
        const mm = x.split(/\s+as\s+/); return `module.exports.${mm[1] || mm[0]} = ${id}.${mm[0]};`;
      });
      return `${nl}${ind}{ const ${id} = require(${JSON.stringify(spec)}); ${assigns.join(' ')} }`;
    });
  s = s.replace(/(^|\n)([ \t]*)export\s+default\s+(function\b|class\b)/g,
    (m, nl, ind, kw) => `${nl}${ind}module.exports.default = ${kw}`);
  s = s.replace(/(^|\n)([ \t]*)export\s+default\s+/g, (m, nl, ind) => `${nl}${ind}module.exports.default = `);
  s = s.replace(/(^|\n)([ \t]*)export\s+(async\s+)?function\s+([A-Za-z0-9_$]+)/g,
    (m, nl, ind, asy, name) => { collected.push(name); return `${nl}${ind}${asy || ''}function ${name}`; });
  s = s.replace(/(^|\n)([ \t]*)export\s+class\s+([A-Za-z0-9_$]+)/g,
    (m, nl, ind, name) => { collected.push(name); return `${nl}${ind}class ${name}`; });
  s = s.replace(/(^|\n)([ \t]*)export\s+(const|let|var)\s+([A-Za-z0-9_$]+)/g,
    (m, nl, ind, kw, name) => { collected.push(name); return `${nl}${ind}${kw} ${name}`; });
  s = s.replace(/(^|\n)([ \t]*)export\s*\{([^}]*)\}\s*;?/g,
    (m, nl, ind, names) => {
      const assigns = names.split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
        const mm = x.split(/\s+as\s+/); return `module.exports.${mm[1] || mm[0]} = ${mm[0]};`;
      });
      return `${nl}${ind}${assigns.join(' ')}`;
    });
  let tail = '';
  for (const name of collected) tail += `\nmodule.exports.${name} = ${name};`;
  return 'const __esmDefault = (m) => (m && m.__esModule) ? m.default : m; Object.defineProperty(module.exports, "__esModule", { value: true });\n'
    + s + tail;
}

// Dynamic import(): quickjs's native import() routes through tjs's ESM loader,
// which knows nothing about this shim's CJS registry, so `await import("fs")`
// (and the ~58 such calls the bundle makes for real startup work — config
// reading, realpath/mkdir) reject with "could not load". Route them through
// require() instead, returning an ESM-interop namespace (named exports + a
// `default`). We rewrite the `import(` operator to the global helper
// `__tjsDynImport` (installed once, below). The bundle is Bun-compiled CJS, so
// every `import(` is a dynamic import; `import.meta` / static `import x from`
// (no `(`) are not matched. Kept a GLOBAL (not a per-module `new Function` arg)
// deliberately: adding a 6th eval parameter perturbed the pinned tjs build's
// codegen enough to resurface a latent exit-time SIGSEGV in an unrelated path
// (the documented quickjs-ng heap-layout fragility). The tradeoff: import()
// specifiers resolve from the loader root, not the importing module's dir — fine
// for the bare-builtin/package specifiers the bundle uses; a relative `import()`
// (`./x`) would be a future wall.
const DYN_IMPORT_RE = /(^|[^\w$.])import(\s*\()/g;
globalThis.__tjsDynImport ??= (spec) => {
  try {
    const m = makeRequire(tjs.cwd)(spec);
    if (m && typeof m === 'object') {
      if (!('default' in m)) { try { Object.defineProperty(m, 'default', { value: m, configurable: true }); } catch { /* frozen — fall through */ } }
      return Promise.resolve(m);
    }
    return Promise.resolve({ default: m });
  } catch (e) { return Promise.reject(e); }
};

// quickjs-ng (this pinned tjs) has a libregexp bug: Unicode property escapes
// (\p{…}/\P{…}) are mis-compiled under the `v` (unicodeSets) flag — they match
// NON-members (e.g. `/[\p{Control}\p{Format}]/v` and `/\p{Format}/v` both match the
// ASCII letter "t") and MISS real members. The SAME escapes are correct under the
// `u` flag. This breaks string-width@>=7: `baseVisible("t") === ""` →
// `"".codePointAt(0)` is undefined → get-east-asian-width `validate` throws
// `Expected a code point, got undefined`. That throw fires during Claude Code's
// REPL module top-level init (launchRepl), is caught upstream, and leaves the TUI
// unpainted (deterministic 13-byte paint stall). Full root-cause + minimal repro:
// spike/quickjs/results/phase3-m1-tui-boot.md.
//
// Mitigation until libregexp is fixed: downgrade `v`→`u` on regex literals that use
// property escapes but NONE of `v`'s exclusive features. `v` adds, over `u`: string
// properties (\p{RGI_Emoji} and the \p{…_Sequence}/Basic_Emoji family), set
// operations ([a--b], [a&&b], nested [[…]]), and \q{…} string literals. A property-
// escape regex free of all those has identical meaning under `u`, where this tjs
// compiles it correctly. Conservative by construction: we only touch a `/…/v`
// literal whose body contains \p{ or \P{ (so plain division `a/b/v` is never a
// candidate) and none of the v-only markers; downgrading v→u on such a literal is a
// semantic no-op on a correct engine and the fix on this one.
const V_FLAG_REGEX_RE = /\/((?:\\.|\[(?:\\.|[^\]\n])*\]|[^/\\\n])+)\/([dgimsuvy]*v[dgimsuvy]*)/g;
const V_ONLY_MARKERS_RE = /\\[pP]\{(?:RGI_Emoji|Basic_Emoji|Emoji_Keycap_Sequence|RGI_Emoji_[A-Za-z_]+)\}|--|&&|\\q\{|\[\[/;
function fixVFlagPropertyEscapes(src) {
  // The property-escape regexes that hit the tjs bug (string-width, etc.) live in
  // small node_modules ESM files, never the multi-MB Bun-compiled entry — and
  // V_FLAG_REGEX_RE's regex-literal body pattern is too costly to run over
  // megabytes. Gate on both an early substring check and a size ceiling.
  if (src.length > (1 << 20)) return src;
  if (src.indexOf('\\p{') === -1 && src.indexOf('\\P{') === -1) return src;
  return src.replace(V_FLAG_REGEX_RE, (m, body, flags) => {
    if (!/\\[pP]\{/.test(body)) return m;          // only property-escape regexes
    if (V_ONLY_MARKERS_RE.test(body)) return m;     // keep v where v is load-bearing
    return '/' + body + '/' + flags.replace('v', 'u');
  });
}

function evalModule(file, isEntry = false) {
  const cached = moduleCache.get(file);
  if (cached) return cached.exports;
  let src = readTextSync(file);
  if (src.startsWith('#!')) src = src.slice(src.indexOf('\n') + 1);
  if (!isEntry && esmDetect(src)) src = esmToCjs(src);
  src = src.replace(DYN_IMPORT_RE, '$1__tjsDynImport$2');
  src = fixVFlagPropertyEscapes(src);
  const module = { exports: {}, filename: file };
  if (isEntry) mainModule = module;
  moduleCache.set(file, module);
  const dir = P.dirname(file);
  const fn = new Function('exports', 'require', 'module', '__filename', '__dirname', src);
  fn.call(module.exports, module.exports, makeRequire(dir), module, file, dir);
  return module.exports;
}

// Resolve a package ONLY from the ext roots (NODE_PATH + repo node_modules),
// bypassing the node:/KNOWN shortcut in resolveRequest — so the npm `buffer`
// package is reachable from modules/buffer.cjs despite sharing the same
// specifier as the `buffer` builtin.
function requireExt(name) {
  const roots = [];
  // Fused quaude: the ext-dep closure ships as archive members; consult it first
  // (the P.join fallback below embeds '..' segments __vfsGet cannot see).
  if (__QVFS) roots.push('/quaude/node_modules/' + name);
  for (const r of (globalThis.process && process.env.NODE_PATH || '').split(NODE_PATH_DELIM)) if (r) roots.push(P.join(r, name));
  roots.push(P.join(P.dirname(SHIM_DIR), '..', '..', 'node_modules', name)); // repo node_modules fallback
  for (const pkgDir of roots) {
    const pkgJson = P.join(pkgDir, 'package.json');
    if (!existsFileSync(pkgJson)) continue;
    const main = JSON.parse(readTextSync(pkgJson)).main || 'index.js';
    const entry = P.normalize(P.join(pkgDir, main));
    for (const c of [entry, entry + '.js', entry + '.cjs', P.join(entry, 'index.js')]) if (existsFileSync(c)) return evalModule(c);
  }
  return undefined;
}

/* ---- .qbc bytecode entry ------------------------------------------------------
 * A `.qbc` entry is the CJS wrapper function around cli.cjs, compiled as an ES
 * module by the fuse step (libexec/quaude-fuse.js) under the SAME tjs build:
 *   globalThis.__quaude_entry = function (exports, require, module, __filename,
 *   __dirname) { <transformed cli.cjs> };
 * evalBytecode of that module completes synchronously (no imports / TLA), then
 * the entry function is called with this loader's ordinary CJS machinery — so
 * require(), module cache, and require.main behave exactly as for a source
 * entry. The module identity (filename, cache key, __dirname) uses the .cjs
 * name the bytecode was compiled from, so `require(__dirname + '/bun-shim.cjs')`
 * and relative resolution inside the bundle are unchanged. NOTE: compiled
 * modules are STRICT; the shims must stay strict-clean on the bundle's paths. */
function evalBytecodeEntry(qbcFile) {
  const origName = qbcFile.replace(/\.qbc$/, '.cjs');
  const bytes = readBinSync(qbcFile);
  const obj = tjs.engine.deserialize(bytes);
  tjs.engine.evalBytecode(obj); // sets globalThis.__quaude_entry synchronously
  const fn = globalThis.__quaude_entry;
  if (typeof fn !== 'function') throw new Error(`node-shim: ${qbcFile} did not define __quaude_entry (not a quaude bytecode entry?)`);
  delete globalThis.__quaude_entry;
  const module = { exports: {}, filename: origName };
  mainModule = module;
  moduleCache.set(origName, module);
  const dir = P.dirname(origName);
  fn.call(module.exports, module.exports, makeRequire(dir), module, origName, dir);
}

/* ---- globals, then entry */
globalThis.process = loadBuiltin('process');
Object.defineProperty(globalThis, 'Buffer', {
  configurable: true,
  get() { return loadBuiltin('buffer').Buffer; },
});
// Node's timer functions return a Timeout/Immediate OBJECT (ref/unref/hasRef/
// refresh + Symbol.toPrimitive→id); txiki's return a bare NUMBER. The extracted
// bundle pervasively uses the Node idiom `setTimeout(...).unref()` (e.g. its
// DataDog telemetry-flush timer, `w1m`) — which throws `TypeError: not a
// function` on a number and silently bails the -p action before the Messages
// round-trip. Wrap the globals so the handle is Node-shaped, while clearTimeout/
// clearInterval still accept either the handle or a raw number (txiki's clear*
// wants the number). Characterized by test/node-shim-timers-handle.test.cjs.
// DIVERGENCE: ref()/unref() do NOT change event-loop liveness (txiki exposes no
// per-timer ref control to JS) — they are no-ops returning the handle so the
// chained idiom works; hasRef() reflects the last ref/unref call. refresh()
// re-arms by clearing the old timer and re-scheduling the same fn+delay,
// returning the same handle (identity preserved), matching Node's observable
// contract for the round-trip's usage.
{
  const _st = globalThis.setTimeout, _ct = globalThis.clearTimeout;
  const _si = globalThis.setInterval, _ci = globalThis.clearInterval;
  const TRACE = !!globalThis.process?.env?.CLODE_SHIM_TRACE;
  let n = 0;
  function makeHandle(rawId, kind, rearm) {
    let refed = true;
    return {
      _id: rawId, _kind: kind,
      ref() { refed = true; return this; },
      unref() { refed = false; return this; },
      hasRef() { return refed; },
      refresh() { if (rearm) { _ct.call(globalThis, this._id); this._id = rearm(); } return this; },
      [Symbol.toPrimitive]() { return this._id; },
    };
  }
  globalThis.setTimeout = function (fn, d, ...a) {
    let cb = fn;
    if (TRACE) { const id = ++n; console.error('[timer] setTimeout#' + id + ' delay=' + d); cb = function () { console.error('[timer] fire setTimeout#' + id); return fn.apply(this, arguments); }; }
    const self = this;
    const rearm = () => _st.call(self, cb, d, ...a);
    return makeHandle(_st.call(self, cb, d, ...a), 'timeout', rearm);
  };
  globalThis.setInterval = function (fn, d, ...a) {
    let cb = fn;
    if (TRACE) { const id = ++n; console.error('[timer] setInterval#' + id + ' delay=' + d); }
    return makeHandle(_si.call(this, cb, d, ...a), 'interval', null);
  };
  globalThis.clearTimeout = function (h) { return _ct.call(this, h && typeof h === 'object' ? h._id : h); };
  globalThis.clearInterval = function (h) { return _ci.call(this, h && typeof h === 'object' ? h._id : h); };
}
// setImmediate/clearImmediate AFTER the overrides so they route through the
// handle-wrapped setTimeout/clearTimeout (Node's setImmediate also returns an
// unref-able handle).
globalThis.setImmediate ??= (fn, ...a) => setTimeout(fn, 0, ...a);
globalThis.clearImmediate ??= (h) => clearTimeout(h);
// Node's `global` === globalThis; the bundle references the bare `global`
// identifier (e.g. `global.TEST...`). tjs exposes only globalThis, so alias it.
globalThis.global ??= globalThis;

// Intl.Segmenter polyfill: this tjs build ships NO `Intl` global at all, but the
// bundle's `string-width` dep does `new Intl.Segmenter()` at load to split text
// into grapheme clusters for display-width math. Provide a minimal Segmenter that
// yields one segment per Unicode CODE POINT (String iteration is code-point aware).
// DIVERGENCE: real grapheme clustering keeps combining marks / ZWJ-emoji / flag
// pairs together in ONE cluster; a code-point split separates them. For width
// this stays correct for ASCII, CJK, and per-code-point combining marks (they
// re-join as zero-width by string-width's own rules), and only over-counts
// multi-code-point emoji sequences — off the -p PONG path. A future path needing
// true grapheme segmentation (or Intl.DateTimeFormat/NumberFormat/Collator, also
// absent) is a real wall: wire a fuller Intl then. Locked by
// test/node-shim-esm.test.cjs (which compares transpiled string-width to host).
// quickjs-ng ships no Intl. The bundle uses Segmenter, NumberFormat,
// DateTimeFormat, RelativeTimeFormat, Collator, DisplayNames and Locale — all
// polyfilled (en-US/en, scoped to the bundle's option shapes) in modules/intl.cjs.
// Without NumberFormat the interactive TUI throws "not a function" the instant a
// turn renders its token counts (`wuh` → new Intl.NumberFormat compact).
if (typeof globalThis.Intl === 'undefined') {
  globalThis.Intl = evalModule(P.join(SHIM_DIR, 'intl.cjs'));
}
globalThis.__nodeShim = {
  loadBuiltin, makeRequire, wallProxy, readTextSync, moduleLoad, resolveRequest, requireExt, KNOWN,
  version: 'm2',
};

// Opt-in fetch tracing (CLODE_SHIM_TRACE=1) for the -p wall-walk: log each
// request start and response arrival so a hang in the API round-trip is
// localized. Silent unless enabled.
if (globalThis.process && globalThis.process.env && globalThis.process.env.CLODE_SHIM_TRACE && typeof globalThis.fetch === 'function') {
  const _fetch = globalThis.fetch;
  globalThis.fetch = function (input, init) {
    const method = (init && init.method) || (input && input.method) || 'GET';
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    console.error('[fetch] ->', method, url);
    const p = _fetch.call(this, input, init);
    return p.then(
      (res) => {
        console.error('[fetch] <-', method, url, 'status=', res.status, 'ce=', res.headers.get('content-encoding'), 'te=', res.headers.get('transfer-encoding'), 'cl=', res.headers.get('content-length'));
        for (const m of ['text', 'json', 'arrayBuffer']) {
          const orig = res[m];
          if (typeof orig === 'function') res[m] = function (...a) { console.error('[fetch] body.' + m + ' start', url); return orig.apply(this, a).then((v) => { console.error('[fetch] body.' + m + ' done', url); return v; }, (e) => { console.error('[fetch] body.' + m + ' err', url, String(e)); throw e; }); };
        }
        return res;
      },
      (e) => { console.error('[fetch] xx', method, url, String(e)); throw e; },
    );
  };
}

// Async failures on the -p path settle in promise continuations the synchronous
// try/catch below cannot see. tjs surfaces them via the WHATWG
// 'unhandledrejection' event; print the reason + stack (Node prints unhandled
// rejections by default) so an async wall is a NAMED error, not a silent exit 1.
// QuickJS's Error#stack lacks the "Error: <msg>" head (see note above), so print
// message and stack separately.
globalThis.addEventListener?.('unhandledrejection', (ev) => {
  const r = ev && ev.reason;
  try { ev.preventDefault?.(); } catch { /* ignore */ }
  console.error('node-shim: unhandledRejection:');
  console.error(r && r.stack ? `${r}\n${r.stack}` : String(r));
});

let entryAbs, extraArgv;
if (__QVFS) {
  // Fused binary: tjs.args = [exePath, ...userArgs] (no 'run', no script path —
  // the stock tx1k1.js standalone boot leaves argv untouched). For quaude,
  // --quaude-* flags were already carved out by the bootstrap into
  // globalThis.__quaudeArgs; for the builder role, argv passes through whole.
  // The manifest names the entry member (Q1c: the native clode builder ships
  // its esbuilt clode-main bundle as a SOURCE member — measured 65KB / 0.24s
  // boot, so bytecode buys nothing and would force strict mode on the whole
  // esbuild output); absent manifest/entry keeps the quaude default, cli.qbc.
  entryAbs = '/quaude/' + ((__QVFS.manifest && __QVFS.manifest.entry) || 'cli.qbc');
  extraArgv = globalThis.__quaudeArgs ?? tjs.args.slice(1);
} else {
  const entry = tjs.args[3];
  if (!entry) { console.error('usage: tjs run loader.cjs <entry.cjs> [args...]'); tjs.exit(64); }
  entryAbs = P.resolve(entry);
  extraArgv = tjs.args.slice(4);
}
// argv[1] presents the .cjs identity for a bytecode entry (matching the module
// identity evalBytecodeEntry establishes; the bundle inspects its own argv[1]).
process.argv = [tjs.exePath ?? 'tjs', entryAbs.replace(/\.qbc$/, '.cjs'), ...extraArgv];
if (tjs.env.CLODE_PROBE) { try { evalModule(P.resolve(tjs.env.CLODE_PROBE)); } catch (e) { console.error('probe err', e); } }
try {
  if (entryAbs.endsWith('.qbc')) evalBytecodeEntry(entryAbs);
  else evalModule(entryAbs, true);
} catch (e) {
  // QuickJS's Error#stack is the call-frame trace ONLY — it does not, unlike
  // V8, prepend "Error: <message>" as its first line — so print the message
  // and stack separately or the failure text is silently lost (verified
  // empirically: see loader header note).
  console.error(e && e.stack ? `${e}\n${e.stack}` : String(e));
  tjs.exit(1);
}
