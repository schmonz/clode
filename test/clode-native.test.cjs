'use strict';
// Q1c acceptance: the NATIVE clode builder. `clode build --self` fuses
// ./clode-native (tjs template + builder-role trailer: esbuilt clode-main as a
// source entry, node-shim tree, libexec fuse inputs, ext-dep closure), and that
// binary must complete the whole chain WITHOUT node:
//   1. --version / --help with PATH stripped to an empty dir;
//   2. `clode-native build` fuses a quaude whose internal mandatory smoke
//      (canned PONG round-trip + attest) passes — with node absent from PATH
//      (/usr/bin:/bin keeps codesign, loses node) — THE NATIVE BUILDER BUILDS
//      THE PRODUCT;
//   3. the fused quaude-from-native passes the agentic Bash mock oracle (the
//      same battery quaude-build.test.cjs runs on the host-node-built quaude).
// Gates: tjs template (all tests) + CLODE_PROVIDER_BIN (the product chain,
// like the sibling bundle-spawning suites). SLOW when enabled: the product
// fuse runs extraction + a 19MB syntax check + the cli.qbc compile under
// quickjs (~1-3 min).
//
// Freshness: the builder's behavior is frozen in the esbuilt bundle, so the
// test esbuilds a FRESH bundle into the tmp dir when a toolchain is available
// (build/toolchain/<platformTag>/node_modules/esbuild — reads only; the
// hermetic guard watches build/ for writes), falling back to the newest
// already-esbuilt bundle (typically build/bundle/, but scanned generically —
// see scripts/platform-tag.cjs's file header for why the toolchain and the
// bundle live at different keys/locations).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { tjsPath, skipUnlessTjs, REPO } = require('./node-shim-helper.cjs');
const { startMockAnthropic, cannedSSE, cannedToolUseSSE } = require('./mock-anthropic-helper.cjs');
const { toolchainDir } = require('../scripts/platform-tag.cjs');

const ENTRY = path.join(REPO, 'bin', 'clode');
const VERSION = fs.readFileSync(path.join(REPO, 'VERSION'), 'utf8').replace(/\n+$/, '');
function providerBin() { const p = process.env.CLODE_PROVIDER_BIN; return p && fs.existsSync(p) ? p : null; }

// A fresh (or newest available) esbuilt clode-main bundle, written OUTSIDE the
// repo. Returns null when neither a toolchain nor a prebuilt bundle exists.
function stageMainBundle(dir) {
  const buildDir = path.join(REPO, 'build');
  // Fresh esbuild: THIS host's own toolchain install, at its fixed
  // platform+node-major-keyed location (toolchainDir) — not a scan, since
  // there is exactly one toolchain dir for this host.
  const tool = path.join(toolchainDir(REPO), 'package.json');
  try {
    const esbuild = createRequire(tool)('esbuild');
    const out = path.join(dir, 'clode-main.bundle.cjs');
    esbuild.buildSync({
      entryPoints: [path.join(REPO, 'libexec', 'clode-main.cjs')],
      bundle: true, platform: 'node', format: 'cjs', target: 'node24',
      define: { __CLODE_BUNDLE_VERSION__: JSON.stringify(VERSION) },
      outfile: out,
    });
    return out;
  } catch { /* toolchain not installed on this host */ }
  // Fallback: newest already-esbuilt build/*/clode-main.bundle.cjs (generic
  // scan — same rationale as clode-fuse.cjs's CLODE_MAIN_BUNDLE default).
  let tags = [];
  try { tags = fs.readdirSync(buildDir); } catch { return null; }
  let newest = null;
  for (const d of tags) {
    const c = path.join(buildDir, d, 'clode-main.bundle.cjs');
    try { const m = fs.statSync(c).mtimeMs; if (!newest || m > newest.m) newest = { c, m }; } catch { /* */ }
  }
  return newest && newest.c;
}

let SKIP = null, SKIP_PRODUCT = null;
let DIR = null, NATIVE = null, QUAUDE = null, EMPTY_PATH = null, BUILD = null;
before(() => {
  if (!tjsPath()) { SKIP = 'no tjs binary (CLODE_TJS or build/tjs/tjs)'; return; }
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-native-'));
  EMPTY_PATH = path.join(DIR, 'empty-path-dir');
  fs.mkdirSync(EMPTY_PATH);
  const bundle = stageMainBundle(DIR);
  if (!bundle) { SKIP = 'no esbuilt clode-main bundle and no esbuild toolchain (run scripts/build-clode-main.mjs)'; return; }
  NATIVE = path.join(DIR, 'clode-native');
  QUAUDE = path.join(DIR, 'quaude-from-native');
  // Fuse the builder under HOST node (that is how a dev machine mints it).
  BUILD = spawnSync(process.execPath, [ENTRY, 'build', '--self', '--out', NATIVE], {
    encoding: 'utf8',
    timeout: 300000,
    env: {
      ...process.env,
      CLODE_TJS: tjsPath(),
      CLODE_MAIN_BUNDLE: bundle,
      DYLD_INSERT_LIBRARIES: '',
    },
  });
  if (!providerBin()) SKIP_PRODUCT = 'no CLODE_PROVIDER_BIN';
  // Proving "no node" needs a PATH that actually lacks node: macOS/Linux keep
  // codesign/sh in /usr/bin:/bin and node lives elsewhere. If this machine has
  // a node THERE, the proof is unavailable — skip rather than lie.
  if (!SKIP_PRODUCT) {
    const probe = spawnSync('sh', ['-c', 'command -v node'], {
      encoding: 'utf8', env: { PATH: '/usr/bin:/bin' },
    });
    if (probe.status === 0) SKIP_PRODUCT = `node exists on the minimal PATH (${(probe.stdout || '').trim()}); cannot prove node-freeness here`;
  }
});
after(() => { if (DIR) { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } } });

function runNative(bin, args, env, timeoutMs = 600000) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd: DIR, stdio: ['ignore', 'pipe', 'pipe'], env });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const to = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    child.on('exit', (status) => { clearTimeout(to); resolve({ status, stdout, stderr }); });
    child.on('error', (e) => { clearTimeout(to); resolve({ status: null, stdout, stderr: String(e) }); });
  });
}

test('clode build --self fuses a native builder and its internal smokes pass', (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  assert.strictEqual(BUILD.status, 0, `clode build --self failed:\n${BUILD.stdout}\n${BUILD.stderr}`);
  assert.match(BUILD.stdout, /clode: fused .*native clode builder/);
  assert.match(BUILD.stdout, /--version \+ --help ok/);
  assert.ok(fs.statSync(NATIVE).size > 6 * 1024 * 1024, 'fused builder implausibly small');
  assert.ok(fs.statSync(NATIVE).mode & 0o111, 'fused builder not executable');
});

// Host-node parse of the fused-file trailer (layout per quaude-bootstrap.mjs):
// [exe][members][index JSON][QAUDEv0 footer 32B][bootstrap bc][tx1k1.js 12B].
function readTrailerIndex(file) {
  const buf = fs.readFileSync(file);
  const tx = buf.subarray(buf.length - 12);
  assert.strictEqual(tx.subarray(0, 8).toString('latin1'), 'tx1k1.js', 'missing tx1k1.js trailer');
  const bcOffset = tx.readUInt32LE(8);
  const footer = buf.subarray(bcOffset - 32, bcOffset);
  assert.strictEqual(footer.subarray(0, 8).toString('latin1'), 'QAUDEv0\0', 'bad archive footer magic');
  const indexOff = Number(footer.readBigUInt64LE(8));
  const indexLen = Number(footer.readBigUInt64LE(16));
  const index = JSON.parse(buf.subarray(indexOff, indexOff + indexLen).toString('utf8'));
  const member = (name) => {
    const m = index.members.find((x) => x.name === name);
    return m && { ...m, data: buf.subarray(m.offset, m.offset + m.len) };
  };
  return { index, member };
}

test('the fused builder embeds the PRISTINE tjs template as a trailer member (Decision 2)', (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  const { member } = readTrailerIndex(NATIVE);
  const tpl = member('template/tjs');
  assert.ok(tpl, 'builder trailer has no template/tjs member');
  const want = fs.readFileSync(tjsPath());
  assert.strictEqual(tpl.len, want.length, 'embedded template length differs from the pinned tjs');
  const sha = (b) => require('node:crypto').createHash('sha256').update(b).digest('hex');
  assert.strictEqual(tpl.sha256, sha(want), 'index sha for template/tjs is not the pinned tjs sha');
  assert.strictEqual(sha(tpl.data), tpl.sha256, 'embedded template bytes do not match their index sha');
  // The manifest's template identity must be the SAME artifact (one invariant,
  // three witnesses: manifest, index, bytes).
  const manifest = JSON.parse(member('manifest.json').data.toString('utf8'));
  assert.strictEqual(manifest.template.sha256, tpl.sha256);
  assert.strictEqual(manifest.template.len, tpl.len);
});

test('acceptance 1: --version/--help answer with node ABSENT from PATH', async (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  // PATH = one empty dir: NOTHING external resolves, node included.
  const env = { PATH: EMPTY_PATH, HOME: DIR };
  const v = await runNative(NATIVE, ['--version'], env, 60000);
  assert.strictEqual(v.status, 0, v.stderr);
  assert.strictEqual(v.stdout, `clode ${VERSION}\n`);
  const h = await runNative(NATIVE, ['--help'], env, 60000);
  assert.strictEqual(h.status, 0, h.stderr);
  assert.match(h.stdout, /Options:/);
  assert.match(h.stdout, /clode build \[--out PATH\]/);
  // build --self left the USER surface (Task 6): the fused NATIVE builder still
  // answers to it (this whole test proves that), but its own --help must not
  // advertise it.
  assert.doesNotMatch(h.stdout, /--self/);
});

test('acceptance 1b: BARE invocation is a clean usage error, not a wall stack (v0.1.2 field report)', async (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  // The exact first-user scenario: download the builder, run it with no
  // arguments. v0.1.2 shipped a crash here — clode-main's isSea() probed
  // require('node:sea'), the shim had no sea module, the wallProxy threw on
  // the .isSea PROPERTY READ (outside seaMod()'s try/catch), and the QuickJS
  // stack (which carries no `Error: message` header) printed bare. Contract
  // now (task 5, "delete the runner"): clode never runs Claude Code at all —
  // there is no launch path left to fail controlled INTO, so a bare
  // invocation is just an unrecognized command: print the usage error and
  // exit 2, never a bare QuickJS stack.
  const env = { PATH: EMPTY_PATH, HOME: DIR };
  const r = await runNative(NATIVE, [], env, 60000);
  assert.strictEqual(r.status, 2);
  assert.doesNotMatch(r.stderr, /not implemented|at isSea/);
  assert.match(r.stderr, /unknown command/);
});

test('acceptance 2: the native builder BUILDS THE PRODUCT (quaude fuse + PONG + attest), node-free AND template-free', async (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  if (SKIP_PRODUCT) { t.skip(SKIP_PRODUCT); return; }
  // NO CLODE_TJS and no build/tjs on the sandbox paths: the builder must use
  // its EMBEDDED pristine template (Decision 2 — nothing on disk).
  const env = {
    PATH: '/usr/bin:/bin',                    // codesign + sh, no node (probed in before)
    HOME: DIR,                                // hermetic: nothing real is consulted
    CLODE_CLAUDE_BIN: providerBin(),
    CLODE_CACHE: path.join(DIR, 'cache'),     // extraction cache stays in the sandbox
  };
  const r = await runNative(NATIVE, ['build', '--out', QUAUDE], env);
  assert.strictEqual(r.status, 0, `native build failed:\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /clode: fused .*quaude-from-native/);
  assert.match(r.stdout, /PONG round-trip ok, attest ok/);   // the mandatory smoke
  assert.ok(fs.statSync(QUAUDE).size > 30 * 1024 * 1024, 'fused quaude implausibly small');
});

test('acceptance 3: quaude-from-native passes the agentic Bash mock oracle', async (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  if (SKIP_PRODUCT) { t.skip(SKIP_PRODUCT); return; }
  if (!fs.existsSync(QUAUDE)) { t.skip('no quaude-from-native (acceptance 2 did not produce one)'); return; }
  const MARKER = 'CLODE-NATIVE-AGENTIC-MARKER-7311';
  const TOOL_ID = 'toolu_mock_native_bash_1';
  const mock = await startMockAnthropic({
    respond: (body) => body.includes(TOOL_ID)
      ? cannedSSE('TOOLDONE')
      : cannedToolUseSSE('Bash', { command: `echo ${MARKER}` }, TOOL_ID),
  });
  try {
    const env = { ...process.env, ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: 'sk-ant-mock' };
    delete env.NODE_PATH;                     // the product must stay self-contained
    const r = await runNative(QUAUDE, ['-p', 'run the command', '--allowedTools', 'Bash'], env, 120000);
    assert.strictEqual(r.status, 0, `stderr:\n${r.stderr}`);
    assert.match(r.stdout, /TOOLDONE/, `stdout:\n${r.stdout}`);
    const followUp = mock.requests.find((q) => q.method === 'POST' && q.body
      && q.body.includes(TOOL_ID) && q.body.includes('tool_result'));
    assert.ok(followUp, 'no follow-up POST carrying the tool_result');
    assert.ok(followUp.body.includes(MARKER), `tool_result lacks the command's stdout:\n${followUp.body.slice(0, 2000)}`);
  } finally { await mock.close(); }
});
