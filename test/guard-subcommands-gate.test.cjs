'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SUBCOMMANDS } = require('../libexec/update-guard.cjs');

function newestBundle() {
  const root = path.join(os.homedir(), '.cache', 'clode');
  if (!fs.existsSync(root)) return null;
  const cands = fs.readdirSync(root)
    .map((d) => path.join(root, d, 'cli.cjs'))
    .filter((p) => fs.existsSync(p))
    .map((p) => ({ p, m: fs.statSync(p).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  return cands.length ? cands[0].p : null;
}

function bundleSubcommands(src) {
  const names = new Set();
  for (const m of src.matchAll(/\.command\(["']([a-z][a-z0-9-]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/\.alias\(["']([a-z][a-z0-9-]*)["']\)/g)) names.add(m[1]);
  for (const m of src.matchAll(/\.aliases\(\[([^\]]*)\]/g)) {
    for (const a of m[1].matchAll(/["']([a-z][a-z0-9-]*)["']/g)) names.add(a[1]);
  }
  return names;
}

test('SUBCOMMANDS matches the bundle-registered command + alias names', (t) => {
  const bundle = newestBundle();
  if (!bundle) { t.skip('no cached bundle under ~/.cache/clode/*/cli.cjs'); return; }
  const got = bundleSubcommands(fs.readFileSync(bundle, 'utf8'));
  const missing = [...got].filter((n) => !SUBCOMMANDS.has(n)).sort();
  const extra = [...SUBCOMMANDS].filter((n) => !got.has(n)).sort();
  assert.deepStrictEqual(
    { missing, extra }, { missing: [], extra: [] },
    `SUBCOMMANDS drifted from ${path.basename(path.dirname(bundle))}:\n`
    + `  add to SUBCOMMANDS: ${JSON.stringify(missing)}\n`
    + `  remove from SUBCOMMANDS: ${JSON.stringify(extra)}`);
});
