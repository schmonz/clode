'use strict';
// Collects the two-layer shim-gap inventory. Pure data in, pure data out — the
// test file owns the assertions, this file owns the measurement.
//
// THE TWO LAYERS, because they fail differently and neither implies the other:
//
//   layer 1  Bun -> Node.  Claude Code is built by Bun and calls Bun-only APIs
//            (`Bun.spawn`, `bun:ffi`). libexec/bun-shim.cjs answers those with
//            Node equivalents. A gap here means the bundle asks Bun for
//            something we never emulated.
//
//   layer 2  Node -> txiki.  Everything (upstream's own Node calls, plus what
//            layer 1 just translated INTO Node calls) lands on
//            libexec/node-shim/*, which answers with tjs primitives. A gap here
//            means we hand upstream a Node API that isn't really there.
//
// A layer-1 gap can be MASKED by a layer-2 hit and vice versa, so both are
// measured against the same extracted bundle in one pass.
//
// WHICH ARTIFACT (this was got wrong once, on 2026-08-01, and it matters):
// scan the EXTRACTED cli.cjs (~21MB, what quaude actually runs), NOT the
// 255MB Bun-packaged `claude` binary. The binary additionally contains Bun's own
// runtime source — its `class FSWatcher`, its `node:fs` polyfill — so scanning it
// reports Bun's internal calls as though upstream made them. Concretely: the
// binary shows 74 distinct `Bun.*` properties, the extracted bundle 24. The
// other 50 were Bun's own runtime and type text.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const refs = require('./bundle-refs.cjs');

const REPO = path.resolve(__dirname, '..', '..');
const ENTRY = path.join(__dirname, 'enumerate-entry.cjs');
const LOADER = path.join(REPO, 'libexec/node-shim/loader.cjs');
const MODULES_DIR = path.join(REPO, 'libexec/node-shim/modules');

// The shim's module list IS the directory. Deriving it (rather than hardcoding)
// means a newly added shim module is measured the day it lands.
// `._*` are AppleDouble sidecars this repo's mount creates; they are not modules
// (see memory: git gc fails on them too).
function shimModuleNames() {
  return fs.readdirSync(MODULES_DIR)
    .filter((f) => f.endsWith('.cjs') && !f.startsWith('._'))
    .map((f) => f.replace(/\.cjs$/, ''))
    .sort();
}

function enumerateUnderNode(names) {
  const out = execFileSync(process.execPath, [ENTRY, ...names],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out).modules;
}

function enumerateUnderTjs(names, tjsBin, spawnArgv) {
  const [cmd, argv] = spawnArgv(['run', LOADER, ENTRY, ...names]);
  const out = execFileSync(cmd, argv,
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(out).modules;
}

// layer 2: node API present in real node, absent from the shim, and referenced
// by the bundle through a resolved import/require binding. `scope` is the
// per-module binding+index map from refs.buildScope(); resolution is scoped
// because minified bindings are one character long and a bundle-wide lookup
// turns any `n.abort()` into evidence for `process.abort`.
function layer2Gaps({ nodeSurface, shimSurface, scope }) {
  const gaps = [];
  const unenumerable = [];
  for (const name of Object.keys(nodeSurface)) {
    const ref = nodeSurface[name];
    const shim = shimSurface[name];
    if (!shim || !shim.ok || !ref.ok) {
      // Never silently drop: a module we could not enumerate is reported so the
      // caller can decide, rather than reading as "no gaps here".
      unenumerable.push({
        module: name,
        nodeOk: !!(ref && ref.ok),
        shimOk: !!(shim && shim.ok),
        error: (shim && shim.error) || (ref && ref.error) || null,
      });
      continue;
    }
    if (!refs.scopeBinds(scope, name)) continue; // bundle never imports this module at all
    for (const prop of Object.keys(ref.surface)) {
      if (prop in shim.surface) continue;
      const leaf = prop.split('.').pop();
      const r = refs.referencesIn(scope, name, leaf);
      // A named import (`import{watch as z}from"fs"`) is counted as a read, not
      // a call: it proves upstream reaches for the property, and says nothing
      // about how often the bound identifier is invoked.
      if (r.calls || r.reads || r.imports) {
        gaps.push({ api: `${name}.${prop}`, calls: r.calls, reads: r.reads + r.imports });
      }
    }
  }
  gaps.sort((a, b) => (b.calls - a.calls) || (b.reads - a.reads) || a.api.localeCompare(b.api));
  unenumerable.sort((a, b) => a.module.localeCompare(b.module));
  return { gaps, unenumerable };
}

// layer 1: `Bun.<prop>` and `bun:<mod>` the bundle uses that bun-shim doesn't answer.
function layer1Gaps({ text, index, bunProps, bunBuiltins }) {
  const propGaps = [];
  for (const [key, counts] of index) {
    if (!key.startsWith('Bun.')) continue;
    const prop = key.slice(4);
    if (bunProps.has(prop)) continue;
    propGaps.push({ api: `Bun.${prop}`, calls: counts.calls, reads: counts.reads });
  }
  propGaps.sort((a, b) => (b.calls - a.calls) || (b.reads - a.reads) || a.api.localeCompare(b.api));

  const used = new Set();
  for (const m of text.matchAll(/["'](bun:[a-zA-Z0-9_.-]+)["']/g)) used.add(m[1]);
  const moduleGaps = [...used].filter((m) => !bunBuiltins.includes(m)).sort();
  // Also worth surfacing: something we intercept that upstream no longer uses.
  // Not a defect, but it is dead weight and a sign the declaration has drifted.
  const unusedIntercepts = bunBuiltins.filter((m) => !used.has(m)).sort();

  return { propGaps, moduleGaps, unusedIntercepts };
}

module.exports = {
  REPO, ENTRY, LOADER, MODULES_DIR,
  shimModuleNames, enumerateUnderNode, enumerateUnderTjs,
  layer1Gaps, layer2Gaps,
};
