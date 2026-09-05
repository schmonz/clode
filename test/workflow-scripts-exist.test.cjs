'use strict';
// EVERY SCRIPT A WORKFLOW INVOKES MUST EXIST ON DISK.
//
// The ratchet that makes deleting a watcher safe. A workflow step is a string in YAML:
// nothing type-checks it, and a `run: node scripts/foo.mjs` that names a deleted file
// fails only when the job next fires — on a schedule, that can be a day later, in a log
// nobody opened, on a workflow whose red nobody is watching because it was already red.
//
// This exists because of the retired scripts/haiku-image-watch.mjs (2026-08-31). That
// watcher hardcoded `KNOWN_IMAGE = /r1beta5/i` and asked cross-platform-actions whether a
// newer image had appeared. One had — the SAME r1beta6 the haiku-x64 leg had already been
// pinned to on 2026-08-27 — so it failed the daily upstream-drift run for four days,
// telling us to do work that was done. scripts/check-guest-versions.mjs answers the same
// question generically for every VM leg, off the same catalog, by comparing against the
// PIN rather than a literal, so the bespoke one went away rather than being re-pointed.
// This guard is what keeps the removal from leaving a dangling `run:` behind.
const fs = require('node:fs');
const path = require('node:path');
const { defineGuard, guardTests } = require('./guard.cjs');

const REPO = path.resolve(__dirname, '..');
const WF = path.join(REPO, '.github', 'workflows');
const ACT = path.join(REPO, '.github', 'actions');

function ymlFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...ymlFiles(p));
    else if (/\.ya?ml$/.test(e.name)) out.push(p);
  }
  return out;
}

function allFilesUnder(dir) {
  const out = new Set();
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { for (const f of allFilesUnder(p)) out.add(f); }
    else out.add(path.relative(REPO, p).split(path.sep).join('/'));
  }
  return out;
}

// PURE: `repoFiles` is a Set of every real repo-relative path under scripts/,
// gathered by read() — scan() only checks membership, it does no I/O of its own.
function scanWorkflowScripts({ ymlTexts, repoFiles }) {
  const findings = [];
  let examined = 0;
  for (const { file, text } of ymlTexts) {
    // `scripts/<name>.<ext>` anywhere in a run: block, however it is invoked (node,
    // bash, a variable-prefixed command). Deliberately not anchored to `node ` — the
    // point is the PATH's existence, not the interpreter.
    for (const m of text.matchAll(/\bscripts\/[A-Za-z0-9._-]+\.(?:mjs|cjs|js|sh|py)\b/g)) {
      examined++;
      if (!repoFiles.has(m[0])) findings.push(`${file}: ${m[0]}`);
    }
  }
  return { findings, examined };
}

const guard = defineGuard({
  name: 'workflow-scripts-exist',
  read: () => ({
    ymlTexts: [...ymlFiles(WF), ...ymlFiles(ACT)].map((f) => ({
      file: path.relative(REPO, f), text: fs.readFileSync(f, 'utf8'),
    })),
    repoFiles: allFilesUnder(path.join(REPO, 'scripts')),
  }),
  scan: scanWorkflowScripts,
  // Floored at 6: the real corpus references well over a hundred script paths
  // across dozens of workflow files, so examining fewer than 6 means the yml
  // discovery broke, not that there is nothing to check.
  floor: 6,
  control: () => ({
    ymlTexts: [
      { file: 'fake.yml', text: 'run: node scripts/does-not-exist.mjs\n'.repeat(6) },
    ],
    repoFiles: new Set(),
  }),
});
guardTests(guard);
