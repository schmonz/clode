'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { cleanEnv, makeWorkspace } = require('../bench/lib/workspace.cjs');

test('cleanEnv inherits nothing sensitive and wires the mock', () => {
  process.env.SNIFF_ME = 'secret';
  const env = cleanEnv({ baseUrl: 'http://127.0.0.1:9', home: '/tmp/h' });
  assert.strictEqual(env.SNIFF_ME, undefined);
  assert.strictEqual(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9');
  assert.ok(env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY.length > 0);
  assert.strictEqual(env.HOME, '/tmp/h');
  assert.ok(env.PATH.includes('/usr/bin'));
  delete process.env.SNIFF_ME;
});

test('makeWorkspace creates a dir and cleanup removes it', () => {
  const ws = makeWorkspace({ baseUrl: 'http://127.0.0.1:9' });
  assert.ok(fs.existsSync(ws.dir));
  assert.strictEqual(ws.env.HOME, ws.dir);
  ws.cleanup();
  assert.ok(!fs.existsSync(ws.dir));
});
