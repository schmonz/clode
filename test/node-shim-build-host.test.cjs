'use strict';
// THE BUILD-HOST FLOOR, RE-MEASURED ON EVERY RUN. scripts/engine-api-floor.cjs lets the engine
// that HOSTS the build (scripts/bootstrap-engine.sh's: the last release's) lack two bindings the
// shipped engine must have, on the strength of a measurement: the build reads no Stats field but
// `mode`, and never calls strerror. A measurement taken once is a claim. These rows re-take it,
// on a stale stand-in (test/stale-build-host.cjs), for everything that runs on that engine
// without a warm txiki checkout:
//   * ./build.sh --plan            the resolver's acceptance + build-runner/build-graph planning,
//                                  in-process under the bootstrap engine (build.sh's `exec`)
//   * libexec/graph-meta.js        what upstream-drift.yml's carve-probe and regexp census run
//                                  on the bootstrap engine (CLODE_TJS = bootstrap-engine.sh)
// The three engine phases need that checkout and live in test/build-host-stale-engine.test.cjs.
//
// NOT measured here, because it does not run on the bootstrap engine: the root step's blobulate
// (stage0 runs under node, and the template is the BUILT engine, held to the full floor by clode
// build's front door). Measured once, 2026-11-18: the whole ./build.sh root graph, resolved to
// the stand-in, ran green with nothing refused.
//
// FAILING MEANS ANY REFUSAL, CAUGHT OR NOT. `try { m = statSync(p).mtimeMs } catch {}` would take
// the wrong branch in silence; node-shim's CLODE_ENGINE_FLOOR_LOG (the knob build-leg gates the real legs on) records every
// refusal from every process in the tree, and the control row proves it sees a caught one.
//
// Named node-shim-* on purpose: ci.yml's node-shim-oracle jobs glob test/node-shim-*.test.cjs and
// export CLODE_TJS, so these rows run in CI on a real engine with no opt-in. They must not SKIP
// there (those jobs pin their skip count), and they need nothing those jobs lack.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { defineGuard, guardTests } = require('./guard.cjs');
const { makeStaleHost, refusals, mkdtemp, REPO } = require('./stale-build-host.cjs');

function hermeticEnv(dir, host, extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('CLODE_')) delete env[k];
  return {
    ...env,
    CLODE_TJS: host.engine,
    CLODE_CACHE: path.join(dir, 'cache'),
    CLODE_STATE_ROOT: path.join(dir, 'state'),
    CLODE_DEPS: path.join(dir, 'deps-store'),
    CLODE_TJS_VENDOR: path.join(dir, 'vendor'),
    CLODE_BUILD_SCRATCH: path.join(dir, 'scratch'),
    ...host.env,
    ...extra,
  };
}

function setup(t, tag) {
  const dir = mkdtemp(tag);
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  const host = makeStaleHost(dir);
  if (host.skip) { t.skip(host.skip); return null; }
  return { dir, host };
}

test('control: the floor log catches a refusal the program CAUGHT', (t) => {
  const s = setup(t, 'control');
  if (!s) return;
  const prog = path.join(s.dir, 'swallow.cjs');
  fs.writeFileSync(prog, `const fs = require('fs');
let m = 'unset';
try { m = fs.statSync('.').mtimeMs; } catch { /* the wrong branch, taken quietly */ }
console.log('mode', fs.statSync('.').mode, 'mtime', m);
// rg-native's strerror fallback, which throws nothing: the floor log must still hear it.
const rg = require(process.argv[2]);
console.log('strerror', typeof globalThis.__tjs_fs_sync.strerror, rg.osErrorText(Object.assign(new Error('x'), { code: 'ENOENT', errno: -2 })));
`);
  const r = spawnSync(s.host.engine, ['run', path.join(REPO, 'libexec/node-shim/loader.cjs'), prog, path.join(REPO, 'libexec', 'rg-native.cjs')],
    { env: hermeticEnv(s.dir, s.host), encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stdout, /^mode \d+ mtime unset$/m, 'the program swallowed the refusal and carried on, as a catch-all would');
  const got = refusals(s.host, '');
  assert.match(got.wire, /node-shim: this engine's sync stat carries no mtimeMs/,
    'the floor log must record a refusal even when the caller swallowed it -- or every row below is blind');
  // The loader evaluates modules as `<input>`, so the stack names the frames, not the file.
  assert.match(got.wire, /at floorError[^\n]*\n\s+at get /, 'and with the stack of the read that was refused');
  assert.match(r.stdout, /^strerror undefined No such file or directory/m, 'the stand-in has no strerror and rg falls back');
  assert.match(got.wire, /rg-native: this engine has no __tjs_fs_sync\.strerror/, 'and the fallback, which has no refusal to catch, is logged');
});

test('./build.sh --plan runs on the stale build host: resolver acceptance + graph planning, nothing refused', (t) => {
  const s = setup(t, 'plan');
  if (!s) return;
  const env = hermeticEnv(s.dir, s.host);
  let out = '';
  for (const args of [['--plan'], ['--plan', '--only', 'engine.compile'], ['--plan', '--runs-on', 'host']]) {
    const r = spawnSync('/bin/sh', [path.join(REPO, 'build.sh'), ...args], { cwd: REPO, env, encoding: 'utf8' });
    out += `${r.stdout}${r.stderr}`;
    assert.strictEqual(r.status, 0, `./build.sh ${args.join(' ')} failed on the stale build host:\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /^build: engine=tjs /m, 'it must have run UNDER the stale engine, not fallen back');
    assert.ok(r.stdout.includes(`path=${s.host.engine}`), `the resolver chose some other engine:\n${r.stdout}`);
  }
  const got = refusals(s.host, out);
  assert.ok(!got.any, `the build host read something the build-host floor says it never needs:\n${got.wire}${got.seen.join('\n')}`);
});

test('libexec/graph-meta.js (upstream-drift\'s carve-probe and regexp census) runs on the stale build host', (t) => {
  const s = setup(t, 'graph-meta');
  if (!s) return;
  const doc = path.join(s.dir, 'graph.json');
  const names = path.join(s.dir, 'names.json');
  const outp = path.join(s.dir, 'meta.json');
  fs.writeFileSync(doc, JSON.stringify({ order: ['a.js', 'b.js'],
    sources: { 'a.js': 'export const a = 1; let hidden = 2; export function f() { return hidden; }', 'b.js': 'import { a } from "a.js"; export const b = a + 1;' } }));
  fs.writeFileSync(names, JSON.stringify(['a.js', 'b.js']));
  const r = spawnSync(s.host.engine, ['run', path.join(REPO, 'libexec', 'graph-meta.js'), doc, names, outp],
    { env: hermeticEnv(s.dir, s.host), encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
  const meta = JSON.parse(fs.readFileSync(outp, 'utf8'));
  assert.deepStrictEqual(Object.keys(meta).sort(), ['a.js', 'b.js']);
  const got = refusals(s.host, `${r.stdout}${r.stderr}`);
  assert.ok(!got.any, `${got.wire}${got.seen.join('\n')}`);
});

// What the run above cannot see for an input it never fed: graph-meta.js reaching for something the
// build-host floor exempts on a path these two modules do not exercise. It is a bare tjs program (no
// node-shim, so no Stats at all) and never names strerror; this guard keeps that true of its SOURCE.
// read(): the one file. scan(): pure.
const GRAPH_META_REACH = /__tjs_fs_sync|strerror|\brequire\(/g;
function scanGraphMetaReach({ files }) {
  const findings = [];
  for (const { rel, src } of files) {
    for (const m of src.matchAll(GRAPH_META_REACH)) findings.push(`${rel}: names ${m[0]} -- it now reaches the sync fs binding or node-shim; re-measure it against the build-host floor (scripts/engine-api-floor.cjs)`);
  }
  return { findings, examined: files.length };
}
const graphMetaGuard = defineGuard({
  name: 'graph-meta-build-host-reach',
  floor: 1,
  read: () => ({ files: [{ rel: 'libexec/graph-meta.js', src: fs.readFileSync(path.join(REPO, 'libexec', 'graph-meta.js'), 'utf8') }] }),
  scan: scanGraphMetaReach,
  // The realistic regression: graph-meta grows a node-shim require to read a file's mtime.
  control: () => ({ files: [{ rel: 'synthetic/graph-meta.js', src: "const fs = require('fs'); fs.statSync(p).mtimeMs;\n" }] }),
});
guardTests(graphMetaGuard);
