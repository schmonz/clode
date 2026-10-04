'use strict';
// `clode build`'s smoke runs the product with its OWN throwaway HOME (grep-native Task 10b fix round 3, ruling G33).
//
// The PONG smoke boots the bundle it just built. It used to hand it clode's inherited environment, real HOME included,
// so every build ran the user's ~/.claude/settings.json hooks and left ~/.claude.json, ~/.tjs/localStorage.db and
// ~/.tjs/cookies.txt behind (measured by the review: every test that builds a quaude did it to the developer's home).
// A build must never touch the user's home. The smoke now gets a HOME, USERPROFILE and CLAUDE_CONFIG_DIR of its own,
// in a temp dir it creates and removes, whatever HOME the build was given.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { smokeTarget, buildSmokeHome } = require('../libexec/clode-build.cjs');

test('smokeTarget hands the product its own HOME, USERPROFILE and CLAUDE_CONFIG_DIR, and removes them after', async () => {
  const sentinel = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-sentinel-home-'));
  let seen = null;
  const spawnRun = async (bin, args, { env }) => {
    seen = { HOME: env.HOME, USERPROFILE: env.USERPROFILE, CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR, existed: fs.existsSync(env.HOME) };
    // stand in for the bundle's writes, into the home it was given
    fs.writeFileSync(path.join(env.HOME, '.claude.json'), '{}');
    return { status: 0, stdout: 'PONG', stderr: '' };
  };
  await smokeTarget('/bin/quaude', { spawnRun, env: { ...process.env, HOME: sentinel, USERPROFILE: sentinel, CLAUDE_CONFIG_DIR: path.join(sentinel, '.claude') }, cwd: os.tmpdir(), timeout: 1000 });
  assert.ok(seen, 'the smoke ran');
  assert.notStrictEqual(seen.HOME, sentinel, 'the smoke ran with the build\'s own HOME');
  assert.ok(seen.existed, 'the smoke\'s home existed while it ran');
  assert.strictEqual(seen.USERPROFILE, seen.HOME);
  assert.strictEqual(seen.CLAUDE_CONFIG_DIR, path.join(seen.HOME, '.claude'));
  assert.ok(!fs.existsSync(seen.HOME), 'the smoke\'s home is removed afterwards');
  assert.deepStrictEqual(fs.readdirSync(sentinel), [], 'the sentinel HOME is untouched');
  fs.rmSync(sentinel, { recursive: true, force: true });
});

test('buildSmokeHome: a fresh dir with .claude inside, removed by remove()', () => {
  const h = buildSmokeHome();
  assert.ok(fs.statSync(path.join(h.env.HOME, '.claude')).isDirectory());
  assert.deepStrictEqual(Object.keys(h.env).sort(), ['CLAUDE_CONFIG_DIR', 'HOME', 'USERPROFILE']);
  h.remove();
  assert.ok(!fs.existsSync(h.env.HOME));
});
