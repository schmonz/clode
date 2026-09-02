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

function traceEvents(steps, meta) {
  const tracks = new Map();
  let ts = 0;
  return steps.map((s) => {
    if (!tracks.has(s.component)) tracks.set(s.component, tracks.size + 1);
    const ev = {
      name: s.name, cat: s.component, ph: 'X',
      pid: 1, tid: tracks.get(s.component),
      ts, dur: (s.elapsedMs || 0) * 1000,          // Chrome trace is MICROseconds
      args: { done: s.done, total: s.total, target: meta && meta.target },
    };
    ts += (s.elapsedMs || 0) * 1000;
    return ev;
  });
}

function appendRun(logPath, run, fsm = realFs) {
  fsm.mkdirSync(path.dirname(logPath), { recursive: true });
  fsm.appendFileSync(logPath, JSON.stringify({ at: new Date().toISOString(), ...run }) + '\n');
}

function readRuns(logPath, fsm = realFs) {
  let text;
  try { text = fsm.readFileSync(logPath, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    // A torn final line is expected on a killed build; skip it rather than throw and
    // lose every prior run.
    try { out.push(JSON.parse(line)); } catch { /* torn write */ }
  }
  return out;
}

module.exports = { traceEvents, appendRun, readRuns };
