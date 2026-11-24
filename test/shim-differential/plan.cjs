'use strict';
// Inventory (from the carve) + table (how to call) -> the plan of concrete cases, and the coverage
// findings. PURE: no I/O. The carve decides what is judged; this file only fills the positions the
// carve leaves as expressions, from the table's samples.
//
// PROPERTY-DRIVEN, BOUNDED. For one carve shape, every argument position has a list of candidates (a
// carve literal is a list of one; an expression is the kind's samples). The shape expands to as many
// cases as its longest list, case j taking candidate j of each list (modulo its length), so every
// sample appears at least once in every position the carve fills, without a cartesian blow-up. Equal
// cases (same id) count once. Each API is capped (default CAP), the carve's most frequent shapes
// first; the driver's hand-picked `extra` lists come after and are never capped. What the cap leaves
// out, and every carve shape cut to the driver's argument count, is REPORTED (`capped`, `truncated`),
// never silent: the gate prints both on every run.
const T = require('./table.cjs');

const CAP = 60;

function inferStyle(api, driver) {
  if (driver.style) return driver.style;
  if (api.startsWith('fs/promises.')) return 'promise';
  if (api.startsWith('fs.')) return api.endsWith('Sync') ? 'sync' : 'callback';
  return 'sync';
}

function describe(a) {
  if (a === undefined) return 'undefined';
  if ('path' in a) return `<${a.path}>`;
  if ('abs' in a) return JSON.stringify(a.abs);
  if ('rel' in a) return `rel:${a.rel}`;
  if ('v' in a) return JSON.stringify(a.v);
  if (a.undef) return 'undefined';
  if ('flags' in a) return a.flags.join('|') || '0';
  if ('buf' in a) return `buf:${a.buf}`;
  if ('fd' in a) return `fd:${a.fd}`;
  if (a.signal) return '<signal>';
  if (a.env) return '<env>';
  if (a.cwd) return '<cwd>';
  if (a.arr) return `[${a.arr.map(describe).join(',')}]`;
  if (a.obj) return `{${Object.entries(a.obj).map(([k, v]) => `${k}:${describe(v)}`).join(',')}}`;
  return JSON.stringify(a);
}

// One classified carve argument -> its candidate list, or null when the shape cannot be replayed.
function candidates(arg, kind, driver, api, missingKeys) {
  if (!arg || arg.unparsed) return null;
  const samples = T.SAMPLES[kind] || T.SAMPLES.any;
  const pathish = ['path', 'statpath', 'newpath', 'dest', 'prefix'].includes(kind);
  if (/^fd/.test(kind)) return samples; // a literal descriptor (1, 2) is the executor's own stdio: never touched
  if ('lit' in arg) {
    if (pathish) {
      // an absolute literal path is read where it is (/proc, /home); never written to
      if (typeof arg.lit === 'string' && arg.lit.startsWith('/') && !driver.mutates) return [{ abs: arg.lit }];
      return samples;
    }
    return [{ v: arg.lit }];
  }
  if (arg.undef) return [{ undef: true }];
  if (arg.flags) return [{ flags: arg.flags }];
  if (arg.obj) {
    const obj = {};
    for (const [k, v] of Object.entries(arg.obj)) {
      if ('lit' in v) obj[k] = { v: v.lit };
      else if (v.undef) obj[k] = { undef: true };
      else if (v.flags) obj[k] = { flags: v.flags };
      else {
        const s = (driver.keys && driver.keys[k]) || T.KEY_SAMPLES[k];
        if (s) obj[k] = s;
        else missingKeys.add(`${api}: option "${k}" is passed as an expression in the carve and has no sample (table.cjs KEY_SAMPLES)`);
      }
    }
    return [{ obj }];
  }
  return samples;
}

function expandShape(lists) {
  if (!lists.length) return [[]];
  const n = Math.max(...lists.map((l) => l.length));
  const out = [];
  for (let j = 0; j < n; j++) out.push(lists.map((l) => l[j % l.length]));
  return out;
}

// inventory: { api: { sites, shapes: [{ args, count }] } }  (call-sites.cjs inventory())
// values:    { api: { reads, type } }                         (call-sites.cjs valueReads())
// -> { cases, findings, uncovered, capped: [{api, planned, left}], truncated: [{api, shapes, from, to}] }
// `platform` is the carve's (the provider is the host's own, as the gate stages it): a table entry
// with `only` is expected in those carves alone (one upstream version carves differently per
// platform: the linux carve calls fs.statfsSync, the darwin one does not).
const expected = (entry, platform) => !(entry && typeof entry === 'object' && entry.only && !entry.only.includes(platform));

function makePlan({ inventory, values, table = T, platform = process.platform }) {
  const cases = [];
  const findings = [];
  const capped = [];
  const truncated = [];
  const missingKeys = new Set();
  const seen = new Set();
  const push = (c) => { if (!seen.has(c.id)) { seen.add(c.id); cases.push(c); return true; } return false; };

  for (const [api, inv] of Object.entries(inventory)) {
    const driver = table.DRIVERS[api];
    if (!driver) {
      if (!table.UNCOVERED[api]) findings.push(`${api}: the carve calls it (${inv.sites} sites) and the table neither drives it nor says why not (UNCOVERED)`);
      continue;
    }
    if (table.UNCOVERED[api]) findings.push(`${api}: both driven and listed UNCOVERED; drop one`);
    const style = inferStyle(api, driver);
    const cap = driver.cap || CAP;
    let n = 0;
    const lists = [];
    const cut = inv.shapes.filter((sh) => sh.args.length > driver.args.length);
    if (cut.length) truncated.push({ api, shapes: cut.length, from: Math.max(...cut.map((sh) => sh.args.length)), to: driver.args.length });
    for (const shape of inv.shapes) {
      const args = shape.args.slice(0, driver.args.length);
      const per = args.map((a, i) => candidates(a, driver.args[i], driver, api, missingKeys));
      if (per.some((p) => p === null)) continue;
      lists.push(per);
    }
    const plan1 = (args) => {
      const id = `${api}(${args.map(describe).join(', ')})`;
      // /proc/self/<entry> is the READER's: its own state is judged by what kind of answer (table.cjs PROC_SELF)
      let own = false;
      for (const a of args) {
        const m = a && typeof a.abs === 'string' && /^\/proc\/self(?:\/([^/]*))?/.exec(a.abs);
        if (!m) continue;
        const cls = table.PROC_SELF[m[1] || ''];
        if (cls === 'own') own = true;
        else if (cls !== 'same') findings.push(`${api}: the carve reads ${a.abs}, and /proc/self/${m[1]} is not classified (table.cjs PROC_SELF): is it the reader's own state, or the same for both sides?`);
      }
      return push({ id, api, style, args, post: own ? 'typeof' : driver.post, mutates: !!driver.mutates });
    };
    let left = 0;
    const ids = new Set();
    for (const per of lists) {
      for (const args of expandShape(per)) {
        if (n >= cap) { const id = `${api}(${args.map(describe).join(', ')})`; if (!seen.has(id) && !ids.has(id)) { ids.add(id); left++; } continue; }
        if (plan1(args)) n++;
      }
    }
    if (left) capped.push({ api, planned: n, left });
    for (const extra of driver.extra || []) if (plan1(extra)) n++;
    if (n === 0) findings.push(`${api}: driven, but no carve shape could be replayed (every one unparsed)`);
  }
  for (const api of Object.keys(table.UNCOVERED)) {
    if (!inventory[api] && expected(table.UNCOVERED[api], platform)) findings.push(`${api}: listed UNCOVERED but the carve no longer calls it; drop it`);
  }
  for (const [api, d] of Object.entries(table.DRIVERS)) {
    if (!inventory[api] && !d.addition && expected(d, platform)) findings.push(`${api}: driven but the carve does not call it; drop it or mark it an addition with a reason`);
  }
  for (const api of Object.keys(values || {})) {
    push({ id: `${api} (value)`, api, style: 'value', args: [], post: table.VALUE_POST[api] });
  }
  findings.push(...missingKeys);
  const uncovered = Object.keys(inventory).filter((api) => table.UNCOVERED[api]);
  return { cases, findings, uncovered, capped, truncated };
}

module.exports = { makePlan, describe, expandShape, inferStyle, CAP };
