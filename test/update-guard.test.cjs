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
  // Fail-safe: a shell wrapping the command in quotes must not slip through.
  denied('bash -c "claude update"');
  denied("sh -c 'claude upgrade'");
  denied('ssh host "claude update"');
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
  allowed('echo updating');
});
test('accepted safe over-deny: the words in quoted data are denied (fail-safe)', () => {
  // "claude update" appearing inside quoted data (e.g. a commit message) is
  // denied even though it isn't really an update command. This is a
  // deliberate, safe over-deny: under-denying a real `claude update` hidden
  // behind a shell quote (bash -c "claude update") would be a security bug,
  // and a wrong deny here is self-explanatory and recoverable.
  denied('git commit -m "claude update guard"');
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
