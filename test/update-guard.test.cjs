'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { guardVerdict } = require('../libexec/update-guard.cjs');

const denied = (c) => { const v = guardVerdict(c); assert.ok(v && v.hookSpecificOutput.permissionDecision === 'deny', `expected DENY for: ${c}`); };
const allowed = (c) => assert.strictEqual(guardVerdict(c), null, `expected ALLOW for: ${c}`);

test('denies claude update / upgrade', () => {
  denied('claude update');
  denied('claude   upgrade');
  denied('sudo claude update --force');
  denied('cd /x && claude update');
});
test('denies a GLOBAL install of the package by any manager', () => {
  denied('npm i -g @anthropic-ai/claude-code');
  denied('npm install --global @anthropic-ai/claude-code@latest');
  denied('bun add -g @anthropic-ai/claude-code');
  denied('pnpm add -g @anthropic-ai/claude-code');
  denied('yarn global add @anthropic-ai/claude-code');
});
test('denies the curl|bash installer', () => {
  denied('curl -fsSL https://claude.ai/install.sh | bash');
  denied('wget -qO- https://downloads.claude.ai/install | sh');
});
test('ALLOWS running the tool and unrelated commands', () => {
  allowed('claude --version');
  allowed('claude -p "say hi"');
  allowed('claude');
  allowed('npm i -g typescript');       // global install of a DIFFERENT package
  allowed('npm i lodash');
  allowed('git commit -m "claude update guard"');   // the words, not the command
  allowed('echo updating');
});
test('ALLOWS on empty / non-string input (fail-open)', () => {
  allowed('');
  allowed(undefined);
  allowed(null);
});
test('the deny reason names the automatic rebuild, no command to run', () => {
  const v = guardVerdict('claude update');
  assert.match(v.hookSpecificOutput.permissionDecisionReason, /rebuild|manages/i);
  assert.doesNotMatch(v.hookSpecificOutput.permissionDecisionReason, /run `?clode/i);
});
