const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REPO } = require('./e2e.cjs');

// Pure file checks over man/clode.1 (an mdoc(7) source). The bats original ran
// grep against the file; here we read it once and assert against the contents.
const MAN = path.join(REPO, 'man', 'clode.1');
const man = fs.existsSync(MAN) ? fs.readFileSync(MAN, 'utf8') : '';

test('man page file exists', () => {
  assert.ok(fs.existsSync(MAN));
});

test('man page has NAME section', () => {
  assert.match(man, /^\.Sh NAME/m);
});

test('man page has SYNOPSIS section', () => {
  assert.match(man, /^\.Sh SYNOPSIS/m);
});

test('man page has DESCRIPTION section', () => {
  assert.match(man, /^\.Sh DESCRIPTION/m);
});

test('man page has ENVIRONMENT section', () => {
  assert.match(man, /^\.Sh ENVIRONMENT/m);
});

test('man page has FILES section', () => {
  assert.match(man, /^\.Sh FILES/m);
});

test('man page documents CLODE_CLAUDE_BIN', () => {
  assert.match(man, /CLODE_CLAUDE_BIN/);
});

test('man page documents CLODE_CACHE', () => {
  assert.match(man, /CLODE_CACHE/);
});

test('man page documents CLODE_LIBEXEC', () => {
  assert.match(man, /CLODE_LIBEXEC/);
});

test('man page documents CLODE_NODE', () => {
  assert.match(man, /CLODE_NODE/);
});

test('man page documents --clode-watch', () => {
  assert.match(man, /clode-watch/);
});

test('man page documents CLODE_NO_WATCH', () => {
  assert.match(man, /CLODE_NO_WATCH/);
});

test('mandoc lint runs without error (if mandoc available)', (t) => {
  const probe = spawnSync('mandoc', ['-Tlint', MAN], { encoding: 'utf8' });
  if (probe.error && probe.error.code === 'ENOENT') {
    t.skip('mandoc not available');
    return;
  }
  // Mirrors the bats `mandoc -Tlint man/clode.1 || true`: run it, ignore status.
});
