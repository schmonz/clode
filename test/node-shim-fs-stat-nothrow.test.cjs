'use strict';
// fs.statSync / lstatSync `{ throwIfNoEntry: false }` under quaude, judged against host node. node-shim
// ignored the option and threw ENOENT where node returns undefined. The 2.1.283 bundle asks this at
// nine call sites; one inverts its answer on a throw (`try { return g(e, { throwIfNoEntry: !1 }) ===
// void 0 } catch { return !1 }`: "absent" read as "present"), and one in the permission deny path calls
// it outside any try, so the throw escapes. node's own rule is narrower than "any error": every stat
// form (sync, promise, callback) answers undefined for ENOENT and ENOTDIR, lstatSync for ENOENT only,
// and the promise and callback lstat ignore the option. Every answer here comes from node on this box; the test asserts the oracle
// actually shows the undefined (else it judges nothing).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

const PROG = `
const fs = require('node:fs'), path = require('node:path');
const dir = process.argv[2];
const paths = { file: path.join(dir, 'file.txt'), missing: path.join(dir, 'missing'),
  'under-a-file': path.join(dir, 'file.txt', 'x'), 'missing-parent': path.join(dir, 'nope', 'x') };
const OPTS = { none: undefined, 'nothrow': { throwIfNoEntry: false }, 'nothrow-bigint': { throwIfNoEntry: false, bigint: true },
  'throw': { throwIfNoEntry: true }, 'bigint': { bigint: true } };
const what = (v) => v === undefined ? 'undefined' : Object.getPrototypeOf(v).constructor.name;
const out = {};
(async () => {
  for (const [pn, p] of Object.entries(paths)) {
    for (const [on, o] of Object.entries(OPTS)) {
      for (const f of ['statSync', 'lstatSync']) {
        try { out[[pn, on, f].join(' ')] = what(fs[f](p, o)); } catch (e) { out[[pn, on, f].join(' ')] = 'throws ' + e.code; }
      }
      for (const f of ['stat', 'lstat']) {
        try { out[[pn, on, 'promises.' + f].join(' ')] = what(await fs.promises[f](p, o)); }
        catch (e) { out[[pn, on, 'promises.' + f].join(' ')] = 'rejects ' + e.code; }
        out[[pn, on, f + '-cb'].join(' ')] = await new Promise((res) => {
          const done = (e, s) => res(e ? 'error ' + e.code : what(s));
          if (o) fs[f](p, o, done); else fs[f](p, done);
        });
      }
    }
  }
  console.log(JSON.stringify(out));
})();
`;

test('statSync/lstatSync honour { throwIfNoEntry: false } exactly as host node does', async (t) => {
  if (skipUnlessTjs(t)) return;
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shim-stat-nothrow-')));
  try {
    const prog = path.join(base, 'prog.cjs');
    fs.writeFileSync(prog, PROG);
    const dir = path.join(base, 'd');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'file.txt'), 'x\n');
    const node = JSON.parse(execFileSync(process.execPath, [prog, dir], { encoding: 'utf8', timeout: 30000 }).trim());
    assert.strictEqual(node['missing nothrow statSync'], 'undefined', 'the oracle must show the undefined');
    assert.strictEqual(node['missing nothrow-bigint lstatSync'], 'undefined');
    assert.strictEqual(node['missing none statSync'], 'throws ENOENT');
    const r = runLoader(prog, [dir], { timeout: 60000 });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(r.stdout.trim(), `quaude printed nothing: ${r.stderr}`);
    const ours = JSON.parse(r.stdout.trim());
    const diffs = Object.keys(node).filter((k) => node[k] !== ours[k]);
    assert.deepStrictEqual(diffs.map((k) => `${k}: node ${node[k]} / quaude ${ours[k]}`), [],
      `${diffs.length} of ${Object.keys(node).length} answers differ`);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
