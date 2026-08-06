'use strict';
// fs.statfs — found 2026-08-06 by a real-API hunt with CLODE_SHIM_PROBE, not by
// anything failing. The bundle CALLS it (it does not feature-detect it) on its
// low-disk diagnostic path:
//     let r = await statfs(dir, {bigint:true}),
//         n = r.bavail * r.bsize / (1024n * 1024n)
// then decides whether to tell the user to free space or set CLAUDE_CODE_TMPDIR.
//
// Unimplemented, `statfs` was undefined, so that call threw a bare "not a
// function" — quickjs TypeErrors carry no symbol name — INSIDE the path's own
// try/catch. Swallowed: the run still exited 0 and the user simply never got the
// diagnostic. That is the failure shape this whole probe mechanism exists to
// catch, and nothing in the suite would ever have gone red for it.
//
// Everything here is HERMETIC and offline: statfs reads a filesystem the test
// already has. Each row is a differential against host node on the SAME path.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

function prog(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-statfs-'));
  const f = path.join(dir, 'p.cjs');
  fs.writeFileSync(f, body);
  return f;
}

// Compare the SHAPE (key set, value types, invariants) rather than the numbers:
// free-space counts drift between the two runs on a live filesystem.
const SHAPE = `
  const fsp = require('fs/promises');
  (async () => {
    const r = await fsp.statfs(require('os').tmpdir());
    console.log(JSON.stringify({
      keys: Object.keys(r).sort(),
      types: Object.keys(r).sort().map((k) => typeof r[k]),
      bsizePositive: r.bsize > 0,
      blocksGeAvail: r.blocks >= r.bavail,
    }));
  })();
`;

test('fs/promises.statfs: key set and value types match node', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = prog(SHAPE);
  const node = JSON.parse(execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), node);
  // Anchor the oracle: node's statfs really does carry all eight fields.
  assert.deepStrictEqual(node.keys,
    ['bavail', 'bfree', 'blocks', 'bsize', 'ffree', 'files', 'frsize', 'type']);
});

// The bigint path is the one the bundle actually takes, and it is not optional
// sugar: the caller multiplies and divides by BigInt literals, and mixing BigInt
// with Number throws TypeError. A Number-returning statfs would "exist" and
// still break the feature.
const BIGINT = `
  const fsp = require('fs/promises');
  (async () => {
    const r = await fsp.statfs(require('os').tmpdir(), { bigint: true });
    const allBig = Object.keys(r).every((k) => typeof r[k] === 'bigint');
    // The bundle's exact expression shape — this is what must not throw.
    const mib = r.bavail * r.bsize / (1024n * 1024n);
    console.log(JSON.stringify({ allBig, mibIsBigInt: typeof mib === 'bigint', mibPositive: mib > 0n }));
  })();
`;

test('fs/promises.statfs({bigint:true}): every field is a BigInt and the bundle\'s arithmetic works', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = prog(BIGINT);
  const node = JSON.parse(execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), node);
  assert.deepStrictEqual(node, { allBig: true, mibIsBigInt: true, mibPositive: true });
});

const CALLBACK = `
  require('fs').statfs(require('os').tmpdir(), (err, r) => {
    console.log(JSON.stringify({ err: err ? String(err.message) : null, hasBsize: !!(r && r.bsize > 0) }));
  });
`;

test('fs.statfs (callback form) matches node', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = prog(CALLBACK);
  const node = JSON.parse(execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), node);
  assert.deepStrictEqual(node, { err: null, hasBsize: true });
});

// Guard the DOCUMENTED gap, so it stays a deliberate decision rather than
// quietly becoming a fake. If a probe ever shows statfsSync reached, implement
// it in the engine (libuv's uv_fs_statfs supports sync) — do not stub it, since
// a wrong free-space answer is worse than a missing one.
test('fs.statfsSync stays absent on purpose (engine exposes statFs async-only)', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = prog(`console.log(JSON.stringify({ sync: typeof require('fs').statfsSync }));`);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), { sync: 'undefined' });
  // node HAS it — this row records a known, intentional divergence.
  assert.strictEqual(typeof require('node:fs').statfsSync, 'function');
});
