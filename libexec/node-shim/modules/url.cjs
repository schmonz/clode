'use strict';
// node:url — WHATWG URL is native in txiki; file-URL helpers are ours.
function fileURLToPath(u) {
  const url = typeof u === 'string' ? new URL(u) : u;
  if (url.protocol !== 'file:') throw new TypeError('node-shim: fileURLToPath: not a file URL');
  return decodeURIComponent(url.pathname);
}
function pathToFileURL(p) {
  const path = require('node:path');
  const abs = path.resolve(String(p));
  return new URL('file://' + abs.split('/').map(encodeURIComponent).join('/'));
}
module.exports = { URL, URLSearchParams, fileURLToPath, pathToFileURL };
