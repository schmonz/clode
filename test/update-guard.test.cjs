'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { guardVerdict } = require('../libexec/update-guard.cjs');
const CORPUS = require('./update-guard-corpus.cjs');

const denied = (c) => { const v = guardVerdict(c); assert.ok(v && v.hookSpecificOutput.permissionDecision === 'deny', `expected DENY for: ${c}`); };
const allowed = (c) => assert.strictEqual(guardVerdict(c), null, `expected ALLOW for: ${c}`);

test('denies every case in the shared corpus', () => {
  for (const cmd of CORPUS.deny) denied(cmd);
});
test('allows every case in the shared corpus', () => {
  for (const cmd of CORPUS.allow) allowed(cmd);
});
test('ALLOWS on empty / non-string input (fail-open)', () => {
  for (const cmd of CORPUS.failOpen) allowed(cmd);
});
test('the deny reason names the automatic rebuild, no command to run', () => {
  const v = guardVerdict('claude update');
  assert.match(v.hookSpecificOutput.permissionDecisionReason, /rebuild|manages/i);
  assert.doesNotMatch(v.hookSpecificOutput.permissionDecisionReason, /run `?clode/i);
});
