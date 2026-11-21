'use strict';
// os.machine() under quaude answers uname's machine, as node does. It answered process.arch, which is not the same
// string: on x86_64 Linux node says "x86_64" and process.arch says "x64", and the node-shim differential on
// linux-x64-musl read exactly that (2026-11-21; on arm64 macOS the two strings happen to agree, so darwin never saw
// it). The engine now reports uname (txiki-uname-global.patch, globalThis.__tjs_uname); an engine without it is
// refused by name (scripts/engine-api-floor.cjs), never answered from an arch-to-machine table.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runLoader, skipUnlessTjs, REPO } = require('./node-shim-helper.cjs');

test('os.machine() answers as node does on this host', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-os-machine-'));
  try {
    const prog = path.join(dir, 'p.cjs');
    fs.writeFileSync(prog, "console.log(JSON.stringify(require('os').machine()));");
    const node = spawnSync(process.execPath, [prog], { encoding: 'utf8' });
    assert.strictEqual(node.status, 0, node.stderr);
    const r = runLoader(prog, []);
    assert.strictEqual(r.status, 0, String(r.stderr));
    assert.strictEqual(r.stdout.trim().split('\n').pop(), node.stdout.trim());
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// The stale engine (test/fixtures/stale-engine-prelude.js, which has no __tjs_uname) is refused by name, and the
// refusal reaches CLODE_ENGINE_FLOOR_LOG.
test('an engine without __tjs_uname is refused by name, and the refusal is logged', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-os-machine-stale-'));
  try {
    const prelude = fs.readFileSync(path.join(REPO, 'test', 'fixtures', 'stale-engine-prelude.js'), 'utf8');
    const prog = path.join(dir, 'stale.cjs');
    fs.writeFileSync(prog, `${prelude}
let out; try { out = 'returned ' + require('os').machine(); } catch (e) { out = e.code + ': ' + e.message; }
console.log(JSON.stringify(out));`);
    const log = path.join(dir, 'floor.log');
    const r = runLoader(prog, [], { env: { CLODE_ENGINE_FLOOR_LOG: log } });
    assert.strictEqual(r.status, 0, String(r.stderr));
    const msg = 'node-shim: this engine has no __tjs_uname (it predates txiki-uname-global.patch), so os.machine() '
      + 'cannot answer uname\'s machine; rebuild it: ./build.sh --only engine.compile';
    assert.strictEqual(JSON.parse(r.stdout.trim().split('\n').pop()), `ERR_CLODE_ENGINE_FLOOR: ${msg}`);
    assert.strictEqual(fs.readFileSync(log, 'utf8').split('\n')[0], msg);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
