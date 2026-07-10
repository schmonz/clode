'use strict';
// process.env mutation characterization (Q1b item 1): the shim's env Proxy had
// no `set`/`deleteProperty` traps, so `process.env.X = v` silently no-oped in
// sloppy mode and THREW in strict mode ("'X' is read-only" — surfaced when the
// bundle runs as compiled-module bytecode, which is always strict). Node
// semantics, characterized against host node:
//   - an env write is visible to later reads in the SAME process;
//   - an env write propagates to a spawned CHILD's environment;
//   - `delete process.env.X` removes it (typeof -> undefined);
//   - values are stringified on write (Node coerces to string);
//   - all of the above hold under 'use strict'.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

const SNIPPET = `'use strict';
const { spawnSync } = require('node:child_process');
process.env.CLODE_ENV_TEST_X = 'from-parent';
const sameProcess = process.env.CLODE_ENV_TEST_X;
const child = spawnSync('/bin/sh', ['-c', 'printf %s "$CLODE_ENV_TEST_X"'], { encoding: 'utf8' });
process.env.CLODE_ENV_TEST_NUM = 42;           // Node coerces to '42'
const numType = typeof process.env.CLODE_ENV_TEST_NUM;
const numVal = process.env.CLODE_ENV_TEST_NUM;
delete process.env.CLODE_ENV_TEST_X;
const afterDelete = typeof process.env.CLODE_ENV_TEST_X;
const desc = Object.getOwnPropertyDescriptor(process.env, 'CLODE_ENV_TEST_NUM');
console.log(JSON.stringify({
  sameProcess,
  childSaw: child.stdout,
  numType,
  numVal,
  afterDelete,
  descWritable: desc && desc.writable,
}));
`;

test('process.env: writes/deletes match host node (same process, child env, strict mode)', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-envset-'));
  const f = path.join(dir, 'envset.cjs');
  fs.writeFileSync(f, SNIPPET);
  const nodeOut = execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim();
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), nodeOut);
});
