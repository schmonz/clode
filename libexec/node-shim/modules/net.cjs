'use strict';
// node:net — the -p bundle builds an SSRF/private-range `net.BlockList` at load
// (`new net.BlockList(); addSubnet("127.0.0.0",8,"ipv4"); ...`) and later
// check()s the target address, plus uses net.isIP*/net.Socket. Because the mock
// lives at 127.0.0.1 (inside 127.0.0.0/8), BlockList.check MUST behave exactly
// like host node's or the boot's local-address logic would diverge. isIP/BlockList
// are REAL (pure IP math). Characterized by test/node-shim-net.test.cjs.
//
// DIVERGENCE (loud, deferred): the actual socket surface (net.connect /
// createConnection / real Socket I/O / net.Server) is NOT implemented — the
// -p transport is txiki's native fetch, which never routes through node:net.
// Socket is a minimal EventEmitter subclass so class-refs / instanceof / subclass
// definitions at load resolve; connect/createConnection throw a branded wall.
const { EventEmitter } = require('node:events');

// ---- isIP family (real, matches host node semantics) ----
function isIPv4(s) {
  if (typeof s !== 'string') return false;
  const parts = s.split('.');
  if (parts.length !== 4) return false;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return false;
    if (p.length > 1 && p[0] === '0') return false;   // no leading zeros
    const n = Number(p);
    if (n < 0 || n > 255) return false;
  }
  return true;
}

function isIPv6(s) {
  if (typeof s !== 'string' || s.length === 0) return false;
  s = s.split('%')[0];                                 // strip zone id
  if (!s.includes(':')) return false;
  const dbl = s.split('::');
  if (dbl.length > 2) return false;
  const hex = (g) => /^[0-9a-fA-F]{1,4}$/.test(g);
  const groups = (str) => (str === '' ? [] : str.split(':'));
  const validate = (arr, tail) => {
    for (let i = 0; i < arr.length; i++) {
      const g = arr[i];
      const isLast = tail && i === arr.length - 1;
      if (isLast && g.includes('.')) { if (!isIPv4(g)) return false; }
      else if (!hex(g)) return false;
    }
    return true;
  };
  const head = groups(dbl[0]);
  const tail = dbl.length === 2 ? groups(dbl[1]) : null;
  // an embedded IPv4 in the final group counts as 2 sextets
  const count = (arr) => arr.reduce((n, g) => n + (g.includes('.') ? 2 : 1), 0);
  if (!validate(head, dbl.length !== 2)) return false;
  if (tail && !validate(tail, true)) return false;
  const total = count(head) + (tail ? count(tail) : 0);
  if (dbl.length === 2) return total <= 7;             // '::' fills >=1 group
  return total === 8;
}

function isIP(s) { return isIPv4(s) ? 4 : isIPv6(s) ? 6 : 0; }

// ---- BlockList (real) ----
function v4ToInt(s) {
  const p = s.split('.');
  return (Number(p[0]) * 16777216) + (Number(p[1]) * 65536) + (Number(p[2]) * 256) + Number(p[3]);
}
function v6ToBig(s) {
  s = s.split('%')[0];
  const dbl = s.split('::');
  const head = dbl[0] === '' ? [] : dbl[0].split(':');
  const tail = dbl.length === 2 ? (dbl[1] === '' ? [] : dbl[1].split(':')) : [];
  const expand = (arr) => {
    const out = [];
    for (const g of arr) {
      if (g.includes('.')) { const n = v4ToInt(g); out.push((n >>> 16) & 0xffff, n & 0xffff); }
      else out.push(parseInt(g, 16));
    }
    return out;
  };
  const h = expand(head); const t = expand(tail);
  const mid = new Array(8 - h.length - t.length).fill(0);
  const all = [...h, ...mid, ...t];
  let big = 0n;
  for (const g of all) big = (big << 16n) | BigInt(g >>> 0);
  return big;
}
function toNum(addr, family) {
  return family === 'ipv6' ? v6ToBig(addr) : v4ToInt(addr);
}

class BlockList {
  constructor() { this.rules = []; }
  addAddress(address, family = 'ipv4') {
    const f = normFamily(family, address);
    this.rules.push({ kind: 'addr', family: f, v: toNum(address, f) });
  }
  addRange(start, end, family = 'ipv4') {
    const f = normFamily(family, start);
    this.rules.push({ kind: 'range', family: f, lo: toNum(start, f), hi: toNum(end, f) });
  }
  addSubnet(net, prefix, family = 'ipv4') {
    const f = normFamily(family, net);
    const bits = f === 'ipv6' ? 128 : 32;
    const base = toNum(net, f);
    this.rules.push({ kind: 'subnet', family: f, base, prefix, bits });
  }
  check(address, family) {
    const f = family ? normFamily(family, address) : (isIPv6(address) ? 'ipv6' : 'ipv4');
    let v;
    try { v = toNum(address, f); } catch { return false; }
    for (const r of this.rules) {
      if (r.family !== f) continue;
      if (r.kind === 'addr' && r.v === v) return true;
      if (r.kind === 'range' && v >= r.lo && v <= r.hi) return true;
      if (r.kind === 'subnet') {
        if (f === 'ipv6') {
          const shift = BigInt(r.bits - r.prefix);
          if ((v >> shift) === (r.base >> shift)) return true;
        } else {
          const shift = r.bits - r.prefix;
          // shift of 32 is undefined in JS; guard prefix 0 (matches all)
          const mask = shift >= 32 ? 0 : (~((1 << shift) - 1)) >>> 0;
          if ((v & mask) >>> 0 === (r.base & mask) >>> 0) return true;
        }
      }
    }
    return false;
  }
}
function normFamily(family, sample) {
  if (family === 'ipv6' || family === 'ipv4') return family;
  return isIPv6(sample) ? 'ipv6' : 'ipv4';
}

// ---- Socket / Server (minimal class refs; real I/O is a deferred divergence) ----
class Socket extends EventEmitter {
  constructor(opts = {}) { super(); this._opts = opts; this.connecting = false; this.destroyed = false; }
  connect() { throw new Error('node-shim: net.Socket#connect not implemented (fetch is the -p transport)'); }
  write() { throw new Error('node-shim: net.Socket#write not implemented (fetch is the -p transport)'); }
  end() { this.destroyed = true; return this; }
  destroy() { this.destroyed = true; return this; }
  setTimeout() { return this; }
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  ref() { return this; }
  unref() { return this; }
}
class Server extends EventEmitter {
  listen() { throw new Error('node-shim: net.Server#listen not implemented'); }
  close(cb) { if (cb) queueMicrotask(cb); return this; }
}
function connectUnimpl() { throw new Error('node-shim: net.connect/createConnection not implemented (fetch is the -p transport)'); }

module.exports = {
  isIP, isIPv4, isIPv6, BlockList, Socket, Server, Stream: Socket,
  connect: connectUnimpl, createConnection: connectUnimpl,
};
module.exports.default = module.exports;
