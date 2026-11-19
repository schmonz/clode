'use strict';
// PURE: three runs' results -> per-case divergences. A result is flattened to leaves (`r.error.code`,
// `r.Stats.ino`, `after.new.mode`); a leaf that differs between the oracle's two runs is unjudgeable
// and named, never compared; every other leaf must be node's.
function flatten(v, prefix = '', out = {}) {
  if (v !== null && typeof v === 'object') {
    const keys = Object.keys(v);
    if (!keys.length) out[prefix] = Array.isArray(v) ? '[]' : '{}';
    for (const k of keys) flatten(v[k], prefix ? `${prefix}.${k}` : k, out);
  } else {
    out[prefix] = v;
  }
  return out;
}

const brief = (x) => {
  const s = x === undefined ? '(absent)' : JSON.stringify(x);
  return s.length > 160 ? `${s.slice(0, 157)}...` : s;
};

// -> { divergences: { id: [leaf lines] }, unjudgeable: { id: [leaves] }, compared, missing: [ids] }
function compareRuns({ cases, node1, ours, node2 }) {
  const divergences = {};
  const unjudgeable = {};
  const missing = [];
  let compared = 0;
  for (const c of cases) {
    const a = node1[c.id];
    const b = ours[c.id];
    const a2 = node2[c.id];
    if (!a || !a2) { missing.push(`${c.id}: the oracle wrote no result`); continue; }
    if (!b) { (divergences[c.id] = divergences[c.id] || []).push('quaude wrote no result (the executor died before or at this case)'); continue; }
    compared++;
    const fa = flatten({ r: a.r, after: a.after });
    const fa2 = flatten({ r: a2.r, after: a2.after });
    const fb = flatten({ r: b.r, after: b.after });
    const lines = [];
    for (const k of new Set([...Object.keys(fa), ...Object.keys(fb)])) {
      if (fa[k] !== fa2[k] || !(k in fa) !== !(k in fa2)) { (unjudgeable[c.id] = unjudgeable[c.id] || []).push(k); continue; }
      if (fa[k] !== fb[k] || (k in fa) !== (k in fb)) lines.push(`${k}: node ${brief(fa[k])}, quaude ${brief(fb[k])}`);
    }
    if (lines.length) divergences[c.id] = lines;
  }
  return { divergences, unjudgeable, compared, missing };
}

module.exports = { flatten, compareRuns };
