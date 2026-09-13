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
// THE CAMELCASE HALF (fix round 1, then corrected in fix round 2 — both coordinator review;
// the acceptance table this section describes is now committed as a unit test below,
// `test('FUSE_WORD_RE matches every reintroduction shape...')`, so it cannot regress
// silently). A plain \bfuse\b cannot see a compound with NO boundary at all —
// `materializeFusedPayload`, `sentinelFuse`, `xfuse` all have a WORD CHARACTER immediately
// before "fuse"/"Fuse", so \b never fires there, and this gate shipped blind to the exact
// shape this task spent most of its effort renaming.
//
// Round 1's fix — a single case-insensitive alternative,
// `[a-z](?<!re)...(?<!de)fus(?:e|ed|es|ing)\b` — was ALSO wrong, in the opposite direction
// from a naive `/[a-z]Fus(...)\b/i` (which matched `refuse` too, 302 false positives,
// measured by actually running it). Round 1's version excluded the refuse family correctly,
// but the trailing `\b` only fires when "fuse" is the LAST segment of an identifier —
// `sentinelFuse`, `xfuse`, `unfused` all happen to sit there, which is why round 1's own
// verification table passed while missing the row that mattered: `materializeFusedPayload`
// (round 1's table tested the wrong string, `materializeFused`, and never caught it).
// `fusedBuilder`, `scanFuseReportWiring`, `fuseSrc` — real identifiers from this very task's
// own sweep — all put "fuse" in a MIDDLE segment, where the character right after it is
// another word character (the next segment's capital letter), so `\b` does not exist there
// either. Regex word boundaries do not know about camelCase; the fix has to look at
// adjacent CASE, not just adjacent word-character-ness.
//
// The working fix is five case-SENSITIVE alternatives (no shared /i — that flag is exactly
// what broke round 1's naive attempt, since it makes `[a-z]` fold `A-Z` and erases the one
// signal — capitalization — that tells `someFuseThing` apart from `confuse`):
//   \b[Ff]us(?:e|ed|es|ing)(?=[A-Z]|\b)                                   -- A: word-initial
//   [a-z0-9]Fus(?:e|ed|es|ing)                                            -- B: camelCase-in
//   \bFUS(?:E|ED|ES|ING)\b                                                -- C: ALL-CAPS word
//   [a-z](?<!re)(?<!con)(?<!dif)(?<!in)(?<!pro)(?<!ef)(?<!suf)(?<!de)fus(?:e|ed|es|ing)\b -- D
//   [A-Z](?<!RE)(?<!CON)(?<!DIF)(?<!IN)(?<!PRO)(?<!EF)(?<!SUF)(?<!DE)FUS(?:E|ED|ES|ING)\b -- E
// A is word-initial lowercase/Title-case with a RELAXED right side (a following capital
// letter — camelCase-out, `fuseSrc` — is as good as a true \b, so this alone covers both
// `fuse` alone and `fusedBuilder`). B is the camelCase-IN half: a lowercase/digit directly
// before a capital "Fus" needs no right-side constraint at all, since the left-side case
// transition is already the strong signal (`materializeFused`, `scanFuseReportWiring`,
// `sentinelFuse`). C is the plain ALL-CAPS word. D and E are round 1's lookbehind-exclusion
// trick, kept for the two compounds with NO case transition anywhere (`xfuse`, `unfused`/
// `UNFUSED`) — D case-sensitive-lowercase-only, E case-sensitive-uppercase-only, so neither
// can cross-contaminate the other the way a shared /i flag did. D excludes each prefix in
// BOTH its lowercase and Title-case spelling (`(?<!re)(?<!Re)`, etc) — round 2's OWN first
// attempt at D used lowercase-only lookbehinds and matched "Refusing" as "efusing", because a
// case-sensitive `(?<!re)` does not recognise "Re" (capital R) as the thing it excludes; found
// by re-running the real 515-file gate, not by inspection — a real, sentence-initial "Refusing
// to guess." sits in five production files. Every one of these five (now six, counting D's
// two case variants) alternatives was necessary: removing any single one fails at least one
// row of the acceptance table (checked directly, not assumed).
//
// UNFUSED, specifically flagged by the coordinator as the row expected to be structurally
// impossible (same shape as ECONNREFUSED — a prefix glued on with no case transition) turned
// out to be satisfiable: "UN" is not one of the excluded prefixes {re, con, dif, in, pro, ef,
// suf, de}, so alternative E excludes ECONNREFUSED/GATE_REFUSES (prefix "RE") while still
// matching UNFUSED (prefix "UN") — verified in the acceptance table below, not asserted.
//
// THE STILL-KNOWN GAP, narrower now, named rather than chased: alternatives D/E's exclusion
// list is a FIXED set of known English prefixes. A future real English word built the same
// way — some prefix this list has never met, glued onto "fuse" with no case transition —
// would slip through as a false positive requiring a new ALLOWED entry, which is the safer
// failure direction (a spurious finding someone has to look at, not a silent miss). That is
// the same tradeoff test/windows-path-ratchet.test.cjs names for its own regexes: "it cannot
// catch a shape we have not met." This guard's job is the word as it actually appears in this
// repo today, proven by its two controls below (one per detector — see control()) and by the
// acceptance-table unit test, not every conceivable future English word.
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
// bin/clode (since renamed+moved to scripts/stage0.mjs, which HAS an extension)
// used to have no extension (a shebang script, `#!/usr/bin/env node`) and was
// invisible to an EXT_RE-only filter until this line — found by running this exact gate
// and then grepping the tracked corpus by hand for anything the extension list could not
// see. Any tracked path with no extension is a candidate too (LICENSE, UPSTREAM_PIN,
// VERSION, .tool-versions and .githooks/* all qualify; none of them is large
// or binary, so reading them as UTF-8 text is safe). A LEADING dot (.tool-versions,
// .githooks/post-checkout) is a hidden-file marker, not an extension separator — only a
// dot after the first character counts — exactly the distinction path.extname() already
// draws (extname('.tool-versions') === '', extname('.eslintrc.json') === '.json').
function hasNoExtension(rel) { return path.extname(rel) === ''; }

// Five case-SENSITIVE alternatives (deliberately no shared /i — see the file header for why
// that flag is exactly what breaks this): A word-initial lowercase/Title-case with a
// right side relaxed to allow a following capital letter (`fuse`, `fusedBuilder`,
// `fuseSrc`); B a lowercase/digit directly before a capital "Fus" segment, no right-side
// constraint needed (`materializeFusedPayload`, `sentinelFuse`, `scanFuseReportWiring`); C
// the plain ALL-CAPS word (`FUSE`, `FUSED`); D/E the one shape with NO case transition at
// all (`xfuse`, `unfused`/`UNFUSED`), each excluding the known English prefixes {re, con,
// dif, in, pro, ef, suf, de} in its own case only, so D and E cannot cross-contaminate the
// way a shared /i flag would. Verified against the full acceptance table in the unit test
// below before trusting it — that test is the source of truth for this regex, not this
// comment.
const FUSE_WORD_RE = new RegExp([
  '\\b[Ff]us(?:e|ed|es|ing)(?=[A-Z]|\\b)',                                              // A
  '[a-z0-9]Fus(?:e|ed|es|ing)',                                                          // B
  '\\bFUS(?:E|ED|ES|ING)\\b',                                                            // C
  '[a-z](?<!re)(?<!con)(?<!dif)(?<!in)(?<!pro)(?<!ef)(?<!suf)(?<!de)'
    + '(?<!Re)(?<!Con)(?<!Dif)(?<!In)(?<!Pro)(?<!Ef)(?<!Suf)(?<!De)fus(?:e|ed|es|ing)\\b',  // D
  '[A-Z](?<!RE)(?<!CON)(?<!DIF)(?<!IN)(?<!PRO)(?<!EF)(?<!SUF)(?<!DE)FUS(?:E|ED|ES|ING)\\b', // E
].join('|'));

// The acceptance table itself, committed so a future "simplification" of FUSE_WORD_RE cannot
// regress any of these shapes silently — this is the source of truth the comment above
// summarizes, not the other way around. Every MUST_MATCH string is a real shape this task
// actually renamed somewhere in this repo (not a hypothetical); every MUST_NOT_MATCH string
// is a real English word or a real unrelated identifier already living in this repo (see the
// file header for where each one is used) that this gate must never flag.
const MUST_MATCH = [
  'fuse', 'fused', 'fuses', 'fusing', 'Fuse', 'FUSE', 'unfused', 'UNFUSED', 'xfuse',
  'cross-fuse', 'sentinelFuse', 'someFuseThing', 'materializeFusedPayload', 'fusedBuilder',
  'scanFuseReportWiring', 'fuseSrc', 'quaude-fuse.js',
];
const MUST_NOT_MATCH = [
  'refuse', 'refused', 'refuses', 'refusing', 'confuse', 'confused', 'diffuse', 'defuse',
  'profuse', 'ECONNREFUSED', 'GATE_REFUSES', 'refusal',
  // Extra, beyond the coordinator's table — the rest of the excluded-prefix family, and the
  // new word itself, so a future edit cannot "fix" a MUST_MATCH regression by accidentally
  // widening FUSE_WORD_RE to swallow "blobulate" too.
  'infuse', 'infused', 'effuse', 'effused', 'suffuse', 'suffused', 'fuselage', 'PROXY_REFUSE',
  'blobulate', 'blobulated', 'cross-blobulate',
  // Sentence-initial Title-case — found by this same round's own re-verification, not the
  // coordinator's table: shape D's exclusion lookbehinds were written lowercase-only
  // (`(?<!re)`), so "Refusing to guess." (a real line in libexec/bun-graph.cjs and four other
  // production files) matched as "efusing", since "Re" (capital R) is not "re" under a
  // case-SENSITIVE lookbehind. D now excludes both cases explicitly.
  'Refuse', 'Refused', 'Refusing', 'Confuse', 'Confused', 'Diffuse', 'Defuse', 'Profuse',
  'Infuse', 'Infused', 'Effuse', 'Suffuse', 'Suffused',
];
test('FUSE_WORD_RE matches every reintroduction shape this task actually renamed, and none of the English words or unrelated identifiers it must not flag (fix round 2 acceptance table)', () => {
  const missed = MUST_MATCH.filter((s) => !FUSE_WORD_RE.test(s));
  const wrongly = MUST_NOT_MATCH.filter((s) => FUSE_WORD_RE.test(s));
  assert.deepStrictEqual(missed, [], `FUSE_WORD_RE failed to match: ${missed.join(', ')}`);
  assert.deepStrictEqual(wrongly, [], `FUSE_WORD_RE wrongly matched: ${wrongly.join(', ')}`);
});

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
  { file: 'test/no-retired-spellings.test.cjs', pattern: /no-fuse-gate\.test\.cjs/,
    because: 'names THIS FILE by its real, on-disk path. The retired-spellings gate is built '
      + 'in this gate\'s shape and says so four times (corpus, ALLOWED, the count ratchet, the '
      + 'floor), which is the point — a reader who has understood one has understood both. '
      + 'Same category as .github/renovate.json and test/node-pins-agree.test.cjs above: a '
      + 'REAL PATH this task did not rename, named correctly. (This gate keeps its own name '
      + 'for the reason its SELF entry gives: the word has to appear in order to be '
      + 'forbidden.)' },
  { file: 'test/guards-population.cjs', pattern: /no-fuse-gate\.test\.cjs/,
    because: 'names THIS FILE by its real, on-disk path, in a comment explaining why '
      + "test/no-fuse-gate.test.cjs and test/no-retired-spellings.test.cjs are Windows-safe "
      + 'by construction (their corpus comes from `git ls-files`, always forward-slash) '
      + 'while guards-population.cjs\'s own filesystem walk is not — the exact contrast that '
      + "motivated the windows-path fix this file's toPosixRel() comment records. Same "
      + 'category as the test/no-retired-spellings.test.cjs entry above: a REAL PATH, named '
      + 'correctly.' },
];

// COUNT_ALLOWED — the exact, both-directions ratchet test/windows-path-ratchet.test.cjs uses
// (its ALLOWED table, `scanFiles`'s two finding loops): a file's TOTAL count of FUSE_WORD_RE-
// matching lines is grandfathered exactly at the number below, in EITHER direction. Growing
// past it (a new "fuse" line, for any reason) is a finding; shrinking below it (the file
// improved, and the count is now stale) is ALSO a finding — this repo's mechanism for "a
// number in this table must never go silently unnoticed to be wrong."
//
// Measured 2026-09-13, re-measured after fix round 2's camelCase widening (which sees more
// of BACKLOG.md than round 1's regex did — round 1 caught 150 lines; round 2 additionally
// sees BACKLOG.md:6624's middle-segment `materializeFusedPayload` quote, a real historical
// reference to the exact identifier this task renamed, which round 1's trailing-\b-only
// regex could not see there):
//   node -e "const fs=require('fs'); const FUSE_WORD_RE=/.../; for (const f of [...])
//     console.log(f, fs.readFileSync(f,'utf8').split('\n').filter(l=>FUSE_WORD_RE.test(l)).length)"
// BACKLOG.md: 151. test/fidelity/RESULTS.md: 22 (unchanged — RESULTS.md's dated rows use only
// the trailing-position shape round 1 already saw).
//
// 151 -> 152 (2026-09-13, phase 3a task 5 fix round 1): commit c4d5198 ("docs(backlog): the
// production-gate classifier reads comments as code") added ONE matching line —
// "the phase-5b `no-fuse` gate matching ..." — which matches because the hyphen in this
// gate's OWN NAME is a word boundary before "fuse". That is today's vocabulary naming a
// mechanism (this file's SELF entry above exempts the same self-reference inside the gate),
// so the count is bumped rather than the prose reworded; the ratchet stays exact in both
// directions. Re-measure, do not trust this number:
//   node -e "const {FUSE_WORD_RE}=...; const fs=require('fs');
//     console.log(fs.readFileSync('BACKLOG.md','utf8').split('\n').filter(l=>FUSE_WORD_RE.test(l)).length)"
// 152 -> 155 (2026-09-13, phase 3a final fix wave): the new BACKLOG entry filing
// test/guard.cjs's `checkControl` per-detector gap adds THREE matching lines, all of the same
// kind as the 151 -> 152 bump above — today's vocabulary naming a MECHANISM by its real name:
// `test/no-fuse-gate.test.cjs`'s `scanForFuse` (a real file and a real function),
// `guard control: no-fuse-vocabulary can fail` (the verbatim name of a test whose output the
// entry quotes), and a list of this repo's multi-detector guards which includes
// `no-fuse-vocabulary`. Each matches because the hyphen/underscore before "fuse" or "Fuse" is
// a word boundary, exactly as this gate's own name does. Rewriting any of them would name the
// guards wrongly, so the count moves. Re-measure, do not trust this number.
const COUNT_ALLOWED = {
  'BACKLOG.md': 155,
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
  // TWO synthetic files, one per detector. WHAT THAT ACTUALLY BUYS, stated correctly —
  // the previous version of this comment claimed checkControl "proves BOTH the filename
  // branch and the line-scan branch can independently fail", and that is FALSE. Read
  // test/guard.cjs's checkControl: its entire verdict is `if (r.findings.length > 0)
  // return OK`. Findings are an unlabelled list, so one detector's finding is
  // indistinguishable from two, and a control that trips two detectors is
  // indistinguishable from a control that trips one. MUTATION-PROVEN, not reasoned:
  // deleting the filename branch (`if (/fuse/i.test(rel))`) outright leaves this control
  // still producing a finding from the content file alone, and `guard control:
  // no-fuse-vocabulary can fail` stays GREEN. A second control file cannot prove
  // per-detector failability through an API that only counts.
  //
  // What the second file DOES buy, which is real and worth keeping: (a) both detectors
  // are EXERCISED on every run, so a scan that throws, or silently stops handling one
  // input shape, is caught by the guard crashing rather than by nobody noticing; (b) the
  // two violation SHAPES are written down as executable fixtures next to the scan, so a
  // future author changing one detector has the example in front of them; and (c) with
  // both files present the control is a faithful model of the worst case this gate exists
  // for — a reintroduced quaude-fuse.js with a live "fuse" inside it. Proving each
  // detector independently needs a checkControl that can tell findings apart (per-detector
  // controls, or a labelled-findings contract) — filed in BACKLOG.md, deliberately not
  // patched from inside one gate's control().
  //
  // Neither file's OTHER property is contaminated: the filename-control file has clean
  // content ("// clean\n" — no line-scan finding), and the content-control file has a
  // clean, non-`fuse`-shaped name ("control.cjs" — no filename finding). Not
  // `sentinelFuse`/`NODE_SEA_FUSE_...` (the one real survivor) and not a `refuse`-family
  // word (which this guard must NOT flag), so the control models the SAME discriminating
  // regex that protects those two categories still catching a plain, real "fuse" when one
  // is actually there.
  control: () => ({
    files: [
      { rel: 'synthetic/control.cjs',
        src: '// a fuse worker must never come back under this name.\n' },
      { rel: 'synthetic/quaude-fuse.js', src: '// clean\n' },
    ],
  }),
});
guardTests(guard);
