'use strict';
// node:url — WHATWG URL is native in txiki; file-URL helpers are ours.
function fileURLToPath(u) {
  const url = typeof u === 'string' ? new URL(u) : u;
  if (url.protocol !== 'file:') throw new TypeError('node-shim: fileURLToPath: not a file URL');
  return decodeURIComponent(url.pathname);
}
function pathToFileURL(p) {
  const path = require('node:path');
  let abs = path.resolve(String(p));
  if (globalThis.process && process.platform === 'win32') {
    // Windows: node emits file:///C:/dir/file. Convert backslashes to forward
    // slashes, add a leading slash before the drive, and percent-encode each
    // segment EXCEPT the drive-letter (its ':' must stay literal) and the '/'
    // separators (never encoded — they're the join char).
    abs = abs.replace(/\\/g, '/');
    if (!abs.startsWith('/')) abs = '/' + abs;
    const enc = abs.split('/').map((seg) => /^[a-zA-Z]:$/.test(seg) ? seg : encodeURIComponent(seg)).join('/');
    return new URL('file://' + enc);
  }
  return new URL('file://' + abs.split('/').map(encodeURIComponent).join('/'));
}
// ---- legacy url.parse/format/resolve/domainTo* -----------------------------
// The bundle uses the legacy (deprecated) API: url.parse (12×), format (4×),
// resolve, domainToASCII. Implemented over the native WHATWG URL for absolute
// inputs (the mainline: API/auth URLs), producing the legacy Url field shape
// characterization-locked to host node in test/node-shim-url.test.cjs. A schemeless
// or protocol-relative input is handled with a minimal relative split (protocol/
// host null; pathname/search/hash filled) — matching legacy for the shapes the
// bundle feeds it. `slashes` reflects the special hierarchical schemes.
const SLASHED = /^(?:https?|ftp|file|ws|wss|gopher):$/;

function legacyParse(urlStr, parseQueryString, slashesDenoteHost) {
  const querystring = require('node:querystring');
  let u = null;
  try { u = new URL(urlStr); } catch { u = null; }
  if (u) {
    const searchStr = u.search || null;
    const auth = u.username ? (u.password ? `${u.username}:${u.password}` : u.username) : null;
    const out = {
      protocol: u.protocol || null,
      slashes: SLASHED.test(u.protocol) || urlStr.slice(u.protocol.length, u.protocol.length + 2) === '//' ? true : null,
      auth,
      host: u.host || null,
      port: u.port || null,
      hostname: u.hostname || null,
      hash: u.hash || null,
      search: searchStr,
      query: parseQueryString ? querystring.parse(searchStr ? searchStr.slice(1) : '') : (searchStr ? searchStr.slice(1) : null),
      pathname: u.pathname || null,
      path: (u.pathname || '') + (searchStr || '') || null,
      href: u.href,
    };
    return out;
  }
  // Relative / schemeless: split hash, then search, rest is pathname.
  let rest = String(urlStr);
  let hash = null, search = null;
  const hi = rest.indexOf('#');
  if (hi !== -1) { hash = rest.slice(hi); rest = rest.slice(0, hi); }
  const si = rest.indexOf('?');
  if (si !== -1) { search = rest.slice(si); rest = rest.slice(0, si); }
  const pathname = rest || null;
  return {
    protocol: null, slashes: null, auth: null, host: null, port: null, hostname: null,
    hash, search,
    query: parseQueryString ? querystring.parse(search ? search.slice(1) : '') : (search ? search.slice(1) : null),
    pathname, path: (pathname || '') + (search || '') || null, href: String(urlStr),
  };
}

function legacyFormat(urlObj) {
  if (typeof urlObj === 'string') return urlObj;
  if (urlObj instanceof URL) return urlObj.href; // options (fragment/search/auth/unicode) ignored — documented divergence
  const querystring = require('node:querystring');
  let protocol = urlObj.protocol || '';
  if (protocol && !protocol.endsWith(':')) protocol += ':';
  const slashes = urlObj.slashes || SLASHED.test(protocol);
  let auth = urlObj.auth ? `${urlObj.auth}@` : '';
  const host = urlObj.host != null ? urlObj.host
    : (urlObj.hostname != null ? urlObj.hostname + (urlObj.port ? `:${urlObj.port}` : '') : '');
  const pathname = urlObj.pathname || '';
  let search = urlObj.search || '';
  if (!search && urlObj.query != null) {
    search = typeof urlObj.query === 'object' ? '?' + querystring.stringify(urlObj.query) : (urlObj.query ? '?' + urlObj.query : '');
  }
  if (search && !search.startsWith('?')) search = '?' + search;
  let hash = urlObj.hash || '';
  if (hash && !hash.startsWith('#')) hash = '#' + hash;
  return protocol + (slashes ? '//' : '') + auth + host + pathname + search + hash;
}

function resolve(from, to) {
  try { return new URL(to, from).href; }
  catch { return to; }
}
function domainToASCII(domain) {
  try { return new URL(`http://${domain}`).hostname; } catch { return ''; }
}
function domainToUnicode() {
  // Requires an IDNA-to-unicode decode this build's URL does not expose; the
  // bundle only uses domainToASCII. Fail loud rather than return a wrong value.
  throw new Error('node-shim: url.domainToUnicode not implemented');
}

// Legacy Url class placeholder so `url.Url` reads as a function (feature-detect).
function Url() {}

const urlMod = {
  URL, URLSearchParams, fileURLToPath, pathToFileURL,
  parse: legacyParse, format: legacyFormat, resolve, domainToASCII, domainToUnicode, Url,
};
urlMod.default = urlMod;
module.exports = urlMod;
