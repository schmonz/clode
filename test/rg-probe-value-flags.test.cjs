'use strict';
// The carve-argv reader (scripts/lib/rg-probe.cjs carveRgArgvShapes) takes the literal after a flag as that flag's value
// only for the flags in its RG_VALUE_FLAGS. 2.1.330's model-family listing passes `"--max-count","20"`; the map lacked
// --max-count, so the reader built `--max-count --max-filesize 1M ...` and rg-carve-argv-answered reported quaude's rg
// refusing an argv the carve never builds. Every flag quaude's rg reads a value for must be in that map, with a
// placeholder the parser accepts, so the next value flag quaude's rg learns cannot be misread the same way.
// forced-win32: spawn-injected: no test here spawns; each compares two flag tables and parses an argv in-process
const { test } = require('node:test');
const assert = require('node:assert');
const { RG_VALUE_FLAGS } = require('../scripts/lib/rg-probe.cjs');
const rgn = require('../libexec/rg-native.cjs');

test('every value flag quaude\'s rg reads is one the carve-argv reader takes a value for, its placeholder accepted', () => {
  assert.ok(rgn.RG_VALUE_FLAG_NAMES.length >= 28, `${rgn.RG_VALUE_FLAG_NAMES.length} flags`);
  for (const flag of rgn.RG_VALUE_FLAG_NAMES) {
    assert.ok(RG_VALUE_FLAGS.has(flag), `${flag}: missing from scripts/lib/rg-probe.cjs RG_VALUE_FLAGS`);
    const pattern = flag === '-e' || flag === '--regexp' ? [] : ['x'];
    const r = rgn.parseRgSearch([flag, RG_VALUE_FLAGS.get(flag), ...pattern, '.']);
    assert.ok(r.spec, `${flag} ${RG_VALUE_FLAGS.get(flag)}: ${JSON.stringify(r)}`);
  }
});
