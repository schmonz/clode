'use strict';
// A FULL SUITE ON A RELEASE CUT JUDGES WHAT THE RELEASE WILL JUDGE. Some gates are strict only at a release
// (CLODE_EVIDENCE_RELEASE=1: the NetBSD/arm64 VM record must be fresh, USER RULING 2026-11-21), and release.yml's
// gates-ran-in-release is the only place that set it. Found 2026-11-25: 0.20261125.1 was cut on a commit whose
// test/tree-guard.cjs change (in the evidence driver's require closure) staled the record AFTER the green dry run; the
// local suite on the release commit only warned, the tag was pushed, and the release job was skipped. The local suite
// is the last check before the tag, so on a cut it now applies the release's strictness itself.
//
// A cut is pending exactly when VERSION names a version with no v<VERSION> tag: between releases VERSION carries its
// tag, and the release commit bumps it first. When no v* tag is visible at all (a CI shallow clone fetches none) the
// question has no answer here, so nothing changes; release.yml's own gate still judges the release there.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

// PURE: (VERSION text, the v* tags visible) -> the pending version, or null (no cut pending, or unknowable).
function pendingCut(versionText, tags) {
  const v = String(versionText || '').trim();
  if (!v || !tags.length) return null;
  return tags.includes(`v${v}`) ? null : v;
}

function gitTags(root) {
  try {
    return execFileSync('git', ['tag', '-l', 'v*'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n').map((s) => s.trim()).filter(Boolean);
  } catch { return []; }
}

// -> a line to print when release strictness was switched on, else null. Mutates env only to set
// CLODE_EVIDENCE_RELEASE=1, and never overrides an explicit value (CLODE_EVIDENCE_RELEASE=0 is a deliberate non-release
// run on a cut).
function applyReleaseCut(root, env = process.env, tags = gitTags(root)) {
  if (env.CLODE_EVIDENCE_RELEASE !== undefined) return null;
  let text;
  try { text = fs.readFileSync(path.join(root, 'VERSION'), 'utf8'); } catch { return null; }
  const v = pendingCut(text, tags);
  if (!v) return null;
  env.CLODE_EVIDENCE_RELEASE = '1';
  return `run: VERSION ${v} has no v${v} tag, so this is a release cut: judging as the release will `
    + '(CLODE_EVIDENCE_RELEASE=1; test/release-cut.cjs says why, CLODE_EVIDENCE_RELEASE=0 opts out)';
}

module.exports = { pendingCut, applyReleaseCut, gitTags };
