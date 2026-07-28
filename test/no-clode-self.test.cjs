// test/no-clode-self.test.cjs — the update path no longer depends on CLODE_SELF.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

// Pattern covers the whole retired surface: CLODE_SELF, the --clode-internal-update
// callback verb, the deleted clode-target-update module, AND the targetUpdate
// rebuild function. `targetUpdate[^C]` matches a reintroduced targetUpdate(...) call
// but NOT the SURVIVING notify-only check `targetUpdateCheck` / `target-update-check.cjs`
// (the [^C] excludes the "Check" suffix; `clode-target-update` has the clode- prefix
// that `target-update-check.cjs` lacks). So a rebuild callback can't sneak back
// without also naming CLODE_SELF.
//
// Pure-Node walk (was `grep -rlE`): the shell-out assumed POSIX grep and failed on
// Windows CI. Walking + scanning in Node runs the retirement gate on every platform.
const RETIRED = /CLODE_SELF|clode-internal-update|clode-target-update|targetUpdate[^C]/;

function walk(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else if (ent.isFile()) out.push(p);
  }
  return out;
}

test('retired CLODE_SELF/targetUpdate rebuild surface is gone from libexec/scripts/bin', () => {
  const repo = path.resolve(__dirname, '..');
  const hits = [];
  for (const d of ['libexec', 'scripts', 'bin']) {
    const abs = path.join(repo, d);
    if (!fs.existsSync(abs)) continue;
    for (const f of walk(abs)) {
      let text;
      try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
      if (RETIRED.test(text)) hits.push(path.relative(repo, f));
    }
  }
  assert.deepStrictEqual(hits, [], `still references retired rebuild machinery:\n${hits.join('\n')}`);
});
