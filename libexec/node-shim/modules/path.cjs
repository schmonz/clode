'use strict';
// node:path (posix subset).
//
// Created ahead of schedule, in Task 3 rather than Task 4: Task 3's own
// contract test (test/node-shim-loader.test.cjs, "CJS semantics under tjs")
// does `require('node:path').join('a','b')` to exercise the real-module
// side of the builtin registry (loadBuiltin finds modules/path.cjs and
// evaluates it), as opposed to the wallProxy side covered by the other
// loader test (require('node:dgram')). Without this file that require
// would wall, and the loader test (which the brief says should be 2/2
// green after Task 3) could never pass — Task 4's own brief step 2
// ("node --test test/node-shim-path.test.cjs -> FAIL, wallProxy throws on
// path.join") assumes path.cjs does NOT exist before Task 4, which
// contradicts Task 3's "expect 2 pass" instruction. Filed as a plan
// inconsistency (see task-3-report.md); resolved here by creating this
// file now rather than weakening the verbatim test.
//
// Implementation is the full posix surface from the plan's Task 4 draft
// (docs/superpowers/plans/2026-07-06-universal-binaries-phase2-m1.md) so
// Task 4 can characterization-test and harden it rather than redo it from
// scratch; every behavior here should still be locked by
// test/node-shim-path.test.cjs against host node when Task 4 lands.
const sep = '/';
const delimiter = ':';
const isAbsolute = (p) => p.startsWith('/');

function normalizeArray(parts, allowAboveRoot) {
  const res = [];
  for (const p of parts) {
    if (!p || p === '.') continue;
    if (p === '..') {
      if (res.length && res[res.length - 1] !== '..') res.pop();
      else if (allowAboveRoot) res.push('..');
    } else res.push(p);
  }
  return res;
}

function normalize(p) {
  if (p === '') return '.';
  const abs = isAbsolute(p);
  const trailing = p.endsWith('/') && p.length > 1;
  let out = normalizeArray(p.split('/'), !abs).join('/');
  if (!out && !abs) out = '.';
  if (out && trailing) out += '/';
  return (abs ? '/' : '') + out;
}

function join(...args) {
  const joined = args.filter((a) => a !== '').join('/');
  return joined === '' ? '.' : normalize(joined);
}

function resolve(...args) {
  let resolved = '';
  let abs = false;
  for (let i = args.length - 1; i >= -1 && !abs; i--) {
    const p = i >= 0 ? args[i] : process.cwd();
    if (!p) continue;
    resolved = p + '/' + resolved;
    abs = isAbsolute(p);
  }
  const out = normalizeArray(resolved.split('/'), !abs).join('/');
  return (abs ? '/' + out : out) || (abs ? '/' : '.');
}

function dirname(p) {
  if (p === '') return '.';
  const hasRoot = isAbsolute(p);
  let end = -1, seenNonSlash = false;
  for (let i = p.length - 1; i >= 1; i--) {
    if (p[i] === '/') { if (seenNonSlash) { end = i; break; } }
    else seenNonSlash = true;
  }
  if (end === -1) return hasRoot ? '/' : '.';
  if (hasRoot && end === 0) return '/';
  return p.slice(0, end);
}

function basename(p, ext) {
  let b = p.replace(/\/+$/, '');
  b = b.slice(b.lastIndexOf('/') + 1);
  if (b === '' && isAbsolute(p)) b = '';
  if (ext && b.endsWith(ext) && b !== ext) b = b.slice(0, -ext.length);
  return b;
}

function extname(p) {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i <= 0 ? '' : b.slice(i);
}

function relative(from, to) {
  const f = resolve(from).split('/').filter(Boolean);
  const t = resolve(to).split('/').filter(Boolean);
  let i = 0;
  while (i < f.length && i < t.length && f[i] === t[i]) i++;
  return [...Array(f.length - i).fill('..'), ...t.slice(i)].join('/');
}

function parse(p) {
  const root = isAbsolute(p) ? '/' : '';
  const base = basename(p);
  const ext = extname(p);
  return { root, dir: dirname(p), base, ext, name: base.slice(0, base.length - ext.length) };
}

// ---- win32 surface (Task 4 wall) ----
// The -p bundle does `require('path/win32')` and calls .join/.dirname/
// .isAbsolute/.delimiter inside its Windows git-bash-detection branch (finding
// `bin/bash.exe`). That branch is dead on darwin, but the module must load and
// the methods must be REAL functions with correct Windows semantics (not the
// posix impl — win32 uses `\` sep, `;` delimiter, drive/UNC roots). These are
// genuine win32 implementations, characterized against host node's path.win32
// by test/node-shim-path.test.cjs (win32 row). The full surface used by the
// posix impl (isAbsolute/join/dirname/normalize/relative/parse/basename/
// extname + sep/delimiter) is implemented for win32 as well.
const win32sep = '\\';
const win32delimiter = ';';

function win32IsAbsolute(p) {
  if (typeof p !== 'string' || p.length === 0) return false;
  const c0 = p[0];
  if (c0 === '/' || c0 === '\\') return true;                      // rooted / UNC
  if (p.length > 2 && /[a-zA-Z]/.test(c0) && p[1] === ':') {
    const c2 = p[2];
    return c2 === '/' || c2 === '\\';                              // drive-absolute
  }
  return false;
}

// Length of the "root" prefix: UNC (\\server\share[\]), drive (C:[\]), or a
// lone leading separator (root of current drive).
function win32RootLen(p) {
  let m = /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+(?:[\\/]|$)/.exec(p);
  if (m) return m[0].length;
  m = /^[a-zA-Z]:[\\/]?/.exec(p);
  if (m) return m[0].length;
  if (/^[\\/]/.test(p)) return 1;
  return 0;
}

function win32Normalize(p) {
  if (p.length === 0) return '.';
  let device = '';
  let isAbs = false;
  let rest = p;
  let m = /^([\\/]{2}[^\\/]+[\\/]+[^\\/]+)([\\/]?)/.exec(p);
  if (m) { device = m[1].replace(/\//g, '\\'); isAbs = true; rest = p.slice(m[0].length); }
  else {
    m = /^([a-zA-Z]:)([\\/]?)/.exec(p);
    if (m) { device = m[1]; if (m[2]) isAbs = true; rest = p.slice(m[0].length); }
    else if (/^[\\/]/.test(p)) { isAbs = true; rest = p.replace(/^[\\/]+/, ''); }
  }
  const normed = normalizeArray(rest.split(/[\\/]+/), !isAbs);
  let tail = normed.join('\\');
  if (!tail && !isAbs) tail = '.';
  const root = device + (isAbs ? '\\' : '');
  const out = root + tail;
  return out === '' ? '.' : out;
}

function win32Join(...args) {
  const parts = args.filter((a) => a !== '' && a != null);
  if (parts.length === 0) return '.';
  return win32Normalize(parts.join('\\'));
}

function win32Dirname(p) {
  if (p.length === 0) return '.';
  const rootLen = win32RootLen(p);
  let lastSep = -1, seenNonSep = false;
  for (let i = p.length - 1; i >= rootLen; i--) {
    const c = p[i];
    if (c === '\\' || c === '/') { if (seenNonSep) { lastSep = i; break; } }
    else seenNonSep = true;
  }
  if (lastSep === -1) return rootLen > 0 ? p.slice(0, rootLen) : '.';
  let dir = p.slice(0, lastSep);
  if (dir.length < rootLen) dir = p.slice(0, rootLen);
  return dir || '.';
}

function win32Basename(p, ext) {
  const rootLen = win32RootLen(p);
  let s = p.slice(rootLen).replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  let b = i === -1 ? s : s.slice(i + 1);
  if (ext && b.endsWith(ext) && b !== ext) b = b.slice(0, -ext.length);
  return b;
}

function win32Extname(p) {
  const b = win32Basename(p);
  const i = b.lastIndexOf('.');
  return i <= 0 ? '' : b.slice(i);
}

function win32Resolve(...args) {
  // Mirror posix resolve()'s cwd source (process.cwd()); node uses per-drive
  // cwds, but the bundle passes absolute paths or joins under one root, so a
  // single-cwd resolve is sufficient (extend if a wall drives per-drive cwd).
  let resolved = '';
  let abs = false;
  for (let i = args.length - 1; i >= -1 && !abs; i--) {
    const p = i >= 0 ? args[i] : process.cwd();
    if (!p) continue;
    resolved = resolved ? p + '\\' + resolved : p;
    abs = win32IsAbsolute(p);
  }
  return win32Normalize(resolved) || '.';
}

function win32Relative(from, to) {
  const f = win32Resolve(from), t = win32Resolve(to);
  if (f.toLowerCase() === t.toLowerCase()) return '';
  const fp = f.split('\\').filter(Boolean), tp = t.split('\\').filter(Boolean);
  let i = 0;
  while (i < fp.length && i < tp.length && fp[i].toLowerCase() === tp[i].toLowerCase()) i++;
  return [...Array(fp.length - i).fill('..'), ...tp.slice(i)].join('\\');
}

function win32Parse(p) {
  const rootLen = win32RootLen(p);
  const root = p.slice(0, rootLen);
  const base = win32Basename(p);
  const ext = win32Extname(p);
  return { root, dir: win32Dirname(p), base, ext, name: base.slice(0, base.length - ext.length) };
}

const win32 = {
  sep: win32sep,
  delimiter: win32delimiter,
  isAbsolute: win32IsAbsolute,
  normalize: win32Normalize,
  join: win32Join,
  dirname: win32Dirname,
  basename: win32Basename,
  extname: win32Extname,
  resolve: win32Resolve,
  relative: win32Relative,
  parse: win32Parse,
};

const posix = { sep, delimiter, isAbsolute, normalize, join, resolve, dirname, basename, extname, relative, parse, posix: null, win32 };
posix.posix = posix;
win32.win32 = win32;
win32.posix = posix;

// Node's require('path') is platform-specific: win32 on Windows, posix elsewhere.
// The bundle's Windows code paths were written against win32 (they already run
// on Windows under Bun). The loader uses its OWN P helpers, so this switch does
// not affect module resolution.
module.exports = (globalThis.process && process.platform === 'win32') ? win32 : posix;
