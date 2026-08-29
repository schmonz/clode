'use strict';
// Binding-aware scan of the staged upstream bundle: "which properties of module
// M does upstream actually reference?"
//
// WHY THIS EXISTS, and why it is not the wall tripwire:
// test/node-shim-wall-tripwires.test.cjs deliberately matches only the DIRECT
// `require("fs").watch(` shape, because a binding-aware ALARM would be red on day
// one against vendored dead code, and a ratchet that is red before it catches
// anything is one nobody trusts. That reasoning is sound for an alarm. It is
// exactly WRONG for a MAP: when the output is a reviewed, goldened inventory
// rather than a pass/fail siren, over-inclusion costs a line of review and
// under-inclusion costs a silent gap. On 2026-08-01 that under-inclusion let the
// shim's fs.watch comment claim "the bundle has 0 call sites" while four
// existed, three of them first-party.
//
// So: the tripwire stays narrow and loud. This stays wide and quiet. They are
// answering different questions and must not be merged.
//
// TECHNIQUE. Upstream binds a builtin in four shapes, and a minifier renames
// every one of them:
//
//   var Zlm=require("fs")        object  -> Zlm.watch(...)
//   import*as Zn from"fs"        object  -> Zn.watch(...)
//   import O from"fs"            object  -> O.watch(...)
//   import{watch as zet}from"fs" named   -> zet(...)
//
// The three object shapes are resolved by finding the binding and then looking
// for `<binding>.<prop>`. The named shape needs no resolution at all: the import
// statement names the property outright, which makes it the STRONGEST signal
// here — and, since 2.1.243, by far the most common (185 of fs's 204 sites).
//
// RESOLUTION IS MODULE-SCOPED, and that is not a detail. Minified bindings are
// one and two characters — `n`, `e`, `_`, `L` — so a binding found anywhere and
// looked up everywhere turns `controller.abort()` in module A into evidence for
// `process.abort` because module B happens to bind `n` to node:process. The
// bundle is a GRAPH of 1832 modules with per-module scope, so the scan honors
// it: bindings are resolved only against the module that declared them.
//
// LIMITS, stated because a map that overstates its own reach is worse than none:
//   - Dynamic access (`fs[name]()`) is invisible. No regex fixes that.
//   - Re-export chains (`var A=require("fs"); var B=A;`) are not followed.
//   - A named import is counted as a REFERENCE, never as a call: `import{watch
//     as zet}` proves upstream reaches for fs.watch, but counting `zet(...)`
//     honestly would need scope-aware analysis no regex can do.
//   - Within one module, a binding name is still assumed unshadowed.
//   - Presence of a reference does NOT prove reachability at runtime. That is
//     the runtime recorder's job, not this file's.

const fs = require('node:fs');
const path = require('node:path');

function escapeSpec(spec) {
  return spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function specsFor(moduleName) {
  return [moduleName, `node:${moduleName}`];
}

// WHICH BYTES TO SCAN — the same lesson test/guard-subcommands-gate.test.cjs
// learned on 2026-08-29. From 2.1.243 the staged `cli.cjs` is not a carve, it is
// a GRAPH RUNNER clode generates, and it carries every module's source as a JSON
// string inside a JS string literal — so `from"fs"` arrives as `from\\\"fs\\\"`
// and every quoted pattern here misses. Identifier.property survives escaping
// (which is why layer 1's `Bun.ant` still showed up while all of layer 2 went
// dark), but that is luck, not design.
//
// graph.json holds `sources` as real strings: JSON.parse hands back exactly what
// upstream wrote, at no escape level, WITH the module boundaries that scoped
// resolution needs. Falls back to one pseudo-module of flat text for a
// pre-2.1.243 carve. Accepts a graph.json path or any file with one beside it.
function loadModules(bundlePath) {
  const graph = path.basename(bundlePath) === 'graph.json'
    ? bundlePath
    : path.join(path.dirname(bundlePath), 'graph.json');
  if (fs.existsSync(graph)) {
    const doc = JSON.parse(fs.readFileSync(graph, 'utf8'));
    if (doc && doc.sources && typeof doc.sources === 'object') {
      const mods = [];
      for (const [id, src] of Object.entries(doc.sources)) {
        if (typeof src === 'string') mods.push({ id, src });
      }
      if (mods.length) return mods;
    }
  }
  return [{ id: path.basename(bundlePath), src: fs.readFileSync(bundlePath, 'latin1') }];
}

// Flat text of the whole bundle. Still what layer 1 wants: `Bun.<prop>` and
// `"bun:<mod>"` need no module scope, only the same real (unescaped) source.
function loadBundle(bundlePath) {
  return loadModules(bundlePath).map((m) => m.src).join('\n');
}

// Object-binding names for `moduleName` declared IN THIS SOURCE.
function aliasesFor(text, moduleName) {
  const out = new Set();
  for (const spec of specsFor(moduleName)) {
    const esc = escapeSpec(spec);
    const pats = [
      // Capture the identifier being assigned. Allow an optional single-call
      // interop wrapper between `=` and `require(` (`X=__toESM(require("fs"))`).
      `([A-Za-z_$][A-Za-z0-9_$]*)\\s*=\\s*(?:[A-Za-z_$][A-Za-z0-9_$]*\\()?require\\(\\s*["']${esc}["']\\s*\\)`,
      `import\\s*\\*\\s*as\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s*from\\s*["']${esc}["']`,
      `import\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s*from\\s*["']${esc}["']`,
    ];
    for (const p of pats) {
      const re = new RegExp(p, 'g');
      let m;
      while ((m = re.exec(text)) !== null) out.add(m[1]);
    }
  }
  return out;
}

// Named imports of `moduleName` declared IN THIS SOURCE: prop -> site count.
function namedImportsFor(text, moduleName) {
  const out = new Map();
  for (const spec of specsFor(moduleName)) {
    const re = new RegExp(`import\\s*\\{([^}]{0,600}?)\\}\\s*from\\s*["']${escapeSpec(spec)}["']`, 'g');
    let m;
    while ((m = re.exec(text)) !== null) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+|:/)[0].trim();
        if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) out.set(name, (out.get(name) || 0) + 1);
      }
    }
  }
  return out;
}

// `var {watch, readFile: rf} = require("fs")` — kept for pre-ESM carves.
function destructuredFor(text, moduleName) {
  const out = new Set();
  for (const spec of specsFor(moduleName)) {
    const re = new RegExp(`\\{([^{}]{0,400}?)\\}\\s*=\\s*require\\(\\s*["']${escapeSpec(spec)}["']\\s*\\)`, 'g');
    let m;
    while ((m = re.exec(text)) !== null) {
      for (const part of m[1].split(',')) {
        const name = part.split(':')[0].trim();
        if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) out.add(name);
      }
    }
  }
  return out;
}

// Count `<alias>.<prop>` occurrences, distinguishing a call (`(` follows) from a
// bare read. A bare read matters: feature detection (`typeof fs.glob==="function"`)
// changes control flow without ever calling the thing.
//
// PERFORMANCE — why this is one indexed pass and not the obvious nested loop:
// the naive shape (for each alias, for each property, indexOf over the bundle)
// is O(aliases x props x bundleSize). Real numbers from this repo: `fs` alone
// resolves to 154 aliases, times ~40 missing properties, times a 255MB bundle,
// is ~1.5 TB of scanning for ONE module — it did not finish in two minutes when
// written that way. Instead, tokenize `<ident>.<ident>` ONCE into an index and
// answer every later question from the map. One pass, reused by all callers.
function buildIndex(text) {
  const index = new Map(); // "alias.prop" -> { calls, reads }
  const re = /([A-Za-z_$][A-Za-z0-9_$]*)\.([A-Za-z_$][A-Za-z0-9_$]*)\s*(\()?/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    // Reject `a.b.c` — the middle `.b` would otherwise look like a fresh alias
    // reference when it is really a property of something else.
    const before = text[m.index - 1];
    if (before === '.') continue;
    const key = `${m[1]}.${m[2]}`;
    let e = index.get(key);
    if (!e) { e = { calls: 0, reads: 0 }; index.set(key, e); }
    if (m[3]) e.calls++; else e.reads++;
  }
  return index;
}

function referencesTo(index, aliases, prop) {
  let calls = 0;
  let reads = 0;
  for (const alias of aliases) {
    const e = index.get(`${alias}.${prop}`);
    if (e) { calls += e.calls; reads += e.reads; }
  }
  return { calls, reads };
}

// One pass over the graph: per module, its `<ident>.<ident>` index plus every
// import/require binding it declares, keyed by specifier. Built once and reused
// for every module name the caller asks about — the same "index once, answer
// from the map" reason buildIndex exists, applied to the bindings too.
// The fourth shape, and the reason `specs` is not optional. Vendored CJS inside
// the graph does not call `require` by name: the bundler hands each such module
// its own require helper as an ordinary import —
//
//   import{ard as S,frd as c}from"/$bunfs/root/chunk-wcf10vzc.js"
//   var w=g().Buffer, l=c("crypto"), oe=c("util")
//
// — so `l.createSign("RSA-SHA256")` in jwa is a genuine crypto reference that no
// `require(` pattern can see. Matching `X=<ident>("spec")` generically would
// catch every `x=t("some string")` in the bundle, so it is admitted only for
// specifiers the caller actually asked about. That is why buildScope() takes the
// module list: the filter IS the safety.
const IMPORT_RE = new RegExp([
  'import\\s*\\*\\s*as\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s*from\\s*["\']([^"\']+)["\']',
  'import\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s*from\\s*["\']([^"\']+)["\']',
  'import\\s*\\{([^}]{0,600}?)\\}\\s*from\\s*["\']([^"\']+)["\']',
  '([A-Za-z_$][A-Za-z0-9_$]*)\\s*=\\s*(?:[A-Za-z_$][A-Za-z0-9_$]*\\()?require\\(\\s*["\']([^"\']+)["\']\\s*\\)',
  '([A-Za-z_$][A-Za-z0-9_$]*)\\s*=\\s*[A-Za-z_$][A-Za-z0-9_$]*\\(\\s*["\']([^"\']+)["\']\\s*\\)',
].join('|'), 'g');

// specs: the Set of specifiers worth recording (both spellings of each builtin).
function bindingsFor(src, specs) {
  const out = new Map(); // specifier -> { objects: Set, named: Map }
  const slot = (spec) => {
    if (!specs.has(spec)) return null;
    let e = out.get(spec);
    if (!e) { e = { objects: new Set(), named: new Map() }; out.set(spec, e); }
    return e;
  };
  const object = (name, spec) => { const e = slot(spec); if (e) e.objects.add(name); };
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(src)) !== null) {
    if (m[1]) object(m[1], m[2]);
    else if (m[3]) object(m[3], m[4]);
    else if (m[5] !== undefined) {
      const e = slot(m[6]);
      if (!e) continue;
      for (const part of m[5].split(',')) {
        const name = part.trim().split(/\s+as\s+|:/)[0].trim();
        if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) e.named.set(name, (e.named.get(name) || 0) + 1);
      }
    } else if (m[7]) object(m[7], m[8]);
    else if (m[9]) object(m[9], m[10]);
  }
  return out;
}

function specSet(moduleNames) {
  const out = new Set();
  for (const n of moduleNames) for (const s of specsFor(n)) out.add(s);
  return out;
}

function buildScope(modules, moduleNames) {
  const specs = specSet(moduleNames);
  return modules.map(({ id, src }) => ({ id, index: buildIndex(src), bindings: bindingsFor(src, specs) }));
}

// Does any module in the graph bind `moduleName` at all?
function scopeBinds(scope, moduleName) {
  const specs = specsFor(moduleName);
  for (const mod of scope) {
    for (const spec of specs) {
      const b = mod.bindings.get(spec);
      if (b && (b.objects.size || b.named.size)) return true;
    }
  }
  return false;
}

// References to `moduleName.prop`, resolved module by module.
function referencesIn(scope, moduleName, prop) {
  const specs = specsFor(moduleName);
  let calls = 0;
  let reads = 0;
  let imports = 0;
  for (const mod of scope) {
    for (const spec of specs) {
      const b = mod.bindings.get(spec);
      if (!b) continue;
      imports += b.named.get(prop) || 0;
      for (const obj of b.objects) {
        const e = mod.index.get(`${obj}.${prop}`);
        if (e) { calls += e.calls; reads += e.reads; }
      }
    }
  }
  return { calls, reads, imports };
}

module.exports = {
  aliasesFor, namedImportsFor, destructuredFor, referencesTo, buildIndex,
  loadBundle, loadModules, bindingsFor, specSet, buildScope, scopeBinds, referencesIn,
};
