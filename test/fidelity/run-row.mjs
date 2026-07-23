import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const oracle = require('../oracle-models.cjs');

// Default capture: run a built binary with the row's args (isolated HOME/store).
function defaultRun(bin, args, opts) {
  return oracle.runBinaryAsync(bin, args, { timeout: 60000, ...opts })
    .then((c) => ({ ...c, files: [] }));
}

export async function runRow(row, engines, opts = {}) {
  const run = opts.run || ((bin) => defaultRun(bin, row.args || [], opts));
  const names = ['claude', 'naude', 'quaude'];
  const perEngine = {};
  for (const n of names) perEngine[n] = await run(engines[n], n);
  const invariant = opts.invariant || ((c) => String(c.status));
  const val = Object.fromEntries(names.map((n) => [n, invariant(perEngine[n])]));
  const ref = val.claude;
  const off = names.filter((n) => val[n] !== ref);
  let verdict = 'agree';
  if (off.length) {
    // localize: quaude off but naude matches Claude -> engine/shim
    const loc = (off.length === 1 && off[0] === 'quaude') ? ' (tjs engine/shim)'
      : off.includes('naude') ? ' (SEA/build)' : '';
    verdict = `diverge:${off.join(',')}${loc}`;
  }
  return { perEngine, verdict };
}
