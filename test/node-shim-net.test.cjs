'use strict';
// Characterization: node:net's isIP family and BlockList must match host node
// exactly — the -p bundle builds a private-range BlockList at load and check()s
// the target (127.0.0.1, inside 127.0.0.0/8), so a divergence would change the
// boot's local-address decision. Socket real I/O is a documented divergence.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

const PROG = `
const net = require('net');
const bl = new net.BlockList();
bl.addSubnet('127.0.0.0', 8, 'ipv4');
bl.addAddress('10.0.0.5', 'ipv4');
bl.addRange('192.168.1.1', '192.168.1.10', 'ipv4');
bl.addSubnet('::1', 128, 'ipv6');
bl.addSubnet('fe80::', 10, 'ipv6');
console.log(JSON.stringify({
  isIP: ['127.0.0.1','::1','nope','1.2.3.4','256.1.1.1'].map((x) => net.isIP(x)),
  isIPv4: ['127.0.0.1','01.2.3.4','256.1.1.1','::1'].map((x) => net.isIPv4(x)),
  isIPv6: ['::1','fe80::1','127.0.0.1','2001:db8::1'].map((x) => net.isIPv6(x)),
  check: ['127.0.0.1','128.0.0.1','10.0.0.5','10.0.0.6','192.168.1.5','192.168.1.11'].map((x) => bl.check(x)),
  check6: ['::1','fe80::abcd','2001:db8::1'].map((x) => bl.check(x, 'ipv6')),
  socketFn: typeof net.Socket,
}));
`;

test('net.isIP + BlockList characterization vs host node', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-net-'));
  const f = path.join(dir, 'net.cjs');
  fs.writeFileSync(f, PROG);
  const nodeOut = require('node:child_process')
    .execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim();
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), JSON.parse(nodeOut));
});

// Wall (Task 4): the -p boot reads tls.getCACertificates()/rootCertificates at
// HTTP-client setup. They must be arrays (empty is correct for the http mock
// path — a documented divergence from host node's ~120 bundled PEMs).
test('tls.getCACertificates/rootCertificates are arrays under tjs', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-tls-'));
  const f = path.join(dir, 'tls.cjs');
  fs.writeFileSync(f, `const tls = require('tls');
console.log(JSON.stringify({
  ca: Array.isArray(tls.getCACertificates()),
  roots: Array.isArray(tls.rootCertificates),
}));`);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), { ca: true, roots: true });
});
