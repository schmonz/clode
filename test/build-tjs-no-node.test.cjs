'use strict';
// ACCEPTANCE (spec §11.1): the engine build runs with Node ABSENT.
//
// This is the whole point of converting the orchestration to CJS. Until this
// test existed, "it could run without Node" was an argument; now it is a
// transcript. The shim hosts CommonJS and cannot host an ESM entry at all
// (libexec/node-shim/loader.cjs:481 guards its transpile with !isEntry), which
// is why the orchestration had to stop being ESM first.
//
// CAVEAT this test does NOT prove: build-tjs.cjs has exactly one surviving
// top-level `await` (`const cosmoccBin = await provisionCosmocc()`, guarded by
// `if (cosmoTarget)`). `cosmoTarget` is false on this leg (and every
// non-cosmo leg), so `--source-only` here never executes that async
// continuation under the shim. Only a `CLODE_TJS_TARGET=cosmo` run would
// exercise it, and that pulls a 441MB pinned download — out of scope for this
// gate. This test proves the synchronous orchestration path runs Node-free;
// it says nothing about the cosmo await path.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { tjsDir } = require('../scripts/platform-tag.cjs');

const repo = path.join(__dirname, '..');
const engine = path.join(tjsDir(repo), 'tjs');

test('the engine build runs with Node absent from PATH', (t) => {
  if (!fs.existsSync(engine)) {
    t.skip(`no engine at ${engine} — build one with \`node scripts/build-tjs.cjs\``);
    return;
  }
  // A PATH with no node on it. If node were reachable the run would prove
  // nothing, so assert its absence before asserting anything else.
  const bare = '/usr/bin:/bin:/usr/sbin:/sbin';
  const probe = spawnSync('sh', ['-c', 'command -v node || true'],
    { env: { PATH: bare }, encoding: 'utf8' });
  assert.strictEqual(probe.stdout.trim(), '',
    `node is reachable on the bare PATH (${probe.stdout.trim()}) — this test cannot prove anything`);

  const r = spawnSync(engine,
    ['run', path.join(repo, 'libexec/node-shim/loader.cjs'),
     path.join(repo, 'scripts/build-tjs.cjs'), '--source-only'],
    { cwd: repo, env: { PATH: bare, HOME: process.env.HOME }, encoding: 'utf8' });

  assert.strictEqual(r.status, 0,
    `build-tjs.cjs failed under the shim with no Node:\n${r.stdout}\n${r.stderr}`);
});
