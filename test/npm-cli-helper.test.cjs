'use strict';
// Unit tests for scripts/lib/npm-cli.cjs — the npm-CLI resolver + runner shared by
// build-clode-main.mjs and build-naude.mjs (previously byte-identical copies, differing
// only in the thrown-error prefix). Everything here is injected (existsSync,
// execFileSync); no real npm is ever shelled.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { npmCliPath, runNpm, envWithRealNodeOnPath } = require('../scripts/lib/npm-cli.cjs');

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
  // Not the SAME object as `opts` any more (Finding 1): runNpm now augments PATH so
  // the child's own lifecycle scripts can find a real `node`, which means it must
  // build a new opts object rather than pass the caller's through unchanged.
  assert.notStrictEqual(passedOpts, opts);
  assert.strictEqual(passedOpts.cwd, opts.cwd);
  assert.strictEqual(passedOpts.stdio, opts.stdio);
  assert.ok(passedOpts.env.PATH.startsWith(path.dirname(process.execPath) + path.delimiter)
    || passedOpts.env.PATH === path.dirname(process.execPath));
});

test('runNpm: a caller-supplied env is preserved, with PATH augmented (not replaced)', () => {
  const calls = [];
  const execFileSync = (...a) => { calls.push(a); };
  runNpm(['ci'], { env: { FOO: 'bar', PATH: '/x:/y' } }, { execFileSync });
  const passedOpts = calls[0][2];
  assert.strictEqual(passedOpts.env.FOO, 'bar');
  assert.strictEqual(passedOpts.env.PATH, `${path.dirname(process.execPath)}${path.delimiter}/x:/y`);
});

test('envWithRealNodeOnPath: prepends the real node dir to an existing PATH', () => {
  const out = envWithRealNodeOnPath({ PATH: '/a:/b' }, '/fake/node/bin/node');
  assert.strictEqual(out.PATH, `/fake/node/bin${path.delimiter}/a:/b`);
});

test('envWithRealNodeOnPath: works with no PATH at all', () => {
  const out = envWithRealNodeOnPath({ FOO: '1' }, '/fake/node/bin/node');
  assert.strictEqual(out.PATH, '/fake/node/bin');
  assert.strictEqual(out.FOO, '1');
});

test('envWithRealNodeOnPath: finds a differently-cased PATH key (Windows spells it "Path") and extends IT, not a new PATH', () => {
  // path.dirname is the HOST's own module (posix here) — build the fake execPath with
  // path.join so dirname/delimiter agree with whichever platform runs this test,
  // rather than hand-writing a Windows-shaped literal that only parses correctly
  // under path.win32.
  const fakeExecPath = path.join('fake', 'node', 'bin', 'node');
  const out = envWithRealNodeOnPath({ Path: '/a;/b' }, fakeExecPath);
  assert.strictEqual(out.Path, `${path.dirname(fakeExecPath)}${path.delimiter}/a;/b`);
  assert.strictEqual(out.PATH, undefined);
});

test('envWithRealNodeOnPath: never mutates the input env object', () => {
  const input = { PATH: '/a' };
  envWithRealNodeOnPath(input, '/fake/node/bin/node');
  assert.deepStrictEqual(input, { PATH: '/a' });
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
