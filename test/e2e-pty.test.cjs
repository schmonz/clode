const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { sandbox } = require('./e2e.cjs');
const { seedClaudeProfile } = require('./e2e-pty.cjs');

test('seedClaudeProfile writes a cwd-keyed trusted profile', (t) => {
  const sbx = sandbox(t);
  seedClaudeProfile(sbx.home, { cwd: '/some/project' });
  const j = JSON.parse(fs.readFileSync(path.join(sbx.home, '.claude.json'), 'utf8'));
  assert.strictEqual(j.hasCompletedOnboarding, true);
  assert.ok(j.projects['/some/project'], 'the cwd is present in projects');
  assert.strictEqual(j.projects['/some/project'].hasTrustDialogAccepted, true);
});
