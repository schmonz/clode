'use strict';
// The control for test/option-refusals.cjs: the recorder the default-path turns (node-shim-roundtrip's mock -p,
// node-shim-agentic's Bash turn) assert EMPTY must catch a refusal whose throw the caller SWALLOWS, from both shims,
// or an empty file would prove nothing. The shape is the 2026-11-23 bug: the bundle built an http.Agent with an
// option the shim refused, caught the throw, and the turn printed nothing.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLoader, skipUnlessTjs, REPO } = require('./node-shim-helper.cjs');
const { refusalRecorder } = require('./option-refusals.cjs');

test('option refusals: a swallowed refusal from either shim is recorded, and assertNone fails on it', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-refusals-'));
  const f = path.join(dir, 'swallow.cjs');
  fs.writeFileSync(f, `
require(${JSON.stringify(path.join(REPO, 'libexec/bun-shim.cjs'))});
const http = require('node:http');
try { new http.Agent({ localPort: 4321 }); } catch (_) { /* swallowed, as the bundle did */ }
try { Bun.spawn(['/bin/sh', '-c', 'true'], { ipc() {} }); } catch (_) { /* swallowed */ }
try { new http.Agent({ keepAlive: true, timeout: 5000 }); } catch (_) { /* honoured: must NOT be recorded */ }
console.log('done');
`);
  const rec = refusalRecorder(dir, 'control');
  try {
    const r = runLoader(f, [], { env: rec.env, timeout: 60000 });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /done/);
    const got = rec.read().map((x) => `${x.entry} ${x.option} ${x.code}`);
    assert.deepStrictEqual(got, ['http.Agent localPort ERR_SHIM_UNSUPPORTED_OPTION', 'Bun.spawn ipc ERR_CLODE_UNSUPPORTED_OPTION']);
    assert.throws(() => rec.assertNone(), /REFUSED option/);
    // and with nothing refused, nothing is recorded and assertNone passes
    const quiet = refusalRecorder(dir, 'quiet');
    fs.writeFileSync(f, 'require(\'node:http\').request({ host: \'127.0.0.1\', port: 9, lookup: (h, o, cb) => cb(new Error(\'x\')) }).on(\'error\', () => console.log(\'done\')).end();\n');
    const q = runLoader(f, [], { env: quiet.env, timeout: 60000 });
    assert.strictEqual(q.status, 0, q.stderr);
    quiet.assertNone();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
