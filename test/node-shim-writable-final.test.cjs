'use strict';
// stream.Writable runs _final before 'finish' and _destroy on destroy(), as node does — oracle: host node, same script.
//
// MEASURED 2026-11-23 on NetBSD/arm64, a real quaude: EVERY request the 2.1.330 bundle sends through its axios
// adapter with redirects on (bootstrap, settings, passes eligibility, fast-mode status, penguin_mode, MCP registry)
// timed out — 5 s, 10 s, 3 s — and /login took ~30 s. The adapter wraps each request in a redirect-follower
// (`class Dt extends <stream>.Writable`, constructed with `{autoDestroy: false}`) whose ONLY call to the real
// ClientRequest's end() is in its `_final(cb)`: `_final(e){ this.isBodyWhole=!0; if(!this.isResending) this.hop.end(); e() }`.
// node-shim's Writable never called _final, so the request was never sent and sat until axios's timeout fired.
// Its abort path is `_destroy(e, r){ this.hop.destroy(e); r(e) }`, which the shim's destroy() never called either.
// Requests sent with maxRedirects: 0 (policy_limits, metrics_enabled) bypass the wrapper and always worked, which is
// why the turn itself did.
//
// Writable already had a sibling that honoured _final (Duplex, for the AWS SDK's ChecksumStream); the comment there
// said "_final support Writable itself doesn't have (no bundle path needed it there)". This file is the bundle path.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

const SCRIPT = `
const { Writable } = require('stream');
const http = require('http');
const log = [];
const out = () => console.log(JSON.stringify(log));
class W extends Writable {
  constructor(o) { super({ autoDestroy: false, ...o }); }
  _write(c, e, cb) { log.push('write:' + c); cb(); }
  _final(cb) { log.push('final'); cb(); }
  _destroy(err, cb) { log.push('_destroy:' + (err ? err.message : err)); cb(err); }
}
// 1. end() with no writes still runs _final, before 'finish'; the end callback is in order too.
const a = new W(); a.on('finish', () => log.push('finish-a')); a.end(() => log.push('cb-a'));
// 2. writes, then end(chunk): every write before _final.
const b = new W(); b.on('finish', () => log.push('finish-b')); b.write('x'); b.end('y');
// 3. options.final / options.write, no subclass.
const c = new Writable({ write(ch, e, cb) { log.push('optwrite'); cb(); }, final(cb) { log.push('optfinal'); cb(); } });
c.on('finish', () => log.push('finish-c')); c.end('z');
// 4. a failing _final: 'error', no 'finish'.
const d = new Writable({ final(cb) { cb(new Error('nope')); } });
d.on('error', (e) => log.push('error-d:' + e.message)); d.on('finish', () => log.push('finish-d')); d.end();
setTimeout(() => {
  // 5. destroy(err) runs _destroy, then 'error', then 'close'.
  const e = new W(); e.on('error', (x) => log.push('error-e:' + x.message)); e.on('close', () => log.push('close-e'));
  e.destroy(new Error('boom'));
  setTimeout(() => {
    // 6. THE BUNDLE'S SHAPE, end to end: a Writable whose _final ends a real ClientRequest gets its response.
    const srv = http.createServer((req, res) => { res.setHeader('Connection', 'close'); res.end('pong'); });
    srv.listen(0, '127.0.0.1', () => {
      class Follow extends Writable {
        constructor(opts, onResponse) {
          super({ autoDestroy: false });
          this.once('response', onResponse);
          this.hop = http.request(opts, (res) => this.emit('response', res));
          this.hop.on('error', (x) => log.push('hop-error:' + x.code));
        }
        _write(ch, enc, cb) { this.hop.write(ch); cb(); }
        _final(cb) { this.hop.end(); cb(); }
        _destroy(err, cb) { this.hop.destroy(err || undefined); cb(err); }
      }
      const t = setTimeout(() => { log.push('follow:TIMEOUT'); srv.close(); out(); }, 5000);
      const f = new Follow({ host: '127.0.0.1', port: srv.address().port, path: '/', method: 'GET' }, (res) => {
        let body = ''; res.on('data', (ch) => { body += ch; });
        res.on('end', () => { clearTimeout(t); log.push('follow:' + res.statusCode + ':' + body); srv.close(); out(); });
      });
      f.end();
    });
  }, 50);
}, 50);
`;

let dir;
function script() {
  if (!dir) { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-final-')); fs.writeFileSync(path.join(dir, 'w.cjs'), SCRIPT); }
  return path.join(dir, 'w.cjs');
}
test.after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

test('Writable: _final before finish, options.final, a failing _final, _destroy, and a _final-ended request (vs host node)', (t) => {
  if (skipUnlessTjs(t)) return;
  const n = spawnSync(process.execPath, [script()], { encoding: 'utf8', timeout: 30000 });
  assert.strictEqual(n.status, 0, n.stderr);
  const want = JSON.parse(n.stdout.trim());
  // The oracle itself must show what this file is about, or it proves nothing.
  assert.ok(want.includes('final') && want.includes('optfinal') && want.includes('follow:200:pong'), n.stdout);
  const r = runLoader(script());
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), want);
});
