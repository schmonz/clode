'use strict';
// Characterization for the phase-3 batch-added fs methods: appendFile(Sync),
// writeSync, write/read (cb), rmSync, mkdtempSync, chmod, symlink, link,
// fsync (best-effort). Runs the same program under HOST NODE and tjs+loader and
// compares. File paths live under a per-run temp dir so the two runs don't
// collide.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

const PROG = `
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
(async () => {
  const o = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-fsx-'));
  o.push(['mkdtemp', fs.existsSync(dir), path.basename(dir).startsWith('shim-fsx-')]);
  const f = path.join(dir, 'a.txt');
  fs.writeFileSync(f, 'hello');
  fs.appendFileSync(f, ' world');
  o.push(['append', fs.readFileSync(f, 'utf8')]);
  const fd = fs.openSync(f, 'r+');
  const n = fs.writeSync(fd, Buffer.from('HELLO'), 0, 5, 0);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  o.push(['writeSync', n, fs.readFileSync(f, 'utf8')]);
  // fs.write string form (cb)
  const fd2 = fs.openSync(f, 'r+');
  const wn = await new Promise((res, rej) => fs.write(fd2, '!', 11, 'utf8', (e, bytes) => e ? rej(e) : res(bytes)));
  fs.closeSync(fd2);
  o.push(['write-cb', wn, fs.readFileSync(f, 'utf8')]);
  // fs.read (cb)
  const fd3 = fs.openSync(f, 'r');
  const buf = Buffer.alloc(5);
  const rn = await new Promise((res, rej) => fs.read(fd3, buf, 0, 5, 0, (e, bytes) => e ? rej(e) : res(bytes)));
  fs.closeSync(fd3);
  o.push(['read-cb', rn, buf.toString('utf8')]);
  // symlink + chmod via promises
  await fs.promises.symlink(f, path.join(dir, 'lnk'));
  o.push(['symlink', fs.lstatSync(path.join(dir, 'lnk')).isSymbolicLink()]);
  await fs.promises.chmod(f, 0o600);
  o.push(['chmod', (fs.statSync(f).mode & 0o777).toString(8)]);
  // hardlink via promises
  await fs.promises.link(f, path.join(dir, 'hard'));
  o.push(['hardlink', fs.readFileSync(path.join(dir, 'hard'), 'utf8') === fs.readFileSync(f, 'utf8')]);
  // appendFile cb + mkdtemp promise
  await new Promise((res, rej) => fs.appendFile(f, '?', (e) => e ? rej(e) : res()));
  o.push(['appendFileCb', fs.readFileSync(f, 'utf8').endsWith('?')]);
  const td = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'shim-fsx2-'));
  o.push(['mkdtemp-promise', fs.existsSync(td)]);
  // rmSync recursive + force
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(td, { recursive: true, force: true });
  fs.rmSync(path.join(os.tmpdir(), 'does-not-exist-shim'), { force: true }); // must not throw
  o.push(['rmSync', fs.existsSync(dir)]);
  console.log(JSON.stringify(o));
})().catch((e) => { console.log('ERR ' + (e && e.stack || e)); process.exit(3); });
`;

test('fs batch methods: append/writeSync/write/read/symlink/chmod/link/rmSync/mkdtemp vs host node', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-fsx-drv-'));
  const f = path.join(dir, 'prog.cjs');
  fs.writeFileSync(f, PROG);
  const nodeOut = execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim();
  // The pinned shape (dir/td paths differ per run, so compare the structural
  // parts, not the absolute paths — mkdtemp booleans already assert prefix).
  const expected = JSON.stringify([
    ['mkdtemp', true, true], ['append', 'hello world'], ['writeSync', 5, 'HELLO world'],
    ['write-cb', 1, 'HELLO world!'], ['read-cb', 5, 'HELLO'], ['symlink', true],
    ['chmod', '600'], ['hardlink', true], ['appendFileCb', true], ['mkdtemp-promise', true],
    ['rmSync', false],
  ]);
  assert.strictEqual(nodeOut, expected, `host node output drifted:\n${nodeOut}`);
  const r = runLoader(f, [], { timeout: 30000 });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), nodeOut, `tjs != node:\ntjs=${r.stdout}\nnode=${nodeOut}`);
});
