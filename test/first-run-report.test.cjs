'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { parseChunkLog, stepFindings, renderTranscript } = require('../scripts/lib/first-run-report.cjs');

const kinds = (f) => f.map((x) => x.kind);

test('first-run report: the 2026-11-25 frozen spinner is a finding, a live one is not', () => {
  const live = []; for (let ms = 100; ms <= 5000; ms += 100) live.push({ ms, text: `\r⠋ Extracting bundle… (${(ms / 1000).toFixed(1)}s)` });
  assert.deepStrictEqual(kinds(stepFindings({ name: 'build', chunks: live, exit: { ms: 5100, code: 0 } })), []);
  const frozen = [{ ms: 100, text: '\r⠋ Extracting bundle… (0.0s)' }, { ms: 14365, text: '\r⠙ Extracting bundle… (14.3s)' }];
  const f = stepFindings({ name: 'build', chunks: frozen, exit: { ms: 14400, code: 0 } });
  assert.deepStrictEqual(kinds(f), ['frozen-spinner']);
  assert.strictEqual(f[0].ms, 14265);
  assert.match(f[0].detail, /Extracting bundle/);
});

test('first-run report: silence, a wide line, a failed or stopped step', () => {
  assert.deepStrictEqual(kinds(stepFindings({ name: 'fetch', chunks: [{ ms: 12000, text: 'hello\n' }], exit: { ms: 12001, code: 0 } })), ['silence']);
  assert.deepStrictEqual(kinds(stepFindings({ name: 'clode', chunks: [{ ms: 5, text: `${'x'.repeat(81)}\n` }], exit: { ms: 6, code: 0 } })), ['wide-line']);
  assert.deepStrictEqual(kinds(stepFindings({ name: 'clode', chunks: [{ ms: 5, text: `\x1b[1m${'x'.repeat(80)}\x1b[0m\n` }], exit: { ms: 6, code: 0 } })), []);
  assert.deepStrictEqual(kinds(stepFindings({ name: 'build', chunks: [{ ms: 5, text: 'no\n' }], exit: { ms: 6, code: 1 } })), ['exit']);
  assert.deepStrictEqual(kinds(stepFindings({ name: 'tui', chunks: [{ ms: 5, text: 'x' }], exit: null, lineMode: false })), ['no-exit']);
});

test('first-run harness: the user hands in nothing (no CLODE_*, no Claude Code variable, an empty HOME)', async () => {
  const { userEnv } = await import('../scripts/first-run.mjs');
  const env = userEnv({ PATH: '/usr/bin', home: '/h', tmp: '/t' });
  assert.deepStrictEqual(Object.keys(env).sort(), ['CLODE_AUTOUPDATER_BECAUSE', 'HOME', 'LANG', 'PATH', 'TERM', 'TMPDIR']);
  assert.strictEqual(env.HOME, '/h');
});

test('first-run report: a chunk log parses, and the transcript collapses spinner frames', () => {
  const log = [{ ms: 10, text: '\r⠋ Fetching (0.0s)' }, { ms: 110, text: '\r⠙ Fetching (0.1s)' }, { ms: 200, text: '\rdone\n' }, { ms: 210, exit: { code: 0, signal: null } }]
    .map((r) => JSON.stringify(r)).join('\n');
  const { chunks, exit } = parseChunkLog(log);
  assert.strictEqual(chunks.length, 3);
  assert.deepStrictEqual(exit, { ms: 210, code: 0, signal: null });
  const t = renderTranscript([{ command: 'clode fetch claude', chunks, exit }]);
  assert.match(t, /^\$ clode fetch claude {4}\[0\.2s, exit 0\]$/m);
  assert.strictEqual((t.match(/Fetching/g) || []).length, 1, t);
  assert.match(t, /Fetching \(0\.1s\)/);
});
