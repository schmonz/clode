// What rg calls does the CURRENT bundle actually make, and can we still translate
// every one of them?
//
//   node scripts/rg-inventory.mjs <binary> [--update] [--verbose]
//
// WHY THIS EXISTS. We translate rg to portable applets on purpose — rg is Rust and
// cannot exist everywhere quaude does, while ugrep and bfs can (see the routing
// spec and the rg-divergence decision). That bargain holds only as long as we can
// translate what upstream actually invokes, and upstream can change its rg usage
// in any release, with no change on our side. Two ways that goes wrong:
//
//   1. A NEW or CHANGED flag we cannot translate. The shim refuses loudly rather
//      than mistranslating — but "loudly" means a line on stderr that nobody reads
//      unless something is watching. This watches.
//   2. A call that still translates but now means something DIFFERENT (a flag
//      added, a path form changed). Nothing refuses; the answer is just quietly
//      wrong. Only a diff against a recorded inventory catches that.
//
// So: drive the real binary, record every rg invocation the shim sees, normalize
// away machine-specific paths, and compare against a golden. A refusal fails
// outright; an inventory change fails asking a human to look. Refresh with
// --update once the change is understood.
//
// Runs where a built binary exists — build-leg's smoke — so it rides the same
// daily upstream-drift check that asks whether the newest bundle still boots.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN = path.join(HERE, '..', 'test/shim-surface/rg-calls-golden.json');

const argv = process.argv.slice(2);
const binary = argv.find((a) => !a.startsWith('--'));
const update = argv.includes('--update');
const verbose = argv.includes('--verbose');

if (!binary || !fs.existsSync(binary)) {
  console.error('usage: rg-inventory.mjs <binary> [--update] [--verbose]');
  process.exit(2);
}

// Absolute paths and temp dirs differ per machine and per run; the FLAGS are the
// part that carries meaning, so normalize operands to a placeholder rather than
// recording noise that would make the golden churn on every host.
const normalize = (argvStr) => argvStr
  .trim()
  .split(/\s+/)
  .map((tok) => (tok.startsWith('/') || tok.startsWith('~') ? '<PATH>' : tok))
  .join(' ');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-inv-home-'));
let calls = [];
let refusals = [];
try {
  const r = spawnSync(binary, ['-p', 'hi'], {
    encoding: 'utf8',
    // Every rg call happens during STARTUP, before any API turn, so we do not need
    // the turn to succeed — or even to be attempted for long. Point the API at a
    // closed local port so the turn fails immediately instead of retrying against
    // the real endpoint for a minute, and cap the run regardless. spawnSync still
    // returns the stderr collected before a timeout kill, which is all we read.
    timeout: 25000,
    env: {
      ...process.env,
      HOME: home,
      ANTHROPIC_API_KEY: 'sk-rg-inventory-notreal',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
      CLODE_RG_DEBUG: '1',
    },
  });
  const err = r.stderr || '';
  if (verbose) process.stderr.write(err.slice(0, 4000));

  for (const line of err.split('\n')) {
    // Translated: "clode rg-debug: rg <args> => <tool> <args>"
    const m = line.match(/^clode rg-debug: (rg .*?) =>/);
    if (m) { calls.push(normalize(m[1])); continue; }
    // Refused: the shim says so rather than mistranslating.
    if (/doesn't translate/.test(line)) refusals.push(line.trim());
  }
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}

calls = [...new Set(calls)].sort();

console.log(`--- rg calls observed (${calls.length}) ---`);
for (const c of calls) console.log(`  ${c}`);

// A refusal is unambiguous: upstream now invokes rg in a way we cannot express
// with portable applets. That is exactly the event this exists to surface, and it
// is a failure whether or not the inventory also changed.
if (refusals.length) {
  console.error(`\nFAIL: ${refusals.length} rg call(s) could not be translated:`);
  for (const r of refusals) console.error(`  ${r}`);
  console.error('\nUpstream changed its rg usage. Either translate the new form to a '
    + 'portable applet (ugrep/bfs) or refuse it deliberately — do NOT install rg, '
    + 'which cannot exist on every target quaude supports.');
  process.exit(1);
}

if (update) {
  fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
  fs.writeFileSync(GOLDEN, JSON.stringify(calls, null, 2) + '\n');
  console.log(`\nwrote ${GOLDEN}`);
  process.exit(0);
}

if (!fs.existsSync(GOLDEN)) {
  console.error(`\nFAIL: no golden at ${GOLDEN} — create it with --update`);
  process.exit(1);
}

const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
const added = calls.filter((c) => !golden.includes(c));
const gone = golden.filter((c) => !calls.includes(c));

if (added.length || gone.length) {
  console.error('\nFAIL: the bundle\'s rg usage changed.');
  for (const a of added) console.error(`  + ${a}`);
  for (const g of gone) console.error(`  - ${g}`);
  console.error('\nA NEW call may be translated correctly and still mean something '
    + 'different from what we assume. Check each one against the routing spec, then '
    + 'refresh with: node scripts/rg-inventory.mjs <binary> --update');
  process.exit(1);
}

console.log(`\nPASS: ${calls.length} rg call(s), all translated, inventory unchanged`);
