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

const REPO = path.resolve(__dirname, '..');
const LOADER = path.join(REPO, 'libexec/node-shim/loader.cjs');
const DEPS = path.join(REPO, 'node_modules');

// NODE_PATH := our ext-deps, ahead of anything the caller already had. Never
// carries CLODE_ENGINE through: the models ARE the engine choice.
function modelEnv(opts) {
  const env = { ...(opts.env || {}) };
  env.NODE_PATH = env.NODE_PATH ? DEPS + path.delimiter + env.NODE_PATH : DEPS;
  delete env.CLODE_ENGINE;
  return env;
}

function dispatch(cmd, args, opts) {
  const spawn = opts.spawn || require('node:child_process').spawnSync;
  const r = spawn(cmd, args, {
    encoding: 'utf8',
    input: opts.input !== undefined ? opts.input : '',
    cwd: opts.cwd,
    env: modelEnv(opts),
    timeout: opts.timeout,
  });
  return { status: r.status, signal: r.signal ?? null, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// naude-model — what a naude binary does: run the baked cli.cjs under node.
function runNaudeModel(cli, args = [], opts = {}) {
  const node = opts.node || process.execPath;
  return dispatch(node, [cli, ...args], opts);
}

// quaude-model — what a quaude binary does: run cli under tjs + the node-shim.
function runQuaudeModel(cli, args = [], opts = {}) {
  const tjs = opts.tjs || process.env.CLODE_TJS || path.join(REPO, 'build/tjs/tjs');
  return dispatch(tjs, ['run', LOADER, cli, ...args], opts);
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
function stageCli(bin, opts = {}) {
  const dir = opts.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'oracle-stage-'));
  const cli = path.join(dir, 'cli.cjs');
  const exec = opts.execFileSync || require('node:child_process').execFileSync;
  exec(process.execPath, [path.join(REPO, 'libexec/extract-claude-js.cjs'), bin, cli], { stdio: 'pipe' });
  fs.copyFileSync(path.join(REPO, 'libexec/bun-shim.cjs'), path.join(dir, 'bun-shim.cjs'));
  return { dir, cli };
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
  resolveProviderBin, stageCli, stageProviderCli,
};
