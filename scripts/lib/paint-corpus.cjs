'use strict';
// Paint scenarios. Each part names the question it asks native. Built from code points
// (tool hazard): never type non-ASCII here.
const E = '\x1b';
const CP = (...c) => String.fromCodePoint(...c);
const CJK = CP(0x4e2d), CJK2 = CP(0x6587), EMOJI = CP(0x1f44d, 0x1f3fd), FLAG = CP(0x1f1fa, 0x1f1f8);
const MARK = 'e' + CP(0x301), ZWSP = CP(0x200b), TAB = '\t';
const CJK3 = CP(0x5b57);
// One cluster wider than 2: two Hangul leading jamo are one cluster of advance 4, and 128 of
// them one of advance 255, where the cell's 8-bit field saturates.
const WIDE4 = CP(0x1100, 0x1100), WIDE255 = CP(0x1100).repeat(128);
const W2 = CJK + CJK2;                         // heads at 0 and 2, spacerTails at 1 and 3
const Q = (x, y, width, style = '', link = '') => ({ set: { x, y, text: 'q', style, link, width } });
const STYLED = 'a' + E + '[1mb' + E + '[22mc';
const LINKED = 'a' + E + ']8;;https://x\x07bc' + E + ']8;;\x07d';

const PAINT_PARTS = ['ascii', 'clip', 'wide', 'tabs', 'zero-width', 'overwrite', 'runs', 'setcell', 'grow'];

function paintCorpus() {
  const out = [];
  const add = (part, w, h, ops) => out.push({ part, w, h, ops });
  const TEXTS = ['a', 'abc', 'abcdefghijklmnop', CJK, CJK + CJK2, 'a' + CJK, CJK + 'a', EMOJI, FLAG, MARK, STYLED, LINKED];
  for (const w of [5, 12]) {
    const XS = [0, 1, w - 2, w - 1, w, w + 3];
    for (const t of TEXTS) for (const x of XS) add('ascii', w, 2, [{ seg: t, x, y: 0 }]);
    for (const t of ['abcdefghijklmnopqrstuvwxyz', CJK.repeat(8)]) for (const x of XS) add('clip', w, 2, [{ seg: t, x, y: 1 }]);
    // left of the screen: a cell at a negative column is not written, a wide cluster whose head
    // is there writes no second column, and one wider than 2 still writes its further columns
    for (const t of ['abc', CJK + 'a', WIDE4 + 'b']) for (const x of [-1, -2, -3]) add('clip', w, 2, [{ seg: t, x, y: 0 }]);
    // a row outside the screen is not written
    for (const y of [-1, 2]) add('clip', w, 2, [{ seg: 'ab', x: 0, y }]);
    // a wide glyph whose second column falls past the edge (the contract's open experiment)
    for (const x of [w - 3, w - 2, w - 1, w]) add('wide', w, 1, [{ seg: CJK, x, y: 0 }]);
    for (const x of [w - 3, w - 2, w - 1]) add('wide', w, 1, [{ seg: 'a' + CJK + 'b', x, y: 0 }]);
    // a cluster wider than 2: the columns after its second, what they carry, and the edge
    for (const x of [0, w - 4, w - 3, w - 1, w]) add('wide', w, 1, [{ seg: WIDE4 + 'b', x, y: 0 }]);
    add('wide', w, 1, [{ seg: E + '[31m' + WIDE4 + E + '[39mb', x: 0, y: 0 }]);
    add('wide', w, 1, [{ seg: E + ']8;;https://x\x07' + WIDE4 + E + ']8;;\x07b', x: 0, y: 0 }]);
    add('wide', w, 1, [{ seg: WIDE255 + 'b', x: 0, y: 0 }]);
    // tabs at every column: damage must cover what the expansion writes
    for (let x = 0; x < w; x++) add('tabs', w, 1, [{ seg: TAB + 'b', x, y: 0 }]);
    for (let x = 0; x < w; x++) add('tabs', w, 1, [{ seg: 'a' + TAB, x, y: 0 }]);
    // at or past the right edge, and left of the screen, where the stop's remainder has a sign
    for (const x of [w, w + 1, w + 3, -1, -2, -3, -8, -9]) {
      add('tabs', w, 1, [{ seg: TAB + 'b', x, y: 0 }]);
      add('tabs', w, 1, [{ seg: 'a' + TAB + 'b', x, y: 0 }]);
    }
    add('tabs', w, 1, [{ seg: TAB + TAB + TAB + 'b', x: 0, y: 0 }]);
    // what a tab's blanks carry when the tab is styled or linked
    add('tabs', w, 1, [{ seg: E + '[41m' + TAB + 'b' + E + '[49m', x: 0, y: 0 }]);
    add('tabs', w, 1, [{ seg: E + ']8;;https://x\x07' + TAB + 'b' + E + ']8;;\x07', x: 0, y: 0 }]);
    for (const t of [ZWSP, 'a' + ZWSP + 'b', CP(0x301), 'a' + CP(0x200d)]) for (const x of XS) add('zero-width', w, 1, [{ seg: t, x, y: 0 }]);
    // overlaps: paint, then paint again over part of it (same value and different value)
    for (const [a, b, dx] of [['abcd', 'abcd', 0], ['abcd', 'xy', 1], [CJK + CJK2, 'x', 1], ['ab', CJK, 1], ['abc', 'abc', 1]]) {
      add('overwrite', w, 1, [{ seg: a, x: 0, y: 0 }, { seg: b, x: dx, y: 0 }]);
    }
    // half of a wide cluster overwritten: what becomes of the other half, and the damage
    for (const [b, dx] of [['x', 0], ['x', 2], ['x', 3], ['xy', 1], [CJK3, 1], [CJK3, 0], [TAB, 1]]) {
      add('overwrite', w, 1, [{ seg: W2, x: 0, y: 0 }, { seg: b, x: dx, y: 0 }]);
    }
    add('overwrite', w, 1, [{ seg: 'a' + W2, x: 0, y: 0 }, { seg: CJK3, x: 0, y: 0 }]);      // its spacer lands on a head
    add('overwrite', w, 1, [{ seg: E + '[31m' + W2 + E + '[39m', x: 0, y: 0 }, { seg: E + '[32mx' + E + '[39m', x: 1, y: 0 }]);
    add('overwrite', w, 1, [{ seg: 'ab' + CJK, x: w - 4, y: 0 }, { seg: 'x', x: w - 2, y: 0 }]);   // the tail in the last column
    add('overwrite', w, 1, [{ seg: CJK, x: w - 2, y: 0 }, { seg: CJK2, x: w - 1, y: 0 }]);        // a spacerHead over a tail
    add('overwrite', w, 1, [Q(0, 0, 2), { seg: 'x', x: 0, y: 0 }]);                              // a tail in column 0
    add('overwrite', w, 1, [Q(w - 1, 0, 1), { seg: 'x', x: w - 1, y: 0 }]);                      // a head in the last column
    for (const t of [STYLED, LINKED, E + '[31m' + CJK + E + '[39m' + 'a']) for (const x of XS) add('runs', w, 1, [{ seg: t, x, y: 0 }]);
    for (const x of [-1, 0, w - 1, w, w + 5]) for (const y of [0, 1]) {
      for (const width of [0, 1, 2, 3]) add('setcell', w, 2, [{ set: { x, y, text: 'q', style: '', link: '', width } }]);
    }
    add('setcell', w, 1, [{ seg: 'abc', x: 0, y: 0 }, { set: { x: 1, y: 0, text: 'b', style: '', link: '', width: 0 } }]);
    // further left, and a row outside the screen
    for (const [x, y] of [[-3, 0], [0, -1], [0, 2]]) add('setcell', w, 2, [Q(x, y, 0)]);
    // what a wide word's second column carries
    add('setcell', w, 2, [Q(0, 0, 1, 'S', 'L')]);
    // setCell over half of a wide cluster
    for (const [x, width] of [[1, 0], [2, 0], [1, 1], [1, 2], [1, 3], [0, 1]]) add('setcell', w, 1, [{ seg: W2, x: 0, y: 0 }, Q(x, 0, width)]);
  }
  // the end column saturates into its 20 bits, at both ends
  for (const x of [1048575, 1048579, 2147483646, -2147483647]) add('clip', 5, 1, [{ seg: 'ab', x, y: 0 }]);
  add('setcell', 5, 1, [Q(1048579, 0, 0)]);
  // a cluster of advance 255 where it fits, styled; and one of advance 4 over two wide ones
  add('wide', 260, 1, [{ seg: E + '[31m' + WIDE255 + E + '[39mb', x: 2, y: 0 }]);
  add('overwrite', 8, 1, [{ seg: W2 + CJK, x: 0, y: 0 }, { seg: WIDE4, x: 1, y: 0 }]);
  // grow-and-retry: > 256 scratch cells from the bundle's 512-int buffers
  for (const n of [256, 257, 300, 600]) add('grow', 12, 1, [{ seg: 'x'.repeat(n), x: 0, y: 0 }]);
  add('grow', 12, 1, [{ seg: CJK.repeat(300), x: 0, y: 0 }]);
  return out;
}

module.exports = { paintCorpus, PAINT_PARTS };
