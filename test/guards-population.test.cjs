'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const TEST_DIR = __dirname;
const { classifyTestFile, discoverTestFiles, isRecordedExclusion, GUARD_EXCLUSIONS, MIGRATED,
  isMigratedSource, CALLS_BARE_DEFINEGUARD, UNMIGRATED_BASELINE, ratchetUnmigrated,
  unsafeCliRunnerQuoteScans, CLI_QUOTE_SCAN_EXCLUSIONS, isRecordedCliQuoteScanExclusion,
  discoverCliQuoteScanFiles,
} = require('./guards-population.cjs');

test('the classifier recognises a scanner-shaped test', () => {
  const src = `const src = fs.readFileSync(path.join(REPO, 'libexec', 'x.js'), 'utf8');
               assert.ok(!/require\\("net"\\)/.test(src));`;
  assert.strictEqual(classifyTestFile(src).scannerShaped, true);
});

test('the classifier does NOT flag a test that builds its own inputs', () => {
  const src = `const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x-'));
               assert.strictEqual(add(1, 2), 3);`;
  assert.strictEqual(classifyTestFile(src).scannerShaped, false);
});

// Minor (fix round 2, coordinator, 2026-09-04): isRecordedExclusion's empty-`because`
// throw path had no direct test. Push a synthetic bad entry, assert the throw, remove it
// again in `finally` so no other test in this file (which walks the real GUARD_EXCLUSIONS
// array via the real sweep) sees the synthetic entry.
test('isRecordedExclusion throws on a recorded exclusion with an empty `because`', () => {
  GUARD_EXCLUSIONS.push({ file: '__fixture-empty-because__.test.cjs', because: '' });
  try {
    assert.throws(() => isRecordedExclusion('__fixture-empty-because__.test.cjs'),
      /empty `because`/);
  } finally {
    GUARD_EXCLUSIONS.pop();
  }
});

test('isRecordedExclusion throws on a recorded exclusion with a whitespace-only `because`', () => {
  GUARD_EXCLUSIONS.push({ file: '__fixture-whitespace-because__.test.cjs', because: '   ' });
  try {
    assert.throws(() => isRecordedExclusion('__fixture-whitespace-because__.test.cjs'),
      /empty `because`/);
  } finally {
    GUARD_EXCLUSIONS.pop();
  }
});

test('FLOOR: the sweep re-discovers every already-migrated guard', () => {
  // This is the sweep's own positive control, and it is why the sweep cannot go quietly
  // blind: if the classifier stops recognising guard shape, it stops finding the files we
  // KNOW are guards, and this goes red. It strengthens as migration proceeds instead of
  // staling, which a hand-written fixture would not.
  const missed = [];
  for (const rel of MIGRATED) {
    const src = fs.readFileSync(path.join(TEST_DIR, rel), 'utf8');
    if (!classifyTestFile(src).scannerShaped) missed.push(rel);
  }
  assert.deepStrictEqual(missed, [],
    'the classifier failed to recognise a file that IS a registered guard — the classifier '
    + 'is broken, not the files');
});

test('FLOOR: finding zero scanner-shaped tests is BROKEN, never a pass', () => {
  const files = discoverTestFiles(TEST_DIR);
  const shaped = files.filter((f) => classifyTestFile(fs.readFileSync(f, 'utf8')).scannerShaped);
  assert.ok(shaped.length > 0,
    'zero scanner-shaped tests found across the whole suite — the sweep is broken (a walk '
    + 'or classifier regression), NOT "there are no guards"');
});

// RATCHET (fix round 1, 2026-09-04), not a fixed "must be empty" assertion — a coordinator
// ruling overriding the original design. Leaving this test permanently FAILING as an
// intentional to-do marker turns `main` red for the rest of the phase, and a red that is
// EXPECTED stops being read: this project has already paid for exactly that failure mode
// once (a clode-native P0 broke 13 CI jobs at once and went unnoticed because main was
// already red with three tolerated failures — see BACKLOG.md). So this test passes as long
// as the unmigrated count is AT OR BELOW the recorded UNMIGRATED_BASELINE (103 as of fix
// round 3, 2026-09-04 — see the comment on that constant in guards-population.cjs) and only
// goes red when a NEW
// scanner-shaped file skips defineGuard and pushes the count past that baseline — a real,
// actionable regression. The full unmigrated list still prints every run (via
// t.diagnostic), so the backlog stays visible without the suite itself staying red.
test('every scanner-shaped test is registered through defineGuard (ratchet)', (t) => {
  const files = discoverTestFiles(TEST_DIR);
  const unmigrated = [];
  // Weakest-link hardening (with C2, 2026-09-04): every scanner-shaped file must land in
  // EXACTLY ONE of three buckets — migrated, recorded exclusion, or unmigrated. Counted
  // as the walk runs (not re-derived afterward) so a file that falls through all three
  // (the exact C2 shape: `isMigratedSource` false, `isRecordedExclusion` false, yet never
  // pushed to `unmigrated` because some FOURTH, unaccounted-for `continue` dropped it)
  // makes the conservation check below fail loudly instead of silently lowering the count.
  let scannerShapedCount = 0;
  let migratedCount = 0;
  let exclusionCount = 0;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    if (!classifyTestFile(src).scannerShaped) continue;
    scannerShapedCount++;
    // SAME predicate deriveMigrated() uses (guards-population.cjs) — C2's actual bug was
    // this line using a WEAKER, independently-maintained check (`require('./guard.cjs')`
    // present, with no defineGuard() call required), which happily classified a file that
    // merely requires the module as "migrated" without it ever registering a guard.
    if (isMigratedSource(src)) { migratedCount++; continue; }
    if (isRecordedExclusion(f)) { exclusionCount++; continue; }
    unmigrated.push(path.basename(f));
  }
  assert.strictEqual(scannerShapedCount, migratedCount + unmigrated.length + exclusionCount,
    `conservation failed: ${scannerShapedCount} scanner-shaped file(s) but `
    + `${migratedCount} migrated + ${unmigrated.length} unmigrated + ${exclusionCount} `
    + 'excluded do not add up — a file vanished from every bucket instead of being counted '
    + 'in one of them');
  const r = ratchetUnmigrated(unmigrated.length, UNMIGRATED_BASELINE, unmigrated);
  t.diagnostic(r.message);
  assert.ok(r.ok, r.message);
});

// C2 regression test: a file whose ENTIRE guard-related content is a bare
// `require('./guard.cjs');` — no destructure, no defineGuard() call — must NOT be
// counted as migrated. Before this fix, guards-population.test.cjs's own ratchet used a
// looser inline check (`require\(['"]\.\/guard\.cjs['"]\)` with no defineGuard
// requirement at all) that treated exactly this shape as migrated, silently dropping a
// real scanner-shaped-but-unregistered file out of the unmigrated count without it ever
// needing a control. isMigratedSource() (the one predicate now used everywhere) must
// reject it.
test('a file that only requires guard.cjs, with no defineGuard() call, is NOT migrated', () => {
  const src = "'use strict';\nrequire('./guard.cjs');\n"
    + "const fs = require('node:fs');\n"
    + "assert.ok(/some-pattern/.test(fs.readFileSync(path.join(REPO, 'x'), 'utf8')));\n";
  assert.strictEqual(isMigratedSource(src), false,
    'a bare require(\'./guard.cjs\') with no defineGuard() call must not count as migrated');
});

// Weakest-link hardening (with C2, 2026-09-04): MIGRATED is derived STATICALLY (see the
// fix-round-1 note above deriveMigrated()) precisely so loading this module never
// re-executes every migrated guard's tests. That leaves a gap this test closes once,
// deliberately, by actually loading test/guard.cjs plus every MIGRATED file in a
// disposable CHILD process (never in-process — requiring a file that calls node:test's
// top-level `test()` from inside this file's own currently-running test body is not a
// supported registration point, and would pollute this suite's own test count) and
// reading back REGISTRY's size immediately after the synchronous requires finish —
// defineGuard() runs at module-load time, before any guardTests() callback body ever
// executes, so this does not pay for running the guards' real scans/controls. A file
// that vanishes from the MIGRATED list without also vanishing from the real registry (or
// vice versa) means the static text-based derivation has drifted from what actually
// registers guards at runtime — the exact kind of silent mismatch this whole module
// exists to make loud.
test('MIGRATED.length matches test/guard.cjs\'s registry size after loading every migrated file', () => {
  // NOT one-file-one-guard: windows-path-ratchet.test.cjs registers TWO guards
  // (windows-path-ratchet and windows-path-ratchet-regex-division-ambiguity), so the
  // real invariant is at the GUARD-CALL-SITE level, not the file level — count every
  // `defineGuard(` call site across the MIGRATED files themselves (the same predicate
  // isMigratedSource() requires be present at least once) and compare THAT to the
  // registry size after actually loading them.
  const callSiteRe = new RegExp(CALLS_BARE_DEFINEGUARD.source, 'g');
  let expectedGuardCount = 0;
  for (const rel of MIGRATED) {
    const src = fs.readFileSync(path.join(TEST_DIR, rel), 'utf8');
    expectedGuardCount += (src.match(callSiteRe) || []).length;
  }
  const { execFileSync } = require('node:child_process');
  const guardPath = path.join(TEST_DIR, 'guard.cjs');
  const lines = [`const { registered } = require(${JSON.stringify(guardPath)});`];
  for (const rel of MIGRATED) {
    lines.push(`require(${JSON.stringify(path.join(TEST_DIR, rel))});`);
  }
  lines.push('process.stdout.write(String(registered().length));');
  lines.push('process.exit(0);');
  let out;
  try {
    out = execFileSync(process.execPath, ['-e', lines.join('\n')], {
      cwd: TEST_DIR, encoding: 'utf8', timeout: 60000,
    });
  } catch (e) {
    assert.fail(`loading every MIGRATED file in a child process threw: `
      + `${(e && e.stderr) || (e && e.message)}`);
  }
  assert.strictEqual(Number(out), expectedGuardCount,
    `test/guard.cjs's REGISTRY held ${out} guard(s) after requiring every MIGRATED file, `
    + `but the MIGRATED files' own source contains ${expectedGuardCount} defineGuard() `
    + 'call site(s) — a listed file did not actually register a guard, an unlisted file\'s '
    + 'guard leaked in, or a call site\'s guard failed to register, and the static '
    + 'derivation no longer matches runtime reality.');
});

// Proof the ratchet mechanism itself can fail, independent of what the real tree currently
// contains — synthetic counts, not a real sweep run.
test('ratchet: a count ABOVE baseline is a finding (a regression)', () => {
  const r = ratchetUnmigrated(58, 57, ['newly-added.test.cjs']);
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /ABOVE the recorded baseline/);
});

test('ratchet: a count AT baseline is not a finding', () => {
  const r = ratchetUnmigrated(57, 57, []);
  assert.strictEqual(r.ok, true);
});

test('ratchet: a count BELOW baseline is not a finding, and says to lower the baseline', () => {
  const r = ratchetUnmigrated(50, 57, []);
  assert.strictEqual(r.ok, true);
  assert.match(r.message, /lower UNMIGRATED_BASELINE/);
});

// ---- ESCAPE-BLIND DETECTOR (BACKLOG item 8, task-11) -------------------------

test('unsafeCliRunnerQuoteScans: catches the guard-subcommands-gate shape (bracket-class quote, no fix)', () => {
  const src = `const { readFileSync } = require('fs');
    const CLODE_PROVIDER_BIN = 1;
    for (const m of src.matchAll(/\\.command\\(["']([a-z][a-z0-9-]*)/g)) names.add(m[1]);
    // reads cli.cjs`;
  const hits = unsafeCliRunnerQuoteScans(src);
  assert.ok(hits.length > 0, 'must catch a bare bracket-class quote pattern with no fix');
});

test('unsafeCliRunnerQuoteScans: catches the zstd-gap shape (a literal double-quoted string, no fix)', () => {
  const src = `const bin = stageProviderCli();
    const direct = /switch\\("clode-managed-target"\\)/.test(BUNDLE_SRC);`;
  const hits = unsafeCliRunnerQuoteScans(src);
  assert.ok(hits.length > 0, 'must catch a literal-quoted string pattern with no fix');
});

test('unsafeCliRunnerQuoteScans: exempt when the pattern is escape-blind (tolerates any backslash depth before the quote)', () => {
  // Built with plain string concatenation, not a template literal, so the exact
  // characters are unambiguous: this is literally
  //   const bin = stageProviderCli();
  //       const pattern = /switch\(\\*["']clode-managed-target\\*["']\)/;
  //       pattern.test(BUNDLE_SRC);
  // — the `\\*["']` shape test/node-shim-staged-graph.test.cjs and the `Q`
  // convention (test/zlib-zstd-stream-gap.test.cjs) both use to tolerate ANY
  // number of backslashes before the quote.
  const src = 'const bin = stageProviderCli();\n'
    + '    const pattern = /switch\\(\\\\*["\']clode-managed-target\\\\*["\']\\)/;\n'
    + '    pattern.test(BUNDLE_SRC);';
  assert.deepStrictEqual(unsafeCliRunnerQuoteScans(src), []);
});

test('unsafeCliRunnerQuoteScans: exempt when the file reads graph.json\'s real sources instead', () => {
  const src = `const CLODE_PROVIDER_BIN = 1;
    const doc = JSON.parse(fs.readFileSync(graph, 'utf8'));
    for (const src2 of Object.values(doc.sources)) {
      if (/\\.command\\(["']([a-z][a-z0-9-]*)/.test(src2)) names.add('x');
    }`;
  assert.deepStrictEqual(unsafeCliRunnerQuoteScans(src), []);
});

test('unsafeCliRunnerQuoteScans: does not fire on a file with no staged-cli-runner signal at all', () => {
  const src = `require('/\\.command\\(["']/, "totally unrelated code");`;
  assert.deepStrictEqual(unsafeCliRunnerQuoteScans(src), []);
});

test('unsafeCliRunnerQuoteScans: a quote-bearing scan pattern mentioned only in a `//` comment is not flagged', () => {
  const src = `const CLODE_PROVIDER_BIN = 1;
    // old pattern was /\\.command\\(["']/ before the fix
    const doc = JSON.parse(fs.readFileSync(graph.json, 'utf8'));`;
  assert.deepStrictEqual(unsafeCliRunnerQuoteScans(src), []);
});

test('isRecordedCliQuoteScanExclusion throws on an exclusion with an empty `because`', () => {
  CLI_QUOTE_SCAN_EXCLUSIONS.push({ file: '__fixture-empty-because__.test.cjs', because: '' });
  try {
    assert.throws(() => isRecordedCliQuoteScanExclusion('__fixture-empty-because__.test.cjs'),
      /empty `because`/);
  } finally {
    CLI_QUOTE_SCAN_EXCLUSIONS.pop();
  }
});

// THE STANDING GATE: every current test file, for real. This is what converts the
// one-time task-11 sweep into a mechanism — a NEW file that greps a staged cli.cjs for a
// quote-bearing literal with neither known-good fix goes RED here, at authoring time,
// instead of silently reporting a bundle's walls as down (or up) for years.
// FIX ROUND 1 (coordinator review, task-11, 2026-09-05): walks discoverCliQuoteScanFiles()
// — test/*.test.cjs AND every libexec/**/*.cjs,*.mjs + scripts/**/*.cjs,*.mjs — not
// discoverTestFiles(TEST_DIR) alone. This task's OWN defect lived in
// libexec/clode-build.cjs, a file the narrower test-only walk could never have reached;
// fed the PRE-FIX file to this exact classifier and confirmed it fires (see the
// "a synthetic offender" tests above, plus task-11-report.md's fix-round-1 section for
// the real pre-fix file's finding).
test('no test, libexec, or scripts file greps the staged cli.cjs runner for an escape-blind quoted literal', (t) => {
  const files = discoverCliQuoteScanFiles();
  const offenders = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const hits = unsafeCliRunnerQuoteScans(src);
    if (!hits.length) continue;
    if (isRecordedCliQuoteScanExclusion(f)) continue;
    offenders.push(`${path.relative(path.join(TEST_DIR, '..'), f)}: ${JSON.stringify(hits)}`);
  }
  assert.deepStrictEqual(offenders, [],
    'a file greps the staged cli.cjs GRAPH RUNNER for a quote-bearing literal — since '
    + '2.1.243 module sources ride escaped inside a JS string, so this can silently report '
    + "a bundle's walls as intact (or down) for the wrong reason. Fix by reading "
    + "graph.json's `sources` map directly (real strings, no escape level — see "
    + 'test/node-shim-wall-tripwires.test.cjs), or by pinning BOTH encodings with a '
    + 'self-check (the `Q` convention in test/zlib-zstd-stream-gap.test.cjs). '
    + `Offenders:\n${offenders.join('\n')}`);
});

// ---- PRODUCTION BUILD-GATE POPULATION (phase 5b, task 5) --------------------
// The other half of the problem. Everything above sweeps TESTS; these sweep the gates that
// live in production code and run inside `clode build`. See the long comment block above
// PRODUCTION_SCOPE_SKIP in guards-population.cjs for why it is a separate sweep, and for the
// spec erratum (ruling 3) this section corrects.
const {
  discoverProductionFiles, classifyProductionFile, buildGateGuardFiles, modulesNamedByGuard,
  namedProductionModules, controlledProductionModules, PRODUCTION_GATE_EXCLUSIONS, isRecordedProductionGateExclusion,
  UNCONTROLLED_GATE_BASELINE, GATE_SHAPED_FLOOR, ratchetUncontrolledGates, sweepProductionGates,
} = require('./guards-population.cjs');

test('the production classifier recognises a gate: derives a verdict from text AND refuses', () => {
  const src = `const src = fs.readFileSync(artifact, 'utf8');
    if (/\\brequire\\(/.test(src)) throw new Error('bundle still requires at runtime');`;
  assert.strictEqual(classifyProductionFile(src).gateShaped, true);
});

test('the production classifier does NOT flag code that pattern-matches but never refuses', () => {
  // The REFUSES half is what separates a gate from ordinary production code. This shape —
  // inspect, return a value, let the caller decide — is most of libexec/ and is not a gate.
  const src = `function findImports(src) {
      const out = [];
      let m;
      while ((m = SPEC.exec(src))) out.push(m[1]);
      return out;
    }`;
  const c = classifyProductionFile(src);
  assert.strictEqual(c.gateShaped, false);
  assert.match(c.why, /never refuses/);
});

test('the production classifier does NOT flag code that refuses but derives no verdict from bytes', () => {
  const src = `function need(x) { if (!x) throw new Error('missing argument'); return x; }`;
  const c = classifyProductionFile(src);
  assert.strictEqual(c.gateShaped, false);
  assert.match(c.why, /no pattern-match shape/);
});

test('modulesNamedByGuard reads the literal require() path and ignores non-production requires', () => {
  // Ruling 2: the mapping is DERIVED from the require() literal, never declared. A guard
  // also requires test-side helpers (guard.cjs, throws-as-findings.cjs); those must not be
  // mistaken for a production gate under control.
  const src = "const { defineGuard } = require('../guard.cjs');\n"
    + "const { throwsAsFindings } = require('../throws-as-findings.cjs');\n"
    + "const { thing } = require('../../libexec/some-gate.cjs');\n"
    + "const s = require('../../scripts/some-script.mjs');\n";
  // Expected as POSIX literals, not path.join: modulesNamedByGuard() returns toPosixRel()
  // output on every OS (see the windows-only regression this guards against, in
  // guards-population.cjs's toPosixRel comment), so path.join here would silently mismatch
  // on Windows (backslash) while still passing on this box.
  assert.deepStrictEqual(
    modulesNamedByGuard(path.join('test', 'build-gates', 'x.test.cjs'), src),
    ['libexec/some-gate.cjs', 'scripts/some-script.mjs']);
});

test('FLOOR: every registered build-gates guard names a production module the classifier calls a gate', () => {
  // The same move the MIGRATED floor above makes, one layer over: the guards are derived
  // from source text (isMigratedSource), so if classifyProductionFile ever stops recognising
  // gate shape, a guard we KNOW controls a gate ends up naming none and this goes red — the
  // classifier is broken, not the files. It strengthens with every gate phase 5b's successors
  // control, instead of staling the way a hand-written fixture would.
  const guards = buildGateGuardFiles();
  assert.ok(guards.length > 0,
    'no registered guard found under test/build-gates/ — the walk or isMigratedSource broke, '
    + 'NOT "phase 5b controlled nothing"');
  const blind = [];
  for (const guardRel of guards) {
    const src = fs.readFileSync(path.join(TEST_DIR, '..', guardRel), 'utf8');
    const named = modulesNamedByGuard(guardRel, src);
    const gates = named.filter((rel) => classifyProductionFile(
      fs.readFileSync(path.join(TEST_DIR, '..', rel), 'utf8')).gateShaped);
    if (!gates.length) blind.push(`${guardRel} names [${named.join(', ')}], none gate-shaped`);
  }
  assert.deepStrictEqual(blind, [],
    'a registered build-gate guard controls a production module the classifier does not '
    + 'recognise as a gate — the classifier has gone blind to a shape we know is real');
});

test('FLOOR: finding zero gate-shaped production files is BROKEN, never a pass', () => {
  const s = sweepProductionGates();
  assert.ok(s.population > 0, 'the production walk found no files at all — the walk is broken');
  assert.ok(s.gates.length > 0,
    'zero gate-shaped production files across libexec/ and scripts/ — the sweep is broken '
    + '(a walk or classifier regression), NOT "there are no build gates"');
});

test('the production classifier discriminates: it does not call every production file a gate', () => {
  // A sweep that flags everything is as useless as one that flags nothing. Structural rather
  // than "file X is not a gate", so it stays true as the tree changes.
  const s = sweepProductionGates();
  assert.ok(s.gates.length < s.population,
    `every one of ${s.population} production files classified as a gate — the classifier `
    + 'discriminates nothing and its findings mean nothing');
});

test('ratchetUncontrolledGates: a count ABOVE baseline is a finding (a NEW un-controlled gate)', () => {
  const r = ratchetUncontrolledGates(31, 30, ['libexec/new-gate.cjs'], 35, 28);
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /ABOVE the recorded baseline/);
  assert.match(r.message, /libexec\/new-gate\.cjs/);
});

test('ratchetUncontrolledGates: a count AT baseline is not a finding', () => {
  assert.strictEqual(ratchetUncontrolledGates(30, 30, [], 34, 28).ok, true);
});

test('ratchetUncontrolledGates: a count BELOW baseline says to lower the baseline', () => {
  const r = ratchetUncontrolledGates(20, 30, [], 34, 28);
  assert.strictEqual(r.ok, true);
  assert.match(r.message, /lower UNCONTROLLED_GATE_BASELINE/);
});

// FIX ROUND 1 (reviewer): the phase's own thesis applied to its newest instrument. A drop in
// the uncontrolled count looks identical whether someone wrote a control or the classifier
// went partly blind, and the first cut returned ok:true with "Progress" for both. The two
// FLOOR tests only catch TOTAL blindness, so a collapse from 30 uncontrolled to 8 would have
// passed while REPORTING PROGRESS. The gate-shaped floor is checked first, unconditionally.
test('ratchetUncontrolledGates: a COLLAPSE in gates seen is a finding even though the count FELL', () => {
  const r = ratchetUncontrolledGates(8, 30, [], 9, 28);
  assert.strictEqual(r.ok, false);
  assert.match(r.message, /BELOW the recorded floor/);
  assert.match(r.message, /NOT progress/);
});

test('ratchetUncontrolledGates: the real sweep is above the gate-shaped floor', () => {
  const s = sweepProductionGates();
  assert.ok(s.gates.length >= GATE_SHAPED_FLOOR,
    `the classifier sees ${s.gates.length} gate-shaped file(s), below the recorded floor of `
    + `${GATE_SHAPED_FLOOR} — re-cut it deliberately or fix the classifier`);
});

test('isRecordedProductionGateExclusion throws on an exclusion with an empty `because`', () => {
  PRODUCTION_GATE_EXCLUSIONS.push({ file: 'libexec/__fixture__.cjs', because: '' });
  try {
    assert.throws(() => isRecordedProductionGateExclusion('libexec/__fixture__.cjs'),
      /empty `because`/);
  } finally {
    PRODUCTION_GATE_EXCLUSIONS.pop();
  }
});

// REGRESSION (CI run 34762646884, windows-latest only): PRODUCTION_GATE_EXCLUSIONS is keyed
// by a REPO-RELATIVE POSIX literal ('libexec/cli-surface.cjs'), but discoverProductionFiles()
// built its `rel` with path.relative(REPO, f), which yields a BACKSLASH on Windows. The
// literal never matched, cli-surface.cjs counted as uncontrolled, and the ratchet fired at 30
// against a baseline of 29 — a real Windows-only failure with no Windows box needed to catch
// it here: this passes a literal backslash string, which means the same thing on every OS.
// Deliberately calling isRecordedProductionGateExclusion() directly rather than mocking
// path.sep/path.relative — it is the exact function whose mismatch caused the CI failure.
test('isRecordedProductionGateExclusion matches a Windows-shaped (backslash) relative path', () => {
  assert.strictEqual(isRecordedProductionGateExclusion('libexec\\cli-surface.cjs'), true,
    'a backslash-separated rel path (what path.relative(REPO, f) produces on Windows) must '
    + 'match the same POSIX-literal exclusion a POSIX rel path matches');
});

// THE STANDING GATE. A NEW build gate authored under libexec/ or scripts/ with no guard
// under test/build-gates/ naming it pushes the count past the baseline and goes RED here,
// at authoring time — which is the whole point of phase 5b: the first four un-controlled
// build gates were found by accident, and this is the mechanism that means the fifth is not.
test('every gate-shaped production file is named by a registered build-gates guard (ratchet)', (t) => {
  const s = sweepProductionGates();
  assert.strictEqual(s.gates.length, s.controlledCount + s.excludedCount + s.uncontrolled.length,
    `conservation failed: ${s.gates.length} gate-shaped file(s) but ${s.controlledCount} `
    + `controlled + ${s.uncontrolled.length} uncontrolled + ${s.excludedCount} excluded do not `
    + 'add up — a file vanished from every bucket instead of being counted in one of them');
  const r = ratchetUncontrolledGates(s.uncontrolled.length, UNCONTROLLED_GATE_BASELINE,
    s.uncontrolled, s.gates.length, GATE_SHAPED_FLOOR);
  t.diagnostic(`${s.population} production file(s) in scope, ${s.gates.length} gate-shaped, `
    + `${s.controlledCount} controlled by ${buildGateGuardFiles().length} registered guard(s)`);
  t.diagnostic(r.message);
  assert.ok(r.ok, r.message);
});

test('every module a build-gates guard names actually exists', () => {
  // Cheap, but it is the one way the derived mapping could silently go empty: a guard
  // renamed its module and the require() literal rotted, so the mapping names a path
  // nothing reads and the real gate quietly rejoins the uncontrolled count. Walks
  // namedProductionModules() — the RAW reading of the require() literals — deliberately:
  // controlledProductionModules() has to read each module to classify it, so it drops a
  // rotted name rather than crashing, and a rotted name must stay visible SOMEWHERE.
  const missing = [];
  for (const rel of namedProductionModules().keys()) {
    if (!fs.existsSync(path.join(TEST_DIR, '..', rel))) missing.push(rel);
  }
  assert.deepStrictEqual(missing, [], 'a build-gates guard require()s a module that is not there');
});

// FIX ROUND 2 (reviewer): "controlled" was derived from a require() literal alone, which
// proves the guard LOADS the module, not that it CONTROLS it.
// host-provision-gates.test.cjs requires libexec/clode-hosttools.cjs only to borrow
// hosttools.findTool as a fixture, and that made it "controlled". It moved no count only
// because clode-hosttools.cjs is not gate-shaped — add one `throw new Error(` to it and it
// would have become gate-shaped AND "controlled" in the same instant, dropping the
// uncontrolled count to 29 and making ratchetUncontrolledGates report PROGRESS for a
// regression. The derivation is now named AND gate-shaped; this test is the other half:
// the controlled set is PINNED, so a fifth module joining it — incidentally or on purpose —
// goes red here and a human says which it was.
test('the controlled set is EXACTLY the modules a guard was deliberately written for', () => {
  // POSIX literals, not path.join — controlledProductionModules() keys are toPosixRel()
  // output on every OS; a path.join literal would match on this box (path.sep is '/') but
  // silently mismatch on Windows, exactly the bug this whole fix is about.
  //
  // scripts/build-graph.cjs ADDED 2026-09-21, and this is the mechanism working as designed
  // rather than a baseline absorbing a change: the build-graph declaration landed
  // gate-shaped (its bundle-output derivation REFUSES rather than answering empty), pushed
  // the uncontrolled count to 30 against a baseline of 29, and went red at authoring time.
  // test/build-gates/build-graph-gates.test.cjs was written to control that refusal, which
  // returned the count to 29 — so the baseline did NOT move, and the fifth entry here is a
  // human saying which of the two it was.
  assert.deepStrictEqual([...controlledProductionModules().keys()].sort(), [
    'libexec/clode-build.cjs',
    'libexec/host-provision.cjs',
    'libexec/scc-merge.cjs',
    'libexec/target-update-check.cjs',
    'scripts/build-graph.cjs',
  ].sort(),
  'the set of production modules counted as CONTROLLED changed. If a successor phase wrote '
  + 'a new guard, add its module here and lower UNCONTROLLED_GATE_BASELINE. If a guard '
  + 'merely started require()ing a module as a FIXTURE, it is NOT controlled: the count '
  + 'must not fall for it.');
});

test('a module a guard requires only as a FIXTURE is not counted as controlled', () => {
  // Pinned by shape rather than by clode-hosttools.cjs's name, so it stays proven if that
  // particular import ever goes away: a named module that is not gate-shaped must not
  // appear in the controlled map, however it got named.
  const named = [...namedProductionModules().keys()];
  const notGateShaped = named.filter((rel) => !classifyProductionFile(
    fs.readFileSync(path.join(TEST_DIR, '..', rel), 'utf8')).gateShaped);
  assert.ok(notGateShaped.length > 0,
    'no build-gates guard currently names a non-gate-shaped production module — this test '
    + 'has nothing to prove and its premise moved; re-derive it rather than deleting it');
  const controlled = new Set(controlledProductionModules().keys());
  assert.deepStrictEqual(notGateShaped.filter((rel) => controlled.has(rel)), [],
    'a module that is not itself gate-shaped is being counted as a controlled gate');
});

test('discoverProductionFiles skips libexec/node-shim (target runtime, not a build gate)', () => {
  const inShim = discoverProductionFiles().filter((rel) => rel.includes('node-shim/'));
  assert.deepStrictEqual(inShim, [],
    'libexec/node-shim/ is the TARGET\'s Node-API emulation and never runs as a gate during '
    + '`clode build` — see PRODUCTION_SCOPE_SKIP');
});

// FIX ROUND 1 (reviewer) — the live miss. scripts/apicheck.mjs IS a build gate (its own header
// says so) and refuses with `process.exit(runGate())`, a COMPUTED status. The first cut's
// literal-`1-9` rule called it "never refuses", which was factually wrong about that file, and
// shipped alongside a comment claiming no such instance existed. Pinned by shape, not by that
// file's name, so the rule stays proven if apicheck.mjs is ever rewritten.
test('GATE_REFUSES: a COMPUTED non-zero exit status is a refusal', () => {
  const src = "function runGate() { return bad.includes('x') ? 1 : 0; }\nprocess.exit(runGate());";
  assert.strictEqual(classifyProductionFile(src).gateShaped, true);
});

test('GATE_REFUSES: exit(0) and a bare exit() are NOT refusals', () => {
  const clean = "if (names.includes('x')) { report(); }\nprocess.exit(0);";
  assert.strictEqual(classifyProductionFile(clean).gateShaped, false);
  const bare = "if (names.includes('x')) { report(); }\nprocess.exit();";
  assert.strictEqual(classifyProductionFile(bare).gateShaped, false);
});

test('GATE_REFUSES: a ternary and a named-variable exit status are refusals', () => {
  assert.strictEqual(classifyProductionFile(
    "if (src.includes('x')) fail();\nprocess.exit(failed ? 1 : 0);").gateShaped, true);
  assert.strictEqual(classifyProductionFile(
    "if (src.includes('x')) fail();\nprocess.exit(status);").gateShaped, true);
});

// FIX ROUND 1 (reviewer) — the extension-shaped hole. libexec/quaude-blobulate.js (spawned by
// libexec/clode-build.cjs) and libexec/graph-meta.js (spawned by libexec/clode-extract.cjs) are
// real build-path files that landed in NO bucket: not gate-shaped, not excluded, not counted.
// Neither is gate-shaped today, which is precisely why the hole was invisible.
test('the production walk covers .js as well as .cjs and .mjs', () => {
  // POSIX literals, not path.join — see the note on the pinned controlled-set test above.
  const files = discoverProductionFiles();
  for (const rel of ['libexec/quaude-blobulate.js', 'libexec/graph-meta.js']) {
    assert.ok(files.includes(rel),
      `${rel} is spawned on the build path but is outside the production-gate population — `
      + 'an extension-shaped hole in a mechanism whose promise is "the next gate cannot '
      + 'appear unseen"');
  }
  assert.ok(files.some((f) => f.endsWith('.js') && !f.endsWith('.cjs') && !f.endsWith('.mjs')),
    'the walk found no plain .js file at all — the extension list regressed');
});
