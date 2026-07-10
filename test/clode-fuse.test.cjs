'use strict';
// Unit tests for the `clode build` subcommand surface (libexec/clode-fuse.cjs
// + the clode-main dispatch). Cheap paths only — no tjs, no provider, no fuse:
// argv validation, template/provider fail-loud ordering, help text. The real
// fuse (compile + assemble + smoke) is exercised end-to-end in
// test/quaude-build.test.cjs, gated on tjs + CLODE_PROVIDER_BIN.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'bin', 'clode');
const NODE = process.execPath;

function runEntry(args, extraEnv) {
  return spawnSync(NODE, [ENTRY, ...args], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { DYLD_INSERT_LIBRARIES: '' }, extraEnv || {}),
  });
}

test('clode build: unknown argument fails loudly before any work', () => {
  const r = runEntry(['build', '--frobnicate']);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /build: unknown argument '--frobnicate'/);
  assert.match(r.stderr, /usage: clode build \[--self\] \[--out PATH\]/);
});

test('clode build --self: missing esbuilt bundle fails loudly and names the fix', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-build-self-'));
  const fakeTjs = path.join(home, 'tjs');
  fs.writeFileSync(fakeTjs, '#!/bin/sh\nexit 0\n');
  const r = runEntry(['build', '--self'], {
    CLODE_TJS: fakeTjs,
    CLODE_MAIN_BUNDLE: '/nonexistent/clode-main.bundle.cjs',
  });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /build --self: no esbuilt clode-main bundle at '\/nonexistent\/clode-main\.bundle\.cjs'/);
  assert.match(r.stderr, /build-sea\.mjs --bundle-only|CLODE_MAIN_BUNDLE/);
});

test('clode build: missing tjs template fails loudly and names the fix', () => {
  const r = runEntry(['build'], { CLODE_TJS: '/nonexistent/tjs' });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /build: no tjs template at '\/nonexistent\/tjs'/);
  assert.match(r.stderr, /build-tjs|CLODE_TJS/);
});

test('clode build: no resolvable provider fails loudly (after the template gate)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-build-nohome-'));
  // A real file suffices for the template existence gate; resolution then fails.
  const fakeTjs = path.join(home, 'tjs');
  fs.writeFileSync(fakeTjs, '#!/bin/sh\nexit 0\n');
  const r = runEntry(['build'], {
    HOME: home,
    CLODE_TJS: fakeTjs,
    CLODE_CLAUDE_BIN: '',
    CLODE_VERSION_DIR: '',
    CLODE_STATE_ROOT: home,
    PATH: '/nonexistent',
  });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /build: no Claude Code binary found/);
});

test('--clode-help documents clode build, build --self, and CLODE_TJS', () => {
  const r = runEntry(['--clode-help']);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /clode build \[--out PATH\]/);
  assert.match(r.stdout, /clode build --self/);
  assert.match(r.stdout, /quaude/);
  assert.match(r.stdout, /CLODE_TJS/);
});
