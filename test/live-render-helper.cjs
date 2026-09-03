'use strict';
// The single source of the CLODE_LIVE_RENDER gate's PLATFORM condition.
//
// The historic gate bundled two justifications of different scope under one
// blanket opt-in: "touches the Keychain, may touch the network". Those are not
// the same claim:
//   - Keychain: macOS-only. Linux has no `security` binary on PATH at all --
//     this project deleted its Keychain emulation on 2026-09-02 precisely
//     because the on-disk-credentials fallback IS the real path there, so
//     there is no GUI modal to hang on off darwin.
//   - network: universal, and the genuinely remaining reason -- but most of
//     these tests drive an in-process mock Anthropic server
//     (test/mock-anthropic-helper.cjs) and touch no network at all.
//
// So the platform condition below is Keychain-shaped (darwin only), never
// network-shaped. A test that ALSO touches the real network on its own merits
// (real credentials, real tokens) keeps ITS OWN separate opt-in
// (CLODE_LIVE_ONLINE -- see test/fidelity/interactive-live-turn.test.cjs);
// this helper says nothing about that axis and must not be used as a
// substitute for it.
//
// Measured, not assumed: a Linux container (ultimate-hat's remote Docker
// daemon) ran the real gated files under CLODE_LIVE_RENDER=1 against a real
// fused quaude -- they rendered and passed, no Keychain involved (no
// `security` binary on PATH at all in the container), nothing hung. See
// .superpowers/sdd/2026-09-02-phase2-name-the-steps/linux-pty-experiment.md.
//
// Every other platform (Linux, the BSDs, Haiku, Windows) gets the same
// default-run treatment as Linux: the Keychain modal is a darwin GUI concern,
// full stop, not a POSIX-vs-Windows one. Windows CI already runs one of these
// files un-gated (.github/workflows/ci.yml's windows-amd64-tui, which forces
// CLODE_LIVE_RENDER=1) for exactly this reason; that continues to work
// unchanged since forcing the var to '1' is a no-op once the platform default
// is already "run".
//
// `platform` is a parameter (default process.platform) so a caller -- see
// this file's own sibling test -- can prove BOTH directions of the gate
// (darwin skips, non-darwin runs) without needing an actual non-darwin box.
function liveRenderSkipReason(platform = process.platform) {
  if (platform !== 'darwin') return null; // no Keychain off darwin: runs by default
  if (process.env.CLODE_LIVE_RENDER === '1') return null; // explicit opt-in still works
  return 'live-render opt-in only on darwin (set CLODE_LIVE_RENDER=1; spawns the real bundle, touches the macOS Keychain)';
}

module.exports = { liveRenderSkipReason };
