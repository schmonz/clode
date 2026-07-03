const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sandbox, REPO, NODE } = require('./e2e.cjs');
const { capture, seedClaudeProfile, makeWsWorlds, worldNode } = require('./e2e-pty.cjs');

const BIN = path.join(REPO, 'bin', 'clode');
const DOCTOR_PARITY = path.join(REPO, 'test', 'doctor-parity.cjs');

// Hex the bats sent: type "/doctor" then Enter, at 4s and 6s.
const THEN_HEX = ['2f646f63746f72@4', '0d@6'];   // "/doctor", CR

function nativeClaude() {
  const r = spawnSync('command', ['-v', 'claude'], { shell: true, encoding: 'utf8' });
  const p = (r.stdout || '').trim();
  return p && fs.existsSync(p) ? p : null;
}
function version(cmd, env) {
  const r = spawnSync(cmd[0], cmd.slice(1).concat('--version'), { encoding: 'utf8', env });
  return ((r.stdout || '') + (r.stderr || '')).split('\n')[0].trim();
}

let SKIP = null, NATIVE = '', CLODE = '', SBX = null;

before(async () => {
  // OPT-IN ONLY. This spawns the REAL Claude Code bundle, which probes the macOS login
  // Keychain (auth/Remote-Control status) and pops system dialogs, and may touch the
  // network. Keep it OUT of the default offline `npm test`; a dev opts in explicitly.
  if (process.env.CLODE_LIVE_RENDER !== '1') {
    SKIP = 'live-render opt-in only (set CLODE_LIVE_RENDER=1; spawns the real bundle, touches Keychain)';
    return;
  }
  const native = nativeClaude();
  if (!native) { SKIP = 'native claude not on PATH (environmental)'; return; }
  const nver = version([native], { ...process.env, DISABLE_AUTOUPDATER: '1' });
  if (!nver) { SKIP = 'native claude did not run here'; return; }
  SBX = sandbox();
  // clode must run the SAME provider bundle as native (the constructed-clean PATH has no
  // provider); otherwise version-match and the comparison are meaningless.
  SBX.env.CLODE_CLAUDE_BIN = native;
  // Past-onboarding + trusted profile keyed by the capture cwd (REPO), so the fixed-
  // duration no-keystroke capture reaches the interactive prompt where /doctor works.
  seedClaudeProfile(SBX.home, { cwd: REPO });
  // clode's bundle constructs a WebSocket at TUI startup; under the bun-shim that needs a
  // resolvable `ws` or it fails loud instead of rendering /doctor. Give it a fake ws via
  // the withws world node (native has Bun's built-in WebSocket and needs no world).
  const { withws } = makeWsWorlds(SBX);
  const wnode = worldNode(withws);
  const cver = version([wnode, BIN], { ...SBX.env, CLODE_NODE: wnode });
  if (nver !== cver) { SKIP = `version mismatch: native='${nver}' clode='${cver}'`; return; }
  // Warm clode's cache so a (re)extract never eats the timed capture.
  spawnSync(wnode, [BIN, '--version'], { env: { ...SBX.env, CLODE_NODE: wnode }, encoding: 'utf8' });
  const capOpts = { seconds: 16, thenHex: THEN_HEX, rows: 120, cols: 100 };
  NATIVE = capture(SBX, { ...capOpts, cmd: [native], env: { DISABLE_AUTOUPDATER: '1' } });
  CLODE  = capture(SBX, { ...capOpts, cmd: [wnode, BIN],
    env: { CLODE_NODE: wnode, DISABLE_AUTOUPDATER: '1' } });
});

after(() => { if (SBX) { try { fs.rmSync(SBX.dir, { recursive: true, force: true }); } catch { /* */ } } });

test('both /doctor renders were captured', (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  assert.match(NATIVE, /Enter to close/);
  assert.match(CLODE, /Enter to close/);
});

test('clode /doctor matches native except for allowlisted deviations', (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  // PENDING the doctor-parity allowlist curation (BACKLOG "Hermetic test execution"):
  // a live capture on a real box surfaces environment noise the current allowlist does
  // not yet cover — version fetch (Updates), auth/session (Remote Control), the macOS
  // Keychain-writability warning + the section-title status glyph (⚠/✔) in Diagnostics /
  // Installation warnings — plus wrapping differences from clode's FAKE render deps. The
  // fix (real render deps in the world + title-glyph normalization + volatile-section
  // allowlist in doctor-parity.cjs) is tracked separately; until then this strict
  // comparison would red on pure noise, so skip it. The comparator logic itself stays
  // covered by test/doctor-parity.test.cjs against the golden fixtures.
  t.skip('strict /doctor parity allowlist WIP — see BACKLOG hermetic-testing');
  const nf = path.join(SBX.dir, 'native.txt'), cf = path.join(SBX.dir, 'clode.txt');
  fs.writeFileSync(nf, NATIVE); fs.writeFileSync(cf, CLODE);
  const r = spawnSync(NODE, [DOCTOR_PARITY, nf, cf], { encoding: 'utf8' });
  if (r.status !== 0) console.error(r.stdout, r.stderr);
  assert.strictEqual(r.status, 0);
});
