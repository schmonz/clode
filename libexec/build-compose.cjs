'use strict';
// build-compose — the orchestrator half of the step protocol. It aggregates plans
// and merges event streams from any number of components, and it DELIBERATELY does
// not know what any component's steps are: adding a step to a component must never
// require editing this file.
//
// It also answers the question a progress display cannot be trusted without: did a
// component actually do what it declared? A display that can silently under-count
// is one that cannot tell you when work went missing — the same shape as the
// zero-is-a-pass defect this project keeps finding in its own guards.
const { parse, PLAN, STARTED, PROGRESSED, FINISHED } = require('./build-report.cjs');

class Composer {
  constructor() { this._steps = []; this._index = new Map(); this._duplicateFinishes = []; }

  // Component and step name are each caller-supplied strings, so no single join
  // char (however exotic) is safe against a collision across the two — a step
  // named "a:b" under component "x:y" must not alias component "x" step "y:a:b".
  // A Map of Maps keys on each string whole, so there is nothing to collide.
  _byName(component) {
    let m = this._index.get(component);
    if (!m) { m = new Map(); this._index.set(component, m); }
    return m;
  }

  ingest(component, line) {
    const rec = parse(line);
    if (!rec) return false;
    if (rec.type === PLAN) {
      const byName = this._byName(component);
      for (const s of rec.steps) {
        if (byName.has(s.name)) continue;              // a re-declared plan is not a new step
        // totalIsUpperBound rides on the step object itself (beyond the brief's declared
        // {component, name, total, done, elapsedMs, state} shape) so a caller building its
        // own display can render "at least N" instead of "N of M" without re-deriving the
        // distinction mismatches() already knows.
        const step = {
          component, name: s.name, total: s.total, done: 0,
          totalIsUpperBound: !!s.totalIsUpperBound, elapsedMs: undefined, state: 'declared',
        };
        byName.set(s.name, step); this._steps.push(step);
      }
      return true;
    }
    const step = this._byName(component).get(rec.name);
    if (!step) return true;                            // an event for an undeclared step: ignore
    if (rec.type === STARTED) step.state = 'running';
    else if (rec.type === PROGRESSED) step.done = rec.done;
    else if (rec.type === FINISHED) {
      // A second FINISHED for an already-finished step is a protocol violation, not a
      // correction: nothing in Reporter.finish() prevents a component (or a retry path)
      // calling it twice, and last-write-wins would let a stray duplicate silently
      // relabel correctly-reported work as a shortfall (or mask a real one). Keep the
      // first report as the truth and surface the duplicate itself as a loud mismatch —
      // which value is "right" is not this orchestrator's call to make silently.
      if (step.state === 'finished') {
        this._duplicateFinishes.push({
          step,
          reason: `${step.component}:${step.name} received a duplicate finish (first reported ${step.done}, duplicate reported ${rec.done}); ignoring the duplicate and keeping the first report`,
        });
        return true;
      }
      if (rec.done !== undefined) step.done = rec.done;
      step.elapsedMs = rec.elapsedMs; step.state = 'finished';
    }
    return true;
  }

  steps() { return this._steps.slice(); }

  totals() {
    let done = 0, total = 0;
    for (const s of this._steps) if (s.total !== undefined) { done += s.done; total += s.total; }
    return { done, total };
  }

  // A declared step that never finished counts too: silence is the failure mode a
  // progress display is least able to notice on its own.
  mismatches() {
    const out = [];
    for (const s of this._steps) {
      if (s.state !== 'finished') {
        out.push({ step: s, reason: `${s.component}:${s.name} declared but never finished (state ${s.state})` });
        continue;
      }
      if (s.total === undefined) continue;
      if (s.done > s.total) {
        out.push({ step: s, reason: `${s.component}:${s.name} reported ${s.done} of a declared ${s.total} — exceeding a total is wrong even for an upper bound` });
      } else if (s.done < s.total && !s.totalIsUpperBound) {
        out.push({ step: s, reason: `${s.component}:${s.name} reported ${s.done} but declared ${s.total}; declare totalIsUpperBound if the count is legitimately dynamic` });
      }
    }
    out.push(...this._duplicateFinishes);
    return out;
  }
}

module.exports = { Composer };
