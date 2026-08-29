'use strict';
// clode-extract — JS port of bin/clode's extract_if_needed: the extract-on-change
// caching orchestration. Behavior-for-behavior with the sh launcher, but runs the
// extractor IN-PROCESS (require of the sibling extract-claude-js.cjs) instead of
// spawning it. Pure Node stdlib + sibling .cjs requires; runs before any ext-deps
// are ensured.
//
// The cached cli.cjs is a function of BOTH the provider binary (captured by the
// cache KEY / cacheDir) AND the extractor logic that patches it. The key only
// captures the binary, so we fingerprint the extractor too (.extractor-sig) and
// re-extract when it changes — otherwise an extract-claude-js edit never reaches
// existing caches until the binary moves. The bun-shim is handled separately: a
// cache hit still refreshes the cached shim if the installed source differs, so a
// shim fix reaches existing per-version caches without waiting for a re-extract.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const { sigOf } = require('./clode-resolve.cjs');
const { extractToFile, extractGraphToFile, graphRunnerSource, isSplitBundle, providerPlatformOf } = require('./extract-claude-js.cjs');
const plan = require('./bun-graph-plan.cjs');
const merger = require('./scc-merge.cjs');
const scc = require('./graph-scc-merge.cjs');

// `[ -f "$p" ]`: exists AND is a regular file (any stat error -> false).
function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// sigOf, but tolerant: a libexec that does not carry one of the staging sources (an older
// fused clode, a materialized dir assembled for a different role) must not crash staging —
// it just means that file cannot contribute to the cache signature.
function sigOrAbsent(p) {
  try {
    return sigOf(p);
  } catch {
    return 'absent';
  }
}

// EVERY SOURCE THAT SHAPES A STAGED ARTIFACT, in one place. The staged graph is no longer
// just what extract-claude-js.cjs emitted: mergeStagedGraph rewrites whole modules with
// libexec/scc-merge.cjs. Without those in the signature, editing the merger would have no
// effect on any machine that had already staged this provider once — silently, on that
// machine only, forever. (That failure mode is why the merger carries its own
// MERGER_VERSION; here a file signature says the same thing for free.)
//
// EXPORTED so the tests that assert on .extractor-sig compose it the same way this does.
// They used to spell `sigOf(libexec/extract-claude-js.cjs)` out inline, which is a copy
// that goes stale the moment the real composition changes — and it did.
function extractorSigOf(libexec) {
  return ['extract-claude-js.cjs', 'scc-merge.cjs', 'graph-scc-merge.cjs']
    .map((f) => sigOrAbsent(path.join(libexec, f)))
    .join('+');
}

// `[ "$(cat "$p" 2>/dev/null)" = ... ]`: command substitution strips trailing
// newlines; a missing file yields "".
function readSig(p) {
  try {
    return fs.readFileSync(p, 'utf8').replace(/\n+$/, '');
  } catch {
    return '';
  }
}

// `cmp -s a b`: byte-identical? A missing/unreadable file counts as different.
function filesEqual(a, b) {
  try {
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  } catch {
    return false;
  }
}

// Port of run_quiet around the (in-process) extractor: when verbose, let its
// stderr stream live; otherwise buffer stdout+stderr and swallow on success,
// resurfacing it only on failure (keeping "see error above" honest). Restores the
// original writers even if fn throws.
function runQuiet(verbose, fn) {
  if (verbose) return fn();
  const origErr = process.stderr.write.bind(process.stderr);
  const origOut = process.stdout.write.bind(process.stdout);
  let buf = '';
  const cap = (chunk) => { buf += Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk); return true; };
  process.stderr.write = cap;
  process.stdout.write = cap;
  try {
    const r = fn();
    process.stderr.write = origErr;
    process.stdout.write = origOut;
    return r;
  } catch (e) {
    process.stderr.write = origErr;
    process.stdout.write = origOut;
    if (buf) origErr(buf);
    throw e;
  }
}

// ---- the cyclic-group merge, done ONCE per staged graph ----------------------------
//
// A staged graph is the input to BOTH targets: the fuse worker compiles it into quaude,
// and graphRunnerSource() below turns the same doc into the cli.cjs naude embeds and every
// oracle stages. Upstream's residual `import.meta.require("<chunk>")` edges (2.1.248+) are
// answerable by NEITHER, so the merge that removes them belongs here — before the doc is
// written and before either consumer sees it. It used to live in libexec/quaude-fuse.js,
// which is why a quaude worked and a naude (and every node-shim oracle) did not.
//
// COST, measured on darwin-arm64 2.1.251 (1836 modules, 33 residual edges, groups of
// 99/7/5): ~5s of engine CPU for the metadata pass and ~11s for the merge under node. It
// runs once per (provider, extractor) and is cached with the rest of the stage.

// The engine to ask for module metadata. In order: this process, if it IS tjs (a fused
// clode — no spawn needed and none possible); CLODE_TJS; the checkout's built engine.
function resolveEngine(libexec, env) {
  if (globalThis.tjs && globalThis.tjs.engine && typeof globalThis.tjs.engine.moduleMeta === 'function') {
    return { inProcess: true };
  }
  const explicit = env.CLODE_TJS;
  if (explicit && isFile(explicit)) return { bin: explicit, why: 'CLODE_TJS' };
  try {
    // A dev checkout: libexec/../build/tjs/<platform-tag>/tjs. Absent in a fused clode,
    // which never reaches here because the in-process branch above already answered.
    const { tjsBin } = require('../scripts/platform-tag.cjs');
    const cand = tjsBin(path.dirname(libexec));
    if (isFile(cand)) return { bin: cand, why: 'the checkout engine' };
  } catch { /* no scripts/ next to libexec: fall through to the refusal */ }
  return null;
}

// metaOf for every name in `want`, via the engine. Refuses rather than guessing: see
// libexec/graph-meta.js.
function moduleMetas(docPath, want, { libexec, cacheDir, env, log }) {
  const engine = resolveEngine(libexec, env);
  if (!engine) {
    throw new Error('clode: this provider\'s module graph has residual cyclic require(s), which '
      + 'need the engine\'s own report of each module\'s top-level bindings to merge away.\n'
      + '  No tjs engine is reachable: set CLODE_TJS to one, or build it with '
      + '`node scripts/build-tjs.mjs`.\n'
      + '  Staging without the merge is REFUSED on purpose — the target would boot and then '
      + 'die on the first residual require ("cannot resolve /$bunfs/root/chunk-….js" under '
      + 'tjs, ERR_REQUIRE_CYCLE_MODULE under node).');
  }
  if (engine.inProcess) {
    const enc = new TextEncoder();
    const doc = JSON.parse(fs.readFileSync(docPath, 'utf8'));
    const wanted = new Set(want);
    const out = {};
    for (const name of doc.order) {
      const mod = globalThis.tjs.engine.compile(enc.encode(doc.sources[name]), name);
      if (wanted.has(name)) out[name] = globalThis.tjs.engine.moduleMeta(mod);
    }
    return out;
  }
  log(`clode: asking ${engine.bin} for module metadata (${engine.why})`);
  const namesPath = path.join(cacheDir, '.graph-meta-names.json');
  const outPath = path.join(cacheDir, '.graph-meta.json');
  fs.writeFileSync(namesPath, JSON.stringify(want));
  try {
    const r = require('node:child_process').spawnSync(
      engine.bin, ['run', path.join(libexec, 'graph-meta.js'), docPath, namesPath, outPath],
      { encoding: 'utf8', maxBuffer: 1 << 24 });
    if (r.status !== 0) {
      throw new Error(`clode: graph-meta failed under ${engine.bin} (exit ${r.status})\n`
        + `${(r.stderr || '').trim()}`);
    }
    return JSON.parse(fs.readFileSync(outPath, 'utf8'));
  } finally {
    for (const p of [namesPath, outPath]) { try { fs.rmSync(p); } catch { /* best effort */ } }
  }
}

// Merge `doc` in place when it still carries residual cyclic requires, then PROVE none
// survive. The proof is the ratchet: a residual require is invisible until a target runs
// far enough to touch it, which is how the graph runner shipped broken through a whole
// release. Here it is a staging-time failure that names the edge.
function mergeStagedGraph(doc, docPath, opts) {
  // DERIVED FROM THE SOURCES, not read off doc.cyclicRequires. The list the planner wrote
  // is a claim about what it left behind; this is the thing itself, so a shape the planner
  // does not classify the way we expect still gets caught instead of sailing through.
  const residual = scc.residualCyclicRequires(doc, plan);
  if (!residual.length) return;
  const groups = scc.cyclicGroupsOf(doc, plan);
  const want = [];
  for (const g of groups) for (const n of g) want.push(n);
  const metas = moduleMetas(docPath, want, opts);
  scc.mergeCyclicGroups(doc, {
    plan,
    merger,
    groups,
    metaOf: (n) => {
      const m = metas[n];
      if (!m) throw new Error(`clode: the engine reported no metadata for ${n}`);
      return m;
    },
    log: (m) => opts.log(`clode: ${m}`),
  });
  const left = scc.residualCyclicRequires(doc, plan);
  if (left.length) {
    throw new Error(`clode: ${left.length} require(s) of a graph module survived the `
      + `cyclic-group merge (e.g. ${left[0][0]} -> ${left[0][1]}).\n`
      + '  Nothing can answer them at runtime, so staging refuses rather than shipping a '
      + 'target that dies on the first one.');
  }
  opts.log(`clode: merged ${doc.sccMerge.groups.length} cyclic group(s) `
    + `(${doc.sccMerge.groups.join(', ')} modules) — ${residual.length} residual `
    + 'require(s) removed');
}

// Extract-on-first-use, cached per key. Mirrors extract_if_needed exactly:
//  - CACHE HIT when cli.cjs AND bun-shim.cjs exist AND .extractor-sig matches the
//    current extractor sig: still refresh the cached shim if the installed source
//    differs, then return.
//  - CACHE MISS: log (first-extract vs extractor-changed), run the extractor
//    in-process to (re)write cli.cjs, `node --check` it, copy the shim, write the
//    sig. Any extraction/verify/check problem removes the partial cli.cjs and fails
//    loudly (throws), matching the sh's rm + exit 1.
//
// opts: { bin, cacheDir, libexec, verbose=false, node=process.execPath, key,
//         log } — `key` defaults to basename(cacheDir) (the sh KEY, since
//         CACHE=CACHE_ROOT/KEY); `log` is the clode_log sink (defaults to stderr).
function extractIfNeeded(opts) {
  const {
    bin, cacheDir, libexec,
    verbose = false,
  } = opts;
  const key = opts.key !== undefined ? opts.key : path.basename(cacheDir);
  const emit = opts.log || ((m) => process.stderr.write(m + '\n'));
  const clodeLog = (m) => { if (verbose) emit(m); };

  // THE KEY CARRIES THE PROVIDER'S PLATFORM, not just the extractor's signature. The cache
  // directory is named for the VERSION, and a version does not determine the carve: Bun folds
  // process.platform at carve time, so a linux provider and a darwin provider for the same
  // version produce different graphs. Without this, extracting one poisoned every later build
  // of the other — which is exactly how a darwin quaude shipped with no macOS credential
  // store. See test/extract-cache-key.test.cjs.
  // The extractor half is extractorSigOf() — the merger is in it too; see there.
  const extractorSig = cacheSignature({
    extractorSig: extractorSigOf(libexec),
    providerPlatform: providerPlatformOf(bin),
  });
  // TWO SHAPES. Through 2.1.241 a bundle carves to one cli.cjs; from 2.1.243 it is a
  // code-split ESM graph and stages as graph.json instead. Decided from Bun's own
  // module_format field in the container, never from a version string — see
  // isSplitBundle. The staged artifact then tells every later step which shape it is,
  // so there is exactly one place that decides.
  const split = isSplitBundle(bin);
  const cliPath = path.join(cacheDir, split ? 'graph.json' : 'cli.cjs');
  const cacheShim = path.join(cacheDir, 'bun-shim.cjs');
  const srcShim = path.join(libexec, 'bun-shim.cjs');
  const sigPath = path.join(cacheDir, '.extractor-sig');

  if (isFile(cliPath) && isFile(cacheShim) && readSig(sigPath) === extractorSig) {
    // Cache hit on the bundle. Refresh the cached shim if the installed source
    // differs, so a shim fix reaches existing per-version caches without waiting
    // for a provider update to trigger a re-extract.
    if (!filesEqual(srcShim, cacheShim)) {
      fs.copyFileSync(srcShim, cacheShim);
      clodeLog(`clode: refreshed cached bun-shim for ${key}`);
    }
    return;
  }

  if (isFile(cliPath)) {
    clodeLog(`clode: extractor changed; re-extracting JS for ${key}...`);
  } else {
    clodeLog(`clode: extracting JS for ${key}...`);
  }

  fs.mkdirSync(cacheDir, { recursive: true });

  try {
    runQuiet(verbose, () => {
      if (!split) return extractToFile(bin, cliPath);
      const res = extractGraphToFile(bin, cliPath);
      // A SPLIT STAGE CARRIES BOTH SHAPES, from ONE extraction. graph.json feeds the
      // fuse worker, which compiles each module to bytecode — that is where quaude's
      // load-time win comes from and it must stay. cli.cjs is the same graph as ONE
      // RUNNABLE FILE, which is what naude embeds and what every oracle stages.
      //
      // They are derived from the same doc rather than extracted twice, so they cannot
      // disagree about what the bundle says. Writing only the first is what left naude
      // and the whole oracle apparatus dead on 2.1.243+ while `clode build` was green:
      // the consumer's input silently stopped existing and nothing declared the edge.
      const doc = JSON.parse(fs.readFileSync(cliPath, 'utf8'));
      // BEFORE either consumer sees it: the residual cyclic requires upstream 2.1.248+
      // leaves behind are unanswerable by both of them, so they are merged away once,
      // here, and graph.json is rewritten with the result.
      mergeStagedGraph(doc, cliPath, { libexec, cacheDir, env: process.env, log: clodeLog });
      if (doc.sccMerge) fs.writeFileSync(cliPath, JSON.stringify(doc));
      fs.writeFileSync(path.join(cacheDir, 'cli.cjs'), graphRunnerSource(doc));
      return res;
    });
  } catch (e) {
    try { fs.rmSync(cliPath); } catch { /* ignore */ }
    process.stderr.write('clode: extraction failed (see error above); not caching.\n');
    throw e;
  }

  // Syntax-check the extracted JS IN-PROCESS: compile it as a CommonJS module (wrapped,
  // so top-level return/require/module are legal) WITHOUT running it — the equivalent of
  // `node --check`. Done in-process so it works whether the launcher is a plain node or
  // a SEA binary (which has no `--check` mode) and needs no external node at all.
  try {
    if (split) {
      // A staged GRAPH is JSON, not JS, so Module.wrap would be meaningless. Check what
      // can actually be wrong here: that it parses, that every unit the order names has
      // a source, and that the entry is among them. The authoritative SYNTAX check is
      // the fuse step, which compiles every module under the TARGET engine — the only
      // parser whose opinion matters — and fails loudly naming the module.
      const doc = JSON.parse(fs.readFileSync(cliPath, 'utf8'));
      if (doc.format !== 'clode-bun-graph-v1') throw new Error(`staged graph format ${doc.format}`);
      if (!Array.isArray(doc.order) || !doc.order.length) throw new Error('staged graph has no order');
      for (const name of doc.order) {
        if (typeof doc.sources[name] !== 'string') throw new Error(`staged graph has no source for ${name}`);
      }
      if (typeof doc.sources[doc.entry] !== 'string') throw new Error(`staged graph entry ${doc.entry} has no source`);
    } else {
      const src = fs.readFileSync(cliPath, 'utf8');
      new vm.Script(Module.wrap(src), { filename: cliPath });
    }
  } catch (e) {
    try { fs.rmSync(cliPath); } catch { /* ignore */ }
    if (e && e.stack) process.stderr.write(e.stack + '\n');
    process.stderr.write(`clode: extracted ${split ? 'module graph' : 'JS'} failed the check; not caching.\n`);
    throw new Error('extracted JS failed the syntax check');
  }

  fs.copyFileSync(srcShim, cacheShim);
  fs.writeFileSync(sigPath, extractorSig + '\n');
}

// The cache entry's identity: the extractor that produced it AND the platform the provider
// binary carves for. Kept as a pure function so the separation it guarantees is testable
// without a 200MB provider on disk. A null platform (a container we cannot name) gets its own
// bucket rather than borrowing the host's.
function cacheSignature({ extractorSig, providerPlatform }) {
  return `${extractorSig}:${providerPlatform || 'unknown'}`;
}

module.exports = { extractIfNeeded, cacheSignature, extractorSigOf };
