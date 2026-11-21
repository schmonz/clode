'use strict';
// Bun.gzipSync and Bun.SHA256.hash, which 2.1.330 calls live (its telemetry batches go out gzip-compressed; its
// prompt-block digester hashes with SHA256 into base64) and the shim lacked: inspect --strict flagged both. Run
// under quaude's engine (node-shim) when one is available, and under node, with one expected answer.
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

const SHIM = path.join(__dirname, '..', 'libexec', 'bun-shim.cjs');
const PROGRAM = `
const Bun = require(${JSON.stringify(SHIM)});
const zlib = require('zlib');
const text = 'hello hello hello hello\\n'.repeat(50);
let gzip;
try {
  const gz = Bun.gzipSync(Buffer.from(text), { level: 1, library: 'libdeflate' });
  gzip = { type: Object.prototype.toString.call(gz), magic: [gz[0], gz[1]],
    roundTrip: zlib.gunzipSync(Buffer.from(gz)).toString() === text, smaller: gz.length < text.length };
} catch (e) { gzip = { threw: String(e && e.message).slice(0, 40) }; }
const out = {
  gzip,
  b64: Bun.SHA256.hash(Buffer.from('abc'), 'base64'),
  hex: Bun.SHA256.hash('abc', 'hex'),
  bytes: Array.from(Bun.SHA256.hash(new Uint8Array([0x61, 0x62, 0x63]))).slice(0, 4),
  incremental: new Bun.SHA256().update('a').update('bc').digest('hex'),
};
console.log(JSON.stringify(out));
`;
// FIPS 180-2's "abc" vector
const ABC_HEX = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const GZIP = { type: '[object Uint8Array]', magic: [0x1f, 0x8b], roundTrip: true, smaller: true };
// UNDER tjs node-shim has no gzip (its zlib.gzipSync refuses by name; BACKLOG "2.1.330 absorbed except three gaps",
// with deflateRawSync), so Bun.gzipSync there refuses the same way instead of failing as "not a function".
const GZIP_TJS = { threw: 'node-shim: zlib.gzipSync not implemented' };
const EXPECTED = {
  gzip: GZIP,
  b64: Buffer.from(ABC_HEX, 'hex').toString('base64'), hex: ABC_HEX, bytes: [0xba, 0x78, 0x16, 0xbf], incremental: ABC_HEX,
};

test('Bun.gzipSync and Bun.SHA256 under node', () => {
  const { execFileSync } = require('node:child_process');
  const got = JSON.parse(execFileSync(process.execPath, ['-e', PROGRAM], { encoding: 'utf8' }));
  assert.deepStrictEqual(got, EXPECTED);
});

test('Bun.gzipSync and Bun.SHA256 under quaude\'s engine', (t) => {
  if (skipUnlessTjs(t)) return;
  const fs = require('node:fs');
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'bun-gzip-sha-'));
  try {
    const entry = path.join(dir, 'p.cjs');
    fs.writeFileSync(entry, PROGRAM);
    const r = runLoader(entry);
    assert.strictEqual(r.status, 0, String(r.stderr));
    assert.deepStrictEqual(JSON.parse(String(r.stdout).trim().split('\n').pop()), { ...EXPECTED, gzip: GZIP_TJS });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
