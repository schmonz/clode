#!/usr/bin/env node
'use strict';

// scripts/changed-paths.mjs
//
// Classifies a CI push/PR's changed paths as "code" or "docs-only", so the
// heavy build matrix (the `tjs` job in .github/workflows/ci.yml, and the
// legs downstream of it) can skip on a docs-only push without losing signal
// on a real one.
//
// DEFAULT-DENY IS THE WHOLE DESIGN, and it is not negotiable:
//   - an unrecognised path counts as code
//   - an empty or uncomputable change list counts as code
//   - a failure ANYWHERE in this file — computing the diff, or classifying
//     it — must still print `code=true`, never nothing. A classifier that
//     prints nothing on error would skip the entire matrix silently, which
//     is strictly worse than the cancellation problem this exists to fix.
//
// The docs allow-list is small and explicit on purpose (see
// .superpowers/sdd/2026-09-04-phase5-gates-that-can-fail/task-7-brief.md):
// unknown ⇒ code is what makes a short list SAFE. Do not grow it casually.
//
// Library usage (e.g. from a test):
//   const { classifyChangedPaths } = require('./changed-paths.mjs');
//   classifyChangedPaths(['BACKLOG.md']) // => { code: false, why: '...' }
//
// CI usage (a workflow step):
//   node scripts/changed-paths.mjs >> "$GITHUB_OUTPUT" || echo "code=true" >> "$GITHUB_OUTPUT"
// prints `code=<bool>` and `why=<text>` lines. The `||` is a second,
// independent fail-open layer for the case this process cannot even start
// cleanly (e.g. a syntax error, which would fire before any try/catch in
// this file could run) — belt AND suspenders, not either/or.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const DOCS_EXTENSION = /\.md$/i;

// A path containing a literal `..` SEGMENT (not merely the substring "..",
// e.g. "a..b.md" is fine) is refused rather than normalised. Fix round 1
// (task-7-report.md), Finding 2: `docs/../libexec/quaude-fuse.js` and
// `docs/sub/../../scripts/z.mjs` both classified as docs before this guard,
// because `startsWith('docs/')` never looked past the literal prefix.
// `git diff --name-only` does not emit un-normalised paths today, so this
// was latent — but isDocsPath/classifyChangedPaths are exported and a future
// caller (or a git behaviour change) is not a premise worth trusting.
// Normalising and then trusting the result invites "did I normalise the
// same way git does?"; refusing does not. A path with a `..` segment is
// unknown-or-suspicious, which this file's whole design already treats as
// code, so it is rejected here rather than given its own special case in
// classifyChangedPaths.
function hasTraversalSegment(p) {
  return p.split('/').some((segment) => segment === '..');
}

// A path is docs-only if it matches ALL of: *.md (anywhere in the tree —
// a .md file inside a code directory, e.g. libexec/README.md, is still
// docs), docs/** (a top-level docs/ directory), or the exact repo-root
// LICENSE file. Everything else — including a LICENSE-like name that is
// NOT that exact path, e.g. docs/LICENSE-THIRD-PARTY.md would already be
// caught by *.md, but a bare "licenses/LICENSE" would not — falls through
// to code, which is the point: this list stays short because unknown always
// means code.
export function isDocsPath(p) {
  if (typeof p !== 'string' || p.length === 0) return false;
  if (hasTraversalSegment(p)) return false;
  if (DOCS_EXTENSION.test(p)) return true;
  if (p === 'docs' || p.startsWith('docs/')) return true;
  if (p === 'LICENSE') return true;
  return false;
}

export function classifyChangedPaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    return {
      code: true,
      why: 'empty change list — the diff could not be computed (or genuinely touched '
        + 'nothing), and that must run everything, not skip everything, or a broken '
        + 'diff silently disables CI',
    };
  }
  const codePaths = paths.filter((p) => !isDocsPath(p));
  if (codePaths.length > 0) {
    return { code: true, why: `code path(s) present: ${codePaths.join(', ')}` };
  }
  return {
    code: false,
    why: `every changed path matched the docs allow-list (*.md, docs/**, LICENSE): ${paths.join(', ')}`,
  };
}

// ---- CLI: derive the changed-path list for the current CI event, then classify it ----

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

const ALL_ZERO_SHA = /^0+$/;

// Throws on anything it cannot resolve confidently — main() below treats a
// throw here exactly like an empty list, which classifyChangedPaths already
// fails open on. There is deliberately no branch that returns [] to mean
// "nothing changed" AND no branch that swallows an error silently: every
// exit from this function is either a real path list or a thrown reason.
function computeChangedPaths() {
  const eventName = process.env.GITHUB_EVENT_NAME || '';
  let range;
  if (eventName === 'pull_request' || eventName === 'pull_request_target') {
    const base = process.env.GH_PR_BASE_SHA;
    const head = process.env.GH_PR_HEAD_SHA || 'HEAD';
    if (!base) throw new Error('pull_request event but GH_PR_BASE_SHA was not supplied');
    range = [`${base}...${head}`];
  } else if (eventName === 'push') {
    const before = process.env.GH_BEFORE_SHA;
    const after = process.env.GITHUB_SHA || 'HEAD';
    if (!before || ALL_ZERO_SHA.test(before)) {
      // A new branch's first push, or a force-push GitHub reports with an
      // all-zero "before" — there is no single parent to diff against.
      throw new Error('push event with no usable "before" SHA (new branch or force-push)');
    }
    range = [`${before}..${after}`];
  } else {
    // workflow_dispatch and anything else carry no diff context at all.
    throw new Error(`no diff context for event "${eventName || '(unset)'}"`);
  }
  const out = git(['diff', '--name-only', ...range]);
  return out ? out.split('\n').filter(Boolean) : [];
}

function main() {
  try {
    let paths = [];
    let computeErrorMessage = null;
    try {
      paths = computeChangedPaths();
    } catch (err) {
      computeErrorMessage = err && err.message ? err.message : String(err);
    }

    const result = classifyChangedPaths(paths);
    const why = computeErrorMessage
      ? `${result.why} (diff computation failed: ${computeErrorMessage})`
      : result.why;

    process.stdout.write(`code=${result.code}\n`);
    process.stdout.write(`why=${why.replace(/[\r\n]+/g, ' ')}\n`);
  } catch (err) {
    // Absolute last resort: something in the classify/print path itself
    // blew up in a way the inner try/catch did not anticipate. Still never
    // print nothing — fail open, by name, so a broken classifier is a named
    // failure instead of a silent skip.
    process.stdout.write('code=true\n');
    const msg = err && err.message ? err.message : String(err);
    process.stdout.write(`why=changed-paths.mjs itself failed: ${msg.replace(/[\r\n]+/g, ' ')}\n`);
  }
}

// Only run as a CLI when invoked directly (`node scripts/changed-paths.mjs`
// or required as this process's entry point) — NOT when required/imported
// by a test for classifyChangedPaths/isDocsPath, which must not have the
// side effect of shelling out to git and writing to stdout.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
