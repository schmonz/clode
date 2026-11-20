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
//   - test/run.mjs asks for one root (clode-run-<pid>-XXXXXX), which test/suite-home.cjs makes as its first act, so
//     the suite home lives in it too, and points TMPDIR, TMP and TEMP at it; the runner's own dirs
//     (CLODE_STATE_ROOT, the security stub, the TAP copies) land there; a root whose pid is dead is a killed run's,
//     named and removed when the next run starts;
//   - every test-file process gets its own dir under that root (test/file-tmpdir-preload.cjs), so one file's temp
//     files are never another's;
//   - at exit the runner removes the root, after making every directory under it u+rwx, because some tests leave
//     dirs chmod 0 (shim-diff's case dirs) that a plain recursive rm cannot enter;
//   - the run is JUDGED on the original temp dir: each entry that appeared there during the run in the shape this
//     repo's code makes temp files with is a named `not ok`, grouped by prefix with a count, and fails the run.
//
// WHERE THE ROOT GOES: the shorter of the original temp dir and /tmp. macOS caps a unix socket path at 103 bytes, its
// $TMPDIR is already 49 (/var/folders/xx/.../T/, 58 once realpath'd), and tests make sockets in their temp dir: two
// more levels under it pushed rg-native's RG-SPECIAL-FILE socket to 121 bytes (listen EINVAL). /tmp is short on every
// POSIX box and is the original temp dir on most Linux ones. Whichever writable candidate is shorter wins. Windows
// does not offer /tmp as a candidate: node resolves it to <drive>:\tmp, a directory nothing on Windows provides or
// cleans (a writable one would be some other program's, and creating it would be ours to litter), and the cap it
// exists to dodge is a unix socket fact (Windows pipes do not live in the temp dir).
//
// WHICH NAMES ARE JUDGED: <prefix><suffix>, where the prefix is one this repo's own code spells (repoPrefixes), is at
// least 5 characters before the separator it ends in, and the suffix is generated (letters and digits, an optional
// short extension: mkdtemp's six, a pid). The original temp dir is shared with everything else the user runs (macOS
// daemons, editors, other agents: a run measured 2026-11-20 saw s1, s2, a, b, mm-build and tmp.* appear from another
// session), and short generic prefixes this repo also spells (work-, cfg-, rm-) are anyone's.
//
// ANOTHER RUN AT THE SAME TIME. A second checkout's suite makes the same names in the same dir, and nothing on disk
// says whose they are. So a watcher (test/run-tmp-runs.cjs, a child of the runner) samples for other LIVE clode-run-<pid>-*
// roots through the whole run: when one overlapped, each leftover is a named UNATTRIBUTABLE warning naming that pid,
// never silent and never red; with no overlap a leftover is a not ok. (A concurrent run of code older than this file
// makes no root, so it cannot be seen; its leftovers stay red here.)
//
// KEPT IN THE ORIGINAL TEMP DIR, ON PURPOSE (STABLE): the durable scratch and caches meant to outlive a run, so a run
// neither rebuilds the engine and PTY harness nor re-extracts the provider. Each is one fixed-name directory, reused,
// never a pile; test/run.mjs points the variable each is read through at the original temp dir.
const fs = require('node:fs');
const path = require('node:path');

const ROOT_ENV = 'CLODE_TEST_RUN_TMP';
const ORIGINAL_ENV = 'CLODE_TEST_ORIGINAL_TMP';
const ROOT_PREFIX = 'clode-run-';
const REQUEST_ENV = 'CLODE_TEST_RUN_TMP_REQUEST';
// name -> how it stays in the original temp dir
const STABLE = {
  'clode-built-binary-cache': `test/built-binary.cjs reads ${ORIGINAL_ENV}: the provider extraction every quaude build shares`,
  'clode-oracle-stage': `test/oracle-models.cjs reads ${ORIGINAL_ENV}: the merged provider every oracle stages from`,
  harness: 'CLODE_BUILD_SCRATCH (scripts/build-scratch.cjs): the PTY harness node_modules',
  toolchain: 'CLODE_BUILD_SCRATCH (scripts/build-scratch.cjs): the esbuild/postject tool cache',
  tjs: 'CLODE_BUILD_SCRATCH (scripts/build-scratch.cjs): the scratch engine the suite resolves',
  'clode-tjs-build': 'CLODE_TJS_LOCAL_ROOT (scripts/build-tjs.cjs): the engine build dirs',
  'clode-test-crashes': 'test/run-crashes.cjs: the evidence of a test file whose process died of a signal, kept for the next look',
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

// Where a root may go: the original temp dir; /tmp off Windows (see the header); and the CI runner's own temp dir when
// the host names one (RUNNER_TEMP). A Windows TEMP is C:\Users\<user>\AppData\Local\Temp, INSIDE the real home, so
// the suite home made there was inside the developer's home (test/suite-home-hermetic.test.cjs, "the suite home is
// not inside the real one"). That check passed only while the root carried the runner's 8.3 alias (C:\Users\RUNNER~1),
// which a textual prefix test does not see as C:\Users\runneradmin; once rootParent took the long name (fb01301) the
// containment showed (CI windows-latest on 26149c8). RUNNER_TEMP (D:\a\_temp on a GitHub runner) is outside the home,
// and test/bun-graph.test.cjs already goes there for room, since C: is the small volume.
// An operator on a box with no RUNNER_TEMP (a Windows dev box, whose TEMP is in the home) names one with
// CLODE_TEST_TMP_PARENT: a directory outside the home, offered before RUNNER_TEMP.
const TMP_PARENT_ENV = 'CLODE_TEST_TMP_PARENT';
function rootCandidates(original, platform = process.platform, env = process.env) {
  return [original, ...(platform === 'win32' ? [] : ['/tmp']), ...[env[TMP_PARENT_ENV], env.RUNNER_TEMP].filter(Boolean)];
}

// A path's NATIVE real path (the long name on Windows, the on-disk case), or its resolved form when it does not exist.
function nativeReal(p, real = fs.realpathSync.native) {
  try { return real(p); } catch { return path.resolve(p); }
}

// Whether `child` is `parent` or lies under it, both normalised the same way (nativeReal), so an 8.3 alias of one and
// the long name of the other compare as what they are. Windows compares without case, as its file system does.
function isInside(child, parent, { platform = process.platform, real = fs.realpathSync.native } = {}) {
  const P = platform === 'win32' ? path.win32 : path.posix;
  const fold = (x) => (platform === 'win32' ? x.toLowerCase() : x);
  const c = fold(P.resolve(nativeReal(child, real)));
  const h = fold(P.resolve(nativeReal(parent, real)));
  return c === h || c.startsWith(h.endsWith(P.sep) ? h : h + P.sep);
}

// The parent for the root: a writable candidate by its NATIVE real path, outside the real home if any is (`home`, the
// developer's, read before the suite home replaces it), the shortest of those. The native real path is the long name
// on Windows (a runner's TEMP is C:\Users\RUNNER~1\..., an 8.3 short name; GetFinalPathNameByHandle gives the long
// one), so the root, and every per-file dir and TMPDIR under it, never carries a ~1 name a tool may not expand.
function rootParent(original, { candidates = rootCandidates(original), home = null, real = fs.realpathSync.native } = {}) {
  const ok = candidates.filter(writableDir).map((d) => real(d));
  const outside = home ? ok.filter((d) => !isInside(d, home, { real })) : ok;
  const pick = outside.length ? outside : ok;
  return pick.length ? pick.sort((a, b) => a.length - b.length)[0] : original;
}

// The per-run root, with every temp-dir variable pointed at it and the durable-scratch variables at the original.
function makeRunRoot(original, env = process.env, opts = {}) {
  const home = opts.home !== undefined ? opts.home : (env.USERPROFILE || env.HOME || null);
  const root = fs.mkdtempSync(path.join(rootParent(original, { ...opts, home }), `${ROOT_PREFIX}${opts.pid || process.pid}-`));
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

function snapshotList(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
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

// A judged prefix: at least 5 characters before its closing separator (work-, cfg-, shim- are anyone's). A generated
// suffix: letters and digits (mkdtemp's six, a pid), with an optional short extension.
const JUDGED_PREFIX = /^.{5,}[-_.]$/;
const GENERATED_SUFFIX = /^[A-Za-z0-9]{3,}(?:\.[A-Za-z0-9]{1,5})?$/;

// The entries of `after` not in `before` shaped <judged prefix><generated suffix>, minus `ignore` and STABLE,
// grouped by the longest such prefix: [{ prefix, count, example }], largest first.
function leaks(before, after, { prefixes, ignore = [] }) {
  const byLength = [...prefixes].filter((x) => JUDGED_PREFIX.test(x)).sort((a, b) => b.length - a.length);
  const groups = new Map();
  for (const name of after) {
    if (before.has(name) || ignore.includes(name) || Object.hasOwn(STABLE, name)) continue;
    const p = byLength.find((x) => name.startsWith(x) && GENERATED_SUFFIX.test(name.slice(x.length)));
    if (!p) continue;
    const g = groups.get(p) || { prefix: p, count: 0, example: name };
    g.count++;
    groups.set(p, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.prefix.localeCompare(b.prefix));
}

// The verdict on leaks(): one line per prefix. With no overlapping run each is a `not ok` and the run fails; when
// another live run overlapped (`overlaps`: its pids) each is an UNATTRIBUTABLE warning naming them, and it does not.
function leakVerdict(found, original, overlaps = []) {
  const what = (g) => `${g.count} entr${g.count === 1 ? 'y' : 'ies'} named ${g.prefix}* in ${original} (e.g. ${g.example})`;
  if (!overlaps.length) {
    return { fail: found.length > 0, lines: found.map((g) => `not ok - the suite left ${what(g)}; a test's temp files `
      + 'belong under the per-run root (test/run-tmp.cjs)') };
  }
  return { fail: false, lines: found.map((g) => `warning - UNATTRIBUTABLE: ${what(g)} appeared while another run `
    + `(pid ${overlaps.join(', ')}) was live in the same temp dir; either run may have left them. Rerun alone to judge`) };
}

// The durable scratch kept in the original temp dir, by size: one line, for the verdict (it fails nothing).
function stableSizes(original) {
  const size = (p) => {
    let st;
    try { st = fs.lstatSync(p); } catch { return 0; }
    if (!st.isDirectory()) return st.size;
    let n = 0;
    for (const e of snapshotList(p)) n += size(path.join(p, e));
    return n;
  };
  return Object.keys(STABLE).filter((n) => fs.existsSync(path.join(original, n)))
    .map((n) => ({ name: n, bytes: size(path.join(original, n)) }));
}
function stableLine(sizes, original) {
  const mb = (b) => `${Math.round(b / 1048576)} MB`;
  const total = sizes.reduce((a, x) => a + x.bytes, 0);
  return `run: durable scratch kept in ${original}: ${sizes.length ? sizes.map((x) => `${x.name} ${mb(x.bytes)}`).join(', ') : 'none'}`
    + ` (total ${mb(total)}; kept on purpose, test/run-tmp.cjs STABLE)`;
}

module.exports = {
  ROOT_ENV, ORIGINAL_ENV, ROOT_PREFIX, REQUEST_ENV, STABLE, DURABLE_ENV,
  redirect, rootCandidates, rootParent, isInside, nativeReal, TMP_PARENT_ENV, makeRunRoot, makeFileDir, openUp, removeRunRoot,
  writableDir, snapshot, snapshotList, repoPrefixes, leaks, leakVerdict, stableSizes, stableLine,
};

