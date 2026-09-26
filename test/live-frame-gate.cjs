'use strict';
// The ONE statement of when a live pty frame gate can run, and of the native claude it
// judges against. Before this, each frame gate carried its own copy of the harness check,
// the skip chain and the "no native claude" message (interactive-frame-diff, then
// session-determinism, then a variant in tui-screen-script), and every phase-5 session
// gate would have added another.
//
//   ptyHarnessSkipReason()           the PTY harness (node-pty + @xterm/headless) is not
//                                    installed where tui-screen.cjs's loadHarness() looks
//   fullSuiteSkipReason(env)         this file is running inside the concurrent full
//                                    suite (test/run.mjs), where a SESSION gate does not
//   liveFrameGate({ session, env })  -> { skip } | { native }: the whole chain, in order
//   quaudeBesideNative(native)       -> { skip } | { quaude, version }: the built quaude a
//                                    gate judges, only when it is the native's version
//   quaudeVersion(bin)               a built quaude's --version line (apeCmd-aware)
//
// WHERE THE SESSION GATES RUN, AND WHY THE FULL SUITE IS NOT IT (ruling R5, CellSegmenter
// phase 5). A session gate launches native Claude Code, and later a built quaude too, a
// few times per session, and captures a frame per scripted step once output settles:
// about a minute per session per pair, with timing budgets measured with the capture in
// the foreground. They are placed in a SERIAL pty run: CI's linux-x64-pty job (files by
// name, --test-concurrency=1) and, locally, `node --test` of the file (on darwin with
// CLODE_LIVE_RENDER=1). The generic suite legs (suite.yml's ubuntu-latest and
// windows-latest `npm test`) run test/run.mjs, which runs every file concurrently. Off
// darwin nothing else in the chain stops a session gate there: liveRenderSkipReason() is
// null, run.mjs installs the harness, suite.yml exports CLODE_PROVIDER_BIN and puts the
// pinned `claude` on PATH. So run.mjs DECLARES itself (CLODE_TEST_FULL_SUITE=1, set for
// every file it runs) and a session gate skips there, naming how to run it. This is the
// narrowest honest signal: it is true exactly when the runner is the concurrent full
// suite, whatever the platform, and it says nothing about the artifacts a gate needs (the
// signal the single-frame gate happens to skip on in those legs, "no tjs engine", is a
// fact about quaude, not about where a native-only check belongs).
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { liveRenderSkipReason } = require('./live-render-helper.cjs');
const { skipReason: providerSkipReason } = require('./provider-resolve.cjs');
const { resolveNativeClaude, nativeVersion } = require('../scripts/lib/native-oracle.cjs');

const REPO = path.resolve(__dirname, '..');
const FULL_SUITE_ENV = 'CLODE_TEST_FULL_SUITE';

// The same two places tui-screen.cjs's loadHarness() looks, in the same order: the
// per-platform harness dir, then ordinary resolution.
function ptyHarnessSkipReason() {
  try {
    const { harnessDir } = require(path.join(REPO, 'scripts', 'platform-tag.cjs'));
    require.resolve(path.join(harnessDir(REPO), 'node_modules', 'node-pty'));
    return null;
  } catch { /* fall through to bare resolution */ }
  try { require.resolve('node-pty'); return null; } catch { /* */ }
  return 'PTY harness (node-pty/@xterm/headless) is not installed for this platform tag';
}

function fullSuiteSkipReason(env = process.env) {
  if (env[FULL_SUITE_ENV] !== '1') return null;
  return 'a live session gate does not run inside the concurrent full suite (test/run.mjs); '
    + 'it runs on its own, serially: CI\'s linux-x64-pty job, or locally `node --test '
    + '<this file>` (on darwin with CLODE_LIVE_RENDER=1)';
}

// The chain every live frame gate skips on, in order: live render (darwin opt-in), the
// full suite (session gates only), the PTY harness, a build provider, then the native
// reference (CLODE_NATIVE_CLAUDE, else `claude` on PATH).
function liveFrameGate({ session = false, env = process.env, platform = process.platform } = {}) {
  const skip = liveRenderSkipReason(platform) || (session && fullSuiteSkipReason(env))
    || ptyHarnessSkipReason() || providerSkipReason(env) || null;
  if (skip) return { skip };
  const native = resolveNativeClaude(env);
  if (!native) return { skip: 'no native claude (set CLODE_NATIVE_CLAUDE, or put `claude` on PATH)' };
  return { native };
}

// THE QUAUDE a live frame gate judges beside its native: builtQuaude() (CLODE_QUAUDE, else a
// build of this tree), and only when it reports the native's --version -- frames of two
// versions are not comparable, so the gate skips naming both. quaudeVersion() is the
// QUAUDE's and apeCmd-aware (a cosmo/APE quaude cannot be exec'd directly); nativeVersion()
// is a plain spawnSync for the native side only (controller ruling R2, phase-3 task 1).
// Required lazily: test/run.mjs loads this file for FULL_SUITE_ENV alone.
function quaudeVersion(bin) {
  const { apeCmd } = require('./e2e-pty.cjs');
  const w = apeCmd([bin, '--version']);
  const env = { ...process.env, DISABLE_AUTOUPDATER: '1' }; delete env.NODE_PATH;
  const r = spawnSync(w[0], w.slice(1), { encoding: 'utf8', env, timeout: 60000 });
  return ((r.stdout || '') + (r.stderr || '')).split('\n')[0].trim();
}

function quaudeBesideNative(native) {
  const built = require('./built-binary.cjs').builtQuaude();
  if (built.skip) return { skip: built.skip };
  const rv = nativeVersion(native), qv = quaudeVersion(built.path);
  if (!rv || rv !== qv) {
    return { skip: 'native and quaude are not the same version, so their frames are not comparable: '
      + `${native} says ${JSON.stringify(rv)}, ${built.path} says ${JSON.stringify(qv)}` };
  }
  return { quaude: built.path, version: rv };
}

module.exports = { liveFrameGate, quaudeBesideNative, quaudeVersion, ptyHarnessSkipReason, fullSuiteSkipReason, FULL_SUITE_ENV };
