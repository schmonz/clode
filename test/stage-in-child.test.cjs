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

// RELAUNCH EXACTLY AS LAUNCHED. Relaunching [execPath, argv[1]] dropped node's execArgv, and
// under `tjs run loader.cjs <entry>` dropped `run loader.cjs` (the loader rewrites process.argv
// to [tjs, entry]), so a checkout run under tjs died "ended without an answer".
// AND ALWAYS THE CLODE ENTRY, never argv[1]: clode-build runs in-process inside node:test files
// (and the naude path), and relaunching argv[1] re-ran the TEST FILE as the "staging child",
// recursively — the suite went 4,216 -> 111,898 tests with 68,283 failures (2026-11-22).
const CLODE_MAIN = path.join(__dirname, '..', 'libexec', 'clode-main.cjs');
test('stageRelaunchArgv: the target is the clode entry, launched as this process was', () => {
  const { stageRelaunchArgv } = require('../libexec/clode-build.cjs');
  const proc = { execPath: '/n/node', execArgv: ['--stack-size=4000', '--test', '--test-name-pattern=x', '--require', '/p.cjs', '--watch'],
    argv: ['/n/node', '/c/some.test.cjs'] };
  assert.deepStrictEqual(stageRelaunchArgv({ __clodeLauncherArgv: ['/t/tjs', 'run', '/c/loader.cjs'], __clodeEntry: '/c/clode-main.cjs' }, proc),
    ['/t/tjs', 'run', '/c/loader.cjs', '/c/clode-main.cjs']);
  assert.deepStrictEqual(stageRelaunchArgv({ __quaudeVFS: {} }, proc), ['/n/node']);
  assert.deepStrictEqual(stageRelaunchArgv({}, proc), ['/n/node', '--stack-size=4000', '--require', '/p.cjs', CLODE_MAIN],
    'node keeps its own execArgv but not the test runner\'s or watcher\'s, and runs clode-main.cjs, not argv[1]');
});

// THE RATCHET, in-process from THIS node:test file, whose argv[1] is this file: the real globals
// must still relaunch clode's entry.
test('in-process from a node:test file, the staging child is clode-main.cjs, not the test file', () => {
  const { stageRelaunchArgv } = require('../libexec/clode-build.cjs');
  const argv = stageRelaunchArgv();
  assert.strictEqual(argv[argv.length - 1], CLODE_MAIN, JSON.stringify(argv));
  assert.ok(!argv.includes(__filename) && !argv.includes(process.argv[1]),
    `the relaunch names the running test file: ${JSON.stringify(argv)}`);
});

test('recursion fuse: a staging child refuses to start another, by name', () => {
  const { stageInChild, STAGE_CHILD_REFUSAL } = require('../libexec/clode-build.cjs');
  globalThis.__clodeStageChild = true;
  try {
    assert.deepStrictEqual(stageInChild({}, {}), { error: STAGE_CHILD_REFUSAL });
  } finally {
    delete globalThis.__clodeStageChild;
  }
  assert.deepStrictEqual(stageInChild({}, { CLODE_STAGE_REQUEST: '/x/request.json' }), { error: STAGE_CHILD_REFUSAL });
  assert.match(STAGE_CHILD_REFUSAL, /staging child .*refused/);
});

test('clode build under `tjs run loader.cjs` stages in a child the same way (the child\'s answer arrives)', (t) => {
  const tjs = tjsPath();
  if (!tjs) { t.skip('no tjs binary (CLODE_TJS or build/tjs/tjs)'); return; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-in-child-tjs-'));
  try {
    const provider = path.join(tmp, 'claude');
    fs.writeFileSync(provider, 'not a provider\n', { mode: 0o755 });
    const loader = path.join(__dirname, '..', 'libexec', 'node-shim', 'loader.cjs');
    const r = spawnSync(tjs, ['run', loader, ENTRY, 'build', '--out', path.join(tmp, 'q')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: tmp, CLODE_STATE_ROOT: tmp, CLODE_CACHE: path.join(tmp, 'cache'), CLODE_DEPS: path.join(tmp, 'deps'),
        CLODE_WATCH_DIR: path.join(tmp, 'watch'), CLODE_OFFLINE: '1', CLODE_TJS: tjs, CLODE_CLAUDE_BIN: provider,
        CLODE_STAGE_REQUEST: '',
      },
    });
    assert.strictEqual(r.status, 1, r.stderr);
    assert.doesNotMatch(r.stderr, /ended without an answer/);
    assert.match(r.stderr, /build: extraction failed: no Bun @bun-cjs entry marker found/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// A stray CLODE_STAGE_REQUEST used to turn ANY invocation into a silent staging child that
// wrote <path>.result.json and exited. Only request.json in a clode-stage-* temp dir counts.
test('a stray CLODE_STAGE_REQUEST is refused by name, and nothing is written beside it', () => {
  const { isStageRequestPath } = require('../libexec/clode-build.cjs');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-in-child-stray-'));
  const ours = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-stage-'));
  try {
    const stray = path.join(tmp, 'request.json');
    fs.writeFileSync(stray, '{}');
    const r = spawnSync(process.execPath, [ENTRY, '--version'], {
      encoding: 'utf8', env: { ...process.env, CLODE_STAGE_REQUEST: stray },
    });
    assert.strictEqual(r.status, 2, r.stderr);
    assert.match(r.stderr, /refusing CLODE_STAGE_REQUEST=.*Unset it/);
    assert.ok(!fs.existsSync(`${stray}.result.json`), 'a refused request must write nothing');
    const req = path.join(ours, 'request.json');
    assert.strictEqual(isStageRequestPath(req), false, 'absent: not a request');
    fs.writeFileSync(req, '{}');
    assert.strictEqual(isStageRequestPath(req), true, 'what stageInChild makes is a request');
    assert.strictEqual(isStageRequestPath(path.join(ours, 'other.json')), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(ours, { recursive: true, force: true });
  }
});
