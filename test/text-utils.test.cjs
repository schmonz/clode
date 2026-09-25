// test/text-utils.test.cjs — Bun.stripANSI / wrapAnsi backed by the npm strip-ansi /
// wrap-ansi deps (the ext-dep pattern). These are CORE (every render), so a missing one
// is fatal: write the install hint and exit, like ws — clode can't render without them,
// so there's nothing to recover. Bun.stringWidth and Bun.sliceAnsi are NOT npm-backed any
// more (phase 3, 2026-09-24 and -25): they are libexec/unicode-text.cjs's, judged against
// native by test/fidelity/text-differential.test.cjs, so they need no module and ignore one.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { runShimChild } = require('./isolated-shim.cjs');

// Fake string-width/strip-ansi/wrap-ansi/slice-ansi on a NODE_PATH dir. string-width and
// strip-ansi are ESM-only upstream (default export), so model that shape — a
// `{default: fn}` namespace — to prove the shim unwraps `.default`. wrap-ansi echoes
// all three args so we can prove forwarding.
function withFakes() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-text-'));
  const mk = (name, body) => {
    fs.mkdirSync(path.join(dir, name));
    fs.writeFileSync(path.join(dir, name, 'package.json'),
      `{"name":"${name}","version":"0.0.0-clode-test","main":"index.js"}`);
    fs.writeFileSync(path.join(dir, name, 'index.js'), body);
  };
  // ESM-default shape: module.exports.default = fn (what require(esm) yields)
  mk('string-width', 'exports.default=(...a)=>"SW:"+JSON.stringify(a);');
  mk('strip-ansi', 'exports.default=(s)=>"STRIP:"+s;');
  // CJS-function shape: module.exports = fn (proves `.default || m` falls back to m)
  mk('wrap-ansi', 'module.exports=(...a)=>"WRAP:"+JSON.stringify(a);');
  mk('slice-ansi', 'exports.default=(...a)=>"SLICE:"+JSON.stringify(a);');
  return dir;
}

for (const [api, call] of [['stripANSI', "Bun.stripANSI('x')"],
                           ['wrapAnsi', "Bun.wrapAnsi('x', 10)"]]) {
  test(`fail-loud: Bun.${api} exits with an install hint when its module is absent`, () => {
    const r = runShimChild(`${call}; console.log('CONTINUED');`);
    assert.notStrictEqual(r.status, 0, 'must exit non-zero when the dep is missing');
    assert.doesNotMatch(r.stdout, /CONTINUED/, 'must exit, not continue (every render needs it)');
    assert.match(r.stderr, /npm install/);
  });
}

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

test('forwards all args to the real modules and unwraps ESM .default', () => {
  const r = runShimChild(
    `console.log(Bun.stripANSI('\\u001b[31mhi\\u001b[0m'));
     console.log(Bun.wrapAnsi('hi there', 4, {hard:true}));`,
    { NODE_PATH: withFakes() });
  assert.match(r.stdout, /STRIP:\[31mhi\[0m/);                // default-export unwrapped
  assert.match(r.stdout, /WRAP:\["hi there",4,\{"hard":true\}\]/);        // CJS-function shape works
});
