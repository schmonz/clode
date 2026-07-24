'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  parseTimeL, parsePeakRss, rssStrategy, resolveLaunch, TIME_BIN,
} = require('../bench/lib/measure.cjs');

// ---- Peak-RSS parsing, normalized to BYTES across every fleet platform ----

// macOS `/usr/bin/time -l`: "<bytes>  maximum resident set size" (already bytes).
const DARWIN = [
  '        1.23 real         0.80 user         0.30 sys',
  '            84934656  maximum resident set size',
  '                   0  average shared memory size',
].join('\n');

// *BSD `/usr/bin/time -l`: same label, but the value is KILOBYTES.
const BSD = [
  '        2.10 real         1.40 user         0.50 sys',
  '            82944  maximum resident set size',
].join('\n');

// Linux GNU `/usr/bin/time -v`: "Maximum resident set size (kbytes): N".
const GNU = [
  '\tCommand being timed: "quaude -p hi"',
  '\tMaximum resident set size (kbytes): 80996',
  '\tExit status: 0',
].join('\n');

test('darwin: maximum resident set size is bytes (no scaling)', () => {
  assert.strictEqual(parsePeakRss(DARWIN, rssStrategy('darwin')), 84934656);
});

test('netbsd/*BSD: same label but kilobytes → scaled to bytes', () => {
  assert.strictEqual(parsePeakRss(BSD, rssStrategy('netbsd')), 82944 * 1024);
  assert.strictEqual(parsePeakRss(BSD, rssStrategy('freebsd')), 82944 * 1024);
  assert.strictEqual(parsePeakRss(BSD, rssStrategy('openbsd')), 82944 * 1024);
});

test('linux GNU time -v: kbytes label → scaled to bytes', () => {
  assert.strictEqual(parsePeakRss(GNU, rssStrategy('linux')), 80996 * 1024);
});

test('unknown platform has no strategy → RSS null (wall-only)', () => {
  assert.strictEqual(rssStrategy('haiku'), null);
  assert.strictEqual(rssStrategy('sunos'), null);
  assert.strictEqual(parsePeakRss(DARWIN, rssStrategy('haiku')), null);
});

test('parsePeakRss returns null when the line is absent', () => {
  assert.strictEqual(parsePeakRss('no rss here', rssStrategy('darwin')), null);
});

test('back-compat parseTimeL still parses the macOS bytes format', () => {
  assert.strictEqual(parseTimeL(DARWIN).peakRssBytes, 84934656);
  assert.strictEqual(parseTimeL('nope').peakRssBytes, null);
});

// ---- Launch resolution: wrap in time(1) when usable, else run direct ----

test('resolveLaunch wraps in time(1) with the platform flag when present', () => {
  const l = resolveLaunch({ bin: '/b/quaude', args: ['-p', 'hi'], platform: 'darwin', existsSync: () => true });
  assert.deepStrictEqual(l.argv, [TIME_BIN, '-l', '/b/quaude', '-p', 'hi']);
  assert.ok(l.strategy);
});

test('resolveLaunch uses -v on linux', () => {
  const l = resolveLaunch({ bin: '/b/quaude', args: [], platform: 'linux', existsSync: () => true });
  assert.deepStrictEqual(l.argv, [TIME_BIN, '-v', '/b/quaude']);
});

test('resolveLaunch falls back to a direct run when time(1) is absent', () => {
  const l = resolveLaunch({ bin: '/b/quaude', args: ['-p', 'hi'], platform: 'darwin', existsSync: () => false });
  assert.deepStrictEqual(l.argv, ['/b/quaude', '-p', 'hi']);
  assert.strictEqual(l.strategy, null);
});

test('resolveLaunch runs direct on an unknown platform (no strategy)', () => {
  const l = resolveLaunch({ bin: '/b/quaude', args: [], platform: 'haiku', existsSync: () => true });
  assert.deepStrictEqual(l.argv, ['/b/quaude']);
  assert.strictEqual(l.strategy, null);
});
