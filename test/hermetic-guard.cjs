'use strict';
// hermetic-guard — the enforcement backstop for the test suite. run-all.sh snapshots
// the real dirs a test must never touch (real store/cache/bin + repo build/) before
// the suite and asserts them unchanged after; any creation/mtime change fails the run.
// Also a preflight that refuses to run against a store already contaminated with
// test-fake deps. Pure Node stdlib; fs injectable for tests.
const fs = require('fs');
const path = require('path');
const tree = require('./tree-guard.cjs');

// A snapshot line is "<watched-root>::<relpath>|<size>|<mtime>|<mode>". The watched
// root is kept in the line so a diff can name WHICH watched dir moved, and so the
// string[] shape the callers already expect is unchanged.
function snapshot(paths, fsm = fs) {
  const out = [];
  for (const p of paths) {
    let missing = true;
    for (const [rel, v] of tree.walk(p, { fsm })) { missing = false; out.push(`${p}::${rel}|${v}`); }
    if (missing) out.push(`${p}|ABSENT-OR-EMPTY`);
  }
  return out;
}

function diffSnapshots(before, after) {
  const b = new Set(before);
  const a = new Set(after);
  const changed = [];
  for (const line of after) if (!b.has(line)) changed.push(`+ ${line}`);
  for (const line of before) if (!a.has(line)) changed.push(`- ${line}`);
  return changed.sort();
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
