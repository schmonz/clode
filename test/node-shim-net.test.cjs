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

// The -p boot reads tls.getCACertificates()/rootCertificates at HTTP-client
// setup (cli.cjs's `TQ`): when they came back empty, the bundle logged "CA
// certs: Loaded 0 bundled root certificates" and never took the "mTLS:
// Creating HTTPS agent with custom certificates" branch — a real divergence
// from naude/host node. Fixed by scripts/extract-cacert-pem.mjs (see
// test/tls-cacert-pem.test.cjs for the extraction's own characterization) —
// this row locks the tls.cjs SURFACE atop that fix: real cert content (not
// just "is an array"), frozen like node's, getCACertificates()'s per-type
// contract, and identical content whether read via the module's __dirname
// (unfused here — the fused/VFS leg is exercised by runLoader itself, which
// always runs UNFUSED against loader.cjs directly; the sibling-file-read
// mechanism is shared code with no fused-only branch to separately probe).
test('tls.rootCertificates/getCACertificates: real bundled CA content, not an empty stub', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-tls-'));
  const f = path.join(dir, 'tls.cjs');
  fs.writeFileSync(f, `const tls = require('tls');
const roots = tls.rootCertificates;
const ca = tls.getCACertificates();
const bundled = tls.getCACertificates('bundled');
let invalidThrew = null;
try { tls.getCACertificates('nonsense'); } catch (e) { invalidThrew = e.code || e.message; }
console.log(JSON.stringify({
  rootsIsArray: Array.isArray(roots),
  rootsCount: roots.length,
  rootsFrozen: Object.isFrozen(roots),
  firstLooksLikePem: /^-----BEGIN CERTIFICATE-----\\n/.test(roots[0]) && /-----END CERTIFICATE-----$/.test(roots[0]),
  caEqualsRoots: JSON.stringify(ca) === JSON.stringify(roots),
  bundledEqualsRoots: JSON.stringify(bundled) === JSON.stringify(roots),
  systemIsEmpty: tls.getCACertificates('system').length === 0,
  extraIsEmpty: tls.getCACertificates('extra').length === 0,
  invalidThrew,
}));`);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout.trim());
  assert.strictEqual(got.rootsIsArray, true);
  assert.ok(got.rootsCount >= 50, `expected >=50 root certs, got ${got.rootsCount}`);
  assert.strictEqual(got.rootsFrozen, true, 'rootCertificates must be frozen, like node');
  assert.strictEqual(got.firstLooksLikePem, true);
  assert.strictEqual(got.caEqualsRoots, true, "getCACertificates() must match rootCertificates' content");
  assert.strictEqual(got.bundledEqualsRoots, true, "getCACertificates('bundled') must match rootCertificates' content");
  assert.strictEqual(got.systemIsEmpty, true, "'system' store is honestly unimplemented, not fabricated");
  assert.strictEqual(got.extraIsEmpty, true, "'extra' (NODE_EXTRA_CA_CERTS) is honestly unimplemented");
  assert.strictEqual(got.invalidThrew, 'ERR_INVALID_ARG_VALUE', 'an invalid type must throw, matching node');
});

// The actual bundle-visible symptom this fix addresses: with a NON-empty
// rootCertificates, the bundle's own CA-loading code (cli.cjs's `TQ`) pushes
// real cert content and logs a nonzero count instead of the "Loaded 0
// bundled root certificates" line RECIPE G6 traced. This row does not run
// the real bundle (too heavy for this suite) — it locks the exact SHAPE the
// bundle's logic depends on: a truthy, non-empty rootCertificates array,
// which is all `if (t) s.push(...) ; C(\`...Loaded ${t.length}...\`)`
// (cli.cjs's `TQ`/`cPi`) actually branches on.
test('tls.rootCertificates is non-empty and truthy (the exact bundle branch condition)', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-tls-'));
  const f = path.join(dir, 'tls2.cjs');
  fs.writeFileSync(f, `const tls = require('tls');
const roots = tls.rootCertificates;
console.log(JSON.stringify({ truthy: !!(roots && roots.length > 0) }));`);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), { truthy: true });
});
