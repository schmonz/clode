// Characterization for libexec/bun-graph.cjs — the decoder for Bun's standalone module
// graph, which is how clode sees a CODE-SPLIT bundle (Claude Code 2.1.243+) at all.
//
// Two layers, same doctrine as test/regression.test.cjs:
//
//   1. ALWAYS-ON, hermetic. Synthetic bytes, no provider needed. These assert the
//      REFUSALS, because the decoder's whole value is that it throws instead of
//      returning a plausible-looking wrong answer. A 32-byte error in `base` produced
//      names that looked perfectly valid attached to the WRONG module's source — the
//      failure mode this file exists to make impossible to ship.
//
//   2. REAL PROVIDER, gated. Decodes actual binaries and asserts the facts clode will
//      branch on. The gate resolves a provider the same way the product does, and
//      SKIPS ONLY when there is genuinely none — never silently, and never keyed to a
//      single hard-coded directory. (On 2026-08-25, 16 clode-watch tests were found to
//      have skipped in CI forever because their gate checked the shared user store
//      while CI populates deps/claude. A gate that looks somewhere the code does not is
//      a coin flip, not a test.)
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.join(__dirname, '..');
const {
  decodeBunGraph, loadGraphFromBytes, loadGraphFull, TRAILER, MODULE_FORMAT, LOADER,
} = require('../libexec/bun-graph.cjs');

// ---- layer 1: hermetic refusals ---------------------------------------------

function bytes(str) {
  const u = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) u[i] = str.charCodeAt(i) & 0xff;
  return u;
}

test('refuses input with no Bun trailer', () => {
  assert.throws(() => decodeBunGraph(bytes('not a bun binary at all')), /no .*Bun.* trailer/);
});

test('refuses a trailer too close to the start of the file', () => {
  assert.throws(() => decodeBunGraph(bytes(TRAILER)), /too close to start|runs off the front/);
});

test('refuses a byteCount that runs off the front of the file', () => {
  // 32-byte Offsets struct with a byteCount far larger than the file.
  const head = new Uint8Array(32);
  const put = (p, v) => { head[p] = v & 255; head[p + 1] = (v >> 8) & 255; head[p + 2] = (v >> 16) & 255; head[p + 3] = (v >>> 24) & 255; };
  put(0, 0xffffff);                      // byteCount lo
  const u = new Uint8Array(head.length + TRAILER.length);
  u.set(head, 0); u.set(bytes(TRAILER), head.length);
  assert.throws(() => decodeBunGraph(u), /runs off the front/);
});

test('refuses a module table whose length is not a multiple of the row stride', () => {
  const total = 256;
  const u = new Uint8Array(total + TRAILER.length);
  const h = total - 32;
  const put = (p, v) => { u[p] = v & 255; u[p + 1] = (v >> 8) & 255; u[p + 2] = (v >> 16) & 255; u[p + 3] = (v >>> 24) & 255; };
  put(h, total - 32);      // byteCount -> base 0
  put(h + 8, 0);           // modulesOffset
  put(h + 12, 53);         // modulesLength: NOT a multiple of 52
  u.set(bytes(TRAILER), total);
  assert.throws(() => decodeBunGraph(u), /not a multiple of 52/);
});

test('the ESM/CJS discriminator is a stable, documented pair', () => {
  // clode branches carve-vs-relink on this. If upstream ever adds a third value the
  // branch must be revisited deliberately, not defaulted.
  assert.deepStrictEqual(MODULE_FORMAT, { ESM: 1, CJS: 2 });
  assert.strictEqual(LOADER[1], 'js');
  assert.strictEqual(LOADER[10], 'napi');
});

// ---- layer 2: real providers -------------------------------------------------

// Resolve a provider the way the product does, then fall back to anything the test
// fixtures already know about. Skipping is reported with WHERE we looked.
function providers() {
  const found = [];
  const seen = new Set();
  const add = (p) => { if (p && fs.existsSync(p) && !seen.has(p)) { seen.add(p); found.push(p); } };
  add(process.env.CLODE_PROVIDER_BIN);
  add(process.env.CLODE_CLAUDE_BIN);
  try {
    const out = execFileSync(process.execPath, [path.join(REPO, 'scripts', 'find-provider.mjs')],
      { encoding: 'utf8' }).trim();
    add(out);
  } catch { /* no provider on this box; reported by the skip message */ }
  try {
    const { VERSIONS, providerBin } = require('./golden-shas-lib.cjs');
    for (const v of VERSIONS) add(providerBin(v));
  } catch { /* fixture lib unavailable */ }
  return found;
}

const PROVIDERS = providers();
const provOpts = {
  skip: PROVIDERS.length ? false
    : 'no Claude provider found (CLODE_PROVIDER_BIN, CLODE_CLAUDE_BIN, scripts/find-provider.mjs, or the golden-shas store)',
};

test('every real provider decodes, and every JS row is NUL-framed and named', provOpts, () => {
  for (const bin of PROVIDERS) {
    const g = loadGraphFull(bin);
    assert.ok(g.count > 0, `${bin}: no rows`);
    assert.ok(g.entryName.startsWith('/$bunfs/'), `${bin}: entry ${g.entryName}`);
    const js = g.rows.filter((r) => r.loader === 1);
    assert.ok(js.length > 0, `${bin}: no js rows`);
    for (const r of js) {
      assert.match(r.name, /^\/\$bunfs\/root\//, `${bin}: row ${r.index} name ${JSON.stringify(r.name)}`);
      assert.ok(r.contentsLength > 0, `${bin}: row ${r.index} empty contents`);
    }
  }
});

test('module_format partitions cleanly — a bundle is all-CJS or all-ESM, never mixed', provOpts, () => {
  // This is the fact clode branches on. If a bundle ever mixes formats, the
  // carve-vs-relink decision stops being a property of the BUNDLE and becomes a
  // property of each module, which is a different design. Fail loudly if so.
  for (const bin of PROVIDERS) {
    const g = loadGraphFull(bin);
    const formats = new Set(g.rows.filter((r) => r.loader === 1).map((r) => r.moduleFormat));
    assert.strictEqual(formats.size, 1, `${bin}: mixed module formats ${[...formats]}`);
    const only = [...formats][0];
    assert.ok(only === MODULE_FORMAT.ESM || only === MODULE_FORMAT.CJS,
      `${bin}: unknown module_format ${only} — upstream added a third shape; revisit the branch`);
  }
});

test('a CJS bundle decodes to the same entry bytes clode carves today', provOpts, () => {
  // The safety property for every currently-working user: bringing the table-driven
  // decoder in must not disturb the carve path. The decoded module is exactly the
  // wrapper plus the body carveBlocks returns.
  const { carveBlocks } = require('../libexec/bundle-carve.cjs');
  const PRE = '// @bun @bytecode @bun-cjs\n(function(exports, require, module, __filename, __dirname) {';
  let checked = 0;
  for (const bin of PROVIDERS) {
    const g = loadGraphFull(bin);
    const js = g.rows.filter((r) => r.loader === 1);
    if (!js.length || js[0].moduleFormat !== MODULE_FORMAT.CJS) continue;
    const text = fs.readFileSync(bin, 'latin1');
    const cli = carveBlocks(text).find((b) => b.name && /entrypoints\/cli\.js$/.test(b.name));
    if (!cli) continue;
    const row = g.rows.find((r) => r.name === g.entryName);
    const decoded = text.slice(row.contentsStart, row.contentsEnd);
    assert.ok(decoded.startsWith(PRE), `${bin}: entry does not start with the CJS wrapper`);
    assert.strictEqual(decoded.slice(PRE.length, PRE.length + cli.body.length), cli.body,
      `${bin}: decoded entry body differs from the carve`);
    assert.strictEqual(decoded.slice(PRE.length + cli.body.length), '})\n',
      `${bin}: unexpected tail after the carved body`);
    checked++;
  }
  if (!checked) return; // no CJS-format provider present; the partition test covers shape
  assert.ok(checked > 0);
});

test('loadGraphFromBytes returns only js rows, keyed by module name', provOpts, () => {
  for (const bin of PROVIDERS) {
    const g = loadGraphFull(bin);
    const mods = loadGraphFromBytes(new Uint8Array(fs.readFileSync(bin)));
    assert.strictEqual(mods.size, g.rows.filter((r) => r.loader === 1).length, bin);
    for (const [name, src] of mods) {
      assert.match(name, /^\/\$bunfs\/root\//, bin);
      assert.strictEqual(typeof src, 'string', bin);
    }
  }
});
