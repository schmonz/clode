const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { sandbox } = require('./e2e.cjs');
const { makeWsWorlds, seedClaudeProfile, worldNode } = require('./e2e-pty.cjs');

test('makeWsWorlds builds withws (with ws) and nows (without ws)', (t) => {
  const sbx = sandbox(t);
  const { withws, nows } = makeWsWorlds(sbx);
  // both worlds have a node symlink + fake render deps
  for (const p of [withws, nows]) {
    assert.ok(fs.existsSync(worldNode(p)), 'world node symlink exists');
    assert.ok(fs.existsSync(path.join(p, 'lib', 'node_modules', 'string-width', 'package.json')));
  }
  // ws present ONLY in withws
  assert.ok(fs.existsSync(path.join(withws, 'lib', 'node_modules', 'ws', 'index.js')));
  assert.ok(!fs.existsSync(path.join(nows, 'lib', 'node_modules', 'ws')));
});

test('seedClaudeProfile writes a cwd-keyed trusted profile', (t) => {
  const sbx = sandbox(t);
  seedClaudeProfile(sbx.home, { cwd: '/some/project' });
  const j = JSON.parse(fs.readFileSync(path.join(sbx.home, '.claude.json'), 'utf8'));
  assert.strictEqual(j.hasCompletedOnboarding, true);
  assert.ok(j.projects['/some/project'], 'the cwd is present in projects');
  assert.strictEqual(j.projects['/some/project'].hasTrustDialogAccepted, true);
});
