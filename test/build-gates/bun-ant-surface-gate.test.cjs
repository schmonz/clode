'use strict';
// GUARD: upstream's PRIVATE Bun namespace, member by member.
//
// WHY A SECOND GATE WHEN THERE IS ALREADY AN API-SURFACE GATE. The existing one
// (test/node-shim-api-surface-gate.test.cjs) asks whether every `Bun.<member>` the
// bundle references is accounted for, and `Bun.ant` is accounted for: ACCEPTED
// MISSING, with a written reason. That reason was a MEASUREMENT of ant's members —
// getPeerUid / getPeerPid / memoryPressureLevel, three guarded syscall probes — and
// upstream is free to change them without changing the name the gate watches.
//
// It did. 2.1.278 dropped all three and added `Bun.ant.CellSegmenter`, the native
// grapheme->cell segmenter Ink's screen model is built on, and upstream does NOT
// tolerate that one being absent: the render root throws. A quaude built from
// 2.1.278 boots, writes its alternate-screen escapes, throws on the first frame and
// exits — while the one-level gate stayed green, because "Bun.ant (missing)" was
// still an accurate, reviewed, accepted sentence.
//
// So this guard reads the LEVEL BELOW the name. It is deliberately a separate file
// from the surface gate: that one is about the shim's coverage of Bun, this one is
// about a stale review of one namespace, which is a different failure and deserves
// its own message.
//
// The literal relative require below is load-bearing for the production-gate
// population sweep (test/guards-population.cjs), which derives "which guard controls
// this production gate" by reading that exact string out of this file's own source.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { bunAntMembers, unaccountedBunAnt, KNOWN_BUN_ANT } =
  require('../../libexec/inspect-claude-bundle.cjs');
const { defineGuard, guardTests } = require('../guard.cjs');

const REPO = path.resolve(__dirname, '..', '..');
const EXTRACT = path.join(REPO, 'libexec', 'extract-claude-js.cjs');

guardTests(defineGuard({
  name: 'bun-ant-member-surface',
  // FLOOR 3. A carve whose ant surface came back with fewer than three members is
  // not "clean", it is a scanner that stopped matching: every provider measured so
  // far carries at least getPeerUid + getPeerPid + memoryPressureLevel (2.1.251) or
  // CellSegmenter + getPeerPid + getPeerUid + memoryPressureLevel + waitForUrlEvent
  // (2.1.278). Without the floor, a regex that silently stopped matching reads
  // exactly like an upstream that grew nothing.
  floor: 3,
  read() {
    const bin = process.env.CLODE_PROVIDER_BIN;
    if (!bin || !fs.existsSync(bin)) {
      return { skip: 'no CLODE_PROVIDER_BIN (point it at a real claude binary to run this gate)' };
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunant-'));
    const cli = path.join(dir, 'cli.cjs');
    const ex = spawnSync(process.execPath, [EXTRACT, bin, cli], { encoding: 'utf8' });
    if (ex.status !== 0) {
      return { skip: `extract-claude-js could not carve ${bin}: ${(ex.stderr || '').slice(0, 300)}` };
    }
    // latin1 so 1 char == 1 byte, matching the inspector's own round-trip.
    const text = fs.readFileSync(cli, 'latin1');
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    return { text };
  },
  scan({ text }) {
    const members = bunAntMembers(text);
    return {
      examined: members.length,
      findings: unaccountedBunAnt(members).map((k) =>
        `Bun.ant.${k} — upstream references it and nothing here says what happens without it. `
        + 'Decide, then record the decision: implement it in bun-shim, or add it to '
        + "inspect-claude-bundle's KNOWN_BUN_ANT with the measured reason its absence is "
        + `survivable. Reviewed today: ${[...KNOWN_BUN_ANT.keys()].join(', ')}.`),
    };
  },
  // The control is the real regression, spelled out: a bundle that reaches for a new
  // private member. `CellSegmenter` is not hypothetical — it is what 2.1.278 added and
  // what this guard exists to have caught. The three reviewed members ride along so the
  // control also clears the floor, which is the point: a control that tripped the floor
  // instead of the finding would prove the wrong thing.
  control() {
    return {
      text: 'if(typeof Bun.ant?.getPeerPid==="function"){}Bun.ant.getPeerUid(1);'
        + 'Bun.ant.memoryPressureLevel();new Bun.ant.CellSegmenter({});',
    };
  },
}));

// THE SCANNER MUST SEE BOTH ENCODINGS. Since upstream 2.1.243 a carved cli.cjs
// carries each module's source ESCAPED inside a JS string (the graph runner), so the
// same bytes appear twice in one file at two escape levels. A scan pattern that
// works on only one of them reports a bundle's surface as intact, or as grown, for
// the wrong reason — which is the standing hazard test/guards-population.test.cjs
// polices. `Bun.ant.<member>` carries no quotes and no backslashes, so both
// encodings must agree; this pins that rather than assuming it.
test('the ant-member scanner matches both the raw and the runner-escaped carve', () => {
  const raw = 'function vs(n){if(typeof Bun.ant?.CellSegmenter!=="function")throw Error("no");'
    + 'return new Bun.ant.CellSegmenter({ambiguousIsNarrow:!0})}';
  const escaped = JSON.stringify(raw).slice(1, -1);   // exactly how the runner carries it
  assert.match(escaped, /\\"function\\"/, 'the fixture must really be at the escaped level');
  assert.deepStrictEqual(bunAntMembers(raw), ['CellSegmenter']);
  assert.deepStrictEqual(bunAntMembers(escaped), ['CellSegmenter']);
});

test('the scanner does not fire on an ordinary identifier that ends in "ant"', () => {
  // A bare /ant\./ matched `participant.custom` and a hundred minified locals —
  // measured at 15 false hits for `ant.custom` alone on the 2.1.278 carve.
  const src = 'participant.custom;variant.choice;const ant={};ant.length;defiant.code;';
  assert.deepStrictEqual(bunAntMembers(src), []);
});
