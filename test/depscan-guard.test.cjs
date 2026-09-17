'use strict';
// The hermeticity gate, as a guard (test/guard.cjs): read() does the I/O,
// scan() is pure, control() proves it can go red.
const fs = require('node:fs');
const { test } = require('node:test');
const assert = require('node:assert');
const { defineGuard, guardTests, checkControl, OK } = require('./guard.cjs');
const { parseDepscan, hermeticityFindings, PKG_MANAGER_ROOTS } = require('../scripts/depscan-verdict.cjs');

// ---- unit: the parser -------------------------------------------------------

test('parseDepscan splits a fat binary into per-slice groups', () => {
  const p = parseDepscan([
    'format=macho-fat slices=2',
    'slice=arm64', 'dep=/usr/lib/libSystem.B.dylib', 'deps=1',
    'slice=ppc', 'dep=/opt/pkg/lib/libintl.8.dylib', 'deps=1',
  ].join('\n'));
  assert.strictEqual(p.format, 'macho-fat');
  assert.strictEqual(p.slices.length, 2);
  assert.deepStrictEqual(p.slices[1].deps, ['/opt/pkg/lib/libintl.8.dylib']);
});

test('parseDepscan THROWS on output with no deps= line', () => {
  // The whole point of the output contract: "found none" and "could not read
  // it" must never arrive here looking the same.
  assert.throws(() => parseDepscan('format=elf64le machine=62\ndep=libc.so.6\n'),
    /deps=/, 'a group with no deps= terminator must be rejected, not read as empty');
});

test('parseDepscan THROWS when a new slice= starts before the previous one was terminated', () => {
  // Fix round 1. The unterminated group used to be DISCARDED — and the slice it
  // discarded is, by construction, the one carrying the finding: here the arm64
  // slice's /opt/pkg dependency vanished and a clean ppc slice was all that
  // reached hermeticityFindings(), which returned []. Not reachable through
  // today's depscan.c (a malformed slice exits nonzero and runOut throws first),
  // but this parser IS the backstop against forged or drifted output, and a
  // backstop whose one hole is shaped like "drops the slice with the violation"
  // is no backstop at all.
  assert.throws(() => parseDepscan([
    'format=macho-fat slices=2',
    'slice=arm64', 'dep=/opt/pkg/lib/libevil.dylib',
    'slice=ppc', 'deps=0',
  ].join('\n')), /did not complete/);
});

test('parseDepscan THROWS when fewer slices arrive than the header declared', () => {
  // THE hole this fix wave closes, and the input is the REPRODUCED transcript
  // verbatim: a 2-slice universal whose SECOND slice was corrupt printed its
  // header, then slice 0's complete group, then exited 4. Every line of that
  // is well-formed -- the group closes, the count matches, nothing is
  // unterminated -- so this parser used to return one clean slice and
  // hermeticityFindings() returned [], because it DISCARDED `slices=2` when it
  // split the format line. The /opt/pkg dependency in slice 1 was not hidden,
  // it was simply never mentioned.
  //
  // depscan.c no longer emits this (it proves every slice parses before it
  // prints anything), but the parser must reject it anyway: the caller's
  // exit-status check was the ONLY thing standing between this transcript and
  // a false hermetic verdict, and a check one guard deep is the shape this
  // repo distrusts. Same defence as the deps=N vs dep= count check, one level
  // up.
  assert.throws(() => parseDepscan([
    'format=macho-fat slices=2',
    'slice=arm64', 'dep=/usr/lib/libSystem.B.dylib', 'deps=1',
  ].join('\n')), /declared slices=2 but 1 slice/,
  'a transcript missing a declared slice must be rejected, not read as a clean one-slice answer');
});

test('parseDepscan THROWS on a MORE slices than declared too — the count is an equality', () => {
  // The other direction is just as much a lie about what was scanned, and a
  // one-sided `slices.length < declared` check would let a fabricated extra
  // group (the shape put_dep's control-byte guard exists to stop) through.
  assert.throws(() => parseDepscan([
    'format=macho-fat slices=1',
    'slice=arm64', 'deps=0',
    'slice=ppc', 'deps=0',
  ].join('\n')), /declared slices=1 but 2 slice/);
});

test('parseDepscan accepts a fat transcript whose slice count matches', () => {
  // The guard must not reject the good case: same fixture as the per-slice
  // test above, asserted here for the count specifically.
  const p = parseDepscan([
    'format=macho-fat slices=3',
    'slice=x86_64', 'dep=/usr/lib/libSystem.B.dylib', 'deps=1',
    'slice=arm64e', 'dep=/usr/lib/libSystem.B.dylib', 'deps=1',
    'slice=arm64', 'dep=/usr/lib/libSystem.B.dylib', 'deps=1',
  ].join('\n'));
  assert.strictEqual(p.slices.length, 3);
});

test('parseDepscan still parses a NON-fat header, which declares no slice count', () => {
  // format=elf64le machine=62 carries a second token that is NOT slices=; the
  // count check must stay inert there rather than reading machine=62 as one.
  const p = parseDepscan('format=elf64le machine=62\ndep=libc.so.6\ndeps=1\n');
  assert.strictEqual(p.format, 'elf64le');
  assert.strictEqual(p.slices.length, 1);
});

test('parseDepscan accepts deps=0 as a real, complete answer', () => {
  const p = parseDepscan('format=elf64le machine=62\ndeps=0\n');
  assert.deepStrictEqual(p.slices, [{ slice: null, deps: [], runs: [] }]);
});

// ---- unit: the denylist -----------------------------------------------------

test('hermeticityFindings flags an absolute dep inside a package-manager prefix', () => {
  const f = hermeticityFindings(parseDepscan(
    'format=macho64le machine=arm64\ndep=/opt/homebrew/lib/libfoo.dylib\ndeps=1\n'), PKG_MANAGER_ROOTS);
  assert.strictEqual(f.length, 1);
  assert.match(f[0], /\/opt\/homebrew/);
});

test('hermeticityFindings flags an RPATH inside a package-manager prefix', () => {
  // The ELF case: the dep is a bare SONAME with nothing to match, and the
  // hazard is the search path baked into the binary.
  const f = hermeticityFindings(parseDepscan(
    'format=elf64le machine=62\nrun=/opt/pkg/lib\ndep=libintl.so.8\ndeps=1\n'), PKG_MANAGER_ROOTS);
  assert.strictEqual(f.length, 1);
  assert.match(f[0], /\/opt\/pkg\/lib/);
  assert.match(f[0], /search path|RPATH|RUNPATH/i);
});

test('hermeticityFindings does NOT flag /usr/lib or a bare SONAME', () => {
  // Inherits the /lib64-vs-/lib regression from the pre-depscan denylist: an
  // allowlist of ['/lib/', '/usr/lib/'] flagged glibc's own dynamic linker,
  // because '/lib64/ld-linux-x86-64.so.2' does not start with '/lib/'. That
  // would have failed the native linux-x64-glibc leg on every build.
  const f = hermeticityFindings(parseDepscan(
    'format=elf64le machine=62\ndep=libc.so.6\ndep=/lib64/ld-linux-x86-64.so.2\ndeps=2\n'), PKG_MANAGER_ROOTS);
  assert.deepStrictEqual(f, []);
});

test('/usr/local is denied but /usr/locale is not — prefix match is path-aware', () => {
  const bad = hermeticityFindings(parseDepscan(
    'format=macho64le machine=arm64\ndep=/usr/local/lib/libx.dylib\ndeps=1\n'), PKG_MANAGER_ROOTS);
  assert.strictEqual(bad.length, 1);
  const ok = hermeticityFindings(parseDepscan(
    'format=macho64le machine=arm64\ndep=/usr/localetest/libx.dylib\ndeps=1\n'), PKG_MANAGER_ROOTS);
  assert.deepStrictEqual(ok, [], 'a sibling directory that merely shares a prefix must not match');
});

test('a finding names the SLICE on a fat binary', () => {
  const f = hermeticityFindings(parseDepscan([
    'format=macho-fat slices=2',
    'slice=arm64', 'dep=/usr/lib/libSystem.B.dylib', 'deps=1',
    'slice=ppc', 'dep=/opt/pkg/lib/libintl.8.dylib', 'deps=1',
  ].join('\n')), PKG_MANAGER_ROOTS);
  assert.strictEqual(f.length, 1);
  assert.match(f[0], /ppc/, 'a per-slice finding must say WHICH slice — that is why we report per slice');
});

// ---- the guard --------------------------------------------------------------

const engineHermeticity = defineGuard({
  name: 'engine-hermeticity',
  floor: 1,
  read() {
    const p = process.env.CLODE_DEPSCAN_ENGINE;
    if (!p) return { skip: 'CLODE_DEPSCAN_ENGINE is unset — no built engine to inspect (the build itself runs this check inline; this guard is the suite-side copy)' };
    if (!fs.existsSync(p)) return { skip: `CLODE_DEPSCAN_ENGINE=${p} does not exist` };
    const { depscanExe } = require('./depscan-build.cjs');
    const r = require('node:child_process').spawnSync(depscanExe(), [p], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`depscan could not read ${p} (exit ${r.status}): ${r.stderr}`);
    return { output: r.stdout, roots: PKG_MANAGER_ROOTS };
  },
  scan({ output, roots }) {
    const parsed = parseDepscan(output);
    return {
      findings: hermeticityFindings(parsed, roots),
      // Examined = complete dependency TABLES read (one per slice), not
      // individual deps. "Found nothing" and "looked at nothing" still cannot
      // be confused: parseDepscan throws unless every group was terminated by
      // a deps= line, so an examined count of N means N tables were read to
      // the end. Counting deps instead was measured WRONG against a real
      // shipped engine — the statically-linked linux-arm64 template has zero
      // dynamic dependencies by construction, which is the STRONGEST possible
      // hermeticity result, and the floor reported it as BROKEN (the guard is
      // blind). Zero dependencies is an answer; no table is not.
      examined: parsed.slices.length,
    };
  },
  control() {
    // A binary that links a pkgsrc library and carries a Homebrew RPATH: the
    // exact violation this gate claims to catch.
    return {
      output: [
        'format=elf64le machine=62',
        'run=/opt/homebrew/lib',
        'dep=/opt/pkg/lib/libintl.so.8',
        'deps=1',
      ].join('\n'),
      roots: PKG_MANAGER_ROOTS,
    };
  },
});

guardTests(engineHermeticity);

test('a statically linked engine reads as EXAMINED, not BROKEN', () => {
  // Regression, found running the gate against the real linux-arm64 engine
  // template (ELF, aarch64, statically linked): with examined counted in
  // dependencies it was 0, under the floor of 1, so the guard called itself
  // blind on the one artifact shape that cannot possibly be non-hermetic. The
  // musl legs ship exactly this shape, and this guard now runs on every CI leg.
  const r = engineHermeticity.scan({
    output: 'format=elf64le machine=183\ndeps=0\n',
    roots: PKG_MANAGER_ROOTS,
  });
  assert.deepStrictEqual(r.findings, []);
  assert.ok(r.examined >= engineHermeticity.floor,
    `a complete, empty dependency table must clear the floor: examined ${r.examined}, floor ${engineHermeticity.floor}`);
});

test('the control produces findings for BOTH a bad dep and a bad RPATH', () => {
  const r = checkControl(engineHermeticity);
  assert.strictEqual(r.verdict, OK, r.message);
  assert.strictEqual(r.findings.length, 2,
    `expected a finding for the dep AND one for the RPATH, got ${r.findings.length}`);
});
