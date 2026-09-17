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

// ---- Task 6 addendum: hardening items (a)-(g) carried forward from Tasks 2-5.

test('(a) a DT_NEEDED value near UINT64_MAX cannot WRAP into a plausible name', () => {
  // DEMONSTRATED by the controller, 2026-09-17: DT_NEEDED = 0xffffffffffffff00
  // with an otherwise valid string table used to wrap `strtab_off + needed[i]`
  // into a small in-bounds offset, printing an EMPTY dependency name and
  // exiting 0 -- which the downstream denylist (only matches names starting
  // with "/") reads as HERMETIC.
  const out = scanFixture(binfmt.elf({ needed: [], rawNeeded: [0xffffffffffffff00n] }));
  assert.strictEqual(out.status, 4, `expected malformed exit 4, got ${out.status}: stdout=${out.stdout}`);
  assert.doesNotMatch(out.stdout, /^dep=/m, 'a wrapped offset must never reach a dep= line, empty or otherwise');
  assert.doesNotMatch(out.stdout, /^deps=/m);
});

test('(a) a DIFFERENT wrap value proves the arithmetic guard, not just the control-char guard, is doing the work', () => {
  // The demonstrated value above happens to wrap into this fixture's
  // .dynamic table, whose first tag byte (DT_NEEDED = 1) is itself a control
  // byte -- so item (c)'s put_dep guard would ALSO reject it, even with
  // item (a)'s arithmetic guard removed. That would make the test above
  // pass for the wrong reason. This value instead wraps to offset 8 (e_ident
  // padding, a plain zero byte, no control-char involved): verified by
  // hand that with ONLY the arithmetic guard removed, this reproduces the
  // exact original bug (`dep=` empty, `deps=1`, exit=0) -- proving the
  // arithmetic guard is independently load-bearing, not redundant with (c).
  const out = scanFixture(binfmt.elf({ needed: [], rawNeeded: [0xfffffffffffffe08n] }));
  assert.strictEqual(out.status, 4, `expected malformed exit 4, got ${out.status}: stdout=${out.stdout}`);
  assert.doesNotMatch(out.stdout, /^dep=/m);
  assert.doesNotMatch(out.stdout, /^deps=/m);
});

test('(b) ELF32 accepts a header exactly 0x34 bytes long, not just 0x40', () => {
  // The old `len < 0x40` check rejected every real ELF32 binary -- ELF32's
  // own header is only 0x34 bytes. Build the smallest possible valid ELF32:
  // e_phnum=0 (no program headers, so nothing beyond the header itself is
  // ever read), which is a real, parseable "statically linked" answer.
  const HDR32 = 0x34;
  const b = Buffer.alloc(HDR32, 0);
  b[0] = 0x7f; b[1] = 0x45; b[2] = 0x4c; b[3] = 0x46;  // \x7fELF
  b[4] = 1;                                             // EI_CLASS = ELFCLASS32
  b[5] = 1;                                             // EI_DATA  = little-endian
  b[6] = 1;                                             // EI_VERSION
  binfmt.u(b, 0x12, 3, 2, false);                       // e_machine = EM_386
  binfmt.u(b, 0x1c, 0, 4, false);                       // e_phoff (unused: e_phnum=0)
  binfmt.u(b, 0x2a, 32, 2, false);                      // e_phentsize
  binfmt.u(b, 0x2c, 0, 2, false);                       // e_phnum = 0
  const out = scanFixture(b);
  assert.strictEqual(out.status, 0, `expected a minimal ELF32 header to parse, got ${out.status}: ${out.stderr}`);
  assert.strictEqual(out.format, 'elf32le');
  assert.deepStrictEqual(out.counts, [0], 'no PT_DYNAMIC means statically linked, a real deps=0 answer');
});

test('(c) an ELF dependency name containing a newline cannot forge the output protocol', () => {
  // DEMONSTRATED by the controller: DT_NEEDED = "/tmp/ok.so\ndeps=1\n
  // format=elf64le machine=62" fabricated a fake deps=1 terminator mid-stream,
  // splitting one dependency into a benign-looking group and hiding a second,
  // real one. put_dep now refuses any control byte outright.
  const out = scanFixture(binfmt.elf({
    needed: ['/tmp/ok.so\ndeps=1\nformat=elf64le machine=62', '/opt/pkg/lib/libevil.so'],
  }));
  assert.strictEqual(out.status, 4, `expected malformed exit 4, got ${out.status}`);
  assert.doesNotMatch(out.stdout, /^deps=/m,
    'a forged protocol line must never reach stdout -- this must fail BEFORE printing any deps= line');
});

test('(c) an ELF dependency name containing a tab is refused the same way', () => {
  const out = scanFixture(binfmt.elf({ needed: ['libc.so.6\tbad'] }));
  assert.strictEqual(out.status, 4, `expected malformed exit 4, got ${out.status}`);
});

test('(c) an ordinary ELF dependency name with no control characters still parses', () => {
  // The guard must not break the common path.
  const out = scanFixture(binfmt.elf({ needed: ['libc.so.6'] }));
  assert.strictEqual(out.status, 0, out.stderr);
  assert.deepStrictEqual(out.deps, ['libc.so.6']);
});

test('(c) a DT_RUNPATH entry containing a newline is refused the same way as a dep name', () => {
  // run= lines are exactly as capable of forging a protocol line as dep=
  // lines are -- the guard on put_line covers both call sites.
  const out = scanFixture(binfmt.elf({ needed: ['libc.so.6'], rpath: ['/opt/pkg/lib\ndeps=99'] }));
  assert.strictEqual(out.status, 4, `expected malformed exit 4, got ${out.status}`);
  assert.doesNotMatch(out.stdout, /^deps=99/m);
});

test('(d) Mach-O whose first load command has cmdsize=0 is MALFORMED, not an infinite loop', () => {
  // `cmdsize < 8` rejects 0 outright -- which is also what stops `at +=
  // cmdsize` from looping forever. Reviewed and fuzzed (218 inputs, 0 hangs)
  // after Task 3, but never committed as a regression test until now.
  const HDR64 = 32;              // bits:64 header: magic..flags (28) + reserved
  const buf = binfmt.macho({ needed: ['/usr/lib/libSystem.B.dylib'] });
  binfmt.u(buf, HDR64 + 4, 0, 4, false);   // corrupt the first command's cmdsize
  const out = scanFixture(buf);
  assert.strictEqual(out.status, 4, `expected malformed exit 4, got ${out.status}`);
});

test('(d) Mach-O whose first load command cmdsize overruns sizeofcmds is MALFORMED', () => {
  const HDR64 = 32;
  const base = binfmt.macho({ needed: ['/usr/lib/libSystem.B.dylib'] });  // sizeofcmds=52
  // Pad the file so an oversized cmdsize still fits inside the FILE but not
  // inside the sizeofcmds the header itself declares -- otherwise this would
  // exercise the same "ran off the end of the file" branch as cmdsize=0 above.
  const buf = Buffer.concat([base, Buffer.alloc(100, 0)]);
  binfmt.u(buf, HDR64 + 4, 100, 4, false);  // > sizeofcmds (52), but within the padded file
  const out = scanFixture(buf);
  assert.strictEqual(out.status, 4, `expected malformed exit 4, got ${out.status}`);
});

test('(e) PE with a zero import-directory RVA prints deps=0 and exits 0 — imports nothing', () => {
  // Distinct from "PE with an empty import directory" above: that fixture
  // still has a nonzero RVA and walks to a table holding only the all-zero
  // terminator. A zero RVA is scan_pe's OTHER "imports nothing" path, and no
  // committed test reached it before this.
  const out = scanFixture(binfmt.pe({ zeroImportDir: true }), 'noimports.exe');
  assert.strictEqual(out.status, 0, out.stderr);
  assert.deepStrictEqual(out.counts, [0]);
});

test('(f) a Mach-O ARM64E slice gets its own label, not a duplicate "arm64"', () => {
  // /bin/sh on an ordinary Mac is 3-way fat (x86_64 + two arm64e slices, per
  // `lipo -info`), and depscan used to print "slice=arm64" for BOTH arm64e
  // slices -- an ambiguous label that defeats per-slice reporting (spec §12
  // Q4: one hermetic slice must not be able to mask a non-hermetic one).
  const out = scanFixture(binfmt.fat([
    { cputype: binfmt.CPU_ARM64, buf: binfmt.macho({
      cputype: binfmt.CPU_ARM64, cpusubtype: binfmt.CPU_SUBTYPE_ARM64E,
      needed: ['/usr/lib/libSystem.B.dylib'],
    }) },
    { cputype: binfmt.CPU_ARM64, buf: binfmt.macho({
      cputype: binfmt.CPU_ARM64, needed: ['/usr/lib/libSystem.B.dylib'],
    }) },
  ]));
  assert.strictEqual(out.status, 0, out.stderr);
  const slices = out.stdout.split('\n').filter((l) => l.startsWith('slice=')).map((l) => l.slice(6));
  assert.deepStrictEqual(slices, ['arm64e', 'arm64'],
    'arm64 and arm64e are the same cputype with different cpusubtypes and must not print the same label');
});
