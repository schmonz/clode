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
import { readFileSync, existsSync, readdirSync } from 'node:fs';
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
export function runGate(opts = {}) {
  const log = opts.log || ((s) => console.log(s));
  const corpus = opts.corpus || CORPUS;
  const runNaude = opts.runNaude || models.runNaudeModel;
  const runQuaude = opts.runQuaude || models.runQuaudeModel;
  const stage = opts.stage || (() => models.stageProviderCli({ env: opts.env || process.env }));

  log('# clode API-surface gate (v1: naude reference vs quaude subject)\n');

  const staged = stage();
  if (!staged) {
    log('SKIP: no Bun-packaged Claude Code provider resolved.');
    log('  The gate stages cli.cjs from a real provider binary; point CLODE_PROVIDER_BIN');
    log("  or CLODE_CLAUDE_BIN at one, or run 'clode fetch'.");
    return 0;
  }

  const baseEnv = { ...(opts.env || process.env) };
  const allWalls = new Set();
  const divergences = [];

  for (const item of corpus) {
    const q = runQuaude(staged.cli, item.args, {
      cwd: staged.dir, timeout: TIMEOUT,
      env: { ...baseEnv, CLODE_SHIM_TRACE: '1' },
    });
    const nEnv = { ...baseEnv };
    delete nEnv.CLODE_SHIM_TRACE;
    const n = runNaude(staged.cli, item.args, { cwd: staged.dir, timeout: TIMEOUT, env: nEnv });

    const walls = wallsOf(q.stderr);
    walls.forEach((w) => allWalls.add(w));
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

  if (opts.versionDelta !== false) versionDelta(log);

  const failed = allWalls.size > 0 || divergences.length > 0;
  log(`\n${failed ? 'GATE: FAIL' : 'GATE: PASS'} (walls=${allWalls.size}, divergences=${divergences.length})`);
  return failed ? 1 : 0;
}

// Only run when invoked as a script — importing this module must never spawn.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(runGate());
}
