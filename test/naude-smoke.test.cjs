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
// libexec/extract-claude-js.cjs <bin> <out> writes the baked Claude Code JS.
// build-naude requires bun-shim.cjs staged BESIDE the --cli (it is version-locked
// to the bundle by the extract cache — a bare cli.cjs is rejected, which is what
// `clode build --naude` stages from its cache dir). Mirror that here: copy the
// checkout's libexec/bun-shim.cjs next to the extracted cli.cjs.
// ONE STAGING PATH, shared with every other oracle: test/oracle-models.cjs stageCli runs
// clode's own cached extraction, which merges upstream's residual cyclic requires away.
// Spawning libexec/extract-claude-js.cjs directly (what this did until 2026-08-29) bakes a
// cli.cjs no built target ever runs — and from 2.1.243 that difference is fatal at the
// first turn, which is exactly the row below.
function stageCli(bin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naude-smoke-stage-'));
  return require('./oracle-models.cjs').stageCli(bin, { dir });
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

// THE NAUDE ATTEST GATE, ON A REAL NAUDE. The unit tests drive attestSelf against a fake
// SEA; `clode build --naude` refuses to report success unless the real binary attests. That
// refusal is worth nothing unless a corrupted naude actually answers differently, so: build
// one, flip a byte inside a real asset, and require the verdict to change.
//
// Re-signing after the flip is NOT weakening the test — it is the only way to reach attest
// at all on macOS. An ad-hoc-signed Mach-O with one byte changed is SIGKILLed by the kernel
// before any of our code runs (observed: exit 137), which proves the OS noticed and proves
// nothing about our gate. Ad-hoc re-signing hands the corrupted payload to a binary the OS
// is willing to start, which is exactly the case attest exists for.
test('naude: a tampered asset fails --clode-attest (the build gate can fail)', async (t) => {
  const reason = skipReason();
  if (reason) { t.skip(reason); return; }
  const { seaBin } = require('../scripts/platform-tag.cjs');
  const { ATTEST_VERIFIED, ATTEST_FAILED } = require('../libexec/clode-attest.cjs');
  const naude = seaBin(REPO, 'naude');
  assert.ok(fs.existsSync(naude), `no naude at ${naude} — the build test above must run first`);

  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'naude-attest-cache-'));
  const tampered = path.join(cache, path.basename(naude) + '.tampered');
  try {
    // Sanity: the pristine binary attests clean, so a FAIL below is the tampering.
    const clean = await run(naude, ['--clode-attest'], { env: { ...process.env, NAUDE_CACHE: cache }, timeout: 180000 });
    assert.strictEqual(clean.status, 0, `pristine naude did not attest:\n${clean.stdout}\n${clean.stderr}`);
    assert.ok(clean.stdout.includes(ATTEST_VERIFIED), clean.stdout);

    // Flip one byte inside a REAL asset's bytes (located by searching for the asset's own
    // file content), so the flip is guaranteed to land in hashed payload, not in slack.
    const assetBytes = fs.readFileSync(path.join(REPO, 'libexec', 'target-update-check.cjs'));
    const bytes = fs.readFileSync(naude);
    const at = bytes.indexOf(assetBytes);
    assert.ok(at >= 0, 'could not find the target-update-check.cjs asset inside the SEA image');
    bytes[at + 10] ^= 0xff;
    fs.writeFileSync(tampered, bytes);
    fs.chmodSync(tampered, 0o755);
    if (process.platform === 'darwin') {
      execFileSync('codesign', ['-f', '-s', '-', tampered], { stdio: 'ignore' });
    }

    const r = await run(tampered, ['--clode-attest'], { env: { ...process.env, NAUDE_CACHE: cache }, timeout: 180000 });
    assert.notStrictEqual(r.status, 0, `a tampered naude exited 0:\n${r.stdout}\n${r.stderr}`);
    assert.ok(!r.stdout.includes(ATTEST_VERIFIED),
      `the tampered binary still printed the verdict the build gate greps:\n${r.stdout}`);
    assert.ok(r.stdout.includes('FAIL target-update-check.cjs') && r.stdout.includes(ATTEST_FAILED),
      `no failure reported:\n${r.stdout}\n${r.stderr}`);
  } finally {
    fs.rmSync(cache, { recursive: true, force: true });
  }
});
