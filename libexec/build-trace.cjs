'use strict';
// build-trace — the durable record that turns "the build got slower" from a feeling
// into a diff. One JSON line per build, appended, so a torn write costs one run and
// not the history.
//
// The per-step shape is Chrome-trace ("google-trace") COMPLETE events, borrowed
// rather than invented: free viewers (Perfetto, speedscope, chrome://tracing), and
// it is what ninjatracing emits from a .ninja_log — so if the ENGINE build later
// gains CTest or Ninja timings, both halves of this project speak one language.
const realFs = require('node:fs');
const path = require('node:path');

// ts is NOT a real wall-clock offset today: Composer.steps() (Task 2) carries only
// elapsedMs, not a start timestamp — build-report.cjs's Reporter DOES track a real
// start internally, but threading it through the wire protocol and Composer's step
// shape is a Task 4/5 protocol change, not a Task 3 fix (both of their briefs are
// already written against the current step shape). So this synthesizes a serial
// timeline PER COMPONENT TRACK — accurate only as long as steps on the SAME track
// ran serially (true today: the only components are the builder and the one worker
// it spawns and waits on) — and marks every event with tsSynthetic so a viewer is
// told, not left to infer real overlap from fake serialization. A SHARED accumulator
// across all components would be worse than not tracking ts at all: it would show a
// fake serial order between components that may genuinely run concurrently, which is
// exactly the kind of thing Chrome-trace format was adopted so a real viewer could
// show truthfully.
function traceEvents(steps, meta) {
  const tracks = new Map();       // component -> tid (track identity)
  const cursors = new Map();      // component -> next available ts on ITS track
  return steps.map((s) => {
    if (!tracks.has(s.component)) tracks.set(s.component, tracks.size + 1);
    const dur = (s.elapsedMs || 0) * 1000;           // Chrome trace is MICROseconds
    const ts = cursors.get(s.component) || 0;
    cursors.set(s.component, ts + dur);
    return {
      name: s.name, cat: s.component, ph: 'X',
      pid: 1, tid: tracks.get(s.component),
      ts, dur,
      args: { done: s.done, total: s.total, target: meta && meta.target, tsSynthetic: true },
    };
  });
}

// A run is anything shaped like what appendRun writes: an object carrying a `steps`
// array and a `meta` object. SHARED by both directions on purpose (round-2 fix): the
// review found appendRun validating only meta.interpreter while readRuns enforced the
// full shape, so a caller could write a run (e.g. missing `steps`, or `steps` of the
// wrong type) that landed durably and then came back invisible from every read —
// indistinguishable from hand-corruption, with no error at either end to say so. One
// predicate used on both sides is what keeps the write and read contracts from
// drifting apart again; `readRuns` also uses it to recognize valid-but-foreign JSON on
// a line (a hand-edit, a different tool's line, `null`, a bare number), which is real
// content that parsed fine and must not be mistaken for storage damage.
function isRunShaped(x) {
  return !!x && typeof x === 'object' && !Array.isArray(x)
    && Array.isArray(x.steps) && !!x.meta && typeof x.meta === 'object' && !Array.isArray(x.meta);
}

// A run without its interpreter recorded is not a promise anyone can trust later —
// Phase 1 lost an afternoon to two agents disagreeing about a verdict because neither
// had asked which `node` produced it. Refusing here (rather than merely documenting
// the field as required) is what keeps that guarantee real: nothing durable gets
// written that cannot later be explained. And refusing on shape (isRunShaped) BEFORE
// that, mirroring exactly what readRuns will demand back, closes the round-2 gap: a
// run appendRun accepts must never come back unreadable.
function appendRun(logPath, run, fsm = realFs) {
  if (!isRunShaped(run)) {
    throw new Error('build-trace: refusing to record a run — it must be an object with '
      + 'a `steps` array and a `meta` object (readRuns will refuse anything less)');
  }
  const interpreter = run.meta.interpreter;
  if (typeof interpreter !== 'string' || interpreter.trim() === '') {
    throw new Error('build-trace: refusing to record a run without meta.interpreter — '
      + 'a timing without its interpreter is not comparable across machines');
  }
  fsm.mkdirSync(path.dirname(logPath), { recursive: true });
  fsm.appendFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), ...run }) + '\n');
}

// onSkip(reason, line) lets a caller (and this file's own tests) tell a torn write
// apart from a merely-foreign one — both are silently excluded from the returned
// array (a corrupt log must not crash a diff tool), but they are different failure
// modes with different remedies, so collapsing them into one blanket catch would hide
// which one actually happened.
function readRuns(logPath, fsm = realFs, onSkip = () => {}) {
  let text;
  try { text = fsm.readFileSync(logPath, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    let parsed;
    try { parsed = JSON.parse(line); }
    catch { onSkip('torn', line); continue; }        // not valid JSON at all: a killed-mid-write line
    if (!isRunShaped(parsed)) { onSkip('malformed', line); continue; }   // valid JSON, wrong shape
    out.push(parsed);
  }
  return out;
}

module.exports = { traceEvents, appendRun, readRuns };
