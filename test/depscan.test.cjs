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
