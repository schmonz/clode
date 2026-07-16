const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { REPO, NODE } = require('./e2e.cjs');

// test_dist.bats: clode ships as an npm package. `npm pack` produces the installable
// tarball; verify it carries exactly what a runnable clode needs and nothing else, and
// that the packed launcher works. These tests drive the host packaging tools
// (npm/tar/git/grep) directly — NOT the hermetic launcher — so they inherit the real
// env (npm et al. live on the real PATH). npm pack is always run in (and its output
// destined for) a private tmp dir so it never litters the repo.

const VERSION = fs.readFileSync(path.join(REPO, 'VERSION'), 'utf8').trim();

// bats setup(): `command -v "$NPM" || NPM_SKIP`. If npm is not installed, the pack-based
// @tests skip.
function npmMissing() {
  const r = spawnSync('npm', ['--version'], { encoding: 'utf8' });
  return Boolean(r.error) || r.status !== 0;
}

// bats setup(): npm pack into a fresh mktempd PACKDIR, then LIST=tar tzf. Packs the repo
// package into a disposable tmp dir (cwd + destination both tmp) so nothing lands in the
// repo; cleanup registered on t.after (deterministic, no teardown race). Returns
// { tmp, tgz, list }.
function pack(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-dist-'));
  t.after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });
  spawnSync('npm', ['pack', REPO, '--pack-destination', tmp], { cwd: tmp, encoding: 'utf8' });
  const tgz = path.join(tmp, `clode-${VERSION}.tgz`);
  const list = spawnSync('tar', ['tzf', tgz], { encoding: 'utf8' }).stdout || '';
  return { tmp, tgz, list };
}

// @test "npm pack produces the package tarball"
test('npm pack produces the package tarball', (t) => {
  if (npmMissing()) { t.skip('npm not installed'); return; }
  const { tgz } = pack(t);
  assert.ok(fs.existsSync(tgz));   // test -f "$TGZ"
});

// @test "package ships the launcher, libexec helpers, manifest, version, man, license"
test('package ships the launcher, libexec helpers, manifest, version, man, license', (t) => {
  if (npmMissing()) { t.skip('npm not installed'); return; }
  const { list } = pack(t);
  const lines = list.split('\n');
  for (const f of [
    'bin/clode', 'libexec/bun-shim.cjs', 'libexec/extract-claude-js.cjs',
    'libexec/inspect-claude-bundle.cjs', 'package.json', 'VERSION', 'man/clode.1', 'LICENSE',
  ]) {
    // grep -q "^package/$f\$"
    assert.ok(lines.includes(`package/${f}`), `missing: ${f}`);
  }
});

// @test "the shipped runtime (bin + libexec) has no python"
test('the shipped runtime (bin + libexec) has no python', () => {
  const re = /python3?|CLODE_PYTHON/;
  const hits = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      try { if (re.test(fs.readFileSync(p, 'utf8'))) hits.push(p); } catch { /* binary/unreadable: skip */ }
    }
  };
  walk(path.join(REPO, 'bin'));
  walk(path.join(REPO, 'libexec'));
  assert.deepStrictEqual(hits, [], `python reference(s) in shipped runtime: ${hits.join(', ')}`);
});

// @test "the repo tracks no python files"
test('the repo tracks no python files', () => {
  // spike/ is exempt: non-production measurement tooling (qemu guest drivers)
  // that never ships; the invariant guards the product, not the evidence.
  const r = spawnSync('git', ['ls-files', '*.py', ':!spike/'], { cwd: REPO, encoding: 'utf8' });
  // ! git ls-files '*.py' ':!spike/' | grep -q .  → no tracked .py files outside spike/
  assert.strictEqual(r.stdout.trim(), '');
});

// @test "package excludes tests, build artifacts, and node_modules"
test('package excludes tests, build artifacts, and node_modules', (t) => {
  if (npmMissing()) { t.skip('npm not installed'); return; }
  const { list } = pack(t);
  // ! grep -qE 'package/(test/|Makefile|node_modules/)|cli\.cjs|/build/'
  assert.doesNotMatch(list, /package\/(test\/|Makefile|node_modules\/)|cli\.cjs|\/build\//);
});

// @test "the packed launcher runs and reports its version"
test('the packed launcher runs and reports its version', (t) => {
  if (npmMissing()) { t.skip('npm not installed'); return; }
  const { tmp, tgz } = pack(t);
  spawnSync('tar', ['xzf', tgz, '-C', tmp]);   // tar xzf "$TGZ" -C "$PACKDIR"
  const bin = path.join(tmp, 'package', 'bin', 'clode');
  const r = spawnSync(NODE, [bin, '--version'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0);                                       // [ "$status" -eq 0 ]
  assert.strictEqual(((r.stdout || '') + (r.stderr || '')).trim(), `clode ${VERSION}`); // [ "$output" = "clode $v" ]
});
