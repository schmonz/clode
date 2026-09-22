'use strict';
// HARD GATE for upstream API drift: the extracted bundle's Bun.* / bun: / require()
// surface must be FULLY ACCOUNTED FOR by bun-shim.cjs — `inspect-claude-bundle
// --strict --shim` exits 0. A new upstream Bun.X or require the shim doesn't cover
// is a potential SILENT break in a target (a require() that rejects -> TUI hang, an
// unguarded Bun.X() -> opaque quickjs "not a function"); this catches it PRE-SHIP
// instead of a user discovering it later. The static axis of the api-surface gate
// (the behavioral node-vs-tjs axis is scripts/apicheck.mjs); see [[clode-api-surface-gate]].
//
// Gated on a real provider (CLODE_PROVIDER_BIN — the CI node-shim-oracle jobs set it
// to the LATEST npm @anthropic-ai/claude-code, so this fails the moment upstream
// drifts). Skips locally without one. When it fails: review each flagged item and
// implement/stub/accept it in bun-shim.cjs + inspect-claude-bundle.cjs's KNOWN_BUN /
// ACCEPTED_* lists (grep the bundle for `"X" in Bun` feature-detection BEFORE stubbing
// a missing API — stubbing a feature-detected one flips the guard and makes it worse).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { gateProblems } = require('../libexec/inspect-claude-bundle.cjs');

const REPO = path.resolve(__dirname, '..');
const EXTRACT = path.join(REPO, 'libexec', 'extract-claude-js.cjs');
const INSPECT = path.join(REPO, 'libexec', 'inspect-claude-bundle.cjs');
const SHIM = path.join(REPO, 'libexec', 'bun-shim.cjs');

function providerBin() {
  const p = process.env.CLODE_PROVIDER_BIN;
  return p && fs.existsSync(p) ? p : null;
}

test('API-surface gate: inspect --strict --shim is clean on the provider', (t) => {
  const bin = providerBin();
  if (!bin) { t.skip('no CLODE_PROVIDER_BIN (set it to a real claude binary to run the gate)'); return; }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apigate-'));
  const cli = path.join(dir, 'cli.cjs');
  const ex = spawnSync(process.execPath, [EXTRACT, bin, cli], { encoding: 'utf8' });
  assert.strictEqual(ex.status, 0, `extract-claude-js failed: ${ex.stderr}`);

  const r = spawnSync(process.execPath, [INSPECT, cli, '--strict', '--shim', SHIM],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.strictEqual(r.status, 0,
    'inspect --strict flagged unaccounted bundle surface (upstream API drift?). '
    + 'Review + implement/stub/accept each item (see this file\'s header):\n'
    + `${r.stdout}\n${r.stderr}`);
});

// ---------------------------------------------------------------------------
// PROOF THE GATE CAN FAIL ON THE THING IT WAS BLIND TO.
//
// Until 2026-09-22 `gateProblems()` ignored `cov.unrecognized` entirely — the
// bucket holding every `Bun.<member>` the bundle references that KNOWN_BUN has
// never heard of, which is precisely the shape of upstream adopting a NEW Bun
// API. On the real 2.1.278 carve that bucket held Bun.sliceAnsi and Bun.unsafe;
// `--strict` reported neither, and the resulting quaude's interactive TUI painted
// zero printable cells while every `-p` check stayed green.
//
// The gate test above can only run where a provider binary exists, so on its own
// it proves nothing about the code here on a box without one. These two do: a
// coverage report carrying one unrecognized member MUST produce a finding, and an
// accepted one MUST NOT. Feed them a KNOWN-BAD input and watch it go red — that is
// the whole contract (test/guard.cjs).
const EMPTY_COV = {
  implemented: [], stubbed: [], missing: [], unrecognized: [],
  bun_modules_unhandled: [], modules_missing: [], modules_host_stub: [],
  disabled_native_features: [], search_applets_unknown: [],
};

test('gate control: an UNRECOGNIZED Bun member is reported (Bun.sliceAnsi, 2.1.278)', () => {
  const problems = gateProblems({ ...EMPTY_COV, unrecognized: ['sliceAnsi'] });
  assert.ok(problems.some((p) => p.startsWith('Bun.sliceAnsi')),
    `gateProblems ignored an unrecognized Bun member — the gate is blind again: ${JSON.stringify(problems)}`);
});

test('gate control: a reviewed UNRECOGNIZED member is not reported (Bun.Image)', () => {
  const problems = gateProblems({ ...EMPTY_COV, unrecognized: ['Image'] });
  assert.deepStrictEqual(problems, [],
    'Bun.Image carries a written review in ACCEPTED_UNRECOGNIZED_BUN and must not be a finding');
});

test('gate control: an empty coverage report is clean (the check is not always-red)', () => {
  assert.deepStrictEqual(gateProblems({ ...EMPTY_COV }), []);
});
