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
