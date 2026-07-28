'use strict';
// The naude ASSEMBLER runs as loose scripts under a fetched node inside a fused
// clode-native (NO scripts/ dir of its own) — libexec/quaude-fuse.js carries an
// explicit list of `scripts/*` members and clode-fuse materializes them. If a staged
// script gains a repo-local sibling require that ISN'T in that list, the miss is
// INVISIBLE to a dev-checkout build (the file is right there on disk) and only
// explodes under clode-native as "Cannot find module './X.cjs'" — the node-shim
// oracle's acceptance 4, a ~26s live build. This guard closes that gap statically:
// BFS the relative-require closure of the assembler entry and assert every sibling
// is a carried member. (Regression: platform-tag.cjs gained ./canonical-name.cjs.)
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const SCRIPTS = path.join(REPO, 'scripts');

// The carried member list, parsed from quaude-fuse.js's builder-role loop so the
// test tracks the ACTUAL source (not a hand-copy that could drift the other way).
function carriedScriptMembers() {
  const src = fs.readFileSync(path.join(REPO, 'libexec', 'quaude-fuse.js'), 'utf8');
  // for (const f of ['build-naude.mjs', 'platform-tag.cjs', 'canonical-name.cjs', 'sea-sign.cjs']) {
  const m = src.match(/for \(const f of \[([^\]]*)\]\)\s*\{\s*\n\s*members\.push\(\{ name: `scripts\//);
  assert.ok(m, 'could not locate the naude-assembler member loop in quaude-fuse.js');
  return m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

// Every `require('./x.cjs')` / `import … from './x.mjs'` that resolves to a sibling
// in scripts/ (relative, same dir). Node builtins / bare specifiers / node_modules
// are NOT carried as script members (handled elsewhere), so ignore non-relative.
function relativeSiblingRequires(file) {
  const src = fs.readFileSync(path.join(SCRIPTS, file), 'utf8');
  const out = new Set();
  const re = /(?:require\(|from\s+)['"]\.\/([A-Za-z0-9_.-]+\.(?:c?js|mjs))['"]/g;
  let m;
  while ((m = re.exec(src))) out.add(m[1]);
  return [...out];
}

test('the naude-assembler script members are require-closed (no missing sibling)', () => {
  const members = new Set(carriedScriptMembers());
  assert.ok(members.has('build-naude.mjs'), 'build-naude.mjs must be a carried member');

  // BFS the relative-require closure starting from every carried script.
  const seen = new Set();
  const queue = [...members];
  const missing = [];
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    if (!fs.existsSync(path.join(SCRIPTS, f))) continue; // e.g. not a scripts/ file
    for (const dep of relativeSiblingRequires(f)) {
      if (!members.has(dep)) missing.push(`${f} -> ./${dep} (not a carried member)`);
      if (!seen.has(dep)) queue.push(dep);
    }
  }
  assert.deepStrictEqual(missing, [],
    `naude-assembler require closure has un-carried members (add them to quaude-fuse.js's loop):\n${missing.join('\n')}`);
});
