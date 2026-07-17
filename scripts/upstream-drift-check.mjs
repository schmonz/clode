#!/usr/bin/env node
'use strict';
// THE DAILY UPSTREAM-DRIFT CHECK — the place where "did a new Claude Code break
// us?" gets asked, on a schedule, against LATEST.
//
// Usage: node scripts/upstream-drift-check.mjs <path-to-claude-binary>
// Driven by .github/workflows/upstream-drift.yml (daily). Run it by hand against
// any provider: it needs only node + the binary.
//
// WHY IT EXISTS. clode reads a bundle it does not own. Upstream can break us
// without breaking itself, and the failure is silent by nature: an anchor that no
// longer matches means a hook is NOT APPLIED, and everything still builds. That is
// not hypothetical — 2.1.210 dropped the alias `let`s at the pkg-manager
// autoupdater site (2.1.207 was fine), the redirect stopped applying, and it took
// weeks and a CI archaeology session to notice.
//
// WHY THIS AND NOT `--strict` — YET. --strict gates on gateProblems(): everything
// NOT in inspect-claude-bundle's ACCEPTED_* sets, which are the REVIEWED baseline
// ("we looked at this and decided it is fine"). So --strict already asks the right
// question — "is anything unreviewed?" — and its red is honest, not noise: on
// 2.1.210 the bundle references 38 Bun members the shim lacks while
// ACCEPTED_MISSING_BUN contains exactly one ('SQL'), so 37 are genuinely
// UNREVIEWED. That is a backlog, and each entry wants a decision: implement it,
// stub it fail-loud, or accept it with a written reason.
//
// This job cannot adopt --strict until that backlog is zero, or it would be red
// from birth and teach everyone to ignore it. The fix is to review the 37, NOT to
// filter them — and NOT (an idea considered and rejected here, 2026-07-17) to
// diff against "yesterday's list", which would silently baseline all 37 as fine
// forever. Any unreviewed member needs reviewing; that is the whole point of the
// ACCEPTED_* lists.
//
// So: when the backlog reaches zero, `--strict --shim` becomes the check in this
// file and needs no new machinery — the ACCEPTED_* lists ARE the baseline, and a
// member upstream newly starts using turns it red by itself. Until then this
// asserts only what must be TRUE RIGHT NOW, so red always means "today, something
// changed".
//
// FLESH THIS OUT. As we find more ways upstream can break us, add checks here —
// each one a thing that must be true of a bundle we do not control. Keep the rule:
// only assert what must be true TODAY, so this job never cries wolf.
//
// NEXT CANDIDATE, deferred deliberately (user, 2026-07-17): work the unreviewed
// Bun-member backlog to zero (37 on 2.1.210 — see above), then make `--strict
// --shim` the second check here. Reviewing unreviewed members IS a daily-shaped
// task; it just cannot gate until the existing backlog is dealt with. No delta, no
// new baseline file: ACCEPTED_* is the baseline.
// Other known candidates: the bundle's required Node floor creeping up; new search
// applets; new bare specifiers (the dep-closure seed scan already catches those at
// BUILD time, loudly — see clode-fuse's assertNoUnknownBareSpecifiers).
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import url from 'node:url';

const REPO = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const INSPECT = path.join(REPO, 'libexec', 'inspect-claude-bundle.cjs');
const SHIM = path.join(REPO, 'libexec', 'bun-shim.cjs');

// Every hook clode patches into the bundle. Each is a regex pinned to a site in
// ~20MB of minified JS; each fails SILENTLY (hook not applied, build still green)
// when upstream reshapes that site. The value is the reason, so a failure tells
// the next person what actually breaks for users.
const ANCHORS = {
  autoupdater_hook_anchor_present:
    'the in-TUI pkg-manager autoupdater redirect (clode --clode-internal-update) would not apply',
  native_autoupdater_hook_anchor_present:
    'the in-TUI NATIVE autoupdater redirect would not apply — a built target would try to install over itself',
  doctor_hook_anchor_present:
    '/doctor installation-warnings would lose the applet-skew hook',
  snapshot_generator_present:
    'the eager-snapshot bridge would not apply — shell snapshot generation loses its shadow rewrite',
  ripgrep_lever_present:
    'the USE_BUILTIN_RIPGREP lever is gone — ripgrep env shaping would silently no-op',
};

const bin = process.argv[2];
if (!bin) {
  process.stderr.write('usage: upstream-drift-check.mjs <path-to-claude-binary>\n');
  process.exit(64);
}

let cov;
try {
  // --json, not --strict: we want the discrete facts, not the triage list.
  const raw = execFileSync(process.execPath, [INSPECT, '--json', '--shim', SHIM, bin],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  cov = JSON.parse(raw);
} catch (e) {
  process.stderr.write(`upstream-drift: could not inspect '${bin}': ${(e && e.message) || e}\n`);
  process.exit(1);
}

const broken = [];
for (const [key, why] of Object.entries(ANCHORS)) {
  // Absent key = an inspect that no longer reports this anchor. Treat as broken,
  // never as "fine": a check that quietly stops checking is the failure mode this
  // whole job exists to prevent.
  if (cov[key] !== true) broken.push({ key, why, value: cov[key] });
}

if (!broken.length) {
  process.stdout.write(`upstream-drift: OK — all ${Object.keys(ANCHORS).length} anchors present\n`);
  process.exit(0);
}

process.stderr.write('upstream-drift: UPSTREAM MOVED — clode hooks would not apply\n\n');
for (const b of broken) {
  process.stderr.write(`  ${b.key} = ${b.value}\n      -> ${b.why}\n`);
}
process.stderr.write('\nThis is upstream drift, NOT a regression in the commit that ran this job.\n');
process.stderr.write('Re-pin the anchor: find the site in the new bundle, extend the regex in\n');
process.stderr.write('libexec/extract-claude-js.cjs AND its mirror in libexec/inspect-claude-bundle.cjs\n');
process.stderr.write('(keep them in step), and prove it against the OLD and NEW versions both.\n');
process.exit(1);
