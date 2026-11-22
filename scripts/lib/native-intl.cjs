'use strict';
// Which Intl.Segmenter a native Claude carries, and whether it is the one libexec/unicode-text.cjs's
// `uax29` profile was generated from: the ONE answer scripts/gen-unicode-data.cjs,
// scripts/cell-profile-diff.cjs, test/unicode-data-fresh.test.cjs and
// test/fidelity/text-differential.test.cjs all act on.
//
// INTL-FOLLOWS-BUNDLED-ICU (oracle choice). Native's Intl.Segmenter is JSC over ICU, and the
// two platforms get their ICU differently. Measured 2026-11-21 with 2.1.330 (Bun 1.4.4,
// WebKit ee59053d) through the BUN_OPTIONS preload:
//   linux-arm64  process.versions icu 79.1, unicode 18.0; ldd lists no libicu (BUNDLED)
//   darwin-arm64 process.versions icu 78.1, unicode 17.0; otool -L lists
//                /usr/lib/libicucore.A.dylib (the HOST OS's ICU, so it moves with macOS)
// and they segment differently: `094D 0915` is one cluster on linux (UAX #29 rev 49's GB9c,
// `Linker Extend* x Consonant`) and two on darwin (rev 47's, which needs a Consonant first).
// quaude has no host ICU to defer to, so the polyfill carries ONE answer, and it is the one the
// bundle itself pins: linux's. A darwin native's Intl is therefore a DIFFERENT oracle for
// uax29, named as such, never a verdict on ours and never allowed to move the tables.
// (CellSegmenter, stringWidth and sliceAnsi are Bun's own code and agree on both platforms:
// CI's linux cell-profile-diff found bun-cell=0 against tables generated on darwin.)
const { runInNative } = require('./native-oracle.cjs');

const INTL_PLATFORM = 'linux';

const INTL_PROBE = 'return { unicode: process.versions.unicode, icu: process.versions.icu, platform: process.platform, arch: process.arch };';

// { unicode: '18.0', icu: '79.1', platform: 'linux', arch: 'arm64' } from inside native. A
// native that does not report its Unicode version cannot be placed, so that is a refusal.
function nativeIntl(bin) {
  const r = runInNative(bin, INTL_PROBE);
  if (!r || typeof r.unicode !== 'string' || !/^\d+(\.\d+)*$/.test(r.unicode) || typeof r.platform !== 'string') {
    throw new Error(`native ${bin} did not report its Intl Unicode version (process.versions.unicode): ${JSON.stringify(r)}`);
  }
  return r;
}

// '18.0' -> '18.0.0', the shape scripts/unicode-inputs.json keys its versions by.
function versionKey(v) {
  const p = String(v).split('.');
  while (p.length < 3) p.push('0');
  return p.slice(0, 3).join('.');
}

function compareVersions(a, b) {
  const x = versionKey(a).split('.').map(Number); const y = versionKey(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

// May native `n` (nativeIntl's answer) judge tables whose header.intl is `h`?
//   { judge: true }                   the same oracle: compare
//   { judge: false, other: why }      another platform's ICU (INTL-FOLLOWS-BUNDLED-ICU): not a verdict
//   { judge: false, stale: why }      the SAME platform's Intl now reports another Unicode version:
//                                     the tables are behind native, which IS a finding (the table-version
//                                     check: the next Unicode bump lands here by name, not as stray rows)
function intlVerdict(n, h) {
  if (!h || typeof h.unicode !== 'string') return { judge: false, stale: 'libexec/unicode-text.cjs\'s header names no intl version; regenerate it' };
  if (n.platform !== h.platform) {
    return { judge: false, other: `native's Intl is ${n.platform}'s ICU ${n.icu} (Unicode ${n.unicode}); uax29's tables follow `
      + `${h.platform}'s bundled ICU ${h.icu} (Unicode ${h.unicode}) — a different oracle (INTL-FOLLOWS-BUNDLED-ICU, scripts/lib/native-intl.cjs)` };
  }
  if (versionKey(n.unicode) !== h.unicode || n.icu !== h.icu) {
    return { judge: false, stale: `native's Intl now reports ICU ${n.icu}, Unicode ${n.unicode}, but uax29's tables were generated at `
      + `ICU ${h.icu}, Unicode ${h.unicode}: regenerate with scripts/gen-unicode-data.cjs --native <a ${h.platform} native>` };
  }
  return { judge: true };
}

module.exports = { INTL_PLATFORM, nativeIntl, versionKey, compareVersions, intlVerdict };
