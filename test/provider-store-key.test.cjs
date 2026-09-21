'use strict';
// THE PROVIDER STORE'S KEY (spec 2026-09-14 phase 4, §7.1).
//
// `~/.local/share/clode/providers/<version>/claude` was keyed by VERSION ALONE — one
// binary per version — while `clode fetch claude` is OS-MATCHED. So the same path meant
// different bytes on different machines, and on ONE machine the first target fetched for
// a version occupied the path: `libexec/clode-update.cjs` built its destination as
// `path.join(providersDir, ver)` and the branch below it did a "byte-verified copy on
// disk (a re-point to an already-fetched version)", so a later fetch for a DIFFERENT
// target re-pointed to the first one's bytes instead of fetching its own. First writer
// wins, silently.
//
// That is not hypothetical and it is not historical. Measured on this box 2026-09-20,
// a darwin-arm64 Mac:
//     providers/2.1.207/claude  ELF 64-bit LSB executable, x86-64
//     providers/2.1.210/claude  ELF 64-bit LSB executable, x86-64
//     providers/2.1.211/claude  ELF 64-bit LSB executable, x86-64
//     providers/2.1.215/claude  ELF 64-bit LSB executable, x86-64
//     providers/2.1.243/claude  ELF 64-bit LSB executable, x86-64
// Five linux carves sitting at paths a Mac will happily resolve. Bun folds
// process.platform at carve time, so a quaude built from one of those believes it runs
// on Linux and tells the user so (`quaude doctor` reporting `Platform: linux-x64`,
// 2026-09-04) — and has upstream's whole macOS credential store dead-coded away.
//
// The fix is a DERIVED key: the store path is a function of what the artifact IS
// (version x platform x arch), in the repo's one naming vocabulary
// (scripts/canonical-name.cjs), so a wrong-OS binary has nowhere to sit where a host
// would find it. Not "unlikely" — unrepresentable.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

// LITERAL relative requires, not require(path.join(REPO, ...)). test/forced-win32.cjs
// derives its file set by walking each test's relative-require closure and EXCLUDING any
// file that can reach the real operating system (child_process). This file drives the real
// clodeUpdate, which provisions a host sha256 tool by spawning -- so it belongs in that
// exclusion, and a computed require path would hide the dependency from the derivation that
// exists to see it. Measured: with the computed spelling, the forced-win32 pass swept this
// file in and its fetch case went red on a Mac with no Windows digest tool -- noise about
// the harness, not about Windows.
const { clodeUpdate } = require('../libexec/clode-update.cjs');
const current = require('../libexec/clode-current.cjs');
const paths = require('../libexec/clode-paths.cjs');

// --- container fixtures ------------------------------------------------------
// Minimal, REAL container headers: the store's key has to come from what the bytes say
// they are, the same way libexec/extract-claude-js.cjs's providerPlatformOf reads them.
// A fixture that merely claims a platform in its filename would test the claim, not the
// mechanism -- which is the exact failure this whole file is about.
function carve(kind, salt) {
  const b = Buffer.alloc(256);
  if (kind === 'linux-x64') {
    b.write('\x7fELF', 0, 'latin1');
    b[4] = 2; b[5] = 1; b[6] = 1; b[7] = 0;        // 64-bit, little-endian, SysV
    b.writeUInt16LE(0x3e, 18);                      // e_machine = EM_X86_64
  } else if (kind === 'linux-arm64') {
    b.write('\x7fELF', 0, 'latin1');
    b[4] = 2; b[5] = 1; b[6] = 1; b[7] = 0;
    b.writeUInt16LE(0xb7, 18);                      // EM_AARCH64
  } else if (kind === 'darwin-arm64') {
    b.writeUInt32BE(0xcffaedfe, 0);                 // MH_MAGIC_64, byte-swapped (LE host)
    b.writeUInt32LE(0x0100000c, 4);                 // CPU_TYPE_ARM64
  } else if (kind === 'darwin-x64') {
    b.writeUInt32BE(0xcffaedfe, 0);
    b.writeUInt32LE(0x01000007, 4);                 // CPU_TYPE_X86_64
  } else {
    throw new Error(`no fixture for ${kind}`);
  }
  b.write(String(salt || ''), 128, 'latin1');       // distinct bytes per platform
  return b;
}
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// A file:// releases fixture carrying SEVERAL platforms for ONE version, which is what
// upstream actually publishes and what the version-only key could not represent.
function releases(dir, version, platforms) {
  fs.mkdirSync(dir, { recursive: true });
  const entries = {};
  for (const [plat, body] of Object.entries(platforms)) {
    const pd = path.join(dir, version, plat);
    fs.mkdirSync(pd, { recursive: true });
    fs.writeFileSync(path.join(pd, 'claude'), body);
    entries[plat] = { checksum: sha256(body), binary: 'claude' };
  }
  fs.writeFileSync(path.join(dir, 'latest'), version + '\n');
  fs.writeFileSync(path.join(dir, version, 'manifest.json'), JSON.stringify({ platforms: entries }));
  return pathToFileURL(dir).href;
}

function sandbox(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'store-key-'));
  t.after(() => { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } });
  return d;
}
const devnull = { write() {} };

const V = '9.9.9';
const LINUX = carve('linux-x64', 'LINUX-CARVE');
const MAC = carve('darwin-arm64', 'DARWIN-CARVE');

// --- 1. the mechanism --------------------------------------------------------

test('two platforms of ONE version do not collide in the store', async (t) => {
  const d = sandbox(t);
  const base = releases(path.join(d, 'rel'), V, { 'linux-x64': LINUX, 'darwin-arm64': MAC });
  const env = { ...process.env, CLODE_STATE_ROOT: d, CLODE_RELEASES_URL: base, CLODE_PROVIDERS: '' };
  delete env.CLODE_PROVIDERS;

  assert.strictEqual(await clodeUpdate(V, { env: { ...env, CLODE_FETCH_PLATFORM: 'linux-x64' }, stderr: devnull }), 0);
  assert.strictEqual(await clodeUpdate(V, { env: { ...env, CLODE_FETCH_PLATFORM: 'darwin-arm64' }, stderr: devnull }), 0);

  // Every `claude` now in the store, with the bytes it actually holds.
  const store = paths.providersDir(env);
  const found = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, path.posix.join(rel, e.name));
      else if (e.name === 'claude') found.push([rel, fs.readFileSync(p)]);
    }
  };
  walk(store, '');

  assert.strictEqual(found.length, 2,
    `both carves must be on disk at once; found ${found.length}: ${found.map(([r]) => r).join(', ')}`);
  const bodies = found.map(([, b]) => sha256(b)).sort();
  assert.deepStrictEqual(bodies, [sha256(LINUX), sha256(MAC)].sort(),
    'the second fetch must fetch its OWN bytes, not re-point to the first target\'s');

  // And the PATH must say which is which, without opening the file.
  for (const [rel, body] of found) {
    const isMac = sha256(body) === sha256(MAC);
    assert.match(rel, isMac ? /macos-arm64/ : /linux-amd64/,
      `the store path must name what the artifact IS (got "${rel}")`);
    assert.ok(rel.includes(V), 'and still name the version');
  }
});

// --- 2. the consequence ------------------------------------------------------

test('a foreign carve at the current version is NOT served to this host', (t) => {
  const d = sandbox(t);
  const env = { CLODE_STATE_ROOT: d };
  const store = paths.providersDir(env);

  // The shape this box actually carries at 2.1.207/210/211/215/243: a LINUX carve at the
  // version-only path, with `current` pointing at the version. Written in the OLD layout
  // on purpose, so this test is RED before the fix (it resolved, and a quaude built from
  // it reported `Platform: linux-x64`) rather than vacuously green on a store shape that
  // did not exist yet.
  fs.mkdirSync(path.join(store, V), { recursive: true });
  fs.writeFileSync(path.join(store, V, 'claude'), LINUX, { mode: 0o755 });
  current.setCurrent(env, V);

  if (process.platform === 'linux') {
    t.skip('this host IS linux, so the linux carve is the RIGHT one here; the case needs a non-linux host');
    return;
  }
  assert.strictEqual(current.currentBin(env), null,
    'a carve for another OS must not be reachable as this host\'s current provider');
});

test("this host's own carve at the current version IS served", (t) => {
  const d = sandbox(t);
  const env = { CLODE_STATE_ROOT: d };
  const store = paths.providersDir(env);
  // A gate that cannot be passed says as little as one that cannot fail.
  const key = paths.providerKey(process.platform, process.arch);
  const mine = path.join(store, V, key);
  fs.mkdirSync(mine, { recursive: true });
  const bin = path.join(mine, 'claude');
  fs.writeFileSync(bin, carve(process.platform === 'darwin' ? 'darwin-arm64' : 'linux-x64', 'MINE'));
  current.setCurrent(env, V);
  assert.strictEqual(current.currentBin(env), bin);
});

test('a same-OS, other-ARCH carve is still served (arch is don\'t-care for a CARVE)', (t) => {
  // libexec/clode-update.cjs's providerFor() deliberately falls back to any same-OS
  // provider when the exact arch is absent, because Bun folds the OS branches and "the
  // sole arch-switch is moot". The store must not turn that documented fallback into a
  // permanent cache miss -- that would be a re-fetch loop, not a fix. What it must never
  // do is cross the OS boundary, which is the assertion above.
  const d = sandbox(t);
  const env = { CLODE_STATE_ROOT: d };
  const store = paths.providersDir(env);
  const { canonOsFromNode } = require('../scripts/canonical-name.cjs');
  const otherArch = process.arch === 'arm64' ? 'amd64' : 'arm64';
  const dir = path.join(store, V, `${canonOsFromNode(process.platform)}-${otherArch}`);
  fs.mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, 'claude');
  fs.writeFileSync(bin, carve(process.platform === 'darwin' ? 'darwin-x64' : 'linux-x64', 'OTHERARCH'));
  current.setCurrent(env, V);
  assert.strictEqual(current.currentBin(env), bin);
});

// --- 3. migration ------------------------------------------------------------
//
// Existing stores hold version-only entries. Leaving them readable would leave the bug;
// deleting them would throw away a ~250MB download that is usually CORRECT. So they are
// re-keyed in place from what the bytes say they are -- the same question
// providerPlatformOf already answers for the build's carve gate, plus the arch dimension
// read from the same container header. An entry whose container is unrecognizable cannot
// be given an honest key, so it is not given a dishonest one either: it is left where it
// is, where nothing resolves it.

test('a legacy version-only entry is re-keyed from its own bytes', (t) => {
  const d = sandbox(t);
  const env = { CLODE_STATE_ROOT: d };
  const store = paths.providersDir(env);
  fs.mkdirSync(path.join(store, V), { recursive: true });
  fs.writeFileSync(path.join(store, V, 'claude'), LINUX, { mode: 0o755 });
  current.setCurrent(env, V);

  const served = current.currentBin(env);
  const moved = path.join(store, V, 'linux-amd64', 'claude');
  assert.ok(fs.existsSync(moved), 'the legacy entry must be re-keyed by what it IS');
  assert.strictEqual(fs.readFileSync(moved).compare(LINUX), 0, 'byte-for-byte, no re-download');
  assert.ok(!fs.existsSync(path.join(store, V, 'claude')),
    'and the ambiguous path must be GONE, or the next reader finds it again');
  if (process.platform !== 'linux') {
    assert.strictEqual(served, null,
      'THE BUG: on a non-linux host this used to resolve, and a quaude built from it '
      + 'reported the wrong OS');
  }
});

test('a legacy entry for THIS host survives migration and is still served', (t) => {
  const d = sandbox(t);
  const env = { CLODE_STATE_ROOT: d };
  const store = paths.providersDir(env);
  fs.mkdirSync(path.join(store, V), { recursive: true });
  const body = carve(process.platform === 'darwin' ? 'darwin-arm64' : 'linux-x64', 'MINE');
  fs.writeFileSync(path.join(store, V, 'claude'), body, { mode: 0o755 });
  current.setCurrent(env, V);

  const served = current.currentBin(env);
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    t.skip(`no container fixture for ${process.platform}`);
    return;
  }
  assert.ok(served, 'a correct legacy binary must NOT cost the user a 250MB re-download');
  assert.strictEqual(fs.readFileSync(served).compare(body), 0);
  assert.ok(!fs.existsSync(path.join(store, V, 'claude')));
});

test('a legacy entry whose container is unreadable is left alone, not mis-keyed', (t) => {
  const d = sandbox(t);
  const env = { CLODE_STATE_ROOT: d };
  const store = paths.providersDir(env);
  fs.mkdirSync(path.join(store, V), { recursive: true });
  const junk = Buffer.from('#!/bin/sh\nnot a container at all\n');
  fs.writeFileSync(path.join(store, V, 'claude'), junk);
  current.setCurrent(env, V);

  assert.strictEqual(current.currentBin(env), null,
    'guessing a key for bytes we cannot identify is how the wrong binary gets served');
  assert.ok(fs.existsSync(path.join(store, V, 'claude')),
    'but it is not deleted either -- the user\'s bytes are the user\'s');
});
