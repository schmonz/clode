'use strict';
// The emulated-keychain async child must behave like a REAL child process.
//
// Root cause of open bug #1 (fixed 2026-08-06): `_kcFakeChild` pushed its
// payload AND EOF synchronously inside the constructor, so a consumer that
// attached on a later tick found an already-ended stream. A real child cannot
// do that — it must be spawned and scheduled before it can write — and the real
// child path (`wrapReadable`) pushes from an async drain loop for that reason.
//
// It mattered because the bundle reads the credential through execa, whose
// get-stream collector attaches on a LATER tick. Handed an ended stream it
// collected nothing and its promise never settled: the bundle's `await` never
// returned, nothing threw, nothing exited, and `quaude -p` ended 0 with EMPTY
// stdout and EMPTY stderr. Silent, on every headless box.
//
// These tests are HERMETIC: a temp HOME with a synthetic credentials fixture,
// CLODE_KC_MODE=emulate to pin the branch (the probe answers differently from a
// GUI session than over SSH), and NO real credentials anywhere.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { skipUnlessTjs, engineSpawn } = require('./node-shim-helper.cjs');

const LOADER = path.join(__dirname, '..', 'libexec/node-shim/loader.cjs');
// Shaped like the real store (service ends in `-credentials`, value is the
// credentials JSON) but entirely synthetic — no token, real or otherwise.
const FIXTURE = '{"claudeAiOauth":{"accessToken":"NOT-A-REAL-TOKEN","scopes":["user:inference"]}}';

function runUnderShim(body, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-async-'));
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude/.credentials.json'), FIXTURE, { mode: 0o600 });
  const f = path.join(dir, 'p.cjs');
  fs.writeFileSync(f, body);
  try {
    const [cmd, argv] = engineSpawn(['run', LOADER, f]);
    const r = spawnSync(cmd, argv, {
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env, HOME: home, CLODE_KC_MODE: 'emulate', ...extraEnv },
    });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// The regression proper. Attaching the collector on a LATER tick is what execa
// does and what the old synchronous push broke; attaching synchronously always
// worked, which is why simpler probes missed this.
test('emulated keychain: a collector attached on a LATER tick still receives the payload', (t) => {
  if (skipUnlessTjs(t)) return;
  const r = runUnderShim(`
    const cp = require('child_process');
    const child = cp.spawn('security',
      ['find-generic-password', '-a', process.env.USER || 'u', '-w', '-s', 'Claude Code-credentials'],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    // Attach only after a macrotask — the execa/get-stream timing.
    setTimeout(() => {
      let buf = '';
      child.stdout.on('data', (d) => { buf += d; });
      child.stdout.on('end', () => { console.log('COLLECTED ' + buf.trim().length); });
    }, 25);
    setTimeout(() => { console.log('NO_END_EVENT'); }, 4000).unref?.();
  `);
  assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
  // Pre-fix this printed COLLECTED 0 (or never fired 'end' at all).
  const m = r.stdout.match(/COLLECTED (\d+)/);
  assert.ok(m, `expected a COLLECTED line; got stdout=${JSON.stringify(r.stdout)} stderr=${r.stderr}`);
  assert.strictEqual(Number(m[1]), FIXTURE.length,
    `late collector got ${m[1]} bytes, expected the full ${FIXTURE.length}-byte payload`);
});

// execa awaits the exit AND full stream consumption together. If either half
// never settles the Promise.all hangs — the exact "promise never settles"
// signature that made the bundle exit 0 in silence.
test('emulated keychain: exit and stream consumption BOTH settle (execa-shaped await)', (t) => {
  if (skipUnlessTjs(t)) return;
  const r = runUnderShim(`
    const cp = require('child_process');
    const child = cp.spawn('security',
      ['find-generic-password', '-a', process.env.USER || 'u', '-w', '-s', 'Claude Code-credentials'],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    const collect = (st) => new Promise((res) => { let b = ''; st.on('data', (d) => { b += d; }); st.on('end', () => res(b)); });
    const exited = new Promise((res) => child.on('exit', res));
    setTimeout(() => {
      Promise.all([exited, collect(child.stdout), collect(child.stderr)])
        .then(([code, so]) => console.log('SETTLED code=' + code + ' len=' + so.trim().length));
    }, 25);
  `);
  assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /SETTLED code=0/, `execa-shaped await never settled: ${JSON.stringify(r.stdout)}`);
  assert.match(r.stdout, new RegExp(`len=${FIXTURE.length}\\b`));
});

// The ordering guarantee the fix restores: a real child's bytes arrive BEFORE
// its exit. Pushing payload and EOF in the constructor inverted this.
test('emulated keychain: stdout data arrives BEFORE exit, as from a real child', (t) => {
  if (skipUnlessTjs(t)) return;
  const r = runUnderShim(`
    const cp = require('child_process');
    const child = cp.spawn('security',
      ['find-generic-password', '-a', process.env.USER || 'u', '-w', '-s', 'Claude Code-credentials'],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    const seq = [];
    child.stdout.on('data', () => seq.push('data'));
    child.stdout.on('end', () => seq.push('end'));
    child.on('exit', () => { seq.push('exit'); setTimeout(() => console.log('SEQ ' + seq.join(',')), 0); });
  `);
  assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
  const m = r.stdout.match(/SEQ ([a-z,]+)/);
  assert.ok(m, `expected SEQ; got ${JSON.stringify(r.stdout)}`);
  assert.ok(m[1].indexOf('data') < m[1].indexOf('exit'), `data must precede exit, got: ${m[1]}`);
});

// A miss must stay a miss. The fix must not turn "no such item" into a hang or
// a bogus success — the branch the bundle relies on to fall back to an API key.
test('emulated keychain: a MISS still reports not-found, asynchronously', (t) => {
  if (skipUnlessTjs(t)) return;
  const r = runUnderShim(`
    const cp = require('child_process');
    cp.execFile('security', ['find-generic-password', '-a', 'nobody', '-w', '-s', 'no-such-service'],
      (err, so) => { console.log('MISS code=' + (err ? err.code : 0) + ' len=' + (so ? so.length : 0)); });
  `);
  assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
  assert.match(r.stdout, /MISS code=(44|36) len=0/, `unexpected miss result: ${JSON.stringify(r.stdout)}`);
});
