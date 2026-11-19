'use strict';
// The shim-surface reader, extended from "upstream references this API" to "upstream CALLS this
// API, with these arguments". bundle-refs.cjs answers presence (the gap map); this file answers
// shape: for every call site of a builtin module's function in the carve, which arguments it passes,
// and for each argument whether it is a literal (`{throwIfNoEntry:!1}`, `"utf8"`, `384`), a set of
// fs.constants flags (`w.O_WRONLY|w.O_CREAT|w.O_EXCL`), or an expression the scan cannot read.
// test/node-shim-differential.test.cjs replays those shapes under node and under tjs+node-shim.
//
// The bindings are the same four shapes bundle-refs.cjs resolves, module by module (minified names
// are one or two characters, so a binding is only looked up in the module that declared it):
//   import{statSync as z}from"fs"     ->  z(...)
//   import*as X from"fs" / import X from"fs" / X=require("fs") / X=c("fs")  ->  X.statSync(...)
//   {statSync:z,mkdir}=require("fs") / ...=c("fs")  ->  z(...), mkdir(...)          (destructured)
//   X.promises.readFile(...) with X bound to "fs"  ->  fs/promises.readFile          (the promises member)
// The last two were blind until 2026-11-19 (final review): the 2.1.283 carve has 28 `X.promises.m(` sites and 17
// destructured requires of builtins (none of fs, os or child_process; util 7, crypto 5, url 2, stream, http, events).
//
// LIMITS, stated so the inventory is not read as more than it is:
//   - a call through a re-bound name (`let f=z; f(...)`), `X[name](...)`, `.call/.apply` is not seen;
//   - an argument the scan cannot read is `{ expr: true }`, never guessed;
//   - one module's local name is assumed unshadowed within that module (as in bundle-refs.cjs).
const refs = require('./bundle-refs.cjs');

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const MAX_ARGS_TEXT = 4000;

// From the '(' at `open`, the index of its matching ')', honouring strings, templates (and their
// ${} holes), regex-free (a '/' is never treated as a regex start: a mis-scan only truncates that
// one site, which is then `unparsed`). -1 when it does not close within MAX_ARGS_TEXT.
function matchParen(src, open) {
  let depth = 0;
  const end = Math.min(src.length, open + MAX_ARGS_TEXT);
  for (let i = open; i < end; i++) {
    const c = src[i];
    if (c === '"' || c === "'") {
      for (i++; i < end && src[i] !== c; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (c === '`') { i = skipTemplate(src, i + 1, end); if (i < 0) return -1; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return c === ')' ? i : -1;
    }
  }
  return -1;
}

// Scans a template body from `i` (just after the opening backtick); returns the index of the
// closing backtick. `${...}` holes are scanned as code.
function skipTemplate(src, i, end) {
  for (; i < end; i++) {
    const c = src[i];
    if (c === '\\') { i++; continue; }
    if (c === '`') return i;
    if (c === '$' && src[i + 1] === '{') {
      const close = matchBrace(src, i + 1, end);
      if (close < 0) return -1;
      i = close;
    }
  }
  return -1;
}

function matchBrace(src, open, end) {
  let depth = 0;
  for (let i = open; i < end; i++) {
    const c = src[i];
    if (c === '"' || c === "'") { for (i++; i < end && src[i] !== c; i++) if (src[i] === '\\') i++; continue; }
    if (c === '`') { i = skipTemplate(src, i + 1, end); if (i < 0) return -1; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// Top-level comma split of an argument list's text.
function splitTop(text) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'") { for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++; continue; }
    if (c === '`') { i = skipTemplate(text, i + 1, text.length); if (i < 0) return null; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) { out.push(text.slice(start, i)); start = i + 1; }
  }
  const last = text.slice(start);
  if (last.trim() || out.length) out.push(last);
  return out.map((s) => s.trim());
}

// One argument's text -> a literal, a flags set, an object of those, or { expr: true }.
function classify(text) {
  const t = text.trim();
  if (t === '!0') return { lit: true };
  if (t === '!1') return { lit: false };
  if (t === 'null') return { lit: null };
  if (t === 'void 0') return { undef: true };
  if (/^-?(?:0x[0-9a-fA-F]+|0o[0-7]+|\d+(?:\.\d+)?(?:e\d+)?)$/.test(t)) return { lit: Number(t) };
  if (/^"(?:[^"\\]|\\.)*"$/.test(t) || /^'(?:[^'\\]|\\.)*'$/.test(t)) {
    try { return { lit: JSON.parse(t[0] === '"' ? t : `"${t.slice(1, -1).replace(/"/g, '\\"')}"`) }; } catch { return { expr: true }; }
  }
  if (/^`[^`$\\]*`$/.test(t)) return { lit: t.slice(1, -1) };
  // fs.constants flags: `X.O_WRONLY|X.O_CREAT|f` (a bare variable among them is kept as `more`)
  if (/^[\w$.|]+$/.test(t) && /\.O_[A-Z_]+/.test(t) && t.includes('|') || /^[A-Za-z_$][\w$]*\.O_[A-Z_]+$/.test(t)) {
    const parts = t.split('|');
    const flags = [];
    let more = false;
    for (const p of parts) {
      const m = /^[A-Za-z_$][\w$]*\.(O_[A-Z_]+)$/.exec(p);
      if (m) flags.push(m[1]); else more = true;
    }
    return more ? { flags, more: true } : { flags };
  }
  if (t[0] === '{' && t[t.length - 1] === '}') {
    const parts = splitTop(t.slice(1, -1));
    if (!parts) return { expr: true };
    const obj = {};
    let spread = false;
    for (const p of parts) {
      if (!p) continue;
      if (p.startsWith('...')) { spread = true; continue; }
      const m = /^([A-Za-z_$][\w$]*|"[^"]*"|'[^']*')\s*:([\s\S]*)$/.exec(p);
      if (m) { obj[m[1].replace(/^["']|["']$/g, '')] = classify(m[2]); continue; }
      if (IDENT.test(p)) { obj[p] = { expr: true }; continue; } // shorthand {recursive}
      return { expr: true }; // a method, a computed key: not an options bag we can read
    }
    return spread ? { obj, spread: true } : { obj };
  }
  return { expr: true };
}

// A shape is the classified argument list; its key is a stable string so equal shapes count once.
function shapeKey(args) { return JSON.stringify(args); }

// Per module of the graph: every call of a function of one of `moduleNames`, with its arguments.
// -> Map api -> { sites, shapes: Map shapeKey -> { args, count } }
function callSites(modules, moduleNames) {
  const specs = refs.specSet(moduleNames);
  const inv = new Map();
  const add = (api, args) => {
    let e = inv.get(api);
    if (!e) { e = { sites: 0, shapes: new Map() }; inv.set(api, e); }
    e.sites++;
    const k = shapeKey(args);
    const s = e.shapes.get(k);
    if (s) s.count++; else e.shapes.set(k, { args, count: 1 });
  };
  for (const { src } of modules) {
    const bindings = refs.bindingsFor(src, specs);
    const destructured = [...src.matchAll(/\{([^{}=]{1,600})\}\s*=\s*(?:require|[A-Za-z_$][\w$]*)\(\s*["']([^"']+)["']\s*\)/g)]
      .filter((m) => specs.has(m[2]));
    if (!bindings.size && !destructured.length) continue;
    const named = new Map();   // local -> api
    const objects = new Map(); // object binding -> module name
    for (const [spec, b] of bindings) {
      const mod = spec.replace(/^node:/, '');
      for (const o of b.objects) objects.set(o, mod);
    }
    // named imports with their LOCAL names (bindingsFor keeps only the imported names)
    for (const m of src.matchAll(/import\s*\{([^}]{0,600}?)\}\s*from\s*["']([^"']+)["']/g)) {
      if (!specs.has(m[2])) continue;
      const mod = m[2].replace(/^node:/, '');
      for (const part of m[1].split(',')) {
        const [imported, local] = part.trim().split(/\s+as\s+/).map((s) => s && s.trim());
        if (imported && IDENT.test(imported)) named.set(local && IDENT.test(local) ? local : imported, `${mod}.${imported}`);
      }
    }
    for (const m of destructured) {
      const mod = m[2].replace(/^node:/, '');
      for (const part of m[1].split(',')) {
        const [imported, local] = part.trim().split(/\s*:\s*/);
        if (imported && IDENT.test(imported)) named.set(local && IDENT.test(local) ? local : imported, `${mod}.${imported}`);
      }
    }
    const record = (api, open) => {
      const close = matchParen(src, open);
      if (close < 0) { add(api, [{ unparsed: true }]); return; }
      const parts = splitTop(src.slice(open + 1, close));
      add(api, parts ? parts.map(classify) : [{ unparsed: true }]);
    };
    for (const pm of src.matchAll(/([A-Za-z_$][\w$]*)\.promises\.([A-Za-z_$][\w$]*)\s*\(/g)) {
      const before = src[pm.index - 1];
      if (before === '.' || (before && /[\w$]/.test(before)) || !objects.has(pm[1])) continue;
      const sub = `${objects.get(pm[1])}/promises`;
      if (moduleNames.includes(sub)) record(`${sub}.${pm[2]}`, pm.index + pm[0].length - 1);
    }
    const re = /([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?\s*\(/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const before = src[m.index - 1];
      if (before === '.' || (before && /[\w$]/.test(before))) continue;
      let api = null;
      if (m[2] !== undefined) { if (objects.has(m[1])) api = `${objects.get(m[1])}.${m[2]}`; }
      else if (named.has(m[1]) && !/function\s*$/.test(src.slice(Math.max(0, m.index - 12), m.index))) api = named.get(m[1]);
      if (!api) continue;
      record(api, m.index + m[0].length - 1);
    }
  }
  return inv;
}

// The inventory as plain data, APIs filtered to those the ORACLE's module really exports as functions
// (minified names collide with everything; node's own surface is the filter).
function inventory(modules, moduleNames, nodeExports) {
  const inv = callSites(modules, moduleNames);
  const out = {};
  for (const [api, e] of [...inv].sort((a, b) => a[0].localeCompare(b[0]))) {
    const dot = api.indexOf('.');
    const mod = api.slice(0, dot);
    const prop = api.slice(dot + 1);
    if (!nodeExports[mod] || nodeExports[mod][prop] !== 'function') continue;
    out[api] = { sites: e.sites, shapes: [...e.shapes.values()].sort((a, b) => b.count - a.count) };
  }
  return out;
}

module.exports = { matchParen, splitTop, classify, callSites, inventory };

// Non-function exports the bundle reads (os.devNull, path.sep, process.platform): a value is
// judged by what it is, so these join the inventory as `value` entries.
function valueReads(modules, moduleNames, nodeExports) {
  const scope = refs.buildScope(modules, moduleNames);
  const out = {};
  for (const mod of moduleNames) {
    for (const [prop, type] of Object.entries(nodeExports[mod] || {})) {
      if (type === 'function') continue;
      const r = refs.referencesIn(scope, mod, prop);
      if (r.calls || r.reads || r.imports) out[`${mod}.${prop}`] = { reads: r.calls + r.reads + r.imports, type };
    }
  }
  return out;
}

module.exports.valueReads = valueReads;
