'use strict';
// bun-shim (the real libexec/bun-shim.cjs) must load to completion under the
// node-shim loader and set globalThis.Bun, and its Module._load hook must
// intercept a bun: require. This is the design's top risk (bun-shim assumed
// real Node; now its requires resolve through node-shim).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLoader, skipUnlessTjs, REPO } = require('./node-shim-helper.cjs');

test('bun-shim loads under the loader and installs its bun:ffi hook', (t) => {
  if (skipUnlessTjs(t)) return;
  const shim = path.join(REPO, 'libexec/bun-shim.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-bun-'));
  const f = path.join(dir, 'p.cjs');
  fs.writeFileSync(f, `
    require(${JSON.stringify(shim)});
    const ffi = require('bun:ffi');              // resolved by bun-shim's Module._load hook
    console.log(JSON.stringify({
      hasBun: typeof globalThis.Bun === 'object',
      bunVersion: typeof Bun.version === 'string',
      which: typeof Bun.which === 'function',
      ffiSuffix: ffi.suffix,                       // 'dylib' on darwin
      deepEq: Bun.deepEquals({ a: 1 }, { a: 1 }),  // util.isDeepStrictEqual
    }));`);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.strictEqual(out.hasBun, true);
  assert.strictEqual(out.bunVersion, true);
  assert.strictEqual(out.which, true);
  assert.strictEqual(out.ffiSuffix, 'dylib');
  assert.strictEqual(out.deepEq, true);
});

// Wall (Task 4): the -p bundle require()s 'ws' at MODULE-LOAD time
// (`P(require("ws"))`) but never opens a WebSocket on the -p path. bun-shim's
// own contract is "fail loud at the first WebSocket USE" (not at require), so a
// load-time require('ws') must return a lazy ws-shaped module — constructing a
// WebSocket from it is what fails loud. (When ws fails to load under the loader,
// which it does — ws needs a fuller tls/net than the shim provides — the eager
// _wsFatal would kill any boot that merely captures ws. This locks the deferral.)
test('bun-shim: require("ws") at load is non-fatal (fails only on WebSocket USE)', (t) => {
  if (skipUnlessTjs(t)) return;
  const shim = path.join(REPO, 'libexec/bun-shim.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-ws-'));
  const f = path.join(dir, 'p.cjs');
  // Capturing ws must NOT exit; the module must expose a WebSocket constructor.
  fs.writeFileSync(f, `
    require(${JSON.stringify(shim)});
    const ws = require('ws');
    const WS = ws && (ws.WebSocket || ws.default || ws);
    console.log(JSON.stringify({
      captured: !!ws,
      wsIsFn: typeof WS === 'function',
      globalWS: typeof globalThis.WebSocket === 'function',
    }));`);
  // Force ws unresolvable so the lazy (missing-ws) path is what runs, regardless
  // of what happens to be in node_modules: point NODE_PATH at an empty dir.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-np-'));
  const r = runLoader(f, [], { env: { NODE_PATH: empty } });
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.strictEqual(out.captured, true);
  assert.strictEqual(out.wsIsFn, true);
  assert.strictEqual(out.globalWS, true);
});
