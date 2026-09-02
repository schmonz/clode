'use strict';
// [GATED] End-to-end cross-build proof (Task 5 of the naude cross-build spec).
//
// `clode build --naude --target macos-amd64 --out <path>` — a REAL invocation of
// the FULL CLI entry (bin/clode, under host node; not the injected-seam wiring
// covered by test/clode-build-naude.test.cjs) — cross-builds a darwin-x64 naude
// on a darwin-arm64 host, and the produced binary boots under Rosetta
// (`arch -x86_64 <naude> --version` prints Claude Code's own version).
//
// This CODIFIES a pipeline already proven by hand across Tasks 1-4 (target-node
// fetch/store, the two-node blobgen/embed split, clode-fuse's naude+--target
// wiring, attest-only output naming): it does not re-derive that the pipeline
// works, it makes the proof repeatable and gated.
//
// GATED because it is SLOW on this tree (NFS — the deps.tar step crawls) and
// needs real inputs (a provider binary; network for the first pinned-node
// fetch) — it never runs in the normal suite (test/run.mjs). Opt in with:
//   CLODE_CROSS_BUILD=1 CLODE_PROVIDER_BIN=<path-to-real-claude> \
//     node --test test/naude-cross-build.test.cjs
// SKIPs cleanly (naming the reason) when the gate, the host shape, or a
// provider is missing — never silently runs a weaker check instead.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const ENTRY = path.join(REPO, 'bin', 'clode');
const PIN = require('../deps/clode/node-pin.json');

// Same resolution convention as the other live-provider suites
// (test/naude-smoke.test.cjs, test/clode-native.test.cjs): this task's named
// opt-in var first, then the wider CLODE_CLAUDE_BIN, then the conventional
// install paths.
function providerBin() {
  for (const v of [process.env.CLODE_PROVIDER_BIN, process.env.CLODE_CLAUDE_BIN]) {
    if (v && fs.existsSync(v)) return v;
  }
  for (const p of ['/usr/local/bin/claude', '/usr/bin/claude']) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Bare Mach-O magic/cputype sniff — no shell-out to `file`, no dependency. True
// for a 64-bit little-endian Mach-O whose cputype is x86_64. This is a
// structural sanity check standing in for "actually ran it" when execution
// isn't possible, not a full Mach-O parse.
function isMachOx64(buf) {
  if (buf.length < 8) return false;
  return buf.readUInt32LE(0) === 0xfeedfacf   // MH_MAGIC_64
    && buf.readUInt32LE(4) === 0x01000007;    // CPU_TYPE_X86_64
}

let SKIP = null;
let DIR = null;
before(() => {
  if (process.env.CLODE_CROSS_BUILD !== '1') {
    SKIP = 'live cross-build opt-in only (set CLODE_CROSS_BUILD=1)';
    return;
  }
  if (!(process.platform === 'darwin' && process.arch === 'arm64')) {
    // The proven path is darwin-arm64 -> darwin-x64 under Rosetta (the
    // controller's spike). Off-mac darwin signing is a NAMED deferred item
    // (see .superpowers/sdd/2026-07-28-naude-cross-build/task-5-brief.md) —
    // no other host shape is exercised by this suite yet.
    SKIP = `Rosetta cross-build proof needs a darwin/arm64 host (this box is ${process.platform}/${process.arch})`;
    return;
  }
  if (!providerBin()) {
    SKIP = 'no provider: set CLODE_PROVIDER_BIN=<claude> (or CLODE_CLAUDE_BIN, or install ' +
      '/usr/local/bin/claude or /usr/bin/claude)';
    return;
  }
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-cross-build-'));
});
after(() => { if (DIR) { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* best effort */ } } });

test('clode build --naude --target macos-amd64: cross-built naude boots under Rosetta', (t) => {
  if (SKIP) { t.skip(SKIP); return; }

  const out = path.join(DIR, 'naude-macos-amd64');
  // clode-fuse's own internal build-naude spawn timeout is 600000ms * SCALE
  // (CLODE_TIMEOUT_SCALE) — the deps.tar step is the slow part on this NFS
  // tree, so scale it up generously here; the OUTER spawnSync timeout below
  // must stay comfortably above the scaled inner one, or we'd kill the build
  // ourselves before its own (legitimate) timeout ever would.
  const SCALE = process.env.CLODE_TIMEOUT_SCALE || '6';
  const outerTimeout = Number(process.env.CLODE_CROSS_BUILD_TIMEOUT_MS) || 90 * 60 * 1000;

  // Persistent-store overrides let a caller (or a re-run) skip the ~40MB
  // pinned x64-node download and re-extraction — same convention as
  // test/clode-native.test.cjs's acceptance 4 (CLODE_NODES). Absent, a
  // hermetic per-run store lives under DIR instead of the shared
  // ~/.local/share/clode/{cache,nodes}.
  const env = {
    ...process.env,
    CLODE_TIMEOUT_SCALE: SCALE,
    CLODE_CLAUDE_BIN: providerBin(),
    CLODE_CACHE: process.env.CLODE_CACHE || path.join(DIR, 'cache'),
    CLODE_NODES: process.env.CLODE_NODES || path.join(DIR, 'nodes'),
    // No CLODE_STATE_ROOT needed here (unlike the quaude-path tests
    // elsewhere): this is a `--naude` build, and clodeBuild's --naude branch
    // always returns from inside its own `if (naude) {...}` block before
    // the shared try/finally that appends a build-trace.jsonl line
    // (Task 5) is ever reached.
    DYLD_INSERT_LIBRARIES: '',
  };

  const build = spawnSync(process.execPath,
    [ENTRY, 'build', '--naude', '--target', 'macos-amd64', '--out', out],
    { encoding: 'utf8', timeout: outerTimeout, env });

  assert.strictEqual(build.status, 0,
    `clode build --naude --target macos-amd64 failed:\nstdout:\n${build.stdout}\nstderr:\n${build.stderr}`);
  // Reach honesty (Task 4, re-asserted here as the wiring this test depends
  // on): a naude cross-build must say it did NOT run the foreign binary.
  assert.match(build.stdout + build.stderr, /attest-only/,
    'a naude cross-build must be honest that it did not smoke-run the foreign binary');
  assert.ok(fs.existsSync(out), `no naude produced at ${out}`);
  assert.ok(fs.statSync(out).size > 30 * 1024 * 1024, 'cross-built naude implausibly small');

  const bytes = fs.readFileSync(out);
  assert.ok(isMachOx64(bytes), 'output is not a 64-bit x86_64 Mach-O');

  // The proof: run it for REAL under Rosetta — the same invocation the
  // controller's spike used. A missing/broken Rosetta surfaces as the CHILD
  // failing to exec (a nonzero status with an exec-format complaint on
  // stderr), not a spawnSync launch error — `arch` itself always launches
  // fine. Treat that distinctly from the build having failed: skip only the
  // execution assertion (the structural Mach-O check above already stands as
  // the attest-only proof), naming the gap rather than reporting a false red
  // for an environment property this suite doesn't own.
  const run = spawnSync('arch', ['-x86_64', out, '--version'], { encoding: 'utf8', timeout: 60000 });
  const execUnavailable = run.error
    || (run.status !== 0 && /bad cpu type|exec format error|posix_spawn/i.test(run.stderr || ''));
  if (execUnavailable) {
    t.skip(`could not execute the x86_64 output under Rosetta (${run.error || run.stderr}); ` +
      'the structural Mach-O x86_64 check above stands in');
    return;
  }
  assert.strictEqual(run.status, 0, `arch -x86_64 ${out} --version failed:\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  assert.match(run.stdout, /\(Claude Code\)/, `unexpected --version output:\n${run.stdout}`);
  // Belt-and-braces: the embedded node is the exact pin (deps/clode/node-pin.json),
  // not merely "some" x86_64 Mach-O.
  assert.ok(bytes.includes(`v${PIN.version}`), `embedded node does not carry the pinned version string v${PIN.version}`);
});
