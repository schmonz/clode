'use strict';
// THE QUESTION THIS FILE ANSWERS: does the LAST RELEASE still bootstrap HEAD?
//
// The whole design of scripts/bootstrap-engine.sh rests on a fact that is true today
// and can stop being true on any push: the engine published in the pinned release can
// host HEAD's libexec/node-shim. Memory has two scars in exactly this shape ("Bundle
// bumps add node API reads", "Shim constants are a class") — upstream or our own shim
// can grow a binding an older engine does not have, with no repo change to notice.
// Without this test, the day that happens is the day a leg discovers it, on a cache
// miss, in CI, in the longest job of the matrix.
//
// It is the ONLINE half on purpose: the answer requires the real published bytes, and
// a fixture cannot be stale in the way the real thing can. test/run.mjs forces
// CLODE_OFFLINE=1, so this needs an explicit opt-in — CLODE_BOOTSTRAP_ONLINE=1, same
// shape as test/ccache.test.cjs's CLODE_CCACHE_ENGINE_E2E.
//
// The offline half — resolution order, sha refusal, the derived fallback set — is in
// test/bootstrap-engine.test.cjs and needs no network at all.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const SH = path.join(REPO, 'scripts', 'bootstrap-engine.sh');
const MANIFEST = path.join(REPO, 'scripts', 'bootstrap-engine.manifest.json');
const { OK_TOKEN } = require('../scripts/engine-api-floor.cjs');
const canon = require('../scripts/canonical-name.cjs');

function why() {
  if (process.env.CLODE_BOOTSTRAP_ONLINE !== '1') {
    return 'opt-in: set CLODE_BOOTSTRAP_ONLINE=1 (fetches ~3MB from the pinned release) — '
      + 'this is the gate that answers "does the last release still bootstrap HEAD?"';
  }
  if (process.env.CLODE_OFFLINE === '1') {
    return 'CLODE_OFFLINE=1 — run the suite with `node test/run.mjs --online`, or this file '
      + 'directly, to let it reach the network it exists to reach';
  }
  const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const target = `${canon.canonOs(process.platform === 'win32' ? 'windows' : process.platform)}-${canon.canonArch(process.arch)}`;
  if (!m.targets[target]) {
    return `this host's target (${target}) is not in the pinned pack ${m.bootstrapTag} — `
      + 'that is the documented base case, not a failure; the offline suite covers it';
  }
  return null;
}

const mkdtemp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'clode-bootstrap-online-'));

// Resolve for real: fetch, gunzip, sha-verify, floor-probe, print the path.
function resolve() {
  const cache = mkdtemp();
  const env = { ...process.env, CLODE_CACHE: cache };
  delete env.CLODE_TJS;       // the point is the PUBLISHED engine, not this box's
  delete env.CLODE_TJS_OUT;
  const r = spawnSync('/bin/sh', [SH], { env, encoding: 'utf8' });
  assert.strictEqual(r.status, 0,
    `bootstrap-engine.sh refused (${r.status}):\n${r.stderr}\n`
    + 'If this is the floor probe, the pinned release can no longer host HEAD\'s shim — '
    + 'that is the finding, not a flake. Cut a release, or re-pin the bootstrap tag.');
  const tjs = r.stdout.trim();
  assert.ok(fs.existsSync(tjs), `resolver printed a path that does not exist: ${tjs}`);
  return tjs;
}

const runTjs = (tjs, args) => spawnSync(tjs, ['run', ...args], { cwd: REPO, encoding: 'utf8' });

test('the last release still bootstraps HEAD: the pinned slice fetches and passes the floor', (t) => {
  const skip = why();
  if (skip) return t.skip(skip);
  const tjs = resolve();
  // The resolver already ran the floor probe (it would have refused otherwise). Assert it
  // again HERE, visibly, so a reader of this file sees the acceptance rather than trusting
  // an exit code — and so the token comes from engine-api-floor.cjs both times.
  const gen = runTjs(tjs, [path.join(REPO, 'libexec', 'node-shim', 'loader.cjs'),
    path.join(REPO, 'scripts', 'engine-api-floor.cjs'), '--emit-check']);
  assert.strictEqual(gen.status, 0, `could not generate the floor check under the fetched engine:\n${gen.stderr}`);
  const check = path.join(mkdtemp(), 'floor.js');
  fs.writeFileSync(check, gen.stdout);
  const ran = runTjs(tjs, [check]);
  assert.strictEqual(ran.stdout.trim(), OK_TOKEN,
    `the pinned release's engine does not carry HEAD's engine API floor:\n${ran.stdout}${ran.stderr}`);
  assert.strictEqual(ran.status, 0);
});

test("HEAD's build-tjs.cjs loads, top to bottom, under the fetched engine", (t) => {
  const skip = why();
  if (skip) return t.skip(skip);
  const tjs = resolve();
  // READ-ONLY BY CONSTRUCTION: --source-only and --build-only together are refused at
  // build-tjs.cjs:118, AFTER every require has been resolved and every module body has
  // run. So this loads node:child_process, node:os, node:fs, node:path, node:crypto and
  // all ten sibling requires under HEAD's loader, mutates nothing, and takes ~200ms.
  // It is the difference between "the engine boots" and "the engine can run the program
  // we are about to stop running under node".
  const r = runTjs(tjs, [path.join(REPO, 'libexec', 'node-shim', 'loader.cjs'),
    path.join(REPO, 'scripts', 'build-tjs.cjs'), '--source-only', '--build-only']);
  assert.match(`${r.stdout}${r.stderr}`, /pick one of --source-only \/ --build-only \/ --regen-only/,
    'the probe must reach build-tjs.cjs\'s own argv guard. Anything else means a require '
    + `failed under the pinned engine's shim — which is exactly the day this test exists `
    + `for:\n${r.stdout}${r.stderr}`);
  assert.strictEqual(r.status, 1, 'the argv guard throws, so the probe exits 1');
});

test('the committed pin still describes the published pack it names', async (t) => {
  const skip = why();
  if (skip) return t.skip(skip);
  const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const url = `https://github.com/schmonz/clode/releases/download/${m.bootstrapTag}/${m.blob}.json`;
  const res = await fetch(url);
  assert.ok(res.ok, `GET ${url}: HTTP ${res.status} — the pinned release no longer serves its `
    + 'manifest. A deleted or re-published release breaks every bootstrap; re-pin.');
  const published = await res.json();
  // Every field the resolver USES must still agree. `bootstrapTag` is ours (the published
  // manifest does not record which tag carries it), so it is excluded, not forgotten.
  assert.deepStrictEqual(published.targets, m.targets,
    'the committed pin and the published manifest disagree about the pack. The bytes the '
    + 'resolver range-fetches are chosen by the COMMITTED offsets — if the release was '
    + 're-published, those offsets now name different bytes and the sha check is the only '
    + 'thing standing between us and a wrong engine.');
  assert.strictEqual(published.blob, m.blob);
  assert.strictEqual(published.schema, m.schema);
});
