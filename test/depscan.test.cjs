'use strict';
// depscan — the cross-capable dependency reader (tools/depscan/depscan.c).
// These tests BUILD it, because a verifier that is never built on this host
// proves nothing about this host. The build is the first assertion.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { depscanExe, runDepscan } = require('./depscan-build.cjs');
const { stripComments } = require('./strip-comments.cjs');

const repo = path.join(__dirname, '..');

test('depscan builds host-native and reports usage on no arguments', () => {
  const r = runDepscan([]);
  assert.strictEqual(r.status, 2, `expected usage exit 2, got ${r.status}: ${r.stderr}`);
  assert.match(r.stderr, /usage: depscan/);
});

test('depscan exits 4, not 0, on a file it cannot read', () => {
  const r = runDepscan([path.join(os.tmpdir(), 'depscan-no-such-file-9e3a')]);
  assert.strictEqual(r.status, 4, `expected 4 for an unreadable file, got ${r.status}`);
});

test('depscan exits 3, not 0, on a file that is not a binary at all', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'depscan-txt-')), 'notabinary');
  fs.writeFileSync(f, 'this is plain text, not ELF, Mach-O or PE\n');
  const r = runDepscan([f]);
  assert.strictEqual(r.status, 3, `expected 3 for an unrecognized container, got ${r.status}`);
  assert.doesNotMatch(r.stdout, /deps=/,
    'an unparseable file must NOT print a deps= line — "found none" and "could not read it" are different answers');
});

test('build-depscan never passes a cross toolchain file', () => {
  // HOST-NATIVE IS THE WHOLE POINT: depscan inspects a binary built for
  // another machine, so it must run on THIS one. Handing it the target's
  // cross-file would build a verifier the build cannot execute.
  //
  // Scanned with comments stripped, not the raw source: build-depscan.mjs's own
  // header comment names both identifiers in prose, to explain why they must never
  // appear as code. A raw-text scan cannot tell that mention apart from a real
  // violation (this repo has hit that exact self-match twice already — the
  // phase-5b no-fuse gate and test/merge-step.test.cjs, both matching the word
  // inside their own header). stripComments() preserves string literals (where the
  // real -DCMAKE_TOOLCHAIN_FILE=... argument would live) and blanks only comments,
  // so a prose mention is not a violation but an actual argument still is.
  const src = fs.readFileSync(path.join(repo, 'scripts/build-depscan.mjs'), 'utf8');
  const code = stripComments(src);
  assert.doesNotMatch(code, /CMAKE_TOOLCHAIN_FILE/,
    'buildDepscan must not pass CMAKE_TOOLCHAIN_FILE — the verifier is a HOST tool');
  assert.doesNotMatch(code, /crossFile/,
    'buildDepscan must not consult the target cross-file at all');
});

const binfmt = require('./fixtures/binfmt.cjs');

// Write a fixture to disk and scan it. Returns the parsed result plus the raw
// run, so a test can assert on both the deps and the exit code.
function scanFixture(buf, name = 'fixture.bin') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'depscan-fx-'));
  const f = path.join(dir, name);
  fs.writeFileSync(f, buf);
  const r = runDepscan([f]);
  const deps = r.stdout.split('\n').filter((l) => l.startsWith('dep=')).map((l) => l.slice(4));
  const counts = r.stdout.split('\n').filter((l) => l.startsWith('deps=')).map((l) => Number(l.slice(5)));
  const format = (r.stdout.match(/^format=(\S+)/m) || [])[1];
  return { ...r, deps, counts, format };
}

test('ELF 64-bit little-endian: reads DT_NEEDED in order', () => {
  // x86-64 (e_machine 62) — the shape linux-x64 ships.
  const out = scanFixture(binfmt.elf({ cls: 2, be: false, machine: 62, needed: ['libc.so.6', 'libm.so.6'] }));
  assert.strictEqual(out.status, 0, out.stderr);
  assert.strictEqual(out.format, 'elf64le');
  assert.deepStrictEqual(out.deps, ['libc.so.6', 'libm.so.6']);
  assert.deepStrictEqual(out.counts, [2]);
});

test('ELF 32-bit BIG-endian: the m68k case otool/ldd cannot read at all', () => {
  // e_machine 4 = EM_68K. netbsd-m68k is built-not-run on an x64 runner, so
  // file(1) is its entire hermeticity proof today. This is the leg this whole
  // task exists for.
  const out = scanFixture(binfmt.elf({ cls: 1, be: true, machine: 4, needed: ['libc.so.12'] }));
  assert.strictEqual(out.status, 0, out.stderr);
  assert.strictEqual(out.format, 'elf32be');
  assert.deepStrictEqual(out.deps, ['libc.so.12']);
});

test('ELF 64-bit BIG-endian: the s390x case', () => {
  const out = scanFixture(binfmt.elf({ cls: 2, be: true, machine: 22, needed: ['libc.so.6'] }));
  assert.strictEqual(out.status, 0, out.stderr);
  assert.strictEqual(out.format, 'elf64be');
  assert.deepStrictEqual(out.deps, ['libc.so.6']);
});

test('ELF with no DT_NEEDED prints deps=0 and exits 0 — parsed, not broken', () => {
  const out = scanFixture(binfmt.elf({ cls: 2, be: false, needed: [] }));
  assert.strictEqual(out.status, 0, out.stderr);
  assert.deepStrictEqual(out.deps, []);
  assert.deepStrictEqual(out.counts, [0],
    'a parsed binary with no dependencies must say deps=0 out loud');
});

test('ELF whose DT_STRTAB points outside any PT_LOAD is MALFORMED, not empty', () => {
  // This is the distinction the old ldd path got wrong: an output shape the
  // parser did not recognize read identically to "verified clean". A strtab
  // we cannot resolve means we do not know the dependencies -- it must never
  // come back as deps=0.
  const out = scanFixture(binfmt.elf({ cls: 2, be: false, needed: ['libc.so.6'], strtabVaddr: 0x9000000 }));
  assert.strictEqual(out.status, 4, `expected malformed exit 4, got ${out.status}`);
  assert.deepStrictEqual(out.counts, [],
    'an unresolvable string table must NOT print a deps= line');
});

test('Mach-O 64-bit little-endian: reads LC_LOAD_DYLIB', () => {
  const out = scanFixture(binfmt.macho({
    bits: 64, be: false, cputype: binfmt.CPU_ARM64,
    needed: ['/usr/lib/libSystem.B.dylib', '/usr/lib/libc++.1.dylib'],
  }));
  assert.strictEqual(out.status, 0, out.stderr);
  assert.strictEqual(out.format, 'macho64le');
  assert.deepStrictEqual(out.deps, ['/usr/lib/libSystem.B.dylib', '/usr/lib/libc++.1.dylib']);
  assert.deepStrictEqual(out.counts, [2]);
});

test('Mach-O 32-bit BIG-endian: the darwin-ppc case', () => {
  // Tiger PPC is a real published run-target, cross-built on arm64. No otool
  // on the build host can read this file.
  const out = scanFixture(binfmt.macho({
    bits: 32, be: true, cputype: binfmt.CPU_PPC, needed: ['/usr/lib/libSystem.B.dylib'],
  }));
  assert.strictEqual(out.status, 0, out.stderr);
  assert.strictEqual(out.format, 'macho32be');
  assert.deepStrictEqual(out.deps, ['/usr/lib/libSystem.B.dylib']);
});

test('fat Mach-O reports EVERY slice separately, not a merged list', () => {
  // The load-bearing test for spec §12 Q4. One hermetic slice must not be
  // able to hide a non-hermetic one.
  const out = scanFixture(binfmt.fat([
    { cputype: binfmt.CPU_ARM64, buf: binfmt.macho({ bits: 64, cputype: binfmt.CPU_ARM64, needed: ['/usr/lib/libSystem.B.dylib'] }) },
    { cputype: binfmt.CPU_PPC, buf: binfmt.macho({ bits: 32, be: true, cputype: binfmt.CPU_PPC, needed: ['/opt/pkg/lib/libintl.8.dylib'] }) },
  ]));
  assert.strictEqual(out.status, 0, out.stderr);
  assert.match(out.stdout, /^format=macho-fat slices=2$/m);
  const slices = out.stdout.split('\n').filter((l) => l.startsWith('slice=')).map((l) => l.slice(6));
  assert.strictEqual(slices.length, 2, `expected 2 slice= headers, got ${slices.length}`);
  assert.deepStrictEqual(out.counts, [1, 1], 'each slice reports its own count');
  assert.deepStrictEqual(out.deps, ['/usr/lib/libSystem.B.dylib', '/opt/pkg/lib/libintl.8.dylib']);
});

test('fat Mach-O whose slice offset runs past the end is MALFORMED', () => {
  const buf = binfmt.fat([
    { cputype: binfmt.CPU_ARM64, buf: binfmt.macho({ needed: ['/usr/lib/libSystem.B.dylib'] }) },
  ]);
  // Corrupt the first fat_arch's offset field (big-endian, at byte 16).
  binfmt.u(buf, 16, 0x7fffffff, 4, true);
  const out = scanFixture(buf);
  assert.strictEqual(out.status, 4, `expected malformed exit 4, got ${out.status}`);
});

test('PE32+ reads the import directory (windows-amd64)', () => {
  const out = scanFixture(binfmt.pe({ plus: true, machine: 0x8664, needed: ['KERNEL32.dll', 'ws2_32.dll'] }), 'fixture.exe');
  assert.strictEqual(out.status, 0, out.stderr);
  assert.strictEqual(out.format, 'pe64');
  assert.deepStrictEqual(out.deps, ['KERNEL32.dll', 'ws2_32.dll']);
  assert.deepStrictEqual(out.counts, [2]);
});

test('PE32 (32-bit optional header) reads the import directory too', () => {
  // The data directory sits at a different offset in PE32 than PE32+; a
  // reader that hardcodes one silently reads garbage for the other.
  const out = scanFixture(binfmt.pe({ plus: false, machine: 0x014c, needed: ['KERNEL32.dll'] }), 'fixture32.exe');
  assert.strictEqual(out.status, 0, out.stderr);
  assert.strictEqual(out.format, 'pe32');
  assert.deepStrictEqual(out.deps, ['KERNEL32.dll']);
});

test('PE with an empty import directory prints deps=0 and exits 0', () => {
  const out = scanFixture(binfmt.pe({ needed: [] }), 'bare.exe');
  assert.strictEqual(out.status, 0, out.stderr);
  assert.deepStrictEqual(out.counts, [0]);
});

test('PE whose import RVA maps into no section is MALFORMED, not empty', () => {
  const buf = binfmt.pe({ needed: ['KERNEL32.dll'] });
  // Point data directory [1] at an RVA no section covers.
  // Data directory [1] is the IMPORT table: base + 112 is directory [0]
  // (export), and corrupting that would leave the import table parsing fine —
  // a test that cannot go red.
  const peAt = 0x80, optAt = peAt + 24, importDirRva = optAt + 112 + 8;
  binfmt.u(buf, importDirRva, 0x7f000000, 4, false);
  const out = scanFixture(buf, 'broken.exe');
  assert.strictEqual(out.status, 4, `expected malformed exit 4, got ${out.status}`);
  assert.deepStrictEqual(out.counts, []);
});

test('ELF DT_RUNPATH is reported as run= — a SONAME has no prefix to deny', () => {
  // The defect this task exists for: DT_NEEDED is a bare SONAME, so the
  // package-manager denylist has nothing to match on. What the FILE declares
  // about where it will look is DT_RUNPATH, and that is true on every machine
  // -- unlike ldd's resolution, which is a fact about the build host.
  const out = scanFixture(binfmt.elf({
    cls: 2, be: false, needed: ['libintl.so.8'], rpath: ['/opt/pkg/lib', '/usr/lib'],
  }));
  assert.strictEqual(out.status, 0, out.stderr);
  assert.deepStrictEqual(out.deps, ['libintl.so.8']);
  const runs = out.stdout.split('\n').filter((l) => l.startsWith('run=')).map((l) => l.slice(4));
  assert.deepStrictEqual(runs, ['/opt/pkg/lib', '/usr/lib'],
    'a colon-separated DT_RUNPATH must be split into one run= line per entry');
});

test('ELF with no RUNPATH emits no run= lines', () => {
  const out = scanFixture(binfmt.elf({ needed: ['libc.so.6'] }));
  assert.strictEqual(out.status, 0, out.stderr);
  assert.doesNotMatch(out.stdout, /^run=/m);
});

test('Mach-O LC_RPATH is reported as run=', () => {
  const out = scanFixture(binfmt.macho({
    needed: ['/usr/lib/libSystem.B.dylib'], rpath: ['/opt/homebrew/lib'],
  }));
  assert.strictEqual(out.status, 0, out.stderr);
  const runs = out.stdout.split('\n').filter((l) => l.startsWith('run=')).map((l) => l.slice(4));
  assert.deepStrictEqual(runs, ['/opt/homebrew/lib']);
});
