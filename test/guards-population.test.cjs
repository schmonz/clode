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
// libexec/clode-fuse.cjs, a file the narrower test-only walk could never have reached;
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
