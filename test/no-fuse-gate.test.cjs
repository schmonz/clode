'use strict';
// no-fuse-gate.test.cjs — phase 3a, task 2. Retiring the word "fuse" is not really about
// renaming five files; it is about the word never quietly coming back once "blobulate" has
// been said to mean what it meant. This guard is that promise made checkable: it reads every
// git-tracked file that could carry prose or code and complains if the standalone word "fuse"
// (or fused/fuses/fusing) appears anywhere outside the one place upstream still owns it.
//
// WHY GIT-TRACKED FILES, not a hand-rolled filesystem walk with a SKIP_DIRS blocklist (the
// task brief's own Step-1 sketch, deliberately incomplete): a raw `fs.readdirSync` walk sees
// whatever happens to be sitting on THIS machine, not just the project. Measured directly:
// test/.harness/ — six to nine per-platform dirs, each holding a package.json and a
// package-lock.json, populated by whichever test or build last ran locally — added 16 files
// to a naive walk's `examined` count on this box, and that number depends on which tests you
// happened to run before this one, which means `floor` (a fixed integer) would not be the
// same on two checkouts of the identical commit. `git ls-files` IS the project: it already
// excludes build/, node_modules/, test/.harness/, docs/ and .superpowers/ (all fully
// gitignored, the last two confirmed here to hold zero tracked files) with no blocklist to
// keep in sync as new local caches appear.
//
// WHY "fuse" AS A WORD, not a bare case-insensitive substring (the brief's own sketch's
// `/fuse/i`): English has a whole family of real, unrelated words that CONTAIN "fuse" as a
// substring — refuse(d/s), confuse(d/s), diffuse(d/s), infuse(d/s), profuse(ly), effuse(d),
// suffuse(d), defuse(d), fuselage — and this repo has its own: the errno constant
// ECONNREFUSED, and test/guards-population.cjs's own GATE_REFUSES / test/fixtures/
// proxy-server.cjs's PROXY_REFUSE. A bare /fuse/i would flag every one of those, forever
// (BACKLOG.md alone has dozens of "refuse/refused" lines that are plain English, nothing to
// do with this task). None of that family has a WORD BOUNDARY immediately before "fuse" —
// the character right before it is always a letter (re-FUSE, con-FUSE, ECONNRE-FUSE-D) — so
// \bfuse\b, matched alongside fused/fuses/fusing as its own inflected forms (an ordinary
// suffix, not a compound), excludes the whole family with no explicit allowlist, while still
// catching every real site this task renamed: cross-fuse, quaude-fuse.js, "the fuse worker",
// FUSED (all-caps emphasis in a comment), and so on.
//
// THE KNOWN GAP, named rather than chased: a prefix glued on with NO boundary at all — a
// hypothetical future "unfuse" or "xfuse", or a camelCase "somethingFusedPayload" — would
// slip past this the same way "unfused"/"xfuse"/"materializeFusedPayload" did before this
// task renamed them (there is no boundary between "l" and "F" in "materializeFused" either).
// That is the same tradeoff test/windows-path-ratchet.test.cjs names for its own regexes:
// "it cannot catch a shape we have not met." This guard's job is the word as it actually
// appears in this repo today, proven by its control below, not every conceivable disguise.
//
// THE ONE SURVIVOR, and the TWO HISTORICAL RECORDS that are not survivors of the same kind:
//
//   - scripts/build-naude.mjs's `sentinelFuse` / `NODE_SEA_FUSE_<hash>` is postject's own
//     API parameter name and Node's own sentinel constant — upstream's vocabulary, not ours,
//     and a gate that forbade it would force a WRONG fix (renaming an argument postject does
//     not recognise). \bfuse\b does not even match it (no boundary inside "sentinelFuse" or
//     between "_" and "FUSE" in the constant); listed in ALLOWED anyway, as documentation and
//     defense-in-depth against a future, less careful regex change.
//
//   - BACKLOG.md and test/fidelity/RESULTS.md are dated, append-only journals, and both are
//     exempted WHOLESALE rather than line-by-line. BACKLOG.md's entries record decisions made
//     when the tool was literally CALLED clode-fuse.cjs and the action was literally named
//     cross-fuse; Task 1 already established the precedent of leaving BACKLOG.md's own
//     clode-fuse.cjs references untouched even after that literal rename ("the word 'fuse'
//     itself is untouched (Task 2's business)" — its commit message). RESULTS.md says of
//     itself: "a hand-driven row is a fact about the past ... and stays true forever no
//     matter what happens later; append-only latest-wins is built for exactly that shape."
//     Rewriting either to say "blobulate" retroactively would misrepresent what was actually
//     decided, built, or run on the date the entry claims — the same reason this repo does
//     not rewrite README.md in someone else's voice, applied to its own history instead.
//
//     Two lines elsewhere quote that history verbatim, in quotes, as a worked example: the
//     exact phrase RESULTS.md uses for what a `how: ci` claim asserts ("fuses and runs a
//     quaude ... on every build") is quoted in test/fidelity/ci-claim-check.mjs to explain why
//     that class of claim needs a liveness check, and a specific note string that once
//     drifted ("... fuses and runs a quaude inside the Haiku guest on every build") is quoted
//     in test/fidelity/fidelity-notes.test.cjs as the drift example. Both get the same narrow,
//     line-scoped exemption, for the same reason as the two files above: a paraphrase would
//     no longer be the thing being quoted.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { defineGuard, guardTests } = require('./guard.cjs');

const REPO = path.resolve(__dirname, '..');
const SELF = 'test/no-fuse-gate.test.cjs';

// Tracked, but out of THIS task's scope on purpose: bench/ and spike/ are research and
// experimental trees, not the vocabulary surface a user or CI reads as "the product" (the
// task brief's own SKIP_DIRS sketch names the same two, for the same reason).
const SKIP_DIRS = new Set(['bench', 'spike']);
const EXT_RE = /\.(cjs|mjs|js|json|yml|yaml|md|sh|Dockerfile)$/;
// bin/clode itself has no extension (a shebang script, `#!/usr/bin/env node`) and was
// invisible to an EXT_RE-only filter until this line — found by running this exact gate
// and then grepping the tracked corpus by hand for anything the extension list could not
// see. Any tracked path with no extension is a candidate too (LICENSE, UPSTREAM_PIN,
// VERSION, .tool-versions, .githooks/* and bin/clode all qualify; none of them is large
// or binary, so reading them as UTF-8 text is safe). A LEADING dot (.tool-versions,
// .githooks/post-checkout) is a hidden-file marker, not an extension separator — only a
// dot after the first character counts — exactly the distinction path.extname() already
// draws (extname('.tool-versions') === '', extname('.eslintrc.json') === '.json').
function hasNoExtension(rel) { return path.extname(rel) === ''; }

// Matches "fuse" only as a standalone word/inflection — see the file header for exactly
// which real English words this is designed to exclude, and why a bare substring test
// cannot be used here.
const FUSE_RE = /\bfuse\b|\bfused\b|\bfuses\b|\bfusing\b/i;

const ALLOWED = [
  { file: 'scripts/build-naude.mjs', pattern: /sentinelFuse|NODE_SEA_FUSE_[0-9a-f]{32}/,
    because: "postject's own API parameter name and Node's own sentinel constant — "
      + 'upstream\'s vocabulary, not ours; a gate that forbade it would force a wrong fix.' },
  { file: 'BACKLOG.md', pattern: FUSE_RE,
    because: 'a dated, append-only journal — entries record decisions made when the tool '
      + 'was literally named with "fuse" (clode-fuse.cjs, the cross-fuse action). Task 1 '
      + "already left this file's clode-fuse.cjs references untouched after that literal "
      + 'rename; rewriting history to say "blobulate" retroactively would misrepresent it.' },
  { file: 'test/fidelity/RESULTS.md', pattern: FUSE_RE,
    because: 'an append-only, latest-wins ledger of dated fidelity rows — by its own header, '
      + '"a hand-driven row is a fact about the past ... and stays true forever no matter '
      + 'what happens later." Rewriting a row would misrepresent what actually ran on the '
      + 'date it claims.' },
  { file: 'test/fidelity/ci-claim-check.mjs', pattern: /fuses and runs a quaude/i,
    because: "verbatim quotation of RESULTS.md's own historical wording, quoted to explain "
      + 'why a `how: ci` claim needs a liveness check; paraphrasing it would no longer be '
      + 'the text being quoted.' },
  { file: 'test/fidelity/fidelity-notes.test.cjs', pattern: /fuses and\b/i,
    because: 'verbatim quotation of a specific note string that once drifted (the haiku-x64 '
      + 'example two lines below); the point of the example is exactly what was written at '
      + "the time, not today's vocabulary." },
  { file: 'libexec/quaude-blobulate.js', pattern: /WHY NOT "fuse"|`fuse` is Node SEA/,
    because: "this file's own header is the canonical definition of \"blobulate\" (the task "
      + 'brief requires exactly one home for the coined word), and explaining a rename '
      + 'requires naming the word being replaced once — the same reasoning this gate '
      + 'applies to itself (see SELF above).' },
];

function isAllowed(rel, line) {
  return ALLOWED.some((a) => rel === a.file && a.pattern.test(line));
}

function trackedFiles() {
  const out = execFileSync('git', ['-C', REPO, 'ls-files'], { encoding: 'utf8' });
  return out.split('\n').filter(Boolean);
}

function candidateFiles() {
  return trackedFiles().filter((rel) => {
    if (rel.split('/').some((seg) => SKIP_DIRS.has(seg))) return false;
    return EXT_RE.test(rel) || path.basename(rel) === 'Dockerfile' || hasNoExtension(rel);
  });
}

// read() — the only I/O: ask git for the corpus (deterministic across checkouts of the same
// commit — see the file header) and read each candidate once.
function readCorpus() {
  const rels = candidateFiles();
  if (rels.length === 0) {
    return { skip: '`git ls-files` returned no candidate files — repo layout or git '
      + 'invocation changed; nothing to scan' };
  }
  const files = [];
  for (const rel of rels) {
    let src;
    try { src = fs.readFileSync(path.join(REPO, rel), 'utf8'); } catch { continue; }
    files.push({ rel, src });
  }
  return { files };
}

// PURE. {findings, examined} — the shape defineGuard's scan requires. `examined` is a FILE
// count (this file names the word to forbid it, so it is excluded from BOTH the corpus and
// the count, exactly as the brief's own sketch does).
function scanForFuse({ files }) {
  const findings = [];
  let examined = 0;
  for (const { rel, src } of files) {
    if (rel === SELF) continue;
    examined++;
    // A bare substring, not FUSE_RE: a FILENAME is a much smaller, controlled namespace
    // than prose (measured: no tracked path contains "refuse"/"confuse"/etc — the whole
    // family this file's header explains FUSE_RE exists to exclude), so the brief's
    // original, simpler check is exactly right here.
    if (/fuse/i.test(rel)) findings.push(`${rel}: the FILENAME still says fuse`);
    for (const line of src.split('\n')) {
      if (!FUSE_RE.test(line)) continue;
      if (isAllowed(rel, line)) continue;
      findings.push(`${rel}: ${line.trim().slice(0, 120)}`);
    }
  }
  return { findings, examined };
}

const guard = defineGuard({
  name: 'no-fuse-vocabulary',
  // Measured 2026-09-13 (`/opt/pkg/bin/node -e` against readCorpus()+scanForFuse() run
  // directly — see task-2-report.md for the exact command and output) against the real,
  // post-rename tree: 515 tracked, extension-matching-or-extensionless files, SELF
  // excluded, zero findings. The floor equals that measurement exactly (never one under,
  // per the task brief) — any future file this gate would have scanned but no longer can
  // (a `git ls-files` regression, a candidate filter narrowed by accident, a new
  // SKIP_DIRS entry added without a reason written beside it) drops `examined` below 515
  // and reports BROKEN rather than a silently-narrower OK.
  floor: 515,
  read: readCorpus,
  scan: scanForFuse,
  // A synthetic corpus containing a real violation: the word this guard exists to forbid,
  // as an ordinary standalone word in a comment — not `sentinelFuse`/`NODE_SEA_FUSE_...`
  // (the one real survivor) and not a `refuse`-family word (which this guard must NOT
  // flag), so the control proves the SAME discriminating regex that protects those two
  // categories still catches a plain, real "fuse" when one is actually there.
  control: () => ({
    files: [{ rel: 'synthetic/control.cjs',
      src: '// a fuse worker must never come back under this name.\n' }],
  }),
});
guardTests(guard);
