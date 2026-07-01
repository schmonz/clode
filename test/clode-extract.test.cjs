'use strict';
// Unit tests for libexec/clode-extract.cjs — the JS port of bin/clode's
// extract_if_needed (in-process extract-on-change caching). Mirrors the sh-side
// coverage in test/test_selfupdate.bats (miss/hit/provider-upgrade/shim-refresh)
// and test/test_keying.bats (extractor-sig change re-extracts an unchanged binary).
// Real "bundle" fixtures come from test/mkfixture.cjs.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { extractIfNeeded } = require('../libexec/clode-extract.cjs');

const REPO = path.resolve(__dirname, '..');
const NODE = process.env.CLODE_NODE || process.execPath;

// A scenario: a temp libexec (copy of the real one so extract-claude-js.cjs +
// bun-shim.cjs are present and editable without touching the shipped tree), a
// synthetic provider binary, and a per-key cache dir.
function setup(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-extract-'));
  const libexec = path.join(root, 'libexec');
  fs.cpSync(path.join(REPO, 'libexec'), libexec, { recursive: true });
  const bin = path.join(root, 'claude');
  execFileSync(NODE, [path.join(REPO, 'test', 'mkfixture.cjs'), bin, label]);
  const cacheDir = path.join(root, 'cache', 'KEY');
  return { root, libexec, bin, cacheDir };
}

function cleanup(s) { fs.rmSync(s.root, { recursive: true, force: true }); }

// Capture the (verbose-gated) clode_log lines so a re-extract vs cache-hit is
// observable the way the bats suite reads clode's chatter.
function run(s, extra = {}) {
  const logs = [];
  extractIfNeeded({
    bin: s.bin, cacheDir: s.cacheDir, libexec: s.libexec, node: NODE,
    verbose: true, log: (m) => logs.push(m), ...extra,
  });
  return logs;
}

function boot(cacheDir) {
  return spawnSync(NODE, [path.join(cacheDir, 'cli.cjs')], { encoding: 'utf8' });
}

test('first call: cache miss extracts cli.cjs + shim + sig, and boots the fixture', () => {
  const s = setup('v1');
  try {
    const logs = run(s);
    assert.ok(fs.existsSync(path.join(s.cacheDir, 'cli.cjs')), 'cli.cjs written');
    assert.ok(fs.existsSync(path.join(s.cacheDir, 'bun-shim.cjs')), 'shim copied');
    assert.ok(fs.existsSync(path.join(s.cacheDir, '.extractor-sig')), 'sig written');
    assert.ok(logs.some((l) => l.includes('extracting JS')), 'logged extract');
    assert.ok(!logs.some((l) => l.includes('re-extracting')), 'not a re-extract');
    const r = boot(s.cacheDir);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /CLODE-FIXTURE v1/);
  } finally { cleanup(s); }
});

test('second call, unchanged: cache hit, no re-extract', () => {
  const s = setup('v1');
  try {
    run(s); // warm
    const cli = path.join(s.cacheDir, 'cli.cjs');
    const mtime = fs.statSync(cli).mtimeMs;
    const logs = run(s);
    assert.ok(!logs.some((l) => l.includes('extracting JS')), 'no extract log');
    assert.strictEqual(fs.statSync(cli).mtimeMs, mtime, 'cli.cjs untouched');
  } finally { cleanup(s); }
});

test('provider upgrade (new binary sig via new key) re-extracts to the new label', () => {
  const s = setup('v1');
  try {
    run(s); // warm v1
    // A provider upgrade lands in a NEW cache key dir (the sh keys off the binary);
    // rewrite the fixture and extract into a fresh cacheDir.
    execFileSync(NODE, [path.join(REPO, 'test', 'mkfixture.cjs'), s.bin, 'v2-updated']);
    s.cacheDir = path.join(s.root, 'cache', 'KEY2');
    run(s);
    const r = boot(s.cacheDir);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /CLODE-FIXTURE v2-updated/);
  } finally { cleanup(s); }
});

test('changed extractor-sig re-extracts even with an unchanged binary', () => {
  const s = setup('v1');
  try {
    run(s); // warm; writes .extractor-sig
    // Unchanged extractor -> cache hit, no re-extract.
    let logs = run(s);
    assert.ok(!logs.some((l) => l.includes('extracting JS')), 'cache hit');
    // Change the extractor file's size/mtime -> sig differs -> must re-extract.
    fs.appendFileSync(path.join(s.libexec, 'extract-claude-js.cjs'), '\n// clode-test touch\n');
    logs = run(s);
    assert.ok(logs.some((l) => l.includes('re-extracting JS')), 're-extract logged');
    // .extractor-sig now reflects the changed extractor.
    const { sigOf } = require('../libexec/clode-resolve.cjs');
    const newSig = sigOf(path.join(s.libexec, 'extract-claude-js.cjs'));
    const stored = fs.readFileSync(path.join(s.cacheDir, '.extractor-sig'), 'utf8').trim();
    assert.strictEqual(stored, newSig);
  } finally { cleanup(s); }
});

test('changed shim: cache hit but the cached bun-shim is refreshed from source', () => {
  const s = setup('v1');
  try {
    run(s); // warm
    const cli = path.join(s.cacheDir, 'cli.cjs');
    const cliMtime = fs.statSync(cli).mtimeMs;
    // Simulate a stale cached shim.
    const cached = path.join(s.cacheDir, 'bun-shim.cjs');
    fs.writeFileSync(cached, 'STALE-SHIM\n');
    const logs = run(s);
    assert.ok(logs.some((l) => l.includes('refreshed cached bun-shim')), 'shim refreshed');
    assert.ok(!logs.some((l) => l.includes('extracting JS')), 'not re-extracted');
    // The cached shim matches source again, and cli.cjs was left alone.
    const src = fs.readFileSync(path.join(s.libexec, 'bun-shim.cjs'));
    assert.ok(fs.readFileSync(cached).equals(src), 'cached shim == source');
    assert.strictEqual(fs.statSync(cli).mtimeMs, cliMtime, 'cli.cjs untouched');
  } finally { cleanup(s); }
});

test('loud failure: a non-bundle binary throws and does not cache cli.cjs', () => {
  const s = setup('v1');
  try {
    // A file with no @bun-cjs marker: pickEntry/verify path fails.
    fs.writeFileSync(s.bin, 'not a bundle');
    assert.throws(() => run(s));
    assert.ok(!fs.existsSync(path.join(s.cacheDir, 'cli.cjs')), 'no cli.cjs cached');
  } finally { cleanup(s); }
});
