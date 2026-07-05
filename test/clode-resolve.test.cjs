'use strict';
// Unit tests for libexec/clode-resolve.cjs — the JS port of bin/clode's
// resolve_claude_bin, follow_wrapper, sig_of and cache_key. Mirrors the sh-side
// coverage in test/test_resolve.bats (precedence + wrapper follow), the cache_key
// cases in test/test_launcher_unit.bats, and the keying semantics in
// test/test_keying.bats. Real "bundle" fixtures come from test/mkfixture.cjs.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  resolveClaudeBin,
  followWrapper,
  sigOf,
  cacheKey,
} = require('../libexec/clode-resolve.cjs');

// --- helpers ---------------------------------------------------------------
function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clode-resolve-'));
}

// A "real bundle" fixture: > 1MB @bun-cjs blob (>= 65536, so follow_wrapper must
// leave it untouched). Uses the same mkfixture.cjs the bats suite uses.
function mkBundle(out, label) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  execFileSync(process.execPath, [path.join(__dirname, 'mkfixture.cjs'), out, label]);
  return out;
}

function writeExec(p, body) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  fs.chmodSync(p, 0o755);
  return p;
}

// =========================================================================
// resolveClaudeBin — precedence (mirrors test_resolve.bats 1-5, + provider)
// =========================================================================

test('1. CLODE_CLAUDE_BIN wins over all', () => {
  const env = {
    CLODE_CLAUDE_BIN: '/x/explicit',
    CLODE_VERSION_DIR: '/x/versiondir',
  };
  assert.strictEqual(resolveClaudeBin({ env }), '/x/explicit');
});

test('2. CLODE_VERSION_DIR next', () => {
  const env = { CLODE_VERSION_DIR: '/x/versiondir' };
  assert.strictEqual(resolveClaudeBin({ env }), '/x/versiondir');
});

test('3. provider current (symlink-resolved abs) beats baked/local/PATH', () => {
  const dir = tmpdir();
  // providers/<ver>/claude, with providers/current -> <ver> (a symlink).
  const providers = path.join(dir, 'providers');
  const verdir = path.join(providers, '2.1.183');
  fs.mkdirSync(verdir, { recursive: true });
  mkBundle(path.join(verdir, 'claude'), 'prov');
  fs.writeFileSync(path.join(providers, 'current'), '2.1.183\n');
  const env = { CLODE_PROVIDERS: providers, HOME: dir, PATH: '' };
  // Resolves through `current` to the physical version dir.
  assert.strictEqual(
    resolveClaudeBin({ env, baked: mkBundle(path.join(dir, 'baked'), 'b') }),
    path.join(verdir, 'claude'),
  );
});

test('3b. provider default location XDG_DATA_HOME/clode/providers', () => {
  const dir = tmpdir();
  const providers = path.join(dir, 'clode', 'providers');
  const verdir = path.join(providers, '9.9.9');
  fs.mkdirSync(verdir, { recursive: true });
  mkBundle(path.join(verdir, 'claude'), 'prov');
  fs.writeFileSync(path.join(providers, 'current'), '9.9.9\n');
  const env = { XDG_DATA_HOME: dir, HOME: dir, PATH: '' };
  assert.strictEqual(
    resolveClaudeBin({ env }),
    path.join(verdir, 'claude'),
  );
});

test('4. baked CLAUDE_BIN_BAKED next (when it exists)', () => {
  const dir = tmpdir();
  const baked = mkBundle(path.join(dir, 'baked'), 'b');
  const env = { HOME: path.join(dir, 'nohome'), PATH: '' };
  assert.strictEqual(resolveClaudeBin({ env, baked }), baked);
});

test('4b. a baked path that does not exist is skipped', () => {
  const dir = tmpdir();
  const env = { HOME: path.join(dir, 'nohome'), PATH: '' };
  assert.strictEqual(resolveClaudeBin({ env, baked: '/no/such/baked' }), null);
});

test('5. ~/.local/bin/claude symlink next (absolute target, one hop)', () => {
  const dir = tmpdir();
  const target = mkBundle(path.join(dir, 'local-target'), 'L-local');
  const home = path.join(dir, 'home');
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.symlinkSync(target, path.join(home, '.local', 'bin', 'claude'));
  const env = { HOME: home, PATH: '' };
  assert.strictEqual(resolveClaudeBin({ env }), target);
});

test('5b. ~/.local/bin/claude relative symlink is anchored at the link dir', () => {
  const dir = tmpdir();
  const home = path.join(dir, 'home');
  const bindir = path.join(home, '.local', 'bin');
  fs.mkdirSync(bindir, { recursive: true });
  mkBundle(path.join(bindir, 'real-claude'), 'rel');
  fs.symlinkSync('real-claude', path.join(bindir, 'claude')); // relative target
  const env = { HOME: home, PATH: '' };
  assert.strictEqual(
    resolveClaudeBin({ env }),
    path.join(bindir, 'real-claude'),
  );
});

test('5c. ~/.local/bin/claude regular file (not a symlink) returns the path itself', () => {
  const dir = tmpdir();
  const home = path.join(dir, 'home');
  const bindir = path.join(home, '.local', 'bin');
  const claude = mkBundle(path.join(bindir, 'claude'), 'plain');
  const env = { HOME: home, PATH: '' };
  assert.strictEqual(resolveClaudeBin({ env }), claude);
});

test('5d. ~/.local/bin/claude.exe (Windows plain copy) resolves to the .exe', () => {
  const dir = tmpdir();
  const home = path.join(dir, 'home');
  const bindir = path.join(home, '.local', 'bin');
  const claudeExe = mkBundle(path.join(bindir, 'claude.exe'), 'winexe');
  const env = { HOME: home, PATH: '' };
  assert.strictEqual(resolveClaudeBin({ env }), claudeExe);
});

test('5e. when both claude and claude.exe exist, claude wins', () => {
  const dir = tmpdir();
  const home = path.join(dir, 'home');
  const bindir = path.join(home, '.local', 'bin');
  const claude = mkBundle(path.join(bindir, 'claude'), 'plain');
  mkBundle(path.join(bindir, 'claude.exe'), 'winexe');
  const env = { HOME: home, PATH: '' };
  assert.strictEqual(resolveClaudeBin({ env }), claude);
});

test('6. claude on PATH last', () => {
  const dir = tmpdir();
  const pathdir = path.join(dir, 'pathdir');
  const claude = writeExec(path.join(pathdir, 'claude'), '#!/bin/sh\necho hi\n');
  const env = { HOME: path.join(dir, 'nohome'), PATH: pathdir };
  assert.strictEqual(resolveClaudeBin({ env }), claude);
});

test('6b. a non-executable claude on PATH is skipped', () => {
  const dir = tmpdir();
  const pathdir = path.join(dir, 'pathdir');
  fs.mkdirSync(pathdir, { recursive: true });
  fs.writeFileSync(path.join(pathdir, 'claude'), 'not exec');
  fs.chmodSync(path.join(pathdir, 'claude'), 0o644);
  const env = { HOME: path.join(dir, 'nohome'), PATH: pathdir };
  assert.strictEqual(resolveClaudeBin({ env }), null);
});

test('7. no provider yields the not-found signal (null)', () => {
  const dir = tmpdir();
  const env = { HOME: path.join(dir, 'empty'), PATH: path.join(dir, 'empty') };
  assert.strictEqual(resolveClaudeBin({ env }), null);
});

// =========================================================================
// followWrapper — mirrors test_resolve.bats 6-7 + relative/env/$@ cases
// =========================================================================

test('a tiny exec-wrapper is followed to the real bundle (issue #1)', () => {
  const dir = tmpdir();
  const bundle = mkBundle(path.join(dir, 'bundle'), 'real');
  const wrapper = writeExec(
    path.join(dir, 'wrapper'),
    `#!/bin/sh\nexec ${bundle} "$@"\n`,
  );
  assert.strictEqual(followWrapper(wrapper), bundle);
});

test('a real (non-wrapper) bundle is left untouched (>= 65536 bytes)', () => {
  const dir = tmpdir();
  const bundle = mkBundle(path.join(dir, 'bundle'), 'real');
  assert.ok(fs.statSync(bundle).size >= 65536);
  assert.strictEqual(followWrapper(bundle), bundle);
});

test('exec "$@" is not followed (target not absolute)', () => {
  const dir = tmpdir();
  const w = writeExec(path.join(dir, 'w'), '#!/bin/sh\nexec "$@"\n');
  assert.strictEqual(followWrapper(w), w);
});

test('a relative exec target is not followed', () => {
  const dir = tmpdir();
  mkBundle(path.join(dir, 'real'), 'r');
  const w = writeExec(path.join(dir, 'w'), '#!/bin/sh\nexec ./real "$@"\n');
  assert.strictEqual(followWrapper(w), w);
});

test('exec env ... is not followed (first token "env" not absolute)', () => {
  const dir = tmpdir();
  const w = writeExec(path.join(dir, 'w'), '#!/bin/sh\nexec env FOO=1 /abs/claude "$@"\n');
  assert.strictEqual(followWrapper(w), w);
});

test('a missing absolute exec target leaves the path unchanged', () => {
  const dir = tmpdir();
  const w = writeExec(path.join(dir, 'w'), '#!/bin/sh\nexec /no/such/target "$@"\n');
  assert.strictEqual(followWrapper(w), w);
});

test('the LAST exec line wins (matches sed | tail -1)', () => {
  const dir = tmpdir();
  const a = mkBundle(path.join(dir, 'a'), 'a');
  const b = mkBundle(path.join(dir, 'b'), 'b');
  const w = writeExec(
    path.join(dir, 'w'),
    `#!/bin/sh\nexec ${a} "$@"\nexec ${b} "$@"\n`,
  );
  assert.strictEqual(followWrapper(w), b);
});

test('a chain of wrappers is followed to the end', () => {
  const dir = tmpdir();
  const bundle = mkBundle(path.join(dir, 'bundle'), 'real');
  const w2 = writeExec(path.join(dir, 'w2'), `#!/bin/sh\nexec ${bundle} "$@"\n`);
  const w1 = writeExec(path.join(dir, 'w1'), `#!/bin/sh\nexec ${w2} "$@"\n`);
  assert.strictEqual(followWrapper(w1), bundle);
});

test('a self-referential wrapper terminates (target == self)', () => {
  const dir = tmpdir();
  const self = path.join(dir, 'self');
  writeExec(self, `#!/bin/sh\nexec ${self} "$@"\n`);
  assert.strictEqual(followWrapper(self), self);
});

test('a nonexistent start path is returned unchanged', () => {
  assert.strictEqual(followWrapper('/no/such/file'), '/no/such/file');
});

// =========================================================================
// sigOf — stability (mirrors test_keying.bats semantics)
// =========================================================================

test('sigOf: same file yields the same signature', () => {
  const dir = tmpdir();
  const f = path.join(dir, 'f');
  fs.writeFileSync(f, 'hello');
  assert.strictEqual(sigOf(f), sigOf(f));
});

test('sigOf: distinct sizes yield distinct signatures', () => {
  const dir = tmpdir();
  const a = path.join(dir, 'a');
  const b = path.join(dir, 'b');
  fs.writeFileSync(a, 'x');
  fs.writeFileSync(b, 'xxxxxxxxxx');
  assert.notStrictEqual(sigOf(a), sigOf(b));
});

test('sigOf: format is <size>-<truncated epoch seconds>', () => {
  const dir = tmpdir();
  const f = path.join(dir, 'f');
  fs.writeFileSync(f, 'abcd');
  const s = fs.statSync(f);
  assert.strictEqual(sigOf(f), `${s.size}-${Math.trunc(s.mtimeMs / 1000)}`);
});

// =========================================================================
// cacheKey — mirrors test_launcher_unit.bats + test_keying.bats
// =========================================================================

test('cacheKey uses the version when the path is versioned', () => {
  assert.strictEqual(
    cacheKey('/home/u/.local/share/claude/versions/2.1.183'),
    '2.1.183',
  );
});

test('cacheKey uses the version for a versioned path with trailing segments', () => {
  assert.strictEqual(
    cacheKey('/home/u/.local/share/claude/versions/2.1.183/bin/claude'),
    '2.1.183',
  );
});

test('cacheKey uses the version for a providers path', () => {
  assert.strictEqual(
    cacheKey('/x/.local/share/clode/providers/9.9.9/claude'),
    '9.9.9',
  );
});

test('cacheKey uses the FIRST /versions/ occurrence', () => {
  assert.strictEqual(cacheKey('/a/versions/1.0.0/versions/2.0.0/claude'), '1.0.0');
});

test('cacheKey falls back to basename+signature for unversioned paths', () => {
  const dir = tmpdir();
  const bin = path.join(dir, 'claude');
  mkBundle(bin, 'v');
  const key = cacheKey(bin);
  assert.match(key, /^claude-\d+-\d+$/);
  assert.strictEqual(key, `claude-${sigOf(bin)}`);
});

test('cacheKey reads the version from a Windows-separator versioned path', () => {
  assert.strictEqual(cacheKey('C:\\Users\\x\\.local\\share\\clode\\providers\\2.1.201\\claude'), '2.1.201');
  assert.strictEqual(cacheKey('C:\\a\\versions\\9.9.9\\claude.exe'), '9.9.9');
});

test('cacheKey is stable: same binary -> same key', () => {
  const dir = tmpdir();
  const bin = path.join(dir, 'claude');
  mkBundle(bin, 'v');
  assert.strictEqual(cacheKey(bin), cacheKey(bin));
});
