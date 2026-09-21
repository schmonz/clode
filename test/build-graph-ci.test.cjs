'use strict';
// gate 3 — CI names a STEP ID, and cannot invent one.
//
// WHY THIS EXISTS. scripts/build-graph.cjs is the one declaration of what building this
// repo does, and a declaration CI routes around is prose. A call site in
// .github/actions/build-leg/action.yml that spells out a command instead of naming a step
// is a step the graph never hears about: it can be added, changed or dropped with the
// graph, the generated docs/build.md and the diagrams all staying green and all wrong.
//
// WHAT THIS GATE CATCHES, EXACTLY, AND WHAT IT DOES NOT. It reads every call site that
// NAMES a step id and refuses an id the graph does not declare — a typo in CI YAML is
// otherwise found by a 40-minute matrix. It does NOT catch the wider property the sentence
// above describes: a bare `run:` that spells out a command instead of naming a step is
// INVISIBLE to it. That is measured, not assumed. The final whole-branch review appended
//
//     run: node scripts/build-tjs.cjs --regen-only
//
// to the real action.yml and this file reported 4 pass / 0 fail. Six un-converted sites
// remain, sharing one blocker (a runner mode that runs a named step ALONE — `--only
// engine.compile` today drags engine.bytecode and engine.source into containers and guests
// that cannot run a source phase), so a gate that COUNTED the un-converted sites would be
// red by design today. That decision is the user's and is recorded in BACKLOG.md with this
// reproduction; when it lands, the wider rule belongs here and this paragraph goes away.
// Until then the header says what the code does, because a file header claiming a property
// its code does not test is the same rot as a page claiming a build it does not describe.
//
// A GUARD, NOT A BARE TEST, AND THE FLOOR IS THE WHOLE POINT. The interesting failure of
// a rule shaped like "every X satisfies P" is that there are NO X: this repo has found
// ~18 gates that passed by finding nothing, one of whose assertions certified the very bug
// it guarded. test/guard.cjs already has the vocabulary for that — `examined` is the
// number of call sites this scan actually read, and a run below `floor` reports BROKEN
// rather than OK. So before any call site was converted this gate did not pass; it said,
// in the repo's own words, that it had inspected nothing. That red was observed, not
// assumed.
//
// BOTH SPELLINGS, and neither is hand-written twice. A converted site may name the runner
// directly (`scripts/build-runner.cjs --only <id>`) or go through the developer entry
// point, which resolves an engine first and hands the runner its arguments verbatim
// (`./build.sh --only <id>`). CI uses the second, for the reason the first conversion's
// own comment gives: the site it replaced ran the build under a bootstrap engine, and
// `node scripts/build-runner.cjs` would have put a node back on that machine. The entry
// point's FILENAME comes from the graph (ENTRY_REL), so renaming it moves this rule with
// it instead of leaving a gate that quietly matches nothing.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { defineGuard, guardTests } = require('./guard.cjs');
const G = require('../scripts/build-graph.cjs');

const repo = path.join(__dirname, '..');
const ACTION = '.github/actions/build-leg/action.yml';

const quote = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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

const GUARD = defineGuard({
  name: 'build-graph-ci-step-ids',
  // ONE call site is enough for the verdict to mean something, and one is what there is:
  // the qemu-* bytecode regen. It rises as the other six convert, and it must never be 0 —
  // that is the state this floor exists to report as BROKEN rather than as OK.
  floor: 1,
  // The DECLARED ids come from the graph rather than from a literal list here, so a
  // renamed step cannot leave this gate quietly agreeing with a CI file nobody updated.
  read: () => ({
    yaml: fs.readFileSync(path.join(repo, ACTION), 'utf8'),
    declared: G.steps().map((s) => s.id),
    entryRel: G.ENTRY_REL,
  }),
  scan: ({ yaml, declared, entryRel }) => {
    const findings = [];
    const named = stepIdsNamedBy(yaml, entryRel);
    for (const id of named) {
      if (!declared.includes(id)) {
        findings.push(`${ACTION} names step '${id}', which the graph does not declare. `
          + `It declares: ${declared.join(', ')}.`);
      }
    }
    return { findings, examined: named.length };
  },
  // A fabricated id in BOTH spellings. Not an empty file: an empty file models the
  // "nothing to check" state, which is what `floor` reports, and a control has to model a
  // VIOLATION this guard must detect.
  control: () => ({
    yaml: `        run: scripts/build-runner.cjs --only fabricated.step\n`
      + `        ./${G.ENTRY_REL} --only also.fabricated\n`,
    declared: G.steps().map((s) => s.id),
    entryRel: G.ENTRY_REL,
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

test('gate 3: the ids extracted from the shipped YAML are real graph ids', () => {
  // The floor above catches an extractor that has gone blind. This catches the other half:
  // one that finds a site and reads the wrong token out of it. Membership in the graph's
  // own id list, not merely the shape of what followed --only.
  const named = stepIdsNamedBy(fs.readFileSync(path.join(repo, ACTION), 'utf8'), G.ENTRY_REL);
  const declared = G.steps().map((s) => s.id);
  assert.ok(named.length > 0, 'no call site names a step id — this gate would be vacuous');
  for (const id of named) assert.ok(declared.includes(id), `${id} is not one of: ${declared.join(', ')}`);
});
