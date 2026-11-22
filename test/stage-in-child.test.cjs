'use strict';
// STAGE-IN-CHILD (libexec/clode-build.cjs): the builder never extracts in its own process.
//
// netbsd-sparc ran out of swap in the blobulate step (runs 44991586139, 45005386065) because
// the builder still held what staging had taken: measured under tjs on darwin with the real
// 2.1.330 provider, 889MB RSS kept through blobulate after a 1.58GB staging peak, and dropping
// references does not return it (the allocator keeps it; see the comment at stageInChild).
// The property that fixes it is "staging happens in a process that ends", so that is what is
// asserted — not a byte count, which would move with every upstream bump.
//
// HOW: a --require preload, inherited by every node process the build starts through
// NODE_OPTIONS, wraps libexec/clode-extract.cjs's extractIfNeeded and appends the pid that
// called it to a log; it also logs the builder's own pid. The provider is a stand-in file
// that fails extraction at once, so this takes a second, and it also proves the child's
// error still reaches the builder's message.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tjsPath } = require('./node-shim-helper.cjs');

const ENTRY = path.join(__dirname, '..', 'libexec', 'clode-main.cjs');

const PRELOAD = `
'use strict';
const fs = require('node:fs');
const Module = require('node:module');
const log = process.env.STAGE_TEST_LOG;
if (process.argv.includes('build')) fs.appendFileSync(log, 'builder ' + process.pid + '\\n');
const load = Module._load;
Module._load = function (request, parent, isMain) {
  const m = load.apply(this, arguments);
  if (/clode-extract\\.cjs$/.test(request) && m && typeof m.extractIfNeeded === 'function' && !m.__wrapped) {
    const real = m.extractIfNeeded;
    m.extractIfNeeded = function () { fs.appendFileSync(log, 'extract ' + process.pid + '\\n'); return real.apply(this, arguments); };
    m.__wrapped = true;
  }
  return m;
};
`;

test('clode build extracts in a child process, never in the builder, and the child\'s error reaches the builder', (t) => {
  const tjs = tjsPath();
  if (!tjs) { t.skip('no tjs binary (CLODE_TJS or build/tjs/tjs): the build refuses before staging without one'); return; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-in-child-'));
  try {
    const preload = path.join(tmp, 'preload.cjs');
    fs.writeFileSync(preload, PRELOAD);
    const provider = path.join(tmp, 'claude');
    fs.writeFileSync(provider, 'not a provider\n', { mode: 0o755 });
    const log = path.join(tmp, 'pids.log');
    fs.writeFileSync(log, '');
    const r = spawnSync(process.execPath, [ENTRY, 'build', '--out', path.join(tmp, 'q')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: tmp, CLODE_STATE_ROOT: tmp, CLODE_CACHE: path.join(tmp, 'cache'), CLODE_DEPS: path.join(tmp, 'deps'),
        CLODE_WATCH_DIR: path.join(tmp, 'watch'), CLODE_OFFLINE: '1', CLODE_TJS: tjs, CLODE_CLAUDE_BIN: provider,
        CLODE_STAGE_REQUEST: '', NODE_OPTIONS: `--require ${preload}`, STAGE_TEST_LOG: log, DYLD_INSERT_LIBRARIES: '',
      },
    });
    assert.strictEqual(r.status, 1, `the stand-in provider must fail the build:\n${r.stderr}`);
    assert.match(r.stderr, /build: extraction failed: no Bun @bun-cjs entry marker found/,
      'the staging child\'s error must reach the builder\'s own message');
    const lines = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => l.split(' '));
    const builder = lines.filter(([k]) => k === 'builder').map(([, p]) => p);
    const extract = lines.filter(([k]) => k === 'extract').map(([, p]) => p);
    assert.strictEqual(builder.length, 1, `expected one builder process: ${JSON.stringify(lines)}`);
    assert.ok(extract.length >= 1, `extraction never ran: ${JSON.stringify(lines)}`);
    assert.ok(!extract.includes(builder[0]),
      `the builder (pid ${builder[0]}) extracted in its own process: ${JSON.stringify(lines)}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// The dep-closure gate's scan was the builder's SECOND holder (460MB, parsing the whole staged
// graph at the verify step). The staging child scans and hands back names; the builder must
// judge THOSE and not re-read the file. A stand-in cli.cjs whose bytes name an unknown package
// proves which one it judged: the child's answer (no names) passes, the file would fail.
test('the dep-closure gate judges the staging child\'s scan, not the staged file, and throws the child\'s scan error', () => {
  const { assertNoUnknownBareSpecifiers } = require('../libexec/clode-build.cjs');
  const libexec = path.join(__dirname, '..', 'libexec');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-in-child-scan-'));
  try {
    const cli = path.join(tmp, 'cli.cjs');
    fs.writeFileSync(cli, 'require("surely-not-in-the-closure");\n');
    assert.throws(() => assertNoUnknownBareSpecifiers([cli], [], libexec), /surely-not-in-the-closure/,
      'control: scanning the file itself must find the unknown package');
    assert.doesNotThrow(() => assertNoUnknownBareSpecifiers([cli], [], libexec, { scanned: { [cli]: { names: [] } } }));
    assert.throws(() => assertNoUnknownBareSpecifiers([cli], [], libexec, { scanned: { [cli]: { names: ['other-unknown'] } } }),
      /other-unknown/);
    assert.throws(() => assertNoUnknownBareSpecifiers([cli], [], libexec, { scanned: { [cli]: { error: 'dep-closure gate: from the child' } } }),
      /dep-closure gate: from the child/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
