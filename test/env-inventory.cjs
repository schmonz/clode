'use strict';
// The env-read corpus, DERIVED. Matching real reads (`env.X`, `process.env.X`, `env['X']`)
// rather than every CLODE_* token, because the token count is 141 and includes build-time
// esbuild defines like __CLODE_BUNDLE_VERSION__, which are not environment variables at all.
const fs = require('node:fs');
const path = require('node:path');

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
  return idx;
}

module.exports = { indexEnvReads, REPO };
