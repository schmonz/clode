#!/usr/bin/env node
// clode API-surface gate — v1. See docs/superpowers/specs/2026-07-08-api-surface-gate-design.md
//
// Two axes over a seed corpus of Claude Code invocations, run under clode's two
// BUILD TARGETS' runtimes (see test/oracle-models.cjs) rather than any launcher:
//   naude  — cli.cjs under real node. The REFERENCE (native built-ins).
//   quaude — cli.cjs under tjs + the node-shim. The SUBJECT.
// Both run the SAME staged cli.cjs, so the only variable is the engine.
//
//   Axis 1 (presence):    collect the union of [wall] misses (exercised-but-
//                         unimplemented APIs) on the quaude side — the polyfill
//                         work-list.
//   Axis 2 (correctness): flag exit-code divergence always, and stdout divergence
//                         for the deterministic commands (model prose is non-
//                         deterministic, so `-p` prompts are exit+wall only).
// Plus a cross-version require-target set-diff ("did the surface expand?").
//
// Exit non-zero on any wall miss or (applicable) divergence — this is a CI gate.
// Needs a Bun-packaged CC provider to stage cli.cjs; without one it SKIPS (exit 0).
import { readFileSync, existsSync, readdirSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';
import os from 'node:os';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const models = require(path.join(REPO, 'test', 'oracle-models.cjs'));
const TIMEOUT = 60000;

// Seed corpus. `deterministic` commands get strict stdout parity; `-p` model
// prompts are compared on exit code + walls only (prose varies run to run).
const CORPUS = [
  { id: 'version',  args: ['--version'],                              deterministic: true  },
  { id: 'help',     args: ['--help'],                                 deterministic: true  },
  { id: 'bad-flag', args: ['--no-such-flag-xyz-123'],                 deterministic: true  },
  { id: 'p-plain',  args: ['-p', 'reply with only the word: OK'],     deterministic: false },
  { id: 'p-arith',  args: ['-p', 'what is 6 times 7? reply with only the number'], deterministic: false },
  // Tool-bearing rows. The 2026-08-06 hunt showed the interesting gaps are NOT
  // on the plain -p path: fs/promises.statfs surfaced only on an error path, and
  // the missing 'spawn' event only when a child was driven as a transport. A
  // corpus that never spawns a tool cannot see either.
  { id: 'p-json',   args: ['-p', '--output-format', 'json', 'say PONG'],   deterministic: false },
  { id: 'p-stream', args: ['-p', '--output-format', 'stream-json', '--verbose', 'say PONG'], deterministic: false },
  { id: 'p-tools',  args: ['-p', '--permission-mode', 'bypassPermissions', 'run a command'], deterministic: false },
];

function wallsOf(stderr) {
  return [...new Set((stderr || '')
    .split('\n').filter((l) => l.includes('[wall]'))
    .map((l) => l.replace(/^.*\[wall\]\s*/, '').trim()).filter(Boolean))];
}

function requireTargets(file) {
  if (!existsSync(file)) return null;
  const src = readFileSync(file, 'utf8');
  const set = new Set();
  for (const m of src.matchAll(/(?:require|__require)\("([a-zA-Z0-9_/:@.-]+)"\)/g)) set.add(m[1]);
  return set;
}

function cachedVersions() {
  const dir = path.join(os.homedir(), '.cache', 'clode');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((v) => existsSync(path.join(dir, v, 'cli.cjs')))
    .sort();
}

function versionDelta(log) {
  log('\n## Version delta — require-target set-diff');
  const vers = cachedVersions();
  if (vers.length < 2) { log('  (need >=2 cached versions)'); return; }
  const [a, b] = [vers[vers.length - 2], vers[vers.length - 1]];
  const sa = requireTargets(path.join(os.homedir(), '.cache', 'clode', a, 'cli.cjs'));
  const sb = requireTargets(path.join(os.homedir(), '.cache', 'clode', b, 'cli.cjs'));
  log(`  ${a} (${sa.size}) -> ${b} (${sb.size})`);
  log('  added:   ' + ([...sb].filter((x) => !sa.has(x)).join(', ') || '(none)'));
  log('  removed: ' + ([...sa].filter((x) => !sb.has(x)).join(', ') || '(none)'));
}

// The gate. Everything it touches the world through is injectable, so the wiring
// and the axes are unit-testable without a provider (test/apicheck-decoupled).
// Returns the process exit status.

// ---- Axis 3: runtime PROBE hits ---------------------------------------------
// libexec/node-shim/internal/probe.cjs logs every missing-property READ on a
// broad shim builtin under CLODE_SHIM_PROBE=1, without changing behavior. That
// is the only axis that sees the defect class the other two structurally miss:
// a property the bundle READS and then CALLS. Axis 1 (walls) never fires for it
// — broad modules keep node's "missing prop = undefined" idiom on purpose — and
// the STATIC map (test/shim-surface/golden.json) missed both 2026-08-06 defects
// (fs/promises.statfs, reached via a minified alias; and the ChildProcess
// 'spawn' EVENT, which is not a property at all).
const PROBE_GOLDEN = path.join(REPO, 'test', 'shim-surface', 'probe-golden.json');
function probesOf(stderr) {
  const out = new Set();
  for (const line of String(stderr || '').split('\n')) {
    const m = /^\[probe\] (\S+?)(?: \(in\))?$/.exec(line.trim());
    if (m) out.add(m[1]);
  }
  return [...out];
}
function benignProbes() {
  if (!existsSync(PROBE_GOLDEN)) return new Set();
  try {
    const g = JSON.parse(readFileSync(PROBE_GOLDEN, 'utf8'));
    return new Set((g.benign || []).map((e) => e.prop));
  } catch { return new Set(); }
}

// A mock Anthropic endpoint, so the gate is HERMETIC and safe to run in CI.
// Without it the corpus's -p items hit the real API with whoever's credentials
// are lying around — billable, and dependent on the runner being logged in.
function startMock() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'apicheck-mock-'));
  const urlFile = path.join(dir, 'url');
  const child = spawn(process.execPath, [path.join(REPO, 'test', 'mock-anthropic-child.cjs'),
    '--url-file', urlFile], { stdio: 'ignore', detached: false });
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (existsSync(urlFile)) {
      const url = readFileSync(urlFile, 'utf8').trim();
      if (url) return { url, stop: () => { try { child.kill('SIGTERM'); } catch {} rmSync(dir, { recursive: true, force: true }); } };
    }
    // Synchronous sleep: this driver is sync by design (spawnSync dispatch), so
    // it cannot await. Atomics.wait on a throwaway buffer blocks without burning
    // CPU and needs no child process. (Node's main thread permits this; tjs's
    // does not — but the GATE always runs under node, never under the shim.)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  try { child.kill('SIGTERM'); } catch {}
  rmSync(dir, { recursive: true, force: true });
  return null;
}

export function runGate(opts = {}) {
  const log = opts.log || ((s) => console.log(s));
  const corpus = opts.corpus || CORPUS;
  const runNaude = opts.runNaude || models.runNaudeModel;
  const runQuaude = opts.runQuaude || models.runQuaudeModel;
  const stage = opts.stage || (() => models.stageProviderCli({ env: opts.env || process.env }));

  log('# clode API-surface gate (v1: naude reference vs quaude subject)\n');

  const staged = stage();
  // stageProviderCli distinguishes "no provider at all" (null) from "a provider
  // was FOUND and staging it threw" ({ error }) — a `if (!staged)` check alone is
  // false on the latter, because that object is truthy, and the gate would run on
  // with staged.cli === undefined instead of saying what went wrong. Ask
  // providerSkipReason which case this is; it returns null only on real success.
  const stageSkip = models.providerSkipReason(staged, 'no Bun-packaged Claude Code provider resolved.');
  if (stageSkip) {
    log(`SKIP: ${stageSkip}`);
    log('  The gate stages cli.cjs from a real provider binary; point CLODE_PROVIDER_BIN');
    log("  or CLODE_CLAUDE_BIN at one, or run 'clode fetch'.");
    return 0;
  }

  // HERMETIC by construction. Previously this inherited the caller's HOME and had
  // no mock, so it read whoever's ~/.claude was present and sent the -p corpus to
  // the REAL API — billable, and dependent on the runner being logged in. Neither
  // is acceptable for something meant to gate CI.
  const home = opts.home || mkdtempSync(path.join(os.tmpdir(), 'apicheck-home-'));
  const ownHome = !opts.home;
  mkdirSync(path.join(home, '.claude'), { recursive: true });
  const mock = opts.mockUrl ? { url: opts.mockUrl, stop: () => {} } : startMock();
  if (!mock) {
    log('SKIP: could not start the mock Anthropic endpoint.');
    if (ownHome) rmSync(home, { recursive: true, force: true });
    return 0;
  }
  const baseEnv = {
    ...(opts.env || process.env),
    HOME: home,
    ANTHROPIC_BASE_URL: mock.url,
    ANTHROPIC_API_KEY: 'sk-ant-mock',   // dummy; the mock ignores it. NOT a secret.
    CLODE_DEPS: path.join(home, 'deps'),
    CLODE_CACHE: path.join(home, 'cache'),
  };
  const allWalls = new Set();
  const allProbes = new Set();
  const divergences = [];

  for (const item of corpus) {
    const q = runQuaude(staged.cli, item.args, {
      cwd: staged.dir, timeout: TIMEOUT,
      env: { ...baseEnv, CLODE_SHIM_TRACE: '1', CLODE_SHIM_PROBE: '1' },
    });
    const nEnv = { ...baseEnv };
    delete nEnv.CLODE_SHIM_TRACE;
    const n = runNaude(staged.cli, item.args, { cwd: staged.dir, timeout: TIMEOUT, env: nEnv });

    const walls = wallsOf(q.stderr);
    walls.forEach((w) => allWalls.add(w));
    probesOf(q.stderr).forEach((pr) => allProbes.add(pr));
    const exitDiverge = q.status !== n.status || q.signal !== n.signal;
    const stdoutDiverge = item.deterministic && (q.stdout || '').trim() !== (n.stdout || '').trim();
    if (exitDiverge) divergences.push(`${item.id}: exit quaude=${q.status}/${q.signal} naude=${n.status}/${n.signal}`);
    if (stdoutDiverge) divergences.push(`${item.id}: stdout differs (deterministic cmd)`);
    const mark = (exitDiverge || stdoutDiverge) ? 'DIVERGE' : 'ok';
    log(`- ${item.id.padEnd(10)} ${mark.padEnd(8)} exit(quaude=${q.status ?? q.signal},naude=${n.status ?? n.signal}) walls=${walls.length}${walls.length ? ' [' + walls.join(', ') + ']' : ''}`);
  }

  log('\n## Axis 1 — exercised-but-unimplemented (walls, quaude side)');
  log(allWalls.size ? [...allWalls].map((w) => '  - ' + w).join('\n') : '  (none — every API the corpus exercised is implemented)');

  log('\n## Axis 2 — naude-vs-quaude divergences');
  log(divergences.length ? divergences.map((d) => '  - ' + d).join('\n') : '  (none)');

  const benign = benignProbes();
  const newProbes = [...allProbes].filter((pr) => !benign.has(pr)).sort();
  log('\n## Axis 3 — runtime probe hits (missing-property READS on broad shim modules)');
  if (!allProbes.size) {
    log('  (none)');
  } else {
    log(`  ${allProbes.size} seen, ${allProbes.size - newProbes.length} known-benign (test/shim-surface/probe-golden.json)`);
    if (newProbes.length) {
      log('  NEW — each needs one human look: is it SNIFFED (benign, add to the golden)');
      log('  or CALLED (a real gap — an undefined call throws a bare "not a function")?');
      newProbes.forEach((pr) => log('    - ' + pr));
    }
  }

  if (opts.versionDelta !== false) versionDelta(log);
  mock.stop();
  if (ownHome) rmSync(home, { recursive: true, force: true });

  const failed = allWalls.size > 0 || divergences.length > 0 || newProbes.length > 0;
  log(`\n${failed ? 'GATE: FAIL' : 'GATE: PASS'} (walls=${allWalls.size}, divergences=${divergences.length}, newProbes=${newProbes.length})`);
  return failed ? 1 : 0;
}

// Only run when invoked as a script — importing this module must never spawn.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(runGate());
}
