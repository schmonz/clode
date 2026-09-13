'use strict';
// no-retired-spellings.test.cjs — phase 3a, final fix wave. Task 6 BROKE five command-line
// spellings: `clode build --naude`, `clode build --self`, bare `clode fetch`,
// `clode fetch <channel|version>` and `clode watch` each now exit 2 with a usage error.
// Task 2 built a permanent gate for the retired VOCABULARY WORD (the one
// test/no-fuse-gate.test.cjs names); nothing gated the retired SPELLINGS, and the final
// whole-branch review found residue that a human sweep had missed: two package.json
// descriptions, a spike Dockerfile, a .gitignore comment, and three shipped, user-visible
// strings telling the user to run a command that now exits 2. This file is the same promise
// for argv that its sibling is for vocabulary, in deliberately the same shape (`git ls-files`
// corpus, ALLOWED entries with reasons, a both-directions COUNT ratchet, a control that
// proves it can fail), so a reader who has understood one has understood both.
//
// WHY THIS IS A DIFFERENT KIND OF GATE FROM ITS SIBLING, even though it looks the same. A
// retired WORD is a documentation defect: prose using it is merely out of date. A
// retired SPELLING is an EXECUTION defect: every line carrying one is either a call site that
// will fail, or an instruction telling a user to type something that will fail. That
// difference changes exactly one setting — SKIP_DIRS. The sibling skips both bench/ and
// spike/ because a rename of OUR files has no claim on trees we never renamed; this gate
// skips only bench/, because `stage0.mjs build --self` breaks wherever it is written down,
// spike/ included. (Proof it matters: the residue list included
// spike/quickjs/qemu/docker-loop's Dockerfile, which the sibling cannot see at all — and
// which the sibling's EXT_RE could not have read anyway, since its basename has a suffix
// after "Dockerfile". This gate's candidate filter accepts `Dockerfile` and `Dockerfile.*`.)
//
// WHAT THIS GATE CANNOT DO, said plainly so nobody trusts it further than it goes:
//   - It cannot tell an INSTRUCTION from an EXPLANATION. `clode build --naude` inside
//     "`clode build --naude` used to build a naude" is correct, permanent prose; the same
//     eight characters in a package.json description are a defect. No regex separates those.
//     This repo's answer to exactly that problem is already written: the both-directions
//     COUNT ratchet test/windows-path-ratchet.test.cjs uses, and test/no-fuse-gate.test.cjs
//     reuses for BACKLOG.md. So the files whose JOB includes naming the retired spellings —
//     the three libexec modules that IMPLEMENT the break, the tests that ASSERT it, and the
//     two journals — are ratcheted at an exact count instead of exempted. Every line there
//     today is grandfathered; a NEW one, for any reason, is a finding, and so is a stale
//     count after the prose improves. Nothing in this corpus is invisible to this gate.
//   - It is LINE-based, so a spelling split across a line break (`clode fetch` at the end of
//     one comment line and its ingredient at the start of the next) reads as bare
//     `clode fetch`. One such line exists today, in test/clode-fetch-ingredient.test.cjs; it
//     is inside the ratcheted test/ tree, so it costs a count and nothing else.
//   - It does not read man/clode.1's mdoc macro form (`.Cm watch`, `.Nm Cm fetch` with no
//     ingredient after it): those are not text a shell would accept, and
//     test/e2e-man.test.cjs ALREADY gates exactly those four shapes by name. Duplicating them
//     here would be a second place to keep true, which is the defect this phase is about.
//
// THE OPERATIVE RULE FOR "IS THIS SITE EXEMPT" (the sibling states one; this is ours, and it
// is narrower). A line may carry a retired spelling only when rewriting it would make the
// line LESS TRUE: a dated record of what a rig actually ran, or a user-owned document this
// agent is not allowed to edit. "It reads better this way" is not a reason, and "it is only a
// comment" is not a reason — a comment telling the next reader to run a dead command is the
// same defect as a log line telling a user to.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { defineGuard, guardTests } = require('./guard.cjs');

const REPO = path.resolve(__dirname, '..');
const SELF = 'test/no-retired-spellings.test.cjs';

// bench/ only — see the header for why spike/ is IN this gate's corpus and out of its
// sibling's. bench/ is a measurement harness whose scripts drive nothing in the product.
const SKIP_DIRS = new Set(['bench']);
const EXT_RE = /\.(cjs|mjs|js|json|yml|yaml|md|sh)$/;
// `Dockerfile`, and also `Dockerfile.<anything>` — the sibling checks only the bare basename,
// which is why that Dockerfile (its basename carries a suffix) was unreadable to it even
// before SKIP_DIRS got a chance to exclude it. A Dockerfile RUNs its lines.
function isDockerfile(base) { return /^Dockerfile(\.|$)/.test(base); }
// A leading dot is a hidden-file marker, not an extension separator (path.extname agrees:
// extname('.gitignore') === ''), so .gitignore, VERSION, LICENSE and .githooks/* are all
// candidates. That matters: .gitignore carried residue.
function hasNoExtension(rel) { return path.extname(rel) === ''; }

// THE FIVE RETIRED SPELLINGS, as four detectors (`--naude` covers both the build flag and the
// fetch flag), each with the replacement its finding will name. Written to be SHAPE-specific
// rather than word-specific, because three of the five words are ordinary English this repo
// uses constantly:
//
//   --naude   A bare flag token, never anything else in this repo. `\b` on the right so
//             `--naude-ish` is not assumed.
//   --self    `(?![-\w])` on the right, NOT `\b`: scripts/spawn-cost-probe.mjs has an
//             unrelated, still-live `--self-test` flag, and `\b` fires between "f" and "-",
//             so a `\b` version flags it three times. Verified in MUST_NOT_MATCH.
//   watch     ONLY as a verb after an invocation (`clode watch`, `stage0.mjs watch`). A bare
//             /watch/ would flag clode-watch.cjs, CLODE_NO_WATCH, CLODE_WATCH_DIR, "the
//             watcher", "watch signals" — dozens of correct, current names. The right-hand
//             `\b` keeps "clode watches the changelog" out.
//   fetch     Same invocation prefix, plus a NEGATIVE LOOKAHEAD for the two ingredients:
//             `clode fetch claude` and `clode fetch node` are today's spellings and must
//             never be flagged, while `clode fetch`, `clode fetch stable` and
//             `clode fetch 2.1.251` all are. The right-hand `\b` keeps the very common
//             "what clode fetches" out (measured: it appears in five files).
const RETIRED = [
  { name: '--naude',
    re: /--naude\b/,
    now: '`clode build naude` (or `clode fetch node`)' },
  { name: '--self',
    re: /--self(?![-\w])/,
    now: '`clode bootstrap` (checkout only: `node scripts/stage0.mjs bootstrap`)' },
  { name: 'clode watch',
    re: /\b(?:clode|stage0\.mjs)\s+watch\b/,
    now: '`clode read-anthropic-tea-leaves`' },
  { name: 'clode fetch (no ingredient)',
    re: /\b(?:clode|stage0\.mjs)\s+fetch\b(?!\s+(?:claude|node)\b)/,
    now: '`clode fetch claude` (or `clode fetch node`)' },
];
const RETIRED_RE = new RegExp(RETIRED.map((r) => r.re.source).join('|'));

// The acceptance table, committed so a future "simplification" of any detector cannot regress
// a shape silently — this test, not the comment above it, is the source of truth. Every
// MUST_MATCH string is a spelling the break actually removed; every MUST_NOT_MATCH string is
// either a spelling that REPLACED one (which must never be flagged, or the gate would forbid
// the fix) or a real, unrelated identifier that lives in this repo today.
const MUST_MATCH = [
  'clode build --naude', 'build --naude', '--naude', 'clode fetch --naude',
  'clode build --self', '--self', 'node scripts/stage0.mjs build --self',
  'clode watch', 'node scripts/stage0.mjs watch',
  'clode fetch', 'clode fetch stable', 'clode fetch 2.1.251', 'clode fetch [channel|version]',
];
const MUST_NOT_MATCH = [
  // The replacements. A gate that flagged these would forbid the correction it demands.
  'clode build naude', 'clode build quaude', 'clode bootstrap',
  'node scripts/stage0.mjs bootstrap', 'clode fetch claude', 'clode fetch node',
  'clode fetch claude stable', 'clode read-anthropic-tea-leaves',
  // Real, unrelated, still-live things in this repo.
  '--self-test', 'node scripts/spawn-cost-probe.mjs --self-test', '--selfish',
  'libexec/clode-watch.cjs', 'CLODE_NO_WATCH', 'CLODE_WATCH_DIR', 'the watcher runs',
  'clode watches the changelog', 'a downloaded clode fetches', 'what clode fetches',
  'clode fetches nothing behind your back',
];
test('every retired spelling matches, and every replacement and unrelated identifier does not', () => {
  const missed = MUST_MATCH.filter((s) => !RETIRED_RE.test(s));
  const wrongly = MUST_NOT_MATCH.filter((s) => RETIRED_RE.test(s));
  assert.deepStrictEqual(missed, [], `RETIRED_RE failed to match: ${missed.join(', ')}`);
  assert.deepStrictEqual(wrongly, [], `RETIRED_RE wrongly matched: ${wrongly.join(', ')}`);
});

// ALLOWED — the sites where rewriting the line would make it LESS TRUE. Four entries, and
// each one is a different flavour of that, not a different flavour of "too much work".
const ALLOWED = [
  { file: 'README.md', pattern: /clode build --naude|clode fetch\b/,
    because: "README.md is the USER'S OWN VOICE and this agent does not write or rewrite it "
      + '(the standing rule in this project). Its three lines really are stale — `clode build '
      + '--naude` and bare `clode fetch` both exit 2 now — and that is being raised with the '
      + 'user directly rather than fixed here. This entry is the record that it was SEEN and '
      + 'deliberately not touched, not that it is correct; when the user updates README.md, '
      + 'delete this entry rather than leaving a permanent pass behind.' },
  { file: 'spike/quickjs/PINS.md', pattern: /build --self/,
    because: 'a DATED proof row recording what a specific rig actually ran on a specific day '
      + "(`quaude ... build --self, clode-native acceptance 4/4`). The command it names is the "
      + 'command that was run; rewriting it to today\'s spelling would misreport history, and '
      + 'the row is evidence, not an instruction to repeat.' },
  { file: 'spike/quickjs/qemu/ci-guest-smoke.sh', pattern: /cross-\w+ on the x64 runner \(--self\)/,
    because: 'a comment identifying WHICH artifact the historical sparc rig copied in, by the '
      + 'flag that produced it at the time. Nothing in the script runs the flag (grep the '
      + 'file: it execs the already-built binary), so there is no call site to break — and '
      + 'naming a 2026-era artifact by the flag that built it is the accurate label.' },
  { file: 'spike/quickjs/qemu/docker-loop/RESOURCES.md', pattern: /\| cross-\w+ clode --self \|/,
    because: 'a row in a measured COST table (wall-clock per step for the sparc loop). The '
      + 'row names the step as it was run and timed; changing its label would detach the '
      + 'number from the thing measured.' },
];

// COUNT_ALLOWED — an EXACT, both-directions ratchet, the mechanism
// test/windows-path-ratchet.test.cjs established and test/no-fuse-gate.test.cjs reuses. A key
// ending in `/` is a DIRECTORY AGGREGATE (every candidate file under it, summed); any other
// key is one file. Growing past the number is a finding (a new retired spelling appeared,
// whatever the reason); shrinking below it is ALSO a finding (the prose improved and the
// number is now stale). Nothing here is exempt — everything here is COUNTED.
//
// WHY EACH KEY IS RATCHETED RATHER THAN FIXED:
//   BACKLOG.md              a constantly-edited triage document whose entries quote the argv
//                           of the day; its own line 5 says done items are deleted, so it is
//                           not append-only and cannot get a blanket pass.
//   CHANGELOG.md            release notes. The `## Unreleased` section added in this same
//                           wave is the ONE place the retired spellings have to appear in
//                           full — it is the document that tells users what broke — and the
//                           older entries are dated history of shipped releases.
//   libexec/cli-surface.cjs  the three modules that IMPLEMENT the break. Their comments
//   libexec/clode-build.cjs  explain WHY each flag is gone and what it used to do; a reader
//   libexec/clode-main.cjs   who cannot see the old spelling cannot check the explanation.
//                           Ratcheted, not exempted, because these are also the files most
//                           likely to regrow a live call site.
//   test/                   ONE aggregate over the whole tree. A test asserting that
//                           `--naude` is refused must contain `--naude`; that is the test
//                           doing its job. Aggregated rather than per-file because the
//                           individual numbers are pure churn (moving an assertion between
//                           two files would fail two per-file ratchets and mean nothing),
//                           while the total still fires the moment the tree gains or loses
//                           one. SELF is excluded from the corpus, so this file's own
//                           acceptance table above does not count toward it.
//
// MEASURED 2026-09-13, after this wave's fixes, by running this gate's own RETIRED_RE over
// the corpus candidateFiles() returns. Re-measure, do not trust these numbers:
//   node -e "const {execFileSync}=require('child_process'); ..." — or simply run this test
//   and read the finding, which prints both the actual and the recorded number.
const COUNT_ALLOWED = {
  'BACKLOG.md': 26,
  'CHANGELOG.md': 12,
  'libexec/cli-surface.cjs': 6,
  'libexec/clode-build.cjs': 6,
  'libexec/clode-main.cjs': 6,
  // 39 -> 40 (this same wave): the new `parseBuildArgs: the retired product flags are
  // unknown arguments` assertion pinning that bootstrap no longer claims `usage: clode
  // bootstrap` passes ['--naude'] one more time. A test of the break naming the break.
  'test/': 40,
};

// Which COUNT_ALLOWED key governs this file: the exact path if there is one, else the
// longest `/`-suffixed prefix that matches. Returns undefined when the file is not ratcheted
// at all (the normal case — a finding per line).
function ratchetKey(rel) {
  if (rel in COUNT_ALLOWED) return rel;
  let best;
  for (const key of Object.keys(COUNT_ALLOWED)) {
    if (!key.endsWith('/') || !rel.startsWith(key)) continue;
    if (!best || key.length > best.length) best = key;
  }
  return best;
}

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
    return EXT_RE.test(rel) || isDockerfile(path.basename(rel)) || hasNoExtension(rel);
  });
}

// read() — the only I/O. `git ls-files` IS the project (it already excludes build/,
// node_modules/, test/.harness/, docs/ and .superpowers/, all gitignored), so the corpus is
// the same on two checkouts of the same commit and `floor` can be a fixed integer.
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

// PURE. {findings, examined}; `examined` is a FILE count (SELF excluded from both, since this
// file names every retired spelling in order to forbid them).
//
// TWO DETECTORS: the per-line scan (an un-ratcheted, un-allowed line is a finding naming the
// replacement) and the COUNT ratchet (both directions, per key). Both are exercised by
// control() below — which does NOT prove either can fail on its own; see the note there.
function scanRetired({ files }) {
  const findings = [];
  let examined = 0;
  const countTally = {};
  const seenKeys = new Set();
  for (const { rel, src } of files) {
    if (rel === SELF) continue;
    examined++;
    const key = ratchetKey(rel);
    if (key) seenKeys.add(key);
    for (const line of src.split('\n')) {
      if (!RETIRED_RE.test(line)) continue;
      if (key) { countTally[key] = (countTally[key] || 0) + 1; continue; }
      if (isAllowed(rel, line)) continue;
      const hit = RETIRED.find((r) => r.re.test(line));
      findings.push(`${rel}: retired spelling ${hit ? hit.name : '?'} — use `
        + `${hit ? hit.now : 'the current spelling'}: ${line.trim().slice(0, 100)}`);
    }
  }
  // A ratchet fires only for a key this run actually SAW (a synthetic or partial corpus that
  // never included BACKLOG.md is not evidence BACKLOG.md shrank to zero).
  for (const [key, allowed] of Object.entries(COUNT_ALLOWED)) {
    if (!seenKeys.has(key)) continue;
    const actual = countTally[key] || 0;
    if (actual > allowed) {
      findings.push(`${key}: ${actual} lines carry a retired spelling (COUNT_ALLOWED says `
        + `${allowed}) — a new one appeared. Either it should use today's spelling (always `
        + 'fine here) or, if it is genuinely new history or a genuinely new test of the '
        + 'break, bump the count.');
    } else if (actual < allowed) {
      findings.push(`${key}: COUNT_ALLOWED says ${allowed} but only ${actual} remain — good `
        + 'news, this shrank; lower the count so the ratchet holds the gain.');
    }
  }
  return { findings, examined };
}

const guard = defineGuard({
  name: 'no-retired-spellings',
  // FILES EXAMINED, not checks performed — it moves for reasons unrelated to coverage (any
  // deleted tracked .md lowers it by one), so it is cut well below the measurement with room
  // for ordinary churn, exactly as test/no-fuse-gate.test.cjs and
  // test/windows-path-ratchet.test.cjs cut theirs. Measured 2026-09-13: 597 tracked candidate
  // files (SELF included in that count; it is excluded from `examined`, so `examined` is 596).
  // Floor 450 is far below that, and just as far above what a BLIND scan produces — a failed
  // `git ls-files`, a wrong cwd, or a candidate filter that regressed reports zero or a
  // handful, never "a hundred short". Catching the scan going blind is this floor's job; it is
  // not a coverage assertion.
  floor: 450,
  read: readCorpus,
  scan: scanRetired,
  // TWO synthetic files, one per detector — and read test/guard.cjs before believing that
  // proves more than it does. checkControl's whole verdict is `findings.length > 0`, over an
  // unlabelled list, so a control that trips two detectors is indistinguishable from one that
  // trips one: deleting either detector here would leave this control GREEN. (Not a guess:
  // mutation-proven on this gate — blinding the per-line scan alone left
  // `guard control: no-retired-spellings can fail` passing, carried by the ratchet detector
  // alone. Filed in BACKLOG.md with the two shapes guard.cjs would need to close it; NOT
  // worked around inside guard.cjs from here.) So the per-detector claim is made by a plain
  // unit test below instead (`each control file, ALONE, produces a finding`), which runs the
  // same two fixtures one at a time — the local version of what a labelled-findings
  // checkControl would do for every guard. What the two-file control itself buys: both code
  // paths run on every invocation, so a scan that throws or quietly stops handling one input
  // shape is caught; and both violation SHAPES sit next to the scan as executable examples.
  //   - 'synthetic/instructions.md' models the defect this gate was built for: a document
  //     telling a reader to run a command that now exits 2. Not a ratcheted path and not an
  //     ALLOWED file, so it takes the per-line path.
  //   - 'BACKLOG.md' models the ratchet: one matching line against a recorded 26 fires the
  //     SHRANK direction, which is the half a one-directional ratchet would miss.
  control: () => ({
    files: [
      { rel: 'synthetic/instructions.md',
        src: 'To build a Node SEA, run `clode build --naude`.\n' },
      { rel: 'BACKLOG.md', src: 'once upon a time you would type `clode watch`.\n' },
    ],
  }),
});
guardTests(guard);

// The per-detector claim checkControl structurally cannot make (see control() above): run
// each control fixture ALONE through the real scan and require it, by itself, to produce a
// finding. Deleting either detector now fails HERE even though the guard's own control stays
// green — which is the whole point. Each case also asserts the finding came from the intended
// detector, so a fixture that starts tripping the other one (a future ALLOWED/COUNT_ALLOWED
// edit could do that silently) is caught rather than counted as proof.
test('each control file, ALONE, produces a finding from its own detector', () => {
  const [lineCase, ratchetCase] = guard.control().files;

  const line = scanRetired({ files: [lineCase] });
  assert.strictEqual(line.findings.length, 1,
    `the per-LINE detector must fire on ${lineCase.rel} by itself, with nothing else in the `
    + `corpus — got ${JSON.stringify(line.findings)}`);
  assert.match(line.findings[0], /retired spelling/,
    'and it must be the per-line finding, not a ratchet one');

  const ratchet = scanRetired({ files: [ratchetCase] });
  assert.strictEqual(ratchet.findings.length, 1,
    `the COUNT ratchet must fire on ${ratchetCase.rel} by itself (its one matching line is `
    + `far below the recorded count) — got ${JSON.stringify(ratchet.findings)}`);
  assert.match(ratchet.findings[0], /COUNT_ALLOWED says \d+ but only \d+ remain/,
    'and it must be the SHRANK direction of the ratchet — the half a one-directional '
    + 'ratchet would miss');
});
