#!/usr/bin/env node
'use strict';
// WATCH THE `next` CHANNEL — the only advance warning we get.
//
// Usage: node scripts/upstream-next-watch.mjs <path-to-claude-binary>
// Driven by .github/workflows/upstream-drift.yml against `@anthropic-ai/claude-code@next`.
//
// WHY THIS EXISTS. The daily drift check installs `latest`, so it can only tell us we
// are broken on the day every user is broken. On 2026-08-24 upstream published 2.1.243
// as `latest`, it switched Bun to CODE SPLITTING, `clode build` died at extraction, 19
// CI legs went red, and we found out by having a release dry run fail. Upstream then
// withdrew .243 from `latest` (back to 2.1.241) — but did NOT revert the change: 2.1.245
// sits on `next` with the same shape. So the break is staged, not averted, and `next` is
// where we can see it coming.
//
// WHY IT IS NOT JUST "RUN THE DRIFT CHECK ON next". Because that would be RED FROM BIRTH:
// we already know `next` is uncarveable, and a job that is permanently red teaches
// everyone to ignore it. Worse, it is exactly how a P0 hid here before — main sat red
// with three tolerated failures, so a real regression that broke 13 jobs went unnoticed
// for days (see BACKLOG, "Ambient red CI hid a P0").
//
// SO: THIS ASSERTS THE KNOWN STATE AND GOES RED WHEN THE STATE CHANGES. Both directions
// are news, and both need a human:
//
//   next is uncarveable, same as we recorded  -> GREEN (nothing new; loud note in the log)
//   next became CARVEABLE                     -> RED   (upstream reverted, or shipped a
//                                                       third shape — revisit the plan)
//   next fails a DIFFERENT way                -> RED   (a new break hiding behind the
//                                                       known one — the failure mode this
//                                                       whole design exists to prevent)
//
// Same rule as the EXPECTED table in upstream-drift-check.mjs and the counts in
// test/windows-path-ratchet.test.cjs: an expectation that only fires in one direction
// rots into a permanent excuse nobody revisits.
//
// WHEN THE RELINKER LANDS: flip EXPECTED_STATE to 'carveable'. That single edit turns
// this into a guard that `next` keeps working, with no other machinery to change.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import url from 'node:url';

const REPO = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const CHECK = path.join(REPO, 'scripts', 'upstream-drift-check.mjs');

// What we currently believe about the `next` channel, with the evidence and the date.
// Verified 2026-08-25 against 2.1.245: 1385 bare-ESM modules, 12420 static chunk
// imports, no CommonJS entry. See BACKLOG.md, "bundle 2.1.243 BROKE THE EXTRACTOR".
const EXPECTED_STATE = 'uncarveable';
const KNOWN_SIGNATURE = /the CLI is no longer carveable/;

const bin = process.argv[2];
if (!bin) {
  process.stderr.write('usage: upstream-next-watch.mjs <path-to-claude-binary>\n');
  process.exit(64);
}

let out = '';
let failed = false;
try {
  out = execFileSync(process.execPath, [CHECK, bin], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
} catch (e) {
  failed = true;
  out = `${(e.stdout || '')}${(e.stderr || '')}`;
}

process.stdout.write(out.trimEnd() + '\n\n');

if (EXPECTED_STATE === 'uncarveable') {
  if (!failed) {
    process.stderr.write(
      'next-watch: STATE CHANGED — `next` is CARVEABLE again.\n\n'
      + '  We recorded `next` as uncarveable (the Bun code-split ESM shape). It now\n'
      + '  carves. Either upstream reverted the split, or it shipped a third shape that\n'
      + '  happens to satisfy our check. Both need a human: re-read the bundle, and if\n'
      + '  the split is genuinely gone, revisit whether the relinker is still the plan.\n\n'
      + '  Do not "fix" this by deleting the check. Update EXPECTED_STATE deliberately.\n');
    process.exit(1);
  }
  if (!KNOWN_SIGNATURE.test(out)) {
    process.stderr.write(
      'next-watch: DIFFERENT FAILURE — `next` broke in a way we have not seen.\n\n'
      + '  We expected the known code-split refusal. This is something else, and it was\n'
      + '  about to hide behind a break we had already accepted. Read the output above.\n');
    process.exit(1);
  }
  process.stdout.write(
    'next-watch: OK — `next` is uncarveable, exactly as recorded.\n\n'
    + '  NOT a clean bill of health. It means the KNOWN break is still the only break,\n'
    + '  and that `clode build` will fail for everyone the day this reaches `latest`.\n'
    + '  Green here buys time; it does not buy safety. See BACKLOG.md.\n');
  process.exit(0);
}

if (EXPECTED_STATE === 'carveable') {
  if (failed) {
    process.stderr.write('next-watch: `next` no longer carves — an upstream break is inbound.\n');
    process.exit(1);
  }
  process.stdout.write('next-watch: OK — `next` still carves.\n');
  process.exit(0);
}

process.stderr.write(`next-watch: unknown EXPECTED_STATE ${JSON.stringify(EXPECTED_STATE)}\n`);
process.exit(70);
