'use strict';
// Bun.ant.isVmContextGlobal answers as native Bun does. 2.1.330's sandbox builder refuses to make a vm context unless
// the runtime recognizes the context's global ("Refusing to make a node:vm context: this Bun cannot recognize a
// context's global"), so without it every Workflow failed under naude and quaude alike
// (test/fidelity/agentic-workflow-complete.test.cjs). NATIVE is the expected answer: measured on 2.1.330 (Bun 1.4.4)
// by running test/fixtures/vm-context-global-probe.cjs inside native Claude Code
// (`BUN_OPTIONS="--preload <probe>" claude --version`), and re-measured live below whenever the provider is a native
// binary for this host. The same probe then runs under node and under quaude's engine with bun-shim loaded.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

const PROBE = path.join(__dirname, 'fixtures', 'vm-context-global-probe.cjs');
const SHIM = path.join(__dirname, '..', 'libexec', 'bun-shim.cjs');
const NATIVE_2_1_330 = {
  has: 'function', 'inner global of createContext': true, 'the contextified sandbox': false, 'plain object': false,
  'this realm global': false, 'runInNewContext global': true, 'runInNewContext no sandbox': true,
  'Script.runInNewContext global': true, 'createContext() no arg, inner': true, 'object inside a context': false,
  null: false, undefined: false, number: false, 'isContext(inner)': false,
};
const parse = (out) => JSON.parse(String(out).split('\n').find((l) => l.startsWith('CTXGLOBAL ')).slice('CTXGLOBAL '.length));

test('under node, bun-shim answers isVmContextGlobal as native does', () => {
  assert.deepStrictEqual(parse(execFileSync(process.execPath, [PROBE, SHIM], { encoding: 'utf8' })), NATIVE_2_1_330);
});

test('under quaude\'s engine, bun-shim answers isVmContextGlobal as native does', (t) => {
  if (skipUnlessTjs(t)) return;
  const r = runLoader(PROBE, [SHIM]);
  assert.strictEqual(r.status, 0, String(r.stderr));
  assert.deepStrictEqual(parse(r.stdout), NATIVE_2_1_330);
});

test('native still answers as recorded (live, when the provider is a native binary for this host)', (t) => {
  const bin = process.env.CLODE_PROVIDER_BIN;
  if (!bin) { t.skip('no CLODE_PROVIDER_BIN'); return; }
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 60000,
    env: { ...process.env, BUN_OPTIONS: `--preload ${PROBE}`, DISABLE_AUTOUPDATER: '1' } });
  if (r.error || !/CTXGLOBAL /.test(String(r.stdout))) { t.skip(`the provider does not run here as native: ${r.error ? r.error.message : 'no probe output'}`); return; }
  assert.deepStrictEqual(parse(r.stdout), NATIVE_2_1_330);
});
