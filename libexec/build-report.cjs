'use strict';
// build-report — the step-reporting protocol. A build COMPONENT declares its own
// steps and reports progress through this; an ORCHESTRATOR composes what it gets
// without knowing what the steps are (see the phase-2 design, §2: "build systems
// that compose have to consist of components that know their own steps").
//
// The same records travel in-process and across the spawnRun seam, which is what
// makes the program boundary a DEPLOYMENT decision rather than an architectural
// one — the parent never needs to know which side a step runs on.
//
// TJS-SAFE ON PURPOSE: libexec/quaude-fuse.js requires this and runs under the
// txiki.js engine, not Node. No `node:` requires may appear in this file.

const PLAN = 'plan';
const STARTED = 'started';
const PROGRESSED = 'progressed';
const FINISHED = 'finished';

// A sentinel prefix, because a child's stdout also carries ordinary human output
// and the parser must be able to say "not mine" rather than guess.
const MARK = '@clode-step ';

function plan(steps) {
  return { type: PLAN, steps: steps.map((s) => {
    const o = { name: String(s.name) };
    if (s.total !== undefined && s.total !== null) o.total = s.total;
    if (s.totalIsUpperBound) o.totalIsUpperBound = true;
    return o;
  }) };
}

// JSON.stringify escapes newlines, so a step name containing one cannot split a
// record across lines. That is load-bearing: the seam is line-delimited.
function serialize(record) { return MARK + JSON.stringify(record); }

function parse(line) {
  if (typeof line !== 'string' || line.indexOf(MARK) !== 0) return null;
  try {
    const r = JSON.parse(line.slice(MARK.length));
    return r && typeof r === 'object' && typeof r.type === 'string' ? r : null;
  } catch { return null; }
}

class Reporter {
  constructor(opts) {
    const o = opts || {};
    this._emit = o.emit;
    this._now = o.now || (() => Date.now());
    this._startedAt = {};
  }
  plan(steps) { this._emit(serialize(plan(steps))); }
  start(name) {
    this._startedAt[name] = this._now();
    this._emit(serialize({ type: STARTED, name }));
  }
  progress(name, done) { this._emit(serialize({ type: PROGRESSED, name, done })); }
  finish(name, done) {
    const rec = { type: FINISHED, name, elapsedMs: this._now() - (this._startedAt[name] || this._now()) };
    if (done !== undefined) rec.done = done;
    this._emit(serialize(rec));
  }
}

module.exports = { PLAN, STARTED, PROGRESSED, FINISHED, MARK, plan, serialize, parse, Reporter };
