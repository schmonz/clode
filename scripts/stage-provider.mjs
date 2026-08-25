#!/usr/bin/env node
// STAGE A PROVIDER FOR BUILDING — one policy, every platform.
//
// Usage: PROV="$(node scripts/stage-provider.mjs [--out DIR])"
//
// Resolves the platform-correct provider (scripts/find-provider.mjs) and MINIMISES it
// (scripts/make-min-provider.cjs), printing the path to use. Every leg that BUILDS gets
// the same treatment, on every platform.
//
// WHY THIS EXISTS — it replaces a set of accidental special cases. Minimising used to run
// on exactly three legs, through two call sites with DIFFERENT failure policies:
//
//     build-leg:689  verify=qemu-user   linux-riscv64, linux-s390x   `2>/dev/null` — SWALLOWED
//     build-leg:728  guest-platform=qemu-*  netbsd-sparc             bare call    — FATAL
//
// When make-min-provider stopped understanding code-split bundles (2026-08-25), the same
// breakage turned netbsd-sparc red three hours into the slowest job in the matrix, while
// riscv64 and s390x printed "level-2.5 SKIPPED (no provider available to carve)" — which
// named the wrong cause, because a provider WAS available; our own script had failed.
// The user's call: "I would like it to apply equally to all platforms unless there's a
// specific good reason not to."
//
// WHY MINIMISE AT ALL. clode reads a provider by CARVING BYTES, never by executing it, so
// the result is arch-independent and a small file produced here is equivalent everywhere.
// The saving is not marginal — measured on 2.1.245:
//
//     whole binary   358.7MB
//     JS source       34.2MB   <- all clode needs
//     JSC bytecode   235.1MB   <- 6.9x the source, and we recompile with quickjs anyway
//     blobB            9.7MB
//     non-JS rows     12.6MB   <- native .node, mermaid/chart/hljs assets
//
// That matters most where memory is scarcest (the sun4m guest has 512MB, the machine
// type's ceiling, under TCG) and costs nothing where it is not.
//
// THE ONE DECLARED EXCEPTION, and it is about PURPOSE, not platform: anything that
// INSPECTS a bundle must use the real binary, because the minimiser deliberately drops
// what inspection reports on. Measured:
//
//     real provider   embedded_assets=16   napi=8
//     minimised       embedded_assets=0    napi=0
//
// So upstream-drift-check and inspect-claude-bundle keep calling find-provider.mjs
// directly. If you are ASKING QUESTIONS ABOUT the bundle, use find-provider; if you are
// BUILDING FROM it, use this.
//
// FAILURE IS LOUD, EVERYWHERE. A provider that cannot be resolved and a minimiser that
// fails are DIFFERENT conditions with different remedies, and the old code printed the
// same sentence for both. They are distinguished here, and neither is silent.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import url from 'node:url';

const REPO = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const outArg = (() => { const i = argv.indexOf('--out'); return i >= 0 ? argv[i + 1] : null; })();

function die(msg, code = 1) { process.stderr.write(`stage-provider: ${msg}\n`); process.exit(code); }

let prov = '';
try {
  prov = execFileSync(process.execPath, [path.join(REPO, 'scripts', 'find-provider.mjs')],
    { encoding: 'utf8' }).trim();
} catch (e) {
  die(`could not run find-provider.mjs: ${(e && e.message) || e}`);
}
if (!prov) {
  die('no platform-matching Claude provider found. Install one '
    + '(`npm i -g @anthropic-ai/claude-code`) or set CLODE_PROVIDER_BIN.');
}
if (!fs.existsSync(prov)) die(`find-provider returned a path that does not exist: ${prov}`);

const outDir = outArg || fs.mkdtempSync(path.join(os.tmpdir(), 'clode-provider-'));
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, 'provider-min');

try {
  execFileSync(process.execPath, [path.join(REPO, 'scripts', 'make-min-provider.cjs'), prov, out],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
} catch (e) {
  // DISTINCT from "no provider": we found one and could not minimise it. Saying so is the
  // difference between a five-minute fix and a three-hour hunt on an emulated leg.
  die(`found a provider (${prov}) but could not minimise it — see the error above. `
    + 'This is NOT "no provider available"; the resolver worked and make-min-provider did not.');
}

if (!fs.existsSync(out)) die(`make-min-provider reported success but wrote no ${out}`);
process.stdout.write(out + '\n');
