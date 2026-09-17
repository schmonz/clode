'use strict';
// PHASE 5B, TASK 3. `libexec/host-provision.cjs` is one KAT-verified resolver every
// artifact (the clode builder, quaude, naude) uses to find host tools (sha256, tar,
// gzip, unzip, zstd), run them on a known input, and demand the EXACT expected output
// before trusting the winner. Its own history is a warning: a silent pure-JS SHA-256
// verify under tjs once read as a HANG rather than a FAILURE — a "verifier" that ran
// and reported something wrong is worse than one that never ran, because it looks
// alive. This file is the house-shape (defineGuard/guardTests, per
// test/build-gates/lexical-code-mask.test.cjs and dep-closure-gates.test.cjs) that
// controls provision()'s two throw-sites.
//
// The literal relative require below is load-bearing for Task 5's population sweep,
// which derives "which guard controls this production gate" by reading this exact
// string out of the guard's own source.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
// REGISTRY is deliberately NOT imported: this guard's whole point is that the verdict for
// every call site comes from calling the real provision(), never from re-checking
// Object.keys(REGISTRY) here (see scanKnownRequirementIds below). An unused import of it
// was an invitation to do exactly that.
const { provision, parseSha256 } = require('../../libexec/host-provision.cjs');
const hosttools = require('../../libexec/clode-hosttools.cjs');
const { defineGuard, guardTests, checkGate, BROKEN } = require('../guard.cjs');
const { throwsAsFindings } = require('../throws-as-findings.cjs');
const { stripLineComments, discoverFilesByExt } = require('../source-scan.cjs');

const REPO = path.resolve(__dirname, '..', '..');
const LIBEXEC = path.join(REPO, 'libexec');
const SCRIPTS = path.join(REPO, 'scripts');

// ==========================================================================
// GUARD 1 — provision()'s FIRST throw-site: `REGISTRY[id]` lookup miss ->
// `unknown requirement '${id}'`.
// ==========================================================================
//
// WHAT IT GUARDS. This is host-provision's very first validation, and it fires
// before any probing/spawning happens at all: pass an id with no REGISTRY entry
// and provision() refuses immediately. The concern this guard controls is NOT
// "does the throw fire" (trivially true for any bogus string) — it is the SILENT
// alternative: a future rename of a REGISTRY key, or a call-site typo, that a
// human reviewer skims past because nothing runs it at review time. Left alone,
// that mismatch surfaces for real only the first time a build actually needs
// that tool (e.g. a Windows-only leg needing `unzip`), far from the edit that
// broke it. This guard runs the REAL, exported `provision()` against every
// literal `provision('<id>', …)` call site in the shipped codebase, at test
// time, so the mismatch is caught at the edit instead.
//
// WHAT INPUT TRIPS IT (measured): calling `provision('controlled-unknown-tool', …)`
// — any id string absent from `Object.keys(REGISTRY)` — throws
// `host-provision: unknown requirement 'controlled-unknown-tool'`.
//
// HOW FAKES AVOID THE NETWORK AND THE REAL CACHE. `findTool` is injected to always
// return `null`, so `provision()` never even reaches `spawn()` for a real id (it
// records "not found" for every candidate and throws the SECOND throw-site's
// message instead — a different string, filtered out below by matching only
// `/unknown requirement/i`). `dataDir` is a FIXED path under os.tmpdir() that is
// never created: `provision()`'s cache read wraps ENOENT in a try/catch (see
// `readCache` in host-provision.cjs) and its cache WRITE only runs after a
// candidate's KAT passes — which never happens here, because `findTool` never
// hands back a candidate to verify. So nothing under this path is ever created,
// let alone written to; it is not `~/.local/share/clode` or any real cache.
const NEVER_WRITTEN_DATADIR = path.join(os.tmpdir(), 'clode-hp-guard-unknown-requirement-never-written');

// stripLineComments and discoverFilesByExt come from test/source-scan.cjs (they were
// duplicated verbatim across this file, target-update-gates.test.cjs and
// guards-population.cjs). Comment stripping is what keeps a prose mention of
// `provision('sha256'|'tar')` — host-provision.cjs has one, naude-entry.cjs another —
// from reading as a real call site; source-scan.cjs states which direction each of its
// approximations fails in.

const CALL_SITE_RE = /provision\(\s*['"]([\w-]+)['"]/g;

// read() — the only I/O in this guard: the repo's own libexec/ and scripts/ source
// (never ~/.local/share/clode, never anything this guard could write to). Excludes
// host-provision.cjs itself (its own doc-comment names ids in prose, not a call).
function readRealCallSites() {
  const files = [
    ...discoverFilesByExt(LIBEXEC, ['.cjs', '.js']),
    ...discoverFilesByExt(SCRIPTS, ['.mjs', '.cjs', '.js']),
  ].filter((f) => path.basename(f) !== 'host-provision.cjs');
  const sites = [];
  for (const f of files) {
    const stripped = stripLineComments(fs.readFileSync(f, 'utf8'));
    CALL_SITE_RE.lastIndex = 0;
    let m;
    while ((m = CALL_SITE_RE.exec(stripped))) {
      sites.push({ file: path.relative(REPO, f), id: m[1] });
    }
  }
  return { sites };
}

// PURE from the caller's point of view. The verdict for EVERY site comes from
// actually calling the real, exported `provision()` — never from re-checking
// `Object.keys(REGISTRY).includes(id)` here, which would be exactly the
// duplicated-logic mistake task-2's first attempt made (a second copy of
// production's judgment that cannot notice production regressing).
function scanKnownRequirementIds({ sites }) {
  const findings = [];
  for (const { file, id } of sites) {
    const opts = {
      findTool: () => null,
      spawn: () => { throw new Error('scanKnownRequirementIds: must never spawn'); },
      fs,
      dataDir: NEVER_WRITTEN_DATADIR,
    };
    const { findings: f } = throwsAsFindings(provision, [id, opts], { examined: 1 });
    for (const msg of f) {
      if (/unknown requirement/i.test(msg)) {
        findings.push(`${file}: provision('${id}', …) — the REAL provision() reports '${id}' `
          + `as an unknown requirement: ${msg}`);
      }
    }
  }
  return { findings, examined: sites.length };
}

function unknownRequirementControlInputs() {
  return { sites: [{ file: 'synthetic/control.cjs', id: 'controlled-unknown-tool' }] };
}

// Measured 2026-09-12: `grep -rn "provision(" libexec scripts` with line comments
// stripped (the same stripLineComments() this guard uses) finds 9 real call sites —
// libexec/naude-sea.cjs ('tar'), libexec/bun-graph.cjs ('zstd'),
// libexec/clode-node.cjs ('unzip', 'tar'), libexec/clode-net.cjs ('sha256', 'gzip'),
// libexec/clode-rcodesign.cjs ('tar'), libexec/clode-update.cjs ('sha256'), and
// scripts/build-tjs.cjs ('unzip'). See task-3-report.md for the exact command. The
// floor is that exact count — a drop means either a call site was removed (in which
// case this floor should move with it) or the scan broke.
const guard1 = defineGuard({
  name: 'host-provision-unknown-requirement',
  floor: 9,
  read: readRealCallSites,
  scan: scanKnownRequirementIds,
  control: unknownRequirementControlInputs,
});
guardTests(guard1);

test('floor fires: host-provision-unknown-requirement goes BROKEN below its floor', () => {
  const r = checkGate({
    name: 'floor-probe-1', floor: guard1.floor,
    read: () => ({ sites: [{ file: 'synthetic', id: 'tar' }] }), // fewer than the real 9
    scan: scanKnownRequirementIds,
  });
  assert.strictEqual(r.verdict, BROKEN, r.message);
});

// ==========================================================================
// GUARD 2 — provision()'s SECOND throw-site, for `sha256`: every candidate's
// KAT fails -> `clode: no sha256 tool found on PATH — … [tried: …]`.
// ==========================================================================
//
// WHAT IT GUARDS. `REGISTRY.sha256.verify()` runs a candidate on a fixed known-input
// file (`SHA256_KAT.input = 'clode'`) and demands the candidate's output parse (via
// the real, exported `parseSha256`) to the EXACT expected 64-hex digest
// (`SHA256_KAT.expected`). This is the gate that decides whether a digest tool is
// trustworthy before `clode-net.cjs` uses it to verify a real download. The file's
// own header names the failure mode this exists to prevent: a "verifier" that runs,
// exits 0, and reports something that is NOT the right digest must be rejected, not
// trusted merely because it ran without error — the class of defect that once made a
// broken SHA-256 verify under tjs read as a hang instead of a loud failure.
//
// WHAT INPUT TRIPS IT (measured): every candidate name "resolving" to a tool whose
// stdout is neither a valid 64-hex digest nor the KAT's expected value — a corrupted
// digest — makes `parseSha256()` return null (checked directly below) or a wrong
// hex string, `verify()` reject every candidate, and `provision('sha256', …)` throw
// naming every candidate it tried and why.
//
// HOW FAKES AVOID THE NETWORK AND THE REAL CACHE. The control's `findTool` never
// touches PATH — it fabricates a fake path string per candidate name, entirely in
// memory. Its `spawn` never spawns a subprocess — it is a plain function returning a
// canned `{status: 0, stdout: 'not-a-real-digest'}`, so no binary runs and nothing
// crosses the network. `dataDir` is a FIXED path under os.tmpdir(), and because every
// candidate fails its KAT, `provision()` never reaches its cache-WRITE step (see
// `writeCache` in host-provision.cjs, only called after a KAT passes) — the control
// never creates or writes that directory. `verify()` itself does write ONE temp file
// (the KAT input) via `fs.writeFileSync(path.join(os.tmpdir(), 'clode-kat-sha256-<pid>'))`
// and unlinks it in its own `finally` — this is os.tmpdir() scratch space the real,
// unmodified production code already uses for every real caller (see
// test/host-provision.test.cjs's existing integration tests, which do the same); it
// is not `~/.cache/clode`, `~/.local/share/clode`, `~/.local/bin`, or the Keychain.
//
// The WELL-FORMED (real) case below DOES exercise a real local binary (whatever
// sha256 tool this host actually has — shasum on this box) via real `spawnSync` and
// real `hosttools.findTool`: this is LOCAL EXECUTION of an already-installed tool,
// never a network fetch, and its `dataDir` is a fresh `mkdtemp()` under os.tmpdir(),
// removed in `scanWellFormedSha256`'s own `finally` — never the real
// `~/.local/share/clode/hosttools.json`.
const CONTROL_SHA256_DATADIR = path.join(os.tmpdir(), 'clode-hp-guard-sha256-control-never-written');

function corruptedDigestControlInputs() {
  return {
    id: 'sha256',
    opts: {
      env: {},
      findTool: (name) => `/controlled-fake-bin/${name}`,
      spawn: () => ({ status: 0, stdout: 'not-a-real-digest\n', stderr: '' }),
      fs,
      dataDir: CONTROL_SHA256_DATADIR,
    },
  };
}

// read() — the only I/O in the well-formed half of this guard: a real, already-
// installed host binary, executed locally (no network), with its own throwaway
// dataDir. If this box genuinely has no sha256-family tool at all, `provision()`
// throws for real (a genuine environmental VIOLATION, not a false one) — this
// matches test/host-provision.test.cjs's own unconditional (non-skipped) real
// integration test for the same requirement, so it is not a new assumption.
function readRealSha256() {
  return {
    id: 'sha256',
    opts: {
      dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'clode-hp-guard-sha256-real-')),
      spawn: spawnSync,
      findTool: hosttools.findTool,
      env: process.env,
    },
  };
}

// PURE from the caller's point of view (removes its own throwaway dataDir before
// returning). The verdict comes from calling the real, exported `provision()` —
// never from re-deriving "is this digest correct" here.
function scanProvisionSha256({ id, opts }) {
  try {
    return throwsAsFindings(provision, [id, opts], { examined: 1 });
  } finally {
    try { fs.rmSync(opts.dataDir, { recursive: true, force: true }); } catch { /* absent or never created */ }
  }
}

// Measured 2026-09-12: this guard checks exactly one requirement (`sha256`) per
// run, so `examined` is always 1 on a clean call — see task-3-report.md for the
// command. The floor-fire demonstration below exercises `examined: 0` directly
// through the same `scan`, since a real call can never itself produce fewer than 1.
const guard2 = defineGuard({
  name: 'host-provision-sha256-corrupt-digest',
  floor: 1,
  read: readRealSha256,
  scan: scanProvisionSha256,
  control: corruptedDigestControlInputs,
});
guardTests(guard2);

test('the corrupted-digest control string does not parse as a sha256 digest via the real parseSha256', () => {
  assert.strictEqual(parseSha256('not-a-real-digest\n'), null,
    'this is WHY the corrupted control trips the KAT: the real parser finds no digest at all');
});

test('the corrupted-digest control names the sha256 requirement and the candidates it rejected', () => {
  const { id, opts } = corruptedDigestControlInputs();
  assert.throws(
    () => provision(id, opts),
    (e) => {
      assert.match(e.message, /no sha256 tool found/);
      assert.match(e.message, /tried:/, 'the refusal must report what it tried, not just that it failed');
      return true;
    },
  );
});

test('floor fires: host-provision-sha256-corrupt-digest goes BROKEN below its floor', () => {
  // Unlike guard1's floor-probe (which feeds a genuinely smaller real `sites` list
  // through the SAME production-calling `scanKnownRequirementIds`), guard2's real
  // scan always calls `throwsAsFindings(provision, …, { examined: 1 })` for exactly
  // one id — a single real call can never itself produce `examined < 1`, so floor=1
  // (the honestly MEASURED count, per decision #5) can only be demonstrated firing
  // with a stand-in `scan` that reports what an examined-nothing run would look
  // like. This proves checkGate()'s floor wiring for THIS guard's exact floor value,
  // not a re-derivation of scanProvisionSha256's own logic.
  const r = checkGate({
    name: 'floor-probe-2', floor: guard2.floor,
    read: () => ({}),
    scan: () => ({ findings: [], examined: 0 }),
  });
  assert.strictEqual(r.verdict, BROKEN, r.message);
});

module.exports = {
  readRealCallSites, scanKnownRequirementIds, guard1,
  readRealSha256, scanProvisionSha256, corruptedDigestControlInputs, guard2,
};
