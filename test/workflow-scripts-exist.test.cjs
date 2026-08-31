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
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

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

test('every scripts/ file a workflow or action invokes exists', () => {
  const files = [...ymlFiles(WF), ...ymlFiles(ACT)];
  assert.ok(files.length > 5, `expected the workflow set, found ${files.length}`);
  const missing = [];
  let referenced = 0;
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    // `scripts/<name>.<ext>` anywhere in a run: block, however it is invoked (node,
    // bash, a variable-prefixed command). Deliberately not anchored to `node ` — the
    // point is the PATH's existence, not the interpreter.
    for (const m of text.matchAll(/\bscripts\/[A-Za-z0-9._-]+\.(?:mjs|cjs|js|sh|py)\b/g)) {
      referenced++;
      if (!fs.existsSync(path.join(REPO, m[0]))) {
        missing.push(`${path.relative(REPO, f)}: ${m[0]}`);
      }
    }
  }
  assert.ok(referenced > 5, `expected several script references, found ${referenced}`);
  assert.deepStrictEqual(missing, [],
    'a workflow names a scripts/ file that is not in the tree — the job fails only when it '
    + 'next fires, which for a scheduled workflow can be a day later in a log nobody reads');
});
