const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const G = require('./hermetic-guard.cjs');

test('snapshot marks absent vs present and diff detects a new/changed entry', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-'));
  const target = path.join(dir, 'store');
  const before = G.snapshot([target]);
  // target does not exist yet, so this pins the ABSENT sentinel specifically
  // (distinct from EMPTY, which a since-created-but-empty directory gets instead).
  assert.match(before[0], /\|ABSENT$/);
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'f'), 'x');
  const after = G.snapshot([target]);
  const changed = G.diffSnapshots(before, after);
  assert.ok(changed.length > 0);
  assert.ok(changed.some((l) => l.includes(target)));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('diff is empty when nothing changed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-'));
  const snap = G.snapshot([dir]);
  assert.deepStrictEqual(G.diffSnapshots(snap, G.snapshot([dir])), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

const fs2 = require('node:fs');
const os2 = require('node:os');
const path2 = require('node:path');

test('snapshot sees a modification three levels down (was blind)', () => {
  const root = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'herm-deep-'));
  fs2.mkdirSync(path2.join(root, 'a', 'b'), { recursive: true });
  const f = path2.join(root, 'a', 'b', 'f.txt');
  fs2.writeFileSync(f, 'one');
  const before = G.snapshot([root]);
  fs2.writeFileSync(f, 'two-is-longer');
  const changed = G.diffSnapshots(before, G.snapshot([root]));
  assert.ok(changed.length > 0, 'deep modification must be reported, got none');
  assert.ok(changed.join('\n').includes('f.txt'), `expected f.txt in: ${changed.join(', ')}`);
});

test('a watched root going from absent to an existing empty directory produces a non-empty diff', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-empty-'));
  const target = path.join(dir, 'store');
  const before = G.snapshot([target]);
  fs.mkdirSync(target);
  const after = G.snapshot([target]);
  const changed = G.diffSnapshots(before, after);
  assert.ok(changed.length > 0, 'absent -> existing empty directory must be reported, got none');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a watched root that is a plain file reports a content change', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-file-'));
  const target = path.join(dir, 'watched.txt');
  fs.writeFileSync(target, 'one');
  const before = G.snapshot([target]);
  fs.writeFileSync(target, 'two-is-longer');
  const after = G.snapshot([target]);
  const changed = G.diffSnapshots(before, after);
  assert.ok(changed.length > 0, "a watched file's content change must be reported, got none");
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a genuinely absent watched root reports the ABSENT sentinel, distinct from EMPTY', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-absent-'));
  const missing = path.join(dir, 'does-not-exist');
  const snap = G.snapshot([missing]);
  assert.match(snap[0], /\|ABSENT$/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Counterweight for run.mjs's GUARD_WATCH exclusions (test/run.mjs, around GUARD_WATCH):
// an exclusion list is only as trustworthy as proof the guard STILL catches everything
// it didn't name. These two tests use fixture dirs shaped like the two real watched
// roots (~/.cache/clode with a tjs-vendor corner; <repo>/build with a bundle corner) —
// never the user's actual dirs — and each pins BOTH directions: a write inside the
// named exclusion must vanish, a write anywhere else under the same root must not.

test('{path, ignore} entry: a write inside the ignored tjs-vendor corner is silent, a write elsewhere under the cache root is not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-cache-'));
  const vendor = path.join(dir, 'tjs-vendor');
  fs.mkdirSync(path.join(vendor, 'src'), { recursive: true });
  fs.writeFileSync(path.join(vendor, 'src', 'main.c'), 'int main(){}');
  fs.writeFileSync(path.join(dir, 'other-tool.bin'), 'x');
  const watched = { path: dir, ignore: ['tjs-vendor'] };
  const before = G.snapshot([watched]);

  // Stands in for test/tjs-darwin-poll-fixup.test.cjs:29 running
  // `build-tjs.mjs --source-only`, which rewrites files under tjs-vendor on purpose.
  fs.writeFileSync(path.join(vendor, 'src', 'main.c'), 'int main(){return 1;}');
  assert.deepStrictEqual(G.diffSnapshots(before, G.snapshot([watched])), [],
    'a write inside the ignored tjs-vendor prefix must not be reported');

  // Anything else under the same watched cache root is still a real violation.
  fs.writeFileSync(path.join(dir, 'other-tool.bin'), 'yy');
  const changed = G.diffSnapshots(before, G.snapshot([watched]));
  assert.ok(changed.length > 0, 'a write elsewhere under the watched cache root must still be reported');
  assert.ok(changed.join('\n').includes('other-tool.bin'), `expected other-tool.bin in: ${changed.join(', ')}`);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('{path, ignore} entry: a write inside the ignored scratch corner is silent, a write elsewhere under the cache root is not (Finding 4)', () => {
  // Fixture shaped like the REAL watched root as of Finding 4: ~/.cache/clode with
  // BOTH a tjs-vendor corner and a scratch corner ignored — build-scratch.cjs's
  // last-resort allocator candidate. Proves the new 'scratch' exclusion works AND
  // that adding it did not blind the guard to anything else under the same root
  // (including the pre-existing tjs-vendor corner, still exercised alongside it).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-scratch-'));
  const scratch = path.join(dir, 'scratch');
  fs.mkdirSync(path.join(scratch, 'toolchain', 'macos-14-arm64-node24'), { recursive: true });
  fs.writeFileSync(path.join(scratch, 'toolchain', 'macos-14-arm64-node24', 'esbuild.bin'), 'x');
  fs.writeFileSync(path.join(dir, 'other-tool.bin'), 'x');
  const watched = { path: dir, ignore: ['tjs-vendor', 'scratch'] };
  const before = G.snapshot([watched]);

  // Stands in for a real build running through build-scratch.cjs's allocator, which
  // falls through to <cacheBase>/clode/scratch only on a hardened guest / noexec
  // /tmp / no-TMPDIR host — this write is that allocator doing its job, not a
  // violation of it.
  fs.writeFileSync(path.join(scratch, 'toolchain', 'macos-14-arm64-node24', 'esbuild.bin'), 'yy');
  assert.deepStrictEqual(G.diffSnapshots(before, G.snapshot([watched])), [],
    'a write inside the ignored scratch prefix must not be reported');

  // Anything else under the same watched cache root is still a real violation — the
  // new exclusion must not blind the guard beyond exactly what it names.
  fs.writeFileSync(path.join(dir, 'other-tool.bin'), 'yy');
  const changed = G.diffSnapshots(before, G.snapshot([watched]));
  assert.ok(changed.length > 0, 'a write elsewhere under the watched cache root must still be reported');
  assert.ok(changed.join('\n').includes('other-tool.bin'), `expected other-tool.bin in: ${changed.join(', ')}`);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('{path, ignore} entry: a write inside the ignored bundle corner is silent, a write elsewhere under build/ is not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-build-'));
  const bundle = path.join(dir, 'bundle');
  fs.mkdirSync(bundle);
  fs.writeFileSync(path.join(bundle, 'clode-main.bundle.cjs'), 'x');
  fs.writeFileSync(path.join(dir, 'other-artifact.txt'), 'x');
  const watched = { path: dir, ignore: ['bundle'] };
  const before = G.snapshot([watched]);

  // Stands in for scripts/build-clode-main.mjs:30, whose declared output dir is
  // build/bundle.
  fs.writeFileSync(path.join(bundle, 'clode-main.bundle.cjs'), 'yy');
  assert.deepStrictEqual(G.diffSnapshots(before, G.snapshot([watched])), [],
    'a write inside the ignored bundle prefix must not be reported');

  // Anything else under the same watched build root is still a real violation.
  fs.writeFileSync(path.join(dir, 'other-artifact.txt'), 'yy');
  const changed = G.diffSnapshots(before, G.snapshot([watched]));
  assert.ok(changed.length > 0, 'a write elsewhere under the watched build root must still be reported');
  assert.ok(changed.join('\n').includes('other-artifact.txt'), `expected other-artifact.txt in: ${changed.join(', ')}`);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('{path, ignore} entry: a write to the ignored build-trace.jsonl is silent, a write elsewhere under the data root is not (Task 3 fix round 1, Finding 4)', () => {
  // Fixture shaped like REAL_STORE (~/.local/share/clode) after Task 3: traceLog()
  // (libexec/clode-paths.cjs) names build-trace.jsonl AT THE ROOT, not a
  // subdirectory — the durable per-build timing log. Also proves the exclusion is
  // path-anchored rather than a loose name match: a same-named file one level down
  // (sub/build-trace.jsonl) is NOT the ignored path and must still be reported.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hg-trace-'));
  fs.writeFileSync(path.join(dir, 'build-trace.jsonl'), 'one\n');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'build-trace.jsonl'), 'one\n');
  fs.writeFileSync(path.join(dir, 'other.txt'), 'x');
  const watched = { path: dir, ignore: ['build-trace.jsonl'] };
  const before = G.snapshot([watched]);

  // Stands in for Task 5's writer appending a timing line — allowed.
  fs.appendFileSync(path.join(dir, 'build-trace.jsonl'), 'two\n');
  assert.deepStrictEqual(G.diffSnapshots(before, G.snapshot([watched])), [],
    'a write to the ignored top-level build-trace.jsonl must not be reported');

  // A same-named file NOT at the ignored top-level path is still a real violation.
  fs.appendFileSync(path.join(dir, 'sub', 'build-trace.jsonl'), 'two\n');
  let changed = G.diffSnapshots(before, G.snapshot([watched]));
  assert.ok(changed.some((l) => l.includes(path.join('sub', 'build-trace.jsonl'))),
    `expected sub/build-trace.jsonl among violations, got: ${changed.join(', ')}`);

  // Anything else at the watched root is still a real violation too.
  fs.writeFileSync(path.join(dir, 'other.txt'), 'yy');
  changed = G.diffSnapshots(before, G.snapshot([watched]));
  assert.ok(changed.some((l) => l.includes('other.txt')),
    `expected other.txt among violations, got: ${changed.join(', ')}`);

  fs.rmSync(dir, { recursive: true, force: true });
});
