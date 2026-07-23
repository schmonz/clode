import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fs = require('node:fs');
const path = require('node:path');

export function auditRows(text, exists = (p) => fs.existsSync(p)) {
  const guarded = [], gaps = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\|\s*([A-I]\d+)\s*\|(.*)$/);
    if (!m) continue;
    const cells = m[2].split('|').map((c) => c.trim());
    const [action, , , testRef] = cells;      // action, expected, axes, test
    if (!/^→/.test(action)) continue;          // only regression rows must be guarded
    if (testRef === 'NEW' || !exists(testRef)) gaps.push({ id: m[1], test: testRef });
    else guarded.push(m[1]);
  }
  return { guarded, gaps };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
  const text = fs.readFileSync(path.join(REPO, 'test/fidelity/RECIPE.md'), 'utf8');
  const r = auditRows(text, (p) => fs.existsSync(path.join(REPO, p)));
  console.log(`guarded: ${r.guarded.length}; gaps: ${r.gaps.length}`);
  for (const g of r.gaps) console.log(`  GAP ${g.id} -> ${g.test}`);
  if (r.gaps.length) process.exit(1);
}
