'use strict';
// The published builder asset filename. Now a thin delegate to the canonical-name
// source of truth (scripts/canonical-name.cjs) — kept so existing importers and the
// bash mirror's reference stay valid. build-leg's bash must produce the SAME string;
// the canonical rules (os->macos, arch->amd64/i386, DASHED floor, libc suffix) live in
// canonical-name so bash can call it (`node scripts/canonical-name.cjs …`) instead of
// re-implementing the split.
const { assetName } = require('./canonical-name.cjs');
function flooredAssetName(leg, version, floor) { return assetName(leg, version, floor); }
module.exports = { flooredAssetName };
