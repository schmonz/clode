'use strict';
// node:module — createRequire over the loader's own machinery.
const path = require('node:path');
const url = require('node:url');
module.exports = {
  createRequire: (from) => {
    const file = String(from).startsWith('file:') ? url.fileURLToPath(from) : String(from);
    return globalThis.__nodeShim.makeRequire(path.dirname(file));
  },
};
