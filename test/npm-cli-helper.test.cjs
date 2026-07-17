'use strict';
// Unit tests for scripts/lib/npm-cli.cjs — the npm-CLI resolver + runner shared by
// build-clode-main.mjs and build-naude.mjs (previously byte-identical copies, differing
// only in the thrown-error prefix). Everything here is injected (existsSync,
// execFileSync); no real npm is ever shelled.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { npmCliPath, runNpm } = require('../scripts/lib/npm-cli.cjs');

const FAKE_EXEC_PATH = path.join('fake', 'node', 'bin', 'node');
const WIN_CANDIDATE = path.join('fake', 'node', 'bin', 'node_modules', 'npm', 'bin', 'npm-cli.js');
const POSIX_CANDIDATE = path.join('fake', 'node', 'bin', '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');

test('npmCliPath: default (real fs/execPath) resolves a real npm-cli.js', () => {
  const found = npmCliPath();
  assert.match(found, /npm-cli\.js$/);
});

test('npmCliPath: probes the Windows dist layout before the POSIX layout', () => {
  const seen = [];
  const existsSync = (p) => { seen.push(p); return p === WIN_CANDIDATE; };
  const found = npmCliPath({ execPath: FAKE_EXEC_PATH, existsSync });
  assert.strictEqual(found, WIN_CANDIDATE);
  // Windows candidate must be probed FIRST, POSIX second — order matters, not just presence.
  assert.deepStrictEqual(seen, [WIN_CANDIDATE]);
});

test('npmCliPath: falls back to the POSIX dist layout when the Windows one is absent', () => {
  const seen = [];
  const existsSync = (p) => { seen.push(p); return p === POSIX_CANDIDATE; };
  const found = npmCliPath({ execPath: FAKE_EXEC_PATH, existsSync });
  assert.strictEqual(found, POSIX_CANDIDATE);
  assert.deepStrictEqual(seen, [WIN_CANDIDATE, POSIX_CANDIDATE]);
});

test('npmCliPath: missing npm-cli.js throws with the caller-supplied prefix', () => {
  assert.throws(
    () => npmCliPath({ execPath: FAKE_EXEC_PATH, existsSync: () => false, prefix: 'build-widget' }),
    /^Error: build-widget: could not locate npm-cli\.js next to fake/,
  );
});

test('npmCliPath: prefix defaults to something sane when the caller omits it', () => {
  assert.throws(
    () => npmCliPath({ execPath: FAKE_EXEC_PATH, existsSync: () => false }),
    /: could not locate npm-cli\.js next to fake/,
  );
});

test('runNpm: invokes the injected execFileSync with process.execPath + [npmCliPath(), ...args]', () => {
  const calls = [];
  const execFileSync = (...a) => { calls.push(a); };
  const opts = { cwd: '/somewhere', stdio: 'inherit' };
  runNpm(['ci', '--no-audit'], opts, { execFileSync });
  assert.strictEqual(calls.length, 1);
  const [exe, argv, passedOpts] = calls[0];
  assert.strictEqual(exe, process.execPath);
  assert.strictEqual(argv[0], npmCliPath());
  assert.deepStrictEqual(argv.slice(1), ['ci', '--no-audit']);
  assert.strictEqual(passedOpts, opts);
});

test('runNpm: propagates the caller prefix into a resolution failure', () => {
  const execFileSync = () => { throw new Error('should not be called'); };
  assert.throws(
    () => runNpm(['ci'], {}, {
      execFileSync, execPath: FAKE_EXEC_PATH, existsSync: () => false, prefix: 'build-naude',
    }),
    /^Error: build-naude: could not locate npm-cli\.js next to fake/,
  );
});
