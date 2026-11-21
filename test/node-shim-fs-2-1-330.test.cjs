'use strict';
// fs answers node-shim-differential found diverging from node at the 2.1.330 pin (2026-11-21), judged here
// without a staged provider: the probe (test/fixtures/fs-2-1-330-probe.cjs) runs under host node and under
// quaude, and every field must be node's.
//   - fs.open(p, O_WRONLY|O_APPEND|O_CREAT, 0o600, cb) made the file 0644: the callback form dropped its mode.
//   - fs.utimesSync of a missing path returned as if it had worked; fs.lutimesSync did not exist.
//   - readdir errors said readdir (node: scandir); opendir's said readdir with a path (node: opendir, no path
//     from opendirSync, the path from the promise); opendir ignored { recursive }.
//   - the JS realpath walk's errors said realpath (node: lstat / stat); fs.promises.lstat() and mkdtemp() with
//     no argument took `undefined` as a path.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

const PROBE = path.join(__dirname, 'fixtures', 'fs-2-1-330-probe.cjs');
const scratch = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fs330-')));
const parse = (r, who) => {
  const m = /^FS330 (.*)$/m.exec(r.stdout || '');
  assert.ok(m, `${who} printed no FS330 line (status ${r.status}):\n${r.stderr}`);
  return JSON.parse(m[1]);
};

test('fs answers 2.1.330 reaches for, as node gives them', { skip: process.platform === 'win32' && 'POSIX modes and symlinks' }, (t) => {
  if (skipUnlessTjs(t)) return;
  const a = scratch(), b = scratch();
  try {
    const node = parse(spawnSync(process.execPath, [PROBE, a], { encoding: 'utf8', timeout: 30000 }), 'node');
    const ours = parse(runLoader(PROBE, [b]), 'quaude');
    // the fields that matter most, named so a failure says which
    assert.strictEqual(node.openMode, '600', 'node itself made the file 0600');
    assert.strictEqual(ours.openMode, '600', 'quaude must create the file 0600, as node does');
    assert.strictEqual(ours.openModeOnDisk, '600');
    assert.strictEqual(ours.lutimesSyncType, 'function');
    for (const k of Object.keys(node)) assert.deepStrictEqual(ours[k], node[k], `${k} differs from node`);
    assert.deepStrictEqual(Object.keys(ours).sort(), Object.keys(node).sort());
  } finally {
    fs.rmSync(a, { recursive: true, force: true });
    fs.rmSync(b, { recursive: true, force: true });
  }
});
