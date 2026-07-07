'use strict';
// Phase-2 M1 PROOF: clode's own toolchain modules run REAL jobs under tjs with
// output identical to host node.
//
//   Rung 1 — clode-net.cjs: sha256Of + downloadFile('file://...') under tjs
//            match host node AND the known digest / source bytes.
//   Rung 2 — extract-claude-js.cjs: extract a (synthetic, faithful) Bun
//            standalone fixture under tjs; the output is byte-identical to
//            host node's. Exercises carve -> pickEntry -> import.meta rewrite
//            -> PRELUDE prepend -> verify + contentChecks, AND the loader's
//            require.main fix (main() only fires when require.main === module).
//
// NOTE: no native `claude` binary exists in this environment (providers/* is
// empty; the cached cli.cjs is EXTRACTED OUTPUT, not valid input). Rung 2 uses
// a faithful minimal synthetic fixture — see mkBunFixture(). "Full 240MB
// real-binary extraction under tjs" is deferred to M2.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { runLoader, skipUnlessTjs, tjsPath, LOADER } = require('./node-shim-helper.cjs');

const REPO = path.resolve(__dirname, '..');
const NET = path.join(REPO, 'libexec/clode-net.cjs');
const EXTRACTOR = path.join(REPO, 'libexec/extract-claude-js.cjs');

// clode-net.cjs is a MODULE (module.exports = { downloadFile, sha256Of }), not a
// CLI — drive it via a tiny script that requires it and calls the exports, run
// under BOTH tjs and node.
const NET_DRIVER = `
'use strict';
const net = require(${JSON.stringify(NET)});
const [srcFile, downloadSrc, downloadDest] = process.argv.slice(2);
(async () => {
  process.stdout.write('sha256=' + net.sha256Of(srcFile) + '\\n');
  const ok = await net.downloadFile('file://' + downloadSrc, downloadDest);
  process.stdout.write('download=' + ok + '\\n');
  process.stdout.write('copy_sha256=' + net.sha256Of(downloadDest) + '\\n');
})().catch((e) => { process.stderr.write(String(e && e.stack || e) + '\\n'); process.exit(1); });
`;

test('Rung 1: clode-net sha256Of + file:// downloadFile match node & known digest', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rung1-'));
  const driver = path.join(dir, 'driver.cjs');
  fs.writeFileSync(driver, NET_DRIVER);

  const srcFile = path.join(dir, 'input.txt');
  fs.writeFileSync(srcFile, 'clode');
  const knownSha = crypto.createHash('sha256').update('clode').digest('hex');

  // A binary payload with NULs so a utf-8 round-trip would visibly corrupt it.
  const dlSrc = path.join(dir, 'payload.bin');
  fs.writeFileSync(dlSrc, Buffer.from('clode-download-\x00\x01\x02-payload', 'latin1'));

  const nodeDest = path.join(dir, 'copy-node.bin');
  const tjsDest = path.join(dir, 'copy-tjs.bin');

  const nodeOut = execFileSync(process.execPath, [driver, srcFile, dlSrc, nodeDest], { encoding: 'utf8' }).trim();
  const r = runLoader(driver, [srcFile, dlSrc, tjsDest]);
  assert.strictEqual(r.status, 0, r.stderr);

  // tjs output == node output, and the sha256 is the known digest of 'clode'.
  assert.strictEqual(r.stdout.trim(), nodeOut);
  assert.match(r.stdout, new RegExp('sha256=' + knownSha));

  // The file:// download copies bytes exactly (== source, and == node's copy).
  assert.ok(fs.readFileSync(tjsDest).equals(fs.readFileSync(dlSrc)), 'tjs copy == source bytes');
  assert.ok(fs.readFileSync(tjsDest).equals(fs.readFileSync(nodeDest)), 'tjs copy == node copy');
});

// Build a faithful minimal Bun --compile standalone fixture: a NUL-terminated
// `entrypoints/cli.js` name, then the `// @bun ... @bun-cjs\n(function(exports,
// require, module, __filename, __dirname) { <body> })` block terminated by NUL.
// Body carries two import.meta forms, the 'commander' sentinel, and >1MB of
// padding so contentChecks (MIN_OUTPUT_BYTES) passes.
function mkBunFixture(outPath) {
  const pad = 'A'.repeat(1_100_000); // valid string literal; no NUL, no 'import.meta'
  const body =
    "const commander = require('commander');\n" +
    'const meta = import.meta;\n' +
    'const PAD = "' + pad + '";\n' +
    'module.exports = { url: import.meta.url, commander, PAD };';
  const marker = '// @bun @bun-cjs\n(function(exports, require, module, __filename, __dirname) {' + body + '})';
  const blob = Buffer.concat([
    Buffer.from('\x00entrypoints/cli.js\x00', 'latin1'),
    Buffer.from(marker, 'latin1'),
    Buffer.from('\x00trailing bun runtime bytes\x00', 'latin1'),
  ]);
  fs.writeFileSync(outPath, blob);
}

test('Rung 2: extract-claude-js output under tjs is byte-identical to host node', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rung2-'));
  const bin = path.join(dir, 'fake-claude.bin');
  mkBunFixture(bin);

  const nodeOut = path.join(dir, 'out-node.cjs');
  const tjsOut = path.join(dir, 'out-tjs.cjs');

  // Host node: run the extractor as the entry (require.main === module -> main()).
  execFileSync(process.execPath, [EXTRACTOR, bin, nodeOut], { stdio: 'ignore' });
  // tjs: same, via the loader. The loader's require.main fix is what lets main()
  // fire here — without it nothing would be written.
  const r = runLoader(EXTRACTOR, [bin, tjsOut]);
  assert.strictEqual(r.status, 0, r.stderr);

  const a = fs.readFileSync(nodeOut);
  const b = fs.readFileSync(tjsOut);
  assert.ok(a.length > 1_000_000, 'output exceeds contentChecks size floor');
  assert.ok(a.equals(b), `extractor output differs (node ${a.length}B vs tjs ${b.length}B)`);
  // Positive shape checks the extractor guarantees on its output.
  const text = b.toString('latin1');
  assert.ok(text.startsWith('// ---- mavericks node-host prelude'), 'PRELUDE prepended');
  assert.ok(!text.includes('import.meta'), 'import.meta rewritten away');
  assert.ok(text.includes('__import_meta'), 'import.meta -> __import_meta');
  assert.ok(!text.includes('\x00'), 'no NUL bytes in output');
});
