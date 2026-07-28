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
