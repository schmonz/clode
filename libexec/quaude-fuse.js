// quaude fuse worker — the tjs-side half of `clode build` (driven by
// libexec/clode-fuse.cjs). Runs under the SAME tjs binary that becomes the
// quaude template: the runtime-compiles-for-itself rule makes the quickjs
// BC_VERSION/config lockstep automatic (bytecode written by any OTHER build is
// undefined behavior — design memo §6.2).
//
// Usage (spawned by clode-fuse.cjs, not by hand):
//   tjs run quaude-fuse.js <signed-base> <stage-dir> <node-shim-dir> \
//     <node_modules-dir> <bootstrap.mjs> <extras.json> <out>
//
//   signed-base: a COPY of the running tjs template, ALREADY ad-hoc re-signed
//     (sign-then-append discipline: appending invalidates strict Mach-O
//     validation, so signing must happen while the copy is still a plain
//     binary; the kernel only validates mapped code pages, so the fused
//     result executes fine — memo §6.1).
//   stage-dir:   quaude role — the extracted+hooked cache entry (cli.cjs +
//     bun-shim.cjs); builder role — a staging dir with clode-main.bundle.cjs.
//   extras.json: node-side fields (role, bundleVersion, clodeVersion, hooks,
//     template sha, manifest schema) PLUS `deps` — the ext-dep closure to embed.
//     The closure travels as DATA precisely because this worker runs under tjs
//     and cannot require() the node-side module that derives it.
//
// Output layout (memo §2):
//   [signed-base][members...][index JSON][quaude footer 32B][bootstrap bc][tx1k1.js 12B]
import path from 'tjs:path';

const [signedBase, stageDir, shimDir, nmDir, bootstrapPath, extrasPath, out, templatePath] = tjs.args.slice(3);
if (!out) {
  console.error('usage: tjs run quaude-fuse.js <signed-base> <stage-dir> <node-shim-dir> <node_modules-dir> <bootstrap.mjs> <extras.json> <out> [pristine-template]');
  tjs.exit(64);
}

const enc = new TextEncoder();
const dec = new TextDecoder();

async function sha256hex(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function mustRead(file, what) {
  try { return await tjs.readFile(file); }
  catch (e) { console.error(`quaude-fuse: cannot read ${what}: ${file} (${e.message ?? e})`); tjs.exit(1); }
}

// ---- residual cyclic requires (upstream 2.1.248+): merge each SCC ----------
// Upstream emits CJS `require()` of its own graph modules. The extractor converts every one it
// safely can into a static import; the rest (33 on 2.1.250) cannot become imports because the
// target statically imports its way back, and an import cycle has no valid compile order. The
// engine cannot drive module evaluation to completion synchronously from inside a require
// either, so a runtime bridge is not available (six approaches measured dead — see
// docs/superpowers/specs/2026-08-28-cyclic-scc-merge-design.md).
//
// The fix is to make the cycle stop crossing a module boundary at all: every strongly connected
// group of the post-conversion graph is MERGED into one module (libexec/scc-merge.cjs), and each
// former member becomes a re-export shim onto it. On 2.1.250 that is 3 groups of 95, 7 and 5.
//
// WHY THE RESULT IS CACHED. This worker runs ONCE PER TARGET, and merging the 95-module group
// costs ~345s under tjs (11s under node — pure interpreter cost, not an algorithmic problem).
// Extraction is already cached once per provider in ~/.cache/clode/<key>/ (cli.cjs, bun-shim.cjs),
// so the merged graph belongs beside them: every later build of the same provider, for any
// target, reuses it. The entry records the merger's OWN version as well as the provider key —
// without that, editing scc-merge.cjs would silently have no effect on any machine that had
// already built once.
const MERGED_CACHE_FILE = 'graph-merged.json';
const MERGED_CACHE_FORMAT = 'clode-scc-merge-v1';

// libexec/*.cjs, loaded by a worker that runs under tjs with no CJS resolver of its own. NOT the
// node-shim loader: that rewrites the text it evaluates, and these two files are consumed here
// verbatim. Both are deliberately dependency-free, so require() is a loud stub rather than a
// resolver.
function loadLibexecCjs(src, file) {
  const mod = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'require', '__filename', src)(
    mod, mod.exports,
    (spec) => {
      throw new Error(`quaude-fuse: ${file} tried to require(${spec}) — the fuse worker loads it `
        + 'with no module resolver. Keep the libexec .cjs files it loads dependency-free.');
    },
    file,
  );
  return mod.exports;
}

// Merge every cyclic group in `doc`, IN PLACE: member sources become their re-export shims, each
// merged module is added, and doc.order is recomputed (see the note on ordering below).
async function mergeCyclicGroups(doc, cyclicRequires, libexecDir) {
  // REQUIRED, not optional. mergeGroup renames only names the engine's own parser reported as
  // real top-level bindings; guessing them from the text instead is how a merged module silently
  // shadows a binding, which compiles and boots fine and then fails somewhere rare. Same posture
  // as the stale-engine constants gate: refuse, and name the rebuild.
  if (typeof tjs.engine.moduleMeta !== 'function') {
    throw new Error('quaude-fuse: this engine does not report moduleMeta, which the cyclic-group '
      + 'merge needs to know each module\'s real top-level bindings.\n'
      + '  Rebuild the engine: node scripts/build-tjs.mjs\n'
      + '  Guessing those names from the source text is REFUSED on purpose — a merged module that '
      + 'shadows a binding boots fine and fails somewhere rare.');
  }

  const key = path.basename(stageDir);
  const cacheFile = path.join(stageDir, MERGED_CACHE_FILE);
  const merger = loadLibexecCjs(
    dec.decode(await mustRead(path.join(libexecDir, 'scc-merge.cjs'), 'the SCC merger')),
    'scc-merge.cjs');

  // -- cache read. Valid only if it records BOTH this provider key AND this merger version.
  let cached = null;
  try {
    const raw = JSON.parse(dec.decode(await tjs.readFile(cacheFile)));
    if (raw && raw.format === MERGED_CACHE_FORMAT && raw.key === key
        && raw.mergerVersion === merger.MERGER_VERSION
        && Array.isArray(raw.order) && raw.order.length && raw.sources) {
      cached = raw;
    } else if (raw) {
      console.log(`quaude-fuse: ignoring the merged-graph cache in ${cacheFile} `
        + `(format ${raw.format}, key ${raw.key}, merger ${raw.mergerVersion}; `
        + `wanted ${MERGED_CACHE_FORMAT}/${key}/${merger.MERGER_VERSION}) — recomputing`);
    }
  } catch { cached = null; /* absent or unreadable: recompute */ }

  if (cached) {
    for (const n of Object.keys(cached.sources)) doc.sources[n] = cached.sources[n];
    doc.order = cached.order;
    console.log(`quaude-fuse: REUSED the cached cyclic-group merge for ${key} `
      + `(merger ${merger.MERGER_VERSION}, ${Object.keys(cached.sources).length} rewritten modules) `
      + `from ${cacheFile}`);
    return;
  }

  const t0 = performance.now();
  // PRE-PASS. moduleMeta answers about a COMPILED module, and compiling one in isolation fails
  // ("could not load") because compile() resolves a module's imports as it goes — so every group
  // member's external dependencies have to be compiled first. The staged order is topological,
  // so one pass over it registers everything.
  const compiled = new Map();
  for (const name of doc.order) {
    const src = doc.sources[name];
    if (typeof src !== 'string') throw new Error(`quaude-fuse: staged graph has no source for ${name}`);
    try {
      compiled.set(name, tjs.engine.compile(enc.encode(src), name));
    } catch (e) {
      throw new Error(`quaude-fuse: pre-compiling ${name} for the cyclic merge failed: ${e.message}`);
    }
  }
  const t1 = performance.now();
  console.log(`quaude-fuse: pre-compiled ${compiled.size} modules for moduleMeta `
    + `(${(t1 - t0).toFixed(0)}ms)`);

  const plan = loadLibexecCjs(
    dec.decode(await mustRead(path.join(libexecDir, 'bun-graph-plan.cjs'), 'the graph planner')),
    'bun-graph-plan.cjs');
  // ONE DRIVER, TWO HOSTS. The grouping, the merge loop and the re-sort all live in
  // libexec/graph-scc-merge.cjs, which staging (libexec/clode-extract.cjs, under node) calls
  // with exactly the same arguments. Everything host-specific stays here: the engine that
  // answers moduleMeta, and the cache below.
  const scc = loadLibexecCjs(
    dec.decode(await mustRead(path.join(libexecDir, 'graph-scc-merge.cjs'), 'the cyclic-group merge driver')),
    'graph-scc-merge.cjs');
  const { groups, rewritten } = scc.mergeCyclicGroups(doc, {
    plan,
    merger,
    metaOf: (n) => {
      const m = compiled.get(n);
      if (!m) throw new Error(`quaude-fuse: no compiled module for group member ${n}`);
      return tjs.engine.moduleMeta(m);
    },
    log: (m) => console.log(`quaude-fuse: ${m}`),
  });
  compiled.clear();

  const ms = performance.now() - t0;
  console.log(`quaude-fuse: COMPUTED the cyclic-group merge for ${key} — `
    + `${groups.length} groups (${groups.map((g) => g.length).join(', ')} modules), `
    + `${Object.keys(rewritten).length} modules rewritten, ${(ms / 1000).toFixed(1)}s`);

  // -- cache write. Best effort: a read-only cache dir costs the next build the same ~6 minutes,
  // which is not a reason to fail a build that has already succeeded at the hard part.
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
    console.log(`quaude-fuse: wrote ${cacheFile} (${(payload.length / 1048576).toFixed(1)}MB) — `
      + 'later builds of this provider reuse it');
  } catch (e) {
    console.log(`quaude-fuse: could not cache the merged graph at ${cacheFile} `
      + `(${e.message ?? e}) — every build of this provider will recompute it`);
  }
}

async function collect(dir, prefix, outArr) {
  for await (const item of await tjs.readDir(dir)) {
    const full = path.join(dir, item.name);
    const rel = `${prefix}/${item.name}`;
    let { isDirectory, isFile } = item;
    if (!isDirectory && !isFile) {
      // SunOS dirents carry no d_type — libuv reports every entry UNKNOWN
      // there, so both flags are false and the walk would silently collect
      // NOTHING (matrix solaris leg, dispatch #7 2026-07-10). stat() the
      // entry instead; on d_type platforms this branch never runs.
      const st = await tjs.stat(full);
      isDirectory = st.isDirectory;
      isFile = st.isFile;
    }
    if (isDirectory) {
      if (item.name === 'node_modules' || item.name === '.bin') continue;
      await collect(full, rel, outArr);
    } else if (isFile && !item.name.startsWith('._') && !item.name.startsWith('.DS_')) {
      outArr.push({ name: rel, data: await tjs.readFile(full) });
    }
  }
}

// Derived IDNA level of THIS build's URL host mapping (manifest field; the
// spike hardcoded it). Full UTS-46 (the pinned ada build) maps fullwidth
// compatibility characters; an ASCII+punycode-passthrough implementation
// (wurl L1') does not.
function deriveIdnaLevel() {
  try { if (new URL('http://ＡＢＣ.example/').hostname === 'abc.example') return 'uts46'; } catch { /* fall through */ }
  try { if (new URL('http://xn--nxasmq6b.example/').hostname === 'xn--nxasmq6b.example') return 'l1'; } catch { /* fall through */ }
  return 'unknown';
}

// The worker knows its own steps. It declares them here rather than having the
// builder declare them on its behalf: a component whose steps are named by its
// parent is only usable inside that parent (phase-2 design §2). Loaded the SAME
// way scc-merge.cjs is (mergeCyclicGroups, above) — NOT require(), which in this
// worker is a loud stub that throws. There is no module resolver here.
const libexecDir = path.dirname(shimDir);
const { Reporter } = loadLibexecCjs(
  dec.decode(await mustRead(path.join(libexecDir, 'build-report.cjs'), 'the step reporter')),
  'build-report.cjs');
const report = new Reporter({ emit: (line) => { console.log(line); } });

// ---- 1) members ------------------------------------------------------------
// The extras file (written by clode-fuse.cjs) names the payload ROLE:
//   quaude (default): the product — compiled Claude Code bundle + its runtime.
//   builder: a native clode — the esbuilt clode-main bundle as a SOURCE entry
//     (measured: 65KB, 0.24s boot under tjs — bytecode would force strict mode
//     on the whole esbuild output for no meaningful parse win), plus the
//     libexec support files `clode build` must materialize at fuse time
//     (extractor, bun-shim, this worker, the bootstrap).
// Both roles ship the node-shim tree and the ext-dep closure: the builder needs
// the deps NOT for itself (clode-main imports node builtins only) but as the
// member INPUTS for the quaude it fuses.
const extras = JSON.parse(dec.decode(await mustRead(extrasPath, 'manifest extras')));
const role = extras.role ?? 'quaude';
// `let`, not `const`: the quaude role has TWO shapes and only the staging artifact
// knows which. A code-split bundle (2.1.243+) compiles to graph.qbc + graph.idx and the
// manifest must name graph.qbc, or the loader would look for a cli.qbc that is not there.
let entryName = role === 'builder' ? 'clode-main.bundle.cjs' : 'cli.qbc';
const members = [];

// The ext-dep closure: package.json's `dependencies` plus their transitive
// closure, computed by clode-fuse.cjs (node side) and handed here as DATA —
// this worker runs UNDER TJS and cannot require() a shared node module to
// recompute it itself. This used to be a hardcoded list living right here,
// which silently drifted from package.json whenever a dependency was added
// without a matching edit to this file (duplication audit §1: a transitive
// bump or a new direct dep rotted the list identically, with no signal until
// a user hit "Cannot find module" deep in a session). A missing/empty deps
// array means an old clode-fuse.cjs fused this worker — fail loud rather than
// silently ship a quaude with an empty ext-dep closure.
const DEPS = extras.deps;
if (!Array.isArray(DEPS) || DEPS.length === 0) {
  console.error('quaude-fuse: extras.json has no non-empty "deps" array (the ext-dep closure) — built by a stale clode-fuse.cjs?');
  tjs.exit(1);
}

if (role === 'builder') {
  members.push({ name: entryName, data: await mustRead(path.join(stageDir, 'clode-main.bundle.cjs'), 'esbuilt clode-main bundle') });
  // The naude entry point: pre-esbuilt off the user path (Task 4), staged
  // alongside clode-main.bundle.cjs by clode-fuse.cjs's --self staging step.
  // Carried here (not built at naude-assembly time) so a later task can build
  // a naude without esbuild present on the user side.
  members.push({ name: 'naude-entry.bundle.cjs', data: await mustRead(path.join(stageDir, 'naude-entry.bundle.cjs'), 'esbuilt naude-entry bundle') });
  const libexecDir = path.dirname(shimDir);
  // The naude ASSEMBLER: scripts/build-naude.mjs (spawned under the fetched
  // pinned node), its repo-local requires scripts/platform-tag.cjs AND that
  // module's own sibling requires scripts/canonical-name.cjs (the artifact-name
  // source of truth) and scripts/build-scratch.cjs (the out-of-checkout scratch
  // allocator every build-dir helper in platform-tag.cjs now resolves through —
  // Task 8), and scripts/sea-sign.cjs (which build-naude execs to unsign/re-sign
  // the SEA — on macOS the ad-hoc re-sign after postject is MANDATORY or the
  // binary won't run). A fused builder ships no scripts/ dir, so `clode build
  // --naude` under clode-native materializes these (clode-fuse.cjs's
  // materializeFusedPayload) and spawns the copy. Member names keep their scripts/
  // path (re-joined onto the payload dir verbatim). Committed files that always
  // exist → mustRead. (Miss one require in this list → "Cannot find module" only
  // under clode-native, invisible to a dev-checkout build — the acceptance-4 gate.)
  for (const f of ['build-naude.mjs', 'platform-tag.cjs', 'canonical-name.cjs', 'build-scratch.cjs', 'sea-sign.cjs']) {
    members.push({ name: `scripts/${f}`, data: await mustRead(path.join(path.dirname(libexecDir), 'scripts', f), `naude assembler member scripts/${f}`) });
  }
  // host-provision.cjs rides here as forwarded bytes, same as its loop-siblings
  // above — never require()'d from this materialized dir, only carried so a
  // self-fused clode-native can re-fuse targets. The quaude-product role below
  // deliberately omits it: no runtime provision() consumer on that side.
  for (const f of ['bun-shim.cjs', 'extract-claude-js.cjs', 'quaude-fuse.js', 'quaude-bootstrap.mjs', 'host-provision.cjs', 'target-update-check.cjs', 'bun-graph-plan.cjs', 'scc-merge.cjs', 'build-report.cjs', 'graph-scc-merge.cjs', 'graph-meta.js']) {
    members.push({ name: `libexec/${f}`, data: await mustRead(path.join(libexecDir, f), `libexec member ${f}`) });
  }
  // target-env.cjs member name is BARE (no libexec/ prefix), matching how
  // node-shim/* is stored below: the node-shim loader (SHIM_DIR =
  // '/quaude/node-shim/modules' when fused) requires it via a relative
  // '../../target-env.cjs' from modules/, which only lands on the archive
  // root — a 'libexec/' prefix here would 404 that require. clode-fuse.cjs's
  // materialization step special-cases this bare name back onto disk at
  // libexec/target-env.cjs (sibling to node-shim/, matching this repo's own
  // layout) for the self-fuse path.
  members.push({ name: 'target-env.cjs', data: await mustRead(path.join(libexecDir, 'target-env.cjs'), 'target-env.cjs member') });
  // deps/claude/package.json, member name matches its real repo path (unlike
  // target-env.cjs, no bare-root special-casing needed — clode-fuse.cjs's
  // materialization step just re-joins `mat` + this name verbatim): the ext-dep
  // closure's SOURCE OF TRUTH — Claude Code's runtime deps, NOT clode's own
  // (clode has none). A fused builder ships no repo checkout, so when IT later
  // runs `clode build`, its clode-fuse.cjs needs this manifest on disk to walk
  // `dependencies` from (duplication audit §1 — the closure is derived, never
  // hand-listed).
  members.push({ name: 'deps/claude/package.json', data: await mustRead(path.join(path.dirname(libexecDir), 'deps', 'claude', 'package.json'), 'deps/claude/package.json member') });
  // deps/claude/package-lock.json, same reasoning as package.json just above:
  // the lockfile gate's (assertClosureMatchesLockfile, clode-fuse.cjs) SOURCE
  // OF TRUTH. A fused builder ships no repo checkout, so when it later runs
  // `clode build`, its clode-fuse.cjs needs this on disk to verify
  // node_modules matches the lockfile before embedding.
  members.push({ name: 'deps/claude/package-lock.json', data: await mustRead(path.join(path.dirname(libexecDir), 'deps', 'claude', 'package-lock.json'), 'deps/claude/package-lock.json member') });
  // postject's pure-JS pieces (dist/api.js does the actual SEA-blob inject;
  // dist/cli.js + package.json ride along for completeness) — so a fused
  // builder can eventually assemble a naude without a host esbuild/postject
  // toolchain (mirrors how clode-main.bundle.cjs / naude-entry.bundle.cjs,
  // above, are carried as our-source-only members). Resolved from the
  // checkout's deps/clode/node_modules/postject — the SAME tree
  // `npm ci --prefix deps/clode` populates and scripts/build-naude.mjs's
  // --postject default reads (one code path, two resolutions — checkout vs a
  // future fused-payload materialization — exactly like the deps/claude/
  // package.json member above, which resolves the same way in both cases
  // because libexecDir itself is already rebound upstream).
  //
  // Deliberately NOT a hard requirement yet (unlike deps/claude/package.json,
  // a committed file that must always exist): no CI job runs
  // `npm ci --prefix deps/clode` today — that lands with the fetch/materialize
  // wiring (a later task). A missing directory here just means this fused
  // builder was minted on a host that hasn't provisioned postject, and won't
  // be able to assemble a naude until it is (or until a later task teaches it
  // to fetch one) — skip with a loud warning instead of failing the whole
  // fuse over a capability nothing yet exercises end-to-end.
  const postjectDir = path.join(path.dirname(libexecDir), 'deps', 'clode', 'node_modules', 'postject');
  let postjectPresent = false;
  try { postjectPresent = (await tjs.stat(postjectDir)).isDirectory; } catch { /* not provisioned on this host */ }
  if (postjectPresent) {
    for (const f of ['package.json', 'dist/cli.js', 'dist/api.js']) {
      members.push({
        name: `deps/clode/node_modules/postject/${f}`,
        data: await mustRead(path.join(postjectDir, f), `postject member ${f}`),
      });
    }
  } else {
    console.log(`quaude-fuse: ${postjectDir} not provisioned — carrying no postject (this builder cannot assemble a naude until 'npm ci --prefix deps/clode' has been run somewhere in its lineage)`);
  }
  // The PRISTINE tjs template rides along (Q2 Decision 2): a shipped builder
  // must be able to fuse with NOTHING on disk — `clode build` materializes this
  // member when no CLODE_TJS/build-tree template exists. Pristine = the
  // pre-signing bytes, so it matches the manifest's template identity exactly.
  members.push({ name: 'template/tjs', data: await mustRead(templatePath, 'pristine tjs template') });
} else {
  // TWO SHAPES OF BUNDLE. Through 2.1.241 the CLI is ONE @bun-cjs module and the
  // staging step wrote cli.cjs. From 2.1.243 it is a code-split ESM GRAPH and the
  // staging step wrote graph.json instead. Branch on which artifact is present rather
  // than on a version number: the stage already decided, using Bun's own module_format
  // field, and re-deciding here from a version string would be a second source of truth.
  const graphPath = path.join(stageDir, 'graph.json');
  let stagedGraph = null;
  try { stagedGraph = await tjs.readFile(graphPath); } catch (e) { stagedGraph = null; }

  if (stagedGraph) {
    const doc = JSON.parse(dec.decode(stagedGraph));
    if (doc.format !== 'clode-bun-graph-v1') {
      throw new Error(`quaude-fuse: staged graph has format ${doc.format}, expected clode-bun-graph-v1`);
    }

    // `|| []` on purpose: absent and empty are the same thing, and both must be an exact no-op.
    // 2.1.247 and earlier have no cyclic requires at all and must take precisely today's path —
    // no merge, no cache read, no cache write, no diagnostics.
    //
    // The plan is declared HERE, the moment the graph is parsed: every denominator below
    // (1795 modules, 173 assets, 33 cyclic requires on 2.1.250) is already a field on `doc`,
    // so there is nothing to guess and no reason to wait — the "attach a total once honestly
    // known" rule from the phase-2 design (§6) is satisfied at the earliest possible instant,
    // not by declaring these steps totalless and hoping a caller notices they never grow one.
    const cyclicRequires = doc.cyclicRequires || [];
    report.plan([
      { name: 'merge', total: cyclicRequires.length },
      { name: 'compile', total: doc.order.length },
      { name: 'assets', total: doc.assets ? Object.keys(doc.assets).length : 0 },
    ]);

    // RESIDUAL CYCLIC REQUIRES (upstream 2.1.248+). The extractor converted every require() of a
    // graph module it could turn into a static import; these could not, because the target
    // statically imports its way back. They are real: leave them and the target dies at runtime
    // with `cannot resolve '/$bunfs/root/chunk-….js'`. Merge each strongly connected group into a
    // single module instead — see mergeCyclicGroups above for the whole story, including why the
    // result is cached beside the staged cli.cjs.
    report.start('merge');
    if (cyclicRequires.length && doc.sccMerge) {
      // ALREADY MERGED, AT STAGING (libexec/clode-extract.cjs). That is where the merge
      // belongs: the staged graph is the input to BOTH targets, and doing it here meant
      // only a fused quaude ever got it while the graph runner naude embeds — and every
      // node-shim oracle stages — was emitted from the unmerged doc and died on the first
      // residual require. Everything below is the fallback for a doc staged before that
      // moved, and both paths run the SAME libexec/graph-scc-merge.cjs.
      console.log(`quaude-fuse: the staged graph is already merged (${doc.sccMerge.format}, `
        + `merger ${doc.sccMerge.mergerVersion}, groups ${doc.sccMerge.groups.join(', ')}) `
        + '— nothing to do');
    } else if (cyclicRequires.length) {
      // The named escape hatch: refuse to build rather than merge. Kept from the warn-only
      // version of this block so a bisect can separate "the merge is wrong" from "the graph is
      // wrong" without editing the worker.
      if (tjs.env.CLODE_ALLOW_CYCLIC_REQUIRES === '0') {
        const listed = cyclicRequires.slice(0, 5)
          .map(([from, to]) => '    ' + from + ' -> ' + to).join('\n');
        throw new Error('quaude-fuse: ' + cyclicRequires.length + ' CJS require(s) of a graph'
          + ' module could not be converted to imports (converting would close an import cycle):\n'
          + listed + (cyclicRequires.length > 5 ? '\n    … and ' + (cyclicRequires.length - 5) + ' more' : '')
          + '\n  CLODE_ALLOW_CYCLIC_REQUIRES=0 refused to merge them.');
      }
      console.log(`quaude-fuse: ${cyclicRequires.length} cyclic CJS require(s) of graph modules — `
        + 'merging their strongly connected groups');
      // console.log, NOT console.error, here and throughout mergeCyclicGroups: clode-fuse.cjs
      // only surfaces the fuse worker's stdout on a SUCCESSFUL build (clodeLog(w.stdout)) —
      // stderr is shown only on failure. A non-fatal message on stderr would reach no one on the
      // green path (see the postject-not-provisioned warning above, same reasoning).
      await mergeCyclicGroups(doc, cyclicRequires, path.dirname(shimDir));
    }
    report.finish('merge', cyclicRequires.length);

    // Compile every unit IN THE STAGED ORDER. Order is not cosmetic: compile()
    // resolves imports as it compiles, so a module whose dependency has not been
    // compiled yet fails with "could not load" naming a module that is perfectly
    // fine. The stage produced a topological order; trust it and fail loudly if it
    // is wrong rather than half-building.
    report.start('compile');
    const t0 = performance.now();
    const index = [];
    const parts = [];
    let off = 0;
    for (const name of doc.order) {
      const src = doc.sources[name];
      if (typeof src !== 'string') throw new Error(`quaude-fuse: staged graph has no source for ${name}`);
      let bc;
      try {
        bc = tjs.engine.serialize(tjs.engine.compile(enc.encode(src), name));
      } catch (e) {
        throw new Error(`quaude-fuse: compiling ${name} failed: ${e.message}\n`
          + '  A "could not load" here usually means the staged order is not topological.');
      }
      index.push({ name, off, len: bc.length });
      parts.push(bc);
      off += bc.length;
      report.progress('compile', index.length);
    }
    report.finish('compile', index.length);
    const all = new Uint8Array(off);
    let p = 0;
    for (const b of parts) { all.set(b, p); p += b.length; }
    // ONE blob plus an index, not 1459 archive members: the archive index is read and
    // verified eagerly at boot, and 1459 entries would put that cost on every start.
    members.push({ name: 'graph.qbc', data: all });
    // The prelude runs BEFORE the graph: it installs globalThis.Bun (which upstream's
    // modules reference directly) and __clodeCheckUpdate (which the autoupdater hooks
    // call). The CJS path gets it by prepending to cli.cjs; a graph has no single text
    // to prepend to, so it rides as its own member.
    if (typeof doc.prelude === 'string' && doc.prelude.length) {
      members.push({ name: 'graph-prelude.cjs', data: enc.encode(doc.prelude) });
    } else {
      throw new Error('quaude-fuse: staged graph has no prelude — a built target would '
        + 'have no globalThis.Bun and a broken update path');
    }
    // TEXT ASSETS the bundle require()s by name (2.1.246+: 164 of them, 118 .md — prompt
    // preambles and quickrefs upstream moved out of JS). They are not modules and must not
    // be compiled; they ride as one member and the loader answers require() from it.
    // Without them the target boots and dies on its first turn with "cannot resolve
    // /$bunfs/root/loopAutonomousPreamble-*.md" — a file that exists only inside the
    // provider, so no host path can satisfy it.
    report.start('assets');
    if (doc.assets && Object.keys(doc.assets).length) {
      const a = enc.encode(JSON.stringify(doc.assets));
      members.push({ name: 'graph-assets.json', data: a });
      console.log(`quaude-fuse: ${Object.keys(doc.assets).length} text assets -> `
        + `graph-assets.json (${(a.length / 1048576).toFixed(1)}MB)`);
    }
    report.finish('assets', doc.assets ? Object.keys(doc.assets).length : 0);
    entryName = 'graph.qbc';
    members.push({ name: 'graph.idx', data: enc.encode(JSON.stringify({ entry: doc.entry, modules: index })) });
    console.log(`quaude-fuse: compiled ${index.length} modules -> graph.qbc `
      + `(${(all.length / 1048576).toFixed(1)}MB, ${(performance.now() - t0).toFixed(0)}ms)`);
  } else {
  // cli.cjs -> cli.qbc: replicate the loader's ENTRY transforms (shebang strip +
  // dynamic-import rewrite; fixVFlagPropertyEscapes self-gates off for >1MB
  // entries), wrap in the CJS wrapper as a module (=> strict), compile+serialize
  // under this very runtime. Keep the transform set in lockstep with
  // libexec/node-shim/loader.cjs — the transforms are frozen into the bytecode.
  let src = dec.decode(await mustRead(path.join(stageDir, 'cli.cjs'), 'staged bundle'));
  if (src.startsWith('#!')) src = src.slice(src.indexOf('\n') + 1);
  src = src.replace(/(^|[^\w$.])import(\s*\()/g, '$1__tjsDynImport$2');
  const wrapped = 'globalThis.__quaude_entry = function (exports, require, module, __filename, __dirname) {\n' + src + '\n};\n';
  const t0 = performance.now();
  const bc = tjs.engine.serialize(tjs.engine.compile(enc.encode(wrapped), '/quaude/cli.cjs'));
  console.log(`quaude-fuse: compiled cli.cjs -> cli.qbc (${bc.length} bytes, ${(performance.now() - t0).toFixed(0)}ms)`);
  members.push({ name: 'cli.qbc', data: bc });
  }

  // bun-shim from the extracted stage (version-locked to the bundle by the
  // cache). scripts/build-naude.mjs reads it from this same staged location
  // (stagedBunShim) for the same reason — both build targets bake the shim the
  // bundle was extracted with, never one reached back for from the repo
  // (duplication audit §5: naude used to read REPO/libexec/bun-shim.cjs and
  // agreed with this only by accident, because clode-extract.cjs re-copies the
  // shim over the cached one on every cache hit).
  members.push({ name: 'bun-shim.cjs', data: await mustRead(path.join(stageDir, 'bun-shim.cjs'), 'staged bun-shim') });

  // The env contract the bootstrap applies before booting the bundle.
  // BARE member name (no libexec/ prefix) — see the builder branch's comment
  // above for why: the node-shim loader's fused SHIM_DIR has no 'libexec'
  // ancestor in the archive namespace, so process.cjs's relative require must
  // find this at the archive root.
  members.push({ name: 'target-env.cjs', data: await mustRead(path.join(path.dirname(shimDir), 'target-env.cjs'), 'target-env.cjs member') });

  // The PRELUDE's __clodeCheckUpdate does `require(__dirname + '/target-update-check.cjs')`
  // from inside cli.qbc, whose __dirname is the archive root ('/quaude') — same
  // resolution rule as bun-shim.cjs/target-env.cjs above (BARE member name, no
  // libexec/ prefix, so qvfsRead's '/quaude/'-stripping finds it). Without this
  // member the notify-only autoupdater path would 404 the moment it's invoked.
  members.push({ name: 'target-update-check.cjs', data: await mustRead(path.join(path.dirname(shimDir), 'target-update-check.cjs'), 'target-update-check.cjs member') });
}

// node-shim tree: THE committed loader + modules + internal (the loader's VFS
// seam activates when the bootstrap mounts the archive).
members.push({ name: 'node-shim/loader.cjs', data: await mustRead(path.join(shimDir, 'loader.cjs'), 'node-shim loader') });
await collect(path.join(shimDir, 'modules'), 'node-shim/modules', members);
await collect(path.join(shimDir, 'internal'), 'node-shim/internal', members);

// ext-dep closure (DEPS = extras.deps, derived node-side — see above). The
// node side already fails the build if a listed package is missing from
// node_modules, so this guard is the belt to that braces: it catches a package
// whose dir exists but is EMPTY (nothing collected), which the manifest-only
// check up there cannot see.
for (const dep of DEPS) {
  const before = members.length;
  try { await collect(path.join(nmDir, dep), `node_modules/${dep}`, members); }
  catch { /* missing dir caught below */ }
  if (members.length === before) {
    console.error(`quaude-fuse: dependency '${dep}' not found under ${nmDir} (run clode once, or npm install)`);
    tjs.exit(1);
  }
}

// ---- 2) manifest (single hashing pass: these shas feed BOTH the manifest and
// the index; the index stays authoritative for offsets, the manifest is the
// attestation identity) --------------------------------------------------------
const memberShas = {};
for (const m of members) {
  m.sha256 = await sha256hex(m.data);
  memberShas[m.name] = { len: m.data.length, sha256: m.sha256 };
}
const manifest = {
  clode: extras.clode,
  role,
  entry: entryName,
  bundleVersion: extras.bundleVersion,
  // WHICH PLATFORM'S UPSTREAM BUNDLE IS IN HERE. Bun constant-folds process.platform at carve
  // time, so a graph is per-platform: a darwin target fused from a linux carve has upstream's
  // whole macOS credential store dead-coded away, and that is exactly the quaude that shipped
  // on 2026-08-27 unable to read the login Keychain. Until now a FUSED TARGET COULD NOT BE
  // ASKED: the bundle is stored as bytecode, so `strings` on a quaude answers nothing (an hour
  // was spent on precisely that mistake, and it produced a false conclusion), and a
  // cross-built target cannot be run to ask it. Recording it here makes the question
  // answerable about the BINARY — printed verbatim by --clode-attest on a target you can run,
  // and readable straight out of the archive (manifest.json is a plain JSON member) on one you
  // cannot. Absent on the builder role, which carves no upstream bundle.
  providerPlatform: extras.providerPlatform,
  clodeVersion: extras.clodeVersion,
  engine: { ...tjs.engine.versions },
  idna: deriveIdnaLevel(),
  template: extras.template,
  hooks: extras.hooks,
  // The declared bill of materials, name@version, computed node-side
  // (clode-fuse.cjs's computeDepClosure) and carried verbatim — answers "what
  // is in this quaude?" from manifest.json alone, without cross-referencing
  // package.json + node_modules. Distinct from DEPS (bare names, above,
  // consumed only to collect members) — never itself re-emitted.
  bom: extras.bom,
  builtAt: new Date().toISOString(),
  members: memberShas,
};
const manifestData = enc.encode(JSON.stringify(manifest, null, 2) + '\n');
members.push({ name: 'manifest.json', data: manifestData, sha256: await sha256hex(manifestData) });

// ---- 3) assemble -------------------------------------------------------------
const exe = await mustRead(signedBase, 'signed template copy');
let off = exe.length;
const chunks = [exe];
const index = { version: 0, members: [] };
for (const m of members) {
  index.members.push({ name: m.name, offset: off, len: m.data.length, sha256: m.sha256 });
  chunks.push(m.data);
  off += m.data.length;
}
const indexBytes = enc.encode(JSON.stringify(index));
const indexOff = off;
chunks.push(indexBytes); off += indexBytes.length;

const footer = new Uint8Array(32);
footer.set(enc.encode('QAUDEv0\0'), 0);
const fdv = new DataView(footer.buffer);
fdv.setBigUint64(8, BigInt(indexOff), true);
fdv.setBigUint64(16, BigInt(indexBytes.length), true);
chunks.push(footer); off += 32;

// Bootstrap bytecode, compiled by THIS runtime (same lockstep rule as cli.qbc).
const bootBc = tjs.engine.serialize(tjs.engine.compile(await mustRead(bootstrapPath, 'bootstrap'), '<quaude-boot>'));
const bcOffset = off;
if (bcOffset > 0xFFFFFFFF) { console.error('quaude-fuse: bootstrap offset exceeds the tx1k1 u32 trailer limit (4GiB)'); tjs.exit(1); }
chunks.push(bootBc); off += bootBc.length;

const tx = new Uint8Array(12);
tx.set(enc.encode('tx1k1.js'), 0);
new DataView(tx.buffer).setUint32(8, bcOffset, true);
chunks.push(tx); off += 12;

const total = new Uint8Array(off);
{ let o = 0; for (const c of chunks) { total.set(c, o); o += c.length; } }
await tjs.writeFile(out, total, { mode: 0o755 });
console.log(`quaude-fuse: wrote ${out} (${total.length} bytes, ${members.length} members, index ${indexBytes.length}B, bootstrap ${bootBc.length}B)`);
