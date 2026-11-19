'use strict';
// scripts/cosmocc-pin.cjs: the cosmocc mirror list. Run 44460009323 went red because the
// cosmo leg had ONE source (cosmo.zip) and it refused the connection. These pin the
// three properties the fallback is worthless without: every mirror is verified against
// the SAME pinned sha256 (never trusted alone), each fallback is logged by mirror name,
// and all mirrors failing is a refusal naming every attempt. Driven through the REAL
// libexec/clode-net.cjs downloadFile/sha256Of with file:// mirrors, so no network.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const { defineGuard, guardTests } = require('./guard.cjs');

const REPO = path.resolve(__dirname, '..');
const pin = require('../scripts/cosmocc-pin.cjs');
const { downloadFile, sha256Of } = require('../libexec/clode-net.cjs');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cosmocc-pin-'));
  const good = path.join(dir, 'good.zip');
  const bad = path.join(dir, 'bad.zip');
  fs.writeFileSync(good, 'the real toolchain');
  fs.writeFileSync(bad, 'a mirror serving something else');
  const sha = crypto.createHash('sha256').update('the real toolchain').digest('hex');
  return {
    dir, sha, dest: path.join(dir, 'out', 'cosmocc.zip'),
    good: { name: 'good-mirror', url: pathToFileURL(good).href },
    bad: { name: 'wrong-bytes-mirror', url: pathToFileURL(bad).href },
    dead: { name: 'dead-mirror', url: pathToFileURL(path.join(dir, 'absent.zip')).href },
  };
}

async function fetch(f, mirrors) {
  fs.mkdirSync(path.dirname(f.dest), { recursive: true });
  const lines = [];
  const used = await pin.fetchVerified({ mirrors, sha256: f.sha, dest: f.dest, downloadFile, sha256Of, log: (l) => lines.push(l) });
  return { used, lines };
}

test('the first verified mirror wins and nothing after it is fetched', async () => {
  const f = fixture();
  const { used, lines } = await fetch(f, [f.good, f.dead]);
  assert.strictEqual(used, 'good-mirror');
  assert.strictEqual(sha256Of(f.dest), f.sha);
  assert.ok(!lines.some((l) => l.includes('dead-mirror')), lines.join('\n'));
});

test('an unreachable mirror falls back, and the fallback is logged by name with the reason', async () => {
  const f = fixture();
  const { used, lines } = await fetch(f, [f.dead, f.good]);
  assert.strictEqual(used, 'good-mirror');
  const fb = lines.find((l) => l.includes('falling back to mirror good-mirror'));
  assert.ok(fb, lines.join('\n'));
  assert.match(fb, /dead-mirror/);
});

test('a mirror serving other bytes is NOT trusted: sha mismatch falls back, never lands at dest', async () => {
  const f = fixture();
  const { used, lines } = await fetch(f, [f.bad, f.good]);
  assert.strictEqual(used, 'good-mirror');
  assert.strictEqual(sha256Of(f.dest), f.sha);
  assert.ok(lines.some((l) => /wrong-bytes-mirror: sha256 mismatch/.test(l)), lines.join('\n'));
});

test('every mirror failing is an honest refusal naming each attempt, and leaves no zip behind', async () => {
  const f = fixture();
  await assert.rejects(fetch(f, [f.dead, f.bad]), (e) => {
    assert.match(e.message, /every cosmocc mirror failed/);
    assert.match(e.message, /dead-mirror/);
    assert.match(e.message, /wrong-bytes-mirror: sha256 mismatch/);
    return true;
  });
  assert.ok(!fs.existsSync(f.dest), 'an unverified zip reached the final name');
  assert.ok(!fs.existsSync(`${f.dest}.part`), 'a partial was left behind');
});

test('the shipped mirror list: >1 mirror, all https, all the same pinned zip name', () => {
  assert.ok(pin.COSMOCC_MIRRORS.length >= 2, 'one mirror is a single point of failure (run 44460009323)');
  for (const m of pin.COSMOCC_MIRRORS) {
    assert.match(m.url, /^https:\/\//);
    assert.ok(m.url.endsWith(`/${pin.COSMOCC_ZIP}`), m.url);
    assert.ok(m.name, 'every mirror needs a name for the fallback log');
  }
  assert.strictEqual(new Set(pin.COSMOCC_MIRRORS.map((m) => m.name)).size, pin.COSMOCC_MIRRORS.length);
  assert.match(pin.COSMOCC_SHA256, /^[0-9a-f]{64}$/);
});

// The CI cache key is DERIVED: it used to be the literal `cosmocc-4.0.2` in YAML, a
// second copy of the pin a bump could leave behind.
test('the extract dir is keyed by version AND sha', () => {
  assert.strictEqual(pin.extractDirName(), `${pin.COSMOCC_VERSION}-${pin.COSMOCC_SHA256.slice(0, 16)}`);
});

test('the cache-key CLI answers the module\'s key, and the key names version AND sha', () => {
  const key = execFileSync(process.execPath, [path.join(REPO, 'scripts/cosmocc-pin.cjs'), 'cache-key'], { encoding: 'utf8' }).trim();
  assert.strictEqual(key, pin.cacheKey());
  assert.ok(key.startsWith(`cosmocc-${pin.COSMOCC_VERSION}-${pin.COSMOCC_SHA256.slice(0, 16)}`), key);
});

function scanCosmoccWiring({ action, buildTjs }) {
  const findings = [];
  const checks = [
    [/node scripts\/cosmocc-pin\.cjs cache-key/.test(action), 'build-leg action does not derive the cosmocc key from scripts/cosmocc-pin.cjs'],
    [/key: \$\{\{ steps\.cosmocc-pin\.outputs\.key \}\}/.test(action), 'the cosmocc cache step is not keyed on steps.cosmocc-pin.outputs.key'],
    [!/key:\s*cosmocc-\d/.test(action), 'a literal cosmocc cache key is back in the build-leg action'],
    [!/COSMOCC_SHA256\s*=/.test(buildTjs), 'scripts/build-tjs.cjs re-declares the cosmocc pin instead of requiring cosmocc-pin.cjs'],
    // A failing $(...) inside `echo` is swallowed under bash -e and writes an EMPTY key.
    [/KEY="\$\(node scripts\/cosmocc-pin\.cjs cache-key\)"/.test(action), 'the cosmocc key is not assigned before use (a failing derivation would not fail the step)'],
    // The extracted tree is reused unverified, so it must be named by the sha.
    [/cosmoccExtractDirName\(\)/.test(buildTjs) && !/'cosmocc', COSMOCC_VERSION\)/.test(buildTjs),
      'the extracted cosmocc dir is keyed by version alone (a re-pin would reuse old, unverified bytes)'],
  ];
  for (const [ok, why] of checks) if (!ok) findings.push(why);
  return { findings, examined: checks.length };
}

const cosmoccWiringGuard = defineGuard({
  name: 'cosmocc-cache-key-derived',
  read: () => ({
    action: fs.readFileSync(path.join(REPO, '.github/actions/build-leg/action.yml'), 'utf8'),
    buildTjs: fs.readFileSync(path.join(REPO, 'scripts/build-tjs.cjs'), 'utf8'),
  }),
  scan: scanCosmoccWiring,
  floor: 6,
  // The exact shape run 44460009323 ran with: a literal key, and the pin declared in build-tjs.
  control: () => ({
    action: '      with:\n        path: ~/.cache/clode/cosmocc\n        key: cosmocc-4.0.2\n',
    buildTjs: "const COSMOCC_SHA256 = '85b8';\nconst dir = path.join(cacheRoot, 'cosmocc', COSMOCC_VERSION);\n",
  }),
});
guardTests(cosmoccWiringGuard);
