'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const R = require('../libexec/build-report.cjs');
const { Composer } = require('../libexec/build-compose.cjs');

test('worker lines arriving over the seam land in the composed totals', () => {
  const c = new Composer();
  const lines = [];
  const r = new R.Reporter({ emit: (l) => lines.push(l), now: () => 0 });
  r.plan([{ name: 'compile', total: 1795 }]);
  r.start('compile'); r.progress('compile', 900); r.finish('compile', 1795);
  for (const l of lines) c.ingest('worker', l);
  assert.deepStrictEqual(c.totals(), { done: 1795, total: 1795 });
});

test('non-protocol child output is passed through, not eaten', () => {
  const c = new Composer();
  const passed = [];
  const sink = (l) => { if (!c.ingest('worker', l)) passed.push(l); };
  sink('compiled 1795 modules -> graph.qbc');
  sink(R.serialize(R.plan([{ name: 'compile', total: 1 }])));
  assert.deepStrictEqual(passed, ['compiled 1795 modules -> graph.qbc']);
});

test('clode-fuse declares its own steps rather than only the worker s', () => {
  const src = require('node:fs').readFileSync(require.resolve('../libexec/clode-fuse.cjs'), 'utf8');
  assert.match(src, /build-compose\.cjs/, 'the builder composes');
  assert.match(src, /build-report\.cjs/, 'and declares its own steps too');
});
