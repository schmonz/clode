'use strict';
// The rg gate's VERDICTS, on synthetic evidence.
//
// WHY THIS EXISTS. scripts/rg-inventory.mjs shipped able to report exactly one
// conclusion — "the bundle's rg usage changed" — for three unrelated situations,
// and its first-ever CI run hit the wrong two: every runner lacks ugrep/bfs, the
// shim printed nothing the probe could parse, and the gate blamed upstream for a
// change that had not happened. Four legs went red with a false message.
//
// The gate needs a built binary, so nothing could test it end-to-end cheaply and
// nothing did. But the part that was wrong is the JUDGEMENT, not the driving: it
// reads a child's stderr and decides what it means. So hand it a "binary" that is
// a script printing chosen lines, and assert on the verdict. That makes each of
// the situations the gate must tell apart a row here — including the one where it
// must say "I observed nothing" instead of accusing upstream.
const { test } = require('node:test');
const assert = require('node:assert');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.dirname(__dirname);
const GATE = path.join(ROOT, 'scripts', 'rg-inventory.mjs');
const GOLDEN = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'test', 'shim-surface', 'rg-calls-golden.json'), 'utf8'));

// A shebang script stands in for the built binary. Windows cannot exec one
// without a shell and node refuses .cmd without shell:true, so the fake cannot be
// built there — the JUDGEMENT under test is platform-independent, and it is
// covered on every other leg.
const NO_FAKE = process.platform === 'win32' ? 'needs a POSIX shebang to fake a binary' : false;

// The golden's three calls, with a concrete path where it records <PATH>.
const P = '/tmp/rg-gate-fixture';
const RG = [
  'rg --version',
  `rg --files --hidden ${P}`,
  `rg --files --hidden --no-ignore --max-depth 4 --glob .orphaned_at ${P}`,
];
const SENTINEL = 'fixture-stderr-sentinel-9f2a';

// Emits `lines` on stderr, exits 0. Named so a failure message points here.
function fakeBinary(lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-gate-'));
  const bin = path.join(dir, 'fake-quaude');
  const body = [SENTINEL, ...lines]
    .map((l) => `printf '%s\\n' ${JSON.stringify(l)} >&2`).join('\n');
  fs.writeFileSync(bin, `#!/bin/sh\n${body}\nexit 0\n`, { mode: 0o755 });
  return bin;
}

function runGate(lines, extraArgs = []) {
  const r = cp.spawnSync(process.execPath, [GATE, fakeBinary(lines), ...extraArgs],
    { encoding: 'utf8' });
  return { status: r.status, out: r.stdout || '', err: r.stderr || '' };
}

const translated = (rg) => `clode rg-debug: ${rg} => /usr/bin/ugrep -r -L ${P}`;
const needs = (rg, applet) => `clode rg-debug: ${rg} !! needs ${applet}`;

test('gate: the golden calls, all translated -> PASS', { skip: NO_FAKE }, () => {
  const r = runGate(RG.map(translated));
  assert.strictEqual(r.status, 0, r.err);
  assert.match(r.out, /PASS: 3 rg call\(s\), 3 translated/);
});

// The CI failure, reduced. A refused call is still an OBSERVED call: the
// inventory is intact and upstream changed nothing. Saying so is the whole point.
test('gate: applet-missing refusals are NOT "usage changed"', { skip: NO_FAKE }, () => {
  const r = runGate([needs(RG[0], 'ugrep'), needs(RG[1], 'ugrep'), needs(RG[2], 'bfs')]);
  assert.strictEqual(r.status, 1);
  assert.match(r.err, /this host cannot translate rg — missing bfs, ugrep/);
  assert.doesNotMatch(r.err, /usage changed/);
  assert.doesNotMatch(r.err, /probe observed NOTHING/);
  // All three calls were still observed — the inventory question is answered.
  for (const g of GOLDEN) assert.ok(r.out.includes(g), `missing from inventory: ${g}`);
});

test('gate: --allow-untranslated passes but says how many were refused', { skip: NO_FAKE }, () => {
  const r = runGate([needs(RG[0], 'ugrep'), needs(RG[1], 'ugrep'), needs(RG[2], 'bfs')],
    ['--allow-untranslated']);
  assert.strictEqual(r.status, 0, r.err);
  assert.match(r.out, /0 translated, 3 refused \(no applet on this host\)/);
});

// The lie that cost the most: nothing parsed, so nothing was observed, so the
// gate declared every golden call gone.
test('gate: zero observations is "the probe observed NOTHING"', { skip: NO_FAKE }, () => {
  const r = runGate([]);
  assert.strictEqual(r.status, 1);
  assert.match(r.err, /the probe observed NOTHING/);
  assert.doesNotMatch(r.err, /usage changed/);
});

// ...and the real finding still reports as the real finding.
test('gate: a genuinely changed inventory still fails as "usage changed"', { skip: NO_FAKE }, () => {
  const r = runGate([...RG.map(translated), translated('rg --files --brand-new-flag ' + P)]);
  assert.strictEqual(r.status, 1);
  assert.match(r.err, /the bundle's rg usage changed/);
  assert.match(r.err, /\+ rg --files --brand-new-flag <PATH>/);
});

test('gate: an rg-only flag fails as untranslatable, not as host config', { skip: NO_FAKE }, () => {
  const r = runGate([`clode rg-debug: rg --json foo ${P} !! untranslatable --json`]);
  assert.strictEqual(r.status, 1);
  assert.match(r.err, /flag\(s\) we cannot express/);
  assert.match(r.err, /--json {2}\(seen in: rg --json foo <PATH>\)/);
  assert.doesNotMatch(r.err, /this host cannot translate/);
});

// The single line that diagnoses a blind probe ("clode: rg needs 'ugrep' ...")
// was discarded unless someone re-ran with --verbose, which nobody does from a
// CI log. Every failure path must show what the child actually said.
test('gate: a failure prints the child stderr it judged', { skip: NO_FAKE }, () => {
  for (const lines of [[], [needs(RG[0], 'ugrep')]]) {
    const r = runGate(lines);
    assert.strictEqual(r.status, 1);
    assert.ok(r.err.includes(SENTINEL), `child stderr not echoed for ${JSON.stringify(lines)}`);
  }
});

// The gate can only parse what the shim prints. This is the seam that broke:
// the verdict line existed for translated calls and for nothing else.
test('shim: a refused rg call prints the same parseable rg-debug shape', () => {
  const src = `
    const shim = require(${JSON.stringify(path.join(ROOT, 'libexec', 'bun-shim.cjs'))});
    shim._rewriteRgSpawn(['rg', '--files', '--hidden', '--no-ignore', '/tmp/x']);
    shim._rewriteRgSpawn(['rg', '--version']);
  `;
  // Force the applets absent regardless of what this host has installed. The
  // PATH key is dropped case-insensitively because Windows spells it `Path`, and
  // handing the child both spellings would leave which() reading whichever one
  // won — an instrument that depends on the platform it is measuring.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !/^path$/i.test(k) && !/^CLODE_(UGREP|BFS)$/.test(k)));
  env.CLODE_RG_DEBUG = '1';
  const r = cp.spawnSync(process.execPath, ['-e', src], { encoding: 'utf8', env });
  assert.match(r.stderr, /^clode rg-debug: rg --files --hidden --no-ignore \/tmp\/x !! needs bfs$/m);
  assert.match(r.stderr, /^clode rg-debug: rg --version !! needs ugrep$/m);
});
