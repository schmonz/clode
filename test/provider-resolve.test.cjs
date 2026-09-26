'use strict';
// test/provider-resolve.cjs selects the suite's provider. These pin what it READS, with stores
// built in tmpdirs: never the real HOME store.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { providerBin, skipReason, pinnedVersion } = require('./provider-resolve.cjs');
const cpaths = require('../libexec/clode-paths.cjs');
const { TRAILER } = require('../libexec/bun-graph.cjs');

// A file isBunContainer() accepts: what makes one is the trailer, never the name.
function fakeProvider(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([Buffer.from('not really bun\n'), Buffer.from(TRAILER, 'latin1')]));
  return file;
}

// test/run.mjs sets CLODE_STATE_ROOT to a fresh tmpdir, THEN fetches a pin missing from the HOME
// store. `clode fetch claude` writes to the product's store (libexec/clode-update.cjs:
// providerVersionDir(env, ver)/providerKey(os, arch)/claude), which CLODE_STATE_ROOT moves.
// Selection read only the HOME store, so the fetched pin was never selected (2026-09-26, the
// pin move to 2.1.283).
test('the pin that `clode fetch claude` wrote under CLODE_STATE_ROOT is selected', () => {
  const pin = pinnedVersion();
  assert.ok(pin, 'UPSTREAM_PIN names a version');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-resolve-home-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-resolve-root-'));
  try {
    const env = { HOME: home, CLODE_STATE_ROOT: root };
    assert.strictEqual(providerBin({ ...env }), null, 'both stores empty: nothing to select');
    const fetched = fakeProvider(cpaths.providerBinPath(env, pin, cpaths.providerKey()));
    assert.ok(fetched.startsWith(root), `the fetch path is under CLODE_STATE_ROOT: ${fetched}`);
    assert.strictEqual(providerBin({ ...env }), fetched);
    // The HOME store stays first: a box's own provider is never displaced by a run's fetch.
    const own = fakeProvider(path.join(home, '.local', 'share', 'clode', 'providers', pin,
      cpaths.providerKey(), 'claude'));
    assert.strictEqual(providerBin({ ...env }), own);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the skip reason names the store `clode fetch claude` writes to', () => {
  const pin = pinnedVersion();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-resolve-home-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prov-resolve-root-'));
  try {
    const reason = skipReason({ HOME: home, CLODE_STATE_ROOT: root });
    const stores = [path.join(home, '.local', 'share', 'clode', 'providers'),
      cpaths.providersDir({ CLODE_STATE_ROOT: root })];
    for (const store of stores) {
      assert.ok(reason.includes(`${path.join(store, pin)}/`), `${store} is named: ${reason}`);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
