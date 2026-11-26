'use strict';
// Q1c acceptance: the NATIVE clode builder. `clode bootstrap` blobulates
// ./clode-native (tjs template + builder-role trailer: esbuilt clode-main as a
// source entry, node-shim tree, libexec blobulate inputs, ext-dep closure), and that
// binary must complete the whole chain WITHOUT node:
//   1. --version / --help with PATH stripped to an empty dir;
//   2. `clode-native build` blobulates a quaude whose internal mandatory smoke
//      (canned PONG round-trip + attest) passes — with node absent from PATH
//      (/usr/bin:/bin keeps codesign, loses node) — THE NATIVE BUILDER BUILDS
//      THE PRODUCT;
//   3. the blobulated quaude-from-native passes the agentic Bash mock oracle (the
//      same battery quaude-build.test.cjs runs on the host-node-built quaude).
// Gates: tjs template (all tests) + CLODE_PROVIDER_BIN (the product chain,
// like the sibling bundle-spawning suites). SLOW when enabled: the product
// blobulate runs extraction + a 19MB syntax check + the cli.qbc compile under
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
const { spawnCollect } = require('./spawn-collect.cjs');
const { runCpuBounded } = require('./cpu-bound-run.cjs');
const { throwawayHome } = require('./throwaway-home.cjs');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { tjsPath, skipUnlessTjs, REPO } = require('./node-shim-helper.cjs');
const { startMockAnthropic, cannedSSE, cannedToolUseSSE } = require('./mock-anthropic-helper.cjs');
const { toolResultText, assertFailsOnMissingOutput } = require('../scripts/lib/tool-result.cjs');
const { toolchainDir } = require('../scripts/platform-tag.cjs');
const { stateRoot } = require('./state-root-helper.cjs');

const ENTRY = path.join(REPO, 'scripts', 'stage0.mjs');
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
    // Sibling naude-entry bundle (Task 4): clode-build.cjs's bootstrap staging
    // now copies it from alongside clode-main.bundle.cjs, so a fresh esbuild
    // here must produce both, mirroring scripts/build-clode-main.mjs.
    esbuild.buildSync({
      entryPoints: [path.join(REPO, 'libexec', 'naude-entry.cjs')],
      bundle: true, platform: 'node', format: 'cjs', target: 'node24',
      outfile: path.join(dir, 'naude-entry.bundle.cjs'),
    });
    return out;
  } catch { /* toolchain not installed on this host */ }
  // Fallback: newest already-esbuilt build/*/clode-main.bundle.cjs (generic
  // scan — same rationale as clode-build.cjs's CLODE_MAIN_BUNDLE default).
  // Its sibling naude-entry.bundle.cjs lives in the same tag dir (both are
  // produced by the same build-clode-main.mjs run), so no copy is needed here.
  let tags = [];
  try { tags = fs.readdirSync(buildDir); } catch { return null; }
  let newest = null;
  for (const d of tags) {
    const c = path.join(buildDir, d, 'clode-main.bundle.cjs');
    try { const m = fs.statSync(c).mtimeMs; if (!newest || m > newest.m) newest = { c, m }; } catch { /* */ }
  }
  return newest && newest.c;
}

// Claude Code 2.1.251+ embeds its text assets as zstd frames (host-provision.cjs's
// `zstd` requirement, [[upstream-deps-become-our-deps]]); a carve now genuinely
// needs zstd reachable. Acceptance 2/4 deliberately strip PATH down to
// '/usr/bin:/bin' to PROVE NODE-FREENESS — that PATH is not meant to prove
// zstd-freeness too, and stripping it away just breaks the carve with
// "this provider embeds zstd-compressed assets and this runtime cannot decode
// them". Resolve zstd once, via `CLODE_ZSTD`: an ABSOLUTE-PATH override that
// clode-hosttools.cjs's findTool() honors before ever consulting PATH (line 71:
// `if (override && isExec(override)) return override;`), so passing it keeps the
// minimal PATH intact — node stays excluded, only this one tool becomes reachable
// by name, not by widening PATH. Resolved via the REAL ambient PATH, once, never
// hardcoded to a host location.
function hostZstd() {
  for (const name of ['zstd', 'unzstd', 'zstdcat']) {
    const r = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
    if (r.status === 0 && (r.stdout || '').trim()) return r.stdout.trim();
  }
  return null;
}

let SKIP = null, SKIP_PRODUCT = null, HOST_ZSTD = null;
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
  // Blobulate the builder under HOST node (that is how a dev machine mints it).
  BUILD = spawnSync(process.execPath, [ENTRY, 'bootstrap', '--out', NATIVE], {
    encoding: 'utf8',
    timeout: 300000,
    env: {
      ...process.env,
      CLODE_TJS: tjsPath(),
      CLODE_MAIN_BUNDLE: bundle,
      // stateRoot(): respects test/run.mjs's central CLODE_STATE_ROOT when
      // present, else falls back to this file's own private DIR -- needed
      // for a standalone `node --test` run (run.mjs never executes) and for
      // CI, which invokes this file directly (.github/workflows/ci.yml).
      // This test gates on tjsPath() alone (no CLODE_LIVE_RENDER/
      // CLODE_PROVIDER_BIN), so it runs on EVERY suite pass -- the exact
      // call site proven live-firing into the real ~/.local/share/clode
      // (84 -> 85 lines) before a per-file root existed at all.
      CLODE_STATE_ROOT: stateRoot(DIR),
      DYLD_INSERT_LIBRARIES: '',
    },
  });
  if (!providerBin()) SKIP_PRODUCT = 'no CLODE_PROVIDER_BIN';
  // Proving "no node" needs a PATH that actually lacks node: macOS/Linux keep
  // codesign/sh in /usr/bin:/bin and node lives elsewhere. If this machine has
  // a node THERE, the proof is unavailable — skip rather than lie.
  if (!SKIP_PRODUCT) {
    const probe = spawnSync('sh', ['-c', 'command -v node'], {
      encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME },
    });
    if (probe.status === 0) SKIP_PRODUCT = `node exists on the minimal PATH (${(probe.stdout || '').trim()}); cannot prove node-freeness here`;
  }
  if (!SKIP_PRODUCT) {
    HOST_ZSTD = hostZstd();
    if (!HOST_ZSTD) SKIP_PRODUCT = 'no zstd/unzstd/zstdcat on this host’s PATH — required to carve '
      + 'Claude Code 2.1.251+ (embeds zstd-compressed text assets); set CLODE_ZSTD or install zstd';
  }
});
after(() => { if (DIR) { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } } });

function runNative(bin, args, env, timeoutMs = 600000) {
  return spawnCollect(bin, args, { cwd: DIR, env }, { timeoutMs });
}

// THE BOUND ON A NATIVE BUILD (acceptance 2 and 4): the WORK it does, not the wall clock (test/cpu-bound-run.cjs).
//
// MEASURED 2026-11-19 on this M1 (4 performance + 4 efficiency cores), acceptance 2's build with CLODE_VERBOSE:
//   alone           234 s wall, 216 s CPU. No network. 164 s of it is extracting and SCC-merging the 2.1.283 carve
//                   under tjs (group 1, 51 modules, alone is ~100 s), then template sign 14 s, blobulate 5 s, smoke 4 s.
//   16 CPU hogs     869 s wall (3.7x), 303 s CPU (1.4x: the build is pushed onto the slower efficiency cores).
//   + IO loop
//   E-cores only    (taskpolicy -b) 151 s CPU to the first merge, which alone reaches in at most 62 s: ~2.5x the
//                   CPU for the same work, so a whole build on efficiency cores projects to ~560 s CPU.
//   full suites     245-460 s over 17 runs; one suite ran every test 2.5-3x slower and this row hit 600 s with no
//                   output. Wall time is CPU time over the core share the box gives it, so a wall bound judged the box.
// Acceptance 4 shares DIR/cache with acceptance 2, so its own build is ~35 s WARM; when acceptance 2 dies before it
// has extracted (that suite), acceptance 4 extracts COLD under tjs and is acceptance 2's work again: it hit 600 s in
// the same run. So both rows get the one bound, which covers the cold case.
//   cpuBudgetMs  900 s: 1.6x the all-E-core projection, 4.2x alone. It catches a build doing several times its work
//                (a runaway loop), which the wall clock could only tell from a slow box by guessing.
//   stallMs      120 s with no CPU advance in the whole tree. The longest healthy phase without CPU in the build's own
//                tree is seconds (codesign and the mock smoke both run in it); a box that starves a runnable process
//                for two minutes is not one a row can judge.
//   wallMs       1800 s, about 2x the 16-hog wall, so a starved box ends in a named WALL failure, not the watchdog
//                (test/file-watchdog.cjs's OVERRIDES entry for this file is sized from it).
const BUILD_BOUND = { cpuBudgetMs: 900 * 1000, stallMs: 120 * 1000, wallMs: 1800 * 1000, pollMs: 5000 };
async function runBuild(args, env) {
  const r = await runCpuBounded(NATIVE, args, { cwd: DIR, env }, BUILD_BOUND);
  r.why = `${r.bound ? `BOUND: ${r.bound}\n` : ''}wall ${Math.round(r.wallMs / 1000)} s, CPU ${Math.round(r.cpuMs / 1000)} s${r.cpuSampled ? '' : ' (not sampled)'}`;
  return r;
}

test('clode bootstrap blobulates a native builder and its internal smokes pass', (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  assert.strictEqual(BUILD.status, 0, `clode bootstrap failed:\n${BUILD.stdout}\n${BUILD.stderr}`);
  assert.match(BUILD.stdout, /clode: blobulated .*native clode builder/);
  assert.match(BUILD.stdout, /--version \+ --help ok/);
  assert.ok(fs.statSync(NATIVE).size > 6 * 1024 * 1024, 'blobulated builder implausibly small');
  assert.ok(fs.statSync(NATIVE).mode & 0o111, 'blobulated builder not executable');
});

// Host-node parse of the blobulated-file trailer — see test/quaude-archive.cjs.
const { readTrailerIndex } = require('./quaude-archive.cjs');

test('the blobulated builder embeds the PRISTINE tjs template as a trailer member (Decision 2)', (t) => {
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
  // Phase 3a task 5: help is rendered from libexec/cli-surface.cjs's SURFACE literal,
  // and this binary carries that same literal (esbuilt in), so the assertion reads the
  // table rather than pinning two strings it now owns. What matters here is not the
  // wording but that the BLOBULATED builder — running under tjs with node absent —
  // renders the identical surface the source tree does.
  const { renderHelp, surfaceFor } = require('../libexec/cli-surface.cjs');
  assert.strictEqual(h.stdout, renderHelp(VERSION, surfaceFor('shipped')),
    'the native builder must render the same surface as the source tree');
  // TASK 6: `--self` is gone from the surface entirely — what it did is `clode
  // bootstrap`, a CHECKOUT-only verb. This binary IS the shipped shape, so its help
  // must not mention either spelling.
  assert.doesNotMatch(h.stdout, /--self/);
  assert.doesNotMatch(h.stdout, /bootstrap/);
});

// The shipped-vs-checkout split, proven on the REAL ARTIFACT rather than on the spine
// running under node: a downloaded clode has no bootstrap verb, and says where the verb
// lives instead of a bare "unknown command". It cannot be a conditional in dispatch —
// the binary carries the shipped table, and that table simply has no such entry.
test('acceptance 1c: a shipped clode refuses bootstrap, naming the checkout', async (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  const env = { PATH: EMPTY_PATH, HOME: DIR };
  const r = await runNative(NATIVE, ['bootstrap'], env, 60000);
  assert.strictEqual(r.status, 2, r.stderr);
  assert.match(r.stderr, /checkout/i);
  assert.match(r.stderr, /scripts\/stage0\.mjs bootstrap/);
});

test('acceptance 1b: BARE invocation is brief usage, not a wall stack (v0.1.2 field report)', async (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  // The exact first-user scenario: download the builder, run it with no
  // arguments. v0.1.2 shipped a crash here — clode-main's isSea() probed
  // require('node:sea'), the shim had no sea module, the wallProxy threw on
  // the .isSea PROPERTY READ (outside seaMod()'s try/catch), and the QuickJS
  // stack (which carries no `Error: message` header) printed bare. Contract
  // now (task 5, "delete the runner"): clode never runs Claude Code at all —
  // there is no launch path left to fail controlled INTO, so a bare
  // invocation prints brief usage on stdout and exits 0 (2026-11-25: it used to be
  // "unknown command ''" plus the whole --help, exit 2), never a bare QuickJS stack.
  const env = { PATH: EMPTY_PATH, HOME: DIR };
  const r = await runNative(NATIVE, [], env, 60000);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /not implemented|at isSea|unknown command/);
  assert.match(r.stdout, /clode --help/);
});

test('acceptance 2: the native builder BUILDS THE PRODUCT (quaude blobulate + PONG + attest), node-free AND template-free', async (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  if (SKIP_PRODUCT) { t.skip(SKIP_PRODUCT); return; }
  // NO CLODE_TJS and no build/tjs on the sandbox paths: the builder must use
  // its EMBEDDED pristine template (Decision 2 — nothing on disk).
  const env = {
    PATH: '/usr/bin:/bin',                    // codesign + sh, no node (probed in before)
    HOME: DIR,                                // hermetic: nothing real is consulted
    CLODE_CLAUDE_BIN: providerBin(),
    CLODE_CACHE: path.join(DIR, 'cache'),     // extraction cache stays in the sandbox
    CLODE_ZSTD: HOST_ZSTD,                    // reachable by name, not by widening PATH
  };
  const r = await runBuild(['build', '--out', QUAUDE], env);
  assert.strictEqual(r.status, 0, `native build failed (${r.why}):\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /clode: blobulated .*quaude-from-native/);
  assert.match(r.stdout, /PONG round-trip ok, attest ok/);   // the mandatory smoke
  assert.ok(fs.statSync(QUAUDE).size > 30 * 1024 * 1024, 'blobulated quaude implausibly small');
});

test('acceptance 3: quaude-from-native passes the agentic Bash mock oracle', async (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  if (SKIP_PRODUCT) { t.skip(SKIP_PRODUCT); return; }
  if (!fs.existsSync(QUAUDE)) { t.skip('no quaude-from-native (acceptance 2 did not produce one)'); return; }
  // The judgment reads the tool_result (scripts/lib/tool-result.cjs), and the marker is
  // COMPUTED by the shell, so the output spells it and the command does not. The old check
  // searched the whole follow-up body for `echo ${MARKER}`'s marker, and that body also
  // carries the tool_use: it could not fail on missing output.
  const MARKER = 'CLODE-NATIVE-AGENTIC-MARKER-7311';
  const BASH = { name: 'Bash', input: { command: 'echo CLODE-NATIVE-AGENTIC-MARKER-$((7300+11))' }, id: 'toolu_mock_native_bash_1' };
  const carriesStdout = (m) => toolResultText(m, BASH.id).includes(MARKER);
  assertFailsOnMissingOutput(carriesStdout, BASH);
  const mock = await startMockAnthropic({
    respond: (body) => body.includes(BASH.id)
      ? cannedSSE('TOOLDONE')
      : cannedToolUseSSE(BASH.name, BASH.input, BASH.id),
  });
  try {
    const env = { ...process.env, ...throwawayHome(path.join(DIR, 'acceptance-3')), ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: 'sk-ant-mock' };
    delete env.NODE_PATH;                     // the product must stay self-contained
    const r = await runNative(QUAUDE, ['-p', 'run the command', '--allowedTools', 'Bash'], env, 120000);
    assert.strictEqual(r.status, 0, `stderr:\n${r.stderr}`);
    assert.match(r.stdout, /TOOLDONE/, `stdout:\n${r.stdout}`);
    assert.ok(carriesStdout(mock), `tool_result lacks the command's stdout: ${JSON.stringify(toolResultText(mock, BASH.id).slice(0, 2000))}`);
  } finally { await mock.close(); }
});

test('acceptance 4: the native builder BUILDS A NAUDE (fetch node + assemble + PONG), node absent from PATH', async (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  if (SKIP_PRODUCT) { t.skip(SKIP_PRODUCT); return; }
  // A caller (CI) may point CLODE_NODES at a persistent, cached store so the
  // ~40MB pinned-node download happens once across runs and a transient
  // nodejs.org outage doesn't fail the build; a plain local run gets a hermetic
  // per-test store under DIR.
  const NODES = process.env.CLODE_NODES || path.join(DIR, 'nodes');
  const NAUDE = path.join(DIR, 'naude-from-native');
  // Obtain the pinned Node into a sandbox store via the HOST clode first. This
  // both (a) gates cleanly on the environment — offline / a sha problem fails
  // HERE, distinctly from an assembly bug below — and (b) warms the store so the
  // node-free build proves the ASSEMBLY without a network round-trip inside it.
  // (`clode fetch node` under tjs shares clode-net with the provider fetch,
  // proven elsewhere; the claim under test is that clode-native assembles a
  // working naude with no node on PATH.)
  const fetch = spawnSync(process.execPath, [ENTRY, 'fetch', 'node'], {
    encoding: 'utf8', timeout: 300000,
    env: { ...process.env, CLODE_NODES: NODES, DYLD_INSERT_LIBRARIES: '' },
  });
  if (fetch.status !== 0) { t.skip(`pinned node unavailable in this environment (offline?): ${fetch.stderr || fetch.stdout}`); return; }

  // The proof: clode-native (tjs, no host node) fetches the pinned node from the
  // warm store, materializes its carried assembler + bundle + postject, spawns
  // build-naude UNDER the pinned node, and the resulting naude PONGs — all with
  // node ABSENT from PATH (PATH = /usr/bin:/bin has tar + sh + codesign only).
  const env = {
    PATH: '/usr/bin:/bin',
    HOME: DIR,
    CLODE_CLAUDE_BIN: providerBin(),
    CLODE_CACHE: path.join(DIR, 'cache'),
    CLODE_ZSTD: HOST_ZSTD,                    // reachable by name, not by widening PATH
    CLODE_NODES: NODES,
  };
  const r = await runBuild(['build', 'naude', '--out', NAUDE], env);
  assert.strictEqual(r.status, 0, `native naude build failed (${r.why}):\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /built naude/);
  assert.match(r.stdout, /PONG round-trip ok/);   // the mandatory smoke ran on the built naude
  assert.ok(fs.statSync(NAUDE).size > 30 * 1024 * 1024, 'built naude implausibly small');
});
