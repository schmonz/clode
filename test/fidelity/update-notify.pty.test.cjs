'use strict';
// Task 6 characterization: the three auto-update NOTIFY states, pinned against a
// real built quaude under a real PTY.
//
// SURFACING DECISION (pinned here). Auto-update for a built target is CHECK +
// NOTIFY only — never install/rebuild (Tasks 1-5). The obvious surface, the
// bundle's in-TUI NATIVE auto-updater widget, was characterized against the real
// 2.1.218 bundle and CANNOT carry the notice: that widget's JSX renders only
// install OUTCOMES ("Checking for updates" / "Update installed · Restart to
// update" / "Auto-update failed · Run claude doctor") and returns null unless an
// install is in-flight/succeeded/failed. With notify-only (wasUpdated ALWAYS
// false, and __clodeCheckUpdate never throwing) it renders NOTHING for all three
// states, and — gated by the bundle's own enable checks — may not run at all.
//
// So the notice rides clode's OWN surface: the doctor/status "Installation
// warnings" list (extract-claude-js.cjs patchUpdateNotice), the same {issue,fix}
// array clode already contributes applet-skew findings to. That surface renders
// on `/status` (asserted below via PTY) and `claude doctor`, driven by the async
// diagnostics builder DIRECTLY — independent of the autoupdater's enable gates —
// so it is a reliable trigger AND has the running version in scope for the check.
//
// The check is forced deterministically WITHOUT network: target-update-check.cjs
// treats a numeric CLODE_UPDATE_CHANNEL as the latest version itself (no fetch),
// so 9.9.9 => "newer", the running 2.1.218 => "current"; a non-numeric channel
// with an unreachable CLODE_RELEASES_URL => the fetch fails => "unknown".
//
// GATED, in order: CLODE_LIVE_RENDER (darwin only -- this spawns the REAL bundle
// under a PTY and drives it into /status, which probes the macOS Keychain, same
// hermeticity boundary as every other live-render PTY file; see
// live-render-helper.cjs), THEN a built quaude via built-binary.cjs's
// builtQuaude() -- CLODE_QUAUDE wins when set (skip if that path doesn't exist),
// else one is built once for this process.
//
// The CLODE_QUAUDE check this file used to gate on WAS the de-facto live-render
// opt-in (unset by default, so the file always skipped) -- built-binary.cjs
// building one for free on darwin by default would have made this spawn the real
// bundle against the Keychain with nobody having opted in. liveRenderSkipReason()
// restores that boundary explicitly instead of leaning on an accident.
//
// Point CLODE_QUAUDE at a prebuilt one to skip the build, e.g.:
//   node scripts/stage0.mjs build --out /tmp/quaude-notify/quaude
//   CLODE_LIVE_RENDER=1 CLODE_QUAUDE=/tmp/quaude-notify/quaude node --test test/fidelity/update-notify.pty.test.cjs
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { sandbox } = require('../e2e.cjs');
const { seedClaudeProfile, capture } = require('../e2e-pty.cjs');
const { builtQuaude } = require('../built-binary.cjs');
const { liveRenderSkipReason } = require('../live-render-helper.cjs');

// Resolved lazily, on first use inside a test -- not at module scope -- so merely
// REQUIRING this file (e.g. discovery, or another file that imports it) never
// pays for a build; and memoized after that first resolution so the three tests
// below share one build/skip decision rather than three independent ones.
let RESOLVED = null;
function gate() {
  if (RESOLVED) return RESOLVED;
  const liveRenderSkip = liveRenderSkipReason();
  if (liveRenderSkip) { RESOLVED = { skip: liveRenderSkip }; return RESOLVED; }
  const built = builtQuaude();
  RESOLVED = built.skip ? { skip: built.skip } : { path: built.path };
  return RESOLVED;
}

// Type "/status" + Enter a few seconds in, then let the diagnostics builder (which
// awaits the update check) render its warnings list. The child inherits the test
// runner's cwd, so pre-trust THAT dir to clear the per-project trust prompt.
const STATUS_HEX = ['2f737461747573@6', '0d@8']; // "/status", CR

function statusScreen(quaude, env) {
  const sbx = sandbox();
  seedClaudeProfile(sbx.home, { cwd: process.cwd() });
  try {
    return capture(sbx, { seconds: 16, cols: 120, rows: 50, cmd: [quaude], env, thenHex: STATUS_HEX });
  } finally {
    try { fs.rmSync(sbx.dir, { recursive: true, force: true }); } catch { /* */ }
  }
}

// Sanity that the capture actually reached the /status surface (so a "no notice"
// assertion can't pass merely because the screen never rendered).
const REACHED_STATUS = /Version:\s*\d+\.\d+\.\d+/;

test('newer upstream -> a notice naming the version (clode-managed), never "Auto-update failed"', (t) => {
  const g = gate();
  if (g.skip) { t.skip(g.skip); return; }
  const screen = statusScreen(g.path, { CLODE_UPDATE_CHANNEL: '9.9.9' });
  assert.match(screen, REACHED_STATUS, `/status never rendered:\n${screen}`);
  assert.match(screen, /A newer Claude Code \(9\.9\.9\) is available/,
    `expected the newer-version notice on /status:\n${screen}`);
  assert.doesNotMatch(screen, /Auto-update failed/, `notify-only must never say "Auto-update failed":\n${screen}`);
});

test('already current -> no update notice at all', (t) => {
  const g = gate();
  if (g.skip) { t.skip(g.skip); return; }
  const screen = statusScreen(g.path, { CLODE_UPDATE_CHANNEL: '2.1.218' });
  assert.match(screen, REACHED_STATUS, `/status never rendered:\n${screen}`);
  assert.doesNotMatch(screen, /newer Claude Code/i, `current must show no "newer" notice:\n${screen}`);
  assert.doesNotMatch(screen, /couldn.t check for updates/i, `current is not "unknown":\n${screen}`);
  assert.doesNotMatch(screen, /Auto-update failed/, screen);
});

test("cannot check (bad endpoint) -> a subtle \"couldn't check for updates\" note", (t) => {
  const g = gate();
  if (g.skip) { t.skip(g.skip); return; }
  const screen = statusScreen(g.path, { CLODE_UPDATE_CHANNEL: 'stable', CLODE_RELEASES_URL: 'file:///nonexistent-xyz-clode' });
  assert.match(screen, REACHED_STATUS, `/status never rendered:\n${screen}`);
  assert.match(screen, /couldn.t check for updates/i, `expected the "couldn't check" note on /status:\n${screen}`);
  assert.doesNotMatch(screen, /A newer Claude Code/, `unknown must not name a version:\n${screen}`);
  assert.doesNotMatch(screen, /Auto-update failed/, screen);
});
