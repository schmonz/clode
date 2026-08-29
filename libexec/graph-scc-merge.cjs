'use strict';
// graph-scc-merge — the ONE driver for the residual-cyclic-require merge.
//
// WHY THIS FILE EXISTS. Upstream Claude Code 2.1.248+ emits CJS
// `import.meta.require("/$bunfs/root/chunk-<hash>.js")` inside its own module graph.
// extract-claude-js.cjs's rewriteSafeRequires turns every such edge into a static import
// EXCEPT the ones that would close an import cycle (33 of 298 on 2.1.251). Those survive
// into the staged graph as runtime requires that NO host can answer:
//
//   under tjs   -> libexec/node-shim/loader.cjs resolveRequest():
//                  "node-shim: cannot resolve '/$bunfs/root/chunk-7wqzqa5j.js' from <dir>"
//   under node  -> require() of an ESM module that is in a cycle:
//                  "ERR_REQUIRE_CYCLE_MODULE: Cannot import Module /$bunfs/root/chunk-…"
//
// The fix (docs/superpowers/specs/2026-08-28-cyclic-scc-merge-design.md) is to make the
// cycle stop crossing a module boundary: every strongly connected group of the
// post-conversion graph is merged into ONE module (libexec/scc-merge.cjs) and each former
// member becomes a re-export shim onto it.
//
// It used to live inside libexec/quaude-fuse.js, which meant only the FUSED quaude ever
// got it. The graph runner — what naude embeds and what every oracle stages — was emitted
// from the UNMERGED graph and died on the first residual require, on both of its hosts.
// That is the bug this file's existence prevents from recurring: the merge is now a
// property of the STAGED GRAPH, so everything downstream of staging inherits it and there
// is no second place for it to be done differently.
//
// DEPENDENCY-INJECTED ON PURPOSE. libexec/quaude-fuse.js runs under tjs with no CJS
// resolver and loads its helpers with a require() that throws by design, so this file must
// require() nothing: callers hand in `plan` (bun-graph-plan.cjs), `merger` (scc-merge.cjs)
// and `metaOf`. That constraint is also what keeps it testable with fakes.

// Stamped into doc.sccMerge so a consumer can tell "already merged" from "nothing to
// merge" from "staged by something that did not know about merging at all".
var MERGE_FORMAT = 'clode-scc-merge-v1';

// The strongly connected groups of the staged graph, over static imports PLUS every
// remaining require edge. Exposed separately from mergeCyclicGroups because the caller
// has to know WHICH modules it needs metadata for before it can supply metaOf — asking an
// engine for 1800 modules' metadata when 111 are wanted is the difference between a
// staging step you notice and one you do not.
function cyclicGroupsOf(doc, plan) {
  var mods = modsOf(doc);
  return plan.cyclicGroups(mods);
}

function modsOf(doc) {
  var mods = new Map();
  for (var i = 0; i < doc.order.length; i++) {
    var name = doc.order[i];
    var src = doc.sources[name];
    if (typeof src !== 'string') {
      throw new Error('graph-scc-merge: staged graph has no source for ' + name);
    }
    mods.set(name, src);
  }
  return mods;
}

// Merge every cyclic group in `doc`, IN PLACE: member sources become their re-export
// shims, each merged module is added, doc.order is recomputed, and doc.sccMerge records
// what was done.
//
// opts: { plan, merger, metaOf, groups?, log? }
//   metaOf(name) -> the engine's own report of that module's top-level bindings/exports.
//     REQUIRED and never guessed from the text: mergeGroup renames only names a real
//     parser reported, because a merged module that silently shadows a binding compiles
//     and boots fine and then fails somewhere rare.
function mergeCyclicGroups(doc, opts) {
  var plan = opts.plan, merger = opts.merger, metaOf = opts.metaOf;
  var log = opts.log || function () { /* quiet */ };
  if (!plan || !merger || typeof metaOf !== 'function') {
    throw new Error('graph-scc-merge: plan, merger and metaOf are all required');
  }
  var mods = modsOf(doc);
  var groups = opts.groups || plan.cyclicGroups(mods);
  if (!groups.length) {
    // The caller only gets here when the graph reported residual cyclic requires, so no
    // group containing them means the graph and its own cyclicRequires list disagree.
    // Failing here names that; going on would ship a target that dies at runtime with
    // "cannot resolve", which is where this whole class of bug hides.
    throw new Error('graph-scc-merge: the staged graph reports residual cyclic require(s) '
      + 'but no strongly connected group contains them — the graph and its cyclicRequires '
      + 'list disagree, so there is nothing to merge and the build would fail at runtime.');
  }

  var rewritten = {};
  for (var i = 0; i < groups.length; i++) {
    // Body order inside a merged group is NOT the graph's topological order — a residual
    // require has to be able to read its target, and the target statically imports its way
    // back. See mergeBodyOrder in scc-merge.cjs.
    var ordered = merger.mergeBodyOrder(groups[i], doc.sources);
    var r = merger.mergeGroup(ordered, doc.sources, metaOf, i);
    rewritten[r.mergedName] = r.mergedSource;
    for (var j = 0; j < ordered.length; j++) {
      var m = ordered[j];
      if (typeof r.shims[m] !== 'string') {
        throw new Error('graph-scc-merge: merger emitted no shim for ' + m);
      }
      rewritten[m] = r.shims[m];
    }
    log('merged group ' + i + ' (' + groups[i].length + ' modules) -> ' + r.mergedName
      + ' (' + r.mergedSource.length + ' bytes)');
  }

  var names = Object.keys(rewritten);
  for (var k = 0; k < names.length; k++) {
    doc.sources[names[k]] = rewritten[names[k]];
    mods.set(names[k], rewritten[names[k]]);
  }

  // RE-SORT, rather than splicing each merged module in beside its first member. A merged
  // module imports the UNION of its members' external dependencies, and measured on
  // 2.1.250 all three groups have an external dependency that sits LATER in the staged
  // order than the group's own first member. Splicing before the first member would put
  // the merged module ahead of something it imports, and compile() would fail with "could
  // not load" on a module that is perfectly fine. The condensation of a graph by its
  // strongly connected components is a DAG by construction, so a topological order of the
  // post-merge graph always exists; planOrder throws by name if it ever does not.
  doc.order = plan.planOrder(mods);
  doc.sccMerge = {
    format: MERGE_FORMAT,
    mergerVersion: merger.MERGER_VERSION,
    groups: groups.map(function (g) { return g.length; }),
    merged: names.length,
  };
  return { groups: groups, rewritten: rewritten };
}

// THE RATCHET. Every require edge left in the staged graph whose target is a real graph
// module — i.e. every call site that will reach a host resolver that cannot answer it.
// After a merge this must be EMPTY, and the staging step asserts exactly that. It is the
// check that would have caught the 2.1.243+ graph-runner breakage the day it landed
// instead of after five CI jobs had been red for a week.
//
// Requires of EXTERNAL specifiers (`util`, `worker_threads`, …) are not residuals: those
// names are in doc.order because planGraph adds a generated shim module per external
// specifier, and every host answers them through __quaudeRequire. Only a require whose
// target is one of upstream's own modules is a problem, so external shims are excluded.
function residualCyclicRequires(doc, plan) {
  var externals = new Set(doc.externals || []);
  var real = new Set();
  for (var i = 0; i < doc.order.length; i++) {
    if (!externals.has(doc.order[i])) real.add(doc.order[i]);
  }
  var inGraph = function (s) { return real.has(s); };
  var out = [];
  for (var j = 0; j < doc.order.length; j++) {
    var from = doc.order[j];
    var targets = plan.requiresOf(doc.sources[from], inGraph);
    for (var t = 0; t < targets.length; t++) out.push([from, targets[t]]);
  }
  return out;
}

if (typeof module === 'object' && module.exports) {
  module.exports = { MERGE_FORMAT, cyclicGroupsOf, mergeCyclicGroups, residualCyclicRequires };
}
