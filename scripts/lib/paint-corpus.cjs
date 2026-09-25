'use strict';
// Paint scenarios. Each part names the question it asks native. Built from code points
// (tool hazard): never type non-ASCII here.
const E = '\x1b';
const CP = (...c) => String.fromCodePoint(...c);
const CJK = CP(0x4e2d), CJK2 = CP(0x6587), EMOJI = CP(0x1f44d, 0x1f3fd), FLAG = CP(0x1f1fa, 0x1f1f8);
const MARK = 'e' + CP(0x301), ZWSP = CP(0x200b), TAB = '\t';
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
    // a wide glyph whose second column falls past the edge (the contract's open experiment)
    for (const x of [w - 3, w - 2, w - 1, w]) add('wide', w, 1, [{ seg: CJK, x, y: 0 }]);
    for (const x of [w - 3, w - 2, w - 1]) add('wide', w, 1, [{ seg: 'a' + CJK + 'b', x, y: 0 }]);
    // tabs at every column: damage must cover what the expansion writes
    for (let x = 0; x < w; x++) add('tabs', w, 1, [{ seg: TAB + 'b', x, y: 0 }]);
    for (let x = 0; x < w; x++) add('tabs', w, 1, [{ seg: 'a' + TAB, x, y: 0 }]);
    for (const t of [ZWSP, 'a' + ZWSP + 'b', CP(0x301), 'a' + CP(0x200d)]) for (const x of XS) add('zero-width', w, 1, [{ seg: t, x, y: 0 }]);
    // overlaps: paint, then paint again over part of it (same value and different value)
    for (const [a, b, dx] of [['abcd', 'abcd', 0], ['abcd', 'xy', 1], [CJK + CJK2, 'x', 1], ['ab', CJK, 1], ['abc', 'abc', 1]]) {
      add('overwrite', w, 1, [{ seg: a, x: 0, y: 0 }, { seg: b, x: dx, y: 0 }]);
    }
    for (const t of [STYLED, LINKED, E + '[31m' + CJK + E + '[39m' + 'a']) for (const x of XS) add('runs', w, 1, [{ seg: t, x, y: 0 }]);
    for (const x of [-1, 0, w - 1, w, w + 5]) for (const y of [0, 1]) {
      for (const width of [0, 1, 2, 3]) add('setcell', w, 2, [{ set: { x, y, text: 'q', style: '', link: '', width } }]);
    }
    add('setcell', w, 1, [{ seg: 'abc', x: 0, y: 0 }, { set: { x: 1, y: 0, text: 'b', style: '', link: '', width: 0 } }]);
  }
  // grow-and-retry: > 256 scratch cells from the bundle's 512-int buffers
  for (const n of [256, 257, 300, 600]) add('grow', 12, 1, [{ seg: 'x'.repeat(n), x: 0, y: 0 }]);
  add('grow', 12, 1, [{ seg: CJK.repeat(300), x: 0, y: 0 }]);
  return out;
}

module.exports = { paintCorpus, PAINT_PARTS };
