'use strict';
// [NODE-HOST] The naude end-to-end proof: build a REAL naude (Claude Code baked
// into a Node SEA) and boot it against the offline mock Anthropic server. A naude
// `-p 'say PONG'` must materialize its embedded assets, run the baked cli.cjs, hit
// the mock's /messages, print PONG, and exit 0 — with no module-resolution or
// "not implemented" breakage in stderr.
//
// This CANNOT run on this box (macOS 10.9 / old Node): building a SEA needs esbuild
// + postject and Node >= 24, and materializing/injecting the blob is a Node>=24
// feature. So the test is GATED and SKIPs cleanly here. It is written to be a real,
// honest build+boot+PONG check on any Node >= 24 host / CI — nothing is stubbed; the
// gate is the ONLY thing that keeps it from executing off-host.
//
// To exercise it on a Node >= 24 host with a real provider present:
//   CLODE_NAUDE_SMOKE=1 CLODE_CLAUDE_BIN=/path/to/claude \
//     node --test test/naude-smoke.test.cjs
// (or drop CLODE_CLAUDE_BIN if /usr/local/bin/claude or /usr/bin/claude exists.)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');

// Resolve the provider (real claude binary) the same way the build does: an explicit
// CLODE_CLAUDE_BIN override, else the conventional install paths. Returns the path or
// null. Kept to plain fs.existsSync so requiring this file never touches a node-host-
// only module — the whole gate must be evaluable on THIS old box.
function providerBin() {
  const explicit = process.env.CLODE_CLAUDE_BIN;
  if (explicit) return fs.existsSync(explicit) ? explicit : null;
  for (const p of ['/usr/local/bin/claude', '/usr/bin/claude']) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function nodeMajor() {
  return parseInt(String(process.versions.node).split('.')[0], 10);
}

// The single reason-string for the SKIP: names exactly what is missing so an operator
// knows what to set to enable it. Returns null when the gate is fully open.
function skipReason() {
  if (process.env.CLODE_NAUDE_SMOKE !== '1') {
    return 'opt-in only: set CLODE_NAUDE_SMOKE=1 to run the real naude build+boot smoke';
  }
  if (nodeMajor() < 24) {
    return `needs Node >= 24 to build a SEA (esbuild/postject); this host is Node ${process.versions.node}`;
  }
  if (!providerBin()) {
    return 'no provider: set CLODE_CLAUDE_BIN=<claude> or install /usr/local/bin/claude or /usr/bin/claude';
  }
  return null;
}

// Extract a fresh cli.cjs from the real provider, mirroring the oracle's stageBundle:
// libexec/extract-claude-js.cjs <bin> <out> writes the baked Claude Code JS. We only
// need cli.cjs here (build-naude bakes bun-shim.cjs itself).
function stageCli(bin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naude-smoke-stage-'));
  const cli = path.join(dir, 'cli.cjs');
  execFileSync(process.execPath, [path.join(REPO, 'libexec/extract-claude-js.cjs'), bin, cli], { stdio: 'pipe' });
  return { dir, cli };
}

// Run the naude binary asynchronously (NOT spawnSync): the mock Anthropic server lives
// in THIS process, so spawnSync would block our event loop and the child would hang
// forever waiting on a response the mock can never send. (Same rationale documented in
// test/node-shim-roundtrip-oracle.test.cjs.)
function run(bin, args, opts) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { env: opts.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, opts.timeout || 180000);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ status: code, stdout, stderr }); });
  });
}

test('naude: real SEA build boots the baked CC and answers PONG offline', async (t) => {
  const reason = skipReason();
  if (reason) { t.skip(reason); return; }

  // Node-host-only requires, deferred to the enabled path so requiring this test file
  // on the old box never loads esbuild-shaped machinery or the mock harness.
  const { seaBin } = require('../scripts/platform-tag.cjs');
  const { startMockAnthropic } = require('./mock-anthropic-helper.cjs');

  const bin = providerBin();
  const { cli } = stageCli(bin);

  // Build the real naude, baking the staged cli.cjs. This runs the full pipeline
  // (esbuild the entry, stage deps, SEA-config, postject inject, sign, self-check).
  execFileSync(process.execPath, [path.join(REPO, 'scripts/build-naude.mjs'), '--cli', cli], {
    stdio: 'inherit',
    cwd: REPO,
    timeout: 600000,
  });

  const naude = seaBin(REPO, 'naude');
  assert.ok(fs.existsSync(naude), `naude binary was not produced at ${naude}`);

  const mock = await startMockAnthropic();
  // Isolate the SEA's asset-materialization cache so the smoke run can't collide with
  // a concurrent build's self-check cache.
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'naude-smoke-cache-'));
  try {
    const r = await run(naude, ['-p', 'say PONG'], {
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: mock.url,
        ANTHROPIC_API_KEY: 'sk-ant-mock',   // dummy; the mock ignores it. NOT a secret.
        NAUDE_CACHE: cache,
      },
      timeout: 180000,
    });
    assert.strictEqual(r.status, 0, `naude exited ${r.status}; stderr:\n${r.stderr}`);
    assert.match(r.stdout, /PONG/, `stdout was:\n${r.stdout}`);
    assert.doesNotMatch(r.stderr, /Cannot find module|MODULE_NOT_FOUND|not implemented/,
      `naude stderr had a boot/resolution error:\n${r.stderr}`);
    assert.ok(mock.requests.some((q) => q.method === 'POST' && /\/messages$/.test(q.url.split('?')[0])),
      `naude never POSTed the messages endpoint; hit: ${JSON.stringify(mock.requests.map((q) => q.method + ' ' + q.url))}`);
  } finally {
    await mock.close();
    fs.rmSync(cache, { recursive: true, force: true });
  }
});
