// What rg calls does the CURRENT bundle actually make, and can we still translate
// every one of them?
//
//   node scripts/rg-inventory.mjs <binary> [--update] [--verbose]
//                                          [--allow-untranslated]
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
//   3. THIS PROBE goes blind — the binary never got far enough to call rg, or the
//      shim's debug line changed shape. Zero observations then look exactly like
//      "upstream deleted every rg call", and the gate accuses upstream of a
//      change that never happened. It shipped that way and the first CI run said
//      so; an instrument that cannot tell "I saw nothing" from "nothing happened"
//      is worse than no instrument. That case is now named, separately.
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
// Hosts that CANNOT carry the applets (no bfs has ever been ported to native
// Windows) still answer the inventory question — every call is observed, just
// refused instead of translated. They pass this to say so out loud, rather than
// the gate quietly deciding for itself that a missing applet is fine.
const allowUntranslated = argv.includes('--allow-untranslated');

if (!binary || !fs.existsSync(binary)) {
  console.error('usage: rg-inventory.mjs <binary> [--update] [--verbose] [--allow-untranslated]');
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
let refusals = [];          // rg-only flags: upstream changed, WE must act
let untranslated = [];      // applet absent: THIS HOST cannot translate
let childErr = '';
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
  // Same blindness the SSE probe had: if the binary never LAUNCHED there is no
  // stderr, zero rg calls get observed, and the inventory diff blames upstream for
  // a change that did not happen. On Windows an extensionless path is the usual
  // cause — node's libuv only tries <name>.com/<name>.exe unless
  // UV_PROCESS_WINDOWS_FILE_PATH_EXACT_NAME is set, and node does not set it.
  // ETIMEDOUT is the NORMAL path, not a launch failure: the quaude keeps running
  // and OUR OWN timeout kills it, which makes spawnSync set r.error. Treating every
  // r.error as "never launched" made this fail on every leg that behaves correctly —
  // caught by the release dry run, on legs that had been green all week. Only a real
  // spawn failure (ENOENT/EACCES/…) means no child ever existed.
  if (r.error && r.error.code !== 'ETIMEDOUT') {
    console.error(`FAIL: the binary never launched — ${r.error.message}`);
    console.error(`  binary: ${binary}`);
    console.error('  This says nothing about upstream\'s rg usage; nothing ran.');
    process.exit(1);
  }
  const err = r.stderr || '';
  childErr = err;
  if (verbose) process.stderr.write(err.slice(0, 4000));

  for (const line of err.split('\n')) {
    // One shape per rg call, whatever the shim decided (bun-shim's _rgDebug):
    //   "clode rg-debug: rg <args> => <tool> <args>"          translated
    //   "clode rg-debug: rg <args> !! needs <applet>"         no ugrep/bfs here
    //   "clode rg-debug: rg <args> !! untranslatable <flag>"  rg-only flag
    // ALL THREE are observations of a call upstream made, so all three feed the
    // inventory. Only the verdict differs — and the verdicts mean opposite
    // things: "untranslatable" is upstream's doing, "needs" is this host's.
    const m = line.match(/^clode rg-debug: (rg .*?) (?:=>|!! needs (\S+)|!! untranslatable (\S+))(?:\s|$)/);
    if (m) {
      calls.push(normalize(m[1]));
      if (m[2]) untranslated.push({ call: normalize(m[1]), applet: m[2] });
      if (m[3]) refusals.push({ flag: m[3], where: normalize(m[1]) });
      continue;
    }
    // The SHELL twin of the shim (the `rg` function bun-shim installs into Bash
    // sessions) refuses on its own, with no argv and no rg-debug line. Keep
    // reading its message so a refusal from that route is not invisible — keyed
    // by flag so it does not double-count the spawn route, which prints both.
    const t = line.match(/doesn't translate (\S+) \(rg-only\)/);
    if (t) refusals.push({ flag: t[1], where: 'shell shadow' });
  }
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}

// Printed whenever the gate is about to fail. The one line that explains a
// blind probe ("clode: rg needs 'ugrep' ...") was being thrown away unless
// somebody thought to re-run with --verbose, which nobody does from a CI log.
const dumpChildErr = () => {
  if (verbose) return;   // already written above
  console.error('\n--- child stderr (last 4000 bytes) ---');
  console.error(childErr.slice(-4000) || '(empty)');
};

calls = [...new Set(calls)].sort();
untranslated = [...new Map(untranslated.map((u) => [u.call, u])).values()];
refusals = [...new Map(refusals.map((r) => [r.flag, r])).values()];

console.log(`--- rg calls observed (${calls.length}) ---`);
for (const c of calls) console.log(`  ${c}`);
if (untranslated.length) {
  console.log(`--- of those, ${untranslated.length} could not be translated ON THIS HOST ---`);
  for (const u of untranslated) console.log(`  needs ${u.applet}: ${u.call}`);
}

// A refusal is unambiguous: upstream now invokes rg in a way we cannot express
// with portable applets. That is exactly the event this exists to surface, and it
// is a failure whether or not the inventory also changed.
if (refusals.length) {
  console.error(`\nFAIL: ${refusals.length} rg flag(s) we cannot express:`);
  for (const r of refusals) console.error(`  ${r.flag}  (seen in: ${r.where})`);
  console.error('\nUpstream changed its rg usage. Either translate the new form to a '
    + 'portable applet (ugrep/bfs) or refuse it deliberately — do NOT install rg, '
    + 'which cannot exist on every target quaude supports.');
  dumpChildErr();
  process.exit(1);
}

// A DIFFERENT finding, and it used to be indistinguishable from the one above
// because the shim printed nothing parseable when the applet was missing: the
// calls are all fine, this machine just has no ugrep/bfs to run them with. That
// is not a product defect, it is an unsupported host — quaude REQUIRES the
// applets (we translate rg on purpose; see the rg-divergence decision) and clode
// does not provision them, so a run without them exercises the fallback path,
// not the product.
if (untranslated.length && !update && !allowUntranslated) {
  const applets = [...new Set(untranslated.map((u) => u.applet))].sort();
  console.error(`\nFAIL: this host cannot translate rg — missing ${applets.join(', ')}.`);
  console.error('The calls themselves are fine; nothing here says upstream changed. '
    + `Install ${applets.join(' and ')} (or point CLODE_`
    + `${applets.map((a) => a.toUpperCase()).join('/CLODE_')} at them) and re-run, so the `
    + 'gate observes the configuration quaude actually supports. Only a host that '
    + 'genuinely cannot carry an applet (native Windows has no bfs port) should pass '
    + '--allow-untranslated.');
  dumpChildErr();
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

// Zero observations against a non-empty golden is not evidence that upstream
// dropped every rg call — it is evidence that the probe saw nothing, which is a
// statement about the INSTRUMENT. Reporting it as "the bundle's rg usage
// changed" (listing all three goldens as removed) is precisely the lie that sent
// a human hunting an upstream change for a gate that had simply gone blind.
if (calls.length === 0 && golden.length > 0) {
  console.error('\nFAIL: the probe observed NOTHING — 0 rg calls, against a golden of '
    + `${golden.length}. This says the instrument is broken, NOT that upstream changed:`);
  console.error('  - did the binary boot at all, or die/hang before its first rg call?');
  console.error('  - did CLODE_RG_DEBUG reach it (is this binary older than the shim\'s '
    + '_rgDebug instrumentation)?');
  console.error('  - did the rg-debug line format change out from under this parser?');
  dumpChildErr();
  process.exit(1);
}

const added = calls.filter((c) => !golden.includes(c));
const gone = golden.filter((c) => !calls.includes(c));

if (added.length || gone.length) {
  console.error('\nFAIL: the bundle\'s rg usage changed.');
  for (const a of added) console.error(`  + ${a}`);
  for (const g of gone) console.error(`  - ${g}`);
  console.error('\nA NEW call may be translated correctly and still mean something '
    + 'different from what we assume. Check each one against the routing spec, then '
    + 'refresh with: node scripts/rg-inventory.mjs <binary> --update');
  dumpChildErr();
  process.exit(1);
}

const translated = calls.length - untranslated.length;
console.log(`\nPASS: ${calls.length} rg call(s), ${translated} translated`
  + (untranslated.length ? `, ${untranslated.length} refused (no applet on this host)` : '')
  + ', inventory unchanged');
