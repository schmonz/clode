'use strict';
// The env-read corpus, DERIVED. Matching real reads (`env.X`, `process.env.X`, `env['X']`)
// rather than every CLODE_* token, because the token count is 141 and includes build-time
// esbuild defines like __CLODE_BUNDLE_VERSION__, which are not environment variables at all.
//
// DIRECT READS ONLY — and that was a hole, not a scope decision. The regex below needs the
// name spelled LITERALLY next to `env.`/`env[`, so shipped code that reads env through one
// level of indirection (`env[req.overrideEnv]`, `tjs.env[name]`, `env[REEXEC_SENTINEL]`)
// was invisible to it: seven shipped names carried no verdict and the ratchet could never
// fire for them. test/env-indirect.cjs is the second, independent detector that finds those
// sites and requires each to be RECORDED; its names are folded in below so an indirectly
// read name needs a verdict exactly like a directly read one. Neither half is enough alone:
// this one is derived-but-blind-to-indirection, that one is recorded-but-cross-checked.
const fs = require('node:fs');
const path = require('node:path');
const { indirectReads } = require('./env-indirect.cjs');

const REPO = path.resolve(__dirname, '..');
const READ = /(?:process\.)?env(?:ironment)?\s*[.[]\s*["']?(CLODE_[A-Z0-9_]+)["']?\s*\]?/g;

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('._') || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

function indexEnvReads() {
  const idx = new Map();
  for (const [dir, tag] of [['libexec', 'prod'], ['scripts', 'prod'], ['test', 'test']]) {
    const abs = path.join(REPO, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of walk(abs, [])) {
      let src; try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
      for (const m of src.matchAll(READ)) {
        const k = m[1];
        if (!idx.has(k)) idx.set(k, { prod: [], test: [] });
        // Repo-relative paths are POSIX here, ALWAYS — replace every backslash rather than
        // path.sep, since path.sep is '/' on this (POSIX) host and a path.sep-only replace
        // would be a no-op that could never be exercised without a real Windows box. This is
        // the exact defect that broke test/guards-population.cjs on Windows CI (run
        // 34762646884); see test/windows-path-ratchet.test.cjs for the house shape.
        const rel = path.relative(REPO, f).split('\\').join('/');
        if (!idx.get(k)[tag].includes(rel)) idx.get(k)[tag].push(rel);
      }
    }
  }
  // The indirect half. Every recorded site lives under libexec/ or scripts/, so these are
  // PROD reads by construction — credited to the file that performs the computed access,
  // which is where a reader chasing the name has to end up anyway.
  for (const [name, files] of indirectReads()) {
    if (!idx.has(name)) idx.set(name, { prod: [], test: [] });
    for (const f of files) if (!idx.get(name).prod.includes(f)) idx.get(name).prod.push(f);
  }
  return idx;
}

module.exports = { indexEnvReads, REPO };
