'use strict';
// THE ENGINE BUILD ON A STALE BUILD HOST, re-measured. The companion of
// test/node-shim-build-host.test.cjs (planning, graph-meta), for the three phases that need a
// txiki checkout: the engine phases as CI runs them, through ./build.sh -- the resolver, the
// in-process build-runner, scripts/build-tjs-boot.sh and build-tjs.cjs -- every one of them on
// test/stale-build-host.cjs's stand-in for the last release's engine.
//
// It is the gate for scripts/engine-api-floor.cjs's build-host exemptions: the build must read
// no Stats field the stale engine cannot report (it reports mode and size) and call no strerror.
// ANY refusal fails a row, including one a catch-all swallowed (the tripwire).
//
// PRECONDITIONS, the same as test/build-tjs-no-node.test.cjs's and for its reasons: a POSIX host,
// an engine, and a WARM vendor checkout to COPY (never the shared one itself, and never a clone
// inside a test run). source + regen run by default wherever those exist. The full compile is
// opt-in (CLODE_TJS_BUILD_GATE=1, the same knob as that file's build row): it compiles txiki.js
// for real (~70s warm, minutes cold). regen is the default stand-in for it: it drives the same
// cmake configure/build path to a real host tjsc. CI's suite jobs have no checkout, so these rows
// SKIP there; on the legs, the engine phases run on the REAL bootstrap engine every time.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tjsVendorParentDir } = require('../scripts/platform-tag.cjs');
const { copyCheckout } = require('./engine-build-harness.cjs');
const { OK_TOKEN } = require('../scripts/engine-api-floor.cjs');
const { makeStaleHost, refusals, mkdtemp, REPO } = require('./stale-build-host.cjs');

function prepare(t, tag) {
  const src = path.join(tjsVendorParentDir(), 'txiki.js');
  if (!fs.existsSync(path.join(src, '.git'))) {
    t.skip(`no vendor checkout at ${src} -- run ./build.sh --only engine.source once; this gate copies `
      + 'an existing checkout and will not clone 785MB inside a test run');
    return null;
  }
  const dir = mkdtemp(tag);
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  const host = makeStaleHost(dir);
  if (host.skip) { t.skip(host.skip); return null; }
  copyCheckout(src, path.join(dir, 'vendor', 'txiki.js'));
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('CLODE_')) delete env[k];
  Object.assign(env, host.env, {
    CLODE_TJS: host.engine,
    CLODE_TJS_VENDOR: path.join(dir, 'vendor'),
    CLODE_TJS_BUILD: path.join(dir, 'build'),
    CLODE_TJS_OUT: path.join(dir, 'out'),
    CLODE_CACHE: path.join(dir, 'cache'),
    CLODE_STATE_ROOT: path.join(dir, 'state'),
    CLODE_DEPS: path.join(dir, 'deps-store'),
    CLODE_BUILD_SCRATCH: path.join(dir, 'scratch'),
  });
  const build = (args) => {
    const r = spawnSync('/bin/sh', [path.join(REPO, 'build.sh'), ...args],
      { cwd: REPO, env, encoding: 'utf8', timeout: 3600000, maxBuffer: 1 << 28 });
    const out = `${r.stdout}${r.stderr}`;
    assert.strictEqual(r.status, 0, `./build.sh ${args.join(' ')} failed on the stale build host:\n${out.slice(-6000)}`);
    assert.ok(r.stdout.includes(`build: engine=tjs `) && r.stdout.includes(`path=${host.engine}`),
      `it did not run UNDER the stale engine:\n${r.stdout.slice(0, 2000)}`);
    const got = refusals(host, out);
    assert.ok(!got.any, `./build.sh ${args.join(' ')}: the build host read something the build-host floor says it `
      + `never needs:\n${got.wire}${got.seen.join('\n')}`);
    return out;
  };
  return { dir, build };
}

test('the SOURCE and REGEN phases run on the stale build host, refusing nothing', (t) => {
  const p = prepare(t, 'phases');
  if (!p) return;
  assert.match(p.build(['--only', 'engine.source']), /source tree ready:/);
  assert.match(p.build(['--only', 'engine.bytecode', '--needs', 'assume']), /REGENERATED and ready/);
});

test('the COMPILE phase runs on the stale build host and its engine meets the FULL floor (opt-in)', (t) => {
  if (process.env.CLODE_TJS_BUILD_GATE !== '1') {
    t.skip('opt-in: set CLODE_TJS_BUILD_GATE=1 to compile txiki.js for real on the stale build host '
      + '(~70s warm, minutes cold); the regen row above is the default stand-in');
    return;
  }
  const p = prepare(t, 'compile');
  if (!p) return;
  p.build(['--only', 'engine.bytecode']);
  const out = p.build(['--only', 'engine.compile', '--needs', 'assume']);
  // build-tjs.cjs prints this only after the NEW engine answered the full ('runtime') floor.
  assert.match(out, new RegExp(`^built .*\\(${OK_TOKEN}\\)$`, 'm'));
});
