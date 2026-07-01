'use strict';
// Unit tests for the JS launcher entry: bin/clode.cjs (ES5-safe prologue) +
// libexec/clode-main.cjs (the dispatch spine). Covers the print-and-exit paths
// (--clode-version, --clode-help) and the prologue's old-node floor guard. The
// full DEFAULT-launch wiring is smoke-tested separately (see the task's fixture
// smoke); the FULL bats parity gate is the next task.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'bin', 'clode.cjs');
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

test('clodeHelp() interpolates the version and is newline-terminated', () => {
  const { clodeHelp } = require('../libexec/clode-main.cjs');
  const text = clodeHelp('9.9.9');
  assert.ok(text.startsWith('clode 9.9.9 — '));
  assert.ok(text.endsWith("Run 'clode --help' for Claude Code's own help.\n"));
  assert.match(text, /--clode-watch/);
});
