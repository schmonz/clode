'use strict';
// tls.createSecureContext({ ca }) under quaude answers as NATIVE does. 2.1.330's CA-trust builder asks it whether the
// NODE_EXTRA_CA_CERTS file loads as one entry (`createSecureContext({ca:[file]})`). When native throws "Invalid CA" the
// bundle warns that it "cannot load ... as one CA list entry" and keeps only the certificates that load one by one.
// The shim first walled (so a private CA never reached WebFetch's trust list, test/fidelity/webfetch.test.cjs), then
// copied node, which accepts any string or bytes unparsed: a file with a corrupt block before a good root was
// refused whole by native and trusted whole by quaude, which is MORE trust than native gives. Native is the reference:
// the rows (test/fixtures/tls-secure-context-cases.cjs) run under quaude's engine and are judged against native's
// recorded answers (tls-secure-context-native.json), and native is re-asked wherever it is present, so a moved native
// shows here rather than as a stale record.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

const CASES = require('./fixtures/tls-secure-context-cases.cjs');
const NATIVE = require('./fixtures/tls-secure-context-native.json');

test('tls.createSecureContext({ca}) answers every case as native does, row for row', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-secctx-'));
  try {
    const entry = path.join(dir, 'p.cjs');
    fs.writeFileSync(entry, `console.log(JSON.stringify((${CASES.toString()})()));`);
    const r = runLoader(entry);
    assert.strictEqual(r.status, 0, String(r.stderr));
    const got = JSON.parse(String(r.stdout).trim().split('\n').pop());
    assert.strictEqual(got.length, NATIVE.length, 'one answer per recorded row');
    const diffs = NATIVE.map((n, i) => (JSON.stringify(n) === JSON.stringify(got[i]) ? null
      : `native: ${JSON.stringify(n)}\n   tjs: ${JSON.stringify(got[i])}`)).filter(Boolean);
    assert.deepStrictEqual(diffs, [], `${diffs.length} row(s) differ from native:\n${diffs.join('\n')}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('native Bun still answers the createSecureContext cases as recorded', (t) => {
  const { resolveNativeOracle, runInNative } = require('../scripts/lib/native-oracle.cjs');
  const bin = resolveNativeOracle();
  if (!bin) { t.skip('no native claude (CLODE_NATIVE_ORACLE / CLODE_NATIVE_CLAUDE / PATH)'); return; }
  const got = runInNative(bin, `return (${CASES.toString()})();`);
  assert.deepStrictEqual(got, NATIVE, 'native moved: re-record test/fixtures/tls-secure-context-native.json and review each row');
});

test('an option the shim cannot honour still meets the wall, never a silent accept', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tls-secctx-wall-'));
  try {
    const entry = path.join(dir, 'p.cjs');
    fs.writeFileSync(entry, `try { require('tls').createSecureContext({ cert: 'x' }); console.log('accepted'); } catch (e) { console.log(e.message); }`);
    const r = runLoader(entry);
    assert.strictEqual(String(r.stdout).trim(), 'node-shim: tls.createSecureContext({cert}) not implemented (only the ca option is taken)');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
