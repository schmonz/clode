'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { comparePaintResults } = require('../scripts/lib/paint-probe.cjs');
const { paintCorpus, PAINT_PARTS } = require('../scripts/lib/paint-corpus.cjs');

test('identical paint results compare clean and count every op', () => {
  const sc = [{ part: 'ascii', w: 5, h: 1, ops: [{ seg: 'ab', x: 0, y: 0 }] }];
  const r = { runtime: 'x', results: [[{ ret: [2, 0, 2], grew: false, screen: [['a|0||n', 'b|0||n', '#', '#', '#']] }]] };
  const d = comparePaintResults(sc, r, JSON.parse(JSON.stringify(r)));
  assert.deepStrictEqual(d.findings, []);
  assert.strictEqual(d.examined, 1);
});

test('a damage difference and a cell difference are each named with part, scenario and op', () => {
  const sc = [{ part: 'wide', w: 5, h: 1, ops: [{ seg: 'x', x: 4, y: 0 }] }];
  const n = { runtime: 'n', results: [[{ ret: [5, 4, 5], grew: false, screen: [['#', '#', '#', '#', 'x|0||n']] }]] };
  const o = { runtime: 'o', results: [[{ ret: [5, 4, 6], grew: false, screen: [['#', '#', '#', '#', 'y|0||n']] }]] };
  const d = comparePaintResults(sc, n, o);
  assert.strictEqual(d.count, 1);
  assert.match(d.findings[0], /^wide #0 op 0: /);
  assert.match(d.findings[0], /ret native \[5,4,5\] ours \[5,4,6\]/);
});

test('a scenario where one side threw and the other did not is a finding, named by the message', () => {
  const sc = [{ part: 'setcell', w: 5, h: 1, ops: [{ set: { x: -1, y: 0, text: 'q', style: '', link: '', width: 0 } }] }];
  const n = { runtime: 'n', results: [[{ threw: 'boom' }]] };
  const o = { runtime: 'o', results: [[{ ret: [0, 0, 0], grew: null, screen: [['#', '#', '#', '#', '#']] }]] };
  const d = comparePaintResults(sc, n, o);
  assert.strictEqual(d.count, 1);
  assert.match(d.findings[0], /^setcell #0 op 0: threw native "boom" ours undefined/);
});

test('both sides throwing the SAME message compares clean', () => {
  const sc = [{ part: 'setcell', w: 5, h: 1, ops: [{ set: { x: -1, y: 0, text: 'q', style: '', link: '', width: 0 } }] }];
  const n = { runtime: 'n', results: [[{ threw: 'boom' }]] };
  const o = { runtime: 'o', results: [[{ threw: 'boom' }]] };
  const d = comparePaintResults(sc, n, o);
  assert.deepStrictEqual(d.findings, []);
});

// The paint gate's floor is in ops (ruling R2), so a scenario that diverges at its first op must
// still count every op as examined: otherwise a real difference reads as a BLIND guard (BROKEN,
// its findings unprinted) instead of a VIOLATION. Later ops are still judged; only the first
// difference in a scenario is reported, since what follows it proves nothing new.
test('a scenario that diverges at its first op still examines every op, and is one finding', () => {
  const sc = [{ part: 'overwrite', w: 5, h: 1, ops: [{ seg: 'ab', x: 0, y: 0 }, { seg: 'x', x: 1, y: 0 }] }];
  const n = { runtime: 'n', results: [[{ ret: [2, 0, 2], grew: false, screen: [] }, { ret: [2, 1, 2], grew: false, screen: [] }]] };
  const o = { runtime: 'o', results: [[{ ret: [2, 0, 1], grew: false, screen: [] }, { ret: [2, 0, 2], grew: false, screen: [] }]] };
  const d = comparePaintResults(sc, n, o);
  assert.strictEqual(d.examined, 2);
  assert.strictEqual(d.count, 1);
  assert.deepStrictEqual(d.findings, ['overwrite #0 op 0: ret native [2,0,2] ours [2,0,1]']);
});

test('the corpus has every named part, and every part is non-empty', () => {
  const c = paintCorpus();
  for (const p of PAINT_PARTS) assert.ok(c.some((s) => s.part === p), `part ${p} missing`);
  assert.ok(c.length >= 390, `only ${c.length} scenarios`);   // a loose floor, well under the
  // corpus's current size, so this number never needs to track it; the gate's PART_FLOORS
  // pin each part and the total exactly.
});
