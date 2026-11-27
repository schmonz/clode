// test/text-utils.test.cjs — Bun's four text functions need no npm module. Bun.stringWidth,
// Bun.sliceAnsi and Bun.wrapAnsi stopped being npm-backed in phase 3 (2026-09-24 and -25;
// wrapAnsi 2026-09-26) and Bun.stripANSI on 2026-11-27 (it was npm strip-ansi): all four are
// libexec/unicode-text.cjs's, judged against native (test/fidelity/text-differential.test.cjs,
// test/text-strip-ansi.test.cjs), so they need no module and ignore one.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { runShimChild } = require('./isolated-shim.cjs');

// Fake string-width/strip-ansi/wrap-ansi/slice-ansi on a NODE_PATH dir, in each package's
// own export shape, to prove the shim uses none of them. `over` replaces a fake's body.
function withFakes(over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-text-'));
  const mk = (name, body) => {
    fs.mkdirSync(path.join(dir, name));
    fs.writeFileSync(path.join(dir, name, 'package.json'),
      `{"name":"${name}","version":"0.0.0-clode-test","main":"index.js"}`);
    fs.writeFileSync(path.join(dir, name, 'index.js'), body);
  };
  const bodies = {
    // ESM-default shape: module.exports.default = fn (what require(esm) yields)
    'string-width': 'exports.default=(...a)=>"SW:"+JSON.stringify(a);',
    'strip-ansi': 'exports.default=(s)=>"STRIP:"+s;',
    'wrap-ansi': 'module.exports=(...a)=>"WRAP:"+JSON.stringify(a);',
    'slice-ansi': 'exports.default=(...a)=>"SLICE:"+JSON.stringify(a);',
    ...over,
  };
  for (const [name, body] of Object.entries(bodies)) mk(name, body);
  return dir;
}

test('Bun.stripANSI needs no npm module, and ignores one that is there', () => {
  // native 2.1.332: ESC[>4;2m (xterm modifyOtherKeys) leaves nothing; npm strip-ansi left "4;2m".
  const probe = 'const E = String.fromCharCode(0x1b); console.log(JSON.stringify([Bun.stripANSI(E + "[31mhi" + E + "[0m"), '
    + 'Bun.stripANSI(E + "[>4;2m" + "x"), Bun.stripANSI()]));';
  const want = JSON.stringify(['hi', 'x', 'undefined']);
  const bare = runShimChild(probe);
  assert.strictEqual(bare.status, 0, bare.stderr);
  assert.strictEqual(bare.stdout.trim(), want);
  const faked = runShimChild(probe, { NODE_PATH: withFakes() });
  assert.strictEqual(faked.stdout.trim(), want, 'a strip-ansi module on NODE_PATH must not be used');
});

test('Bun.stringWidth needs no npm module, and ignores one that is there', () => {
  // U+4E2D is 2 columns and `a` 1 (native 2.1.278); the ESC[1m is not counted.
  const probe = 'console.log(Bun.stringWidth(String.fromCodePoint(0x4e2d, 0x61)), '
    + 'Bun.stringWidth(String.fromCharCode(0x1b) + "[1mhi"));';
  const bare = runShimChild(probe);
  assert.strictEqual(bare.status, 0, bare.stderr);
  assert.strictEqual(bare.stdout.trim(), '3 2');
  const faked = runShimChild(probe, { NODE_PATH: withFakes() });
  assert.strictEqual(faked.stdout.trim(), '3 2', 'a string-width module on NODE_PATH must not be used');
});

test('Bun.sliceAnsi needs no npm module, and ignores one that is there', () => {
  // native 2.1.278: a wide cluster that STARTS in [0, 1) is kept whole (npm slice-ansi gave
  // ''), and a bold run cut from column 1 is reopened and closed.
  const probe = 'console.log(JSON.stringify([Bun.sliceAnsi(String.fromCodePoint(0x4e2d, 0x61), 0, 1), '
    + 'Bun.sliceAnsi(String.fromCharCode(0x1b) + "[1mhi", 1)]));';
  const want = JSON.stringify([String.fromCodePoint(0x4e2d), '\x1b[1mi\x1b[22m']);
  const bare = runShimChild(probe);
  assert.strictEqual(bare.status, 0, bare.stderr);
  assert.strictEqual(bare.stdout.trim(), want);
  const faked = runShimChild(probe, { NODE_PATH: withFakes() });
  assert.strictEqual(faked.stdout.trim(), want, 'a slice-ansi module on NODE_PATH must not be used');
});

test('Bun.wrapAnsi needs no npm module, and ignores one that is there', () => {
  // native 2.1.283: a tab is a 0-wide word character, never expanded (WRAP-TAB), and only the
  // last style is closed and reopened at a break, so the italic runs on (WRAP-SGR).
  const probe = 'const E = String.fromCharCode(0x1b), T = String.fromCharCode(9); console.log(JSON.stringify(['
    + 'Bun.wrapAnsi("a" + T + "b c", 3), Bun.wrapAnsi(E + "[3mab " + E + "[1mcd" + E + "[22m", 2)]));';
  const want = JSON.stringify(['a\tb\nc', '\x1b[3mab\x1b[23m\n\x1b[3m\x1b[1mcd\x1b[22m']);
  const bare = runShimChild(probe);
  assert.strictEqual(bare.status, 0, bare.stderr);
  assert.strictEqual(bare.stdout.trim(), want);
  const faked = runShimChild(probe, { NODE_PATH: withFakes() });
  assert.strictEqual(faked.stdout.trim(), want, 'a wrap-ansi module on NODE_PATH must not be used');
});
