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
test('every provider lookup in .github goes through this script', () => {
  const root = path.resolve(__dirname, '..', '.github');
  const files = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.ya?ml$/.test(e.name)) files.push(p);
    }
  })(root);
  const offenders = [];
  let uses = 0;
  for (const f of files) {
    const y = fs.readFileSync(f, 'utf8');
    uses += (y.match(/scripts\/find-provider\.mjs/g) || []).length;
    if (/find "\$\(npm root -g\)/.test(y)) offenders.push(path.relative(root, f));
  }
  assert.deepStrictEqual(offenders, [],
    'hand-rolled find(1) provider lookups are back — they pick whatever the directory '
    + 'walk yields first, which upstream can change without telling us');
  assert.ok(uses >= 9, `expected the shared finder at every provider site, found ${uses}`);
});
