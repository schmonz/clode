'use strict';
// Characterization for phase-3 batch 2: url (legacy parse/format/resolve/
// domainToASCII), crypto (createHash/createHmac/timingSafeEqual/constants/
// randomFillSync), zlib top-level constants. tjs-under-loader vs host node.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

function bothMatch(t, prog) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-b2-'));
  const f = path.join(dir, 'prog.cjs');
  fs.writeFileSync(f, prog);
  const nodeOut = execFileSync(process.execPath, [f], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), nodeOut, `tjs != node:\ntjs=${r.stdout}\nnode=${nodeOut}`);
}

test('url legacy: parse (abs/auth/relative) + format + resolve + domainToASCII', (t) => {
  if (skipUnlessTjs(t)) return;
  bothMatch(t, `
const url = require('node:url');
const o = [];
o.push(url.parse('https://api.anthropic.com/v1/messages?x=1#f', true));
o.push(url.parse('http://user:pass@host:8080/p/q?a=b'));
o.push(url.parse('/foo/bar?x=1#h'));
o.push(url.parse('wss://ex.com/ws'));
o.push(url.format({protocol:'https:',hostname:'h.com',pathname:'/p',search:'?a=1'}));
o.push(url.format({protocol:'http:',host:'x:9',pathname:'/y',query:{a:1,b:2}}));
o.push(url.format(new URL('https://x.com/a?b=1#z')));
o.push(url.resolve('https://a.com/b/c', '../d'));
o.push(url.domainToASCII('b\\u00fccher.de'));
o.push(url.domainToASCII('xn--'));
console.log(JSON.stringify(o));
`);
});

test('crypto: sha256/hmac-sha256 KAT + timingSafeEqual + constants (vs host)', (t) => {
  if (skipUnlessTjs(t)) return;
  bothMatch(t, `
const c = require('node:crypto');
const o = [];
o.push(c.createHash('sha256').update('abc').digest('hex'));
o.push(c.createHash('sha256').update('').digest('hex'));
o.push(c.createHmac('sha256','key').update('The quick brown fox jumps over the lazy dog').digest('hex'));
o.push(c.createHmac('sha256', Buffer.alloc(80, 0x0b)).update('data').digest('base64'));
o.push(c.timingSafeEqual(Buffer.from('abcd'), Buffer.from('abcd')));
o.push(c.timingSafeEqual(Buffer.from('abcd'), Buffer.from('abce')));
o.push([c.constants.RSA_PKCS1_PADDING, c.constants.SSL_OP_NO_TLSv1_3, c.constants.POINT_CONVERSION_UNCOMPRESSED]);
console.log(JSON.stringify(o));
`);
});

test('zlib: top-level Z_* constants match host node exactly', (t) => {
  if (skipUnlessTjs(t)) return;
  bothMatch(t, `
const z = require('node:zlib');
const keys = ['Z_MIN_CHUNK','Z_FINISH','Z_SYNC_FLUSH','Z_NO_FLUSH','Z_BEST_COMPRESSION','Z_DEFAULT_CHUNK','BROTLI_OPERATION_FLUSH'];
console.log(JSON.stringify(keys.map(k => [k, z[k]])));
`);
});

// getHashes is a DELIBERATE divergence: the shim implements only sha256 and
// reports exactly that (so feature-detection never selects an algorithm we'd
// throw on), whereas host node lists ~50. Assert the honest shape, not equality.
test('crypto.getHashes reports the honest supported set (sha256 only)', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-gh-'));
  const f = path.join(dir, 'p.cjs');
  fs.writeFileSync(f, `console.log(JSON.stringify(require('node:crypto').getHashes()));`);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), JSON.stringify(['sha256']));
  // Host node must at least contain sha256 (sanity that the name is canonical).
  const hostHashes = require('node:crypto').getHashes();
  assert.ok(hostHashes.includes('sha256'));
});
