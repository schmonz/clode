'use strict';
// The build gate inside `scripts/lib/reset-patch.cjs`: the reset-invisibility test build
// (test/fidelity/reset-invisibility.test.cjs) lowers the two CellSegmenter pool-reset
// thresholds it FINDS in the carve by structure, and REFUSES (throws, naming the site) when a
// site is not there exactly once. That refusal is the only thing standing between an upstream
// rename and a test build that silently patched nothing, so it gets a control of its own.
//
// WHY HERE AS WELL AS IN THE LIVE GATE. The live gate needs a pty, live render and two
// builds, so it runs serially, off the concurrent suite. This guard needs only the carve
// (extract-claude-js, about 2 s), so it runs everywhere the provider does: the day the pin
// moves to a bundle whose reset sites moved, the ordinary suite says so, naming the site.
//
// WHY A GUARD. reset-patch.cjs derives a verdict from bytes (its structural regexes
// `.test`/`matchAll` the carve) and refuses (throws), so the production-gate sweep
// (test/guards-population.cjs) counts it gate-shaped (ruling R12: controlled here, never
// excluded). The literal relative require below is load-bearing for that sweep, which derives
// "which guard controls this production gate" from that string.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert');
const { defineGuard, guardTests } = require('../guard.cjs');
const R = require('../../scripts/lib/reset-patch.cjs');
const { decodeGraphRunner } = require('../../libexec/inspect-claude-bundle.cjs');

const REPO = path.resolve(__dirname, '..', '..');
const EXTRACT = path.join(REPO, 'libexec', 'extract-claude-js.cjs');

// The carve of CLODE_PROVIDER_BIN, decoded the way inspect-claude-bundle reads it -- the same
// pattern as paint-probe-gates.test.cjs's readCarve, a separate copy per guard file by this
// repo's convention (each build-gates file resolves its own inputs).
function readCarve() {
  const bin = process.env.CLODE_PROVIDER_BIN;
  if (!bin || !fs.existsSync(bin)) return { skip: 'no CLODE_PROVIDER_BIN (point it at a real claude binary to run this gate)' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-patch-gate-'));
  try {
    const cli = path.join(dir, 'cli.cjs');
    const ex = spawnSync(process.execPath, [EXTRACT, bin, cli], { encoding: 'utf8' });
    if (ex.status !== 0) throw new Error(`extract-claude-js could not carve ${bin}: ${(ex.stderr || '').slice(0, 400)}`);
    const decoded = decodeGraphRunner(cli);
    const text = decoded !== null ? decoded : fs.readFileSync(cli, 'latin1');
    if (!R.hasCellSegmenterConsumer(text)) return { skip: `${R.NO_CONSUMER} (the carve of ${bin})` };
    return { text, what: `the carve of ${bin}` };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// `examined` counts the reset sites found exactly once, so a site upstream renamed, moved into
// a second copy or dropped leaves the count under the floor of 2: BROKEN, naming it.
function scanSites({ text, what }) {
  const s = R.findResetSites(text);
  const findings = [];
  let examined = 0;
  for (const site of Object.keys(R.SITES)) {
    if (s.counts[site] === 1) examined++;
    else findings.push(`${R.SITES[site].what} occurs ${s.counts[site]} time(s) in ${what}, not exactly once`);
  }
  try {
    const p = R.patchResetThresholds(text);
    const after = R.findResetSites(p.source);
    if (after.segmentEntry !== p.patched[0] || after.generation !== p.patched[1]) {
      findings.push(`the patched ${what} does not read back as the patched sites`);
    }
  } catch (e) {
    findings.push(e.message);
  }
  return { findings, examined, note: `${what}: ${examined} of ${Object.keys(R.SITES).length} reset sites found exactly once` };
}

// The two sites as upstream 2.1.278 spells them (graph.json, /$bunfs/root/chunk-rp2p2mxd.js),
// inside enough of the wrapper to read as the carve does, plus the consumer it belongs to.
const CARVE_2_1_278 = 'function vs(n){return new Bun.ant.CellSegmenter({substitute:n})}'
  + 'var vC=2048,Cf=16384;class Mf{segment(n,s){if(this.sgrKeys.length>Cf||this.uris.length>Cf||'
  + 'this.graphemes.length>4*Cf)this.resetNative();this.refreshGenerations();return this.native.segment(n)}'
  + 'refreshGenerations(){if(this.styleGeneration=this.stylePool.generation,this.sgrKeys.length>vC)'
  + 'this.resetNative();else this.styleIds.fill(0)}resetNative(){this.native=vs(qot)}}';

guardTests(defineGuard({
  name: 'reset-patch-sites',
  floor: 2,
  read: readCarve,
  scan: scanSites,
  // Upstream renames the generation branch's reset: the patch must refuse, not patch one site.
  control: () => ({ text: CARVE_2_1_278.replace('vC)this.resetNative()', 'vC)this.rebuildNative()'), what: 'synthetic control' }),
}));

test('the sites scan passes the 2.1.278 spelling and names each way a site goes missing', () => {
  const run = (text) => scanSites({ text, what: 'x' });
  assert.deepStrictEqual(run(CARVE_2_1_278), { findings: [], examined: 2, note: 'x: 2 of 2 reset sites found exactly once' });
  const renamed = run(CARVE_2_1_278.replace('vC)this.resetNative()', 'vC)this.rebuildNative()'));
  assert.strictEqual(renamed.examined, 1);
  assert.match(renamed.findings[0], /refreshGenerations reset condition .* occurs 0 time\(s\) in x, not exactly once/);
  assert.match(renamed.findings[1], /^reset-patch: .* occurs 0 time\(s\), not exactly once -- upstream renamed or restructured it/);
  const twice = run(CARVE_2_1_278 + CARVE_2_1_278);
  assert.strictEqual(twice.examined, 0);
  assert.strictEqual(twice.findings.length, 3, 'both sites twice, and the refusal');
});
