'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { rgToUgrep, RgTranslateError } = require('../libexec/bun-shim.cjs');
const { OK, THROWS } = require('./rg-cases.cjs');

for (const c of OK) {
  test(`rgToUgrep: ${JSON.stringify(c.in)}`, () => {
    assert.deepStrictEqual(rgToUgrep(c.in), c.out);
  });
}
for (const c of THROWS) {
  test(`rgToUgrep rejects ${c.flag}`, () => {
    assert.throws(() => rgToUgrep(c.in), (e) =>
      e instanceof RgTranslateError && e.flag === c.flag && e.code === 'CLODE_RG_UNTRANSLATABLE');
  });
}
