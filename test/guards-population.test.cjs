'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const TEST_DIR = __dirname;
const { classifyTestFile, discoverTestFiles, isRecordedExclusion, MIGRATED } = require('./guards-population.cjs');

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

test('every scanner-shaped test is registered through defineGuard', () => {
  const files = discoverTestFiles(TEST_DIR);
  const unmigrated = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    if (!classifyTestFile(src).scannerShaped) continue;
    if (/require\(['"]\.\/guard\.cjs['"]\)/.test(src)) continue;
    if (isRecordedExclusion(f)) continue;
    unmigrated.push(path.basename(f));
  }
  assert.deepStrictEqual(unmigrated, [],
    'these tests scan an artifact they did not create but ship no positive control, so '
    + 'nothing proves they can fail. Migrate them to defineGuard (test/guard.cjs) or add a '
    + 'recorded exclusion naming why the file is not a guard.');
});
