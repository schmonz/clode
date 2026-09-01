'use strict';
// tree-guard — a WALKING snapshot of a directory tree, used to prove that a build
// wrote nothing into the checkout. Deliberately different from hermetic-guard's
// original shallow snapshot (statSync(mtimeMs) on each NAMED path), which sees a
// top-level creation but is blind to a modification three levels down — the exact
// "a guard that cannot fail" shape the phase-5 backlog entry is about.
// Pure node stdlib; fs injected for testability.
const realFs = require('node:fs');
const path = require('node:path');

function walk(root, { ignore = [], fsm = realFs } = {}) {
  const out = new Map();
  const skip = ignore.map((p) => path.normalize(p));
  const visit = (abs, rel) => {
    let entries;
    try { entries = fsm.readdirSync(abs, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
      const childRel = rel ? path.join(rel, e.name) : e.name;
      if (skip.some((s) => childRel === s || childRel.startsWith(s + path.sep))) continue;
      const childAbs = path.join(abs, e.name);
      if (e.isDirectory()) { visit(childAbs, childRel); continue; }
      let st;
      try { st = fsm.lstatSync(childAbs); } catch { continue; }
      out.set(childRel, `${st.size}|${st.mtimeMs}|${st.mode}`);
    }
  };
  try { if (!fsm.statSync(root).isDirectory()) return out; } catch { return out; }
  visit(root, '');
  return out;
}

function diff(before, after) {
  const changed = [];
  for (const [p, v] of after) {
    if (!before.has(p)) changed.push({ path: p, kind: 'created' });
    else if (before.get(p) !== v) changed.push({ path: p, kind: 'modified' });
  }
  for (const p of before.keys()) if (!after.has(p)) changed.push({ path: p, kind: 'deleted' });
  changed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return changed;
}

module.exports = { walk, diff };
