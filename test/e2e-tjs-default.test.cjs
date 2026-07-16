'use strict';
// The tjs default, end to end (doubt-driven review MAJOR-1). Every OTHER e2e
// pins the sandbox to CLODE_ENGINE=node (the oracle) because CI's `test` job has
// no tjs — which left the ACTUAL shipping default (tjs) un-exercised end to end
// except by e2e-tui-tjs, itself triple-gated behind CLODE_LIVE_RENDER + a real
// provider. This boots a FAKE fixture bundle through the real launcher under the
// DEFAULT engine (CLODE_ENGINE unset -> tjs) and asserts it reaches the bundle,
// so a regression in the tjs launch argv/env assembly can't sail through offline.
// Skips only when no tjs binary is genuinely available (never behind live-render).
const { test } = require('node:test');
const path = require('node:path');
const { sandbox, runClode, mkProvider } = require('./e2e.cjs');
const { tjsPath } = require('./node-shim-helper.cjs');
const assert = require('node:assert');

test('default engine (unset -> tjs) boots the bundle end to end', (t) => {
  const tjs = tjsPath();
  if (!tjs) { t.skip('no tjs binary (CLODE_TJS or build/tjs/tjs); run scripts/build-tjs.mjs'); return; }
  const sbx = sandbox(t);
  // The whole point: DON'T pin the engine — let the default (tjs) resolve.
  delete sbx.env.CLODE_ENGINE;
  const claude = path.join(sbx.dir, 'claude');
  mkProvider(claude, 'tjsdefault');
  const r = runClode(sbx, ['-p', 'hi'], { env: { CLODE_CLAUDE_BIN: claude, CLODE_TJS: tjs } });
  assert.strictEqual(r.status, 0, `stderr:\n${r.stderr}`);
  assert.match(r.output, /CLODE-FIXTURE tjsdefault/);
  // Must have actually gone through the tjs path, not silently fallen back to node.
  assert.doesNotMatch(r.output, /failed to launch tjs|not yet implemented|Cannot find module/i);
});
