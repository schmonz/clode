'use strict';
// The ONE paint probe. Native runs it inside Bun (runInNative); ours runs it under tjs with
// bun-shim loaded. Same source both sides, so a difference is a difference in paint()/setCell().
// Screens are recorded DECODED (grapheme / style key / link / width bits), never as pool
// indices: native pre-seeds and orders its pools differently from ours, and the caller only
// ever reads what an index NAMES.
const { runInNative } = require('./native-oracle.cjs');
// batches/runProbeOurs are the SAME scaffolding scripts/lib/text-probe.cjs's own runOurs
// uses (mkdtemp, ASCII-only JSON input, IIFE-wrap the source, runLoader with NODE_PATH,
// cleanup) — shared there rather than duplicated here (fix round 1, code review). This module
// no longer resolves any repo-rooted path itself, so it needs no `path`/REPO of its own.
const { batches, runProbeOurs } = require('./text-probe.cjs');

const BATCH = 2000;

const PAINT_SOURCE = String.raw`
  const { scenarios, side } = input;
  const SCREEN = { widthMask: 3, narrow: 0, wide: 1, spacerTail: 2, spacerHead: 3,
    emptyCharIndex: 0, spacerCharIndex: 1, emptyWord: 0, tabWidth: 8 };
  const SENTINEL = 999999;
  const results = scenarios.map((sc) => {
    const n = new Bun.ant.CellSegmenter({ ambiguousIsNarrow: true,
      substitute: [[1564, 1564], [8234, 8238], [8294, 8297]], screen: SCREEN });
    // Our own ids, by STRING: chars 2.., styles 1.., links 1.. (0 = none).
    const charId = new Map(), charOf = ['', ''];          // 0 empty, 1 spacer (SCREEN)
    const styleId = new Map([['', 0]]), styleOf = [''];
    const linkId = new Map([['', 0]]), linkOf = [''];
    // A style is keyed as the caller SEES it: the bundle's ansiCodes() (SC-filtered open
    // codes paired with their close codes), exactly as scripts/lib/text-probe.cjs does, so a
    // raw sgrKeys spelling the caller never paints cannot read as a difference.
    const SC = /^\x1b\[(?:\d{1,3})(?:;5;\d{1,3}|;2;\d{1,3};\d{1,3};\d{1,3})?m$/;
    const styleKey = (k) => {
      if (k === 0) return '';
      const o = n.sgrKeys[k].split('\x00'), u = n.sgrCloseKeys[k].split('\x00'), f = [];
      for (let m = 0; m < o.length; m++) if (SC.test(o[m])) f.push([o[m], u[m]]);
      return JSON.stringify(f);
    };
    const idFor = (map, back, key) => {
      let v = map.get(key);
      if (v === undefined) { v = back.length; map.set(key, v); back.push(key); }
      return v;
    };
    const screen = new Int32Array(2 * sc.w * sc.h);
    for (let k = 0; k < screen.length; k += 2) { screen[k] = SENTINEL; screen[k + 1] = 0; }
    let cells = new Int32Array(512), runs = new Int32Array(512);      // the bundle's sizes
    const decode = () => {
      const rows = [];
      for (let y = 0; y < sc.h; y++) {
        const row = [];
        for (let x = 0; x < sc.w; x++) {
          const k = (y * sc.w + x) << 1, c = screen[k], w = screen[k + 1];
          if (c === SENTINEL) { row.push('#'); continue; }
          const g = c === 0 ? '<empty>' : c === 1 ? '<spacer>' : charOf[c];
          row.push(g + '|' + styleOf[w >>> 17] + '|' + linkOf[(w >>> 2) & 0x7fff] + '|' + (w & 3));
        }
        rows.push(row);
      }
      return rows;
    };
    const out = [];
    for (const op of sc.ops) {
      let rec;
      try {
        let ret, grew = null;
        if (op.seg !== undefined) {
          let c = n.segment(op.seg, cells, runs, false);
          grew = c < 0;
          if (c < 0) { const f = Math.max(-c, cells.length); cells = new Int32Array(2 * f); runs = new Int32Array(2 * f); c = n.segment(op.seg, cells, runs, false); }
          const charIdx = new Int32Array(n.graphemes.length);
          for (let i = 0; i < n.graphemes.length; i++) charIdx[i] = idFor(charId, charOf, n.graphemes[i]);
          // as the bundle's runWords(): runs through the LAST cell's run (Og = 10; reordered is
          // phase 6's, and never set by segment() today)
          const nRuns = c === 0 ? 0 : (cells[2 * c - 1] >>> 10) + 1;
          const words = new Int32Array(Math.max(1, nRuns));
          for (let j = 0; j < nRuns; j++) {
            const s = runs[2 * j], l = runs[2 * j + 1];
            const sKey = styleKey(s), lKey = l === 0 ? '' : n.uris[l];
            words[j] = (idFor(styleId, styleOf, sKey) << 17) | (idFor(linkId, linkOf, lKey) << 2);
          }
          ret = n.paint(screen, sc.w, op.x, op.y, cells, c, undefined, charIdx, words);
        } else {
          const s = op.set;
          const ci = idFor(charId, charOf, s.text);
          const word = (idFor(styleId, styleOf, s.style) << 17) | (idFor(linkId, linkOf, s.link) << 2) | s.width;
          ret = n.setCell(screen, sc.w, s.x, s.y, ci, word);
        }
        rec = { ret: [ret % 1048576, Math.floor(ret / 1048576) % 65536, Math.floor(ret / 68719476736)], grew, screen: decode() };
      } catch (e) {
        rec = { threw: String(e && e.message || e) };
      }
      out.push(rec);
    }
    return out;
  });
  return { runtime: side === 'native' ? 'bun ' + Bun.version : 'shim', results };
`;

// merge() stays paint-probe's OWN: its shape (one `results` array, always concatenated) is
// simpler than text-probe.cjs's per-KEY merge and does not generalize to it, so only the
// scaffolding above is shared, not the merging (fix round 1, code review).
function merge(parts) { return { runtime: parts[0].runtime, results: [].concat(...parts.map((p) => p.results)) }; }

function runPaintNative(bin, scenarios) {
  if (scenarios.length === 0) throw new Error('empty corpus: nothing to compare');
  return merge(batches(scenarios, BATCH).map((s) => runInNative(bin, PAINT_SOURCE, { input: { scenarios: s, side: 'native' }, timeoutMs: 600000 })));
}

function runPaintOurs(scenarios) {
  if (scenarios.length === 0) throw new Error('empty corpus: nothing to compare');
  return merge(batches(scenarios, BATCH).map((s) => runProbeOurs(PAINT_SOURCE, { scenarios: s, side: 'ours' }, 'paint-probe-')));
}

function comparePaintResults(scenarios, native, ours) {
  const findings = []; let count = 0, more = 0, examined = 0;
  const idx = new Map();
  scenarios.forEach((sc, i) => {
    const k = idx.get(sc.part) || 0; idx.set(sc.part, k + 1);
    const a = native.results[i], b = ours.results[i];
    // Every op is compared and counted (the gate's floor is in ops, ruling R2), but a scenario
    // reports only its FIRST difference: once one op diverged, the screens differ and what
    // follows proves nothing new.
    let reported = false;
    for (let op = 0; op < sc.ops.length; op++) {
      examined++;
      const na = a[op], ob = b && b[op];
      let why = null;
      if (!ob) why = 'ours has no record';
      else if (('threw' in na) || ('threw' in ob)) {
        if (na.threw !== ob.threw) why = `threw native ${JSON.stringify(na.threw)} ours ${JSON.stringify(ob.threw)}`;
      }
      else if (JSON.stringify(na.ret) !== JSON.stringify(ob.ret)) why = `ret native ${JSON.stringify(na.ret)} ours ${JSON.stringify(ob.ret)}`;
      else if (na.grew !== ob.grew) why = `grew native ${na.grew} ours ${ob.grew}`;
      else {
        for (let y = 0; y < na.screen.length && !why; y++) for (let x = 0; x < na.screen[y].length && !why; x++) {
          if (na.screen[y][x] !== ob.screen[y][x]) why = `cell ${x},${y} native ${JSON.stringify(na.screen[y][x])} ours ${JSON.stringify(ob.screen[y][x])}`;
        }
      }
      if (!why || reported) continue;
      count++;
      if (findings.length < 200) findings.push(`${sc.part} #${k} op ${op}: ${why}`); else more++;
      reported = true;
    }
  });
  if (more) findings.push(`... ${more} more`);
  return { examined, findings, count };
}

module.exports = { PAINT_SOURCE, runPaintNative, runPaintOurs, comparePaintResults, BATCH };
