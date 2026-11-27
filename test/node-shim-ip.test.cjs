'use strict';
// node-shim's one IP-literal test (libexec/node-shim/internal/ip.cjs), DIFFERENTIALLY against host node's net: every
// case below answers isIPv4/isIPv6/isIP as node does, under host node (the module directly) and under the shim
// (net, which re-exports it, and dns.lookup's literal shortcut). Before it, net.cjs passed 'fe80::1%' and a zone with
// a second '%', and refused anything not a string; http.cjs's no_proxy range check took '01.2.3.4' for an address;
// dns.lookup took '999.1.1.1' for one.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');
const ip = require('../libexec/node-shim/internal/ip.cjs');

const CASES = ['127.0.0.1', '0.0.0.0', '255.255.255.255', '256.1.1.1', '01.2.3.4', '1.2.3.04', '1.2.3', '1.2.3.4.5', '1..2.3',
  ' 1.2.3.4', '1.2.3.4 ', '1.2.3.4\n', '1.2.3.-4', '+1.2.3.4', '1e0.2.3.4', '0x1.2.3.4', '999.1.1.1', '', '::', '::1', '1::',
  'fe80::1%eth0', 'fe80::1%', 'fe80::1%en0%x', 'fe80::1%a.b-c:d', '::ffff:1.2.3.4', '::ffff:01.2.3.4', '1:2:3:4:5:6:7:8',
  '1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7::', '1:2:3:4:5:6::8', '1::2::3', '12345::', 'g::1', ':1', '1:', '::1.2.3.4',
  '1:2:3:4:5:6:1.2.3.4', '1:2:3:4:5:6:7:1.2.3.4', 'localhost', 'example.com', '[::1]', 'FE80::ABCD', '0:0:0:0:0:0:0:0',
  '::0:0:0:0:0:0:0', '1.2.3.4%eth0', '00000::1', '0000::1'];
// node coerces with String(): a number, null, undefined, an object with a toString, an array.
const NON_STRINGS = 'return [123, null, undefined, { toString() { return "1.2.3.4"; } }, ["::1"], 1.5]';

const answers = (m, list) => list.map((c) => [m.isIPv4(c), m.isIPv6(c), m.isIP(c)]);

test('internal/ip.cjs answers isIPv4/isIPv6/isIP as host node\'s net does, string or not', () => {
  const others = new Function(NON_STRINGS)();
  assert.deepStrictEqual(answers(ip, CASES), answers(net, CASES));
  assert.deepStrictEqual(answers(ip, others), answers(net, others));
});

test('under the shim, net.isIP* and dns.lookup\'s literal shortcut are node\'s', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-ip-'));
  try {
    const f = path.join(dir, 'ip.cjs');
    fs.writeFileSync(f, `const net = require('node:net');
const cases = ${JSON.stringify(CASES)}.concat((function () { ${NON_STRINGS}; })());
const out = cases.map((c) => [net.isIPv4(c), net.isIPv6(c), net.isIP(c)]);
for (const h of ['127.0.0.1', '::1', 'fe80::1%eth0']) {
  require('node:dns').lookup(h, (e, a, fam) => out.push([h, e ? e.code || 'error' : a, fam]));
}
setTimeout(() => console.log(JSON.stringify(out)), 50);`);
    const want = JSON.parse(require('node:child_process').execFileSync(process.execPath, [f], { encoding: 'utf8' }));
    const r = runLoader(f);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(JSON.parse(r.stdout.trim().split('\n').pop()), want);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// dns.lookup of something that only looks like an address is a name to node; the shim, which has no resolver, says
// so by refusing rather than answering it as a literal.
test('under the shim, dns.lookup(\'999.1.1.1\') is not answered as a literal', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-ip-dns-'));
  try {
    const f = path.join(dir, 'dns.cjs');
    fs.writeFileSync(f, "require('node:dns').lookup('999.1.1.1', (e, a) => console.log(JSON.stringify(e ? 'refused' : a)));");
    const r = runLoader(f);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.strictEqual(JSON.parse(r.stdout.trim().split('\n').pop()), 'refused');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
