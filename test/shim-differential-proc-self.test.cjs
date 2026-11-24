'use strict';
// /proc/self/<entry> describes the READER, and node and quaude are different readers (CI 45381323279: /proc/self/io was
// judged exactly and differed). Every entry a carve literal names is classified in table.cjs PROC_SELF; an 'own' entry is
// judged by type, a 'same' one exactly, and one not classified is a plan finding rather than a guess.
const test = require('node:test');
const assert = require('node:assert');
const { makePlan } = require('./shim-differential/plan.cjs');
const T = require('./shim-differential/table.cjs');

const inv = (p) => ({ 'fs.readFileSync': { sites: 1, shapes: [{ args: [{ lit: p }, { lit: 'utf8' }], count: 1 }] } });
const caseFor = (plan, p) => plan.cases.find((c) => c.api === 'fs.readFileSync' && c.args[0] && c.args[0].abs === p);

test("a /proc/self entry that is the reader's own state is judged by type, the CI 45381323279 row", () => {
  const plan = makePlan({ inventory: inv('/proc/self/io'), values: {}, platform: 'linux' });
  assert.strictEqual(caseFor(plan, '/proc/self/io').post, 'typeof');
  assert.deepStrictEqual(plan.findings.filter((f) => f.includes('/proc/self')), []);
});

test('a /proc/self entry that is the same for both sides is still judged exactly', () => {
  const plan = makePlan({ inventory: inv('/proc/self/mountinfo'), values: {}, platform: 'linux' });
  assert.strictEqual(caseFor(plan, '/proc/self/mountinfo').post, T.DRIVERS['fs.readFileSync'].post);
});

test('an unclassified /proc/self entry is a plan finding naming it', () => {
  const plan = makePlan({ inventory: inv('/proc/self/oom_score'), values: {}, platform: 'linux' });
  assert.ok(plan.findings.some((f) => f.includes('/proc/self/oom_score') && f.includes('PROC_SELF')), plan.findings.join('\n'));
});

// The same rule for every other absolute path (table.cjs ABS_PATHS): a path whose answer moves between two reads is
// judged by type, and a path nobody has classified is a finding, not an exact comparison that happens to pass today.
test('every other absolute path is classified: volatile by type, unclassified a finding', () => {
  const vol = makePlan({ inventory: inv('/proc/stat'), values: {}, platform: 'linux' });
  assert.strictEqual(caseFor(vol, '/proc/stat').post, 'typeof');
  const none = makePlan({ inventory: inv('/proc/uptime'), values: {}, platform: 'linux' });
  assert.ok(none.findings.some((f) => f.includes('/proc/uptime') && f.includes('ABS_PATHS')), none.findings.join('\n'));
});
