'use strict';
// node:sea under tjs — a fused tjs process is NOT a Node single-executable
// application, so isSea() is honestly false (the quaude VFS is the analogous
// embedded-payload signal, and clode-fuse/quaude-bootstrap consume it
// directly). The asset APIs throw the same coded error a plain non-SEA node
// process throws. v0.1.2 field report: without this module the wallProxy
// threw on the mere `sea.isSea` property read and bare `./clode-<ver>-<plat>`
// crashed at startup.
function notSea() {
  const e = new Error('not running inside a single-executable application');
  e.code = 'ERR_NOT_IN_SINGLE_EXECUTABLE_APPLICATION';
  throw e;
}
module.exports = {
  isSea: () => false,
  getAsset: notSea,
  getRawAsset: notSea,
  getAssetAsBlob: notSea,
};
