'use strict';
// gate 3 — CI names a STEP ID, and cannot invent one OR route around one.
//
// WHY THIS EXISTS. scripts/build-graph.cjs is the one declaration of what building this
// repo does, and a declaration CI routes around is prose. A call site in a workflow or a
// composite action that spells out a command instead of naming a step is a step the graph
// never hears about: it can be added, changed or dropped with the graph, the generated
// docs/build.md and the diagrams all staying green and all wrong.
//
// WHAT THIS GATE CATCHES. Two rules, and the second one is new.
//
//   (1) A call site that NAMES a step id must name one the graph declares. A typo in CI
//       YAML is otherwise found by a 40-minute matrix.
//   (2) No call site may INVOKE the engine build as a command. This is the wider property
//       the paragraph above describes, and until 2026-09-21 it was NOT enforced — a bare
//
//           run: node scripts/build-tjs.cjs --regen-only
//
//       appended to the real .github/actions/build-leg/action.yml gave 4 pass / 0 fail.
//       Nothing saw it. That reproduction is this file's own control (CONTROL_YAML below)
//       and the test directly beneath the guard, so the hole cannot reopen silently.
//
// WHAT UNBLOCKED (2). Six call sites shared ONE blocker: `--only engine.compile` selected
// that step AND its transitive `needs`, so naming it would have dragged engine.bytecode and
// engine.source into an alpine container, a cross image or a VM guest that cannot run a
// source phase at all. `--needs assume` (scripts/build-runner.cjs) runs the named step
// alone while still refusing an absent declared input, so those machines can name the step
// they really run. The sites converted; the rule belongs here now.
//
// WHICH COMMANDS COUNT, AND WHY IT IS NOT A LIST. The programs the engine phase shells out
// to are OBSERVED from the graph -- each engine step's `run` is driven with a recording
// exec, on both platforms, and what it spawns is the answer (build-graph.cjs's
// observedNodeRouteFindings). So `scripts/build-tjs-boot.sh` and `scripts/build-tjs.cjs`
// are never written down here: rename either one, or route the engine phase through a third
// program, and this rule moves with it instead of quietly matching nothing. "Derived, never
// declared" is doctrine in this repo because a hand-maintained list of call sites has gone
// silently wrong three times.
//
// AND WHICH FILES. Every `.yml`/`.yaml` under `.github`, found by walking the directory --
// not a list of three paths. The known sites at the time of writing lived in THREE
// different files (.github/actions/build-leg/action.yml, .github/actions/cross-blobulate/
// action.yml, .github/workflows/repro.yml), and a gate that had looked only at the first
// would have reported a clean bill of health over the other two.
//
// THE PHASE FILTER IS ONE WORD, deliberately. This rule covers the ENGINE phase, because
// that is the phase whose call sites the graph can express today. `bundle.clode-main` and
// `clode.blobulate` still shell out to `node scripts/build-clode-main.mjs` and `node
// scripts/stage0.mjs` in CI, and those two entry points are ESM the CJS node-shim cannot
// host at all (docs/build.md's "What still needs node" says so and shrinks by itself when
// they convert). Widening this gate to them is deleting ENGINE_PHASE below -- it is not a
// second gate -- and it should happen when those entry points can be reached through
// ./build.sh on a machine with no node.
//
// A GUARD, NOT A BARE TEST, AND THE FLOOR IS THE WHOLE POINT. The interesting failure of
// a rule shaped like "every X satisfies P" is that there are NO X: this repo has found
// ~18 gates that passed by finding nothing, one of whose assertions certified the very bug
// it guarded. test/guard.cjs already has the vocabulary for that -- `examined` is the
// number of call sites this scan actually read (named ids PLUS raw invocations), and a run
// below `floor` reports BROKEN rather than OK. Before any call site was converted this gate
// did not pass; it said, in the repo's own words, that it had inspected nothing.
//
// BOTH SPELLINGS OF A NAMED SITE, and neither is hand-written twice. A converted site may
// name the runner directly (`scripts/build-runner.cjs --only <id>`) or go through the
// developer entry point, which resolves an engine first and hands the runner its arguments
// verbatim (`./build.sh --only <id>`). Which one a site uses is not a style choice: the
// entry point is POSIX sh and is the spelling for any machine that must build without a
// node (the alpine containers, the cross images, the VM guests), while the runner-under-
// node spelling is what the Windows halves use, because nothing has ever run a POSIX sh
// wrapper on a win32 runner. The entry point's FILENAME comes from the graph (ENTRY_REL),
// so renaming it moves this rule with it instead of leaving a gate that quietly matches
// nothing.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { defineGuard, guardTests } = require('./guard.cjs');
const G = require('../scripts/build-graph.cjs');

const repo = path.join(__dirname, '..');
const CI_DIR = '.github';
const ENGINE_PHASE = 'engine';

const quote = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Every CI YAML, found rather than listed. Relative POSIX paths, sorted, so a finding names
// a path a reader can open and the order does not depend on the filesystem.
function ciYamlFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.ya?ml$/.test(e.name)) out.push(path.relative(root, p).split(path.sep).join('/'));
    }
  };
  walk(path.join(root, CI_DIR));
  return out;
}

// THE PROGRAMS THE ENGINE PHASE RUNS, observed rather than named. Each engine step's `run`
// is driven with a recording exec on both platforms; what it spawns -- the POSIX wrapper by
// path, and the win32 `node <entry>` argv -- is what a CI call site would have to spell out
// in order to bypass the graph. Repo-relative, because that is how a YAML line spells them.
//
// AN EMPTY ANSWER IS REFUSED, for toolchainProvisionerIds's reason: a derivation that can
// answer "the engine phase runs nothing" is indistinguishable from one that stopped
// reading, and this one's whole job is to say which commands must not appear.
function engineCommands(steps, ctx) {
  const engine = steps.filter((s) => s.phase === ENGINE_PHASE);
  const { observed } = G.observedNodeRouteFindings({ steps: engine, ctx });
  const out = new Set();
  for (const o of observed) {
    for (const p of o.programs.concat(o.windowsPrograms)) {
      // `node` is the interpreter, not the entry point; the entry point is in the argv.
      if (/\.(sh|cjs|mjs|js)$/.test(p)) out.add(path.relative(ctx.repo, p).split(path.sep).join('/'));
    }
    for (const e of o.entries.concat(o.windowsEntries)) out.add(e);
  }
  if (!out.size) {
    throw new Error('build-graph-ci: driving the engine phase\'s steps spawned no named '
      + `program at all (looked at ${engine.length} step(s) of phase '${ENGINE_PHASE}'). `
      + 'This gate refuses CI call sites that invoke those programs directly, so an empty '
      + 'answer is a gate that refuses nothing while reading exactly like a clean one. '
      + 'Either the engine phase stopped shelling out -- delete this rule -- or the '
      + 'observation stopped reaching it. Do not hardcode the command names.');
  }
  return [...out].sort();
}

// CALL SITES ONLY, NOT PROSE ABOUT THEM — the narrowing test/build-tjs-boot.test.cjs's
// bootSites() already learned the hard way. The YAML explains the idiom in comments that
// necessarily quote it, and a comment is not an invocation. Worse than a false finding,
// counting one would hand the floor a free pass: a step could be un-named entirely while a
// paragraph describing it kept `examined` above zero, which is the exact green-about-
// nothing this gate is built to refuse.
function stepIdsNamedBy(yamlText, entryRel) {
  const re = new RegExp(`(?:build-runner\\.cjs|${quote(entryRel)})[^\\n]*--only[= ]([a-z][a-z0-9.-]*)`);
  const out = [];
  for (const line of String(yamlText).split('\n')) {
    const t = line.trim().replace(/^run:\s+/, '');
    if (t.startsWith('#')) continue;
    const m = re.exec(t);
    if (m) out.push(m[1]);
  }
  return out;
}

// The same narrowing, for the other half of the rule: which lines INVOKE one of the engine
// phase's programs. Deliberately as coarse as bootSites() and for the stated reason -- the
// cost of reading one prose line is a loud false finding, while the cost of a too-clever
// narrowing is a call site this reader silently stops seeing.
function engineInvocations(yamlText, commands) {
  const out = [];
  const lines = String(yamlText).split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i].trim().replace(/^run:\s+/, '');
    if (t.startsWith('#')) continue;
    for (const c of commands) {
      if (t.includes(c)) { out.push({ line: i + 1, text: t, command: c }); break; }
    }
  }
  return out;
}

// THE ALLOWLIST, EXPLICIT AND NAMED, keyed by `<file>:<the command text>` -- never by line
// number, which rots on the next edit. It is EMPTY, and that is the milestone rather than
// an oversight: every engine call site in CI names a step id today, including the two
// Windows halves (they run `node scripts/build-runner.cjs --only <id>`, which keeps the
// node win32 needs while still naming the step). An entry here costs a PROVEN reason in
// this file, and an entry with no matching site is a phantom that fails below -- the same
// discipline test/build-tjs-boot.test.cjs's NOT_YET_FLIPPED carries, for the same reason:
// an exception list that outlives its reason is how a gate rots.
const ALLOWED = {};

const GUARD = defineGuard({
  name: 'build-graph-ci-step-ids',
  // The named call sites, which is the population that matters. It rose from 1 to 10 when
  // the six blocked sites converted, and it must never fall to 0 -- that is the state this
  // floor exists to report as BROKEN rather than as OK.
  floor: 8,
  read: () => {
    const files = ciYamlFiles(repo);
    return {
      files: files.map((rel) => ({ rel, text: fs.readFileSync(path.join(repo, rel), 'utf8') })),
      declared: G.steps().map((s) => s.id),
      entryRel: G.ENTRY_REL,
      commands: engineCommands(G.steps(), G.defaultContext()),
      allowed: ALLOWED,
    };
  },
  scan: ({ files, declared, entryRel, commands, allowed }) => {
    const findings = [];
    let examined = 0;

    if (!files.length) {
      findings.push(`no CI YAML was found under ${CI_DIR}/ at all. This gate reads the `
        + 'workflows and composite actions to see how CI asks for a build; finding none is '
        + 'a broken reader, not a repo without CI.');
    }

    const hit = new Set();
    for (const { rel, text } of files) {
      for (const id of stepIdsNamedBy(text, entryRel)) {
        examined += 1;
        if (!declared.includes(id)) {
          findings.push(`${rel} names step '${id}', which the graph does not declare. `
            + `It declares: ${declared.join(', ')}.`);
        }
      }
      for (const site of engineInvocations(text, commands)) {
        examined += 1;
        const key = `${rel}:${site.text}`;
        if (Object.prototype.hasOwnProperty.call(allowed, key)) { hit.add(key); continue; }
        findings.push(`${rel}:${site.line} INVOKES the engine build as a command `
          + `(\`${site.text}\`) instead of naming a step id. scripts/build-graph.cjs is the `
          + 'one declaration of what a build does, and a command spelled out here is a step '
          + `the graph never hears about. Say \`./${entryRel} --only <step-id>\` (add `
          + '`--needs assume` when another machine already built what that step needs and '
          + 'synced the outputs here), or `node scripts/build-runner.cjs --only <step-id>` '
          + 'on a machine that has to stay on node. If this site genuinely cannot be '
          + 'migrated, add it to ALLOWED in this file WITH the proof.');
      }
    }

    for (const key of Object.keys(allowed)) {
      if (!hit.has(key)) {
        findings.push(`ALLOWED names a call site that is not there any more: ${key}. A `
          + 'carve-out that outlives its reason is how an exception list rots; delete the '
          + 'entry when you migrate the site.');
      }
    }

    return { findings, examined };
  },
  // BOTH RULES VIOLATED AT ONCE, so a scan that has gone blind on either shows up as a
  // shortfall rather than as a pass. The second half is the reviewer's exact reproduction,
  // verbatim. Not an empty file: an empty file models the "nothing to check" state, which
  // is what `floor` reports, and a control has to model a VIOLATION this guard must detect.
  control: () => ({
    files: [{
      rel: 'control.yml',
      text: '        run: scripts/build-runner.cjs --only fabricated.step\n'
        + `        ./${G.ENTRY_REL} --only also.fabricated\n`
        + '        run: node scripts/build-tjs.cjs --regen-only\n',
    }],
    declared: G.steps().map((s) => s.id),
    entryRel: G.ENTRY_REL,
    commands: engineCommands(G.steps(), G.defaultContext()),
    allowed: ALLOWED,
  }),
});

guardTests(GUARD);

// ---- the extractor itself, which the guard can only be as good as --------------------------

test('gate 3: a comment naming the idiom is not a call site, but the same line without # is', () => {
  for (const caller of [`./${G.ENTRY_REL}`, 'scripts/build-runner.cjs']) {
    assert.deepStrictEqual(stepIdsNamedBy(`        # ${caller} --only ${G.ROOT_ID}\n`, G.ENTRY_REL), [],
      `a comment quoting \`${caller} --only <id>\` was counted as a call site`);
    assert.deepStrictEqual(stepIdsNamedBy(`        ${caller} --only ${G.ROOT_ID}\n`, G.ENTRY_REL), [G.ROOT_ID],
      `the same line WITHOUT the # must still count: ${caller}`);
  }
});

test('gate 3: the same narrowing holds for an engine invocation', () => {
  const commands = engineCommands(G.steps(), G.defaultContext());
  assert.deepStrictEqual(
    engineInvocations('        # run: node scripts/build-tjs.cjs --regen-only\n', commands), []);
  assert.strictEqual(
    engineInvocations('        run: node scripts/build-tjs.cjs --regen-only\n', commands).length, 1);
});

// THE REVIEWER'S REPRODUCTION, against the REAL files rather than a fixture. Appending
// `run: node scripts/build-tjs.cjs --regen-only` to a real workflow used to give 4 pass /
// 0 fail. This asserts the widened scan finds it in whichever file it is appended to, which
// is the property that was missing; the guard above proves the finding becomes a VIOLATION.
test('gate 3: a bare `run:` appended to a REAL workflow is seen, in every CI file', () => {
  const commands = engineCommands(G.steps(), G.defaultContext());
  const files = ciYamlFiles(repo);
  assert.ok(files.length >= 3, `only ${files.length} CI YAML file(s) found under ${CI_DIR}/`);
  for (const rel of files) {
    const real = fs.readFileSync(path.join(repo, rel), 'utf8');
    const before = engineInvocations(real, commands).length;
    const after = engineInvocations(`${real}\n        run: node scripts/build-tjs.cjs --regen-only\n`, commands);
    assert.strictEqual(after.length, before + 1,
      `${rel}: appending the reviewer's line changed nothing this scan can see`);
    assert.strictEqual(after[after.length - 1].text, 'node scripts/build-tjs.cjs --regen-only');
  }
});

test('gate 3: the commands it refuses are OBSERVED from the graph, not written down here', () => {
  const commands = engineCommands(G.steps(), G.defaultContext());
  // The two spellings the engine phase actually uses today. Asserted as a SET membership,
  // so adding a third route widens the gate rather than failing this test — but the
  // wrapper and the entry point must both be in there, or the gate is half-blind.
  assert.ok(commands.includes('scripts/build-tjs.cjs'),
    `the win32 entry point is not among the observed commands: ${commands.join(', ')}`);
  assert.ok(commands.some((c) => /build-tjs-boot\.sh$/.test(c)),
    `the POSIX wrapper is not among the observed commands: ${commands.join(', ')}`);
  // And nothing from another phase leaked in: those entry points are legitimately run
  // directly in CI, and refusing them here would be a gate about the wrong property.
  for (const rel of ['scripts/build-clode-main.mjs', 'scripts/stage0.mjs']) {
    assert.ok(!commands.includes(rel), `${rel} is not an engine-phase command`);
  }
});

test('gate 3: the ids extracted from the shipped YAML are real graph ids', () => {
  // The floor above catches an extractor that has gone blind. This catches the other half:
  // one that finds a site and reads the wrong token out of it. Membership in the graph's
  // own id list, not merely the shape of what followed --only.
  const declared = G.steps().map((s) => s.id);
  let total = 0;
  for (const rel of ciYamlFiles(repo)) {
    const named = stepIdsNamedBy(fs.readFileSync(path.join(repo, rel), 'utf8'), G.ENTRY_REL);
    total += named.length;
    for (const id of named) assert.ok(declared.includes(id), `${rel}: ${id} is not one of: ${declared.join(', ')}`);
  }
  assert.ok(total > 0, 'no call site names a step id — this gate would be vacuous');
});
