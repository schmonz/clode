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
//
// THE LESSON FROM 2.1.243 (2026-08-24): every check here asserted something about
// the CONTENT of the bundle, and none asserted that clode could still GET the
// content. Prefer checks that would fail if the product stopped working, over
// checks that confirm a string is still present somewhere in 340MB.
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
// EXPECTED STATE, NOT JUST PRESENCE — and checked in BOTH directions.
//
// This used to be a flat list of anchors that had to be `true`, and it covered 5 of
// the 8 things inspect reports. That gap cost us: `patchUpdateHint` had NO anchor at
// all, so when its site vanished from upstream around 2.1.210 the build printed one
// line of stderr, exited 0, and NOBODY NOTICED FOR MONTHS. A hook we ship was dead
// and every check we had said fine.
//
// So every anchor inspect reports must appear here with a declared expectation:
//
//   'present' — clode patches this site; if it goes, the hook silently stops applying
//   'absent'  — known gone upstream, with a REASON and the DATE/VERSION last checked
//
// An 'absent' entry that comes BACK is also a failure. Acceptances must not rot: if
// upstream restores a site we gave up on, that is news, and the alternative is a
// permanent excuse nobody revisits. This is the same both-directions rule that keeps
// test/windows-path-ratchet.test.cjs honest.
//
// Adding a new hook to extract-claude-js.cjs without adding it here fails the
// completeness check below. That is deliberate: the decision is cheap to make now and
// expensive to discover later.
const EXPECTED = {
  autoupdater_hook_anchor_present: {
    expect: 'present',
    why: 'the in-TUI pkg-manager autoupdater redirect (notify-only __clodeCheckUpdate) would not apply',
  },
  native_autoupdater_hook_anchor_present: {
    expect: 'present',
    why: 'the in-TUI NATIVE autoupdater redirect would not apply — a built target would try to install over itself',
  },
  legacy_autoupdater_hook_anchor_present: {
    expect: 'present',
    why: 'the LEGACY npm autoupdater install-dispatch neutralization would not apply — and this is '
      + 'the ONE updater a built target actually mounts (installation type `unknown` is neither '
      + '`native` nor `package-manager`), so a target would run `bun/npm install -g '
      + '@anthropic-ai/claude-code` over itself. Observed live on a real quaude before the hook existed.',
  },
  manual_update_hook_anchor_present: {
    expect: 'present',
    why: 'the manual `update` command would not be neutralized — `<target> update`, typed by a human, '
      + 'would `bun/npm install -g @anthropic-ai/claude-code` over this binary (update-guard.cjs only '
      + 'denies the MODEL a `claude update` through Bash). Observed live on a real quaude.',
  },
  doctor_hook_anchor_present: {
    expect: 'present',
    why: '/doctor installation-warnings would lose the applet-skew hook',
  },
  update_notice_hook_anchor_present: {
    expect: 'present',
    why: 'the three-state update notice would stop surfacing on /status and `claude doctor`',
  },
  remote_control_hook_anchor_present: {
    expect: 'present',
    why: 'the Remote Control gate-off would not apply — Remote Control may silently no-op under quaude',
  },
  snapshot_generator_present: {
    expect: 'present',
    why: 'the eager-snapshot bridge would not apply — shell snapshot generation loses its shadow rewrite',
  },
  ripgrep_lever_present: {
    expect: 'present',
    why: 'the USE_BUILTIN_RIPGREP lever is gone — ripgrep env shaping would silently no-op',
  },
  update_hint_anchor_present: {
    expect: 'present',
    why: 'the npm remediation rewrite would not apply — a built target tells its user to `npm i -g` a stock claude over itself',
  },
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
for (const [key, { expect, why }] of Object.entries(EXPECTED)) {
  const got = cov[key];
  // Missing key = an inspect that no longer reports this anchor. Treat as broken,
  // never as "fine": a check that quietly stops checking is the failure mode this
  // whole job exists to prevent. Note this catches a DROPPED report even for an
  // anchor we expect to be absent — `undefined` is not `false`.
  if (typeof got !== 'boolean') {
    broken.push({ key, why: `inspect no longer reports this anchor at all — ${why}`, value: got });
  } else if (expect === 'present' && got !== true) {
    broken.push({ key, why, value: got });
  } else if (expect === 'absent' && got !== false) {
    broken.push({
      key,
      why: `EXPECTED ABSENT BUT PRESENT — upstream restored a site we had written off. ${why}`,
      value: got,
    });
  }
}

// COMPLETENESS: every anchor inspect reports must have a declared expectation. A new
// hook added to extract-claude-js.cjs and mirrored into inspect, but never given a row
// above, would otherwise be gated by nothing — which is exactly how patchUpdateHint
// died unnoticed. Fail rather than let the coverage quietly shrink.
const undeclared = Object.keys(cov).filter(
  (k) => /_present$/.test(k) && !Object.prototype.hasOwnProperty.call(EXPECTED, k));
if (undeclared.length) {
  process.stderr.write('upstream-drift: UNDECLARED ANCHORS — inspect reports these, this check does not gate them:\n');
  for (const k of undeclared) process.stderr.write(`  ${k} = ${cov[k]}\n`);
  process.stderr.write('\nAdd each to EXPECTED in this file with `present` or `absent` + a reason.\n');
  process.exit(1);
}

// THE CARVE ITSELF. Anchors are necessary but NOT sufficient: they are matched
// against the WHOLE binary, so they stay green as long as the JS is present as
// text — even when clode can no longer get at it. That is not hypothetical.
// 2.1.243 switched Bun to CODE SPLITTING: the CLI became ~1383 `chunk-<hash>.js`
// ESM modules with no CommonJS entry, `clode build` died at extraction, and THIS
// JOB REPORTED "OK — all 5 anchors present". Green while the product was dead.
//
// So assert the one fact every hook depends on: there is a single CJS block named
// entrypoints/cli.js to carve. If that is gone, no anchor matters.
const CLI_BLOCK = /entrypoints\/cli\.js$/;
const blocks = Array.isArray(cov.bun_cjs_blocks) ? cov.bun_cjs_blocks : null;
const cliBlock = blocks && blocks.find((b) => CLI_BLOCK.test(String((b && b.name) || '')));
if (!cliBlock) {
  process.stderr.write('upstream-drift: UPSTREAM MOVED — the CLI is no longer carveable\n\n');
  process.stderr.write(
    blocks
      ? `  bun_cjs_blocks = ${blocks.length} block(s), none named entrypoints/cli.js\n` +
        blocks.slice(0, 6).map((b) => `      name=${JSON.stringify(String((b && b.name) || '(unnamed)'))} size=${(b && b.size) || 0}\n`).join('')
      : '  inspect no longer reports bun_cjs_blocks at all\n');
  process.stderr.write(
    '\n  -> `clode build` CANNOT EXTRACT the CLI from this bundle. Every hook above is\n' +
    '     moot: there is nothing to patch them into. Users cannot build a target.\n');
  process.stderr.write('\nThis is upstream drift, NOT a regression in the commit that ran this job.\n');
  process.stderr.write('Run `node libexec/extract-claude-js.cjs <binary> /tmp/cli.cjs` — it diagnoses\n');
  process.stderr.write('the new shape and refuses rather than guessing. Fixing it is a real piece of\n');
  process.stderr.write('work (a code-split bundle needs an ESM relinker, not a carve), not a re-pin.\n');
  process.exit(1);
}

if (!broken.length) {
  process.stdout.write(
    `upstream-drift: OK — all ${Object.keys(EXPECTED).length} anchors as expected, ` +
    `CLI carveable (${cliBlock.size} bytes)\n`);
  process.exit(0);
}

process.stderr.write('upstream-drift: UPSTREAM MOVED — clode hooks are not in their expected state\n\n');
for (const b of broken) {
  process.stderr.write(`  ${b.key} = ${b.value}\n      -> ${b.why}\n`);
}
process.stderr.write('\nThis is upstream drift, NOT a regression in the commit that ran this job.\n');
process.stderr.write('Re-pin the anchor: find the site in the new bundle, extend the regex in\n');
process.stderr.write('libexec/extract-claude-js.cjs AND its mirror in libexec/inspect-claude-bundle.cjs\n');
process.stderr.write('(keep them in step), and prove it against the OLD and NEW versions both.\n');
process.exit(1);
