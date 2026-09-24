'use strict';
// The corpora every phase-3 differential runs over. Each is a plain string[]; what a
// string MEANS (one code point, one GraphemeBreakTest line, one emoji sequence, one
// bundle literal) is the corpus's business, not the comparator's.

function corpusCodePoints() {
  const out = new Array(0x110000);
  for (let cp = 0; cp < 0x110000; cp++) {
    out[cp] = (cp >= 0xd800 && cp <= 0xdfff) ? String.fromCharCode(cp) : String.fromCodePoint(cp);
  }
  return out;
}

// Cases a single code point cannot express. Each line names why it is here.
function corpusComposed() {
  return [
    'é',                       // base + combining mark
    'a‮b́',                // a bidi control (substitute range) inside a would-be cluster
    '‮́',                  // a bidi control followed by a mark it could absorb
    'e\x1b[1ḿ',                // an SGR escape between a base and its mark
    'e\x1b]8;;http://x\x07́',   // an OSC-8 between a base and its mark
    '\u{1f468}‍\u{1f469}‍\u{1f467}', // ZWJ family
    '\u{1f44d}\u{1f3fd}',            // emoji modifier
    '\u{1f1fa}\u{1f1f8}\u{1f1ec}',   // three regional indicators (pair + orphan)
    '❤️', '❤︎',  // VS16 and VS15 on a text-default emoji
    'क्ष',            // Devanagari conjunct (GB9c, Unicode 15.1)
    '각',            // Hangul L V T
    '\r\n', 'a\r\nb',                // CR LF
    'a\tb\t', '\t́',            // tabs, and a mark after a tab
    '؀a',                       // Prepend
    '\ud83d', 'a\udc00b',            // lone surrogates in context
  ];
}

// Code points -> string; a lone surrogate goes in as the one UTF-16 unit it is.
const H = (...cps) => cps.map((c) => ((c >= 0xd800 && c <= 0xdfff) ? String.fromCharCode(c) : String.fromCodePoint(c))).join('');

// The bun-cell probe corpus (task 4b): the multi-code-point contexts that separated native
// CellSegmenter from UAX #29 (libexec/unicode-text.cjs names each delta), measured 2026-09-24
// against 2.1.278 (Bun 1.4.3). First the ZWJ
// grid — `X ZWJ Y` for one representative of each class below, both ways round — whose
// joins follow Extended_Pictographic at Unicode 16.0.0 (the U+2701/U+2605 rows join; 17.0
// dropped them), then one group per delta, each string a case a single code point or the
// UCD corpora do not reach.
const ZWJ_CLASSES = [
  0x1f600, // ExtPict, wide
  0x2764, // ExtPict, narrow, an emoji width base
  0x00a9, // ExtPict, narrow, NOT an emoji width base (the measured override)
  0x2701, // ExtPict in 16.0 only
  0x2605, // ExtPict in 16.0 only, not Emoji
  0x1f476, // Emoji_Modifier_Base, wide
  0x261d, // Emoji_Modifier_Base, narrow
  0x1f3fb, // Emoji_Modifier
  0x0031, // Emoji, not ExtPict (a keycap base)
  0x0023, // the same, not a letter or digit
  0x1f1e6, // Regional Indicator
  0x2100, // So, not Emoji
  0x2e80, // So, not Emoji, wide
  0x1d100, // So, supplementary
  0x0061, 0x00e9, 0x03b1, // letters
  0x4e2d, // CJK
  0xac00, // Hangul LV
  0x0915, // Devanagari consonant (InCB)
];

function corpusCellProbes() {
  const out = [];
  for (const x of ZWJ_CLASSES) for (const y of ZWJ_CLASSES) out.push(H(x, 0x200d, y));
  const groups = [
    // MODIFIER-NEEDS-BASE: which code point before a modifier keeps it.
    [0x1f476, 0x308, 0x1f3fb], [0x1f476, 0x1f3fb, 0x1f3fb], [0x261d, 0xfe0f, 0x1f3fb], [0x1f468, 0x200d, 0x1f3fb],
    [0x600, 0x1f476, 0x1f3fb], [0x1f476, 0x200d, 0x1f476, 0x1f3fb], [0x61, 0x1f3fb], [0x1100, 0x1f3fb], [0x1f3fb, 0x308],
    [0x1f3fb, 0x200d, 0x1f600], [0x600, 0x1f3fb], [0x1f1e6, 0x1f3fb], [0x2764, 0x1f3fb], [0x1f600, 0x1f3fb],
    [0x1f476, 0x1f3fb, 0x200d, 0x1f600], [0x1f476, 0x903, 0x1f3fb], [0x1f476, 0x200d, 0x1f3fb], [0x61, 0x1f3ff, 0x1f476],
    // CC-CONTROLS-ONLY: Cc against the wider GCB=Control class.
    [0x600, 0x200b], [0x600, 0x1], [0x200b, 0x308, 0x903], [0x61, 0x200b], [0x200b, 0x61], [0x1100, 0x200b, 0x1161],
    [0x600, 0xd], [0xd, 0xa, 0x308], [0x85, 0x308], [0xad, 0x903], [0x2028, 0x903], [0xe0001, 0x903], [0x61, 0x0, 0x308],
    [0x1f600, 0x200d, 0x200b], [0x61, 0xd, 0x308], [0x7f, 0x308], [0xfeff, 0x61, 0x308], [0x600, 0x200b, 0x61],
    [0x890, 0x200b, 0x2764, 0xfe0f], [0x61, 0x2060, 0x903], [0x1d173, 0x903], [0x13430, 0x61],
    // CLUSTER-STATE-RESTARTS: a modifier that breaks away inside a GB9c or GB11 pattern.
    [0x915, 0x94d, 0x1f3fb, 0x915], [0x915, 0x94d, 0x1f3fb, 0x94d, 0x915], [0x915, 0x1f3fb, 0x94d, 0x915],
    [0x1f600, 0x1f3fb, 0x200d, 0x1f600], [0x1f476, 0x1f3fb, 0x1f3fb, 0x200d, 0x1f600], [0x1f600, 0x1f3fb, 0x308, 0x200d, 0x1f600],
    // GB11 and CLUSTER-DATA-16's Extended_Pictographic.
    [0x1f600, 0x903, 0x200d, 0x1f600], [0x1f600, 0x200d, 0x200d, 0x1f600], [0x1f600, 0xfe0f, 0x200d, 0x1f600],
    [0x1f600, 0xe0020, 0x200d, 0x1f600], [0x1f600, 0x200d, 0x308, 0x1f600], [0x600, 0x1f600, 0x200d, 0x1f600],
    [0x1f600, 0x200d, 0x1f600, 0x200d, 0x1f600], [0x200d, 0x1f600], [0x2701, 0x200d, 0x2701, 0x200d, 0x2605],
    // GB9c and CLUSTER-DATA-16's InCB; GCB 16.0 against 17.0.
    [0x915, 0x94d, 0x200d, 0x937], [0x915, 0x200d, 0x94d, 0x937], [0x915, 0x94d, 0x94d, 0x937], [0x915, 0x300, 0x94d, 0x937],
    [0x915, 0x94d, 0x300, 0x937], [0x915, 0x93c, 0x94d, 0x937], [0x995, 0x9cd, 0x9b7], [0x1019, 0x1039, 0x1018],
    [0x17a0, 0x17d2, 0x17ab], [0x1b32, 0x1b44, 0x1b2f], [0x915, 0x94d, 0x995], [0x915, 0x94d, 0x903, 0x937], [0x61, 0x1acf, 0x62],
    // Hangul and Regional Indicators.
    [0x1100, 0x1161, 0x11a8], [0xac00, 0x11a8], [0x1100, 0xac00], [0x1161, 0x1161], [0x11a8, 0x11a8], [0xac00, 0x1161],
    [0x1f1e6, 0x1f1e7, 0x1f1e8, 0x1f1e9, 0x1f1ea], [0x61, 0x1f1e6, 0x1f1e7], [0x1f1e6, 0x308, 0x1f1e7], [0x1f1e6, 0x200d, 0x1f1e7],
    // WIDTH-*: sums past 2, the rules that make exactly 2, and the base they read.
    [0x915, 0x94d, 0x937, 0x94d, 0x92e], [0x915, 0x94d, 0x937, 0x94d, 0x92e, 0x94d, 0x92f], [0x1100, 0x1100], [0x1100, 0x1100, 0x1161],
    [0x1100, 0x1100, 0x1100, 0x1161, 0x11a8], [0x600, 0x1100, 0x1100], [0x600, 0x600, 0x61], [0x600, 0x4e2d], [0x308, 0x903], [0x903],
    [0x1f1e6, 0x1f1e7, 0x903], [0x600, 0x1f1e6], [0x6dd, 0x1f1e6], [0x1f1e6, 0x200d], [0x23, 0x20e3], [0x23, 0xfe0f, 0x20e3],
    [0x61, 0x20e3], [0x1100, 0x1100, 0x20e3], [0x1f600, 0x20e3], [0x20e3], [0xfe0f], [0x200d],
    [0x2764, 0x200d, 0x1f525], [0xa9, 0x200d, 0x1f600], [0xa9, 0x200d], [0x2122, 0x200d], [0x3030, 0x200d, 0x1f600],
    [0x3297, 0x1f3fb], [0x261d, 0x1f3fb], [0x1f3fb, 0x1f3fb], [0x1f3fb, 0x200d], [0x1f9b0, 0x200d], [0x1f9b0, 0xfe0f],
    [0x2764, 0xfe0f], [0xa9, 0xfe0f], [0x3030, 0xfe0f], [0x61, 0xfe0f], [0x23, 0xfe0f], [0xe9, 0xfe0f], [0x4e2d, 0xfe0f],
    [0x2764, 0x308, 0xfe0f], [0x2764, 0xfe0f, 0x308], [0x2764, 0xfe0e, 0xfe0f], [0x2764, 0xfe0f, 0xfe0e], [0x61, 0xfe0f, 0x200d, 0x1f600],
    [0x600, 0x2764, 0xfe0f], [0x600, 0x2764, 0x200d, 0x1f600], [0x890, 0x2764, 0x200d, 0x1f600], [0x890, 0x1f476, 0x1f3fb],
    [0x890, 0x2764, 0xfe0f], [0x890, 0x890, 0x2764, 0x200d, 0x1f600], [0x600, 0x890, 0x2764, 0x200d, 0x1f600],
    [0x890, 0x600, 0x2764, 0x200d, 0x1f600], [0x890, 0x61, 0x200d, 0x1f600], [0x890, 0x1f1e6], [0x890, 0x4e2d, 0xfe0f],
    [0x600, 0xa9, 0xfe0f], [0x890, 0xa9, 0x200d, 0x1f600], [0x890, 0x3030, 0x200d], [0x600, 0x61, 0xfe0f], [0x600, 0x1f3fb, 0x200d, 0x1f600],
    [0xb7, 0x308], [0xa1, 0x20e3], [0x2460, 0xfe0f], [0xb7, 0xfe0f],
    // LONE-SURROGATES-INVISIBLE.
    [0xd800, 0x308], [0x61, 0xdc00, 0x308], [0x308, 0xd800], [0x600, 0xd800], [0x61, 0xd83d], [0xd83d, 0x200d, 0x1f600],
    [0xd83d, 0x1f3fb], [0xd800, 0xd800], [0xdc00, 0xd800], [0x600, 0xdc00, 0x61], [0xdc00, 0x2764, 0xfe0f], [0x1f1e6, 0xdc00],
    [0x1f1e6, 0xdc00, 0x1f1e7], [0x2764, 0xdc00, 0xfe0f], [0x1f600, 0x200d, 0xd800, 0x1f600], [0x915, 0x94d, 0xdc00, 0x937],
    [0xd800, 0x61], [0x1f476, 0xdc00, 0x1f3fb], [0x1100, 0xdc00, 0x1161], [0xd, 0xdc00, 0xa, 0x61], [0x61, 0xdbff, 0xdbff, 0x308],
    // TAB, which is a cell of its own (and the mark after it is not joined to it).
    [0x9, 0x308], [0x61, 0x9], [0x600, 0x9], [0x9, 0x9], [0x9, 0x200d, 0x1f600], [0x1f600, 0x200d, 0x9], [0x9, 0xdc00],
  ];
  for (const g of groups) out.push(H(...g));
  // Clusters wider than the cell's 8-bit advance (it saturates at 255).
  out.push(H(...new Array(128).fill(0x1100)), H(...new Array(200).fill(0x1100)), H(0x61, ...new Array(300).fill(0x903)));
  return out;
}

// The bun-cell per-code-point sweep (task 4b): every template, with every code point X in
// the `X` slot, is one string. Templates close with a code point of nonzero width where a
// zero-width X would otherwise leave nothing to compare. `narrow: false` runs it with
// ambiguousIsNarrow false. This is the sweep that fixed CLUSTER-DATA-16's version and found
// CC-CONTROLS-ONLY and the WIDTH-* rules (scripts/cell-profile-diff.cjs --corpus sweep).
const CELL_SWEEP_TEMPLATES = [
  { pre: [], post: [] }, { pre: [], post: [], narrow: false },
  { pre: [0x61], post: [0x903] }, { pre: [], post: [0x61, 0x903] }, { pre: [0x1100], post: [0x903] },
  { pre: [], post: [0x1161, 0x903] }, { pre: [], post: [0x11a8, 0x903] }, { pre: [], post: [0x308, 0x903] },
  { pre: [], post: [0x308, 0x903], narrow: false }, { pre: [0x1f1e6], post: [0x903] }, { pre: [0x1f600, 0x200d], post: [0x903] },
  { pre: [], post: [0x1f3fb, 0x903] }, { pre: [0x915, 0x94d], post: [0x903] }, { pre: [0x915], post: [0x915, 0x903] },
  { pre: [0x915, 0x94d], post: [0x915, 0x903] }, { pre: [0x1f600], post: [0x200d, 0x1f600] },
  { pre: [], post: [0x903, 0x903, 0x903, 0x200d] }, { pre: [0x600], post: [0x903, 0x903, 0x903, 0x200d] },
  { pre: [], post: [0xfe0f] }, { pre: [], post: [0xfe0e] }, { pre: [], post: [0x20e3] }, { pre: [], post: [0x1f3fb] },
];

function hexSeq(field) {
  return field.trim().split(/\s+/).map((h) => String.fromCodePoint(parseInt(h, 16))).join('');
}

// GraphemeBreakTest.txt: "÷ 0020 × 0308 ÷\t# comment". The string is every hex field in
// order; the ÷/× marks are the EXPECTED breaks, used by test/unicode-text.test.cjs.
function corpusGraphemeBreakTest(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const body = line.split('#')[0].trim();
    if (!body) continue;
    out.push(hexSeq(body.replace(/[÷×]/g, ' ')));
  }
  return out;
}

// emoji-test.txt: "1F600 ; fully-qualified # 😀 E1.0 grinning face". All statuses, so
// minimally- and un-qualified sequences are judged too.
function corpusEmojiTest(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line || line[0] === '#') continue;
    const semi = line.indexOf(';');
    if (semi < 0) continue;
    out.push(hexSeq(line.slice(0, semi)));
  }
  return out;
}

// Every non-ASCII snippet the carved bundle can print: maximal runs starting at a
// non-ASCII character, up to 40 code units, stopping at a quote, backtick or newline.
function corpusBundleLiterals(cliSource) {
  const seen = new Set();
  const re = /[^\x00-\x7f][^\n"'`]{0,39}/gu;
  let m;
  while ((m = re.exec(cliSource)) !== null) seen.add(m[0]);
  return [...seen].sort();
}

// GraphemeBreakTest.txt with its answers: each line's string and the code-unit offset of
// every cluster END the ÷ marks give. (corpusGraphemeBreakTest is the strings alone.)
function graphemeBreakTestCases(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const body = line.split('#')[0].trim();
    if (!body) continue;
    let s = ''; const ends = [];
    for (const tok of body.split(/\s+/)) {
      if (tok === '\u00f7') { if (s.length) ends.push(s.length); } else if (tok !== '\u00d7') s += String.fromCodePoint(parseInt(tok, 16));
    }
    out.push({ s, ends });
  }
  return out;
}

module.exports = { corpusCodePoints, corpusComposed, corpusGraphemeBreakTest, corpusEmojiTest, corpusBundleLiterals,
  corpusCellProbes, CELL_SWEEP_TEMPLATES, graphemeBreakTestCases };
