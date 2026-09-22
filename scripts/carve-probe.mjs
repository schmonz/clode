#!/usr/bin/env node
// carve-probe — the daily answer to "can clode carve NEWER upstream than the pin yet?"
//
//   node scripts/carve-probe.mjs --provider <claude-binary> --version <x.y.z> --engine <tjs>
//
// WHY THIS EXISTS. UPSTREAM_PIN holds @anthropic-ai/claude-code at a version behind
// upstream on purpose, and the doctrine that allows that ("absorb the change AND make the
// next absorption cheaper") only holds if something keeps asking whether the reason is
// still true. Nothing did. upstream-drift.yml's `anchors` job checks hook sites and CLI
// reachability; its `boots` job builds from the PIN. Neither reaches the SCC merge, which
// is where the pin's reason lives — so a 22-day, 27-version gap went unnoticed
// (BACKLOG.md, "the daily drift job cannot see the thing that is actually broken").
//
// WHAT IT ASSERTS, and why it is not simply `boots` pointed at `next`. That leg would be
// red from birth, which upstream-drift-check.mjs's own header already rejects as a reason
// people learn to ignore a light. This asserts the RECORDED STATE instead — the outcome
// someone measured and wrote into UPSTREAM_PIN — and goes red on EITHER change:
//
//   * recorded `carves`, measured blocked  -> upstream broke us; a fresh blocker to name
//   * recorded `blocked …`, measured carves -> the blocker lifted; ABSORB NOW
//   * recorded `blocked A`, measured blocked by B -> the recorded reason is STALE
//
// Both directions come out of the same comparison, so the probe cannot lose one of them
// by being edited: flipping the recorded line in UPSTREAM_PIN flips which direction is
// live, and neither is spelled anywhere else.
//
// AND IT DISTINGUISHES "DID NOT RUN" FROM "RAN AND WAS BLOCKED". A probe whose infra
// failure reads as "still blocked" is the same green-that-hides it exists to remove, so
// every precondition (no provider, no engine, upstream not past the pin, a bundle shape
// with no module graph) is a named SKIP, printed as such, never folded into a verdict.
//
// NODE, DELIBERATELY, AND NOT ON THE BUILD PATH. This is a CI helper in the shape
// upstream-drift.yml already uses (`node scripts/upstream-drift-check.mjs`), not something
// the build graph reaches. It drives the REAL staging entry point — libexec/clode-extract's
// extractIfNeeded, the same call `clode build` makes — rather than a second implementation
// of carving and merging, because a probe of a reimplementation proves nothing about the
// thing that breaks.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { cmpVersions } from './check-guest-versions.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// THE TWO STAGES, and they are structural rather than parsed out of an error string. The
// probe runs staging, then compiles what staging produced; which one threw is therefore
// known by WHERE the throw happened, not by what it said. (Carve and merge are one stage
// because they are one call — extractIfNeeded — and splitting them here would mean
// reimplementing the split, which is exactly what this file refuses to do.)
export const STAGES = Object.freeze(['stage', 'compile']);
export const CARVES = 'carves';
export const BLOCKED = 'blocked';

// ---- the recorded expectation -------------------------------------------------------
//
// It lives in UPSTREAM_PIN because that file is ALREADY this class of fact — "MEASURED
// EVIDENCE for the pin, so the gap is a dated fact and not a memory (every line here is
// something someone observed, not inferred)". A second file restating it is how three
// hand-maintained lists in this repo went silently stale. The grammar:
//
//   carve-probe <version-measured> carves
//   carve-probe <version-measured> blocked <stage> <reason text…>
//
// `<version-measured>` is context for a reader, NOT part of the comparison: the record is
// about the OUTCOME, and upstream moves daily. The reason is matched as a SUBSTRING of
// whatever the failure actually said, so a minified identifier or a byte excerpt inside
// the message cannot make a still-accurate record read as drift.
export function parsePinFile(text) {
  const out = { pin: null, expectation: null, malformed: [] };
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    let m = /^claude-code (.+)$/.exec(line);
    if (m) { out.pin = m[1].trim(); continue; }
    m = /^carve-probe (\S+) (.+)$/.exec(line);
    if (!m) continue;
    const [, version, rest] = m;
    if (rest.trim() === CARVES) {
      out.expectation = { version, outcome: CARVES, stage: null, reason: null };
      continue;
    }
    const b = new RegExp(`^${BLOCKED} (\\S+) (.+)$`).exec(rest.trim());
    if (b && STAGES.includes(b[1])) {
      out.expectation = { version, outcome: BLOCKED, stage: b[1], reason: b[2].trim() };
      continue;
    }
    out.malformed.push(line);
  }
  return out;
}

// The comparison, and the whole both-ways property of this probe. Returns
// { ok, headline, detail } — `ok` false is the red.
export function compare(expectation, measured) {
  if (!expectation) {
    return { ok: false, headline: 'NO RECORDED EXPECTATION',
      detail: 'UPSTREAM_PIN carries no `carve-probe <version> …` line, so there is nothing '
        + 'to compare this run against. A probe with no record cannot report a CHANGE, '
        + `which is its only product. Measured: ${describe(measured)}` };
  }
  if (measured.outcome === CARVES && expectation.outcome === CARVES) {
    return { ok: true, headline: 'carves, as recorded',
      detail: 'newer-than-pin upstream still carves, merges and compiles.' };
  }
  if (measured.outcome === CARVES) {
    return { ok: false, headline: 'IT STARTED WORKING — ABSORB NOW',
      detail: `UPSTREAM_PIN records ${describeExpectation(expectation)}, and this run `
        + 'carved, merged and compiled it. The reason the pin exists no longer holds: '
        + 'absorb, then re-record the outcome on UPSTREAM_PIN\'s carve-probe line.' };
  }
  if (expectation.outcome === CARVES) {
    return { ok: false, headline: 'IT STOPPED WORKING — a fresh blocker',
      detail: `UPSTREAM_PIN records that newer-than-pin upstream carves (measured at `
        + `${expectation.version}). It does not any more:\n${describe(measured)}` };
  }
  if (measured.stage !== expectation.stage) {
    return { ok: false, headline: 'BLOCKED SOMEWHERE NEW — the recorded reason is stale',
      detail: `UPSTREAM_PIN records a failure at the \`${expectation.stage}\` stage; this `
        + `run failed at \`${measured.stage}\`:\n${describe(measured)}` };
  }
  if (!measured.message.includes(expectation.reason)) {
    return { ok: false, headline: 'BLOCKED DIFFERENTLY — the recorded reason is stale',
      detail: `UPSTREAM_PIN records \`${expectation.reason}\` at the `
        + `\`${expectation.stage}\` stage; this run failed at the same stage for another `
        + `reason:\n${describe(measured)}` };
  }
  return { ok: true, headline: 'still blocked, for the recorded reason',
    detail: `${describeExpectation(expectation)} — unchanged.\n${describe(measured)}` };
}

function describeExpectation(e) {
  return e.outcome === CARVES
    ? `that newer-than-pin upstream carves (measured at ${e.version})`
    : `a \`${e.stage}\` failure containing "${e.reason}" (measured at ${e.version})`;
}

function describe(m) {
  if (m.outcome === CARVES) return `  carves (${m.modules} modules compiled)`;
  return `  blocked at \`${m.stage}\`:\n`
    + String(m.message).split('\n').map((l) => `    ${l}`).join('\n');
}

// ---- the measurement -----------------------------------------------------------------
//
// One real staging call, then one real compile pass, and nothing between them that could
// turn a failure into a success. `skip` is returned (never thrown) so the caller can print
// a named precondition rather than a stack.
export function measure({ provider, version, engine, work, log = () => {} }) {
  if (!provider || !fs.existsSync(provider)) {
    return { skip: `no provider binary to carve (${provider || '<none given>'}) — the `
      + 'upstream install did not produce one, so this run asked upstream nothing' };
  }
  if (!engine || !fs.existsSync(engine)) {
    return { skip: `no tjs engine (${engine || '<none given>'}) — the SCC merge needs one `
      + 'to report each module\'s top-level bindings, so nothing here could have run' };
  }

  const require = createRequire(import.meta.url);
  const { extractIfNeeded } = require(path.join(REPO, 'libexec', 'clode-extract.cjs'));
  const libexec = path.join(REPO, 'libexec');
  const cacheDir = path.join(work, version);
  fs.mkdirSync(cacheDir, { recursive: true });

  // STAGE: carve + the SCC merge, through the entry point `clode build` itself calls.
  // CLODE_TJS is how clode-extract's resolveEngine is told which engine to ask.
  const priorTjs = process.env.CLODE_TJS;
  process.env.CLODE_TJS = engine;
  try {
    extractIfNeeded({ bin: provider, cacheDir, libexec, verbose: true, log });
  } catch (e) {
    return { outcome: BLOCKED, stage: 'stage', message: String(e && e.message ? e.message : e) };
  } finally {
    if (priorTjs === undefined) delete process.env.CLODE_TJS;
    else process.env.CLODE_TJS = priorTjs;
  }

  const graph = path.join(cacheDir, 'graph.json');
  if (!fs.existsSync(graph)) {
    return { skip: 'this provider stages as a single cli.cjs, not a module graph — the '
      + 'SCC merge this probe exists to exercise does not run on that shape' };
  }

  return compileStagedGraph({ graph, engine, work });
}

// COMPILE: every staged module, in the staged order, under the real engine. This is the
// step the recorded blocker names, and it is where a merged module that is not parseable
// shows up. libexec/graph-meta.js already does exactly this walk (it has to: compile()
// resolves imports as it goes, so the whole order must be compiled to answer about any of
// it), so it is REUSED with an empty want-list rather than reimplemented here — one
// implementation of "compile the staged graph", exercised on every build.
//
// Its own seam, so a test can feed it a staged graph containing a module the engine
// cannot parse and watch the `compile` verdict come out — without a 200MB provider and
// without this file growing a second, untested copy of the classification.
export function compileStagedGraph({ graph, engine, work, libexec = path.join(REPO, 'libexec') }) {
  const names = path.join(work, 'want.json');
  const metaOut = path.join(work, 'meta.json');
  fs.writeFileSync(names, '[]');
  const r = spawnSync(engine, ['run', path.join(libexec, 'graph-meta.js'), graph, names, metaOut],
    { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.error) {
    return { skip: `the engine could not be run (${r.error.message}) — this run asked `
      + 'upstream nothing' };
  }
  if (r.status !== 0) {
    return { outcome: BLOCKED, stage: 'compile', message: (r.stderr || r.stdout || '').trim() };
  }
  const doc = JSON.parse(fs.readFileSync(graph, 'utf8'));
  return { outcome: CARVES, modules: doc.order.length, merge: doc.sccMerge || null };
}

// ---- CLI -----------------------------------------------------------------------------

function parseArgv(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
    if (!m) continue;
    out[m[1]] = m[2] !== undefined ? m[2] : argv[++i];
  }
  return out;
}

export function main(argv) {
  const a = parseArgv(argv);
  const pinText = fs.readFileSync(path.join(REPO, 'UPSTREAM_PIN'), 'utf8');
  const { pin, expectation, malformed } = parsePinFile(pinText);
  if (malformed.length) {
    process.stderr.write('carve-probe: UPSTREAM_PIN has a carve-probe line this probe cannot '
      + `read, so it cannot know what to compare against:\n  ${malformed.join('\n  ')}\n`
      + `  grammar: carve-probe <version> ${CARVES} | carve-probe <version> ${BLOCKED} `
      + `<${STAGES.join('|')}> <reason>\n`);
    return 1;
  }
  // ABSENT vs EMPTY, and the difference is the whole "did not run" distinction. No
  // --version at all is someone running this by hand wrong, and says so. An EMPTY one is
  // CI telling us `npm view` could not answer — a precondition that failed, which must
  // read as a named skip and not as a verdict about upstream.
  if (a.version === undefined) {
    process.stderr.write('usage: carve-probe.mjs --provider P --version V --engine E\n');
    return 2;
  }
  const version = String(a.version);
  if (!version) {
    process.stdout.write('carve-probe: SKIPPED — upstream\'s current version could not be '
      + 'determined (no answer from the registry), so this run measured NOTHING. Do not '
      + 'read it as a green.\n');
    return 0;
  }

  process.stdout.write(`carve-probe: UPSTREAM_PIN is ${pin || '(unreadable)'}; this run carves ${version}\n`);
  if (pin && cmpVersions(version, pin) <= 0) {
    process.stdout.write(`carve-probe: SKIPPED — ${version} is not newer than the pin `
      + `(${pin}). This probe's question ("can we carve newer than the pin yet?") has no\n`
      + '  subject today; it is not a statement that anything works.\n');
    return 0;
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-carve-probe-'));
  let measured;
  try {
    measured = measure({ provider: a.provider, version, engine: a.engine, work,
      log: (m) => process.stdout.write(`  ${m}\n`) });
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  if (measured.skip) {
    // A SKIP IS NOT A GREEN, and it says so in the same breath. This is the "the job never
    // reached the build step" half of the BACKLOG shape: infra that reads as "still
    // blocked" is how the day it starts working passes unnoticed.
    process.stdout.write(`carve-probe: SKIPPED — ${measured.skip}.\n`
      + '  NOTHING about upstream was measured by this run. Do not read it as a green.\n');
    return 0;
  }

  const v = compare(expectation, measured);
  process.stdout.write(`carve-probe: ${v.ok ? 'OK' : 'CHANGED'} — ${v.headline}\n${v.detail}\n`);
  if (v.ok && measured.outcome === CARVES) {
    // The green's own disclosure, in the same spirit as scripts/lib/carve-gap-note.mjs:
    // "it carves" is not "we ship it", and the distance is the thing worth restating.
    process.stdout.write(
      `  what this green means: ${version} carves, merges and compiles — and CI still\n`
      + `  stages ${pin}. The pin is now a CHOICE, not a limitation; the gap is ${pin} -> ${version}.\n`
      + '  What it does NOT prove: that a quaude built from it boots, or passes a live turn.\n');
  }
  return v.ok ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.exit(main(process.argv.slice(2)));
}
