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

module.exports = { sep, delimiter, isAbsolute, normalize, join, resolve, dirname, basename, extname, relative, parse, posix: null };
module.exports.posix = module.exports;
