// test/semver.test.cjs — Bun.semver backed by the npm `semver` dep (the ext-dep
// pattern). Correctness (the "2.1.179 > 2.1.70" Remote Control gate, ranges, etc.)
// is npm semver's job now; we only test the seam: forward to the real module, and
// fail loud when it's absent. semver feeds version gates that run early, so a miss
// is fatal (exit), like the render utils.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { runShimChild } = require('./isolated-shim.cjs');

// Fake `semver` (CJS named exports, like the real one): echo args so we can prove
// order->compare and satisfies->satisfies forward through.
function withFakeSemver() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-semver-'));
  fs.mkdirSync(path.join(dir, 'semver'));
  fs.writeFileSync(path.join(dir, 'semver', 'package.json'),
    '{"name":"semver","version":"0.0.0-clode-test","main":"index.js"}');
  fs.writeFileSync(path.join(dir, 'semver', 'index.js'),
    'exports.compare=(...a)=>"CMP:"+JSON.stringify(a);exports.satisfies=(...a)=>"SAT:"+JSON.stringify(a);');
  return dir;
}

for (const [name, call] of [['order', "Bun.semver.order('1.0.0','2.0.0')"],
                            ['satisfies', "Bun.semver.satisfies('1.0.0','>=1.0.0')"]]) {
  test(`fail-loud: Bun.semver.${name} exits with an install hint when semver is absent`, () => {
    const r = runShimChild(`${call}; console.log('CONTINUED');`);
    assert.notStrictEqual(r.status, 0);
    assert.doesNotMatch(r.stdout, /CONTINUED/);
    assert.match(r.stderr, /semver/);
    assert.match(r.stderr, /npm install/);
  });
}

test('forwards to the real semver: order -> compare, satisfies -> satisfies', () => {
  const r = runShimChild(
    `console.log(Bun.semver.order('1.0.0','2.0.0'));
     console.log(Bun.semver.satisfies('1.0.0','>=1.0.0'));`,
    { NODE_PATH: withFakeSemver() });
  assert.match(r.stdout, /CMP:\["1\.0\.0","2\.0\.0"\]/);
  assert.match(r.stdout, /SAT:\["1\.0\.0",">=1\.0\.0"\]/);
});
