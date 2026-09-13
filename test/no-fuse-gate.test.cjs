'use strict';
// no-fuse-gate.test.cjs — phase 3a, task 2. Retiring the word "fuse" is not really about
// renaming five files; it is about the word never quietly coming back once "blobulate" has
// been said to mean what it meant. This guard is that promise made checkable: it reads every
// git-tracked file that could carry prose or code and complains if the word "fuse" (or its
// ordinary inflections, or a camelCase compound built on it) appears anywhere outside the
// places named below.
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
// (BACKLOG.md alone has over a hundred "refuse/refused" lines that are plain English,
// nothing to do with this task). None of that family has a WORD BOUNDARY immediately before
// "fuse" — the character right before it is always a letter (re-FUSE, con-FUSE,
// ECONNRE-FUSE-D) — so \bfuse\b, matched alongside fused/fuses/fusing as its own inflected
// forms, excludes the whole family with no explicit allowlist.
//
// THE CAMELCASE HALF (fix round 1, coordinator review). A plain \bfuse\b cannot see a
// compound with NO boundary at all — `materializeFusedPayload`, `sentinelFuse`, `xfuse` all
// have a WORD CHARACTER immediately before "fuse"/"Fuse", so \b never fires there, and this
// gate shipped blind to the exact shape this task spent most of its effort renaming. The fix
// is NOT simply "add /[a-z]Fus(e|ed|es|ing)\b/ and rely on the existing /i flag" — tried
// first, measured directly: under a shared case-insensitive flag, `[a-z]` and `Fus` both fold
// case, so the pattern also matches `refuse`/`confused`/`ECONNREFUSED` (the letter before
// "fus" in "re-fuse" is just as much an `[a-z]` match as the letter before "Fuse" in
// "sentinelFuse") — 302 new findings across files that have never said our word, confirmed by
// actually running it. What distinguishes a real compound from the excluded English family is
// not case, it is the SPECIFIC 2-3 letters immediately before "fus": re/con/dif/in/pro/ef/
// suf/de are excluded prefixes, and nothing else is. So the real fix is a letter immediately
// before "fus", NOT preceded by one of those specific prefixes:
//   [a-z](?<!re)(?<!con)(?<!dif)(?<!in)(?<!pro)(?<!ef)(?<!suf)(?<!de)fus(?:e|ed|es|ing)\b
// (case-insensitive). The lookbehinds sit AFTER the generic `[a-z]` on purpose: they must
// check the text ending where "fus" starts, not where the generic letter starts, or the
// exclusion silently never fires (measured: swapping the order made `diffuse`/`refuse` match
// again). Verified against the whole family plus every real compound this task renamed
// (`sentinelFuse`, `materializeFused`, `unfused`, `xfuse`, `cross-fuse`) before trusting it —
// see the fix-round-1 report for the exact table. This closes the gap enough to make the
// scripts/build-naude.mjs ALLOWED entry below load-bearing again (under the OLD plain
// \bfuse\b, it matched nothing there and was pure documentation); it does not close the gap
// named next.
//
// THE STILL-KNOWN GAP, named rather than chased: a prefix glued on with NO letters at all
// before it that could carry a lookbehind — i.e. this closes compounds with at least one
// letter before "fus" (camelCase, "xfuse"), but a bare, sentence-initial reintroduction of
// the word with a NEW two-or-three-letter prefix this list has never met (some future English
// word, or a new coined abbreviation) would need its prefix added here to be excluded, or it
// will slip through as a false positive requiring a new ALLOWED entry — the opposite failure
// direction from before, and the safer one. That is the same tradeoff
// test/windows-path-ratchet.test.cjs names for its own regexes: "it cannot catch a shape we
// have not met." This guard's job is the word as it actually appears in this repo today,
// proven by its two controls below (one per detector — see control()), not every conceivable
// disguise.
//
// THE OPERATIVE RULE FOR "IS THIS SITE EXEMPT", stated once so every ALLOWED/COUNT_ALLOWED
// entry below can be checked against it: describing a mechanism in TODAY's vocabulary is
// fine everywhere in this repo, swept like anything else (test/fidelity/PLATFORMS.md's dated
// PROOF statements — "on-box fuse, PONG + attest green, bundle 2.1.179" — were swept to
// "blobulate" for exactly this reason: they describe what a rig proved, not a verbatim quote
// of what something once said). What is actually protected is narrower: a VERBATIM QUOTE of
// specific historical wording (paraphrasing it stops being the thing quoted), a DATED LEDGER
// ROW that is a fact about a specific past date (rewriting it misrepresents when something
// ran), upstream's OWN identifier (ours to use, never to rename), and a REAL ON-DISK PATH this
// task did not rename (spike/ is out of scope, so a path under it keeps its real name).
//
//   - scripts/build-naude.mjs's `sentinelFuse` / `NODE_SEA_FUSE_<hash>` — upstream's own
//     identifier. Forcing a rename here would not fix anything; postject would not recognise
//     the result.
//   - test/fidelity/ci-claim-check.mjs and test/fidelity/fidelity-notes.test.cjs each quote a
//     specific piece of historical wording verbatim, in quotes, as a worked example (the exact
//     RESULTS.md phrase for what a `how: ci` claim asserts, and a specific note string that
//     once drifted). Paraphrasing either stops being the thing being quoted.
//   - libexec/quaude-blobulate.js's own header (the canonical definition — see the top of
//     that file) names `sentinelFuse`/`NODE_SEA_FUSE_<hash>` to explain why "fuse" was
//     retired — the same reasoning this gate applies to itself (see SELF below): explaining a
//     rename requires naming the thing being replaced.
//   - .github/renovate.json and test/node-pins-agree.test.cjs name the REAL, on-disk
//     `spike/quickjs/qemu/docker-loop/Dockerfile.xfuse` — spike/ is out of scope for this
//     task (see SKIP_DIRS below), so that file was never renamed, and text naming it by its
//     actual name is correct, not stale. (Under the OLD plain \bfuse\b this needed no entry
//     at all — "xfuse" has a word character, not a boundary, before "fuse". The camelCase fix
//     above closes that gap too, which is why these two are new entries in this round.)
//
// BACKLOG.md and test/fidelity/RESULTS.md are a DIFFERENT shape of exception, and get a
// DIFFERENT mechanism (fix round 1: the first draft called BACKLOG.md "a dated, append-only
// journal", which BACKLOG.md's own line 5 contradicts — "Done items are DELETED from here —
// git history is the record" — it is a constantly-edited triage document, not a ledger).
// test/fidelity/RESULTS.md genuinely is what the first draft claimed for both: append-only,
// latest-wins, each row "a fact about the past ... true forever no matter what happens
// later" (its own header). Neither file gets a wholesale "any line in here is fine" pass,
// because that would hide a NEW "fuse" typed into either one tomorrow exactly as well as it
// hides today's history — instead both get the EXACT, both-directions count ratchet
// test/windows-path-ratchet.test.cjs already uses for the same problem (COUNT_ALLOWED,
// below): every line currently there is grandfathered by the measured count, but the count
// itself is a tripwire — it fails the moment a NEW matching line appears (whatever its
// reason) or an old one disappears (a stale, too-generous count), so the file is never
// invisible to this gate the way a wholesale exemption would make it.
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
// task brief's own SKIP_DIRS sketch names the same two, for the same reason). spike/ not
// being renamed is also WHY .github/renovate.json and test/node-pins-agree.test.cjs need an
// ALLOWED entry below for the real spike/.../Dockerfile.xfuse — this list is what makes that
// path "out of scope" rather than "stale".
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

// Matches "fuse"/"fused"/"fuses"/"fusing" as a standalone word (excludes the whole
// refuse/confuse/... family automatically — no boundary before "fus" in any of them), OR the
// same suffix glued onto ANY other letter that is not one of the excluded English prefixes —
// this is what catches a camelCase compound (`sentinelFuse`, `materializeFused`) or a
// lowercase compound with no boundary at all (`xfuse`) without also catching `refuse`/
// `confuse`/`ECONNREFUSED`/`GATE_REFUSES`. See the file header for the full reasoning,
// including why the lookbehinds must sit AFTER the generic `[a-z]`, not before it.
const FUSE_RE = /\bfuse\b|\bfused\b|\bfuses\b|\bfusing\b/
  .source + '|[a-z](?<!re)(?<!con)(?<!dif)(?<!in)(?<!pro)(?<!ef)(?<!suf)(?<!de)fus(?:e|ed|es|ing)\\b';
const FUSE_WORD_RE = new RegExp(FUSE_RE, 'i');

const ALLOWED = [
  { file: 'scripts/build-naude.mjs', pattern: /sentinelFuse|NODE_SEA_FUSE_[0-9a-f]{32}/,
    because: "postject's own API parameter name and Node's own sentinel constant — "
      + 'upstream\'s vocabulary, not ours; a gate that forbade it would force a wrong fix.' },
  { file: 'test/fidelity/ci-claim-check.mjs', pattern: /fuses and runs a quaude/i,
    because: "verbatim quotation of RESULTS.md's own historical wording, quoted to explain "
      + 'why a `how: ci` claim needs a liveness check; paraphrasing it would no longer be '
      + 'the text being quoted.' },
  { file: 'test/fidelity/fidelity-notes.test.cjs', pattern: /fuses and\b/i,
    because: 'verbatim quotation of a specific note string that once drifted (the haiku-x64 '
      + 'example two lines below); the point of the example is exactly what was written at '
      + "the time, not today's vocabulary." },
  { file: 'libexec/quaude-blobulate.js',
    pattern: /WHY NOT "fuse"|`fuse` is Node SEA|sentinelFuse: 'NODE_SEA_FUSE_<hash>'/,
    because: "this file's own header is the canonical definition of \"blobulate\" (the task "
      + 'brief requires exactly one home for the coined word), and explaining a rename '
      + 'requires naming the word being replaced, and the upstream identifier it is not, '
      + 'once each — the same reasoning this gate applies to itself (see SELF above).' },
  { file: '.github/renovate.json', pattern: /Dockerfile\.xfuse|xfuse image/,
    because: 'names the real, on-disk spike/quickjs/qemu/docker-loop/Dockerfile.xfuse — '
      + 'spike/ is out of this task\'s scope (SKIP_DIRS above) and was never renamed, so '
      + 'this is the correct current name, not a stale one.' },
  { file: 'test/node-pins-agree.test.cjs', pattern: /Dockerfile\.xfuse|xfuse docker loop/,
    because: 'same reason as .github/renovate.json: names the real, unrenamed spike/.../'
      + 'Dockerfile.xfuse by its actual on-disk name.' },
];

// COUNT_ALLOWED — the exact, both-directions ratchet test/windows-path-ratchet.test.cjs uses
// (its ALLOWED table, `scanFiles`'s two finding loops): a file's TOTAL count of FUSE_WORD_RE-
// matching lines is grandfathered exactly at the number below, in EITHER direction. Growing
// past it (a new "fuse" line, for any reason) is a finding; shrinking below it (the file
// improved, and the count is now stale) is ALSO a finding — this repo's mechanism for "a
// number in this table must never go silently unnoticed to be wrong."
//
// Measured 2026-09-13 against FUSE_WORD_RE (widened, this round) with:
//   node -e "const fs=require('fs'); const FUSE_WORD_RE=/.../i; for (const f of [...])
//     console.log(f, fs.readFileSync(f,'utf8').split('\n').filter(l=>FUSE_WORD_RE.test(l)).length)"
// BACKLOG.md: 150. test/fidelity/RESULTS.md: 22.
const COUNT_ALLOWED = {
  'BACKLOG.md': 150,
  'test/fidelity/RESULTS.md': 22,
};

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
//
// TWO DETECTORS, each with its own control (see control() below): the FILENAME check (a
// reintroduced `quaude-fuse.js` is the single most likely regression) and the per-LINE scan.
// A COUNT_ALLOWED file's matching lines are tallied but never pushed individually — the
// ratchet check after this loop is their only finding path, both directions.
function scanForFuse({ files }) {
  const findings = [];
  let examined = 0;
  const countTally = {};
  const seen = new Set();
  for (const { rel, src } of files) {
    if (rel === SELF) continue;
    examined++;
    seen.add(rel);
    // A bare substring, not FUSE_WORD_RE: a FILENAME is a much smaller, controlled namespace
    // than prose (measured: no tracked path contains "refuse"/"confuse"/etc — the whole
    // family this file's header explains FUSE_WORD_RE exists to exclude), so the brief's
    // original, simpler check is exactly right here.
    if (/fuse/i.test(rel)) findings.push(`${rel}: the FILENAME still says fuse`);
    const isRatcheted = rel in COUNT_ALLOWED;
    for (const line of src.split('\n')) {
      if (!FUSE_WORD_RE.test(line)) continue;
      if (isRatcheted) { countTally[rel] = (countTally[rel] || 0) + 1; continue; }
      if (isAllowed(rel, line)) continue;
      findings.push(`${rel}: ${line.trim().slice(0, 120)}`);
    }
  }
  // Ratchet only fires for a COUNT_ALLOWED file that was actually part of THIS run's corpus
  // (`seen`) — a synthetic/partial corpus (the control below, or any future ad-hoc call)
  // that never included BACKLOG.md at all is not evidence BACKLOG.md "shrank to zero".
  for (const [rel, allowed] of Object.entries(COUNT_ALLOWED)) {
    if (!seen.has(rel)) continue;
    const actual = countTally[rel] || 0;
    if (actual > allowed) {
      findings.push(`${rel}: ${actual} fuse-matching lines (COUNT_ALLOWED says ${allowed}) — `
        + 'a new one was added; either it should say "blobulate" (today\'s vocabulary is '
        + 'always fine here) or, if it is genuinely new dated history, bump the count');
    } else if (actual < allowed) {
      findings.push(`${rel}: COUNT_ALLOWED says ${allowed} but only ${actual} remain — good `
        + 'news, this shrank; lower the count so the ratchet holds the gain.');
    }
  }
  return { findings, examined };
}

const guard = defineGuard({
  name: 'no-fuse-vocabulary',
  // The census this floor guards is FILES EXAMINED, not checks performed — it moves for
  // reasons that have nothing to do with coverage (anyone deleting a tracked .md file lowers
  // it by one), unlike phase 5's `examined` (which counts checks, so losing one IS losing
  // coverage). Following test/windows-path-ratchet.test.cjs's own precedent for this exact
  // distinction ("leaving room for ordinary file churn"): measured 2026-09-13 at 515 tracked,
  // candidate files (SELF excluded) — floor is 400, comfortably below that so an ordinary
  // month of file churn does not turn this BROKEN and train someone to re-cut the number, but
  // nowhere near what a genuinely broken corpus would produce: a `git ls-files` invocation
  // failure, a wrong cwd, or a candidate filter that regressed to matching almost nothing
  // reports empty or near-empty, not "off by a few dozen" — 400 is nowhere near that, so it
  // still catches the scan going BLIND, which is this floor's actual job.
  floor: 400,
  read: readCorpus,
  scan: scanForFuse,
  // TWO synthetic files, one per detector, so checkControl proves BOTH the filename branch
  // and the line-scan branch can independently fail — a single-file control that happened to
  // trip only one of them would leave the other unproven (fix round 1: the filename branch,
  // `if (/fuse/i.test(rel))`, is the one that catches a reintroduced quaude-fuse.js, the
  // single most likely regression this whole gate exists for, and the prior control never
  // exercised it). Neither file's OTHER property is contaminated: the filename-control file
  // has clean content ("// clean\n" — no line-scan finding), and the content-control file has
  // a clean, non-`fuse`-shaped name ("control.cjs" — no filename finding). Not
  // `sentinelFuse`/`NODE_SEA_FUSE_...` (the one real survivor) and not a `refuse`-family
  // word (which this guard must NOT flag), so the control proves the SAME discriminating
  // regex that protects those two categories still catches a plain, real "fuse" when one is
  // actually there. See the fix-round-1 report for the per-detector red-then-green.
  control: () => ({
    files: [
      { rel: 'synthetic/control.cjs',
        src: '// a fuse worker must never come back under this name.\n' },
      { rel: 'synthetic/quaude-fuse.js', src: '// clean\n' },
    ],
  }),
});
guardTests(guard);
