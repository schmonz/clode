'use strict';
// Surface enumeration, shared VERBATIM by both sides of the diff.
//
// The whole value of this file is that ONE implementation runs under host node
// (where `require('node:fs')` is the real thing) and under tjs+node-shim (where
// the same call lands on libexec/node-shim/modules/fs.cjs). Same traversal, same
// ordering, same exclusions — so any difference in the output is a difference in
// the SHIM, never an artifact of measuring the two sides differently. Do not
// "optimize" one caller by special-casing it here.
//
// WHY NOT invoke anything: a surface walk must be side-effect free. We read
// property NAMES via getOwnPropertyNames + getOwnPropertyDescriptor and never
// touch `descriptor.get`, because invoking a getter on a half-initialized shim
// module can throw (or, worse, lazily construct something and change behavior
// under measurement). A getter's presence is recorded; its value is not read.

// Namespaces worth descending into. Deliberately curated rather than "recurse
// everywhere": a blind deep walk hits cyclic references (stream.Readable
// .prototype.constructor), pulls in whole class hierarchies, and produces a
// golden file too noisy for a human to review — which is the failure mode that
// makes a ratchet worthless. Each entry here is a namespace the bundle actually
// reaches through.
const DESCEND = new Set([
  'fs.promises',
  'fs.realpath',
  'dns.promises',
  'timers.promises',
  'stream.promises',
  'stream.consumers',
  'util.types',
  'util.promisify',
  'child_process.promises',
  'readline.promises',
]);

// Property names present on every object/function by virtue of being one. They
// say nothing about whether an API is implemented, and including them would bury
// the real signal.
const UNINTERESTING = new Set([
  'length', 'name', 'prototype', 'constructor', 'caller', 'arguments',
  '__proto__', 'toString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf',
  'propertyIsEnumerable', 'toLocaleString', '__defineGetter__',
  '__defineSetter__', '__lookupGetter__', '__lookupSetter__',
]);

function kindOf(desc) {
  if (!desc) return 'absent';
  if (desc.get || desc.set) return 'accessor';
  const v = desc.value;
  if (typeof v === 'function') return 'function';
  if (v === null) return 'null';
  return typeof v;
}

// Walk one object, returning a sorted { "prop": "kind" } map. `prefix` is the
// dotted path used to consult DESCEND.
function walkObject(obj, prefix, out, seen) {
  if (obj === null || (typeof obj !== 'object' && typeof obj !== 'function')) return;
  if (seen.has(obj)) return;
  seen.add(obj);

  let names;
  try { names = Object.getOwnPropertyNames(obj); } catch { return; }

  for (const name of names.sort()) {
    if (UNINTERESTING.has(name)) continue;
    let desc;
    try { desc = Object.getOwnPropertyDescriptor(obj, name); } catch { continue; }
    const kind = kindOf(desc);
    const dotted = prefix ? `${prefix}.${name}` : name;
    out[dotted] = kind;

    // Descend only into curated, non-accessor object values. Reading
    // desc.value is safe (it's already materialized); reading a getter is not.
    if (DESCEND.has(dotted) && desc && !desc.get && desc.value
        && (typeof desc.value === 'object' || typeof desc.value === 'function')) {
      walkObject(desc.value, dotted, out, seen);
    }
  }
}

// Enumerate one module. Returns { ok: true, surface } or { ok: false, error }.
// A module that cannot be loaded is an EXPLICIT failure result, never a silent
// omission — "a skipped oracle is not a pass" applies here too: if we can't see
// a module's surface we must say so, or the diff will read the gap as "no gaps."
function walkModule(name, requireFn) {
  let mod;
  try {
    mod = requireFn(`node:${name}`);
  } catch (e) {
    try {
      mod = requireFn(name);
    } catch (e2) {
      return { ok: false, error: String((e2 && e2.message) || e2).slice(0, 200) };
    }
  }
  const out = Object.create(null);
  // A module whose export IS a function (assert, stream) still has a surface.
  walkObject(mod, '', out, new Set());
  const surface = {};
  for (const k of Object.keys(out).sort()) surface[k] = out[k];
  return { ok: true, rootType: typeof mod, surface };
}

module.exports = { walkModule, walkObject, DESCEND, UNINTERESTING };
