'use strict';
// cli-surface.test.cjs — phase 3a, task 5. The CLI surface is ONE literal
// (libexec/cli-surface.cjs) and these tests are what make that literal load-bearing
// rather than decorative: help is RENDERED from the table, argv is PARSED against the
// table, and the table's own cross-verb consistency is asserted. The defect this
// replaces: `--target` meant "cross-build a naude" with --naude and "cross-build a
// quaude" without it, with the help text explaining the fallthrough — nobody decided
// that, it accumulated in a 213-line if-chain where each verb documented itself.
const { test } = require('node:test');
const assert = require('node:assert');
const { SURFACE, CHECKOUT_ONLY_VERBS, renderHelp, parseArgv, surfaceFor } = require('../libexec/cli-surface.cjs');

// FIX ROUND 1 (coordinator): this loop used to stop at verbs and subjects, and that left
// the one flag this whole phase exists for unasserted. Measured: mutating renderHelp's
// `if (flags.length)` to `if (false)` removed --target and --out from the rendered help
// and ALL FIVE active tests here stayed green (build's flags happen to be covered
// incidentally by test/clode-build.test.cjs; fetch's --target was covered by nothing,
// anywhere). Flags, globals and env names are now in the loop, and the DOC TEXT is
// checked too — against whitespace-collapsed help, so renderHelp's word wrap cannot
// hide a missing description.
test('help is generated from the table, so the two cannot disagree', () => {
  const help = renderHelp('1.2.3', SURFACE);
  const flat = help.replace(/\s+/g, ' ');
  const documents = (text, what) => assert.ok(flat.includes(String(text).replace(/\s+/g, ' ')), what);
  for (const verb of Object.keys(SURFACE.verbs)) {
    assert.match(help, new RegExp(`clode ${verb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
      `help must document the verb ${verb}`);
  }
  for (const [verb, def] of Object.entries(SURFACE.verbs)) {
    documents(def.summary, `help must carry ${verb}'s summary`);
    for (const subject of Object.keys(def.subjects)) {
      assert.ok(help.includes(subject), `help must name the ${verb} subject ${subject}`);
      documents(def.subjects[subject], `help must describe the ${verb} subject ${subject}`);
    }
    for (const flag of Object.keys(def.flags)) {
      assert.ok(help.includes(flag), `help must document ${verb}'s ${flag}`);
      documents(def.flags[flag], `help must describe ${verb}'s ${flag}`);
    }
    for (const entry of def.env) {
      assert.ok(help.includes(entry.name), `help must document ${verb}'s ${entry.name}`);
      documents(entry.doc, `help must describe ${verb}'s ${entry.name}`);
    }
  }
  for (const global of Object.keys(SURFACE.globals)) {
    assert.ok(help.includes(global), `help must document the global ${global}`);
    documents(SURFACE.globals[global], `help must describe the global ${global}`);
  }
  for (const entry of SURFACE.env) {
    assert.ok(help.includes(entry.name), `help must document the verb-neutral ${entry.name}`);
    documents(entry.doc, `help must describe the verb-neutral ${entry.name}`);
  }
});

test('every table subject parses, and nothing else does', () => {
  for (const [verb, def] of Object.entries(SURFACE.verbs)) {
    for (const subject of Object.keys(def.subjects)) {
      const r = parseArgv([verb, subject], SURFACE);
      assert.strictEqual(r.error, undefined, `${verb} ${subject} must parse`);
      assert.strictEqual(r.subject, subject);
    }
    const bad = parseArgv([verb, 'not-a-subject'], SURFACE);
    assert.ok(bad.error, `${verb} must reject an unknown subject`);
  }
});

test('--target means one thing: every verb that takes it documents it identically', () => {
  const takers = Object.entries(SURFACE.verbs).filter(([, v]) => v.flags['--target']);
  const texts = takers.map(([, v]) => v.flags['--target']);
  assert.ok(texts.length >= 2, 'at least build and fetch take --target');
  assert.strictEqual(new Set(texts.map((t) => t.replace(/ingredient|product/, 'X'))).size, 1,
    '--target must mean the same thing everywhere — that is the defect this table exists to prevent');
  // FIX ROUND 1 (coordinator): sameness-modulo-the-noun is only half the invariant. The
  // normalised-away noun must be the verb's OWN subjectClass, or `build` could document
  // "the INGREDIENT is for PLATFORM-ARCH", pass the check above, and be nonsense.
  for (const [verb, def] of takers) {
    assert.match(def.flags['--target'], new RegExp(`\\b${def.subjectClass}\\b`),
      `clode ${verb}'s --target must name its own subject class ('${def.subjectClass}')`);
  }
});

test('parseArgv records the leading globals in argv order, and only leading ones', () => {
  // Dispatch acts on the FIRST print-and-exit global (clode-main.cjs step 4), which is
  // how `clode --help --version` keeps printing help and `clode --version --help` keeps
  // printing the version — each what it printed before the table existed.
  assert.deepStrictEqual(parseArgv(['--help', '--version'], SURFACE).globalOrder, ['--help', '--version']);
  assert.deepStrictEqual(parseArgv(['--version', '--help'], SURFACE).globalOrder, ['--version', '--help']);
  assert.deepStrictEqual(parseArgv(['--verbose', 'build'], SURFACE).globalOrder, ['--verbose']);
  // After the verb, argv belongs to the verb: a global there is an unknown argument,
  // which is what makes `clode build --help` a build error rather than clode's help.
  const after = parseArgv(['build', '--help'], SURFACE);
  assert.deepStrictEqual(after.globalOrder, []);
  assert.match(after.error, /unknown argument '--help'/);
});

// The brief's fourth assertion, in two halves — because task 5 builds the SPLIT and
// task 6 adds the VERB that uses it (coordinator's dispatch: bootstrap is task 6's).
// The half that is true today is asserted today, structurally, so that task 6's whole
// change really is one entry in one table; the half that is task 6's is SKIPPED with
// the reason rather than left failing. A red that is expected stops being read, and
// this project has already paid for that once (a clode-native P0 broke 13 CI jobs and
// went unnoticed because main was already red with three tolerated failures —
// BACKLOG.md).
test('the shipped table has no bootstrap, and the checkout table is it plus the checkout-only verbs', () => {
  assert.ok(!('bootstrap' in surfaceFor('shipped').verbs), 'a shipped clode cannot bootstrap');
  const shipped = Object.keys(surfaceFor('shipped').verbs);
  const checkout = Object.keys(surfaceFor('checkout').verbs);
  for (const verb of Object.keys(CHECKOUT_ONLY_VERBS)) {
    assert.ok(!shipped.includes(verb), `${verb} is checkout-only — a shipped clode must not carry it`);
  }
  assert.deepStrictEqual(checkout, shipped.concat(Object.keys(CHECKOUT_ONLY_VERBS)),
    'the checkout table is the shipped table plus CHECKOUT_ONLY_VERBS — adding a checkout verb '
    + 'is one entry in one table, never a conditional in dispatch');
});

test('the checkout table has bootstrap',
  { skip: 'task 6 adds the bootstrap entry to CHECKOUT_ONLY_VERBS (and the stage0.mjs wiring); '
        + 'task 5 only builds the shipped/checkout split it goes in' },
  () => {
    assert.ok('bootstrap' in surfaceFor('checkout').verbs, 'the checkout entry point can');
  });

test('surfaceFor refuses a kind that is not an entry point', () => {
  // There are exactly two entry points. A typo'd kind must not quietly hand back the
  // shipped table (which would make "the shipped binary refuses bootstrap" true by
  // accident on the checkout side too).
  assert.throws(() => surfaceFor('checkedout'), /unknown entry-point kind/);
});
