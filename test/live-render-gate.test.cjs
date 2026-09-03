'use strict';
// The gate's OWN test. test/live-render-helper.cjs decides whether ~16 PTY tests
// run, so if it is wrong they go dark (or, worse on darwin, they run and hang on a
// Keychain modal) and nothing else in the suite would say so.
//
// This is the whole reason liveRenderSkipReason() takes `platform` as a parameter
// instead of reading process.platform directly: both directions are provable from
// any host. A gate that can only be exercised on the platform it gates is a gate
// nobody checks.
const { test } = require('node:test');
const assert = require('node:assert');
const { liveRenderSkipReason } = require('./live-render-helper.cjs');

// Each case runs with CLODE_LIVE_RENDER controlled explicitly, so the result never
// depends on what the operator happens to have exported.
function withOptIn(value, fn) {
  const saved = process.env.CLODE_LIVE_RENDER;
  if (value === undefined) delete process.env.CLODE_LIVE_RENDER;
  else process.env.CLODE_LIVE_RENDER = value;
  try { return fn(); } finally {
    if (saved === undefined) delete process.env.CLODE_LIVE_RENDER;
    else process.env.CLODE_LIVE_RENDER = saved;
  }
}

test('darwin without the opt-in SKIPS, and the reason names the platform condition', () => {
  const why = withOptIn(undefined, () => liveRenderSkipReason('darwin'));
  assert.ok(why, 'darwin must still gate: the Keychain modal is real and is an open bug');
  assert.match(why, /darwin/, 'the reason must name the platform, not just the env var');
  assert.match(why, /CLODE_LIVE_RENDER=1/, 'the reason must say how to opt in');
  assert.match(why, /Keychain/, 'the reason must name WHY, so the next reader can tell whether it still applies');
});

test('darwin WITH the opt-in runs — the escape hatch still works', () => {
  assert.strictEqual(withOptIn('1', () => liveRenderSkipReason('darwin')), null);
});

// The finding this gate exists to encode: the old blanket gate suppressed these
// everywhere for a reason that only holds on darwin. Linux has no `security` binary
// at all -- proven by running the real gated files against a real fused quaude in a
// Linux container, where they rendered and passed (see
// .superpowers/sdd/2026-09-02-phase2-name-the-steps/linux-pty-experiment.md).
for (const platform of ['linux', 'freebsd', 'netbsd', 'openbsd', 'haiku', 'win32']) {
  test(`${platform} runs by default — the Keychain is a darwin concern, not a POSIX one`, () => {
    assert.strictEqual(withOptIn(undefined, () => liveRenderSkipReason(platform)), null,
      `${platform} has no macOS Keychain, so it must not inherit darwin's opt-in`);
  });
}

test('a forced CLODE_LIVE_RENDER=1 is a no-op off darwin, so Windows CI keeps working', () => {
  // .github/workflows/ci.yml's windows-amd64-tui sets CLODE_LIVE_RENDER=1 explicitly.
  // That must remain harmless now that win32 already defaults to running.
  assert.strictEqual(withOptIn('1', () => liveRenderSkipReason('win32')), null);
});

test('the gate reads the env var live, not once at require time', () => {
  // A cached read would make the escape hatch depend on import order -- the kind of
  // thing that works in isolation and fails in a full suite run.
  assert.ok(withOptIn(undefined, () => liveRenderSkipReason('darwin')));
  assert.strictEqual(withOptIn('1', () => liveRenderSkipReason('darwin')), null);
  assert.ok(withOptIn(undefined, () => liveRenderSkipReason('darwin')));
});

test('only the exact string "1" opts in — no truthiness surprises', () => {
  for (const v of ['0', 'true', 'yes', '']) {
    assert.ok(withOptIn(v, () => liveRenderSkipReason('darwin')),
      `CLODE_LIVE_RENDER=${JSON.stringify(v)} must NOT be treated as opting in`);
  }
});
