'use strict';
// The published builder asset filename. Floored legs encode their compat floor
// (clode-<ver>-<os><floor>-<arch>); unfloored legs stay bare. build-leg's bash
// mirrors this (os=${leg%-*}, arch=${leg##*-}); keep the two in sync.
function flooredAssetName(leg, version, floor) {
  if (!floor) return `clode-${version}-${leg}`;
  const dash = leg.lastIndexOf('-');
  const os = leg.slice(0, dash), arch = leg.slice(dash + 1);
  return `clode-${version}-${os}${floor}-${arch}`;
}
module.exports = { flooredAssetName };
