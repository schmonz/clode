'use strict';
// guards-population.cjs — the phase-5 sweep that finds scanner-shaped tests which are
// NOT registered through test/guard.cjs's defineGuard, so that "a guard nobody proved can
// fail" becomes structurally visible instead of quietly possible.
//
// THE DESIGN POINT THAT MAKES THIS SWEEP DIFFERENT FROM EVERY OTHER SCANNER IN THIS REPO:
// its own floor is the migrated population itself (MIGRATED below). It re-discovers every
// guard already registered through defineGuard by reading each candidate file's SOURCE for
// the two textual facts that make it a guard — `require('./guard.cjs')` and a
// `defineGuard(` call — not by hand-listing their names. If classifyTestFile() ever stops
// recognising guard shape, MIGRATED still lists the same files (they are derived from the
// source text, not from the classifier), so the FLOOR test in guards-population.test.cjs
// goes red: the classifier failed to recognise a file we KNOW is a guard. A hand-written
// fixture could not do this — it would stay green forever, describing an encoding that may
// have already drifted, which is the exact "control describes a violation that no longer
// matches the artifact" failure phase 5 exists to close (see the MIGRATED note in
// node-shim-wall-tripwires.test.cjs for the concrete incident this generalises).
//
// STATIC, NOT EXECUTED (fix round 1, 2026-09-04): an earlier version of deriveMigrated()
// required() every candidate file and read test/guard.cjs's registered() before/after to
// confirm it actually registered a guard — provably correct, but it meant merely LOADING
// this module re-ran every migrated guard's entire test file (guardTests() plus every
// other test() in the file) as a side effect, every time. That cost is O(migrated files)
// and was already ~7 extra tests with only two guards migrated; it would have scaled
// linearly with every file Task 14 moves onto this list, making the sweep's own cost grow
// with the very thing it measures. A guard whose defineGuard() call is broken already fails
// LOUDLY on its own — guardTests() asserts the control produces findings and the gate is
// clean — so nothing is lost by not executing it here too; a static source check (both
// facts present in the text) gets the same MIGRATED membership with zero executions.
//
// TUNING RULE (from the spec, verbatim): false positives are the SAFE side. A false
// positive costs one migration or one recorded exclusion with a reason; a false negative
// is a guard nobody proved. When in doubt, flag it.
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');

// Reads something it did not create: a repo-rooted path, a staged provider, or the
// upstream carve. Deliberately NOT "uses readFileSync" — half the suite reads fixtures it
// wrote itself, and flagging those would train people to add exclusions, which is how an
// allow-list becomes noise nobody reads.
const READS_ARTIFACT = [
  /readFileSync\s*\([^)]*\b(REPO|ROOT|__dirname\s*,\s*['"]\.\.)/,
  /stageProviderCli|CLODE_PROVIDER_BIN|CLODE_TJS\b/,
  /graph\.json|cli\.cjs/,
];
// Derives a verdict from the bytes rather than from a value it computed.
const PATTERN_MATCHES = [
  /\/[^\n/]+\/[gimsuy]*\.test\s*\(/,
  /\.match\s*\(\s*\//,
  /\.exec\s*\(/,
  /\.includes\s*\(\s*['"]/,
];

function classifyTestFile(src) {
  const readsArtifact = READS_ARTIFACT.some((re) => re.test(src));
  const derivesFinding = PATTERN_MATCHES.some((re) => re.test(src));
  const scannerShaped = readsArtifact && derivesFinding;
  const why = scannerShaped
    ? 'reads an artifact it did not create AND derives a finding from the bytes'
    : !readsArtifact
      ? 'does not read a repo-rooted/staged/upstream artifact'
      : 'reads an artifact but derives no finding from its bytes (no pattern-match shape)';
  return { scannerShaped, why };
}

// Same walk as test/run.mjs's discoverTests(): recurse, skip dotfiles/dot-dirs and
// node_modules, only *.test.cjs. Deliberately the SAME shape as the real suite's own
// discovery so this sweep sees exactly the population test/run.mjs runs — no separate
// notion of "the test files" that could drift from the one that actually executes.
function discoverTestFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') out.push(...discoverTestFiles(p)); }
    else if (e.name.endsWith('.test.cjs')) out.push(p);
  }
  return out;
}

// GUARD_EXCLUSIONS — a file lands here ONLY when it is genuinely not a guard: it builds
// its own inputs (mkdtemp fixtures, synthetic strings) even though the classifier's
// pattern-shape heuristic also matched some unrelated artifact-reading or bytes-matching
// idiom in its source. An exclusion NEVER means "this one is hard to migrate" — that is a
// Task 14 item, not an exclusion. Every entry needs a real, specific `because`; an entry
// with an empty `because` is itself a failure (checked by isRecordedExclusion below and by
// the self-check test in guards-population.test.cjs analogue... see guard.cjs's own
// convention for `skip` reasons, which this mirrors).
const GUARD_EXCLUSIONS = [
  {
    file: 'guards-population.test.cjs',
    because: 'this IS the sweep — it classifies OTHER tests\' shape and asserts about the '
      + 'discovered file LIST, which trips READS_ARTIFACT (it reads REPO/__dirname-rooted '
      + 'paths, i.e. every other test file) and PATTERN_MATCHES (it contains the very '
      + 'regex literals this module tests, plus .test()/.includes() calls in its own '
      + 'test-body assertions). It does not scan a fixed artifact for a violation; it scans '
      + 'the test suite\'s own SHAPE, and its own FLOOR tests (see guards-population.test.cjs) '
      + 'already ARE its positive control — a file cannot register itself as its own '
      + 'defineGuard guard without becoming circular.',
  },
];

function isRecordedExclusion(file) {
  const base = path.basename(file);
  const entry = GUARD_EXCLUSIONS.find((e) => e.file === base);
  if (!entry) return false;
  if (typeof entry.because !== 'string' || entry.because.trim().length === 0) {
    throw new Error(`GUARD_EXCLUSIONS entry for '${base}' has an empty \`because\` — an `
      + 'exclusion with no stated reason is itself a failure (phase-5 rule: an exclusion '
      + 'means "this test builds its own inputs", never "this one is hard to migrate")');
  }
  return true;
}

// MIGRATED — derived, not declared, and derived STATICALLY (see the fix-round-1 note
// above): a file counts as migrated when its source (a) DESTRUCTURES `defineGuard` out of
// `require('./guard.cjs')` and (b) calls that bare, un-namespaced `defineGuard(` somewhere.
// Both halves matter, and measuring this against the real tree is what found the gap:
// test/guard.test.cjs — the guard MECHANISM's own unit tests — does `const G =
// require('./guard.cjs')` and calls `G.defineGuard(...)` dozens of times to unit-test
// defineGuard() itself against disposable synthetic specs. A loose "requires guard.cjs and
// contains the substring defineGuard(" check (tried first) counted it as migrated, and the
// FLOOR test correctly went red over it — guard.test.cjs is not scanner-shaped (it never
// reads a real artifact) and was never a false negative to begin with, so calling it
// "migrated" was the actual bug, not the classifier. The destructure requirement excludes
// it (no bare `defineGuard` is ever imported), and the negative lookbehind on the call site
// excludes any other `<namespace>.defineGuard(` usage the same way.
const DESTRUCTURES_DEFINEGUARD = /\{[^}]*\bdefineGuard\b[^}]*\}\s*=\s*require\(['"]\.\/guard\.cjs['"]\)/;
const CALLS_BARE_DEFINEGUARD = /(?<![.\w])defineGuard\s*\(/;
function deriveMigrated() {
  const files = discoverTestFiles(__dirname)
    .filter((f) => f !== path.join(__dirname, 'guards-population.test.cjs'))
    .sort();
  const migrated = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    if (!DESTRUCTURES_DEFINEGUARD.test(src)) continue;
    if (!CALLS_BARE_DEFINEGUARD.test(src)) continue;
    migrated.push(path.relative(__dirname, f));
  }
  return migrated;
}
const MIGRATED = deriveMigrated();

// UNMIGRATED_BASELINE — the count of scanner-shaped tests NOT registered through
// defineGuard, as last measured against a real run of this sweep (fix round 1, 2026-09-04:
// 57, after excluding guards-population.test.cjs itself — see GUARD_EXCLUSIONS above).
// MEANT TO GO DOWN: Task 9 (windows-path-ratchet.test.cjs) and Task 14 (the rest) migrate
// files off this list. Never raise it to make a run "look clean" — raising it papers over
// exactly the regression this ratchet exists to catch. Lower it (with a comment recording
// the new measured count and when) whenever a migration makes the real count drop; the
// ratchet test below tells you to when that happens.
const UNMIGRATED_BASELINE = 57;

// Pure ratchet decision — unit-tested directly with synthetic counts (see
// guards-population.test.cjs) as well as through the real file list, so the mechanism is
// provably correct independent of what the tree currently contains. A RATCHET, not a
// fixed-target assertion: `findings` is non-empty only when count RISES past the recorded
// baseline (a NEW scanner-shaped file skipped defineGuard — a real regression). A count at
// or below baseline is `ok`, but a FALL is called out in `message` too, so progress doesn't
// go unnoticed and the baseline gets a deliberate re-cut instead of silently drifting stale
// (the same asymmetry test/node-shim-wall-tripwires.test.cjs's WALLS ratchet uses, and for
// the same reason: leaving improvement undetected is how a ratchet starts lying by omission).
function ratchetUnmigrated(count, baseline, unmigrated) {
  const list = unmigrated.length
    ? ':\n' + unmigrated.map((f) => `    ${f}`).join('\n')
    : ' (none)';
  if (count > baseline) {
    return { ok: false, message: `${count} scanner-shaped test(s) are not registered `
      + `through defineGuard — ABOVE the recorded baseline of ${baseline}. A NEW file `
      + `skipped defineGuard: migrate it (test/guard.cjs) or add a recorded `
      + `GUARD_EXCLUSIONS entry naming why it is not a guard. Unmigrated${list}` };
  }
  if (count < baseline) {
    return { ok: true, message: `${count} scanner-shaped test(s) remain unmigrated — `
      + `BELOW the recorded baseline of ${baseline}. Progress: lower UNMIGRATED_BASELINE `
      + `in test/guards-population.cjs to ${count} so a future regression is caught at the `
      + `new, lower count. Unmigrated${list}` };
  }
  return { ok: true, message: `${count} scanner-shaped test(s) remain unmigrated, matching `
    + `the recorded baseline of ${baseline}. Unmigrated${list}` };
}

module.exports = {
  classifyTestFile,
  discoverTestFiles,
  isRecordedExclusion,
  GUARD_EXCLUSIONS,
  MIGRATED,
  UNMIGRATED_BASELINE,
  ratchetUnmigrated,
  READS_ARTIFACT,
  PATTERN_MATCHES,
};
