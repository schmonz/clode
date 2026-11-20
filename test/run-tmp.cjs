'use strict';
// run-tmp: the suite's temporary files live under ONE per-run root, and the run is judged on what it leaves in the
// box's own temp dir.
//
// WHY (2026-11-19). About 41,000 entries had piled up in the developer's $TMPDIR from 329 of this repo's prefixes
// (clode-bootstrap-, shim-cp-, depscan-fx-, clode-runner-trace-, clode-main-test-watch-, min-prov-,
// clode-test-state-, shim-diff-, ...) until the disk filled mid-suite and truncated a vendored source file to 0
// bytes. Each was a test that made a temp dir and did not remove it, and nothing judged the run on what it left.
// Asking every test to clean up is the per-test convention that keeps failing here (the security stub and
// CLODE_STATE_ROOT both moved into test/run.mjs for the same reason), so the fix is in one place:
//   - test/run.mjs makes one root (clode-run-XXXXXX) and points TMPDIR, TMP and TEMP at it, right after the suite
//     home; its own dirs (CLODE_STATE_ROOT, the security stub, the TAP copies) land there;
//   - every test-file process gets its own dir under that root (test/file-tmpdir-preload.cjs), so one file's temp
//     files are never another's;
//   - at exit the runner removes the root, after making every directory under it u+rwx, because some tests leave
//     dirs chmod 0 (shim-diff's case dirs) that a plain recursive rm cannot enter;
//   - the run is JUDGED on the original temp dir: each entry that appeared there during the run under a name this
//     repo's code makes temp files with is a named `not ok`, grouped by prefix with a count, and fails the run.
//
// WHERE THE ROOT GOES: the shorter of the original temp dir and /tmp. macOS caps a unix socket path at 103 bytes, its
// $TMPDIR is already 49 (/var/folders/xx/.../T/, 58 once realpath'd), and tests make sockets in their temp dir: two
// more levels under it pushed rg-native's RG-SPECIAL-FILE socket to 121 bytes (listen EINVAL). /tmp is short on every
// POSIX box and is the original temp dir on most Linux ones; Windows has no /tmp and keeps the original. A fact about
// path lengths, not a platform branch: whichever writable candidate is shorter wins, wherever.
//
// WHICH NAMES ARE JUDGED: only the prefixes this repo's own code spells (repoPrefixes), because the original temp dir
// is shared with everything else the user runs (macOS daemons, editors, other agents: a run measured 2026-11-20 saw
// s1, s2, a, b, mm-build and tmp.* appear from another session). A concurrent run of this repo's tests from another
// checkout still lands names this check counts; the message says so.
//
// KEPT IN THE ORIGINAL TEMP DIR, ON PURPOSE (STABLE): the durable scratch and caches meant to outlive a run, so a run
// neither rebuilds the engine and PTY harness nor re-extracts the provider. Each is one fixed-name directory, reused,
// never a pile; test/run.mjs points the variable each is read through at the original temp dir.
const fs = require('node:fs');
const path = require('node:path');

const ROOT_ENV = 'CLODE_TEST_RUN_TMP';
const ORIGINAL_ENV = 'CLODE_TEST_ORIGINAL_TMP';
const ROOT_PREFIX = 'clode-run-';
// name -> how it stays in the original temp dir
const STABLE = {
  'clode-built-binary-cache': `test/built-binary.cjs reads ${ORIGINAL_ENV}: the provider extraction every quaude build shares`,
  'clode-oracle-stage': `test/oracle-models.cjs reads ${ORIGINAL_ENV}: the merged provider every oracle stages from`,
  harness: 'CLODE_BUILD_SCRATCH (scripts/build-scratch.cjs): the PTY harness node_modules',
  toolchain: 'CLODE_BUILD_SCRATCH (scripts/build-scratch.cjs): the esbuild/postject tool cache',
  tjs: 'CLODE_BUILD_SCRATCH (scripts/build-scratch.cjs): the scratch engine the suite resolves',
  'clode-tjs-build': 'CLODE_TJS_LOCAL_ROOT (scripts/build-tjs.cjs): the engine build dirs',
};
// Where test/run.mjs points the durable-scratch variables (each only when the operator has not set it).
const DURABLE_ENV = [ORIGINAL_ENV, 'CLODE_BUILD_SCRATCH', 'CLODE_TJS_LOCAL_ROOT'];

function redirect(env, dir) {
  env.TMPDIR = dir;
  env.TMP = dir;
  env.TEMP = dir;
}

function writableDir(d) {
  try { return fs.statSync(d).isDirectory() && (fs.accessSync(d, fs.constants.W_OK | fs.constants.X_OK), true); } catch { return false; }
}

// The parent for the root: the shortest writable one of the original temp dir and /tmp (realpath'd lengths).
function rootParent(original, { candidates = [original, '/tmp'] } = {}) {
  const ok = candidates.filter(writableDir).map((d) => fs.realpathSync(d));
  return ok.length ? ok.sort((a, b) => a.length - b.length)[0] : original;
}

// The per-run root, with every temp-dir variable pointed at it and the durable-scratch variables at the original.
function makeRunRoot(original, env = process.env, opts = {}) {
  const root = fs.mkdtempSync(path.join(rootParent(original, opts), ROOT_PREFIX));
  env[ROOT_ENV] = root;
  for (const k of DURABLE_ENV) if (!env[k]) env[k] = original;
  redirect(env, root);
  return root;
}

// A test file's own dir under the run root, named for the file (at most 24 bytes with its separator).
function makeFileDir(root, file) {
  const base = path.basename(String(file || 'file')).replace(/\.test\.c?js$/, '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 16);
  return fs.mkdtempSync(path.join(root, `${base}-`));
}

// Make every directory under `dir` (and it) u+rwx, so a recursive removal can enter and empty each one.
function openUp(dir) {
  let st;
  try { st = fs.lstatSync(dir); } catch { return; }
  if (!st.isDirectory()) return;
  try { fs.chmodSync(dir, (st.mode & 0o7777) | 0o700); } catch { /* removal below names what still refuses */ }
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) openUp(path.join(dir, n));
}

// Remove the run root, opened up first. Throws (naming each entry that refused) when it cannot.
function removeRunRoot(root) {
  const { removeNamingRefusals } = require('./suite-home.cjs');
  openUp(root);
  removeNamingRefusals(root, { what: 'the per-run temp root (test/run-tmp.cjs, at exit)' });
}

function snapshot(dir) {
  try { return new Set(fs.readdirSync(dir)); } catch { return new Set(); }
}

// The temp-name prefixes this repo's code spells: a literal joined onto os.tmpdir(), or a literal handed to mkdtemp.
// Derived from the source, never listed, so a new test's prefix is judged the day it is written.
const SOURCE_DIRS = ['test', 'scripts', 'libexec', 'bin'];
const SPELLINGS = [
  /os\.tmpdir\(\)\s*,\s*['"`]([A-Za-z0-9][A-Za-z0-9._-]{2,})/g,
  /mkdtemp(?:Sync)?\(\s*path\.join\([^,()]+(?:\([^()]*\))?\s*,\s*['"`]([A-Za-z0-9][A-Za-z0-9._-]{2,})/g,
];
function repoPrefixes(repo) {
  const out = new Set();
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      // (source only: a generated bundle or fixture over 1 MB spells no prefix of ours, and reading them is the cost)
      else if (/\.(c|m)?js$/.test(e.name) && fs.statSync(p).size < 1 << 20) {
        const src = fs.readFileSync(p, 'utf8');
        for (const re of SPELLINGS) for (const m of src.matchAll(re)) out.add(m[1]);
      }
    }
  };
  for (const d of SOURCE_DIRS) walk(path.join(repo, d));
  return [...out];
}

// The entries of `after` not in `before` that start with one of `prefixes`, minus `ignore` and STABLE, grouped by
// the longest such prefix: [{ prefix, count, example }], largest first.
function leaks(before, after, { prefixes, ignore = [] }) {
  const byLength = [...prefixes].sort((a, b) => b.length - a.length);
  const groups = new Map();
  for (const name of after) {
    if (before.has(name) || ignore.includes(name) || Object.hasOwn(STABLE, name)) continue;
    const p = byLength.find((x) => name.startsWith(x));
    if (!p) continue;
    const g = groups.get(p) || { prefix: p, count: 0, example: name };
    g.count++;
    groups.set(p, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.prefix.localeCompare(b.prefix));
}

// The verdict lines for leaks(): one `not ok` per prefix, or none.
function leakLines(found, original) {
  return found.map((g) => `not ok - the suite left ${g.count} entr${g.count === 1 ? 'y' : 'ies'} named ${g.prefix}* `
    + `in ${original} (e.g. ${g.example}); a test's temp files belong under the per-run root (test/run-tmp.cjs). `
    + 'If another checkout ran these tests at the same time, those runs share this dir: rerun alone to confirm');
}

module.exports = {
  ROOT_ENV, ORIGINAL_ENV, ROOT_PREFIX, STABLE, DURABLE_ENV,
  redirect, rootParent, makeRunRoot, makeFileDir, openUp, removeRunRoot, snapshot, repoPrefixes, leaks, leakLines,
};
