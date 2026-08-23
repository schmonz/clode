#!/usr/bin/env node
// THE big-endian gate: is serialized bytecode identical on LE and BE?
//
// This is the property the canonical-LE work exists to deliver — "serialized
// bytecode is little-endian, so one artifact loads everywhere" — and until now
// nothing checked it. `be-oracle` replayed node-shim tests on a BE engine: in 30
// runs it never caught a big-endian bug, its green was bought with a five-file
// exclude list, and its only endianness assertion was
// `assert.ok(x === 'LE' || x === 'BE')`. This asks the actual question instead,
// in seconds, with no provider, no exclude list and no libc mismatch.
//
// It runs spike/quickjs/bc-le-oracle.mjs under BOTH engines from the SAME build
// and diffs per-item hashes. Same commit, same pipeline, so a difference is
// endianness and nothing else.
//
// RATCHET, NOT PASS/FAIL. Some corpus items DO differ today (see BACKLOG,
// "canonical-LE bytecode is INCOMPLETE"): the synthetic stress corpus matches
// byte-for-byte while real CommonJS files diverge from offset 1. Failing the
// release on that pre-existing bug helps nobody, and silently tolerating it is
// how it stays unfixed. So the baseline records the CURRENT verdict per item and
// this fails when it CHANGES in either direction:
//   - an item that matched now differs        -> regression
//   - an item that differed now matches       -> good news; lower the baseline
//   - an item with no baseline entry          -> review it and record a verdict
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORACLE = path.join(repo, 'spike/quickjs/bc-le-oracle.mjs');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : null;
}
const leBin = arg('--le');
const beBin = arg('--be');
const baselineFile = arg('--baseline') || path.join(repo, 'test/fixtures/bc-le-baseline.json');
const update = process.argv.includes('--update');
if (!leBin || !beBin) {
  console.error('usage: bc-le-gate.mjs --le <tjs> --be <tjs> [--baseline FILE] [--update]');
  process.exit(2);
}

// name -> hash, from the oracle's `sha256(NAME) bytes=N HASH` lines.
function run(bin, label) {
  let out;
  try {
    out = execFileSync(process.execPath, [ORACLE, bin], { encoding: 'utf8', timeout: 600000 });
  } catch (e) {
    console.error(`bc-le-gate: the ${label} oracle run failed: ${e.message.split('\n')[0]}`);
    if (e.stdout) console.error(e.stdout);
    process.exit(1);
  }
  const items = {};
  for (const line of out.split('\n')) {
    const m = line.match(/^sha256\((.+?)\) bytes=(\d+) ([0-9a-f]{64})$/);
    if (m) items[m[1]] = { bytes: Number(m[2]), hash: m[3] };
    else if (/^FAIL\(/.test(line)) {
      console.error(`bc-le-gate: the ${label} oracle reported ${line}`);
      process.exit(1);
    }
  }
  if (!Object.keys(items).length) {
    console.error(`bc-le-gate: the ${label} oracle produced no items — the corpus is empty or the binary is wrong:\n${out}`);
    process.exit(1);
  }
  return items;
}

const le = run(leBin, 'LE');
const be = run(beBin, 'BE');

const verdicts = {};
for (const name of Object.keys(le).sort()) {
  if (!(name in be)) continue;               // corpus differs between hosts; reported below
  verdicts[name] = le[name].hash === be[name].hash ? 'identical' : 'differs';
}

if (update) {
  fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
  fs.writeFileSync(baselineFile, JSON.stringify({
    note: 'LE-vs-BE serialized-bytecode verdict per corpus item. See BACKLOG '
        + '"canonical-LE bytecode is INCOMPLETE". `identical` entries must never regress; '
        + 'a `differs` entry that becomes identical is progress — lower it here.',
    verdicts,
  }, null, 2) + '\n');
  console.log(`bc-le-gate: baseline written (${Object.keys(verdicts).length} items)`);
  process.exit(0);
}

if (!fs.existsSync(baselineFile)) {
  console.error(`bc-le-gate: no baseline at ${baselineFile}; create one with --update after reviewing`);
  process.exit(1);
}
const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8')).verdicts || {};

const problems = [];
for (const [name, got] of Object.entries(verdicts)) {
  const want = baseline[name];
  if (!want) {
    problems.push(`${name}: NEW corpus item (verdict ${got}) — review it and record a verdict`);
  } else if (want !== got) {
    problems.push(got === 'differs'
      ? `${name}: REGRESSION — was identical on LE/BE, now differs (LE ${le[name].hash.slice(0, 12)} vs BE ${be[name].hash.slice(0, 12)})`
      : `${name}: now IDENTICAL on LE/BE, baseline says differs — good news, lower the baseline`);
  }
}
// A baselined item the run never produced is visible, not fatal: the corpus is
// partly environmental (build/*/clode-main.bundle.cjs exists only after a build).
for (const name of Object.keys(baseline)) {
  if (!(name in verdicts)) console.log(`bc-le-gate: not exercised this run: ${name}`);
}

for (const [name, got] of Object.entries(verdicts)) console.log(`  ${got.padEnd(9)} ${name}`);

if (problems.length) {
  console.error('\nbc-le-gate: LE/BE bytecode equivalence changed:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log(`bc-le-gate: ${Object.keys(verdicts).length} items match the recorded LE/BE verdicts`);
