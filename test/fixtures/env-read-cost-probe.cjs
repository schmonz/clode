'use strict';
// Run unchanged under host node and under tjs + node-shim (test/node-shim-env-read-cost.test.cjs). What process.env
// answers for a set, an empty and an unset name, and what a read of an UNSET name costs relative to a read of a SET one
// in this same process (a ratio, so the load the box is under divides out), at a shallow and a deep stack.
const N = Number(process.env.PROBE_READS || 20000);
const SET = 'ENV_READ_COST_SET', EMPTY = 'ENV_READ_COST_EMPTY', UNSET = 'ENV_READ_COST_NEVER_SET_ANYWHERE';

function deep(n, f) { return n ? deep(n - 1, f) : f(); }
function perRead(name) {
  let c = 0;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) if (process.env[name] !== undefined) c++;
  return { ns: Number(process.hrtime.bigint() - t0) / N, c };
}
function ratio(depth) {
  return deep(depth, () => {
    let best = Infinity;
    // the best of five, each a fresh pair: a scheduler hiccup lands on one pair, not on the verdict
    for (let k = 0; k < 5; k++) {
      const hit = perRead(SET), miss = perRead(UNSET);
      best = Math.min(best, miss.ns / Math.max(hit.ns, 1));
    }
    return Math.round(best * 100) / 100;
  });
}

const answers = {
  set: process.env[SET], empty: process.env[EMPTY], unset: process.env[UNSET],
  'in set': SET in process.env, 'in empty': EMPTY in process.env, 'in unset': UNSET in process.env,
  'hasOwn unset': Object.prototype.hasOwnProperty.call(process.env, UNSET) === true ? 'true' : 'not true',
  'symbol read': process.env[Symbol('x')],
};
process.env[UNSET + '_W'] = 7;
answers['written then read'] = process.env[UNSET + '_W'];
delete process.env[UNSET + '_W'];
answers['deleted then read'] = process.env[UNSET + '_W'];
answers['deleted then in'] = (UNSET + '_W') in process.env;
process.stdout.write(JSON.stringify({ answers, ratio: { shallow: ratio(0), deep: ratio(40) } }));
