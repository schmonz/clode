'use strict';
// node:module — createRequire + the CommonJS Module surface node-shim routes
// require() through, so a Module._load monkeypatch (bun-shim) intercepts.
// SEALED (loader): an unimplemented prop throws the branded wall.
const path = require('node:path');
const url = require('node:url');
const NS = globalThis.__nodeShim;

function parentDir(parent) {
  const f = parent && parent.filename;
  return f ? path.dirname(f) : NS.readTextSync ? process.cwd() : process.cwd();
}

// Node's Module.wrap: the exact CJS wrapper string. Kept byte-faithful so a
// consumer that string-matches the header (rare) still works.
const wrapper0 = '(function (exports, require, module, __filename, __dirname) { ';
const wrapper1 = '\n});';
function wrap(src) { return wrapper0 + src + wrapper1; }

const Module = {
  createRequire: (from) => {
    const file = String(from).startsWith('file:') ? url.fileURLToPath(from) : String(from);
    return NS.makeRequire(path.dirname(file));
  },
  // The canonical loader entry. Default impl = the loader's real resolution;
  // a monkeypatch wraps this and calls the saved original for fallthrough.
  _load: (request, parent, _isMain) => NS.moduleLoad(request, parentDir(parent)),
  _resolveFilename: (request, parent) => {
    const bare = request.startsWith('node:') ? request.slice(5) : request;
    if (NS.KNOWN.includes(bare)) return `node:${bare}`;
    return NS.resolveRequest(request, parentDir(parent)).file;
  },
  wrap,
  builtinModules: NS.KNOWN.slice(),
};
Module.Module = Module;
module.exports = Module;
