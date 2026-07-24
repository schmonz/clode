'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { parseTimeL } = require('../bench/lib/measure.cjs');

// macOS `/usr/bin/time -l` prints "<bytes>  maximum resident set size".
const SAMPLE = [
  '        1.23 real         0.80 user         0.30 sys',
  '            84934656  maximum resident set size',
  '                   0  average shared memory size',
].join('\n');

test('parseTimeL extracts peak RSS in bytes', () => {
  assert.strictEqual(parseTimeL(SAMPLE).peakRssBytes, 84934656);
});

test('parseTimeL returns null when the line is absent', () => {
  assert.strictEqual(parseTimeL('no rss here').peakRssBytes, null);
});
