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
    H(0x65, 0x301),                  // base + combining mark (decomposed: e U+0301)
    'a\u202eb\u0301',                // a bidi control (substitute range) inside a would-be cluster
    '\u202e\u0301',                  // a bidi control followed by a mark it could absorb
    'e\x1b[1m' + H(0x301),          // an SGR escape between a base and its mark
    'e\x1b]8;;http://x\x07\u0301',   // an OSC-8 between a base and its mark
    '\u{1f468}\u200d\u{1f469}\u200d\u{1f467}', // ZWJ family
    '\u{1f44d}\u{1f3fd}',            // emoji modifier
    '\u{1f1fa}\u{1f1f8}\u{1f1ec}',   // three regional indicators (pair + orphan)
    '❤️', '❤︎',  // VS16 and VS15 on a text-default emoji
    'क्ष',            // Devanagari conjunct (GB9c, Unicode 15.1)
    H(0x1100, 0x1161, 0x11a8),       // Hangul L V T (conjoining jamo)
    '\r\n', 'a\r\nb',                // CR LF
    'a\tb\t', '\t\u0301',            // tabs, and a mark after a tab
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
    // WIDTH-VS16 widens the BASE, not the cluster to exactly 2 (task 6: fuzzing found it).
    [0x1f600, 0x903, 0xfe0f], [0x2764, 0x903, 0xfe0f], [0x2764, 0x903, 0x903, 0xfe0f], [0x2764, 0xfe0f, 0x903],
    [0xa9, 0x903, 0xfe0f], [0x600, 0x2764, 0x903, 0xfe0f], [0x23, 0x903, 0xfe0f], [0x1f1e6, 0x903, 0xfe0f],
    [0x1f600, 0x903, 0x20e3], [0x261d, 0x903, 0xfe0f], [0x1100, 0x903, 0xfe0f], [0x2764, 0x903, 0xfe0e],
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

// The escape layer (task 6): what ESC and the C1 introducers do to the text around them.
// CellSegmenter and Bun.stringWidth both put it in front of the clusterer, and a single
// code point or the UCD corpora never reach it. Two cross products, so the transition
// table is WALKED rather than sampled:
//   PARSER  `a` + a STATE (a prefix that leaves the parser in one of its states) + two
//           TOKENS + `b c`: every state followed by every two-step continuation. The `b c`
//           tail shows whether the sequence ended, and where (`b` is itself a final byte).
//   ACROSS  a cluster's first half, one escape sequence, its second half: native clusters
//           ACROSS an escape (measured 2026-09-24 against 2.1.278: `e ESC[1m U+0301` is the
//           one cell `e U+0301`, and `1F600 200D ESC[1m 1F600` one 2-wide cell).
const ESC = 0x1b;
const ESCAPE_STATES = [
  [], [ESC], [ESC, 0x20],                                                  // ground, ESC, ESC + intermediate
  [ESC, 0x5b], [ESC, 0x5b, 0x31], [ESC, 0x5b, 0x3f], [ESC, 0x5b, 0x20],    // CSI: entry, param, private, intermediate
  [ESC, 0x5b, 0x31, 0x301],                                                // CSI after a byte it cannot hold
  [ESC, 0x5d], [ESC, 0x5d, 0x38, 0x3b, 0x3b, 0x78],                        // OSC: entry, an OSC-8 body
  [ESC, 0x50], [ESC, 0x58], [ESC, 0x5e], [ESC, 0x5f],                      // 7-bit DCS, SOS, PM, APC
  [0x9b], [0x9b, 0x31], [0x9d], [0x90], [0x98], [0x9e], [0x9f],            // the C1 introducers
];
const ESCAPE_TOKENS = [
  ESC, 0x5b, 0x5d, 0x5c, 0x50, 0x5f, 0x31, 0x30, 0x3b, 0x3a, 0x3f, 0x20, 0x2f,   // ESC [ ] \ P _ 1 0 ; : ? SP /
  0x6d, 0x48, 0x40, 0x7e,                                                       // finals m H @ ~
  0x4e, 0x4f, 0x58, 0x5e,                                                       // N O (single shifts) X ^
  0x07, 0x09, 0x0a, 0x0d, 0x00, 0x7f, 0x18, 0x1a,                               // BEL TAB LF CR NUL DEL CAN SUB
  0x80, 0x85, 0x8e, 0x8f, 0x90, 0x98, 0x9b, 0x9c, 0x9d, 0x9e, 0x9f,             // C1: SS2 SS3, the introducers, ST
  0x301, 0x903, 0x4e2d, 0x1f600, 0x1f1e6, 0x202e, 0xd83d, 0xde00,               // mark, spacing mark, wide, emoji, RI, bidi, lone halves
];
const ACROSS_FIRST = [[0x65], [0x1f1e6], [0x915, 0x94d], [0x1100], [0x1f600, 0x200d], [0x600], [0x1f476], [0x2764],
  [0x202e], [0xd83d], [0x61, 0x09]];
const ACROSS_ESCAPE = [
  [ESC, 0x5b, 0x31, 0x6d], [ESC, 0x5b, 0x6d], [ESC, 0x5d, 0x38, 0x3b, 0x3b, 0x75, 0x07],
  [ESC, 0x5d, 0x38, 0x3b, 0x3b, 0x75, ESC, 0x5c], [0x9b, 0x31, 0x6d], [0x9d, 0x38, 0x3b, 0x3b, 0x75, 0x9c],
  [ESC, 0x37], [ESC, 0x28, 0x42], [ESC], [ESC, 0x5b, 0x31, 0x301, 0x6d], [ESC, 0x50, 0x71, ESC, 0x5c], [],
];
const ACROSS_SECOND = [[0x301], [0x903], [0x1f1e7], [0x937], [0x1161], [0x1f600], [0x1f3fb], [0xfe0f], [0x200d, 0x1f600],
  [0xde00], [0x202e], [0x78], [0x09]];

function corpusEscapes() {
  const out = [];
  for (const st of ESCAPE_STATES) {
    for (const t1 of ESCAPE_TOKENS) for (const t2 of ESCAPE_TOKENS) out.push(H(0x61, ...st, t1, t2, 0x62, 0x63));
  }
  for (const x of ACROSS_FIRST) for (const e of ACROSS_ESCAPE) for (const y of ACROSS_SECOND) out.push(H(...x, ...e, ...y));
  return [...new Set(out)];   // the two halves overlap in a few strings
}

// Bun.sliceAnsi's own rules (task 7), which the corpora above never reach: what it replays,
// keeps and closes needs a variety of SGR and OSC 8 sequences AROUND the cut, and two of its
// clustering rules show only after a 1-wide Prepend. Measured 2026-09-25: with only the
// corpora above, the sliceAnsi gate stayed green with any one of SLICE-CONTROLS-JOIN,
// SLICE-IDENTITY, the SLICE-ASCII-RUNS horizon, SGR-ATTRIBUTES, SGR-CLOSES or the SLICE-STYLES
// replay switched off. The same strings judge CellSegmenter's painted style (CELL-SGR): the
// segmenter gate differed from native on 2,010 of them until its rows carried the style.
//   AROUND  every sequence below before `a` and again between `a` and `bc`: the probe cuts
//           columns (1) (the first replayed), (0, 1) (the second met at the cut) and (1, 2).
//   PREPEND a 1-wide Prepend, then each Cc (and a few other would-be controls), then `x`:
//           the Prepend takes it, so (1) is just `x` — except CR and LF.
//   HORIZON zero-width marks, a 1-wide Prepend and two letters: the scan horizon lands
//           between the Prepend and the letters for exactly one count of marks.
//   EVERY SGR every code 0-107 (task 8, R32), in two linear templates, because AROUND only
//           SAMPLES the close/attribute table (sgrCloseCode, sgrSlot, isSgrEndCode in
//           libexec/unicode-text.cjs): `ESC[c m a ESC[c m bc` asks what c closes with and
//           whether it closes, `ESC[31;42m ESC[c m ab` asks which attribute c replaces
//           beside an open foreground and background. Measured 2026-09-25 against native
//           2.1.278: 0 differences, and with only the corpora above the gate stayed green
//           with 97, 107 or 30 dropped from their colour ranges (each one is 1 string here)
//           or with the background codes given one attribute each (16 strings here).
const SGR_CODES = Array.from({ length: 108 }, (_, c) => c);
const SGRS = [
  '1', '2', '1;2', '3', '20', '4', '21', '5', '6', '7', '8', '9', '31', '91', '38;5;208', '38;2;1;2;3', '38;5', '38;2;1',
  '48;5;1', '48;2;9;8;7', '58;5;1', '51', '52', '53', '73', '74', '10', '11', '99', '', '0', ';1', '1;', '22', '23', '24', '25',
  '27', '28', '29', '39', '49', '54', '55', '59', '75', '22;4', '0;1', '4:3', '38:5:208', '1234567', '31;1;4;7;9;53;73;2;3;5',
  new Array(33).fill('1').join(';'),
].map((p) => '\x1b[' + p + 'm');
const LINKS = ['\x1b]8;;http://x\x07', '\x1b]8;;\x07', '\x1b]8;id=1;u\x1b\\', '\x1b]8;;\x1b\\', '\x9d8;;u\x9c', '\x9d8;;\x9c',
  '\x1b]8;u\x07', '\x1b]8;;u\x18', '\x1b]0;t\x07', '\x9b1m', '\x9b31;1m', '\x9b22m', '\x1b[2K', '\x1b[?25l'];
const SLICE_PREPENDS = [0x890, 0xd4e];

function corpusSliceProbes() {
  const out = [];
  const around = SGRS.concat(LINKS);
  for (const x of around) for (const y of around) out.push(x + 'a' + y + 'bc');
  for (const c of SGR_CODES) out.push('\x1b[' + c + 'ma\x1b[' + c + 'mbc', '\x1b[31;42m\x1b[' + c + 'mab');
  const controls = [];
  for (let c = 0; c <= 0x1f; c++) controls.push(c);
  for (let c = 0x7f; c <= 0x9f; c++) controls.push(c);
  for (const p of SLICE_PREPENDS) {
    for (const c of controls.concat([0xd800, 0xdbff, 0xdc00, 0xdfff, 0x200b, 0xad, 0x2028, 0xfeff])) out.push(H(p, c, 0x78));
    out.push(H(p) + '\x1b[1mab', H(p) + '\x1b[1ma\x1b[22mb', H(p) + '\x1b[1ma\u0301b');
  }
  for (let k = 0; k <= 10; k++) {
    const marks = H(...new Array(k).fill(0x301));
    out.push(marks + H(0x890) + 'ab', 'x' + marks + H(0x890) + 'abc', '\x1b[1m' + marks + H(0x890) + 'ab\x1b[22m');
  }
  return [...new Set(out)];
}

// OSC 8 hyperlinks (CellSegmenter phase 4): which link each cell takes, which the corpora above
// reach only in passing (the escape and slice probes open links but rarely close them, and
// none varies the URI). Measured 2026-09-25 against native 2.1.278 (Bun 1.4.3), whose
// CellSegmenter interns each link's URI into `uris`:
//   FORMS   every introducer (ESC ] and U+009D) x parameters (none, `id=`, `id=` with more,
//           and one holding a `;`, which moves the rest into the URI) x URI (`;` and a lone
//           `;`, a space, non-ASCII, TAB, C1, DEL, NUL, a lone surrogate, 3,000 characters)
//           x terminator (BEL, U+009C, ESC \), opened after `a` and closed after `b`.
//   CLOSES  every introducer x terminator x parameters, closing a link that is open.
//   NOT     what is not a hyperlink (one `;`, `08`, `88`, `8 `, another OSC, ended by an ESC
//           that is not ST, by CAN or SUB, a terminator inside the parameters, unterminated)
//           and two sequences that do not close one (SGR 0, RIS): each alone, after an open
//           link, and after an open link at the end of the string.
//   SHAPES  a link spanning wide glyphs, emoji and SGR changes; opened or closed between the
//           code points of one cluster (a mark, a ZWJ sequence, a conjunct, a flag, Hangul, a
//           Prepend, a split surrogate pair); over a tab, a zero-width cluster and a
//           substituted bidi control; re-opened (there is no nesting); left open at the end of
//           a string, followed by a string with none (the probe segments every string with one
//           segmenter, so a link carried from one segment() to the next would show).
function corpusLinks() {
  const E = H(0x1b), BEL = H(0x07), ST = H(0x9c), OSC = [E + ']', H(0x9d)];
  const TERMS = [BEL, ST, E + '\\'];
  const PARAMS = ['', 'id=1', 'id=1:foo=bar', 'a;b'];
  const URIS = ['http://x', 'u;v', ';', ' ', 'http://' + H(0xfc, 0x4e2d, 0x1f600), 'u' + H(0x09) + 'v', 'u' + H(0x85) + 'v',
    'u' + H(0x7f) + 'v', 'u' + H(0x00) + 'v', 'u' + H(0x9d) + 'v', 'u' + H(0xd800) + 'v', 'h'.repeat(3000)];
  const link = (intro, params, uri, term) => intro + '8;' + params + ';' + uri + term;
  const out = [];
  for (const intro of OSC) for (const params of PARAMS) for (const uri of URIS) for (const term of TERMS) {
    out.push('a' + link(intro, params, uri, term) + 'b' + link(intro, '', '', term) + 'c');
  }
  const O = link(E + ']', '', 'http://x', BEL), O2 = link(E + ']', 'id=2', 'http://y', ST), X = link(E + ']', '', '', BEL);
  for (const intro of OSC) for (const term of TERMS) for (const params of ['', 'id=1']) out.push(O + 'a' + link(intro, params, '', term) + 'b');
  const NOT = [
    E + ']8;u' + BEL, E + ']8' + BEL, E + ']08;;v' + BEL, E + ']88;;v' + BEL, E + ']8 ;;v' + BEL, E + '];8;;v' + BEL, E + ']0;t' + BEL,
    E + ']8;;v' + E + '[1m', E + ']8;;v' + E + '7', E + ']8;;v' + E + E + '\\', E + ']8;;v' + H(0x18), E + ']8;;v' + H(0x1a),
    E + ']8;' + BEL + ';v' + BEL, E + ']8;' + ST + ';v' + BEL, E + ']8;' + H(0x18) + ';v' + BEL, E + ']8;' + E + ';v' + BEL,
    H(0x9d) + '8;v' + ST, H(0x9d) + '8;;v' + E + '[1m', H(0x9d) + '8;;v' + H(0x1a), E + '[0m', E + 'c', E + ']8;;v', H(0x9d) + '8;;v',
  ];
  for (const m of NOT) out.push('a' + m + 'bc', O + 'a' + m + 'bc', O + 'a' + m);
  out.push(
    'a' + O + H(0x4e2d) + E + '[1m' + H(0x6587, 0x1f44d, 0x1f3fd) + 'b' + E + '[0m' + 'c' + X + 'd',
    'e' + O + H(0x301) + 'x', O + 'e' + X + H(0x301) + 'x', O + 'e' + O2 + H(0x301) + 'x',
    H(0x1f600, 0x200d) + O + H(0x1f600) + 'x', H(0x915, 0x94d) + O + H(0x937) + 'x', H(0x1f1e6) + O + H(0x1f1e7) + 'x',
    H(0x1100) + O + H(0x1161) + 'x', H(0x600) + O + 'a', 'a' + H(0xd83d) + O + H(0xde00) + 'b',
    O + 'a' + H(0x09) + 'b' + X + H(0x09), O + H(0x200b) + X + 'a', O + H(0x301) + X + 'a', 'a' + O + H(0x202e) + X + 'b',
    O + 'a' + O2 + 'b' + X + 'c', O + 'a' + O2 + 'b' + O + 'c' + X + 'd', O + 'a' + O + 'b',
    E + '[1m' + O + 'a' + E + '[0m' + 'b' + X + 'c', 'a' + O + X + 'b', 'a' + O + O2 + X + 'b',
    O + 'a', 'b', O2, 'c', E + ']8;;v', 'd',
  );
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
  { pre: [], post: [0x903, 0xfe0f] },   // task 6: WIDTH-VS16 widens the base, and a spacing mark still counts
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
  corpusCellProbes, corpusEscapes, corpusSliceProbes, corpusLinks, CELL_SWEEP_TEMPLATES, graphemeBreakTestCases };
