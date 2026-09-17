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
      // Examined = every dependency and search path we actually looked at, so
      // "found nothing" cannot be confused with "looked at nothing".
      examined: parsed.slices.reduce((n, s) => n + s.deps.length + s.runs.length, 0),
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

test('the control produces findings for BOTH a bad dep and a bad RPATH', () => {
  const r = checkControl(engineHermeticity);
  assert.strictEqual(r.verdict, OK, r.message);
  assert.strictEqual(r.findings.length, 2,
    `expected a finding for the dep AND one for the RPATH, got ${r.findings.length}`);
});
