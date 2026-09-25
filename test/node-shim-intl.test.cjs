'use strict';
// Characterization: the node-shim Intl polyfill (modules/intl.cjs) under tjs.
// quickjs-ng ships no Intl, so the bundle's `new Intl.NumberFormat(...)` was
// `new undefined(...)` → TypeError "not a function" the instant the interactive
// TUI rendered token counts. These lock the en-US output shapes the bundle uses,
// and (for NumberFormat, the crash site) assert parity with host node.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { skipUnlessTjs, LOADER, tjsPath } = require('./node-shim-helper.cjs');

function fixture(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-intl-'));
  const f = path.join(dir, 'fx.cjs');
  fs.writeFileSync(f, body);
  return f;
}
function runTjs(f) {
  const r = spawnSync(tjsPath(), ['run', LOADER, f], { encoding: 'utf8', timeout: 20000 });
  return (r.stdout || '').trim();
}
function runNode(f) {
  const r = spawnSync(process.execPath, [f], { encoding: 'utf8', timeout: 20000 });
  return (r.stdout || '').trim();
}

// The exact NumberFormat calls the 2.1.204 bundle makes (compact token counts,
// grouped standard). These are the crash site — assert node parity.
const NUMBER_FIXTURE = `
  const out = [];
  const cases = [
    [12345, { notation: 'compact', maximumFractionDigits: 1 }],
    [1234567, { notation: 'compact', maximumFractionDigits: 1 }],
    [999, { notation: 'compact', maximumFractionDigits: 1 }],
    [1000000, { notation: 'compact', maximumFractionDigits: 1, minimumFractionDigits: 1 }],
    [1234.5, {}],
    [1234567.89, { maximumFractionDigits: 0 }],
    [0.5, { minimumFractionDigits: 2 }],
  ];
  for (const [n, o] of cases) out.push(new Intl.NumberFormat('en-US', o).format(n));
  console.log(JSON.stringify(out));
`;

test('Intl.NumberFormat under tjs matches host node for the bundle option shapes', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = fixture(NUMBER_FIXTURE);
  const tjsOut = runTjs(f);
  const nodeOut = runNode(f);
  assert.strictEqual(tjsOut, nodeOut, `tjs=${tjsOut} node=${nodeOut}`);
  assert.deepStrictEqual(JSON.parse(tjsOut), ['12.3K', '1.2M', '999', '1.0M', '1,234.5', '1,234,568', '0.50']);
});

test('Intl legacy constructors are callable without `new` (matches node) — the TUI crash', (t) => {
  if (skipUnlessTjs(t)) return;
  // ECMA-402: Collator/NumberFormat/DateTimeFormat work WITHOUT `new` (web-compat);
  // the newer ones REQUIRE `new`. The bundle's TUI does `Intl.DateTimeFormat(...)`
  // with no `new`, and an ES6 `class` threw "class constructors must be invoked with
  // 'new'", crashing the interactive turn. Assert node-parity on both call forms.
  const f = fixture(`
    const out = {};
    for (const k of ['DateTimeFormat','NumberFormat','Collator']) {
      const C = Intl[k];
      const wn = new C('en-US'), nn = C('en-US');
      out[k] = { withNew: typeof (wn.format||wn.compare)==='function',
                 noNew: typeof (nn.format||nn.compare)==='function',
                 inst: (wn instanceof C) && (nn instanceof C) };
    }
    for (const k of ['Segmenter','RelativeTimeFormat','DisplayNames','Locale']) {
      try { Intl[k](['en']); out[k+'_noNew']='NO-THROW'; } catch { out[k+'_noNew']='throws'; }
    }
    console.log(JSON.stringify(out));
  `);
  const tjsOut = runTjs(f);
  const nodeOut = runNode(f);
  assert.strictEqual(tjsOut, nodeOut, `tjs=${tjsOut} node=${nodeOut}`);
  const o = JSON.parse(tjsOut);
  for (const k of ['DateTimeFormat', 'NumberFormat', 'Collator']) {
    assert.deepStrictEqual(o[k], { withNew: true, noNew: true, inst: true }, k);
  }
  for (const k of ['Segmenter', 'RelativeTimeFormat', 'DisplayNames', 'Locale']) {
    assert.strictEqual(o[k + '_noNew'], 'throws', k);
  }
});

test('Intl.DateTimeFormat under tjs formats the h23 timestamp shape the bundle uses', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = fixture(`
    const d = new Date(2026, 6, 8, 15, 4, 9);
    console.log(new Intl.DateTimeFormat('en-US', {
      hourCycle: 'h23', hour12: false, year: 'numeric', month: 'numeric', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).format(d));
  `);
  assert.strictEqual(runTjs(f), '7/08/2026, 15:04:09');
});

test('Intl.RelativeTimeFormat / Segmenter / Collator / DisplayNames / Locale exist and behave', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = fixture(`
    const out = {};
    out.rtf = new Intl.RelativeTimeFormat('en', {}).format(-3, 'day');
    out.seg = Array.from(new Intl.Segmenter('en', { granularity: 'grapheme' }).segment('aé')).length;
    out.coll = [new Intl.Collator('en').compare('a', 'b'), new Intl.Collator('en').compare('b', 'b')];
    out.dn = new Intl.DisplayNames(['en'], { type: 'language' }).of('en');
    out.loc = new Intl.Locale('en-US').toString();
    out.types = ['NumberFormat','DateTimeFormat','RelativeTimeFormat','Segmenter','Collator','DisplayNames','Locale']
      .every((k) => typeof Intl[k] === 'function');
    console.log(JSON.stringify(out));
  `);
  const out = JSON.parse(runTjs(f));
  assert.strictEqual(out.rtf, '3 days ago');
  assert.strictEqual(out.seg, 2);
  assert.deepStrictEqual(out.coll, [-1, 0]);
  assert.strictEqual(out.loc, 'en-US');
  assert.strictEqual(out.types, true);
});

// ECMA-402 gives %SegmentsPrototype% TWO members: [Symbol.iterator] and
// containing(). This polyfill shipped only the iterator for a year, and the gap
// read as ABSENCE rather than as an error — `segments.containing` was plain
// `undefined`, so a caller got a NAMELESS quickjs "TypeError: not a function"
// from a line that never mentions Intl. That is how it surfaced: npm slice-ansi
// (which then backed Bun.sliceAnsi, new in upstream 2.1.278) tokenises with
// `graphemeSegments.containing(index)`, so every Ink layout pass that truncated
// a string threw, upstream caught it and logged "frame dropped", and the
// interactive TUI emitted 518 bytes of pure control sequences without one
// printable cell — while `-p` stayed completely green.
//
// Asserted against HOST NODE, not against our own past output: node has the real
// ICU implementation, so a parity diff is a real answer rather than a
// characterisation of whatever we happened to emit.
const CONTAINING_FIXTURE = `
  const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const out = [];
  const shape = (s) => (s === undefined ? null : { segment: s.segment, index: s.index });
  for (const input of ['abc', 'a\\u0300bc', '\\u65e5\\u672c\\u8a9e']) {
    const segments = seg.segment(input);
    const row = [];
    for (let i = -1; i <= input.length; i++) row.push(shape(segments.containing(i)));
    out.push(row);
  }
  console.log(JSON.stringify(out));
`;

test('Intl.Segmenter segments.containing() matches host node (the dead-TUI gap)', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = fixture(CONTAINING_FIXTURE);
  const tjsOut = runTjs(f);
  const nodeOut = runNode(f);
  assert.strictEqual(tjsOut, nodeOut, `tjs=${tjsOut} node=${nodeOut}`);
  const rows = JSON.parse(tjsOut);
  // Out-of-range indices are undefined at BOTH ends, and every in-range index
  // maps to the cluster that covers it — a combining sequence answers with the
  // whole cluster from either of its two code-unit positions.
  assert.strictEqual(rows[0][0], null, 'containing(-1) must be undefined');
  assert.strictEqual(rows[0][rows[0].length - 1], null, 'containing(length) must be undefined');
  assert.deepStrictEqual(rows[1][1], { segment: 'a\u0300', index: 0 });
  assert.deepStrictEqual(rows[1][2], { segment: 'a\u0300', index: 0 });
});
