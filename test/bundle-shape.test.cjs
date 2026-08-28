'use strict';
// The bundle SHAPE RECORD is an early-warning trend line for upstream's packaging, kept
// because upstream repacks constantly and not in one direction: 2.1.243 split into 1375
// chunks, 2.1.246 undid half of it, 2.1.250 split into 1770 and made the chunks require()
// each other cyclically — all while the binary shrank 345 -> 197 MB. Those look like Bun
// bundler knobs tuned for install size and cold start, so the useful thing is not to model
// one shape but to notice the shape moving.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
// NOT docs/ — that directory is gitignored, so a record kept there is invisible to
// everyone but its author and the gate would fail on a fresh clone.
const TSV = path.join(__dirname, 'fixtures', 'bundle-shapes.tsv');

function rows() {
  const lines = fs.readFileSync(TSV, 'utf8').trim().split('\n');
  const header = lines[0].split('\t');
  return { header, rows: lines.slice(1).map((l) => Object.fromEntries(l.split('\t').map((v, i) => [header[i], v]))) };
}

test('the shape record header matches the tool that writes it', async () => {
  const { FIELDS } = await import('../scripts/bundle-shape.mjs');
  assert.deepStrictEqual(rows().header, FIELDS,
    'test/fixtures/bundle-shapes.tsv header drifted from bundle-shape.mjs FIELDS — a record whose '
    + 'columns do not mean what the writer thinks is worse than no record');
});

// THE ONE THAT MATTERS. Everything clode does rests on the container holding real
// JavaScript. Bun can emit JSC bytecode instead (`bun build --bytecode`), and cold start is
// exactly what upstream is optimising, so that knob is plausibly one release away. If it is
// ever flipped, extraction does not get harder — it becomes impossible. This test is the
// tripwire: the day a recorded release says false, this goes red and the BACKLOG
// contingency is the next thing to read.
test('every recorded release still ships extractable JavaScript', () => {
  const bad = rows().rows.filter((r) => r.jsExtractable !== 'true').map((r) => r.version);
  assert.deepStrictEqual(bad, [],
    'a recorded release has NO extractable JavaScript. If upstream enabled bun --bytecode, '
    + 'clode cannot carry JSC bytecode and the extraction strategy needs replacing, not '
    + 'patching. Read the JSC-bytecode contingency in BACKLOG before touching anything.');
});

// History is the whole value: a single row tells you nothing, five tell you upstream
// oscillates. Deleting rows to "clean up" would quietly destroy the trend.
test('the record keeps its history: the shapes upstream has actually shipped', () => {
  const seen = rows().rows.map((r) => r.version);
  for (const v of ['2.1.238', '2.1.243', '2.1.246', '2.1.250']) {
    assert.ok(seen.includes(v), `${v} is missing from the shape record — it is one of the `
      + 'four distinct shapes upstream has shipped (single-file, split, half-undone, '
      + 're-split-with-cycles) and the extractor corpus is built from them');
  }
  const single = rows().rows.find((r) => r.version === '2.1.238');
  assert.strictEqual(single.chunks, '0', '2.1.238 is the pre-split single-file shape');
  const cyclic = rows().rows.find((r) => r.version === '2.1.250');
  assert.ok(Number(cyclic.cjsRequireOfChunk) > 0,
    '2.1.250 is the release that introduced CJS require() of chunks — the P0 in BACKLOG');
});
