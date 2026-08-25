'use strict';
// scripts/find-provider.mjs — locating the Bun provider binary CI oracles diff against.
//
// This replaced a find(1) one-liner copy-pasted at six sites in ci.yml. Two things
// were wrong with it, and both are pinned here:
//
//  1. It could kill its own step SILENTLY. Under `set -euo pipefail`, `find` on a
//     missing directory exits non-zero, pipefail carries that past `head`, set -e
//     ends the step AT THE ASSIGNMENT — so the `if [ -z "$PROV" ]` error below it
//     never ran, and `2>/dev/null` had eaten the only clue. node-shim-oracle did
//     exactly this in run 32622574608 after moving into an alpine container:
//     nothing printed after "tjs alive", exit 1.
//  2. It searched only INSIDE the wrapper package, which is npm's layout choice
//     rather than a contract.
//
// And one the replacement introduced, caught by running it rather than reading it:
// the wrapper ships `bin/claude.exe`, which is BIGGER than the darwin binary, so
// "largest match wins" handed a Windows PE to a darwin oracle.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '../scripts/find-provider.mjs');
const BIG = 21 * 1024 * 1024;

// ASK npm where the global root is, do not assume it. On POSIX a prefix means
// <prefix>/lib/node_modules; on Windows it is <prefix>/node_modules. Hardcoding
// the POSIX shape made these rows pass on darwin/linux and fail on
// windows-latest — the shipped script was fine (it runs `npm root -g`), the
// FIXTURE was wrong, which is the same "the test encoded an assumption about the
// host it was written on" mistake as the CRLF and PATH ones.
function globalRootFor(prefix) {
  const { npmCliPath } = require('../scripts/lib/npm-cli.cjs');
  const r = spawnSync(process.execPath, [npmCliPath({ prefix: 'find-provider-test' }), 'root', '-g'], {
    encoding: 'utf8', env: { ...process.env, npm_config_prefix: prefix },
  });
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  // Fall back to npm's documented layout rather than guessing one shape.
  return process.platform === 'win32'
    ? path.join(prefix, 'node_modules')
    : path.join(prefix, 'lib', 'node_modules');
}

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'findprov-'));
  const root = globalRootFor(dir);
  for (const [rel, size] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, Buffer.alloc(size));
  }
  return dir;
}

const run = (prefix) => spawnSync(process.execPath, [SCRIPT], {
  encoding: 'utf8', env: { ...process.env, npm_config_prefix: prefix },
});
// The script returns a NATIVE path, so on Windows it is backslash-separated.
// Comparing it against a literal containing '/' made these rows fail there —
// the same separator assumption the shipped code was fixed for, made again in
// the assertion. Normalise before matching.
const slash = (p) => p.replace(/\\/g, '/');

const arch = process.arch;
const plat = process.platform;
const pkg = `@anthropic-ai/claude-code-${plat}-${arch}`;
const exe = plat === 'win32' ? 'claude.exe' : 'claude';

test('prefers the platform package over a bigger wrong-platform binary', () => {
  // The real layout: the wrapper carries bin/claude.exe AND nests the platform
  // package. On darwin the .exe is the larger file.
  const dir = fixture({
    '@anthropic-ai/claude-code/bin/claude.exe': BIG + 5_000_000,
    [`@anthropic-ai/claude-code/node_modules/${pkg}/${exe}`]: BIG,
  });
  const r = run(dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(slash(r.stdout.trim()).includes(pkg),
    `must choose the package for THIS platform, not the biggest file (got ${r.stdout.trim()})`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('finds a sibling install, not only a nested one', () => {
  const dir = fixture({ [`${pkg}/${exe}`]: BIG });
  const r = run(dir);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(slash(r.stdout.trim()).includes(pkg), `got ${r.stdout.trim()}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('ignores files under the size floor (a launcher script is not the bundle)', () => {
  const dir = fixture({ [`${pkg}/${exe}`]: 4096 });
  const r = run(dir);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /no Bun provider binary found/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// The whole point: when it cannot find one, it must say what it looked at.
test('a missing global root fails LOUDLY, naming the root', () => {
  const r = run(path.join(os.tmpdir(), 'findprov-does-not-exist-' + Date.now()));
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /the npm global root does not exist/);
  assert.match(r.stderr, /SAME environment/, 'must point at the container-vs-host trap');
  assert.strictEqual(r.stdout, '', 'nothing on stdout, so a caller cannot use a partial answer');
});

test('an empty scope reports the root, the scope contents, and what it wanted', () => {
  const dir = fixture({ 'some-other-pkg/index.js': 10 });
  const r = run(dir);
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /npm root -g:/);
  assert.match(r.stderr, /@anthropic-ai\/:\s+\(absent\)/);
  assert.match(r.stderr, /wanted:/);
  assert.match(r.stderr, /optional dependency/i, 'must explain WHY it can be legitimately absent');
  fs.rmSync(dir, { recursive: true, force: true });
});

// EVERY provider lookup, not just ci.yml's. The first version of this test checked
// ci.yml alone, so .github/actions/build-leg/action.yml kept four hand-rolled
// `find … | head -1` lookups — and when 2.1.243 shipped bin/claude.exe inside the
// wrapper, the walk yielded that Windows binary first and EVERY Linux and macOS leg
// died in extraction. A ratchet that covers one file is a ratchet with a hole.
//
// IT NOW PINS THE POLICY, NOT JUST THE SCRIPT (2026-08-25). Counting uses of
// find-provider could not see the defect that actually shipped: minimising ran on
// three legs through two call sites with OPPOSITE failure policies, so the same
// breakage was swallowed on riscv64/s390x and fatal on netbsd-sparc — three hours into
// the slowest job in the matrix. The user: "I would like it to apply equally to all
// platforms unless there's a specific good reason not to."
//
// So: BUILDING stages through scripts/stage-provider.mjs (resolve + minimise, one
// failure policy). INSPECTING uses find-provider.mjs directly, because the minimiser
// deliberately drops what inspection reports on (measured: real provider
// embedded_assets=16 napi=8; minimised 0/0). The exception is about PURPOSE, and the
// allow-list below is the only place it is allowed to be about a FILE.
const INSPECTION_ONLY = new Set(['workflows/upstream-drift.yml']);

test('every provider lookup in .github goes through the right one of the two', () => {
  const root = path.resolve(__dirname, '..', '.github');
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.ya?ml$/.test(e.name)) files.push(p);
    }
  })(root);

  const handRolled = [], unstaged = [], direct = [];
  let staged = 0;
  for (const f of files) {
    const rel = path.relative(root, f).split(path.sep).join('/');
    const y = fs.readFileSync(f, 'utf8');
    if (/find "\$\(npm root -g\)/.test(y)) handRolled.push(rel);
    const finds = (y.match(/scripts\/find-provider\.mjs/g) || []).length;
    staged += (y.match(/scripts\/stage-provider\.mjs/g) || []).length;
    if (finds && !INSPECTION_ONLY.has(rel)) unstaged.push(`${rel} (${finds})`);
    // A build path must never reach the minimiser itself: that is how two call sites
    // acquired two different opinions about whether its failure mattered.
    if (/scripts\/make-min-provider\.cjs/.test(y)) direct.push(rel);
  }

  assert.deepStrictEqual(handRolled, [],
    'hand-rolled find(1) provider lookups are back — they pick whatever the directory '
    + 'walk yields first, which upstream can change without telling us');
  assert.deepStrictEqual(unstaged, [],
    'a BUILD path calls find-provider.mjs directly, so it skips minimising and this '
    + 'platform is now a special case. Use scripts/stage-provider.mjs, or add the file '
    + 'to INSPECTION_ONLY with a written reason about PURPOSE, not about the platform');
  assert.deepStrictEqual(direct, [],
    'a workflow calls make-min-provider.cjs directly. Go through stage-provider.mjs so '
    + 'there is ONE failure policy — two call sites disagreeing about whether an error '
    + 'matters is the same defect as two implementations');
  assert.ok(staged >= 15,
    `expected staged provider lookups at every build site, found ${staged}`);
});

// The declared exception must stay REAL. If the minimiser ever stopped dropping
// embedded assets, INSPECTION_ONLY would be cargo — an exemption nobody re-checked,
// which is the same shape as the openindiana-by-name exemption and the two hardcoded
// leg names. This asserts the exception still has a reason, from the file itself.
test('the inspection exception names a reason, and the reason is about purpose', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'scripts', 'stage-provider.mjs'), 'utf8');
  assert.match(src, /INSPECTS/, 'stage-provider must say what the exception is FOR');
  assert.match(src, /embedded_assets/, 'and cite the measurement that makes it real');
  for (const rel of INSPECTION_ONLY) {
    const y = fs.readFileSync(path.resolve(__dirname, '..', '.github', rel), 'utf8');
    assert.match(y, /scripts\/find-provider\.mjs/,
      `${rel} is exempted from staging but no longer looks up a provider at all — `
      + 'drop it from INSPECTION_ONLY rather than leaving a stale exemption');
  }
});
