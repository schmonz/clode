'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseBuildArgs, resolveBuildOut } = require('../libexec/clode-build.cjs');

test('parseBuildArgs: --list-targets', () => {
  assert.deepStrictEqual(parseBuildArgs(['--list-targets']),
    { naude: false, self: false, out: null, target: null, listTargets: true, keepGoing: false });
});

test('parseBuildArgs: --target Y [--out P]', () => {
  const p = parseBuildArgs(['--target', 'linux-x64', '--out', 'q']);
  assert.strictEqual(p.target, 'linux-x64');
  assert.strictEqual(p.out, 'q');
});

test('parseBuildArgs: --target needs a value', () => {
  assert.match(parseBuildArgs(['--target']).error, /--target needs a platform/);
});

// TASK 6: the exclusivity rule is GONE because what it policed cannot happen. The
// product is parseBuildArgs's second parameter, so it cannot contradict itself, and
// --target composes with each of the three (a cross-built naude, a cross-blobulated
// quaude, a cross-blobulated builder). The old flags are ordinary unknown arguments.
test('parseBuildArgs: the product is a parameter, and --target composes with each', () => {
  for (const [product, want] of [['quaude', { naude: false, self: false }],
                                 ['naude', { naude: true, self: false }],
                                 ['clode', { naude: false, self: true }]]) {
    const p = parseBuildArgs(['--target', 'linux-x64'], product);
    assert.strictEqual(p.error, undefined, `${product} --target must compose`);
    assert.strictEqual(p.target, 'linux-x64');
    assert.strictEqual(p.naude, want.naude);
    assert.strictEqual(p.self, want.self);
  }
});

test('parseBuildArgs: the retired product flags are unknown arguments', () => {
  assert.match(parseBuildArgs(['--self']).error, /unknown argument '--self'/);
  assert.match(parseBuildArgs(['--naude']).error, /unknown argument '--naude'/);
  // And the usage line names the VERB that was actually run, spelled the way it is
  // actually TYPED: `clode build`, but `node scripts/stage0.mjs bootstrap` — there is no
  // `clode` that accepts bootstrap, and this assertion used to pin that non-existent
  // invocation. Both spellings come from libexec/cli-surface.cjs's table (the same field
  // --help renders), so the usage line and the help cannot drift.
  assert.match(parseBuildArgs(['--naude']).error, /usage: clode build \[quaude\|naude\]/);
  assert.match(parseBuildArgs(['--naude'], 'clode').error,
    /usage: node scripts\/stage0\.mjs bootstrap/);
  assert.doesNotMatch(parseBuildArgs(['--naude'], 'clode').error, /usage: clode bootstrap/);
});

test('parseBuildArgs: a flag with no value says WHICH flag, for both verbs', () => {
  // `--out` with nothing after it used to fall through an `args[i] === '--out' &&
  // args[i + 1]` guard into the unknown-argument branch and report
  // `unknown argument '--out'` — for a flag this parser plainly knows — while `--target`
  // two lines below said the useful thing. And the --target message hardcoded "build:"
  // and "clode build --list-targets", so `bootstrap --target` named the wrong verb.
  for (const [product, verb, cmd] of [
    ['quaude', 'build', 'clode build'],
    ['clode', 'bootstrap', 'node scripts/stage0.mjs bootstrap'],
  ]) {
    const noOut = parseBuildArgs(['--out'], product).error;
    assert.match(noOut, new RegExp(`^${verb}: --out needs a path`),
      `${verb} --out with no value must name the flag, not call it unknown`);
    assert.doesNotMatch(noOut, /unknown argument/);
    const noTarget = parseBuildArgs(['--target'], product).error;
    assert.match(noTarget, new RegExp(`^${verb}: --target needs a platform`));
    assert.ok(noTarget.includes(`${cmd} --list-targets`),
      `${verb}'s --target hint must name ${cmd}, not the other verb`);
  }
});

test('parseBuildArgs: bootstrap really does accept --list-targets and --keep-going, and says so', () => {
  // They are parsed by the SAME loop for every product, so bootstrap has always taken
  // them; only the usage line failed to mention it. Accepted-but-undocumented is the same
  // lie as documented-but-ignored.
  assert.strictEqual(parseBuildArgs(['--list-targets'], 'clode').listTargets, true);
  assert.strictEqual(parseBuildArgs(['--keep-going'], 'clode').keepGoing, true);
  assert.strictEqual(parseBuildArgs(['-k'], 'clode').keepGoing, true);
  const usage = parseBuildArgs(['--bogus'], 'clode').error;
  assert.match(usage, /--list-targets/);
  assert.match(usage, /--keep-going/);
});

test('parseBuildArgs: an unknown product is an internal error, never a silent quaude', () => {
  assert.match(parseBuildArgs([], 'kludge').error, /unknown product 'kludge'/);
});

test('parseBuildArgs: plain build unchanged', () => {
  assert.deepStrictEqual(parseBuildArgs([]),
    { naude: false, self: false, out: null, target: null, listTargets: false, keepGoing: false });
});

test('parseBuildArgs: --keep-going / -k', () => {
  assert.strictEqual(parseBuildArgs(['--keep-going']).keepGoing, true);
  assert.strictEqual(parseBuildArgs(['-k']).keepGoing, true);
  assert.strictEqual(parseBuildArgs([]).keepGoing, false);
});

// resolveBuildOut: the .exe suffix follows the TARGET platform, not the host —
// the cross-build naming bug (keying off process.platform got both backwards).
test('resolveBuildOut: default name — .exe follows the target, not the host', () => {
  // windows target from a POSIX host -> still .exe
  assert.strictEqual(resolveBuildOut({ out: null, target: 'windows-amd64', self: false, hostPlatform: 'linux' }), 'quaude.exe');
  assert.strictEqual(resolveBuildOut({ out: null, target: 'windows-arm64', self: false, hostPlatform: 'darwin' }), 'quaude.exe');
  // POSIX target from a Windows host -> NO .exe
  assert.strictEqual(resolveBuildOut({ out: null, target: 'netbsd-sparc', self: false, hostPlatform: 'win32' }), 'quaude');
  assert.strictEqual(resolveBuildOut({ out: null, target: 'linux-x64', self: false, hostPlatform: 'win32' }), 'quaude');
});

test('resolveBuildOut: an explicit --out for a windows target gains .exe if missing', () => {
  // the field-report case: `--out quaude-windows-amd64` must run on Windows
  assert.strictEqual(resolveBuildOut({ out: 'quaude-windows-amd64', target: 'windows-amd64', self: false, hostPlatform: 'linux' }), 'quaude-windows-amd64.exe');
  // already has .exe -> not doubled (case-insensitive)
  assert.strictEqual(resolveBuildOut({ out: 'q.exe', target: 'windows-amd64', self: false, hostPlatform: 'linux' }), 'q.exe');
  assert.strictEqual(resolveBuildOut({ out: 'q.EXE', target: 'windows-amd64', self: false, hostPlatform: 'linux' }), 'q.EXE');
  // non-windows target -> explicit --out respected verbatim, no .exe appended
  assert.strictEqual(resolveBuildOut({ out: 'quaude-netbsd-sparc', target: 'netbsd-sparc', self: false, hostPlatform: 'win32' }), 'quaude-netbsd-sparc');
});

test('resolveBuildOut: a NATIVE windows build (no --target) keeps its explicit --out verbatim', () => {
  // REGRESSION (release 0.20260727.1): the windows BUILDER leg runs
  // `clode bootstrap --out clode-<ver>-windows-amd64` on a windows host; the
  // attest/publish steps expect that EXACT bare name. Appending .exe here (as an
  // over-eager host-based rule did) makes the leg fail "Could not find subject at
  // path clode-<ver>-windows-amd64". Native explicit --out must be untouched.
  assert.strictEqual(resolveBuildOut({ out: 'clode-1.2.3-windows-amd64', target: null, self: true, hostPlatform: 'win32' }), 'clode-1.2.3-windows-amd64');
  assert.strictEqual(resolveBuildOut({ out: 'quaude-x', target: null, self: false, hostPlatform: 'win32' }), 'quaude-x');
});

test('resolveBuildOut: no --target follows the host; bootstrap names clode-native', () => {
  assert.strictEqual(resolveBuildOut({ out: null, target: null, self: false, hostPlatform: 'win32' }), 'quaude.exe');
  assert.strictEqual(resolveBuildOut({ out: null, target: null, self: false, hostPlatform: 'linux' }), 'quaude');
  assert.strictEqual(resolveBuildOut({ out: null, target: null, self: true, hostPlatform: 'win32' }), 'clode-native.exe');
  assert.strictEqual(resolveBuildOut({ out: null, target: 'windows-amd64', self: true, hostPlatform: 'linux' }), 'clode-native.exe');
  assert.strictEqual(resolveBuildOut({ out: null, target: null, self: true, hostPlatform: 'linux' }), 'clode-native');
});
