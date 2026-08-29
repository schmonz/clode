'use strict';
// The oracle's two runtime models — how each build target runs a cli.cjs.
//
//   naude-model:  node cli.cjs …                       (real Node built-ins)
//   quaude-model: tjs run node-shim/loader.cjs cli.cjs … (the shim under test)
//
// These mirror what the PACKAGED binaries do (a naude SEA re-invokes its embedded
// node on the baked cli.cjs; a fused quaude boots cli.qbc under tjs + the shim),
// so the parity gate can diff the two runtimes WITHOUT bin/clode or CLODE_ENGINE.
// Both are gone in the builder-only surface; the oracle outlives them.
//
// The caller stages cli.cjs and bun-shim.cjs into the same dir (see stageBundle):
// the extractor injects a __dirname-relative require of bun-shim.cjs into cli.cjs,
// and NODE_PATH supplies the ext-deps.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { tjsBin } = require('../scripts/platform-tag.cjs');

const REPO = path.resolve(__dirname, '..');
const LOADER = path.join(REPO, 'libexec/node-shim/loader.cjs');
// Claude Code's ext-deps (deps/claude/package.json) — NOT clode's own; clode
// has none (test/clode-self-deps.test.cjs). Both models load cli.cjs, which
// requires these.
const DEPS = path.join(REPO, 'deps', 'claude', 'node_modules');

// NODE_PATH := our ext-deps, ahead of anything the caller already had. Never
// carries CLODE_ENGINE through: the models ARE the engine choice.
function modelEnv(opts) {
  const env = { ...(opts.env || {}) };
  env.NODE_PATH = env.NODE_PATH ? DEPS + path.delimiter + env.NODE_PATH : DEPS;
  delete env.CLODE_ENGINE;
  return env;
}

// The argv each model runs. One builder, so the sync and async dispatches can
// never drift apart on the thing the oracle is actually comparing.
function naudeCommand(cli, args, opts) {
  return { cmd: opts.node || process.execPath, argv: [cli, ...args] };
}
function quaudeCommand(cli, args, opts) {
  const tjs = opts.tjs || process.env.CLODE_TJS || tjsBin(REPO);
  return { cmd: tjs, argv: ['run', LOADER, cli, ...args] };
}

function dispatchSync({ cmd, argv }, opts) {
  const spawn = opts.spawn || require('node:child_process').spawnSync;
  const r = spawn(cmd, argv, {
    encoding: 'utf8',
    input: opts.input !== undefined ? opts.input : '',
    cwd: opts.cwd,
    env: modelEnv(opts),
    timeout: opts.timeout,
  });
  return { status: r.status, signal: r.signal ?? null, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// Async dispatch. REQUIRED whenever the caller hosts the mock Anthropic server
// in-process: spawnSync blocks this event loop until the child exits, so the
// mock can never accept the child's connection and both sides wait forever.
// (Repros with a bare http server + a spawnSync'd client — it is an event-loop
// property, not a bundle bug.) stdin is 'ignore' so `-p` does not block on it.
function dispatchAsync({ cmd, argv }, opts) {
  const spawn = opts.spawn || require('node:child_process').spawn;
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(cmd, argv, {
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: modelEnv(opts),
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const to = opts.timeout ? setTimeout(() => child.kill('SIGKILL'), opts.timeout) : null;
    const done = (status, signal) => { if (to) clearTimeout(to); resolve({ status, signal: signal ?? null, stdout, stderr, ms: Date.now() - t0 }); };
    child.on('exit', (status, signal) => done(status, signal));
    child.on('error', (e) => { stderr += String(e); done(null, null); });
  });
}

// naude-model — what a naude binary does: run the baked cli.cjs under node.
function runNaudeModel(cli, args = [], opts = {}) {
  return dispatchSync(naudeCommand(cli, args, opts), opts);
}
function runNaudeModelAsync(cli, args = [], opts = {}) {
  return dispatchAsync(naudeCommand(cli, args, opts), opts);
}

// quaude-model — what a quaude binary does: run cli under tjs + the node-shim.
function runQuaudeModel(cli, args = [], opts = {}) {
  return dispatchSync(quaudeCommand(cli, args, opts), opts);
}
function runQuaudeModelAsync(cli, args = [], opts = {}) {
  return dispatchAsync(quaudeCommand(cli, args, opts), opts);
}

// A PACKAGED target (a built naude or quaude): it carries its own engine and its
// own baked cli.cjs, so it takes the user's args directly. Same async dispatch —
// the mock server lives in the caller's event loop either way.
function runBinaryAsync(bin, args = [], opts = {}) {
  return dispatchAsync({ cmd: bin, argv: args }, opts);
}

// The provider both models bake: the upstream Bun-packaged CC binary. Honors the
// tests' CLODE_PROVIDER_BIN first, else clode's own resolution (CLODE_CLAUDE_BIN,
// the provider store, PATH).
function resolveProviderBin(env = process.env) {
  const explicit = env.CLODE_PROVIDER_BIN;
  if (explicit) return fs.existsSync(explicit) ? explicit : null;
  const resolve = require(path.join(REPO, 'libexec/clode-resolve.cjs'));
  const bin = resolve.resolveClaudeBin({ env });
  if (!bin || !resolve.pathExists(bin)) return null;
  return resolve.followWrapper(bin);
}

// Carve cli.cjs out of a provider and stage it beside bun-shim.cjs — the layout
// both models require (the extractor injects a __dirname-relative bun-shim
// require into cli.cjs). This is a naude's payload, unpackaged.
//
// THROUGH CLODE'S OWN STAGING, deliberately, and not by spawning
// libexec/extract-claude-js.cjs the way this did until 2026-08-29. The raw extractor
// emits a graph runner from the graph EXACTLY as upstream shipped it, residual cyclic
// `import.meta.require("/$bunfs/root/chunk-….js")` edges and all; only clode's staging
// (libexec/clode-extract.cjs) merges those away. So the oracle was running a cli.cjs
// that no built target ever runs — and from Claude Code 2.1.243, when the CLI became a
// code-split graph, that difference stopped being cosmetic: the mock round-trip, both
// agentic rows, the credentialed-dispatch rows and the naude reference all died on the
// first residual require, in five CI jobs at once, while `clode build` stayed green.
//
// The cache dir is clode's real layout under a TEMP root (never ~/.cache/clode: a test
// must not seed the operator's store, and a fresh runner would trip the hermeticity
// gate). It is keyed like clode's own — one merge per provider per job, not one per
// test file — and the per-test dir gets copies, because callers use it as a cwd and
// write into it.
function stageCli(bin, opts = {}) {
  const dir = opts.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-stage-'));
  const cli = path.join(dir, 'cli.cjs');
  const { cacheKey } = require(path.join(REPO, 'libexec/clode-resolve.cjs'));
  const { extractIfNeeded } = require(path.join(REPO, 'libexec/clode-extract.cjs'));
  const root = process.env.CLODE_ORACLE_STAGE_ROOT
    || path.join(os.tmpdir(), 'clode-oracle-stage');
  const cacheDir = path.join(root, cacheKey(bin));
  extractIfNeeded({
    bin,
    cacheDir,
    libexec: path.join(REPO, 'libexec'),
    verbose: !!process.env.CLODE_VERBOSE,
  });
  fs.copyFileSync(path.join(cacheDir, 'cli.cjs'), cli);
  fs.copyFileSync(path.join(cacheDir, 'bun-shim.cjs'), path.join(dir, 'bun-shim.cjs'));
  return { dir, cli, cacheDir };
}

// Resolve + stage in one step; null when no usable provider exists (the local
// /usr/local/bin/claude is not necessarily Bun-packaged — the extractor rejects
// what it cannot carve). Callers SKIP rather than fail on null.
function stageProviderCli(opts = {}) {
  const bin = opts.bin || resolveProviderBin(opts.env || process.env);
  if (!bin) return null;
  try {
    return stageCli(bin, opts);
  } catch {
    return null;
  }
}

module.exports = {
  REPO, LOADER, DEPS,
  runNaudeModel, runQuaudeModel,
  runNaudeModelAsync, runQuaudeModelAsync, runBinaryAsync,
  resolveProviderBin, stageCli, stageProviderCli,
};
