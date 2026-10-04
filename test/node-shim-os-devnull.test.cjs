'use strict';
// os.devNull under quaude, judged against host node, and every os export node has. node-shim's os
// had no devNull. The 2.1.283 bundle's dirSync stamps a special file by asking whether it is the
// null device: `stat(os.devNull, { bigint: true })` and an rdev comparison (M8). With devNull
// undefined that stat failed, so /dev/null and /dev/zero were both "could not tell it from the
// null device" (undigested), where native stamps /dev/null as the null device and /dev/zero as a
// special file. Found by driving M8 through the real 2.1.283 graph (grep-native, ruling G18).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

const PROG = `
const os = require('node:os');
console.log(JSON.stringify({ devNull: os.devNull, keys: Object.keys(os).filter((k) => !k.startsWith('__')).sort() }));
`;

test("os.devNull, and every export of node's os, exists under quaude as under host node", async (t) => {
  if (skipUnlessTjs(t)) return;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-os-devnull-'));
  try {
    const prog = path.join(base, 'prog.cjs');
    fs.writeFileSync(prog, PROG);
    const node = JSON.parse(execFileSync(process.execPath, [prog], { encoding: 'utf8' }).trim());
    assert.strictEqual(typeof node.devNull, 'string', 'the oracle must have a devNull');
    const r = runLoader(prog, [], { timeout: 30000 });
    assert.strictEqual(r.status, 0, r.stderr);
    const ours = JSON.parse(r.stdout.trim());
    assert.strictEqual(ours.devNull, node.devNull);
    assert.deepStrictEqual(node.keys.filter((k) => !ours.keys.includes(k)), [], 'os exports node has and quaude lacks');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
