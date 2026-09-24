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
// It did. 2.1.278 added `Bun.ant.CellSegmenter`, the native grapheme->cell segmenter
// Ink's screen model is built on, and upstream does NOT tolerate that one being
// absent: the render root throws. A quaude built from 2.1.278 boots, writes its
// alternate-screen escapes, throws on the first frame and exits — while the
// one-level gate stayed green, because "Bun.ant (missing)" was still an accurate,
// reviewed, accepted sentence.
//
// CORRECTION, 2026-09-22, measured with bunAntMembers() on the carved cli.cjs of
// four real 2.1.278 providers: this comment used to say 2.1.278 "dropped all three"
// of getPeerUid/getPeerPid/memoryPressureLevel. It did not — all three are present
// in every 2.1.278 carve. What is true, and was the actual source of that
// impression, is that the surface is PER PLATFORM: see the union table in
// inspect-claude-bundle.cjs. Nothing about why this guard exists changes; the
// sentence was simply wrong, and a guard's rationale has to be measured too.
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
const { bunAntMembers, unaccountedBunAnt, KNOWN_BUN_ANT, shimBunAntMembers } =
  require('../../libexec/inspect-claude-bundle.cjs');
const { defineGuard, guardTests } = require('../guard.cjs');

const REPO = path.resolve(__dirname, '..', '..');
const EXTRACT = path.join(REPO, 'libexec', 'extract-claude-js.cjs');

guardTests(defineGuard({
  name: 'bun-ant-member-surface',
  // FLOOR 3. A carve whose ant surface came back with fewer than three members is
  // not "clean", it is a scanner that stopped matching: every provider measured so
  // far carries at least getPeerUid + getPeerPid + memoryPressureLevel (2.1.251),
  // and at 2.1.278 the smallest real surface is win32's four (CellSegmenter +
  // getPeerPid + getPeerUid + memoryPressureLevel). Without the floor, a regex that
  // silently stopped matching reads exactly like an upstream that grew nothing.
  //
  // THE FLOOR STAYS AT 3 THOUGH EVERY MEASURED BUNDLE HAS AT LEAST 4, because the
  // count is upstream's to change and the floor's job is to catch a BLIND SCANNER,
  // not to assert a shape. Raising it to 4 would turn "upstream dropped a member"
  // into BROKEN ("the guard is blind"), which is the wrong sentence for a true
  // finding. See the union table in inspect-claude-bundle.cjs for all four
  // per-platform measurements.
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
    // WHICH CARVE. The ant surface is PER PLATFORM (see the union table in
    // inspect-claude-bundle.cjs), so a member count is only interpretable beside
    // the artifact it was counted from. Derived from the provider's own container
    // rather than from this host's process.platform: a cross-carve is a real and
    // deliberate thing to do here, and reporting the runner's OS would be a lie
    // exactly when it mattered.
    //
    // Loaded through the EXTRACT constant, NOT a require() literal, on purpose: this is a
    // FIXTURE use (borrowing two helpers to label the carve), and guards-population reads
    // require() literals in build-gates files as "this guard CONTROLS that module". This
    // guard does not control extract-claude-js, and letting the label claim it would drop
    // the uncontrolled-gate count for a gate nobody controls.
    let carve = bin;
    try {
      const { providerPlatformOf, providerArchOf } = require(EXTRACT);
      const plat = providerPlatformOf(bin), arch = providerArchOf(bin);
      if (plat && arch) carve = `${plat}-${arch} carve (${bin})`;
    } catch { /* an unidentifiable container still reports its path */ }
    return { text, carve };
  },
  scan({ text, carve }) {
    const members = bunAntMembers(text);
    const provided = shimBunAntMembers();
    const where = carve || 'a synthetic control fixture';
    return {
      examined: members.length,
      note: `${where}: Bun.ant surface [${members.join(' ')}]`
        + `; bun-shim provides [${provided.join(' ') || '(none)'}]`,
      findings: unaccountedBunAnt(members, provided).map((k) =>
        `Bun.ant.${k} — upstream references it in ${where} and nothing here says what `
        + 'happens without it. Decide, then record the decision: implement it in bun-shim, '
        + "or add it to inspect-claude-bundle's KNOWN_BUN_ANT with the measured reason its "
        + 'absence is survivable — and take that measurement from a carve that HAS the '
        + 'member, since the surface differs per platform. '
        + `Provided: ${provided.join(', ') || '(none)'}. `
        + `Reviewed absent: ${[...KNOWN_BUN_ANT.keys()].join(', ')}.`),
    };
  },
  // The control is the real regression, spelled out: a bundle that reaches for a
  // private member nobody has reviewed. The three reviewed members ride along so the
  // control also clears the floor, which is the point: a control that tripped the floor
  // instead of the finding would prove the wrong thing.
  //
  // THE CONTROL'S MEMBER MUST BE ONE NOTHING WILL EVER ACCOUNT FOR — neither
  // `KNOWN_BUN_ANT` nor bun-shim. It used to be `CellSegmenter`, on the sound
  // reasoning that it was not hypothetical — it is exactly what 2.1.278 added and what
  // this guard exists to have caught. Then CellSegmenter was reviewed, the control
  // stopped producing a finding, and this guard reported CANNOT_FAIL — correctly. It
  // has since been IMPLEMENTED, which would have expired the control a second time.
  // A control spelled with a REAL member is a control with an expiry date: it dies the
  // day someone does the work this guard exists to demand. So the control names
  // something upstream cannot plausibly ship, and says so.
  control() {
    return {
      text: 'if(typeof Bun.ant?.getPeerPid==="function"){}Bun.ant.getPeerUid(1);'
        + 'Bun.ant.memoryPressureLevel();Bun.ant.__clodeControlNeverReviewed(1);',
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
