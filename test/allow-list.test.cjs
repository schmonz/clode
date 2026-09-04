'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { resolveAllowList, sourceContainsWrite } = require('./allow-list.cjs');

test('an entry with no `because` is a finding', () => {
  const r = resolveAllowList([{ pattern: 'build/bundle', provenBy: () => true }]);
  assert.match(r.findings.join('\n'), /because/);
});

test('an exemption for a writer that does not exist is a finding', () => {
  // THE phase-2 defect, made inexpressible. run.mjs exempted
  // REAL_STORE/build-trace.jsonl in Task 3, BEFORE the Task 5 writer existed. From the
  // moment the writer landed every leak was pre-authorised: ten sites leaked into the
  // operator's real ~/.local/share/clode across three rounds with the guard silent,
  // because we had told it to be.
  const r = resolveAllowList([
    { pattern: 'build/future', because: 'the thing that will write here', provenBy: () => false },
  ]);
  assert.match(r.findings.join('\n'), /does not exist|not reachable/i);
  assert.ok(!r.patterns.includes('build/future'),
    'an unproven exemption must NOT be applied — otherwise it still silences the guard');
});

test('a proven, explained entry yields its pattern and no findings', () => {
  const r = resolveAllowList([
    { pattern: '.git', because: 'git refreshes its own index on read-only commands', provenBy: () => true },
  ]);
  assert.deepStrictEqual(r.findings, []);
  assert.deepStrictEqual(r.patterns, ['.git']);
});

test('a provenBy that throws is a finding, not a silent pass', () => {
  const r = resolveAllowList([
    { pattern: 'x', because: 'y', provenBy: () => { throw new Error('boom'); } },
  ]);
  assert.match(r.findings.join('\n'), /boom/);
  assert.ok(!r.patterns.includes('x'));
});

test('plain strings are refused outright', () => {
  assert.throws(() => resolveAllowList(['build/bundle']), /record/i);
});

test('sourceContainsWrite: a clean tree finds nothing', () => {
  const fsm = { readFileSync: () => 'const x = readlinkSync(p); // no write here' };
  const hit = sourceContainsWrite(['/repo/libexec/clode-resolve.cjs'], {
    writeFns: ['writeFileSync', 'symlinkSync'],
    pathLiterals: ["'.local'", "'bin'", "'claude'"],
    fsm,
  });
  assert.deepStrictEqual(hit, { found: false });
});

test('sourceContainsWrite: a writer spelling out the exact path shape is DETECTED', () => {
  const fsm = {
    readFileSync: () => "fs.symlinkSync(target, path.join(home, '.local', 'bin', 'claude'));",
  };
  const hit = sourceContainsWrite(['/repo/libexec/fake-installer.cjs'], {
    writeFns: ['writeFileSync', 'symlinkSync', 'copyFileSync', 'cpSync', 'renameSync', 'appendFileSync'],
    pathLiterals: ["'.local'", "'bin'", "'claude'"],
    fsm,
  });
  assert.strictEqual(hit.found, true);
  assert.strictEqual(hit.file, '/repo/libexec/fake-installer.cjs');
});

test('the claude-bin exemption shape DROPS once its claim is falsified (round-2 fix)', () => {
  // This is run.mjs's LOCAL_BIN_ALLOW 'claude' entry, reproduced here against a fake
  // tree instead of the real repo: it exists to prove clode never writes
  // ~/.local/bin/claude. Add a writer that spells the path out literally (the exact
  // shape a naive future "install ourselves as `claude` too" patch would take) and the
  // entry must drop out of `patterns` — the whole point of making the proof
  // falsifiable, per the coordinator's round-2 finding (base e08e85f).
  const files = ['/repo/libexec/some-future-installer.cjs'];
  const cleanFsm = { readFileSync: () => 'module.exports = {};' };
  const dirtyFsm = {
    readFileSync: () => "fs.symlinkSync(v, path.join(home, '.local', 'bin', 'claude'));",
  };
  const provenBy = (fsm) => !sourceContainsWrite(files, {
    writeFns: ['writeFileSync', 'symlinkSync', 'copyFileSync', 'cpSync', 'renameSync', 'appendFileSync'],
    pathLiterals: ["'.local'", "'bin'", "'claude'"],
    fsm,
  }).found;

  const clean = resolveAllowList(
    [{ pattern: 'claude', because: 'clode never writes ~/.local/bin/claude', provenBy }],
    { fsm: cleanFsm },
  );
  assert.deepStrictEqual(clean.patterns, ['claude']);
  assert.deepStrictEqual(clean.findings, []);

  const dirty = resolveAllowList(
    [{ pattern: 'claude', because: 'clode never writes ~/.local/bin/claude', provenBy }],
    { fsm: dirtyFsm },
  );
  assert.deepStrictEqual(dirty.patterns, [], 'a real writer must drop the exemption, not silence the guard');
  assert.match(dirty.findings.join('\n'), /not reachable/i);
});
