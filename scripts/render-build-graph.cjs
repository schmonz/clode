'use strict';
// render-build-graph — the three views of the build, DRAWN FROM scripts/build-graph.cjs.
//
// WHY THIS EXISTS. docs/build.md is this repo's first tracked developer-facing page, and a
// page about a build is exactly the artifact that rots: right on the day it is written and
// silently wrong every day after. This tree has watched that happen three times to
// hand-maintained LISTS (NODE_CONSTANTS, engine-recipe.cjs's FILES, the BACKLOG prose about
// what building this repo involves) and, earlier today, to a single WORD: a step was
// renamed in one place and the generated text that quoted it was never regenerated. A hand-drawn
// diagram is a comment with better typography, so nothing here is hand-drawn: every node,
// every edge and every number comes out of the graph's own `needs`, `inputs`, `outputs`,
// `runsOn` and `count`. test/build-graph-render.test.cjs then requires the committed bytes
// to be exactly what this file emits, which is the part that makes "derived" true rather
// than aspirational.
//
// THE PAGE MUST BE IDENTICAL ON EVERY MACHINE. That is the one hard constraint a generated,
// COMMITTED artifact adds over a generated one. The graph answers with absolute paths
// resolved against a context, and on a developer's box those are `~/.cache/clode/...` and
// `$TMPDIR/tjs/<tag>/tjs` — so rendering the graph's live answers would commit this box's
// home directory and make the gate permanently red for everyone else. Instead the views are
// rendered against a context whose out-of-repo roots are SYMBOLIC (renderContext below), and
// displayPath REFUSES any path it cannot name against one of them. A silent pass-through
// there is not a cosmetic bug: it is a gate that goes red in CI and nowhere else.
//
// COMMONJS, for build-graph.cjs's reason — this repo is removing ESM from its own tooling,
// and a renderer is not the place to add some back. It does not have to RUN under tjs (it is
// a dev/CI tool, like scripts/tjs-legs.mjs, and it renders every leg, which asks
// scripts/tjs-legs.mjs — still ESM — for the list).
//
// scripts/build-tjs.cjs MUST NOT require this file, for the reason build-graph.cjs's header
// states at length: a require would pull it into engine-recipe.cjs's derived FILES, move the
// recipe hash and rebuild all 42 legs for an edit to a file that compiles nothing.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const G = require('./build-graph.cjs');

const REPO = path.resolve(__dirname, '..');
const PAGE_REL = 'docs/build.md';
const SELF_REL = 'scripts/render-build-graph.cjs';
// ONE spelling, and it is the graph's own: build-graph.cjs derives it from __filename, so a
// rename moves the name in this page instead of leaving a literal here pointing nowhere.
const GRAPH_REL = G.GRAPH_REL;
const RUNNER_REL = 'scripts/build-runner.cjs';

// The tier whose legs the fleet view draws. The release tier is the whole fleet; `ci` is a
// subset of it, and a page that documented the subset would under-report where the build
// runs.
const TIER = 'release';

// ---- the symbolic context the views are rendered against ---------------------------------
//
// THREE of the graph's roots live OUTSIDE the repo and differ per machine: the patched
// txiki.js checkout (under the platform-tag vendor dir), the engine this build produces
// (under $TMPDIR, keyed by an OS-version tag), and the build-only toolchain the bundle step
// provisions for itself. They are given names here instead of values,
// so the page says what a path IS rather than where it happened to land on the box that
// generated it. They are absolute so that every path.join/path.resolve in the graph keeps
// working unchanged; the leading slash is stripped at display time.
// NOT a filename: `engine` names the binary itself rather than spelling a basename, because
// a basename would have to be `tjs` or `tjs.exe` depending on the target and the page would
// then quietly claim one of them for every reader. (test/windows-path-ratchet.test.cjs's
// exe-join-no-win32 rule says the same thing about joining an executable name with no win32
// branch; here there is no executable to name at all.)
const CHECKOUT_ROOT = '/engine-checkout';
const ENGINE_PATH = '/engine';
// The THIRD out-of-repo root, named for the same reason: the build-only toolchain directory
// (esbuild) `bundle.clode-main` provisions for itself. On this box it is
// `$TMPDIR/toolchain/<os>-<arch>-node<major>`, which is three machine-specific facts in one
// path, so the page says what it IS.
const TOOLCHAIN_ROOT = '/toolchain';

// The target the page is rendered for. FIXED, not this host: `out` is resolved through
// libexec/clode-build.cjs's resolveBuildOut, which appends `.exe` for a windows target — so
// rendering for "whatever host ran the generator" would make the committed page's output
// name depend on who typed --write. `linux-amd64` is named here for one property only (it
// is not windows), and renderAll() states the windows spelling alongside, derived from the
// same function rather than asserted in prose.
const RENDER_TARGET = 'linux-amd64';
const WINDOWS_TARGET = 'windows-amd64';

function renderContext(overrides) {
  return G.defaultContext(Object.assign({
    repo: REPO,
    target: RENDER_TARGET,
    checkout: CHECKOUT_ROOT,
    engine: ENGINE_PATH,
    toolchain: TOOLCHAIN_ROOT,
  }, overrides));
}

// A path under one of the known out-of-repo roots, named against that root. Anything else is a
// REFUSAL: it means the graph grew a root this renderer does not know about, and the choices
// are "commit a machine-specific path" or "say so". The first one is green here and red for
// everyone else, which is the worst shape a gate can have.
function underRoot(root, abs) {
  const rel = path.relative(root, abs);
  if (rel === '') return '';
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

function displayPath(ctx, abs) {
  for (const root of [ctx.checkout, ctx.engine, ctx.toolchain]) {
    const rel = underRoot(root, abs);
    if (rel === null) continue;
    const base = String(root).replace(/^[\\/]/, '').split(path.sep).join('/');
    return rel ? `${base}/${rel}` : base;
  }
  const rel = underRoot(ctx.repo, abs);
  if (rel !== null) return rel || '.';
  throw new Error(`render-build-graph: '${abs}' is under none of the repo, the engine `
    + 'checkout, the engine or the toolchain, so it cannot be named symbolically — and '
    + 'docs/build.md is '
    + 'COMMITTED, so rendering an absolute path here would bake this machine\'s home '
    + 'directory into a page whose gate then fails on every other machine. Either the graph '
    + 'grew a new out-of-repo root (give it a name in renderContext), or a step is naming '
    + 'something it should not.');
}

// ---- artifacts, collapsed to something a human can read -----------------------------------
//
// `engine.compile` declares 51 inputs and `bundle.clode-main` 83; drawing one node each
// would be a true diagram nobody can read, which is its own kind of false. So artifacts are
// grouped by DIRECTORY — a group of one keeps its filename (naming PINS.md is more useful
// than "the repo root, 1 file"), and a group of many is named by its directory and counted.
// Both the grouping key and the count are derived, so a 29th patch moves this page.
function groupArtifacts(displayPaths) {
  const order = [];
  const byDir = new Map();
  for (const p of displayPaths) {
    const dir = path.posix.dirname(p);
    if (!byDir.has(dir)) { byDir.set(dir, []); order.push(dir); }
    byDir.get(dir).push(p);
  }
  return order.map((dir) => {
    const members = byDir.get(dir);
    if (members.length === 1) return members[0];
    return `${dir === '.' ? '(repo root)' : `${dir}/`} — ${members.length} files`;
  });
}

// ---- mermaid plumbing ----------------------------------------------------------------------

// Step ids carry dots and artifact labels carry slashes, spaces and dashes; mermaid node ids
// may carry none of that. Ids are therefore positional and assigned in the order the view
// walks the graph, which is topological and stable — a diagram that reshuffles between runs
// is a diff nobody can read, and gate 4 would fail on it.
function idAllocator(prefix) {
  const seen = new Map();
  return (key) => {
    if (!seen.has(key)) seen.set(key, `${prefix}${seen.size}`);
    return seen.get(key);
  };
}

function q(text) {
  return String(text).replace(/"/g, "'");
}

// ---- view 1: the pipeline — what runs, and in what order ------------------------------------
//
// The `needs` DAG, with the steps collapsed into their `phase`. The phase grouping is what
// makes the shape legible: the engine half and the bundle half share no edge and run side by
// side, and they meet exactly once, at the blobulate. That is a real property of the graph
// (`bundle.clode-main` declares `needs: []`), not a layout choice.
function renderPipeline(list) {
  const steps = G.topoOrder(list);
  const nodeId = idAllocator('s');
  const lines = ['flowchart LR'];
  const phases = [];
  for (const s of steps) if (!phases.includes(s.phase)) phases.push(s.phase);
  for (const phase of phases) {
    lines.push(`  subgraph ph_${phase.replace(/[^a-z0-9]/gi, '_')}["${q(phase)}"]`);
    for (const s of steps) {
      if (s.phase !== phase) continue;
      lines.push(`    ${nodeId(s.id)}["${q(s.id)}<br/>runs on ${q(s.runsOn)}"]`);
    }
    lines.push('  end');
  }
  for (const s of steps) {
    for (const need of s.needs) {
      if (!steps.some((o) => o.id === need)) continue;
      lines.push(`  ${nodeId(need)} --> ${nodeId(s.id)}`);
    }
  }
  return lines.join('\n');
}

// ---- view 2: the artifacts — what each step consumes and produces -----------------------------
//
// The SAME graph projected onto its `inputs`/`outputs` instead of its `needs`. It answers a
// different question ("what is on disk between two steps?") and it is the view that shows
// the handoffs the `needs` edges only imply: the engine binary and the two esbuilt bundles
// are the entire interface between the two halves of this build.
function renderArtifacts(list, ctx) {
  const c = ctx || renderContext();
  const steps = G.topoOrder(list);
  const stepId = idAllocator('s');
  const artId = idAllocator('a');
  const nodes = [];
  const edges = [];
  const declared = new Set();

  const artifactNode = (label) => {
    const id = artId(label);
    if (!declared.has(id)) { declared.add(id); nodes.push(`  ${id}("${q(label)}")`); }
    return id;
  };

  for (const s of steps) {
    const sid = stepId(s.id);
    nodes.push(`  ${sid}[["${q(s.id)}"]]`);
    for (const label of groupArtifacts(s.inputs(c).map((p) => displayPath(c, p)))) {
      edges.push(`  ${artifactNode(label)} --> ${sid}`);
    }
    // A PROVISIONED input gets a DASHED edge pointing the other way, because that is what
    // it is: the step fills the directory and then reads it, so it is neither an input the
    // runner can assert nor an output of the build. Drawing it as a plain input edge would
    // claim the runner checks it (it cannot: the directory is absent on a clean machine),
    // and leaving it out is what the review found — an undeclared input in the one view
    // that exists to surface exactly that.
    for (const label of groupArtifacts((s.provisions ? s.provisions(c) : []).map((p) => displayPath(c, p)))) {
      edges.push(`  ${sid} -.->|"provisions, then reads"| ${artifactNode(label)}`);
    }
    for (const label of groupArtifacts(s.outputs(c).map((p) => displayPath(c, p)))) {
      edges.push(`  ${sid} --> ${artifactNode(label)}`);
    }
  }
  return ['flowchart LR'].concat(nodes, edges).join('\n');
}

// ---- view 3: the fleet — where each step runs, across every release leg -------------------------
//
// `runsOn` is the graph's answer to "which machine", and it is the one field that changes
// per leg: the source and bytecode steps always run on the runner (bytecode is canonical-LE
// and target-independent, which is why the netbsd-sparc guest can compile a tree it did not
// generate), while the compile and the blobulate move into containers, VM guests and qemu.
//
// COUNTED IN LEGS, NEVER IN NAMES, and the coverage refusal below is the whole reason this
// function takes leg TOKENS rather than calling targets() itself. canonical-name.cjs drops
// the libc qualifier for the published asset NAME, so `linux-riscv64-musl` collapses onto
// `linux-riscv64` (as one s390x leg collapses onto the other): the tier has 42 legs and only
// 40 distinct names. A fleet drawn from names would show 40, would look exactly as
// plausible, and would be silently missing two machines — which is the same
// resolving-for-the-wrong-machine class `runsOn` exists to express.
//
// The trap that makes an "is this one leg?" check useless: `linux-riscv64` is BOTH a leg
// token and the collapsed name of its musl twin, so legsNamed() answers 2 for a perfectly
// legitimate token. Identity cannot be checked one name at a time. COVERAGE can: the set
// handed here must be exactly the tier's legs, and passing targets() then fails by naming
// the two legs that went missing.
function fleetTally(list, legTokens, tier) {
  const steps = G.topoOrder(list);
  const t = tier || TIER;
  const fleet = G.legs(t);
  const tokens = legTokens || fleet;
  if (!tokens.length) {
    throw new Error('render-build-graph: the fleet view was handed no legs. An empty fleet '
      + 'renders as a diagram of a build that runs nowhere, which is worse than no diagram.');
  }
  const unknown = tokens.filter((tok) => !fleet.includes(tok));
  if (unknown.length) {
    throw new Error(`render-build-graph: ${unknown.join(', ')} — not ${t} leg token(s). `
      + 'The fleet view is drawn from scripts/tjs-legs.mjs\'s legs, and a name it does not '
      + 'declare has no machine to report.');
  }
  const missing = fleet.filter((tok) => !tokens.includes(tok));
  if (missing.length) {
    throw new Error(`render-build-graph: the fleet view was handed ${tokens.length} of the `
      + `${fleet.length} ${t} legs — missing ${missing.join(', ')}. A fleet drawn short looks `
      + 'exactly as plausible as the whole one and is silently missing a machine. The usual '
      + 'cause is counting CANONICAL NAMES: canonical-name.cjs drops the libc qualifier for '
      + `the published asset name, so these ${fleet.length} legs publish only `
      + `${G.targets(t).length} distinct names. Pass leg tokens (build-graph.cjs's legs()).`);
  }
  return steps.map((s) => {
    const counts = new Map();
    for (const token of tokens) {
      const where = G.runsOnFor(s, token, t);
      counts.set(where, (counts.get(where) || 0) + 1);
    }
    return {
      id: s.id,
      machines: G.RUNS_ON.filter((m) => counts.has(m)).map((m) => ({ machine: m, legs: counts.get(m) })),
    };
  });
}

function renderFleet(list, legTokens, tier) {
  const rows = fleetTally(list, legTokens, tier);
  const stepId = idAllocator('s');
  const machineId = idAllocator('m');
  const lines = ['flowchart LR'];
  // Only the machines this fleet actually uses, in build-graph.cjs's declared RUNS_ON order
  // — a machine no leg builds on would be a node drawing work nobody does, and RUNS_ON's
  // order is what keeps the diagram from reshuffling between runs.
  const machines = G.RUNS_ON.filter(
    (name) => rows.some((row) => row.machines.some((m) => m.machine === name)));
  for (const row of rows) lines.push(`  ${stepId(row.id)}[["${q(row.id)}"]]`);
  for (const name of machines) lines.push(`  ${machineId(name)}{{"${q(name)}"}}`);
  for (const row of rows) {
    for (const m of row.machines) {
      lines.push(`  ${stepId(row.id)} -->|"${m.legs} ${m.legs === 1 ? 'leg' : 'legs'}"| ${machineId(m.machine)}`);
    }
  }
  return lines.join('\n');
}

// ---- the page --------------------------------------------------------------------------------

// The command a developer types, DERIVED rather than asserted. The entry point is what this
// graph exists to serve, and the page names it either way — but a page that says "run it" in
// a checkout that has no such file is a lie the first reader finds, which is precisely the
// failure mode this whole task is a reaction to. So when the file is not there the page says
// so in one line and names the command that does work today; the line disappears by itself
// the moment the entry point is committed, and gate 4 makes regenerating it non-optional.
//
// IT MUST BE A FILE, AND THE NAME MUST COME FROM THE GRAPH. Both halves of that sentence are
// bugs this function already shipped. It asked about `build`, spelled here as a literal, and
// `build/` is a DIRECTORY in every working checkout — so `isFile()` answered false for a
// reason that had nothing to do with the entry point, and the page announced that its own
// front door "is not in this checkout yet" on a day it was right there. The name now comes
// from build-graph.cjs's ENTRY_REL (which is why it is `build.sh`: a file cannot share a name
// with build/ on a case-insensitive filesystem), and `isFile()` stays, because the directory
// it sits beside is exactly what a laxer existence check would find.
function entryPointPresent(repo) {
  try {
    return fs.statSync(path.join(repo || REPO, G.ENTRY_REL)).isFile();
  } catch {
    return false;
  }
}

// ---- what still needs node -------------------------------------------------------------
//
// THE PAGE MUST NOT BE TRUE BY OMISSION. Everything above this point describes a build the
// graph can run, and a reader takes that as "so I can build this without node" — because
// that is what the rest of this repo has spent months making true. It is not true YET, and
// the gap is exactly two steps. A page that left this out would contain no false sentence
// and would still mislead every reader who did not go and try it on a node-free box: the
// same rot this file is generated to prevent, arriving as a MISSING sentence rather than as
// a stale word.
//
// DERIVED, for the reason everything else here is. WHICH steps shell out to node comes from
// build-graph.cjs's nodeSteps(), which reads the steps' own `run` functions, so converting
// one drops its row without anyone having to remember that this page exists.

// WHY those entry points need node, MEASURED rather than asserted. The claim the section
// makes is "they are ESM, and the CJS node-shim loader cannot host a module" — so each one
// is put to an actual CommonJS parse instead of grepped for `import`. null means the file
// parses in the CommonJS goal (and the page's explanation of it has gone stale); otherwise
// the parser's own message, which is also what separates the two cases the section reports
// differently: "Cannot use import statement outside a module" is a refusal at load, while
// "Cannot use 'import.meta' outside a module" is an EARLY parse error — that file cannot
// run far enough to report its own failure, which is what makes it the harder conversion.
//
// node:vm, so this renderer is node-only. It already is, twice over (it is a dev/CI tool,
// and it asks ESM scripts/tjs-legs.mjs for the legs); scripts/build-tjs.cjs must not require
// this file, for the reason in this file's header.
function commonJsParseError(source) {
  try {
    new vm.Script(String(source), { filename: 'commonjs-goal-probe.cjs' });
    return null;
  } catch (e) {
    return (e && e.message) || String(e);
  }
}

// WHAT ELSE `./build.sh` NEEDS, and it is not only node (final whole-branch review,
// finding 6). `bundle.clode-main`'s entry point provisions its own build-only toolchain
// (esbuild) by running npm into an out-of-repo directory whenever esbuild does not already
// load from there — so a clean machine also needs `npm` and, the first time, the network.
// The page said nothing about it. That is this section's OWN stated failure mode ("THE PAGE
// MUST NOT BE TRUE BY OMISSION") arriving as a missing sentence: no false claim, and a
// clean-clone developer behind a firewall still gets the surprise the page promised to
// prevent.
//
// MEASURED, not asserted, in the same spirit as the CommonJS parse beside it: an entry
// point counts when its own source REACHES npm's CLI — it requires scripts/lib/npm-cli.cjs
// or calls npmCliPath(). Both spellings are call shapes rather than the word "npm", which
// appears in that file's comments a dozen times over. PURE, so the control can hand it a
// source either way round.
const NPM_CLI_USE = /require\(\s*['"][^'"]*npm-cli\.cjs['"]\s*\)|\bnpmCliPath\s*\(/;

function npmProvisioningEntries(verdicts) {
  return verdicts.filter((v) => NPM_CLI_USE.test(String(v.source))).map((v) => v.rel);
}

function nodeSection(list, ctx, out) {
  const rows = G.nodeSteps(list);
  const entries = [];
  for (const r of rows) for (const e of r.entries) if (!entries.includes(e)) entries.push(e);

  // The parse verdict for every entry point the steps name. A file that has BECOME CommonJS
  // and is still run through node is a refusal, not a silence: the section would otherwise
  // go on explaining it with a reason that had stopped being true, which is the precise
  // failure this page is generated to make impossible.
  const verdicts = entries.map((rel) => {
    let source;
    try {
      source = fs.readFileSync(path.join(ctx.repo, rel), 'utf8');
    } catch {
      throw new Error(`render-build-graph: '${rel}' is named by a step's run() but is not in `
        + 'this checkout, so the page cannot say why that step needs node. Either the step '
        + 'names the wrong path, or the file moved and nothing followed it.');
    }
    return { rel, source, err: commonJsParseError(source) };
  });
  const stillCjs = verdicts.filter((v) => v.err === null).map((v) => v.rel);
  if (stillCjs.length) {
    throw new Error(`render-build-graph: ${stillCjs.join(', ')} now parse(s) as CommonJS, yet `
      + 'the graph still runs it through node. This page explains that dependency by the entry '
      + 'point being ESM, and that explanation is now false. Either the step can stop calling '
      + 'runNode — which is the whole point of converting it — or the real reason has to be '
      + 'written down here in place of this one.');
  }
  // The entry point that cannot even report its own failure, named by its PARSER rather than
  // from memory, so the sentence about it leaves when the file it is about does.
  const earlyParse = verdicts.filter((v) => /import\s*\.\s*meta/.test(v.err)).map((v) => v.rel);
  const npmEntries = npmProvisioningEntries(verdicts);
  const code = (xs) => xs.map((x) => '`' + x + '`').join(' and ');

  const l = [];
  l.push('## What still needs node', '');
  if (!rows.length) {
    l.push('No declared step runs `node`: the whole graph runs under the engine it builds.', '');
  } else {
    l.push(`\`./${G.ENTRY_REL}\` is NOT node-free yet. ${rows.length} of the ${list.length} `
        + 'declared steps shell out to `node`:',
      '',
      '| step | shells out to |',
      '| --- | --- |');
    for (const r of rows) l.push(`| \`${r.id}\` | \`node ${r.entries.join(' ')}\` |`);
    l.push('',
      'The reason is the entry points, not the work they do: they are ESM, and the CJS',
      'node-shim loader the engine boots cannot host a module — neither one parses in the',
      'CommonJS goal at all.');
    if (earlyParse.length) {
      l.push(`${code(earlyParse)} is the harder conversion: \`import.meta\` outside a module is`,
        'an EARLY parse error, so that file cannot load far enough to report its own failure —',
        'a node-free run of it dies without saying why.');
    }
    l.push(`Converting ${code(entries)}`,
      'to CommonJS is what would take node off this list, and this section shrinks by itself',
      'when that lands.',
      '',
      'Everything else already runs under the engine, including the runner\'s own planning. So',
      `on a machine with no node, \`./${G.ENTRY_REL}\` plans the graph and builds the engine, and`,
      `then fails at \`${rows[0].id}\`.`,
      '');
    if (G.engineNodeOnWindows()) {
      l.push('On Windows the engine phase needs node as well: `scripts/build-tjs-boot.sh` is',
        'POSIX sh, so the engine steps fall back to `node scripts/build-tjs.cjs` there.',
        '');
    }
    if (npmEntries.length) {
      // WHERE it installs comes from the step's own `provisions`, not from a second reading
      // of the emitter: the artifact view below draws that same declaration as a dashed
      // edge, and two spellings of one directory is how the page and the graph drift.
      const into = [];
      for (const r of rows) {
        const step = list.find((x) => x.id === r.id);
        if (!step || typeof step.provisions !== 'function') continue;
        if (!r.entries.some((e) => npmEntries.includes(e))) continue;
        for (const abs of step.provisions(ctx)) {
          const d = displayPath(ctx, abs);
          if (!into.includes(d)) into.push(d);
        }
      }
      l.push(`It needs \`npm\` too, and on a cold machine the network: ${code(npmEntries)}`,
        'provisions its own build-only toolchain (esbuild) by running `npm`'
          + (into.length ? ` into ${code(into)},` : ','),
        'whenever esbuild does not already load from there. That is the one step of this',
        'build that fetches anything: a warm toolchain directory skips it, and a clean',
        'machine with no network does not get past it.',
        '');
    }
  }
  l.push('`npm test` needs node for a different reason, and will still need it after those',
    'entry points are converted: the suite is `node:test`, which the shim does not provide.',
    'Getting the suite off `node:test` is separate work, tracked in `BACKLOG.md`.',
    '');

  // The two commands side by side, with their comments aligned on a column derived from the
  // longer of the two. The entry point's name comes from the graph, so padding counted by
  // hand here would go crooked on the day it is renamed — which is the same class of rot,
  // one character wide.
  const entryCmd = `./${G.ENTRY_REL}`;
  const testCmd = 'npm test';
  const col = Math.max(entryCmd.length, testCmd.length) + 3;
  const pad = (cmd) => cmd + ' '.repeat(col - cmd.length);
  l.push('```sh',
    `${pad(entryCmd)}# builds ${out}`
      + (rows.length
        ? ` — ${npmEntries.length ? 'node and npm' : 'node'} still required, see above`
        : ' — no node, no npm'),
    `${pad(testCmd)}# requires node: the suite is node:test, which the shim does not provide`,
    '```',
    '');
  return l;
}

// ---- what a step provisions for itself ----------------------------------------------------
//
// A THIRD kind of edge, and it exists because leaving it out was a real finding (final
// whole-branch review, finding 4): `bundle.clode-main` installs its own build-only
// toolchain (esbuild) into an out-of-repo directory and then requires it from there. That
// is an input by every ordinary meaning of the word, and it is NOT an `inputs` entry,
// because the runner asserts `inputs` BEFORE a step runs and this directory does not exist
// on a clean machine. Undeclared, it was invisible to the graph and to the view that exists
// to surface undeclared inputs; declared as an input it would refuse every first build.
//
// DERIVED, and silent when there is nothing to say: a graph whose steps provision nothing
// renders no paragraph at all, so this cannot become a sentence about a field nobody uses.
function provisionSection(list, ctx) {
  const rows = list.filter((s) => typeof s.provisions === 'function')
    .map((s) => ({ id: s.id, paths: s.provisions(ctx).map((abs) => displayPath(ctx, abs)) }))
    .filter((r) => r.paths.length);
  if (!rows.length) return [];
  const named = rows.map((r) => `\`${r.id}\` (${r.paths.map((x) => `\`${x}\``).join(', ')})`);
  return [
    'A DASHED edge is an artifact the step provisions for itself and then reads: '
      + `${named.join(', ')}.`,
    'The runner does not assert those — they are absent on a clean machine by construction,',
    'and the step fills them. They are drawn because an input nothing declares is an input',
    'nothing can notice going missing.',
    '',
  ];
}

function stepsTable(list) {
  const rows = [
    '| step | phase | runs on | needs | count |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const s of G.topoOrder(list)) {
    const count = s.count ? String(s.count()) : '—';
    rows.push(`| \`${s.id}\` | ${s.phase} | ${s.runsOn} | ${s.needs.length ? s.needs.map((n) => `\`${n}\``).join(', ') : '—'} | ${count} |`);
  }
  return rows;
}

function renderAll(opts) {
  const o = opts || {};
  const ctx = o.ctx || renderContext();
  const list = G.steps();
  const legTokens = G.legs(TIER);
  const names = G.targets(TIER);
  // The names MORE THAN ONE leg collapses onto — derived, so the sentence below cannot say
  // "two pairs" on the day it becomes three.
  const shared = names.filter((n) => G.legsNamed(n, TIER).length > 1);
  // The steps that DO NOT run in the same place for every leg — derived from the fleet
  // tally, so the sentence below names them instead of counting them from memory.
  const movers = fleetTally(list, legTokens, TIER)
    .filter((row) => row.machines.length > 1).map((row) => row.id);
  const runnerUsage = require('./build-runner.cjs').USAGE;
  const out = displayPath(ctx, path.resolve(ctx.repo, ctx.out));
  const winOut = renderContext({ target: WINDOWS_TARGET }).out;
  const here = entryPointPresent(ctx.repo);

  const lines = [];
  const p = (...l) => lines.push(...l);

  p(`<!-- GENERATED FILE — do not edit. Written by \`node ${SELF_REL} --write\` from the`,
    `     build graph declared in ${GRAPH_REL}. test/build-graph-render.test.cjs fails when`,
    '     this file is not byte-for-byte what the renderer emits today. -->',
    '',
    '# Building clode',
    '',
    `\`./${G.ENTRY_REL}\` turns a clean clone into a working \`${out}\` — the builder this `
      + 'repo ships.',
    'It is the only command a developer needs, and everything below is drawn from the one',
    `place that declares what it does: \`${GRAPH_REL}\`.`,
    '');
  if (!here) {
    p(`> \`./${G.ENTRY_REL}\` is not in this checkout yet. Until it lands, the same run is`,
      `> \`node ${RUNNER_REL}\`, which is what \`./${G.ENTRY_REL}\` will exec.`,
      '');
  }
  p(`The engine — a patched [txiki.js](https://github.com/saghul/txiki.js) — is an INTERIOR`,
    'node of this graph, not something a developer builds by hand. `quaude` is what the',
    `resulting \`${out}\` goes on to build; it is not part of this page.`,
    '',
    `On Windows the same run produces \`${winOut}\`.`,
    '');
  p(...nodeSection(list, ctx, out));
  p('## The steps',
    '');
  p(...stepsTable(list));
  p('',
    '`count` is a step\'s derived denominator — how many units of work it covers (patches',
    'applied, bundles emitted) — and `—` where a step has none. It is computed, never',
    'written down, so it moves when the thing it counts moves.',
    '',
    '`runs on` above is the NATIVE answer — where each step runs when you build for the',
    `machine you are sitting at. ${movers.map((id) => `\`${id}\``).join(' and ')} move when the`,
    'target is not this machine; the fleet view below is where they move to.',
    '',
    '## What runs, and in what order',
    '',
    'The `needs` edges, grouped by phase. The two halves of the build share no edge: the',
    'engine is compiled while `clode`\'s own entry points are bundled, and they meet exactly',
    `once, at \`${G.ROOT_ID}\`.`,
    '',
    '```mermaid');
  p(renderPipeline(list));
  p('```',
    '',
    '## What each step consumes and produces',
    '',
    'The same graph projected onto `inputs` and `outputs` instead of `needs`. Rounded nodes',
    'are artifacts on disk; `engine-checkout` is the patched txiki.js tree and `engine` is the',
    'engine binary this build produces — both live outside the repo, at paths that differ per',
    'machine, so they are named rather than spelled. Groups of files are named by their',
    'directory and counted.',
    '',
    'Two artifact nodes that share a path prefix are the same tree at different depths — a',
    'step can consume a subtree of another step\'s output — and the ordering between the steps',
    'that touch them is in the view above, not here.',
    '',
    'The runner treats these as assertions, not as documentation: a declared input that is',
    'missing stops the step before it runs, and a declared output that did not appear fails',
    'the run.',
    '');
  p(...provisionSection(list, ctx));
  p('```mermaid');
  p(renderArtifacts(list, ctx));
  p('```',
    '',
    `## Where each step runs, across the ${legTokens.length} release legs`,
    '',
    'One graph, parameterized by target — never one graph per leg. `runs on` is the field',
    'that moves: the source and bytecode steps always run on the runner (bytecode is',
    'canonical little-endian and therefore target-independent, which is how a 512MB sun4m',
    'guest can compile a tree it did not generate), while the compile and the blobulate move',
    'into cross-toolchain containers, VM guests and qemu.',
    '',
    `Counted in LEGS, never in names. These ${legTokens.length} legs publish only `
      + `${names.length} distinct asset names — canonical-name.cjs`,
    `drops the libc qualifier, so ${shared.length} of those names (${shared.join(', ')}) are `
      + 'shared by two legs each.',
    `A fleet counted in names would be ${legTokens.length - names.length} legs short and would `
      + 'look exactly as plausible.',
    '',
    '```mermaid');
  p(renderFleet(list, legTokens, TIER));
  p('```',
    '',
    '## Running part of it',
    '',
    'The same graph, narrowed. A selection that matches no step is refused rather than',
    'reported as a successful build of nothing.',
    '',
    '```text');
  p(runnerUsage);
  p('```',
    '',
    '## Changing the build',
    '',
    `Edit \`${GRAPH_REL}\`, then regenerate this page:`,
    '',
    '```sh',
    `node ${SELF_REL} --write`,
    '```',
    '',
    'Nothing here is written by hand. Every node, edge and number above is read out of the',
    'graph, and the graph\'s `inputs`, `outputs` and `count` are functions that compose other',
    'single sources of truth rather than lists anyone maintains. That is the only arrangement',
    'under which a page about a build stays true to it.',
    '');
  return lines.join('\n');
}

// ---- cli ----------------------------------------------------------------------------------------

const USAGE = [
  `usage: ${SELF_REL} [--write]`,
  '',
  `  Renders ${PAGE_REL} from the build graph declared in ${GRAPH_REL}.`,
  '',
  `  --write   overwrite ${PAGE_REL} (default: print to stdout)`,
  '  --help    this text',
].join('\n');

function main(argv) {
  let write = false;
  for (const a of argv) {
    if (a === '--help' || a === '-h') { console.log(USAGE); return 0; }
    if (a === '--write') write = true;
    else throw new Error(`render-build-graph: unknown argument '${a}'\n${USAGE}`);
  }
  const page = renderAll();
  if (!write) { process.stdout.write(page); return 0; }
  const dest = path.join(REPO, PAGE_REL);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, page);
  console.log(`render-build-graph: wrote ${PAGE_REL}`);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (e) {
    console.error((e && e.message) || String(e));
    process.exitCode = 1;
  }
}

module.exports = {
  renderPipeline, renderArtifacts, renderFleet, renderAll,
  fleetTally, groupArtifacts, renderContext, displayPath, entryPointPresent,
  stepsTable, nodeSection, provisionSection, npmProvisioningEntries, commonJsParseError, main, USAGE, PAGE_REL, TIER,
};
