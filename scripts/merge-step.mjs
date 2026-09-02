// merge-step — the cyclic-group merge as a protocol-only component (phase-2 design §2:
// "a build COMPONENT declares its own steps and reports events; an ORCHESTRATOR composes
// them without knowing what the steps are"). This is the merge, and nothing else: the
// worker that spawns it (libexec/quaude-fuse.js) does not know how it merges, only that
// it does — the same relationship quaude-fuse.js itself has with clode-fuse.cjs (its own
// argv contract is the style this one follows, quaude-fuse.js:7-21).
//
// Usage (spawned by quaude-fuse.js, not by hand — though it is ALSO meant to be run by
// hand, which is the whole point of extracting it: "worth being able to run, time, and
// cache on its own"):
//   tjs run merge-step.mjs <graph.json> <libexec-dir> <stage-dir>
//
//   graph.json:  the staged graph doc — read-only. Its cyclicRequires says how much work
//     this step has; its sccMerge, if present, says the merge already happened at staging
//     (libexec/clode-extract.cjs) and there is nothing left to do.
//   libexec-dir: directory holding scc-merge.cjs, bun-graph-plan.cjs and
//     graph-scc-merge.cjs — the SAME driver libexec/clode-extract.cjs calls under node
//     (graph-scc-merge.cjs is the ONE implementation; this file supplies the tjs-only
//     half, the engine that answers moduleMeta, and this cache).
//   stage-dir:   where the result is cached, as <stage-dir>/graph-merged.json — keyed on
//     stage-dir's own basename (the provider key) AND the merger's MERGER_VERSION, so
//     editing scc-merge.cjs invalidates every existing cache rather than silently having
//     no effect on a machine that already built once. The caller (quaude-fuse.js) reads
//     this file back and applies it onto its OWN in-memory doc; this process never writes
//     graph.json itself.
//
// Emits the `merge` step (plan/start/finish) through libexec/build-report.cjs on stdout,
// MARK-prefixed — quaude-fuse.js spawns this with stdout/stderr INHERITED, so these lines
// land directly in the same stream clode-fuse.cjs already ingests at the spawn seam
// (libexec/clode-fuse.cjs:889); there is no relay code on either side, only a shared fd.
//
// Same posture as libexec/graph-meta.js (the sibling extraction that answers moduleMeta
// for the NODE-hosted half of this same merge): a bare tjs script, no module resolver,
// console.error + tjs.exit(N) on failure rather than throwing, so a killed or refused run
// is an ordinary nonzero exit the caller can check without parsing a stack trace.
import path from 'tjs:path';

const [graphPath, libexecDir, stageDir] = tjs.args.slice(3);
if (!stageDir) {
  console.error('usage: tjs run merge-step.mjs <graph.json> <libexec-dir> <stage-dir>');
  tjs.exit(64);
}

const enc = new TextEncoder();
const dec = new TextDecoder();

async function mustRead(file, what) {
  try { return await tjs.readFile(file); }
  catch (e) {
    console.error(`merge-step: cannot read ${what}: ${file} (${e.message ?? e})`);
    tjs.exit(1);
  }
}

// libexec/*.cjs, loaded by a script that runs under tjs with no CJS resolver of its own —
// the SAME reason quaude-fuse.js carries this exact helper (its own copy, not shared: two
// independently-spawned processes, no module system between them). Both files it loads
// this way are deliberately dependency-free, so require() is a loud stub rather than a
// resolver.
function loadLibexecCjs(src, file) {
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', '__filename', src)(
    mod, mod.exports,
    (spec) => {
      throw new Error(`merge-step: ${file} tried to require(${spec}) — this script loads it `
        + 'with no module resolver. Keep the libexec .cjs files it loads dependency-free.');
    },
    file,
  );
  return mod.exports;
}

const { Reporter } = loadLibexecCjs(
  dec.decode(await mustRead(path.join(libexecDir, 'build-report.cjs'), 'the step reporter')),
  'build-report.cjs');
const report = new Reporter({ emit: (line) => { console.log(line); } });

// Extraction is already cached once per provider in ~/.cache/clode/<key>/ (cli.cjs,
// bun-shim.cjs); the merged graph belongs beside them so every later build of the same
// provider, for any target, reuses it. MUST MATCH quaude-fuse.js's own read-back of this
// filename — the two processes' sole shared contract for the merged bytes.
const MERGED_CACHE_FILE = 'graph-merged.json';
const MERGED_CACHE_FORMAT = 'clode-scc-merge-v1';

const doc = JSON.parse(dec.decode(await mustRead(graphPath, 'the staged graph')));
// `|| []` on purpose: absent and empty are the same thing, and both are an exact no-op.
const cyclicRequires = doc.cyclicRequires || [];

report.plan([{ name: 'merge', total: cyclicRequires.length }]);
report.start('merge');

if (!cyclicRequires.length) {
  // 2.1.247 and earlier have no cyclic requires at all — nothing to do, nothing to cache.
} else if (doc.sccMerge) {
  // ALREADY MERGED, AT STAGING (libexec/clode-extract.cjs) — the staged graph is the
  // input to BOTH targets, and doing the merge there means a graph-runner naude embeds —
  // and every node-shim oracle stages — from an already-merged doc instead of dying on
  // the first residual require. This is the fallback for a doc staged before that moved;
  // both paths run the SAME libexec/graph-scc-merge.cjs.
  console.log(`merge-step: the staged graph is already merged (${doc.sccMerge.format}, `
    + `merger ${doc.sccMerge.mergerVersion}, groups ${doc.sccMerge.groups.join(', ')}) `
    + '— nothing to do');
} else {
  // The named escape hatch: refuse to build rather than merge. Kept from the warn-only
  // version of this block so a bisect can separate "the merge is wrong" from "the graph
  // is wrong" without editing this file.
  if (tjs.env.CLODE_ALLOW_CYCLIC_REQUIRES === '0') {
    const listed = cyclicRequires.slice(0, 5)
      .map(([from, to]) => '    ' + from + ' -> ' + to).join('\n');
    console.error('merge-step: ' + cyclicRequires.length + ' CJS require(s) of a graph'
      + ' module could not be converted to imports (converting would close an import cycle):\n'
      + listed + (cyclicRequires.length > 5 ? '\n    … and ' + (cyclicRequires.length - 5) + ' more' : '')
      + '\n  CLODE_ALLOW_CYCLIC_REQUIRES=0 refused to merge them.');
    tjs.exit(1);
  }

  // REQUIRED, not optional. mergeGroup renames only names the engine's own parser
  // reported as real top-level bindings; guessing them from the text instead is how a
  // merged module silently shadows a binding, which compiles and boots fine and then
  // fails somewhere rare. Same posture as the stale-engine constants gate: refuse, and
  // name the rebuild.
  if (typeof tjs.engine.moduleMeta !== 'function') {
    console.error('merge-step: this engine does not report moduleMeta, which the cyclic-group '
      + 'merge needs to know each module\'s real top-level bindings.\n'
      + '  Rebuild the engine: node scripts/build-tjs.mjs\n'
      + '  Guessing those names from the source text is REFUSED on purpose — a merged module that '
      + 'shadows a binding boots fine and fails somewhere rare.');
    tjs.exit(1);
  }

  console.log(`merge-step: ${cyclicRequires.length} cyclic CJS require(s) of graph modules — `
    + 'merging their strongly connected groups');

  const key = path.basename(stageDir);
  const cacheFile = path.join(stageDir, MERGED_CACHE_FILE);
  const merger = loadLibexecCjs(
    dec.decode(await mustRead(path.join(libexecDir, 'scc-merge.cjs'), 'the SCC merger')),
    'scc-merge.cjs');

  // -- cache read. Valid only if it records BOTH this provider key AND this merger
  // version — without that, editing scc-merge.cjs would silently have no effect on any
  // machine that had already built once.
  let cached = null;
  try {
    const raw = JSON.parse(dec.decode(await tjs.readFile(cacheFile)));
    if (raw && raw.format === MERGED_CACHE_FORMAT && raw.key === key
        && raw.mergerVersion === merger.MERGER_VERSION
        && Array.isArray(raw.order) && raw.order.length && raw.sources) {
      cached = raw;
    } else if (raw) {
      console.log(`merge-step: ignoring the merged-graph cache in ${cacheFile} `
        + `(format ${raw.format}, key ${raw.key}, merger ${raw.mergerVersion}; `
        + `wanted ${MERGED_CACHE_FORMAT}/${key}/${merger.MERGER_VERSION}) — recomputing`);
    }
  } catch { cached = null; /* absent or unreadable: recompute */ }

  if (cached) {
    console.log(`merge-step: REUSED the cached cyclic-group merge for ${key} `
      + `(merger ${merger.MERGER_VERSION}, ${Object.keys(cached.sources).length} rewritten modules) `
      + `from ${cacheFile} — the caller reads it back`);
  } else {
    const t0 = performance.now();
    // PRE-PASS. moduleMeta answers about a COMPILED module, and compiling one in
    // isolation fails ("could not load") because compile() resolves a module's imports
    // as it goes — so every group member's external dependencies have to be compiled
    // first. The staged order is topological, so one pass over it registers everything.
    const compiled = new Map();
    for (const name of doc.order) {
      const src = doc.sources[name];
      if (typeof src !== 'string') {
        console.error(`merge-step: staged graph has no source for ${name}`);
        tjs.exit(1);
      }
      try {
        compiled.set(name, tjs.engine.compile(enc.encode(src), name));
      } catch (e) {
        console.error(`merge-step: pre-compiling ${name} for the cyclic merge failed: ${e.message}`);
        tjs.exit(1);
      }
    }
    const t1 = performance.now();
    console.log(`merge-step: pre-compiled ${compiled.size} modules for moduleMeta `
      + `(${(t1 - t0).toFixed(0)}ms)`);

    const plan = loadLibexecCjs(
      dec.decode(await mustRead(path.join(libexecDir, 'bun-graph-plan.cjs'), 'the graph planner')),
      'bun-graph-plan.cjs');
    // ONE DRIVER, TWO HOSTS. The grouping, the merge loop and the re-sort all live in
    // libexec/graph-scc-merge.cjs, which staging (libexec/clode-extract.cjs, under node)
    // calls with exactly the same arguments. Everything host-specific stays here: the
    // engine that answers moduleMeta, and the cache.
    const scc = loadLibexecCjs(
      dec.decode(await mustRead(path.join(libexecDir, 'graph-scc-merge.cjs'), 'the cyclic-group merge driver')),
      'graph-scc-merge.cjs');
    const { groups, rewritten } = scc.mergeCyclicGroups(doc, {
      plan,
      merger,
      metaOf: (n) => {
        const m = compiled.get(n);
        if (!m) {
          console.error(`merge-step: no compiled module for group member ${n}`);
          tjs.exit(1);
        }
        return tjs.engine.moduleMeta(m);
      },
      log: (m) => console.log(`merge-step: ${m}`),
    });
    compiled.clear();

    const ms = performance.now() - t0;
    console.log(`merge-step: COMPUTED the cyclic-group merge for ${key} — `
      + `${groups.length} groups (${groups.map((g) => g.length).join(', ')} modules), `
      + `${Object.keys(rewritten).length} modules rewritten, ${(ms / 1000).toFixed(1)}s`);

    // -- cache write. USED TO BE best-effort (a read-only cache dir cost only the NEXT
    // build the same ~6 minutes, because the pre-extraction code had already applied the
    // computed result onto the in-memory `doc` the CALLER went on to use). Extraction
    // changed that: this process's `doc` is private, and this file is now the ONLY
    // channel the computed result travels back to the parent on — quaude-fuse.js's
    // read-back (`mustRead` on this exact path) is unconditional whenever this branch
    // ran. A failed write here is no longer "the next build pays" — it is "THIS build,
    // which just paid the full ~380s compute, dies on a read failure that names the wrong
    // cause." So: fatal, and named honestly, here, where the real cause is known — not
    // surfaced as a generic read failure one process up. Do not add a second handoff
    // channel (stdout is the protocol stream; a fallback path does not help the
    // disk-full case either) — just fail loud and name the path and errno.
    try {
      const payload = enc.encode(JSON.stringify({
        format: MERGED_CACHE_FORMAT,
        key,
        mergerVersion: merger.MERGER_VERSION,
        order: doc.order,
        sources: rewritten,
      }));
      const tmp = `${cacheFile}.tmp-${tjs.pid}`;
      await tjs.writeFile(tmp, payload);
      await tjs.rename(tmp, cacheFile);
      console.log(`merge-step: wrote ${cacheFile} (${(payload.length / 1048576).toFixed(1)}MB) — `
        + 'later builds of this provider reuse it');
    } catch (e) {
      console.error(`merge-step: could not write the merged graph to ${cacheFile} `
        + `(${e.code ?? e.errno ?? ''} ${e.message ?? e}) — this is the ONLY channel the `
        + 'computed merge travels back to the caller on, so this build cannot continue. '
        + 'Fix the cache dir (permissions, free space) and retry.');
      tjs.exit(1);
    }
  }
}

report.finish('merge', cyclicRequires.length);
