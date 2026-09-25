'use strict';
// test/live-frame-gate.cjs: the one skip chain every live pty frame gate uses. Pure where it
// can be (the platform and environment are parameters), so both directions of each branch
// are proven on any host.
const { test } = require('node:test');
const assert = require('node:assert');
const { liveFrameGate, quaudeBesideNative, ptyHarnessSkipReason, fullSuiteSkipReason, FULL_SUITE_ENV } = require('./live-frame-gate.cjs');

test('fullSuiteSkipReason: only the full suite\'s own declaration skips, and the reason says how to run it', () => {
  assert.strictEqual(FULL_SUITE_ENV, 'CLODE_TEST_FULL_SUITE');
  assert.strictEqual(fullSuiteSkipReason({}), null);
  assert.strictEqual(fullSuiteSkipReason({ [FULL_SUITE_ENV]: '0' }), null);
  const r = fullSuiteSkipReason({ [FULL_SUITE_ENV]: '1' });
  assert.match(r, /does not run inside the concurrent full suite \(test\/run\.mjs\)/);
  assert.match(r, /CI's linux-x64-pty job/);
  assert.match(r, /node --test <this file>` \(on darwin with CLODE_LIVE_RENDER=1\)/);
});

test('liveFrameGate: a SESSION gate skips inside the full suite on every platform; a single-frame gate does not', () => {
  const env = { [FULL_SUITE_ENV]: '1' };
  for (const platform of ['linux', 'win32', 'netbsd']) {
    assert.deepStrictEqual(liveFrameGate({ session: true, env, platform }), { skip: fullSuiteSkipReason(env) }, platform);
    const single = liveFrameGate({ session: false, env, platform });
    assert.notStrictEqual(single.skip, fullSuiteSkipReason(env), `${platform}: the full-suite rule is for session gates only`);
  }
});

test('liveFrameGate: darwin without CLODE_LIVE_RENDER=1 skips on live render before anything else', (t) => {
  const saved = process.env.CLODE_LIVE_RENDER;
  delete process.env.CLODE_LIVE_RENDER;
  t.after(() => { if (saved === undefined) delete process.env.CLODE_LIVE_RENDER; else process.env.CLODE_LIVE_RENDER = saved; });
  const r = liveFrameGate({ session: true, env: { [FULL_SUITE_ENV]: '1' }, platform: 'darwin' });
  assert.match(r.skip, /^live-render opt-in only on darwin/);
});

test('liveFrameGate: with every precondition met, a missing native is its own named skip', (t) => {
  const pre = ptyHarnessSkipReason() || require('./provider-resolve.cjs').skipReason(process.env);
  if (pre) { t.skip(`this host lacks a precondition before the native check: ${pre}`); return; }
  const r = liveFrameGate({ env: { ...process.env, CLODE_NATIVE_CLAUDE: '/nonexistent/claude' }, platform: 'linux' });
  assert.deepStrictEqual(r, { skip: 'no native claude (set CLODE_NATIVE_CLAUDE, or put `claude` on PATH)' });
});

// The wiring, measured where it matters: a file the full suite runs sees the declaration.
// Detected the way test/central-security-stub.test.cjs detects test/run.mjs (the stub dir
// only it exports), so this skips under a bare `node --test`.
test('test/run.mjs declares the full suite to every file it runs', (t) => {
  if (!process.env.CLODE_TEST_SECURITY_STUB_DIR) { t.skip('not running under test/run.mjs'); return; }
  assert.strictEqual(process.env[FULL_SUITE_ENV], '1');
});

// quaudeBesideNative: the quaude a gate judges, only when it is the native's version. Stand-in
// binaries that print a version, so every branch is proven without building anything.
test('quaudeBesideNative: a missing CLODE_QUAUDE, a version mismatch and a match', (t) => {
  if (process.platform === 'win32') {
    t.skip('the #!/bin/sh stand-ins cannot be exec\'d on Windows, where no live frame gate runs');
    return;
  }
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-frame-gate-'));
  const saved = process.env.CLODE_QUAUDE;
  t.after(() => {
    if (saved === undefined) delete process.env.CLODE_QUAUDE; else process.env.CLODE_QUAUDE = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const stand = (name, version) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, `#!/bin/sh\necho "${version} (Claude Code)"\n`);
    fs.chmodSync(p, 0o755);
    return p;
  };
  const native = stand('native', '2.1.278'), same = stand('same', '2.1.278'), older = stand('older', '2.1.251');

  process.env.CLODE_QUAUDE = path.join(dir, 'absent');
  assert.deepStrictEqual(quaudeBesideNative(native), { skip: `CLODE_QUAUDE=${path.join(dir, 'absent')} does not exist` });

  process.env.CLODE_QUAUDE = older;
  assert.deepStrictEqual(quaudeBesideNative(native), { skip: 'native and quaude are not the same version, so their '
    + `frames are not comparable: ${native} says "2.1.278 (Claude Code)", ${older} says "2.1.251 (Claude Code)"` });

  process.env.CLODE_QUAUDE = same;
  assert.deepStrictEqual(quaudeBesideNative(native), { quaude: same, version: '2.1.278 (Claude Code)' });
});
