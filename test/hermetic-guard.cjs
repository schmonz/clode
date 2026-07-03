'use strict';
// hermetic-guard — the enforcement backstop for the test suite. run-all.sh snapshots
// the real dirs a test must never touch (real store/cache/bin + repo build/) before
// the suite and asserts them unchanged after; any creation/mtime change fails the run.
// Also a preflight that refuses to run against a store already contaminated with
// test-fake deps. Pure Node stdlib; fs injectable for tests.
const fs = require('fs');
const path = require('path');

function snapshot(paths, fsm = fs) {
  return paths.map((p) => {
    try { return `${p}|${fsm.statSync(p).mtimeMs}`; }
    catch { return `${p}|ABSENT`; }
  });
}

function diffSnapshots(before, after) {
  const b = new Map(before.map((l) => [l.split('|')[0], l]));
  const changed = [];
  for (const line of after) {
    const p = line.split('|')[0];
    if (b.get(p) !== line) changed.push(`${b.get(p) || `${p}|<new>`} -> ${line}`);
  }
  return changed;
}

function preflight(dataStore, fsm = fs) {
  let bad = [];
  let names = [];
  try { names = fsm.readdirSync(path.join(dataStore, 'node_modules')); } catch { return []; }
  for (const n of names) {
    try {
      const v = JSON.parse(fsm.readFileSync(path.join(dataStore, 'node_modules', n, 'package.json'), 'utf8')).version;
      if (String(v).includes('clode-test')) bad.push(`${n}@${v}`);
    } catch { /* skip */ }
  }
  return bad;
}

module.exports = { snapshot, diffSnapshots, preflight };

if (require.main === module) {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === 'snapshot') {
    process.stdout.write(snapshot(args).join('\n') + (args.length ? '\n' : ''));
  } else if (cmd === 'preflight') {
    const bad = preflight(args[0]);
    if (bad.length) {
      process.stderr.write(`hermetic-guard: REAL store contaminated with test-fake deps: ${bad.join(' ')}\n`);
      process.stderr.write(`hermetic-guard: remove them from ${args[0]}/node_modules (they self-heal on next real run)\n`);
      process.exit(2);
    }
  } else {
    process.stderr.write(`hermetic-guard: unknown command '${cmd}'\n`);
    process.exit(2);
  }
}
