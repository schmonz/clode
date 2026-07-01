// test/text-utils.test.cjs — Bun.stringWidth / stripANSI / wrapAnsi backed by the
// npm string-width / strip-ansi / wrap-ansi deps (the ext-dep pattern). These are
// CORE (every render), so a missing one is fatal: write the install hint and exit,
// like ws — clode can't render without them, so there's nothing to recover.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { runShimChild } = require('./isolated-shim.cjs');

// Fake string-width/strip-ansi/wrap-ansi on a NODE_PATH dir. string-width and
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
  return dir;
}

for (const [api, call] of [['stringWidth', "Bun.stringWidth('x')"],
                           ['stripANSI', "Bun.stripANSI('x')"],
                           ['wrapAnsi', "Bun.wrapAnsi('x', 10)"]]) {
  test(`fail-loud: Bun.${api} exits with an install hint when its module is absent`, () => {
    const r = runShimChild(`${call}; console.log('CONTINUED');`);
    assert.notStrictEqual(r.status, 0, 'must exit non-zero when the dep is missing');
    assert.doesNotMatch(r.stdout, /CONTINUED/, 'must exit, not continue (every render needs it)');
    assert.match(r.stderr, /npm install/);
  });
}

test('forwards all args to the real modules and unwraps ESM .default', () => {
  const r = runShimChild(
    `console.log(Bun.stringWidth('hi', {countAnsiEscapeCodes:true}));
     console.log(Bun.stripANSI('\\u001b[31mhi\\u001b[0m'));
     console.log(Bun.wrapAnsi('hi there', 4, {hard:true}));`,
    { NODE_PATH: withFakes() });
  assert.match(r.stdout, /SW:\["hi",\{"countAnsiEscapeCodes":true\}\]/);  // 2nd arg forwarded
  assert.match(r.stdout, /STRIP:\[31mhi\[0m/);                // default-export unwrapped
  assert.match(r.stdout, /WRAP:\["hi there",4,\{"hard":true\}\]/);        // CJS-function shape works
});
