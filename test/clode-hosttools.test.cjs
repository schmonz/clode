'use strict';
// Unit tests for libexec/clode-hosttools.cjs — the JS port of bin/clode's
// host-tool discovery + node-floor enforcement.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  MIN_NODE_MAJOR,
  findTool,
  checkNodeVersion,
  requireNodeVersionOrExit,
} = require('../libexec/clode-hosttools.cjs');

// --- helpers ---------------------------------------------------------------
function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'clode-hosttools-'));
}
function makeExe(dir, name) {
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, '#!/bin/sh\necho hi\n');
  fs.chmodSync(p, 0o755);
  return p;
}

// --- findTool: override -> PATH-walk -> null --------------------------------
test('findTool returns the override when it is executable', () => {
  const dir = tmpdir();
  const rg = makeExe(dir, 'rg');
  assert.strictEqual(findTool('rg', { override: rg, env: { PATH: '' } }), rg);
});

test('findTool ignores a non-executable override and walks PATH', () => {
  const dir = tmpdir();
  const bad = path.join(dir, 'notexec'); // never created -> not executable
  const bindir = path.join(dir, 'bin');
  const rg = makeExe(bindir, 'rg');
  const found = findTool('rg', { override: bad, env: { PATH: bindir } });
  assert.strictEqual(found, rg);
});

test('findTool walks PATH in order and finds the first match', () => {
  const dir = tmpdir();
  const d1 = path.join(dir, 'a');
  const d2 = path.join(dir, 'b');
  const rg1 = makeExe(d1, 'rg');
  makeExe(d2, 'rg');
  const found = findTool('rg', { env: { PATH: [d1, d2].join(path.delimiter) } });
  assert.strictEqual(found, rg1);
});

test('findTool returns null when nothing is found', () => {
  const dir = tmpdir();
  assert.strictEqual(findTool('definitely-not-a-tool', { env: { PATH: dir } }), null);
});

// --- checkNodeVersion / requireNodeVersionOrExit ---------------------------
test('MIN_NODE_MAJOR matches the sh launcher floor (24)', () => {
  assert.strictEqual(MIN_NODE_MAJOR, 24);
});

test('checkNodeVersion accepts the running node', () => {
  const r = checkNodeVersion();
  assert.strictEqual(r.ok, true);
  assert.ok(r.major >= MIN_NODE_MAJOR);
});

test('checkNodeVersion rejects an old version', () => {
  const r = checkNodeVersion('18.19.0');
  assert.deepStrictEqual(r, { ok: false, major: 18 });
});

test('requireNodeVersionOrExit prints the EXACT too-old message and exits 1', () => {
  const lines = [];
  let code;
  requireNodeVersionOrExit({
    versionString: '18.19.0',
    stderr: { write: (s) => lines.push(s) },
    exit: (c) => { code = c; },
  });
  assert.strictEqual(code, 1);
  assert.strictEqual(lines[0], 'clode: node v18.19.0 is too old; need >= v24\n');
  assert.strictEqual(
    lines[1],
    "clode: (the extracted bundle uses newer JS, e.g. 'using' declarations)\n",
  );
});

test('requireNodeVersionOrExit prints the EXACT no-usable-node message and exits 1', () => {
  const lines = [];
  let code;
  requireNodeVersionOrExit({
    nodePath: '/no/such/node',
    isExec: () => false,
    stderr: { write: (s) => lines.push(s) },
    exit: (c) => { code = c; },
  });
  assert.strictEqual(code, 1);
  assert.strictEqual(lines[0], "clode: no usable node at '/no/such/node' (set CLODE_NODE)\n");
});

test('requireNodeVersionOrExit is a no-op (returns ok) for a good version', () => {
  const lines = [];
  let code;
  const r = requireNodeVersionOrExit({
    versionString: '24.6.0',
    stderr: { write: (s) => lines.push(s) },
    exit: (c) => { code = c; },
  });
  assert.strictEqual(code, undefined);
  assert.deepStrictEqual(lines, []);
  assert.strictEqual(r.ok, true);
});

