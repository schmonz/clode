'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const TEST_DIR = __dirname;
const { classifyTestFile, discoverTestFiles, isRecordedExclusion, GUARD_EXCLUSIONS, MIGRATED,
  UNMIGRATED_BASELINE, ratchetUnmigrated, unsafeCliRunnerQuoteScans, CLI_QUOTE_SCAN_EXCLUSIONS,
  isRecordedCliQuoteScanExclusion } = require('./guards-population.cjs');

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
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    if (!classifyTestFile(src).scannerShaped) continue;
    if (/require\(['"]\.\/guard\.cjs['"]\)/.test(src)) continue;
    if (isRecordedExclusion(f)) continue;
    unmigrated.push(path.basename(f));
  }
  const r = ratchetUnmigrated(unmigrated.length, UNMIGRATED_BASELINE, unmigrated);
  t.diagnostic(r.message);
  assert.ok(r.ok, r.message);
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
test('no test file greps the staged cli.cjs runner for an escape-blind quoted literal', (t) => {
  const files = discoverTestFiles(TEST_DIR);
  const offenders = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const hits = unsafeCliRunnerQuoteScans(src);
    if (!hits.length) continue;
    if (isRecordedCliQuoteScanExclusion(f)) continue;
    offenders.push(`${path.basename(f)}: ${JSON.stringify(hits)}`);
  }
  assert.deepStrictEqual(offenders, [],
    'a test greps the staged cli.cjs GRAPH RUNNER for a quote-bearing literal — since '
    + '2.1.243 module sources ride escaped inside a JS string, so this can silently report '
    + "a bundle's walls as intact (or down) for the wrong reason. Fix by reading "
    + "graph.json's `sources` map directly (real strings, no escape level — see "
    + 'test/node-shim-wall-tripwires.test.cjs), or by pinning BOTH encodings with a '
    + 'self-check (the `Q` convention in test/zlib-zstd-stream-gap.test.cjs). '
    + `Offenders:\n${offenders.join('\n')}`);
});
