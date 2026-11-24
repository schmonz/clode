'use strict';
// process.report under quaude answers as node does, for what the carve and clode read from it. 2.1.330's linux carve
// (and only it: Bun constant-folds the platform, so the darwin carve has no reader) picks the agent SDK's musl or glibc
// native binary from `process.report?.getReport().header.glibcVersionRuntime`, and clode's own platform-tag and
// clode-update read the same header. It was absent; CI's linux shim-surface gate named it once the scan saw the global
// process (run 45224603603). The glibc fields come from the engine (txiki-libc-global.patch, globalThis.__tjs_libc).
//
// Oracle: host node, the same program. What is compared: process.report's members, their order, kinds and default
// values, the property's own shape on process; the header's glibc fields (present with node's values on a glibc
// host, absent on any other C library, as node's are) and its uname fields; getReport's argument error; and that the
// same object comes back on every read. Not compared: the report's other sections, which quaude does not produce.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runLoader, skipUnlessTjs, REPO } = require('./node-shim-helper.cjs');

const PROG = `
const t = (f) => { try { return f(); } catch (e) { return e.constructor.name + ' ' + e.code + ' ' + e.message; } };
const r = process.report;
const d = Object.getOwnPropertyDescriptor(process, 'report');
const members = Object.keys(r).map((k) => {
  const p = Object.getOwnPropertyDescriptor(r, k);
  return [k, typeof r[k], p.get ? 'accessor' : 'data', typeof r[k] === 'function' ? r[k].length : r[k]];
});
const h = r.getReport().header;
console.log(JSON.stringify({
  own: [Object.keys(process).includes('report'), typeof d.get, d.enumerable, process.report === process.report],
  members,
  glibc: [h.glibcVersionRuntime, h.glibcVersionCompiler],
  uname: [h.osName, h.osRelease, h.osMachine, h.platform, h.arch],
  badErr: t(() => r.getReport(5)),
  nullErr: t(() => r.getReport(null)),
  objErr: typeof r.getReport(new Error('x')).header,
}));`;

test('process.report: node\'s members, and the header\'s glibc and uname fields as node answers them', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-process-report-'));
  try {
    const prog = path.join(dir, 'p.cjs');
    fs.writeFileSync(prog, PROG);
    const node = spawnSync(process.execPath, [prog], { encoding: 'utf8' });
    assert.strictEqual(node.status, 0, node.stderr);
    const want = JSON.parse(node.stdout.trim());
    const r = runLoader(prog, []);
    assert.strictEqual(r.status, 0, String(r.stderr));
    const got = JSON.parse(r.stdout.trim().split('\n').pop());
    assert.deepStrictEqual(got, want);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('process.report.writeReport() refuses by name: quaude writes no report file', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-process-report-w-'));
  try {
    const prog = path.join(dir, 'w.cjs');
    fs.writeFileSync(prog, `process.chdir(${JSON.stringify(dir)});
let out; try { out = 'returned ' + process.report.writeReport(); } catch (e) { out = e.code; }
console.log(JSON.stringify([out, require('fs').readdirSync('.').filter((f) => f.startsWith('report.')).length]));`);
    const r = runLoader(prog, []);
    assert.strictEqual(r.status, 0, String(r.stderr));
    assert.deepStrictEqual(JSON.parse(r.stdout.trim().split('\n').pop()), ['ERR_CLODE_UNSUPPORTED', 0]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// The stale engine (test/fixtures/stale-engine-prelude.js, no __tjs_libc) reads process.report as undefined: what
// every engine before txiki-libc-global.patch read, and NOT a refusal, because the build host's platform-tag reads
// it on the last release's engine. Nothing reaches CLODE_ENGINE_FLOOR_LOG.
test('an engine without __tjs_libc reads process.report as undefined, and refuses nothing', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-process-report-stale-'));
  try {
    const prelude = fs.readFileSync(path.join(REPO, 'test', 'fixtures', 'stale-engine-prelude.js'), 'utf8');
    const prog = path.join(dir, 'stale.cjs');
    fs.writeFileSync(prog, `${prelude}
console.log(JSON.stringify([typeof process.report, typeof process.report?.getReport]));`);
    const log = path.join(dir, 'floor.log');
    const r = runLoader(prog, [], { env: { CLODE_ENGINE_FLOOR_LOG: log } });
    assert.strictEqual(r.status, 0, String(r.stderr));
    assert.deepStrictEqual(JSON.parse(r.stdout.trim().split('\n').pop()), ['undefined', 'undefined']);
    assert.ok(!fs.existsSync(log) || fs.readFileSync(log, 'utf8') === '', 'nothing refused');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
