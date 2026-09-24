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

module.exports = { corpusCodePoints, corpusComposed, corpusGraphemeBreakTest, corpusEmojiTest, corpusBundleLiterals };
