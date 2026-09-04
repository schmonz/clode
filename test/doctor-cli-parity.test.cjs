'use strict';
// `claude doctor` vs `quaude doctor` — the STRUCTURED, non-interactive doctor.
//
// WHY THIS EXISTS, AND WHY IT IS NOT test/e2e-doctor-parity.test.cjs. That file drives
// the IN-SESSION `/doctor`, which as of 2.1.260 is an agent turn: a model runs shell
// commands and writes prose about them. Two runs of the SAME binary do not match, so a
// parity assertion over it is void (see BACKLOG.md). The CLI subcommand `claude doctor`
// is a different surface and still what it always was — `Label: value` lines, plus a
// warnings section — so it CAN be diffed, deterministically, with no PTY at all.
//
// WHAT IT ASSERTS, and why it is shaped as a characterisation test. Asked whether quaude
// SHOULD match claude here, the honest answer was "nobody knows yet" — some divergence is
// correct (quaude is not a native install and must not claim to be; it resolves ripgrep
// from the host on purpose), and some would be a bug. So this does not assert equality.
// It asserts:
//
//   1. INVARIANTS that must hold whatever else differs (below), and
//   2. that every OTHER differing label is one a human has already looked at and listed
//      in KNOWN_DIVERGENT. A new divergence fails and has to be triaged into the list or
//      fixed. That is the upstream-format-drift signal the old test wanted and could
//      never deliver.
//
// Gated on a built quaude (CLODE_QUAUDE) and a native claude on PATH. Both are cheap to
// satisfy deliberately and absent by default, so this SKIPS rather than lying.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

// Labels that legitimately differ, each with the reason. A label here is NOT ignored —
// it must still be PRESENT in both outputs; only its value may differ.
const KNOWN_DIVERGENT = {
  'Running': 'native reports its install kind; a quaude is not an install kind upstream knows',
  'Commit': 'different upstream bundle revisions are expected while UPSTREAM_PIN lags',
  'Path': 'the two binaries live in different places, necessarily',
  'Config install method': 'quaude is clode-managed, not npm/native-managed',
  'Search': 'rg-divergence-is-intentional: quaude resolves ripgrep from the host',
  'Managed settings (remote)': 'differs with the auth state of whoever runs it',
  'Last update attempt': 'reflects the running machine, not the binary',
};

// Labels only ONE side is expected to emit at all.
const NATIVE_ONLY = [];
const QUAUDE_ONLY = ['Invoked'];   // quaude names its VFS entry; native has no analogue

function doctor(bin) {
  const r = spawnSync(bin, ['doctor'], { encoding: 'utf8', timeout: 120000 });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

// `Label: value` lines from the REPORT BODY only.
//
// Stops at the warnings section, because its bullets carry their own `Fix:` lines and a
// naive trim-then-match reads those as report labels — which it did, on the first run,
// reporting `quaude emits labels native does not: Fix`. That is a parser artefact, not a
// divergence, and exactly the sort of false finding that discredits a new gate.
// Indented lines are skipped for the same reason: report labels start at column 0.
const WARNINGS_START = /^(No installation issues found\.|\d+ warnings? found)/;

function labels(text) {
  const m = new Map();
  for (const line of text.split('\n')) {
    if (WARNINGS_START.test(line.trim())) break;
    if (/^\s/.test(line)) continue;                       // indented => not a report label
    const hit = /^([A-Z][^:]{0,40}):\s*(.*)$/.exec(line);
    if (hit) m.set(hit[1], hit[2]);
  }
  return m;
}

const QUAUDE = process.env.CLODE_QUAUDE;
function nativeClaude() {
  const r = spawnSync('command', ['-v', 'claude'], { shell: true, encoding: 'utf8' });
  const p = (r.stdout || '').trim();
  return p && fs.existsSync(p) ? p : null;
}

function why() {
  if (!QUAUDE || !fs.existsSync(QUAUDE)) {
    return 'no built quaude: set CLODE_QUAUDE=<path> (build one with `clode build --out <path>`)';
  }
  if (!nativeClaude()) return 'no native `claude` on PATH to compare against';
  return null;
}

test('quaude doctor reports the HOST platform, not the platform it was carved from', (t) => {
  const skip = why();
  if (skip) { t.skip(skip); return; }

  // THE INVARIANT WORTH THE WHOLE FILE. Bun constant-folds process.platform/arch at CARVE
  // time, so a quaude assembled from a foreign-carved provider believes it is running on
  // that other OS — and says so here, to the user, on a line that looks authoritative.
  //
  // Found live 2026-09-04 on darwin-arm64: quaude reported `Platform: linux-x64`, because
  // this box's pinned 2.1.251 provider is a LINUX carve (the store is keyed by version
  // alone, so a foreign carve sits happily at the pinned path). `clode build` assembled it
  // without complaint, which contradicts target-matched assembly.
  //
  // This is the assertion a --version smoke or a PONG check can never make.
  const q = doctor(QUAUDE);
  assert.strictEqual(q.status, 0, `quaude doctor exited ${q.status}:\n${q.out}`);
  const platform = labels(q.out).get('Platform');
  assert.ok(platform, `quaude doctor emitted no 'Platform:' line:\n${q.out}`);

  const osToken = { darwin: 'darwin', linux: 'linux', win32: 'windows' }[process.platform]
    || process.platform;
  assert.ok(platform.startsWith(osToken),
    `quaude says Platform=${platform} but this host is ${process.platform}-${process.arch}. `
    + 'A quaude built from a foreign-carved provider lies about its OS — check that the '
    + 'provider it was built from is carved for THIS platform.');
});

test('both doctors emit the same label set, modulo reviewed divergences', (t) => {
  const skip = why();
  if (skip) { t.skip(skip); return; }

  const n = doctor(nativeClaude());
  const q = doctor(QUAUDE);
  assert.strictEqual(n.status, 0, `native doctor exited ${n.status}:\n${n.out}`);
  assert.strictEqual(q.status, 0, `quaude doctor exited ${q.status}:\n${q.out}`);

  const N = labels(n.out);
  const Q = labels(q.out);
  assert.ok(N.size > 3, `native doctor produced no label lines — surface changed?\n${n.out}`);
  assert.ok(Q.size > 3, `quaude doctor produced no label lines — surface changed?\n${q.out}`);

  const missing = [...N.keys()].filter((k) => !Q.has(k) && !NATIVE_ONLY.includes(k));
  const added = [...Q.keys()].filter((k) => !N.has(k) && !QUAUDE_ONLY.includes(k));
  assert.deepStrictEqual(missing, [], `quaude omits labels native emits: ${missing.join(', ')}`);
  assert.deepStrictEqual(added, [], `quaude emits labels native does not: ${added.join(', ')}`);
});

test('no UNREVIEWED value divergence between the two doctors', (t) => {
  const skip = why();
  if (skip) { t.skip(skip); return; }

  const N = labels(doctor(nativeClaude()).out);
  const Q = labels(doctor(QUAUDE).out);

  const unreviewed = [];
  for (const [label, nv] of N) {
    if (!Q.has(label) || label in KNOWN_DIVERGENT) continue;
    const qv = Q.get(label);
    if (qv !== nv) unreviewed.push(`${label}: native='${nv}' quaude='${qv}'`);
  }
  // Zero is a pass here, but zero LABELS COMPARED would not be — that would mean the
  // parse found nothing and this test proved nothing.
  const compared = [...N.keys()].filter((k) => Q.has(k) && !(k in KNOWN_DIVERGENT));
  assert.ok(compared.length > 0,
    'no comparable labels at all — either doctor surface changed, or the parser is wrong');
  assert.deepStrictEqual(unreviewed, [],
    'unreviewed divergence — decide whether each is correct (add to KNOWN_DIVERGENT with a '
    + 'reason) or a bug, then fix it:\n  ' + unreviewed.join('\n  '));
});
