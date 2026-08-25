'use strict';
// The BOUNDED half of bun-shim's skew-probe signal, in a process where no snapshot
// has been intercepted. That is the whole point of the separate file: the signal
// latches process-wide, and test/snapshot-rewrite.test.cjs runs a real snapshot
// through the patched child_process, so the "never intercepted" path cannot be
// observed there. The two files together cover both outcomes.
//
// What the signal is for: extract-claude-js's diagnostics splice awaits
// globalThis.__clodeEnsureSnapshot to START snapshot generation, then awaits
// globalThis.__clodeAwaitSkewProbe (this function) to learn when the resulting
// applet-skew probe has actually RUN. Upstream's shell-provider builder kicks the
// snapshot off and returns without awaiting it — measured on a real quaude built
// from 2.1.245, awaiting only the bridge resolved 7ms in with zero findings. The
// deadline below is what keeps the second await from turning a session that never
// generates a snapshot (skipSnapshot, an unsupported shell) into a stalled /status.
const { test } = require('node:test');
const assert = require('node:assert');

const { awaitSkewProbe } = require('../libexec/bun-shim.cjs');

test('awaitSkewProbe resolves false at its deadline, so a warnings surface cannot hang', async () => {
  const t0 = Date.now();
  const got = await awaitSkewProbe(50);
  const elapsed = Date.now() - t0;
  assert.strictEqual(got, false, 'no snapshot was intercepted: must report that, not pretend');
  assert.ok(elapsed >= 40, `must actually have waited (elapsed ${elapsed}ms)`);
  assert.ok(elapsed < 5000, `must not have waited beyond the deadline (elapsed ${elapsed}ms)`);
});

test('awaitSkewProbe with a zero deadline resolves false without blocking', async () => {
  assert.strictEqual(await awaitSkewProbe(0), false);
});
