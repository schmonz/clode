'use strict';
// The coverage ratchet for phase 4b.
//
// Before this phase, 19 of 42 release legs got no hermeticity verdict at all
// -- every leg with a cross-file or a Windows host, minus the 8 static ones
// whose skip is correct by construction. The check now runs on all of them.
// This file exists so that stops being a fact someone remembers and becomes
// one the suite asserts: a leg that starts skipping again should be as loud as
// a leg that starts failing.
const { test } = require('node:test');
const assert = require('node:assert');

let legsFor;
test.before(async () => { ({ legsFor } = await import('../scripts/tjs-legs.mjs')); });

// The ONLY condition under which a leg may skip the dependency check.
// checkHermeticDeps() has exactly one early return and this is it.
const legMaySkip = (leg) => Boolean(leg.static);

test('every non-static release leg is subject to the dependency check', async () => {
  const legs = legsFor('release');
  assert.ok(legs.length >= 40, `expected the full release matrix, got ${legs.length}`);
  const skipping = legs.filter(legMaySkip);
  const checked = legs.filter((l) => !legMaySkip(l));
  // The numbers are asserted, not just the shape, so a matrix change that
  // moves coverage cannot pass unnoticed. Update them WITH a reason.
  assert.strictEqual(skipping.length, 8,
    `expected 8 static legs to skip by construction, got ${skipping.length}: ${skipping.map((l) => l.leg).join(', ')}`);
  assert.strictEqual(checked.length, legs.length - 8);
});

test('the legs that used to skip are now checked — named, so a regression is legible', () => {
  const legs = legsFor('release');
  // Measured 2026-09-17: every leg with a cross-file or a Windows host, minus
  // the static ones. These are the legs phase 4b converted from "right
  // architecture" to "right architecture AND links nothing it shouldn't".
  const WAS_BLIND = [
    'darwin-x64', 'darwin-x86', 'windows-amd64', 'windows-arm64',
    'linux-riscv64', 'linux-s390x',
    'netbsd-m68k', 'netbsd-sparc64', 'netbsd-alpha', 'netbsd-hppa',
    'netbsd-macppc', 'netbsd-pmax', 'netbsd-sgimips', 'netbsd-i386',
    'netbsd-earmv7hf', 'netbsd-riscv64', 'netbsd-mips64eb', 'netbsd-sh3el',
    'cosmo',
  ];
  const byName = new Map(legs.map((l) => [l.leg, l]));
  const missing = WAS_BLIND.filter((n) => !byName.has(n));
  assert.deepStrictEqual(missing, [],
    'a leg named here no longer exists in the matrix — remove it from WAS_BLIND with a reason');
  const stillBlind = WAS_BLIND.filter((n) => legMaySkip(byName.get(n)));
  assert.deepStrictEqual(stillBlind, [],
    `these legs would skip the dependency check again: ${stillBlind.join(', ')}`);
  assert.strictEqual(WAS_BLIND.length, 19);
});

test('no leg config can reintroduce a host-tool-based skip', () => {
  // The defect shape, not just its instances: checkHermeticDeps must not
  // consult anything about the HOST when deciding whether to check.
  //
  // SCANNED WITH COMMENTS STRIPPED, via the real tokenizer. This test shipped
  // as a raw fn.includes() sweep over the function's whole text, code and
  // prose alike -- so checkHermeticDeps could not NAME otool or ldd even to
  // explain why they were removed, and the comment there degenerated into
  // "...which is why they aren't spelled out here": shipped code documenting
  // a TEST'S limitation instead of the design. Ruling 6 (Task 1, this same
  // branch) already rejected exactly that trade as "worse than the collision"
  // and prescribed the fix, which is sitting right here:
  // test/strip-comments.cjs is a real tokenizer that blanks comments while
  // leaving string literals -- where a genuine `otool` argument or an
  // execFileSync('ldd', ...) call would live -- completely intact. A mention
  // in prose is therefore not a violation; a call still is.
  const fs = require('node:fs');
  const path = require('node:path');
  const { stripComments } = require('./strip-comments.cjs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build-tjs.cjs'), 'utf8');
  const start = src.indexOf('function checkHermeticDeps');
  assert.ok(start > -1);
  const fn = stripComments(src.slice(start, src.indexOf('\n// CLODE_TJS_SMOKE=off', start)));
  for (const hostThing of ['process.platform', 'crossFile', 'otool', 'ldd']) {
    assert.ok(!fn.includes(hostThing),
      `checkHermeticDeps still consults ${hostThing} — the whole point is that the build host is irrelevant`);
  }
});

test('the host-tool sweep can still go red — a real call is caught through the tokenizer', () => {
  // The control for the test above. Stripping comments must narrow what the
  // sweep sees to CODE, not defeat it: an otool/ldd call, a process.platform
  // read, or a cross-file consultation must still be found after tokenizing,
  // including one hidden inside a string literal or a template literal (the
  // exact places test/strip-comments.cjs exists to preserve).
  const { stripComments } = require('./strip-comments.cjs');
  const violations = [
    "  const out = runOut('otool', ['-L', enginePath]);",
    '  const out = runOut(`ldd ${enginePath}`);',
    '  if (process.platform === \'win32\') return;',
    '  if (crossFile) return;',
  ];
  for (const line of violations) {
    const fn = stripComments(`function checkHermeticDeps(enginePath) {\n${line}\n}\n`);
    const hit = ['process.platform', 'crossFile', 'otool', 'ldd'].some((t) => fn.includes(t));
    assert.ok(hit, `the tokenized sweep failed to see a real violation: ${line}`);
  }
  // And the converse, which is the whole reason for the tokenizer: the same
  // words in a COMMENT are not findings.
  const prose = stripComments(
    'function checkHermeticDeps(enginePath) {\n'
    + '  // otool -L and ldd could only read a binary this host can load; that is\n'
    + '  /* why depscan replaced them, and why process.platform and crossFile are gone. */\n'
    + '  return 1;\n}\n');
  for (const t of ['process.platform', 'crossFile', 'otool', 'ldd']) {
    assert.ok(!prose.includes(t), `a prose mention of ${t} must not read as a violation`);
  }
});
