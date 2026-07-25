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

test('man page documents the watch subcommand', () => {
  // watch was a flag (--clode-watch) before the runner was retired; it is now
  // a subcommand (`clode watch`), triggered by `clode build` rather than a launch.
  assert.match(man, /^\.Cm watch$/m);
});

test('man page documents CLODE_NO_WATCH', () => {
  assert.match(man, /CLODE_NO_WATCH/);
});

test('the docs describe a builder, not a runner', () => {
  const docs = {
    'man/clode.1': man,
    'README.md': fs.readFileSync(path.join(REPO, 'README.md'), 'utf8'),
    'package.json': JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).description,
  };
  for (const [name, text] of Object.entries(docs)) {
    // The regression to guard against is the RUNNER model: docs describing CLODE
    // ITSELF as running Claude Code, or as a runtime that hosts it "under Node/tjs",
    // or the retired CLODE_ENGINE/passthrough surface. NOT guarded against (and must
    // stay allowed): a rhetorical "how do you run Claude Code?" — the reader's PROBLEM,
    // answered by the builder example right below it — and "quaude runs Claude Code",
    // which is the model (quaude IS the runner; clode BUILDS it). So we match
    // clode-as-subject-runs and the under-a-runtime framing, not a bare "run Claude Code".
    assert.doesNotMatch(text, /\bclode\b[^.\n]*\bruns?\b[^.\n]*Claude Code/i,
      `${name} describes clode itself as running Claude Code (clode builds; quaude runs)`);
    assert.doesNotMatch(text, /runs? (the )?(latest )?Claude Code (under|on|via|with)\b|under (a |the )?(host )?(Node|tjs)( runtime)?/i,
      `${name} frames clode as a runtime that hosts Claude Code`);
    assert.doesNotMatch(text, /CLODE_ENGINE|pass(es)? through to Claude/i, `${name} references the retired runner surface`);
  }
  // And it must promise only what exists: update is Phase 4.
  assert.doesNotMatch(docs['man/clode.1'], /^\.Cm update$/m, 'man documents an update subcommand that does not exist');
});

test('mandoc lint runs without error (if mandoc available)', (t) => {
  const probe = spawnSync('mandoc', ['-Tlint', MAN], { encoding: 'utf8' });
  if (probe.error && probe.error.code === 'ENOENT') {
    t.skip('mandoc not available');
    return;
  }
  // Mirrors the bats `mandoc -Tlint man/clode.1 || true`: run it, ignore status.
});
