// Text helpers in bun-shim.cjs drive TUI layout. Bun provides these natively;
// the shim must match closely enough that boxes/columns/wrapping render right.
// These pin the three bugs the demo surfaced:
//   - stringWidth over-counts zero-width / combining / ZWJ characters
//   - stripANSI leaves OSC sequences (hyperlinks, titles) in the text
//   - wrapAnsi is identity (never wraps) and so can't preserve style across breaks
const { test } = require('node:test');
const assert = require('node:assert');
const Bun = require('../libexec/bun-shim.cjs');
const { stringWidth, stripANSI, wrapAnsi } = Bun;

const E = '\x1b';

test('stringWidth: ascii is one column per char', () => {
  assert.strictEqual(stringWidth('hello'), 5);
  assert.strictEqual(stringWidth(''), 0);
});

test('stringWidth: CJK and basic emoji are two columns', () => {
  assert.strictEqual(stringWidth('中'), 2);
  assert.strictEqual(stringWidth('你好'), 4);
  assert.strictEqual(stringWidth('🚀'), 2);
});

test('stringWidth: combining marks add zero width', () => {
  assert.strictEqual(stringWidth('é'), 1);        // e + combining acute
  assert.strictEqual(stringWidth('á́'), 1);  // base + two marks
});

test('stringWidth: zero-width characters count as zero', () => {
  assert.strictEqual(stringWidth('a​b'), 2);  // ZWSP
  assert.strictEqual(stringWidth('a‍b'), 2);  // ZWJ
  assert.strictEqual(stringWidth('﻿hi'), 2);  // BOM / ZWNBSP
});

test('stringWidth: ignores ANSI escapes', () => {
  assert.strictEqual(stringWidth(`${E}[1mhi${E}[0m`), 2);
});

test('stringWidth: bare symbol emoji are one column without VS16', () => {
  // Terminal-dependent. We match the conservative wcwidth policy common on
  // clode's target platforms (and confirmed against the user's terminal): a lone
  // BMP symbol keeps text-width 1; only a VS16 selector promotes it to 2 (below).
  assert.strictEqual(stringWidth('✅'), 1);   // U+2705 check mark button
  assert.strictEqual(stringWidth('⭐'), 1);   // U+2B50 star
  assert.strictEqual(stringWidth('❌'), 1);   // U+274C cross mark
  assert.strictEqual(stringWidth('❗'), 1);   // U+2757 exclamation mark
});

test('stringWidth: VS16 promotes a text-presentation symbol to two columns', () => {
  // U+FE0F forces emoji presentation on the preceding base -> 2 cols. The VS16
  // itself stays zero-width; the width lands on the base.
  assert.strictEqual(stringWidth('⚠️'), 2);   // U+26A0 + U+FE0F
  assert.strictEqual(stringWidth('☀️'), 2);   // U+2600 + U+FE0F
  assert.strictEqual(stringWidth('▶️'), 2);   // U+25B6 + U+FE0F
  // Guards against over-promotion:
  assert.strictEqual(stringWidth('⚠'), 1);     // bare base, text presentation, 1 col
  assert.strictEqual(stringWidth('a️'), 1); // VS16 after a non-emoji is ignored
});

test('wrapAnsi: emoji display width counts toward the wrap column', () => {
  // astral emoji are 2 cols each; four = 8, so at width 5 they must split.
  // A no-space run only breaks under hard wrap (native soft-wraps long words).
  const out = wrapAnsi('🚀🚀🚀🚀', 5, { hard: true });
  const lines = out.split('\n');
  assert.strictEqual(lines.length, 2, 'expected the 8-col run to wrap to two lines');
  for (const line of lines) assert.ok(stringWidth(line) <= 5, `line too wide: ${line}`);
  assert.strictEqual(stripANSI(out).replace(/\n/g, ''), '🚀🚀🚀🚀');
});

test('stripANSI: removes SGR/CSI sequences', () => {
  assert.strictEqual(stripANSI(`${E}[1mbold${E}[0m`), 'bold');
  assert.strictEqual(stripANSI(`${E}[38;5;201mpink${E}[0m`), 'pink');
  assert.strictEqual(stripANSI(`${E}[2Aup`), 'up');
});

test('stripANSI: removes OSC hyperlinks and titles', () => {
  // OSC 8 hyperlink, ST-terminated
  assert.strictEqual(
    stripANSI(`${E}]8;;https://example.com${E}\\link${E}]8;;${E}\\`),
    'link');
  // OSC title, ST-terminated
  assert.strictEqual(stripANSI(`${E}]0;window title${E}\\after`), 'after');
  // OSC, BEL-terminated
  assert.strictEqual(stripANSI(`${E}]0;t\x07after`), 'after');
});

test('wrapAnsi: short text is returned unchanged', () => {
  assert.strictEqual(wrapAnsi('hi', 80), 'hi');
});

test('wrapAnsi: preserves explicit newlines', () => {
  assert.strictEqual(wrapAnsi('a\nb', 80), 'a\nb');
});

test('wrapAnsi: wraps long text so every line fits the width', () => {
  const text = 'the quick brown fox jumps over the lazy dog again and again';
  const out = wrapAnsi(text, 20);
  const lines = out.split('\n');
  assert.ok(lines.length > 1, 'expected multiple lines');
  for (const line of lines) assert.ok(stringWidth(line) <= 20, `line too wide: ${line}`);
  // no words lost or reordered
  assert.strictEqual(stripANSI(out).split('\n').join(' '), text);
});

test('wrapAnsi: hard:false (default) does NOT break an over-long word', () => {
  // Native wrap-ansi soft-wraps by default: a word longer than the width overflows.
  assert.strictEqual(wrapAnsi('x'.repeat(10), 4), 'x'.repeat(10));
});

test('wrapAnsi: hard:true breaks an over-long word to fit', () => {
  const out = wrapAnsi('x'.repeat(10), 4, { hard: true });
  const lines = out.split('\n');
  assert.ok(lines.length > 1, 'expected the long word to break');
  for (const line of lines) assert.ok(stringWidth(line) <= 4, `line too wide: ${line}`);
  assert.strictEqual(stripANSI(out).replace(/\n/g, ''), 'x'.repeat(10));
});

test('wrapAnsi: honors the options object (it used to ignore the 3rd arg)', () => {
  const text = 'the quick brown fox';
  assert.notStrictEqual(
    wrapAnsi(text, 9, { trim: true,  hard: true }),
    wrapAnsi(text, 9, { trim: false, hard: true }));
});

test('wrapAnsi: trim:false returns fitting text byte-for-byte (input editor relies on this)', () => {
  // The editor computes the cursor from the buffer and renders the wrapped string; if
  // they disagree it indexes past the end and the TUI crashes. The editor passes trim:false.
  const o = { trim: false };
  assert.strictEqual(wrapAnsi('hello  world', 80, o), 'hello  world');   // internal run
  assert.strictEqual(wrapAnsi('   indented', 80, o), '   indented');     // leading
  assert.strictEqual(wrapAnsi('trailing   ', 80, o), 'trailing   ');     // trailing
  assert.strictEqual(wrapAnsi('a\tb', 80, o), 'a\tb');                   // tab kept verbatim
  assert.strictEqual(wrapAnsi('    ', 80, o), '    ');                   // spaces-only
  assert.strictEqual(wrapAnsi('a\n  b', 80, o), 'a\n  b');               // indent after newline
});

test('wrapAnsi: trim:false preserves wrap-boundary whitespace (renderer mode)', () => {
  // The renderer wraps with {trim:false,hard:true} and positions inline-code highlights
  // by character offset into the result. Dropping wrap-boundary spaces (the old bug)
  // shifted every highlight after a wrap. Native keeps them:
  assert.strictEqual(
    wrapAnsi('the quick brown fox', 9, { trim: false, hard: true }),
    'the quick\n brown \nfox');
});

test('wrapAnsi: trim:true collapses the boundary and left-justifies continuations', () => {
  assert.strictEqual(
    wrapAnsi('the quick brown fox', 9, { trim: true, hard: true }),
    'the quick\nbrown fox');
});

test('wrapAnsi: inverse inline-code (the renderer style) stays balanced across a wrap', () => {
  // Inline code is `[7m … [27m` (reverse on/off). Across a wrap each line must open and
  // close its own reverse span with the matching code — a leak here is the misplaced
  // TUI highlighting we are fixing.
  const out = wrapAnsi(`hi ${E}[7minline code here${E}[27m bye`, 9, { trim: false, hard: true });
  for (const line of out.split('\n')){
    assert.ok(stringWidth(line) <= 9, `line too wide: ${JSON.stringify(line)}`);
    const opens  = (line.match(/\x1b\[7m/g)  || []).length;
    const closes = (line.match(/\x1b\[27m/g) || []).length;
    assert.strictEqual(opens, closes, `unbalanced inverse on line: ${JSON.stringify(line)}`);
  }
  assert.strictEqual(stripANSI(out).split(/\s+/).filter(Boolean).join(' '), 'hi inline code here bye');
});

test('wrapAnsi: closes the active style before each wrap and reopens it after', () => {
  // Native closes with the style's specific reset code (fg -> 39), not a blanket [0m,
  // and reopens the style on the next line so color neither bleeds nor drops.
  const text = 'green text that is long enough to span several wrapped lines here';
  const out = wrapAnsi(`${E}[32m${text}${E}[0m`, 20);
  const lines = out.split('\n');
  assert.ok(lines.length > 1, 'expected multiple lines');
  for (const line of lines){
    assert.ok(stringWidth(line) <= 20, `line too wide: ${line}`);
    const opens  = (line.match(/\x1b\[32m/g) || []).length;
    const closes = (line.match(/\x1b\[(?:39|0)m/g) || []).length;
    assert.ok(opens >= 1, `line lost its color: ${JSON.stringify(line)}`);
    assert.strictEqual(opens, closes, `unbalanced color on line: ${JSON.stringify(line)}`);
  }
  assert.strictEqual(stripANSI(out).split('\n').join(' '), text);
});
