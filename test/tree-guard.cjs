'use strict';
// tree-guard — a WALKING snapshot of a directory tree, used to prove that a build
// wrote nothing into the checkout. Deliberately different from hermetic-guard's
// original shallow snapshot (statSync(mtimeMs) on each NAMED path), which sees a
// top-level creation but is blind to a modification three levels down — the exact
// "a guard that cannot fail" shape the phase-5 backlog entry is about.
// Pure node stdlib; fs injected for testability.
// The sentinel key '.' records the root's state when the root itself is unreadable,
// so an unreadable root is distinguishable from a missing root or empty directory.
const realFs = require('node:fs');
const path = require('node:path');

function walk(root, { ignore = [], fsm = realFs } = {}) {
  const out = new Map();
  // A trailing '*' means "starts with" (no separator boundary required) — the one
  // wildcard shape TREE_ALLOW needs (Finding 3: 'build/clode-*' names a whole FAMILY
  // of artifact dirs, one per host/version, not a single fixed path) without pulling
  // in a real glob engine for one character. Anything without a trailing '*' keeps
  // the exact/prefix-at-a-path-boundary match this already had.
  const skip = ignore.map((p) => {
    const wildcard = p.endsWith('*');
    let normalized = path.normalize(wildcard ? p.slice(0, -1) : p);
    while (normalized.endsWith(path.sep)) {
      normalized = normalized.slice(0, -path.sep.length);
    }
    return { normalized, wildcard };
  });
  const visit = (abs, rel) => {
    let entries;
    try { entries = fsm.readdirSync(abs, { withFileTypes: true }); }
    catch (e) {
      // Record the directory itself as unreadable, don't recurse
      out.set(rel || '.', `UNREADABLE|${e && e.code}`);
      return;
    }
    for (const e of entries) {
      const childRel = rel ? path.join(rel, e.name) : e.name;
      if (skip.some(({ normalized: s, wildcard }) => childRel === s || childRel.startsWith(s + path.sep)
        || (wildcard && childRel.startsWith(s)))) continue;
      const childAbs = path.join(abs, e.name);
      if (e.isDirectory()) { visit(childAbs, childRel); continue; }
      let st;
      try { st = fsm.lstatSync(childAbs); } catch (err) {
        out.set(childRel, `UNREADABLE|${err && err.code}`);
        continue;
      }
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
