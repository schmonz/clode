'use strict';
// fs.watchFile / unwatchFile / watch characterization (Task 4, -p round-trip).
// The bundle installs a config-file watcher at startup via
// `fs.watchFile(path, opts, listener)` (its `mLt` helper); a missing method
// threw `TypeError: not a function` and abandoned that init step. These must be
// real functions returning a watcher with the node-shaped ref/unref (watchFile)
// / close (watch) surface. DIVERGENCE (documented in modules/fs.cjs): they
// register but never FIRE change events on this tjs build — asserted here so the
// approximation is characterized, not merely mentioned.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

function prog(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-fswatch-'));
  const f = path.join(dir, 'p.cjs');
  fs.writeFileSync(f, body);
  return f;
}

test('fs.watchFile/unwatchFile/watch are callable with node-shaped handles', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = prog(`
    const fs = require('node:fs');
    const out = {};
    out.watchFile = typeof fs.watchFile;
    out.unwatchFile = typeof fs.unwatchFile;
    out.watch = typeof fs.watch;
    const w = fs.watchFile(__filename, () => {});
    out.w_ref = typeof w.ref;
    out.w_unref = typeof w.unref;
    fs.unwatchFile(__filename);
    const fw = fs.watch(__filename, () => {});
    out.fw_close = typeof fw.close;
    fw.close();
    console.log(JSON.stringify(out));`);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), {
    watchFile: 'function', unwatchFile: 'function', watch: 'function',
    w_ref: 'function', w_unref: 'function', fw_close: 'function',
  });
});
