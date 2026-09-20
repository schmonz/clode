'use strict';
// The shared engine-build machinery, tested on its own terms.
//
// WHY THIS FILE EXISTS. `copyCheckout` was written FOUR times, byte-identically, in
// test/ccache.test.cjs, test/tjs-bytecode-e2e.test.cjs, test/build-tjs-no-node.test.cjs
// and test/tjs-reproducible-engine.test.cjs — and the double-build reproducibility gate
// would have made five. Four copies of a function is four places a fix lands in three.
// test/engine-build-harness.cjs is now the one copy, and this file is what proves the
// pieces of it that a real engine build is too slow to exercise on every push.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  copyCheckout, findBuildDir, listObjects, sha256OfSync, compareArtifacts,
} = require('./engine-build-harness.cjs');

function tmp(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  return dir;
}

// ---- compareArtifacts: the BASENAME DISCIPLINE ------------------------------------
//
// THE TRAP THIS CLOSES, measured on darwin and recorded in BACKLOG.md's per-platform
// reproducibility section: a mach-o ad-hoc code signature's identifier is DERIVED FROM
// THE OUTPUT FILENAME. Snapshot two byte-identical builds as `tjs-a` and `tjs-b` and the
// signature blobs differ, so the comparison manufactures a delta that the build did not
// produce. Any "build twice and compare" that does not hold the basename fixed reports a
// phantom failure on every darwin run. Refusing the comparison outright is the only
// version of this that cannot be forgotten at a call site.

test('compareArtifacts REFUSES two paths whose basenames differ', (t) => {
  const dir = tmp(t, 'harness-basename-');
  const a = path.join(dir, 'tjs-a');
  const b = path.join(dir, 'tjs-b');
  fs.writeFileSync(a, 'same bytes');
  fs.writeFileSync(b, 'same bytes');
  assert.throws(() => compareArtifacts(a, b), /basename/i,
    'comparing differently-named outputs must be refused, not silently allowed: on mach-o '
    + "the ad-hoc signature's identifier comes from the FILENAME, so two byte-identical "
    + 'builds snapshotted under different names differ');
});

test('compareArtifacts accepts identical basenames in different directories', (t) => {
  const dir = tmp(t, 'harness-basename-ok-');
  const a = path.join(dir, 'a', 'tjs');
  const b = path.join(dir, 'b', 'tjs');
  fs.mkdirSync(path.dirname(a)); fs.mkdirSync(path.dirname(b));
  fs.writeFileSync(a, 'same bytes');
  fs.writeFileSync(b, 'same bytes');
  const r = compareArtifacts(a, b);
  assert.strictEqual(r.identical, true, r.summary);
  assert.strictEqual(r.sizeA, r.sizeB);
  assert.strictEqual(r.shaA, r.shaB);
});

// ---- compareArtifacts: it can actually go RED -------------------------------------

test('compareArtifacts detects a ONE-BYTE delta and names the offset', (t) => {
  const dir = tmp(t, 'harness-onebyte-');
  const a = path.join(dir, 'a', 'tjs');
  const b = path.join(dir, 'b', 'tjs');
  fs.mkdirSync(path.dirname(a)); fs.mkdirSync(path.dirname(b));
  const buf = Buffer.alloc(1024 * 1024, 0x41);
  fs.writeFileSync(a, buf);
  const flipped = Buffer.from(buf); flipped[999_999] = 0x42;
  fs.writeFileSync(b, flipped);
  const r = compareArtifacts(a, b);
  assert.strictEqual(r.identical, false,
    'a one-byte delta in a megabyte must be caught — a reproducibility comparator that '
    + 'rounds off is worse than none');
  assert.strictEqual(r.firstDifferingOffset, 999_999);
  assert.strictEqual(r.differingBytes, 1);
  assert.match(r.summary, /999999/);
});

test('compareArtifacts reports a SIZE difference rather than pretending to diff bytes', (t) => {
  const dir = tmp(t, 'harness-size-');
  const a = path.join(dir, 'a', 'tjs');
  const b = path.join(dir, 'b', 'tjs');
  fs.mkdirSync(path.dirname(a)); fs.mkdirSync(path.dirname(b));
  fs.writeFileSync(a, 'abcd');
  fs.writeFileSync(b, 'abcde');
  const r = compareArtifacts(a, b);
  assert.strictEqual(r.identical, false);
  assert.strictEqual(r.sizeA, 4);
  assert.strictEqual(r.sizeB, 5);
  assert.match(r.summary, /size/i);
});

test('compareArtifacts refuses a missing file instead of reporting "differs"', (t) => {
  const dir = tmp(t, 'harness-missing-');
  const a = path.join(dir, 'a', 'tjs');
  fs.mkdirSync(path.dirname(a));
  fs.writeFileSync(a, 'x');
  assert.throws(() => compareArtifacts(a, path.join(dir, 'b', 'tjs')), /does not exist/,
    'a build that produced NO output is a build failure, and must not read as a '
    + 'reproducibility finding');
});

// ---- copyCheckout: no process.platform branch, and it really copies ----------------
//
// The four inlined copies each branched on process.platform to pick a fast copy flag
// (`cp -Rc` clonefile on darwin, `cp -R --reflink=auto` on GNU). House doctrine is
// capability detection, and this one is free: TRY each candidate and fall through on a
// non-zero exit. The extracted version does that, so the behaviour is identical and the
// branch is gone.

test('copyCheckout reproduces a tree, contents and all', (t) => {
  const dir = tmp(t, 'harness-copy-');
  const src = path.join(dir, 'src');
  fs.mkdirSync(path.join(src, 'deps', 'mimalloc'), { recursive: true });
  fs.writeFileSync(path.join(src, 'CMakeLists.txt'), 'project(tjs)');
  fs.writeFileSync(path.join(src, 'deps', 'mimalloc', 'options.c'), 'banner');
  const dest = path.join(dir, 'dest');
  assert.strictEqual(copyCheckout(src, dest), dest);
  assert.strictEqual(fs.readFileSync(path.join(dest, 'CMakeLists.txt'), 'utf8'), 'project(tjs)');
  assert.strictEqual(fs.readFileSync(path.join(dest, 'deps/mimalloc/options.c'), 'utf8'), 'banner');
});

test('copyCheckout names no platform: the fast-copy flags are TRIED, not selected', () => {
  const src = fs.readFileSync(path.join(__dirname, 'engine-build-harness.cjs'), 'utf8');
  const body = src.slice(src.indexOf('function copyCheckout'), src.indexOf('function findBuildDir'));
  assert.ok(!/process\.platform/.test(body),
    'copyCheckout must try candidate copy flags and fall through on failure, not branch on '
    + 'process.platform — house doctrine, and the fall-through is what the four inlined '
    + 'copies already did after their branch anyway');
});

// ---- findBuildDir / listObjects ----------------------------------------------------

test('findBuildDir picks the main engine build dir, not a sibling tool build', (t) => {
  const dir = tmp(t, 'harness-builddir-');
  const main = path.join(dir, 'abc123', 'build');
  const tool = path.join(dir, 'abc123', 'build-depscan');
  fs.mkdirSync(main, { recursive: true }); fs.mkdirSync(tool, { recursive: true });
  fs.writeFileSync(path.join(main, 'CMakeCache.txt'), '');
  fs.writeFileSync(path.join(tool, 'CMakeCache.txt'), '');
  assert.strictEqual(findBuildDir(dir), main);
});

test('findBuildDir THROWS when no main engine build dir is there', (t) => {
  const dir = tmp(t, 'harness-nobuilddir-');
  fs.mkdirSync(path.join(dir, 'build-depscan'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'build-depscan', 'CMakeCache.txt'), '');
  assert.throws(() => findBuildDir(dir), /exactly one/,
    'zero main build dirs must be an error — a harness that returns undefined here goes on '
    + 'to compare nothing and report success');
});

test('listObjects returns every .o, ASM included, relative and sorted', (t) => {
  const dir = tmp(t, 'harness-objs-');
  fs.mkdirSync(path.join(dir, 'z'), { recursive: true });
  for (const rel of ['z/b.c.o', 'a.c.o', 'z/invokeNative.s.o']) {
    fs.writeFileSync(path.join(dir, rel), rel);
  }
  fs.writeFileSync(path.join(dir, 'not-an-object.txt'), '');
  assert.deepStrictEqual(listObjects(dir), ['a.c.o', 'z/b.c.o', 'z/invokeNative.s.o']);
});

test('sha256OfSync agrees with a known vector', (t) => {
  const dir = tmp(t, 'harness-sha-');
  const f = path.join(dir, 'x');
  fs.writeFileSync(f, 'abc');
  assert.strictEqual(sha256OfSync(f),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
