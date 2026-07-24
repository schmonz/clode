import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveRuntimes, presentRuntimes } = require('./lib/runtimes.cjs');
const { summarize, ratio, classify } = require('./lib/stats.cjs');
const { measure } = require('./lib/measure.cjs');
const { makeWorkspace } = require('./lib/workspace.cjs');
const { loadScenarios } = require('./lib/scenario.cjs');
const { startMockAnthropic } = require('../test/mock-anthropic-helper.cjs');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.dirname(HERE);

function arg(flag, dflt) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : dflt;
}
const REPS = Number(arg('--reps', '5'));
const ONLY = arg('--only', null);
const GATE = process.argv.includes('--gate');

async function runOne(runtime, scenario) {
  const ws = makeWorkspace({ baseUrl: 'http://127.0.0.1:0' });
  await scenario.setup(ws.dir);
  const server = await startMockAnthropic({ respond: scenario.mock.respond });
  ws.env.ANTHROPIC_BASE_URL = server.url;
  const samples = [];
  let lastExit = 0;
  let timedOut = false;
  let peakRss = null;
  try {
    for (let i = 0; i < REPS; i++) {
      const m = await measure({
        bin: runtime.bin,
        args: ['-p', scenario.prompt],
        cwd: ws.dir,
        env: ws.env,
        timeoutMs: scenario.timeoutMs || 120000,
      });
      lastExit = m.exitCode;
      timedOut = timedOut || m.timedOut;
      peakRss = m.peakRssBytes;
      if (i > 0) samples.push(m.wallMs); // drop warmup rep
    }
  } finally {
    await server.close();
    ws.cleanup();
  }
  return { samples, lastExit, timedOut, peakRss };
}

async function main() {
  const buildDir = path.join(REPO, 'build');
  const runtimes = presentRuntimes(resolveRuntimes({ env: process.env, buildDir }));
  if (runtimes.length === 0) {
    console.error('No runtimes found. Set QUAUDE_BIN / NAUDE_BIN / CLAUDE_BIN or build into ./build.');
    process.exit(2);
  }
  let scenarios = loadScenarios(path.join(HERE, 'scenarios'));
  if (ONLY) scenarios = scenarios.filter((s) => s.name === ONLY);

  const results = {};
  for (const scn of scenarios) {
    results[scn.name] = {};
    for (const rt of runtimes) {
      process.stderr.write(`• ${rt.name} / ${scn.name} ...`);
      const r = await runOne(rt, scn);
      const stat = r.samples.length ? summarize(r.samples) : null;
      results[scn.name][rt.name] = { ...r, stat };
      process.stderr.write(r.timedOut ? ' TIMEOUT\n' : ` ${stat ? stat.median.toFixed(0) + 'ms' : 'n/a'}\n`);
    }
  }

  // Report table. quaude is the product; its absolute wall + peak RSS are the
  // headline. `claude` (native, optimized) is the CEILING to close on. `naude`
  // (same bundle under V8) is only the interpreter-tax ORACLE — it drives the
  // class (WATCH/HOT ≈ QuickJS hotspot vs a JIT of the SAME code), not the goal.
  const mb = (b) => (typeof b === 'number' ? (b / 1048576).toFixed(0) + 'M' : '-');
  console.log('\nscenario                  quaude      RSS    claude  q/claude   tax(q/naude)');
  console.log('------------------------  --------  -------  --------  --------  ------------');
  for (const [name, byRt] of Object.entries(results)) {
    const q = byRt.quaude?.stat?.median;
    const c = byRt.claude?.stat?.median;
    const n = byRt.naude?.stat?.median;
    const qc = q && c ? ratio(q, c) : null;
    const qn = q && n ? ratio(q, n) : null;
    const tax = byRt.quaude?.timedOut ? 'TIMEOUT' : qn ? `${qn.toFixed(1)}× ${classify(qn)}` : '-';
    console.log(
      name.padEnd(24),
      (q ? q.toFixed(0) + 'ms' : '-').padStart(8),
      mb(byRt.quaude?.peakRss).padStart(7),
      (c ? c.toFixed(0) + 'ms' : '-').padStart(8),
      (qc ? qc.toFixed(1) + '×' : '-').padStart(8),
      ' ' + tax,
    );
  }

  const outDir = path.join(HERE, 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(outDir, `${stamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify(results, null, 2));
  console.log(`\nWrote ${outFile}`);

  if (GATE) {
    const { checkRegressions } = require('./lib/gate.cjs');
    const baseline = JSON.parse(fs.readFileSync(path.join(HERE, 'baseline.json'), 'utf8'));
    const current = {};
    for (const [name, byRt] of Object.entries(results)) {
      if (byRt.quaude?.stat) current[name] = byRt.quaude.stat.median;
    }
    const { ok, regressions } = checkRegressions({ baseline, current, tolerance: 1.25 });
    if (!ok) {
      console.error('\nREGRESSIONS:');
      for (const reg of regressions) {
        console.error(`  ${reg.name}: ${reg.baselineMs}ms -> ${reg.currentMs}ms (${reg.factor.toFixed(2)}×)`);
      }
      process.exit(1);
    }
    console.log('Gate: no regressions beyond 1.25×.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
