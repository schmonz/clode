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

/* ---- tiny path helpers (self-contained; modules/path.cjs is the real one) */
const P = {
  isAbs: (p) => p.startsWith('/'),
  dirname: (p) => { const s = p.replace(/\/+$/, ''); const i = s.lastIndexOf('/'); return i > 0 ? s.slice(0, i) : i === 0 ? '/' : '.'; },
  join: (...a) => a.filter(Boolean).join('/').replace(/\/{2,}/g, '/'),
  normalize(p) {
    const abs = P.isAbs(p); const out = [];
    for (const seg of p.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else if (!abs) out.push('..'); }
      else out.push(seg);
    }
    return (abs ? '/' : '') + out.join('/') || (abs ? '/' : '.');
  },
  resolve: (...a) => {
    let r = tjs.cwd;
    for (const s of a) r = P.isAbs(s) ? s : r + '/' + s;
    return P.normalize(r);
  },
};

/* ---- read file as utf8 via sync fs */
const td = new TextDecoder();
function readTextSync(file) {
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
function existsFileSync(p) { try { return FSS.stat(p).kind === 'file'; } catch { return false; } }

/* ---- wall proxy */
function wallProxy(ns) {
  return new Proxy({}, {
    get(_, prop) {
      if (prop === Symbol.toPrimitive || prop === 'then' || prop === Symbol.iterator || prop === 'default') return undefined;
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
      throw new Error(`node-shim: ${ns}.${String(prop)} not implemented`);
    },
  });
}

/* ---- builtin registry (lazy) */
const SHIM_DIR = P.join(P.dirname(P.resolve(tjs.args[2] ?? '')), 'modules'); // loader.cjs lives beside modules/
const builtinCache = new Map();
const KNOWN = ['assert','buffer','child_process','crypto','events','fs','fs/promises','module','net','os','path','process','stream','string_decoder','tls','tty','url','util','vm','zlib','sea','readline','http','https','dgram','worker_threads','async_hooks','inspector','constants','querystring','timers','dns','http2','perf_hooks','diagnostics_channel'];
function loadBuiltin(name) {
  if (builtinCache.has(name)) return builtinCache.get(name);
  const base = name === 'fs/promises' ? 'fs' : name;
  const file = P.join(SHIM_DIR, `${base}.cjs`);
  let exportsVal;
  if (existsFileSync(file)) {
    const mod = evalModule(file);
    exportsVal = name === 'fs/promises' ? mod.promises : mod;
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
  for (const r of (globalThis.process && process.env.NODE_PATH || '').split(':')) if (r) roots.push(r);
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

function evalModule(file, isEntry = false) {
  const cached = moduleCache.get(file);
  if (cached) return cached.exports;
  let src = readTextSync(file);
  if (src.startsWith('#!')) src = src.slice(src.indexOf('\n') + 1);
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
  for (const r of (globalThis.process && process.env.NODE_PATH || '').split(':')) if (r) roots.push(P.join(r, name));
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

/* ---- globals, then entry */
globalThis.process = loadBuiltin('process');
Object.defineProperty(globalThis, 'Buffer', {
  configurable: true,
  get() { return loadBuiltin('buffer').Buffer; },
});
globalThis.setImmediate ??= (fn, ...a) => setTimeout(fn, 0, ...a);
globalThis.clearImmediate ??= clearTimeout;
globalThis.__nodeShim = {
  loadBuiltin, makeRequire, wallProxy, readTextSync, moduleLoad, resolveRequest, requireExt, KNOWN,
  version: 'm2',
};

const entry = tjs.args[3];
if (!entry) { console.error('usage: tjs run loader.cjs <entry.cjs> [args...]'); tjs.exit(64); }
const entryAbs = P.resolve(entry);
process.argv = [tjs.exePath ?? 'tjs', entryAbs, ...tjs.args.slice(4)];
try {
  evalModule(entryAbs, true);
} catch (e) {
  // QuickJS's Error#stack is the call-frame trace ONLY — it does not, unlike
  // V8, prepend "Error: <message>" as its first line — so print the message
  // and stack separately or the failure text is silently lost (verified
  // empirically: see loader header note).
  console.error(e && e.stack ? `${e}\n${e.stack}` : String(e));
  tjs.exit(1);
}
