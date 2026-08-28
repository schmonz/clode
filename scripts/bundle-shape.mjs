// Emit a one-line STRUCTURAL RECORD for a Claude Code binary, so upstream's packaging
// changes show up as a trend instead of as 22 red legs.
//
// WHY THIS EXISTS. Upstream repacks constantly, and the changes are not a march in one
// direction — measured across five releases (docs/bundle-shapes.tsv):
//
//   2.1.238      6 modules,     0 chunks   — one file
//   2.1.243   1382 modules,  1375 chunks   — split hard, 12414 static imports
//   2.1.246   1409 modules,   562 chunks   — HALF UNDONE, static imports back to 0, text assets appear
//   2.1.250   1777 modules,  1770 chunks   — split harder, and chunks require() each other CYCLICALLY
//
// while the binary shrank 344 -> 196 MB. These read as Bun bundler KNOBS being tuned for
// install size and cold start, not as architecture. So the useful thing is not to model any
// one shape, it is to notice the shape moving.
//
//   node scripts/bundle-shape.mjs <claude-binary> [version-label]
//
// THE FIELD THAT MATTERS MOST is jsExtractable. Everything clode does rests on the container
// holding real JavaScript. Bun can emit JSC BYTECODE instead (bun build --bytecode), and
// startup time is precisely what upstream is optimising — so that knob is plausibly one
// release away. If it is ever flipped, extraction does not get harder, it becomes impossible,
// and this field is how we find out on the day rather than through a red matrix.
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { loadGraph, loadAssets } = require(path.join(here, '..', 'libexec', 'bun-graph.cjs'));

export const FIELDS = [
  'version', 'binMB', 'jsExtractable', 'modules', 'chunks', 'assets',
  'srcMB', 'cjsRequireOfChunk', 'staticImportOfChunk', 'dynamicImportOfChunk',
];

export function shapeOf(binpath, version) {
  const binMB = Math.round(statSync(binpath).size / 1048576);
  let mods = null;
  try { mods = loadGraph(binpath); } catch { /* single-file bundle, or a shape we cannot read */ }

  // A single-file bundle is a LEGITIMATE shape (2.1.238 was one), not a failure — so it is
  // recorded with modules=1 rather than treated as unreadable. What would NOT be legitimate
  // is a container with no extractable JavaScript at all; see jsExtractable below.
  if (!mods) {
    const buf = readFileSync(binpath);
    // Look for the marks a Bun standalone leaves around embedded JS. Their ABSENCE in a
    // Bun-packaged binary is the bytecode alarm.
    const hay = buf.toString('latin1');
    const jsExtractable = hay.includes('@bun') || hay.includes('$bunfs') || hay.includes('~BUN');
    return { version, binMB, jsExtractable, modules: 1, chunks: 0, assets: 0,
             srcMB: '-', cjsRequireOfChunk: 0, staticImportOfChunk: 0, dynamicImportOfChunk: 0 };
  }

  const names = [...mods.keys()];
  let assets = 0;
  try { assets = [...loadAssets(binpath)].length; } catch { /* older bundles carry none */ }

  let bytes = 0, req = 0, stat = 0, dyn = 0;
  const count = (t, pat) => { let n = 0, k = 0; while ((k = t.indexOf(pat, k)) !== -1) { n++; k += pat.length; } return n; };
  for (const n of names) {
    const t = String(mods.get(n));
    bytes += t.length;
    // Both container prefixes: a Bun binary built on Windows uses B:/~BUN/root.
    for (const pfx of ['/$bunfs/root/chunk-', 'B:/~BUN/root/chunk-']) {
      req += count(t, 'require("' + pfx) + count(t, "require('" + pfx);
      stat += count(t, 'from"' + pfx) + count(t, "from'" + pfx);
      dyn += count(t, 'import("' + pfx) + count(t, "import('" + pfx);
    }
  }
  return {
    version, binMB, jsExtractable: bytes > 0, modules: names.length,
    chunks: names.filter((n) => n.includes('/chunk-')).length,
    assets, srcMB: (bytes / 1048576).toFixed(1),
    cjsRequireOfChunk: req, staticImportOfChunk: stat, dynamicImportOfChunk: dyn,
  };
}

if (process.argv[1] && process.argv[1].endsWith('bundle-shape.mjs')) {
  const bin = process.argv[2];
  if (!bin) { console.error('usage: bundle-shape.mjs <claude-binary> [version]'); process.exit(2); }
  const rec = shapeOf(bin, process.argv[3] || 'unknown');
  if (!rec.jsExtractable) {
    console.error('bundle-shape: NO EXTRACTABLE JAVASCRIPT in ' + bin + '.');
    console.error('bundle-shape: if this is a Bun standalone, upstream has likely enabled');
    console.error('bundle-shape: `bun build --bytecode`. clode cannot carry JSC bytecode —');
    console.error('bundle-shape: read the contingency in BACKLOG before doing anything else.');
  }
  console.log(FIELDS.map((f) => rec[f]).join('\t'));
}
