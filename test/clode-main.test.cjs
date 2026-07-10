'use strict';
// Unit tests for the JS launcher entry: bin/clode (ES5-safe prologue) +
// libexec/clode-main.cjs (the dispatch spine). Covers the print-and-exit paths
// (--clode-version, --clode-help) and the prologue's old-node floor guard. The
// full DEFAULT-launch wiring is smoke-tested separately (see the task's fixture
// smoke); the FULL bats parity gate runs against this same entry.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'bin', 'clode');
const NODE = process.execPath;
const VERSION = fs.readFileSync(path.join(ROOT, 'VERSION'), 'utf8').replace(/\n+$/, '');

// Run the entry under the current node with a clean-ish env (empty
// DYLD_INSERT_LIBRARIES so the AVX shim never crashes a spawned node on old Macs).
function runEntry(args, extraEnv) {
  return spawnSync(NODE, [ENTRY, ...args], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { DYLD_INSERT_LIBRARIES: '' }, extraEnv || {}),
  });
}

test('--clode-version prints "clode <VERSION>" from the VERSION file and exits 0', () => {
  const r = runEntry(['--clode-version']);
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, `clode ${VERSION}\n`);
  assert.strictEqual(r.stderr, '');
});

test('--clode-help prints clode-specific options and exits 0', () => {
  const r = runEntry(['--clode-help']);
  assert.strictEqual(r.status, 0);
  assert.match(r.stdout, /--clode-watch/);
  assert.match(r.stdout, /--clode-verbose/);
  assert.match(r.stdout, /--clode-version/);
  assert.match(r.stdout, /run the latest Claude Code under a host Node/);
  assert.match(r.stdout, new RegExp(`clode ${VERSION.replace(/\./g, '\\.')} —`));
  // ends with the passthrough hint line + trailing newline
  assert.ok(r.stdout.endsWith("Run 'clode --help' for Claude Code's own help.\n"));
});

test('--clode-help is dispatched before any arg that merely contains the text', () => {
  // A prompt containing "--clode-help" but not as the first arg must NOT trigger
  // clode's help (that would be a real session). We only assert the FIRST-arg
  // gate here by checking a non-first occurrence is not the version/help path:
  // run with no bin resolvable so it hits the default-launch bin error, proving
  // it did not short-circuit on the embedded flag.
  const r = runEntry(['-p', 'explain --clode-help'], {
    HOME: fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'clode-nohome-')),
    CLODE_CLAUDE_BIN: '',
    CLODE_VERSION_DIR: '',
    PATH: '/nonexistent',
  });
  // No clode help on stdout; it went down the launch path and failed to find a bin.
  assert.doesNotMatch(r.stdout || '', /--clode-watch/);
  assert.match(r.stderr || '', /no Claude Code binary found|claude binary not found|too old|no usable node/);
});

test('the ES5 prologue prints the exact floor message + exits 1 on an old node', () => {
  // Fake an old node by redefining process.versions.node BEFORE requiring the
  // entry, so the prologue's own floor check trips (the entry is required, not
  // spawned, so the fake version is in effect at prologue-eval time).
  const harness =
    "Object.defineProperty(process.versions,'node',{value:'18.0.0',configurable:true});" +
    `require(${JSON.stringify(ENTRY)});`;
  const r = spawnSync(NODE, ['-e', harness], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { DYLD_INSERT_LIBRARIES: '' }),
  });
  assert.strictEqual(r.status, 1);
  assert.strictEqual(
    r.stderr,
    'clode: node v18.0.0 is too old; need >= v24\n' +
    "clode: (the extracted bundle uses newer JS, e.g. 'using' declarations)\n");
  assert.strictEqual(r.stdout, '');
});

test('the prologue floor relaxes to v20 for `clode build` (fuse runs under tjs, not node)', () => {
  // `clode build` never runs the extracted bundle under node — the fuse
  // worker and the fused artifacts exec under tjs; node only orchestrates
  // file work. OpenIndiana packages node 20 and OpenBSD 7.9 node 22 (matrix
  // legs, dispatches #6/#14 2026-07-10) — the build path must clear the
  // prologue on both. CLODE_TJS points at a nonexistent template so the run
  // fails FAST and CONTROLLED after the gate (proof it got past the check).
  const harness =
    "Object.defineProperty(process.versions,'node',{value:'20.0.0',configurable:true});" +
    "process.argv=[process.argv[0],'clode','build'];" +
    `require(${JSON.stringify(ENTRY)});`;
  const r = spawnSync(NODE, ['-e', harness], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, {
      DYLD_INSERT_LIBRARIES: '',
      CLODE_TJS: '/nonexistent/clode-test-tjs-template',
    }),
  });
  assert.strictEqual(r.status, 1);
  assert.doesNotMatch(r.stderr || '', /too old/);
  assert.match(r.stderr || '', /no tjs template at/);
});

test('the prologue keeps a floor for `clode build` too — v18 is refused', () => {
  const harness =
    "Object.defineProperty(process.versions,'node',{value:'18.19.0',configurable:true});" +
    "process.argv=[process.argv[0],'clode','build'];" +
    `require(${JSON.stringify(ENTRY)});`;
  const r = spawnSync(NODE, ['-e', harness], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { DYLD_INSERT_LIBRARIES: '' }),
  });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr || '', /node v18\.19\.0 is too old; need >= v20/);
});

test('clodeHelp() interpolates the version and is newline-terminated', () => {
  const { clodeHelp } = require('../libexec/clode-main.cjs');
  const text = clodeHelp('9.9.9');
  assert.ok(text.startsWith('clode 9.9.9 — '));
  assert.ok(text.endsWith("Run 'clode --help' for Claude Code's own help.\n"));
  assert.match(text, /--clode-watch/);
});
