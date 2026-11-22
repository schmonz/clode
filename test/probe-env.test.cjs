'use strict';
// The MCP transport probe's client env (scripts/lib/probe-env.cjs) carries every variable, in every spelling, that
// the first minimal env carried (3b5f2d1, a computed copy of this exact allowlist, under which both Windows SSE smokes
// passed in CI 44986483868). The literal rewrite kept one spelling each (PATH, SystemRoot, windir) and both Windows
// smokes then reached no server (CI 45005386065): node reads process.env case-insensitively on Windows, but the env
// object handed to the child is taken key by key. Judged: with each of these set, each reaches the env under its
// own name and value; an unset one is not passed; nothing else from the parent gets through.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { probeEnv } = require('../scripts/lib/probe-env.cjs');

// 3b5f2d1's allowlist, verbatim.
const COPIED = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'ComSpec', 'PATHEXT', 'SystemDrive',
  'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL', 'TERM'];
const FIXED = ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY'];

test('the probe env carries every variable and spelling the copied allowlist did, and nothing else', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-env-'));
  const planted = [];
  try {
    // Set the unset ones (never touch a set one: on Windows, Path IS PATH); plant a secret that must not pass.
    for (const k of COPIED) if (process.env[k] === undefined) { process.env[k] = `probe-${k}`; planted.push(k); }
    process.env.CLAUDE_CODE_OAUTH_TOKEN_PROBE_ENV = 'secret'; planted.push('CLAUDE_CODE_OAUTH_TOKEN_PROBE_ENV');
    const env = probeEnv(path.join(base, 'home'));
    for (const k of COPIED) assert.strictEqual(env[k], process.env[k], `${k} reaches the client as the parent has it`);
    assert.deepStrictEqual(Object.keys(env).filter((k) => !COPIED.includes(k)).sort(), [...FIXED].sort(),
      'nothing but the allowlist and the throwaway home');
    assert.strictEqual(env.HOME, path.join(base, 'home'));
    assert.strictEqual(env.USERPROFILE, path.join(base, 'home'));
  } finally {
    for (const k of planted) delete process.env[k];
    fs.rmSync(base, { recursive: true, force: true });
  }
  // An unset variable is not passed at all (as the copy's `!== undefined` skipped it).
  const saved = process.env.LC_ALL;
  delete process.env.LC_ALL;
  try {
    const b2 = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-env-'));
    try { assert.ok(!('LC_ALL' in probeEnv(path.join(b2, 'home'))), 'an unset LC_ALL is absent, not undefined'); }
    finally { fs.rmSync(b2, { recursive: true, force: true }); }
  } finally { if (saved !== undefined) process.env.LC_ALL = saved; }
});
