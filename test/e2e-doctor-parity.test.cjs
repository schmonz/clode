const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sandbox, REPO, NODE } = require('./e2e.cjs');
const { capture, seedClaudeProfile } = require('./e2e-pty.cjs');

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
  const cver = version([NODE, BIN], { ...SBX.env });
  if (nver !== cver) { SKIP = `version mismatch: native='${nver}' clode='${cver}'`; return; }
  // Warm clode's cache so a (re)extract never eats the timed capture.
  spawnSync(NODE, [BIN, '--version'], { env: { ...SBX.env }, encoding: 'utf8' });
  const capOpts = { seconds: 16, thenHex: THEN_HEX, rows: 120, cols: 100 };
  NATIVE = capture(SBX, { ...capOpts, cmd: [native], env: { DISABLE_AUTOUPDATER: '1' } });
  CLODE  = capture(SBX, { ...capOpts, cmd: [NODE, BIN], env: { DISABLE_AUTOUPDATER: '1' } });
});

after(() => { if (SBX) { try { fs.rmSync(SBX.dir, { recursive: true, force: true }); } catch { /* */ } } });

test('both /doctor renders were captured', (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  assert.match(NATIVE, /Enter to close/);
  assert.match(CLODE, /Enter to close/);
});

test('clode /doctor matches native except for allowlisted deviations', (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  const nf = path.join(SBX.dir, 'native.txt'), cf = path.join(SBX.dir, 'clode.txt');
  fs.writeFileSync(nf, NATIVE); fs.writeFileSync(cf, CLODE);
  const r = spawnSync(NODE, [DOCTOR_PARITY, nf, cf], { encoding: 'utf8' });
  if (r.status !== 0) console.error(r.stdout, r.stderr);
  assert.strictEqual(r.status, 0);
});
