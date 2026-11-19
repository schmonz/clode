'use strict';
// Regenerate known-divergences.json for ONE platform from a measured run:
//   CLODE_SHIM_DIFF_DUMP=/tmp/d.json node --test test/node-shim-differential.test.cjs
//   node test/shim-differential/freeze.cjs /tmp/d.json
// The dump's platform is removed from every listed pair, then every pair of the dump is added under the
// cause known.cjs's patterns assign it. A pair no pattern claims is REFUSED (exit 1): it is a new
// divergence, to be fixed or given a cause (and a BACKLOG line) on purpose. The result is data under
// review: `git diff` shows exactly which fields of which cases became tolerated or stopped being.
const fs = require('node:fs');
const path = require('node:path');
const known = require('./known.cjs');

const FILE = path.join(__dirname, 'known-divergences.json');
const dump = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const plat = dump.platform;
const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
for (const id of Object.keys(data)) {
  for (const leaf of Object.keys(data[id])) {
    data[id][leaf].on = data[id][leaf].on.filter((p) => p !== plat);
    if (!data[id][leaf].on.length) delete data[id][leaf];
  }
  if (!Object.keys(data[id]).length) delete data[id];
}
const refused = [];
for (const [id, lines] of Object.entries(dump.divergences)) {
  const api = dump.apis[id];
  for (const line of lines) {
    const leaf = known.leafOf(line);
    const cause = leaf && known.classify(api, id, leaf);
    if (!cause) { refused.push(`${id}  ${line.slice(0, 200)}`); continue; }
    data[id] = data[id] || {};
    const k = data[id][leaf] || (data[id][leaf] = { cause, on: [] });
    if (k.cause !== cause) refused.push(`${id}  ${leaf}: listed as ${k.cause}, classified ${cause}`);
    if (!k.on.includes(plat)) k.on.push(plat);
    k.on.sort();
  }
}
if (refused.length) {
  console.error(`freeze: ${refused.length} divergence(s) no cause claims; nothing written:\n  ${refused.join('\n  ')}`);
  process.exit(1);
}
const sorted = {};
for (const id of Object.keys(data).sort()) {
  sorted[id] = {};
  for (const leaf of Object.keys(data[id]).sort()) sorted[id][leaf] = data[id][leaf];
}
fs.writeFileSync(FILE, `${JSON.stringify(sorted, null, 1)}\n`);
const n = Object.values(sorted).reduce((a, l) => a + Object.keys(l).length, 0);
console.log(`freeze: ${plat}: ${Object.keys(dump.divergences).length} diverging cases; ${Object.keys(sorted).length} cases, ${n} fields listed in all`);
