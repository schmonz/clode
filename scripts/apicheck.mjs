#!/usr/bin/env node
// clode API-surface gate — v0. See docs/superpowers/specs/2026-07-08-api-surface-gate-design.md
//
// Two axes over a seed corpus of `clode` invocations, using ONLY existing
// instrumentation (wallProxy's [wall] log + node as a reference oracle):
//   Axis 1 (presence):   collect the union of [wall] misses (exercised-but-
//                        unimplemented APIs) — the polyfill work-list.
//   Axis 2 (correctness):run each command under node AND tjs; flag exit-code
//                        divergence always, and stdout divergence for the
//                        deterministic commands (model prose is non-deterministic,
//                        so `-p` prompts are exit+wall only, NOT stdout-compared).
// Plus a cross-version require-target set-diff ("did the surface expand?").
//
// Exit non-zero if any wall miss or any (applicable) divergence is found — so this
// is a CI gate. Runs under host node; orchestrates bin/clode.
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLODE = path.join(REPO, 'bin', 'clode');
const TJS = process.env.CLODE_TJS || path.join(REPO, 'build', 'tjs', 'tjs');
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

function run(engine, item) {
  const env = { ...process.env };
  if (engine === 'tjs') { env.CLODE_ENGINE = 'tjs'; env.CLODE_TJS = TJS; env.CLODE_SHIM_TRACE = '1'; }
  else { delete env.CLODE_ENGINE; delete env.CLODE_SHIM_TRACE; }
  const r = spawnSync(CLODE, item.args, { input: '', env, encoding: 'utf8', timeout: TIMEOUT });
  const walls = [...new Set((r.stderr || '')
    .split('\n').filter((l) => l.includes('[wall]'))
    .map((l) => l.replace(/^.*\[wall\]\s*/, '').trim()).filter(Boolean))];
  return { status: r.status, signal: r.signal, stdout: (r.stdout || ''), walls };
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

console.log('# clode API-surface gate (v0)\n');
const allWalls = new Set();
const divergences = [];

for (const item of CORPUS) {
  const t = run('tjs', item);
  const n = run('node', item);
  t.walls.forEach((w) => allWalls.add(w));
  const exitDiverge = t.status !== n.status || t.signal !== n.signal;
  const stdoutDiverge = item.deterministic && t.stdout.trim() !== n.stdout.trim();
  if (exitDiverge) divergences.push(`${item.id}: exit tjs=${t.status}/${t.signal} node=${n.status}/${n.signal}`);
  if (stdoutDiverge) divergences.push(`${item.id}: stdout differs (deterministic cmd)`);
  const mark = (exitDiverge || stdoutDiverge) ? 'DIVERGE' : 'ok';
  console.log(`- ${item.id.padEnd(10)} ${mark.padEnd(8)} exit(tjs=${t.status ?? t.signal},node=${n.status ?? n.signal}) walls=${t.walls.length}${t.walls.length ? ' [' + t.walls.join(', ') + ']' : ''}`);
}

console.log('\n## Axis 1 — exercised-but-unimplemented (walls)');
console.log(allWalls.size ? [...allWalls].map((w) => '  - ' + w).join('\n') : '  (none — every API the corpus exercised is implemented)');

console.log('\n## Axis 2 — node-vs-tjs divergences');
console.log(divergences.length ? divergences.map((d) => '  - ' + d).join('\n') : '  (none)');

console.log('\n## Version delta — require-target set-diff');
const vers = cachedVersions();
if (vers.length >= 2) {
  const [a, b] = [vers[vers.length - 2], vers[vers.length - 1]];
  const sa = requireTargets(path.join(os.homedir(), '.cache', 'clode', a, 'cli.cjs'));
  const sb = requireTargets(path.join(os.homedir(), '.cache', 'clode', b, 'cli.cjs'));
  const added = [...sb].filter((x) => !sa.has(x));
  const removed = [...sa].filter((x) => !sb.has(x));
  console.log(`  ${a} (${sa.size}) -> ${b} (${sb.size})`);
  console.log('  added:   ' + (added.join(', ') || '(none)'));
  console.log('  removed: ' + (removed.join(', ') || '(none)'));
} else {
  console.log('  (need >=2 cached versions)');
}

const failed = allWalls.size > 0 || divergences.length > 0;
console.log(`\n${failed ? 'GATE: FAIL' : 'GATE: PASS'} (walls=${allWalls.size}, divergences=${divergences.length})`);
process.exit(failed ? 1 : 0);
