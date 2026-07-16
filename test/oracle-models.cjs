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

module.exports = { REPO, LOADER, DEPS, runNaudeModel, runQuaudeModel };
