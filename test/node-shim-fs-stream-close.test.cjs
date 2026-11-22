'use strict';
// fs.createReadStream and fs.createWriteStream close as node's do: 'close' after the stream is done (a tick after
// node closes the fd), .closed false until then and true after, autoClose (destroy after 'end' / 'finish', once
// their listeners have run) and emitClose (whether 'close' is emitted) both honoured, and writeStream.close(cb)
// ending the stream first. node-shim's streams never emitted 'close' and had no .closed before 2026-11-21, so a
// caller waiting for 'close' (stream.finished, the shim differential's driver) waited for nothing, and the driver
// closed the fd twice.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

const PROG = String.raw`
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slc-'));
const f = path.join(dir, 'f.txt');
fs.writeFileSync(f, 'hello\n');
const log = [];
const step = (name, opts, kind) => new Promise((done) => {
  const ev = [];
  const s = kind === 'r' ? fs.createReadStream(f, opts) : fs.createWriteStream(path.join(dir, name), opts);
  ev.push('closed0=' + s.closed);
  for (const e of ['end', 'finish', 'close', 'error']) s.on(e, () => ev.push(e + ':closed=' + s.closed + ':destroyed=' + s.destroyed));
  if (kind === 'r') s.on('data', () => {}); else s.end('x\n');
  setTimeout(() => { ev.push('after closed=' + s.closed + ' destroyed=' + s.destroyed); log.push([name, ev]); done(s); }, 150);
});
(async () => {
  await step('read-default', undefined, 'r');
  await step('read-noautoclose', { autoClose: false }, 'r');
  await step('read-noemitclose', { emitClose: false }, 'r');
  await step('write-default', undefined, 'w');
  await step('write-noautoclose', { autoClose: false }, 'w');
  await step('write-noemitclose', { emitClose: false }, 'w');
  // close(cb) on a write stream mid-life
  await new Promise((done) => {
    const w = fs.createWriteStream(path.join(dir, 'wc'));
    const ev = [];
    w.on('finish', () => ev.push('finish')); w.on('close', () => ev.push('close:' + w.closed));
    w.write('a');
    w.close((e) => { ev.push('cb:' + (e ? e.code : 'ok') + ':' + w.closed); });
    setTimeout(() => { ev.push('content=' + fs.readFileSync(path.join(dir, 'wc'), 'utf8')); log.push(['write-close-cb', ev]); done(); }, 150);
  });
  // read error: missing file
  await new Promise((done) => {
    const r = fs.createReadStream(path.join(dir, 'missing'));
    const ev = [];
    r.on('error', (e) => ev.push('error:' + e.code)); r.on('close', () => ev.push('close:' + r.closed));
    setTimeout(() => { log.push(['read-missing', ev]); done(); }, 150);
  });
  for (const l of log) console.log(JSON.stringify(l));
  fs.rmSync(dir, { recursive: true, force: true });
})();
`;

test('fs read and write streams emit close and set .closed as node does, with autoClose and emitClose', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-stream-close-'));
  try {
    const prog = path.join(dir, 'p.cjs');
    fs.writeFileSync(prog, PROG);
    const node = spawnSync(process.execPath, [prog], { encoding: 'utf8' });
    assert.strictEqual(node.status, 0, node.stderr);
    const want = node.stdout.trim().split('\n').map((l) => JSON.parse(l));
    assert.deepStrictEqual(want[0], ['read-default', ['closed0=false', 'end:closed=false:destroyed=false',
      'close:closed=true:destroyed=true', 'after closed=true destroyed=true']], 'the host node oracle');
    const r = runLoader(prog, []);
    assert.strictEqual(r.status, 0, String(r.stderr));
    assert.deepStrictEqual(r.stdout.trim().split('\n').map((l) => JSON.parse(l)), want);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
