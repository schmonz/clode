'use strict';
// guards-population.cjs — the phase-5 sweep that finds scanner-shaped tests which are
// NOT registered through test/guard.cjs's defineGuard, so that "a guard nobody proved can
// fail" becomes structurally visible instead of quietly possible.
//
// THE DESIGN POINT THAT MAKES THIS SWEEP DIFFERENT FROM EVERY OTHER SCANNER IN THIS REPO:
// its own floor is the migrated population itself (MIGRATED below). It re-discovers every
// guard already registered through defineGuard by reading each candidate file's SOURCE for
// the two textual facts that make it a guard — `require('./guard.cjs')` and a
// `defineGuard(` call — not by hand-listing their names. If classifyTestFile() ever stops
// recognising guard shape, MIGRATED still lists the same files (they are derived from the
// source text, not from the classifier), so the FLOOR test in guards-population.test.cjs
// goes red: the classifier failed to recognise a file we KNOW is a guard. A hand-written
// fixture could not do this — it would stay green forever, describing an encoding that may
// have already drifted, which is the exact "control describes a violation that no longer
// matches the artifact" failure phase 5 exists to close (see the MIGRATED note in
// node-shim-wall-tripwires.test.cjs for the concrete incident this generalises).
//
// STATIC, NOT EXECUTED (fix round 1, 2026-09-04): an earlier version of deriveMigrated()
// required() every candidate file and read test/guard.cjs's registered() before/after to
// confirm it actually registered a guard — provably correct, but it meant merely LOADING
// this module re-ran every migrated guard's entire test file (guardTests() plus every
// other test() in the file) as a side effect, every time. That cost is O(migrated files)
// and was already ~7 extra tests with only two guards migrated; it would have scaled
// linearly with every file Task 14 moves onto this list, making the sweep's own cost grow
// with the very thing it measures. A guard whose defineGuard() call is broken already fails
// LOUDLY on its own — guardTests() asserts the control produces findings and the gate is
// clean — so nothing is lost by not executing it here too; a static source check (both
// facts present in the text) gets the same MIGRATED membership with zero executions.
//
// TUNING RULE (from the spec, verbatim): false positives are the SAFE side. A false
// positive costs one migration or one recorded exclusion with a reason; a false negative
// is a guard nobody proved. When in doubt, flag it.
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');

// Reads something it did not create: a repo-rooted path, a staged provider, or the
// upstream carve. Deliberately NOT "uses readFileSync" — half the suite reads fixtures it
// wrote itself, and flagging those would train people to add exclusions, which is how an
// allow-list becomes noise nobody reads.
//
// FIX ROUND 2 (coordinator, 2026-09-04) — CRITICAL, the dangerous direction the spec calls
// out: the original rule required a READ call and a repo-rooting expression to appear
// inside the SAME readFileSync(...) call. A reviewer sample of files the sweep did NOT
// flag found real guards missed for exactly that reason — msvc-getopt-shim.test.cjs,
// tjs-build-hermeticity.test.cjs, update-guard-drift.test.cjs, quaude-fuse-report.test.cjs,
// scc-merge.test.cjs (71 assert.match calls against artifacts it did not create — the
// starkest miss), win-sync-guards.test.cjs — six of seven sampled misses traced to
// indirection defeating the same-call co-location: a lowercase `repo` variable,
// `require.resolve()`, a path built on an earlier line into a named constant, a
// helper-function parameter. Decoupled below into two WHOLE-FILE facts ANDed together
// (READ_CALLS anywhere, REPO_ROOTED anywhere — not necessarily the same statement), per the
// spec's tuning rule: false positives are the safe side, so loose is correct here.
const READ_CALLS = /readFileSync\s*\(|readdirSync\s*\(|require\.resolve\s*\(/;
// `require.resolve('../x')` is its OWN repo-rooting idiom: it climbs out of test/'s own
// directory relative to __dirname IMPLICITLY, with no `__dirname` token anywhere in the
// source — the exact shape quaude-fuse-report.test.cjs uses (5
// `fs.readFileSync(require.resolve('../libexec/...'), 'utf8')` call sites, zero `__dirname`/
// `REPO`/`ROOT` tokens, missed by the first fix-round-2 attempt and caught measuring the
// seven named files against it).
//
// FIX ROUND 3 (coordinator, 2026-09-04) — deliberately NOT plain `require('../x')`, only
// `require.resolve('../x')`. A scoped re-review measured the round-2 widening's cost: 54
// newly-flagged files, ~6 confirmed false positives in a 20-file sample
// (build-trace.test.cjs, clode-net.test.cjs, clode-node.test.cjs,
// clode-rcodesign.test.cjs, templates-blob-pack.test.cjs) — all round-trip unit tests that
// build their own fixture and read back their own output, swept in only because
// `require('../lib-under-test.cjs')` (importing the very module the file is testing) is a
// near-universal idiom in this suite and satisfied the old, looser pattern. IMPORTING a
// module is not READING an artifact — the same principle BACKLOG.md's "Nothing gates the
// gates" principle 3 already states one layer over ("a scanner must not count our own
// emitted code"): a classifier that counts a test's own subject import as an "artifact
// read" is that defect applied to imports instead of build output. `require.resolve(...)`
// survives because it genuinely NAMES an artifact PATH (a string used for fs access), which
// a bare `require(...)` call — used to load and execute a module, not to name a path for
// later reading — does not.
const REPO_ROOTED = /__dirname\s*,\s*['"]\.\.|path\.resolve\(\s*__dirname|\bREPO\b|\brepo\b|\bROOT\b|require\.resolve\(\s*['"]\.\./;
// These stand on their own — no co-located or even whole-file READ_CALLS match required —
// because they already NAME a real external artifact or the mechanism that stages one (a
// library helper elsewhere, e.g. oracle-models.cjs's stageProviderCli(), does the actual
// readFileSync on the caller's behalf).
// FIX ROUND 3 (coordinator, 2026-09-04) — `cli\.cjs` anchored with a negative lookbehind so
// a filename merely ENDING in `cli.cjs` does not match: the unanchored pattern matched the
// substring inside `npm-cli.cjs` (scripts/lib/npm-cli.cjs, the npm-CLI resolver/runner —
// nothing to do with the staged single-file provider artifact this signal exists to name),
// flagging npm-cli-helper.test.cjs — a fully-injected pure unit test with zero real reads.
// `(?<![\w-])` excludes anything immediately preceded by a word character or a hyphen (so
// `npm-cli.cjs` is excluded) while still matching every real reference to the staged
// artifact, which is always quoted, path-joined, or slash-preceded (`'cli.cjs'`,
// `/cli.cjs`, `path.join(dir, 'cli.cjs')`) — never glued onto a longer identifier.
const STANDALONE_ARTIFACT_SIGNALS = [
  /stageProviderCli|CLODE_PROVIDER_BIN|CLODE_TJS\b/,
  /graph\.json|(?<![\w-])cli\.cjs/,
];
// Kept as a flat array for export/inspection convenience — NOT what classifyTestFile()
// evaluates with .some(): the first two entries are a whole-file AND (see readsArtifact()
// below), not one more OR branch.
const READS_ARTIFACT = [READ_CALLS, REPO_ROOTED, ...STANDALONE_ARTIFACT_SIGNALS];

function readsArtifact(src) {
  return (READ_CALLS.test(src) && REPO_ROOTED.test(src))
    || STANDALONE_ARTIFACT_SIGNALS.some((re) => re.test(src));
}

// Derives a verdict from the bytes rather than from a value it computed. FIX ROUND 2:
// added assert.match/assert.doesNotMatch — this repo's most idiomatic way to derive a
// finding from bytes, and the shape scc-merge.test.cjs's 71 misses and
// win-sync-guards.test.cjs's classic "assert a dangerous pattern is ABSENT" guard both use.
const PATTERN_MATCHES = [
  /\/[^\n/]+\/[gimsuy]*\.test\s*\(/,
  /\.match\s*\(\s*\//,
  /\.exec\s*\(/,
  /\.includes\s*\(\s*['"]/,
  /assert\.(?:match|doesNotMatch)\s*\(/,
];

function classifyTestFile(src) {
  const artifact = readsArtifact(src);
  const derivesFinding = PATTERN_MATCHES.some((re) => re.test(src));
  const scannerShaped = artifact && derivesFinding;
  const why = scannerShaped
    ? 'reads an artifact it did not create AND derives a finding from the bytes'
    : !artifact
      ? 'does not read a repo-rooted/staged/upstream artifact'
      : 'reads an artifact but derives no finding from its bytes (no pattern-match shape)';
  return { scannerShaped, why };
}

// Same walk as test/run.mjs's discoverTests(): recurse, skip dotfiles/dot-dirs and
// node_modules, only *.test.cjs. Deliberately the SAME shape as the real suite's own
// discovery so this sweep sees exactly the population test/run.mjs runs — no separate
// notion of "the test files" that could drift from the one that actually executes.
function discoverTestFiles(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') out.push(...discoverTestFiles(p)); }
    else if (e.name.endsWith('.test.cjs')) out.push(p);
  }
  return out;
}

// GUARD_EXCLUSIONS — a file lands here ONLY when it is genuinely not a guard: it builds
// its own inputs (mkdtemp fixtures, synthetic strings) even though the classifier's
// pattern-shape heuristic also matched some unrelated artifact-reading or bytes-matching
// idiom in its source. An exclusion NEVER means "this one is hard to migrate" — that is a
// Task 14 item, not an exclusion. Every entry needs a real, specific `because`; an entry
// with an empty `because` is itself a failure (checked by isRecordedExclusion below and by
// the self-check test in guards-population.test.cjs analogue... see guard.cjs's own
// convention for `skip` reasons, which this mirrors).
const GUARD_EXCLUSIONS = [
  {
    file: 'guards-population.test.cjs',
    because: 'this IS the sweep — it classifies OTHER tests\' shape and asserts about the '
      + 'discovered file LIST, which trips READS_ARTIFACT (it reads REPO/__dirname-rooted '
      + 'paths, i.e. every other test file) and PATTERN_MATCHES (it contains the very '
      + 'regex literals this module tests, plus .test()/.includes() calls in its own '
      + 'test-body assertions). It does not scan a fixed artifact for a violation; it scans '
      + 'the test suite\'s own SHAPE, and its own FLOOR tests (see guards-population.test.cjs) '
      + 'already ARE its positive control — a file cannot register itself as its own '
      + 'defineGuard guard without becoming circular.',
  },
];

function isRecordedExclusion(file) {
  const base = path.basename(file);
  const entry = GUARD_EXCLUSIONS.find((e) => e.file === base);
  if (!entry) return false;
  if (typeof entry.because !== 'string' || entry.because.trim().length === 0) {
    throw new Error(`GUARD_EXCLUSIONS entry for '${base}' has an empty \`because\` — an `
      + 'exclusion with no stated reason is itself a failure (phase-5 rule: an exclusion '
      + 'means "this test builds its own inputs", never "this one is hard to migrate")');
  }
  return true;
}

// MIGRATED — derived, not declared, and derived STATICALLY (see the fix-round-1 note
// above): a file counts as migrated when its source (a) DESTRUCTURES `defineGuard` out of
// `require('./guard.cjs')` and (b) calls that bare, un-namespaced `defineGuard(` somewhere.
// Both halves matter, and measuring this against the real tree is what found the gap:
// test/guard.test.cjs — the guard MECHANISM's own unit tests — does `const G =
// require('./guard.cjs')` and calls `G.defineGuard(...)` dozens of times to unit-test
// defineGuard() itself against disposable synthetic specs. A loose "requires guard.cjs and
// contains the substring defineGuard(" check (tried first) counted it as migrated, and the
// FLOOR test correctly went red over it — guard.test.cjs is not scanner-shaped (it never
// reads a real artifact) and was never a false negative to begin with, so calling it
// "migrated" was the actual bug, not the classifier. The destructure requirement excludes
// it (no bare `defineGuard` is ever imported), and the negative lookbehind on the call site
// excludes any other `<namespace>.defineGuard(` usage the same way.
//
// REQUIRED MIGRATION FORM (documented, not enforced further — coordinator fix-round-2
// finding, Important, 2026-09-04): both the destructure AND the bare call must appear IN
// THE SAME FILE. A future guard built through a shared setup helper — e.g. a
// `registerFooGuard()` in some other module that itself does `const { defineGuard } =
// require('./guard.cjs')` and calls `defineGuard(...)` on the migrating file's behalf —
// would NOT be seen here: this file's own source would have neither the destructure nor
// the bare call, so it would read as unmigrated even though it truly registers a guard. No
// such helper exists today (checked: every current call site destructures and calls
// in-file), so this is not a live bug, but it IS a constraint on how Task 14 must write its
// 56 migrations: each migrated file needs its OWN `const { defineGuard, guardTests } =
// require('./guard.cjs');` and its OWN direct `defineGuard({...})` call, matching
// naude-assembler-closure.test.cjs / node-shim-wall-tripwires.test.cjs's shape — not a
// shared factory function migrated files merely call into.
//
// DEPTH-INDEPENDENT (phase 5b, task 1, 2026-09-12): every guard until now lived directly
// in test/, so `require('./guard.cjs')` was the only shape ever seen. test/build-gates/
// (phase 5b's home for guards on the real build-path gates — see BACKLOG.md) is one
// directory deeper, so its guards correctly say `require('../guard.cjs')` — a real,
// different string, not a typo. `(?:\.\.?\/)+` matches either segment repeated any number
// of times, so `./guard.cjs` (existing guards) and `../guard.cjs` (test/build-gates/) both
// match; a file in a yet-deeper subdirectory (`../../guard.cjs`) would too. Proven against
// the ratchet: test/build-gates/lexical-code-mask.test.cjs went unrecognised (a real
// defineGuard-registered guard misclassified as a NEW unmigrated file) before this widened.
const DESTRUCTURES_DEFINEGUARD = /\{[^}]*\bdefineGuard\b[^}]*\}\s*=\s*require\(['"](?:\.\.?\/)+guard\.cjs['"]\)/;
const CALLS_BARE_DEFINEGUARD = /(?<![.\w])defineGuard\s*\(/;

// THE ONE PREDICATE for "this file's source registers a guard" — used by deriveMigrated()
// below AND by the ratchet test in guards-population.test.cjs. Coordinator fix (C2,
// 2026-09-04): the ratchet test used to check its OWN, weaker, inline
// `/require\(['"]\.\/guard\.cjs['"]\)/` — true for any file that merely REQUIRES
// guard.cjs, whether or not it ever calls defineGuard(). Proven: a file containing only
// `require('./guard.cjs');` (no defineGuard call at all) is scannerShaped: true (once it
// also matches PATTERN_MATCHES) and matched that inline regex, so it was silently dropped
// from `unmigrated` — not counted as migrated (MIGRATED, built from the STRICTER
// isMigratedSource() below, would never list it either), just erased from the ratchet
// entirely. That is C2: a file needing no control and lowering the count. Every caller
// that means "is this file a registered guard?" must use isMigratedSource(), so a file
// can no longer fall into the gap between two different definitions of "migrated".
function isMigratedSource(src) {
  return DESTRUCTURES_DEFINEGUARD.test(src) && CALLS_BARE_DEFINEGUARD.test(src);
}

function deriveMigrated() {
  const files = discoverTestFiles(__dirname)
    .filter((f) => f !== path.join(__dirname, 'guards-population.test.cjs'))
    .sort();
  const migrated = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    if (!isMigratedSource(src)) continue;
    migrated.push(path.relative(__dirname, f));
  }
  return migrated;
}
const MIGRATED = deriveMigrated();

// UNMIGRATED_BASELINE — the count of scanner-shaped tests NOT registered through
// defineGuard, as last measured against a real run of this sweep.
//
// RE-CUT in fix round 2 (coordinator, 2026-09-04): 57 -> 111, after readsArtifact() stopped
// requiring same-call co-location (see the CRITICAL fix-round-2 note above readsArtifact())
// — six previously UNFLAGGED files, including scc-merge.test.cjs's 71 assert.match calls
// against an artifact it did not create, are real guards the old classifier could not see.
//
// RE-CUT AGAIN in fix round 3 (coordinator, 2026-09-04): 111 -> 103, trimming the round-2
// widening's own overshoot. A scoped review found the widening also swept in round-trip
// unit tests that only import their own subject module (`require('../lib.cjs')` satisfied
// the old REPO_ROOTED, and that idiom is near-universal here — the same "must not count our
// own emitted code" defect from BACKLOG.md's "Nothing gates the gates" principle 3, applied
// to imports instead of build output) and a substring match inside `npm-cli.cjs` (see the
// fix-round-3 notes above `require.resolve` and `cli\.cjs`'s anchor for both fixes). Every
// rise or fall here is the classifier changing, never the tree — always re-verify against
// classifyTestFile()/readsArtifact() before reading a future change as good or bad news;
// see the fix-round-2 and fix-round-3 sections of task-4-report.md for the exact measured
// before/after each time this happened.
//
// RE-CUT AGAIN, 103 -> 102, after Task 9 migrated test/windows-path-ratchet.test.cjs to
// defineGuard/guardTests (its stripComments() tokenizer fix, phase 5). Task 14 owns the rest.
//
// RE-CUT AGAIN, 102 -> 95, Task 14 batch 1 (2026-09-04): "reads a repo pin/config/source
// file, regex-extracts values, asserts agreement or a real control-modelled violation" —
// version-single-source, node-pins-agree, workflow-scripts-exist, release-gate-globs,
// target-env (the require-free half), clode-fuse-compose (the declares-own-steps half),
// tls-cacert-pem (the checkout-free provenance-chain half). Each carries its own positive
// control, shown red then green (see task-14-report.md).
//
// RE-CUT AGAIN, 95 -> 89, Task 14 batch 2 (2026-09-04): "reads one or more repo source/
// patch files and asserts several must-have/must-not-have patterns hold" — update-guard-
// drift (three inline-copy comparisons), quaude-fuse-cyclic-refusal, quaude-fuse-merge,
// win-sync-guards (two patch files + a build script), win-shim-guards (nine source files'
// win32 patterns), and win-fs-rename-guard (behavioral: loads the real fs.cjs in a vm
// sandbox with a mocked platform + FSS and exercises its rename semantics; the async
// promises.rename check was left as a standalone test — guard.cjs's scan() contract is
// synchronous, and unwrapping a promise inside it needs a microtask-flush hack this batch
// did not take on).
//
// RE-CUT AGAIN, 89 -> 85, Task 14 batch 3 (2026-09-04): merge-step-wiring and
// quaude-fuse-report-wiring (source pattern-presence over scripts/merge-step.mjs and
// libexec/quaude-fuse.js, folding many single-assertion tests into one guard each while
// leaving the real behavioral/spawn tests standalone), guard-subcommands-gate (the staged
// carve's graph.json `sources` scan, reusing defineGuard's floor mechanism for the
// "scan found too few names" broken-scanner check), and msvc-getopt-fixup-registration
// (the one pure-regex assertion inside msvc-getopt-shim.test.cjs, leaving its C-compiler
// differential tests, which are not a static text scan, alone).
//
// RE-CUT AGAIN, 85 -> 83, Task 14 batch 4 (2026-09-04): zstd-gap-carved-walls (the
// carved-bundle half of zlib-zstd-stream-gap.test.cjs — its own hand-written mechanism
// self-check already WAS a defineGuard-shaped control, just not wired through this
// module; folded the four-check loop and the "walls down" fixture into one guard,
// keeping the escape-blind double-encoding and stubbed-zlib mechanism checks standalone)
// and engine-api-floor-consumers (five source/yaml files' presence/absence checks over
// build-tjs.mjs, the build-leg action, and the guest bake script, leaving the dynamic
// import()-driven ENGINE_API_FLOOR/behavioral tests alone).
//
// RE-CUT AGAIN, 83 -> 82, Task 14 batch 5 (2026-09-04): engine-recipe-cache-key-wiring,
// the one pure-regex assertion inside engine-recipe.test.cjs (the build-leg cache key
// consumes the recipe's hash rather than re-inlining hashFiles(...)); the rest of that
// file's tests load scripts/engine-recipe.mjs dynamically and exercise real hashing
// behaviour, which is not a static text scan and is left alone.
//
// MEANT TO GO DOWN from here as files migrate. Never raise it to make a run "look clean" —
// raising it papers over exactly the regression this ratchet exists to catch. Lower it (with
// a comment recording the new measured count and when) whenever a migration makes the real
// count drop, OR whenever a future classifier fix surfaces more true positives or trims a
// false positive — the ratchet test below tells you to when that happens.
const UNMIGRATED_BASELINE = 82;

// Pure ratchet decision — unit-tested directly with synthetic counts (see
// guards-population.test.cjs) as well as through the real file list, so the mechanism is
// provably correct independent of what the tree currently contains. A RATCHET, not a
// fixed-target assertion: `findings` is non-empty only when count RISES past the recorded
// baseline (a NEW scanner-shaped file skipped defineGuard — a real regression). A count at
// or below baseline is `ok`, but a FALL is called out in `message` too, so progress doesn't
// go unnoticed and the baseline gets a deliberate re-cut instead of silently drifting stale
// (the same asymmetry test/node-shim-wall-tripwires.test.cjs's WALLS ratchet uses, and for
// the same reason: leaving improvement undetected is how a ratchet starts lying by omission).
function ratchetUnmigrated(count, baseline, unmigrated) {
  const list = unmigrated.length
    ? ':\n' + unmigrated.map((f) => `    ${f}`).join('\n')
    : ' (none)';
  if (count > baseline) {
    return { ok: false, message: `${count} scanner-shaped test(s) are not registered `
      + `through defineGuard — ABOVE the recorded baseline of ${baseline}. A NEW file `
      + `skipped defineGuard: migrate it (test/guard.cjs) or add a recorded `
      + `GUARD_EXCLUSIONS entry naming why it is not a guard. Unmigrated${list}` };
  }
  if (count < baseline) {
    return { ok: true, message: `${count} scanner-shaped test(s) remain unmigrated — `
      + `BELOW the recorded baseline of ${baseline}. Progress: lower UNMIGRATED_BASELINE `
      + `in test/guards-population.cjs to ${count} so a future regression is caught at the `
      + `new, lower count. Unmigrated${list}` };
  }
  return { ok: true, message: `${count} scanner-shaped test(s) remain unmigrated, matching `
    + `the recorded baseline of ${baseline}. Unmigrated${list}` };
}

// ---- ESCAPE-BLIND DETECTOR (BACKLOG item 8, task-11) -------------------------
// A gate that greps the staged carve's `cli.cjs` for a quote-bearing literal is
// silently blind: since Claude Code 2.1.243 the staged cli.cjs is a GRAPH
// RUNNER, module sources ride escaped inside a JS string literal, so a literal
// like `switch("clode-managed-target")` is present only in escaped form. THREE
// gates already died of exactly this before this detector existed
// (guard-subcommands-gate's `.command("…")` scan, the shim-surface family's
// fs.watch alias scanner, zlib-zstd-stream-gap's pin check — see BACKLOG.md
// item 8 and task-11-report.md for the measured counts, including a FOURTH,
// production-code instance found while building this detector:
// libexec/clode-fuse.cjs's dep-closure gate, fixed in the same commit). This is
// a CLASS, not an incident, so — same principle as the MIGRATED sweep above —
// this stops it from being reintroduced a fifth time unnoticed.
//
// THE SIGNAL: a test file that could be reading the staged graph-runner
// cli.cjs (mentions `cli.cjs`, `stageProviderCli`, or `CLODE_PROVIDER_BIN` —
// deliberately loose, same READS_CLI_RUNNER-style signal STANDALONE_ARTIFACT_
// SIGNALS above already uses for a related purpose) AND contains a regex
// LITERAL, adjacent to a require/import/command/switch call shape, that
// carries a BARE quote character — the exact shape that defeated all three
// real incidents (`require(["']`, `.command(["']`, `switch("literal")`, …).
// EXEMPT if the file already shows either known-good fix: mentions
// `graph.json`/`doc.sources` (reads real strings directly — the
// node-shim-wall-tripwires/guard-subcommands-gate/shim-surface fix), or the
// pattern itself is escape-blind (`\*"` / `\+"` — the zlib-zstd-stream-gap `Q`
// convention that tolerates ANY number of backslashes before the quote).
//
// NOT AN AST PARSE — a "regex literal" here is approximated (a `/`-delimited
// run with no unescaped `/` or newline inside, then optional flags), and
// comments are stripped only to end-of-line (a same-line `//` not preceded by
// `:`, so `https://` inside a string survives). Both approximations can
// mis-detect a genuine regex literal sitting inside a longer non-code string
// (see CLI_QUOTE_SCAN_EXCLUSIONS below for the one measured case). Per the
// sweep's own tuning rule (verbatim, above): false positives are the SAFE
// side — one recorded exclusion costs a look; a false negative is a fifth
// silent incident.
function stripLineComments(src) {
  return src.split('\n').map((line) => {
    const m = /(^|[^:])\/\//.exec(line);
    if (!m) return line;
    return line.slice(0, m.index + m[1].length);
  }).join('\n');
}

const READS_CLI_RUNNER = /\bcli\.cjs\b|\bstageProviderCli\b|\bCLODE_PROVIDER_BIN\b/;
// KNOWN HOLE (Finding 3, coordinator review, task-11 fix round 1, documented not
// chased): this exemption is WHOLE-FILE, not per-assertion. A file that reads
// graph.json's real `sources` for ONE check and ALSO blindly greps `cli.cjs`'s escaped
// runner text for an UNRELATED check is silenced entirely — the second, still-broken
// check goes undetected because the file merely MENTIONS `graph.json` somewhere. This
// is not hypothetical: test/node-shim-staged-graph.test.cjs has exactly this shape
// today (it reads `graph.json` for the residual-cyclic-require check, then separately
// greps the raw `cli.cjs` text for the chunk-require tripwire) — safe ONLY because that
// second pattern happens to already be escape-blind BY DESIGN (its `\\*"` spelling), not
// because this detector verified it. A per-assertion (rather than per-file) analysis
// would need something closer to an AST walk scoped to each `test(...)` block, which is
// out of scope for a regex-based sweep; recorded here rather than silently accepted.
const ALREADY_FIXED = /\bgraph\.json\b|\bdoc\.sources\b/;
// Approximates a JS regex literal: `/`, then a run with no bare `/` or newline
// (an escaped char `\\.` is allowed to contain one), then `/` and flags.
const REGEX_LITERAL = /\/(?:\\.|[^/\n\\])+\/[a-z]*/g;
// `\\?\(` (not a bare `\(`): a real regex literal escapes its OWN literal
// parens too — `/\.command\(["']/`, not `/\.command(["']/` — so the open
// paren these keywords are followed by usually carries its own backslash.
// Measured against the first draft of this detector (task-11): the bare-paren
// spelling missed guard-subcommands-gate's actual pre-fix shape entirely.
const SCAN_CALL_SHAPE = /require\\?\(|__require\\?\(|import\\?\(|\.command\\?\(|\.alias\\?\(|switch\\?\(/;
const BARE_QUOTE = /["']/;
// The known-good "pin both encodings" fix's fingerprint, INSIDE the regex
// literal itself: TWO literal backslash characters (the escaped `\\` that
// matches one literal backslash in the scanned TEXT), then a `*`/`+`
// quantifier, then a quote-matching construct (`"`, `'`, or the start of a
// `["']` bracket class) — the `\\*"` shape test/node-shim-staged-graph.test.cjs
// and the `Q = '\\\\*"'` convention (test/zlib-zstd-stream-gap.test.cjs,
// a42bf7e) both use to tolerate ANY number of backslashes before the quote.
const ESCAPE_BLIND_SPELLING = /\\\\[*+]["'[]/;

// Every regex-literal-shaped match in `src` that looks like an unfixed
// escape-blind scan — for diagnostics, not just a boolean, so a finding names
// the actual offending snippet rather than just the file.
function unsafeCliRunnerQuoteScans(src) {
  // Comments stripped FIRST and every signal checked against that: a file
  // merely MENTIONING cli.cjs in prose (e.g. "this runs Claude Code's
  // cli.cjs, not clode's own code" — test/clode-self-deps.test.cjs, measured
  // task-11) must not gate this detector in on that alone.
  const stripped = stripLineComments(src);
  if (!READS_CLI_RUNNER.test(stripped) || ALREADY_FIXED.test(stripped)) return [];
  const hits = [];
  REGEX_LITERAL.lastIndex = 0;
  let m;
  while ((m = REGEX_LITERAL.exec(stripped))) {
    const lit = m[0];
    if (!SCAN_CALL_SHAPE.test(lit)) continue;
    if (!BARE_QUOTE.test(lit)) continue;
    if (ESCAPE_BLIND_SPELLING.test(lit)) continue;
    hits.push(lit);
  }
  return hits;
}

// A file lands here ONLY when a real, read source snippet was checked BY HAND
// and confirmed to be prose/doc text, not scanning code — same discipline as
// GUARD_EXCLUSIONS above (an empty `because` is a bug, checked below).
const CLI_QUOTE_SCAN_EXCLUSIONS = [
  {
    file: 'inspect.test.cjs',
    because: 'the one measured false positive (task-11): a backtick-quoted DOC STRING '
      + '("node libexec/inspect-claude-bundle.cjs \\"$(node -e \'console.log(require(...))\')\\" ") '
      + 'showing a human how to run the tool by hand. The regex-literal approximation reads '
      + 'the `/` inside that string as a delimiter; it is not scanning code and matches '
      + 'nothing at runtime.',
  },
  {
    file: 'shim-surface.test.cjs',
    because: 'measured task-11: its DELIBERATELY NARROW tripwire pattern '
      + '(`/require\\(\\s*["\'](?:node:)?fs["\']\\s*\\)\\s*\\.watch\\s*\\(/`) is used in a '
      + 'NEGATIVE assertion ("this must stay false") against `text`, which comes from '
      + 'test/shim-surface/bundle-refs.cjs\'s loadModules() — already fixed (it prefers '
      + 'graph.json\'s real `sources` over the escaped cli.cjs runner, confirmed by reading '
      + 'that file). The fix lives in a SEPARATE file this detector does not follow across a '
      + 'require() edge, so the same-file `graph.json`/`doc.sources` signal never fires here '
      + 'even though the data really is unescaped.',
  },
];

function isRecordedCliQuoteScanExclusion(file) {
  const base = path.basename(file);
  const entry = CLI_QUOTE_SCAN_EXCLUSIONS.find((e) => e.file === base);
  if (!entry) return false;
  if (typeof entry.because !== 'string' || entry.because.trim().length === 0) {
    throw new Error(`CLI_QUOTE_SCAN_EXCLUSIONS entry for '${base}' has an empty \`because\``);
  }
  return true;
}

// FIX ROUND 1 (coordinator review, task-11, 2026-09-05): a detector that can only see
// `test/*.test.cjs` cannot see where THIS TASK'S OWN defect actually lived —
// libexec/clode-fuse.cjs's scanBareSpecifiers(), the real dep-closure gate `clode build`
// and `clode build --naude` run. Fed the reviewer's own words: "I verified this myself...
// the detector WOULD have flagged this task's own defect" against the PRE-FIX file. A
// detector with a blind spot shaped exactly like the bug it exists to catch is not
// finished, so the population walk now also covers every `.cjs`/`.mjs` under `libexec/`
// and `scripts/` — not just `.test.cjs` files under `test/` — using the SAME
// unsafeCliRunnerQuoteScans() classifier, unchanged. Confirmed both directories are
// clean TODAY (task-11-report.md fix-round-1 section has the measured count), so
// widening this costs nothing.
//
// Deliberately a SEPARATE walk from discoverTestFiles() (which the MIGRATED/
// UNMIGRATED_BASELINE sweep above depends on staying scoped to `test/*.test.cjs` — see
// its own comment): this one matches any `.cjs` or `.mjs` file, not only `*.test.cjs`.
function discoverFilesByExt(dir, exts) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') out.push(...discoverFilesByExt(p, exts)); }
    else if (exts.some((ext) => e.name.endsWith(ext))) out.push(p);
  }
  return out;
}

// The full population this detector's standing gate walks: every test file (as before)
// PLUS every libexec/scripts source file, so a NEW escape-blind gate is caught whether it
// is authored as a test or as the production code a test merely exercises.
function discoverCliQuoteScanFiles() {
  const testDir = path.join(REPO, 'test');
  const libexecDir = path.join(REPO, 'libexec');
  const scriptsDir = path.join(REPO, 'scripts');
  const out = [];
  if (fs.existsSync(testDir)) out.push(...discoverFilesByExt(testDir, ['.test.cjs']));
  if (fs.existsSync(libexecDir)) out.push(...discoverFilesByExt(libexecDir, ['.cjs', '.mjs']));
  if (fs.existsSync(scriptsDir)) out.push(...discoverFilesByExt(scriptsDir, ['.cjs', '.mjs']));
  return out;
}

// ---- PRODUCTION BUILD-GATE POPULATION (phase 5b, task 5) --------------------
// Everything above this line sweeps TESTS. This sweeps the other half of the problem: the
// gates that live in PRODUCTION code and run inside `clode build` itself. Phase 5b put a
// control under four of them (test/build-gates/: scc-merge's lexicalCodeMask, clode-fuse's
// dep-closure family, host-provision's two throw-sites, target-update-check's channel
// check) and each of the first two found a live defect the moment it was controlled. The
// question this closes is the one that outlives the phase: how does the FIFTH un-controlled
// build gate get noticed? Without this, the same way the first four were — by accident.
//
// A SEPARATE SWEEP, DELIBERATELY. The MIGRATED/UNMIGRATED_BASELINE sweep above runs off
// discoverTestFiles(__dirname) and is scoped to `test/*.test.cjs` by design (see that
// function's own comment, and discoverFilesByExt's). A production file is not a test and
// cannot "register a guard" about itself — the control lives in a different file — so
// widening that walk would have meant one classifier answering two incompatible questions.
// This one has its own population, its own classifier, and its own baseline.
//
// THE SPLIT POINT, recorded and deliberately not taken (fix round 1): this file now carries
// two sweeps. Splitting it today would either duplicate the shared vocabulary
// (PATTERN_MATCHES, isMigratedSource, discoverFilesByExt, REPO) or invert the dependency, so
// it stays one file. Split it when a THIRD sweep arrives, not before.
//
// SPEC ERRATUM, recorded (coordinator ruling 3, 2026-09-12): the phase-5b spec §3 says
// "Registration puts them in the population sweep automatically; Task 11 already extended
// it to walk libexec/ and scripts/." That conflates two sweeps. Task 11 extended
// discoverCliQuoteScanFiles() — which feeds ONLY the escape-blind CLI-quote detector — and
// said so in its own comment. Before this section existed, a brand-new un-controlled build
// gate under libexec/ was reported by nothing at all. Measured, not assumed.

// SCOPE SKIP — not an exclusion list, a statement about which tree this sweep is ABOUT.
// libexec/node-shim/ is the TARGET's Node-API emulation: it is fused INTO quaude and runs
// on the end user's machine, and never runs as a gate during `clode build`. Its modules
// throw and pattern-match constantly because they IMPLEMENT Node's error semantics and path
// handling — `throw new Error('ENOENT...')` is a runtime behaving like Node, not a build
// refusing an artifact. Measured 2026-09-12: 8 of its files match the gate shape, all for
// exactly that reason. Skipped at the WALK rather than recorded as 8 near-identical
// exclusions, because the reason is one fact about the directory, not eight facts about
// eight files.
const PRODUCTION_SCOPE_SKIP = [path.join('libexec', 'node-shim')];

function discoverProductionFiles() {
  const out = [];
  for (const dir of ['libexec', 'scripts']) {
    const abs = path.join(REPO, dir);
    if (!fs.existsSync(abs)) continue;
    // `.js` TOO (fix round 1, 2026-09-12). Leaving it out put two real build-path files in
    // NO bucket at all — not gate-shaped, not excluded, not even counted: libexec/quaude-fuse.js
    // (the fuse worker libexec/clode-fuse.cjs spawns under the template) and libexec/graph-meta.js
    // (spawned from libexec/clode-extract.cjs). A mechanism whose promise is "the next gate
    // cannot appear unseen" must not have an extension-shaped hole. Measured cost: population
    // 74 -> 76, gates unchanged at 34 — neither .js file is gate-shaped TODAY, which is exactly
    // why the hole was invisible and exactly why it had to be closed before one of them becomes
    // one.
    out.push(...discoverFilesByExt(abs, ['.cjs', '.mjs', '.js']));
  }
  return out
    .map((f) => path.relative(REPO, f))
    .filter((rel) => !PRODUCTION_SCOPE_SKIP.some((p) => rel === p || rel.startsWith(p + path.sep)))
    .sort();
}

// REFUSES — the half that separates a build GATE from ordinary production code. A gate's
// defining act is stopping the build: it throws, or it exits non-zero. A module that merely
// inspects something and returns a value is not a gate and needs no control.
//
// FIX ROUND 1 (reviewer, 2026-09-12) — A LIVE MISS, and a worse disclosure. The first cut
// required a LITERAL `1`-`9` after `process.exit(`. scripts/apicheck.mjs — whose own header
// line 2 reads "clode API-surface gate" — refuses with `process.exit(runGate())`, a COMPUTED
// status, and came back `gateShaped: false, why: "...never refuses..."`, which is factually
// wrong about that file. The miss alone was forgivable; the comment that shipped with it said
// "nothing in libexec/ or scripts/ has that shape today", which tells the next reader there is
// nothing to go look for. A false "nothing to look for here" is the precise failure this phase
// exists to prevent.
//
// The rule is now: an exit is a REFUSAL unless its argument is literally `0` or absent. That
// covers `exit(1)`, `exit(2)`, `exit(64)`, `exit(code)`, `exit(status)`, `exit(runGate())`,
// `exit(failed ? 1 : 0)` — every spelling measured in this tree — while `process.exit(0)` and
// `process.exit()` stay what they are, an ordinary successful return. Measured cost: exactly
// two more files become gate-shaped (scripts/apicheck.mjs, libexec/naude-entry.cjs), 32 -> 34.
// `process.exitCode =` widened the same way for one vocabulary, at zero measured cost.
const NONZERO_EXIT_ARG = /process\.exit\s*\(\s*(?!0\s*\)|\))./;
const NONZERO_EXITCODE = /process\.exitCode\s*=\s*(?!0\b)[A-Za-z0-9_$(]/;
const GATE_REFUSES = new RegExp(['throw new Error\\s*\\(',
  NONZERO_EXIT_ARG.source, NONZERO_EXITCODE.source].join('|'));

// THE INPUT HALF IS DELIBERATELY ABSENT, and this is the one design decision in this
// section worth arguing about. readsArtifact() above (READ_CALLS && REPO_ROOTED) is the
// test sweep's notion of "reads something it did not create", and the obvious move was to
// reuse it here. Measured against the four gates phase 5b already controls, it does not
// work, and the way it fails is instructive:
//   - libexec/scc-merge.cjs   — READ_CALLS: NO. lexicalCodeMask's artifact is the merged
//                               module source handed to it as a PARAMETER. Zero fs calls.
//   - libexec/target-update-check.cjs — READ_CALLS: NO. Its artifact is an HTTP response
//                               (Task 4's report makes the same point from the other side:
//                               its guard touches no filesystem and would have failed the
//                               TEST sweep's floor on its own).
// Two of the four. A classifier that can only recognise a file-reading scanner has a blind
// spot shaped exactly like half the population it exists to watch — the same failure the
// escape-blind detector's fix round 1 fixed one layer down. A production gate's artifact can
// be a file, a network response, a subprocess's output, or a blob its caller already read,
// and the last of those is not distinguishable from any pure function by source text alone.
// So the input half is dropped ON PURPOSE and the cost is paid in false positives, which the
// spec's tuning rule (verbatim, above) calls the SAFE side: `gateShaped` = derives a verdict
// from text AND refuses. Measured 2026-09-12: 30 of 74 production files, so it discriminates
// (44 files are NOT gates) rather than flagging everything.
//
// WHAT IT THEREFORE CANNOT SEE, stated: a gate that refuses by RETURNING a verdict its
// caller acts on (`return { ok: false }`, a non-empty findings array) WITHOUT the caller then
// throwing or exiting on it. FIX ROUND 1: the first cut of this comment said "nothing in
// libexec/ or scripts/ has that shape today", which was a claim, not a measurement, and it was
// wrong in spirit — scripts/apicheck.mjs's runGate() returns 1/0 and its caller exits on it,
// which the widened GATE_REFUSES above now sees. The honest statement is narrower: a
// return-only gate whose caller lives in a DIFFERENT file is not followed across that edge (the
// same require()-edge limitation the escape-blind detector records for ALREADY_FIXED). No such
// split gate has been found, but "not found" is where the search stopped, not proof of absence
// — go look before believing it.
//
// THE VERDICT HALF IS PATTERN_MATCHES PLUS A PRODUCTION DELTA, and the delta was MEASURED,
// not guessed. PATTERN_MATCHES's first entry requires a regex LITERAL immediately followed
// by `.test(` — `/re/.test(src)` — which is how tests are written. Production code hoists
// the regex to a named const and calls `FORBIDDEN.test(src)`, and PATTERN_MATCHES sees
// nothing. This was found by the synthetic-offender demonstration (task-5-report.md): a
// realistic un-controlled gate, written the way libexec/clode-fuse.cjs's dep-closure gate is
// written, was NOT flagged, and the first run of the demonstration passed when it should
// have failed. Widening `.test(`/`.match(`/`.matchAll(` to accept a receiver of any shape
// costs exactly two more files across the whole production tree (measured 2026-09-12:
// 30 -> 32 gate-shaped of 74), so the precision cost is real but tiny and the blind spot it
// closes is the single most common way a production gate is spelled. Layered ON TOP of
// PATTERN_MATCHES rather than re-spelled, so "derives a finding from bytes" stays ONE
// vocabulary with one stated, reasoned production delta.
const PRODUCTION_VERDICT_EXTRA = [/\.test\s*\(/, /\.match\s*\(/, /\.matchAll\s*\(/];
const GATE_VERDICT = [...PATTERN_MATCHES, ...PRODUCTION_VERDICT_EXTRA];

function classifyProductionFile(src) {
  const derivesFinding = GATE_VERDICT.some((re) => re.test(src));
  const refuses = GATE_REFUSES.test(src);
  const gateShaped = derivesFinding && refuses;
  const why = gateShaped
    ? 'derives a verdict from text AND refuses (throws / exits non-zero)'
    : !derivesFinding
      ? 'derives no verdict from bytes (no pattern-match shape)'
      : 'pattern-matches but never refuses — it returns a value, it does not stop the build';
  return { gateShaped, why };
}

// THE CONTROL MAPPING — derived from source text, never declared (coordinator ruling 2).
// Every guard under test/build-gates/ requires the production module it controls through a
// LITERAL relative path: `require('../../libexec/scc-merge.cjs')`. That literal IS the
// mapping, and reading it back is the same move isMigratedSource() already makes for guard
// membership. defineGuard's contract is NOT extended with a `controls:` field — a declared
// field can disagree with the code; a require() literal cannot, because the guard would not
// run at all if it were wrong.
//
// A build-gates file only counts if isMigratedSource() says it really registers a guard —
// the ONE predicate, so a file that merely sits in the directory cannot silently vouch for a
// gate it never controls.
const BUILD_GATES_DIR = path.join('test', 'build-gates');

function buildGateGuardFiles() {
  const abs = path.join(REPO, BUILD_GATES_DIR);
  if (!fs.existsSync(abs)) return [];
  return discoverFilesByExt(abs, ['.test.cjs'])
    .filter((f) => isMigratedSource(fs.readFileSync(f, 'utf8')))
    .map((f) => path.relative(REPO, f))
    .sort();
}

// The production modules one guard file names. Relative specifiers are resolved against the
// guard's own directory and kept only when they land inside the production tree, so a
// `require('../guard.cjs')` or `require('../throws-as-findings.cjs')` is not mistaken for a
// gate under control.
function modulesNamedByGuard(guardRel, src) {
  const dir = path.dirname(path.join(REPO, guardRel));
  const out = [];
  // A LOCAL literal with matchAll, not a module-level /g regex: a shared /g regex carries
  // mutable lastIndex across calls, which is correct only as long as every caller remembers
  // to reset it. Removing the footgun is cheaper than documenting it.
  for (const m of src.matchAll(/require\(\s*['"]((?:\.\.\/)+[^'"\n]+)['"]\s*\)/g)) {
    const rel = path.relative(REPO, path.resolve(dir, m[1]));
    if (rel.startsWith('libexec' + path.sep) || rel.startsWith('scripts' + path.sep)) out.push(rel);
  }
  return [...new Set(out)];
}

// path -> [guard files that name it].
function controlledProductionModules() {
  const map = new Map();
  for (const guardRel of buildGateGuardFiles()) {
    const src = fs.readFileSync(path.join(REPO, guardRel), 'utf8');
    for (const mod of modulesNamedByGuard(guardRel, src)) {
      if (!map.has(mod)) map.set(mod, []);
      map.get(mod).push(guardRel);
    }
  }
  return map;
}

// PRODUCTION_GATE_EXCLUSIONS — same discipline as GUARD_EXCLUSIONS above: an entry means
// "this file is genuinely not a build gate even though the shape matched", never "this one
// is hard to control". Keyed by REPO-RELATIVE path, not basename, because two production
// files can share a basename across libexec/ and scripts/. Empty today, on purpose: the one
// false-positive CLASS measured so far (libexec/node-shim/) is a fact about a directory and
// is handled at the walk (PRODUCTION_SCOPE_SKIP), not here. It exists so that a genuine
// false positive has somewhere honest to go — without it the only escape would be RAISING
// the baseline, which the ratchet exists to forbid.
const PRODUCTION_GATE_EXCLUSIONS = [];

function isRecordedProductionGateExclusion(rel) {
  const entry = PRODUCTION_GATE_EXCLUSIONS.find((e) => e.file === rel);
  if (!entry) return false;
  if (typeof entry.because !== 'string' || entry.because.trim().length === 0) {
    throw new Error(`PRODUCTION_GATE_EXCLUSIONS entry for '${rel}' has an empty \`because\` — `
      + 'an exclusion with no stated reason is itself a failure');
  }
  return true;
}

// UNCONTROLLED_GATE_BASELINE — gate-shaped production files NOT named by any registered
// test/build-gates/ guard, as last measured. 30 as of fix round 1 (phase 5b task 5,
// 2026-09-12): 76 production files in scope, 34 gate-shaped, 4 controlled (scc-merge.cjs,
// clode-fuse.cjs, host-provision.cjs, target-update-check.cjs — phase 5b tasks 1-4), 0
// excluded.
//
// EVERY MOVE THIS NUMBER HAS MADE, and each was the CLASSIFIER changing, never the tree:
//   26  first cut.
//   28  the synthetic-offender demonstration showed the verdict half was blind to a hoisted
//       regex constant; PRODUCTION_VERDICT_EXTRA added clode-signals.cjs, changed-paths.mjs.
//   30  fix round 1 — GATE_REFUSES widened to a non-zero exit ARGUMENT (apicheck.mjs's
//       `process.exit(runGate())` was a live miss) added apicheck.mjs and naude-entry.cjs.
//       Adding `.js` to the walk in the same round moved the population 74 -> 76 but cost
//       zero gates; the two effects were MEASURED together, not added on paper.
// Re-verify against classifyProductionFile() before reading a future change as good or bad.
//
// MEANT TO GO DOWN. Never raise it to make a run look clean — raising it papers over exactly
// the regression this exists to catch. This number is NOT a to-do list of 30 gates that must
// all get controls; it is the floor under "no NEW un-controlled build gate appears without
// someone seeing it". Some of the 30 are certainly false positives under a classifier with
// no input half (see classifyProductionFile above); each one that is confirmed by hand
// becomes a PRODUCTION_GATE_EXCLUSIONS entry with a reason and the baseline drops.
const UNCONTROLLED_GATE_BASELINE = 30;

// GATE_SHAPED_FLOOR — the OTHER half of the ratchet, and the reason a fall can be trusted.
// FIX ROUND 1 (reviewer, 2026-09-12): the uncontrolled count alone cannot tell "someone wrote
// a control" from "the classifier went partly blind". Both look like a DROP, and a drop
// returned ok:true with a cheerful "Progress: lower the baseline" — so an edit that broke
// GATE_VERDICT and collapsed the visible population 30 -> 8 would have PASSED, reporting
// progress. The two FLOOR tests do not catch this either: they only catch TOTAL blindness
// (`gates.length > 0`). So the sweep now also records how many gates it can SEE, and a count
// below this floor is a finding regardless of what the uncontrolled number did. Set with a
// deliberate cushion under today's 34 — ordinary churn (deleting a gate file, folding two
// scripts into one) must not trip it, a classifier break collapses far past it.
const GATE_SHAPED_FLOOR = 28;

// Mirrors ratchetUnmigrated's asymmetry deliberately (a rise is a finding, a fall is a
// message telling you to re-cut) — same reason, different remediation text, which is the
// load-bearing half: "write a guard under test/build-gates/" is not "migrate to defineGuard".
function ratchetUncontrolledGates(count, baseline, uncontrolled, gatesSeen, gatesFloor) {
  const list = uncontrolled.length
    ? ':\n' + uncontrolled.map((f) => `    ${f}`).join('\n')
    : ' (none)';
  // Checked FIRST and unconditionally: if the classifier can no longer see the gates it is
  // supposed to be counting, every other number below is meaningless — including a fall,
  // which would otherwise read as progress. This is the sweep's own BROKEN verdict.
  if (Number.isInteger(gatesSeen) && Number.isInteger(gatesFloor) && gatesSeen < gatesFloor) {
    return { ok: false, message: `the classifier sees only ${gatesSeen} gate-shaped production `
      + `file(s), BELOW the recorded floor of ${gatesFloor}. This is NOT a clean result and a `
      + `fall in the uncontrolled count below is NOT progress: the classifier has gone partly `
      + 'blind (GATE_VERDICT/GATE_REFUSES broke, or the walk stopped reaching a directory). '
      + 'Fix the classifier, or — if the tree really did lose that many gates — re-cut '
      + 'GATE_SHAPED_FLOOR deliberately, with the measurement recorded.' };
  }
  if (count > baseline) {
    return { ok: false, message: `${count} gate-shaped production file(s) are not named by `
      + `any registered test/build-gates/ guard — ABOVE the recorded baseline of ${baseline}. `
      + 'A NEW build gate arrived with no control: write a guard under test/build-gates/ that '
      + 'require()s it by its literal relative path and registers through defineGuard, or add '
      + 'a recorded PRODUCTION_GATE_EXCLUSIONS entry naming why it is not a gate. '
      + `Uncontrolled${list}` };
  }
  if (count < baseline) {
    return { ok: true, message: `${count} gate-shaped production file(s) remain uncontrolled `
      + `— BELOW the recorded baseline of ${baseline}. Progress: lower `
      + `UNCONTROLLED_GATE_BASELINE in test/guards-population.cjs to ${count}. `
      + `Uncontrolled${list}` };
  }
  return { ok: true, message: `${count} gate-shaped production file(s) remain uncontrolled, `
    + `matching the recorded baseline of ${baseline}. Uncontrolled${list}` };
}

// The whole sweep in one call, so the standing gate and any command-line inspection see the
// SAME numbers. Buckets are counted as the walk runs (not re-derived afterwards) so a file
// that falls through every branch shows up as a conservation failure instead of quietly
// lowering the count — the C2 shape the test sweep above already paid for once.
//
// HOW MUCH THAT ASSERTION ACTUALLY PROVES (fix round 1, honest restatement): as written the
// three branches are EXHAUSTIVE by construction — controlled / excluded / else-uncontrolled —
// so no crafted file can trip the conservation check. Its only real job is to catch a FUTURE
// edit that adds a fourth `continue` and quietly drops files out of every bucket. That is
// worth having, and it is all of it; the phase-5 review reached the same verdict about the
// identical assertion in the test sweep above.
function sweepProductionGates() {
  const controlled = controlledProductionModules();
  const files = discoverProductionFiles();
  const gates = [];
  const uncontrolled = [];
  let controlledCount = 0;
  let excludedCount = 0;
  for (const rel of files) {
    const src = fs.readFileSync(path.join(REPO, rel), 'utf8');
    if (!classifyProductionFile(src).gateShaped) continue;
    gates.push(rel);
    if (controlled.has(rel)) { controlledCount++; continue; }
    if (isRecordedProductionGateExclusion(rel)) { excludedCount++; continue; }
    uncontrolled.push(rel);
  }
  return { population: files.length, gates, controlled, controlledCount, excludedCount, uncontrolled };
}

module.exports = {
  classifyTestFile,
  discoverTestFiles,
  isRecordedExclusion,
  GUARD_EXCLUSIONS,
  MIGRATED,
  isMigratedSource,
  CALLS_BARE_DEFINEGUARD,
  UNMIGRATED_BASELINE,
  ratchetUnmigrated,
  readsArtifact,
  READS_ARTIFACT,
  unsafeCliRunnerQuoteScans,
  CLI_QUOTE_SCAN_EXCLUSIONS,
  isRecordedCliQuoteScanExclusion,
  discoverFilesByExt,
  discoverCliQuoteScanFiles,
  READ_CALLS,
  REPO_ROOTED,
  STANDALONE_ARTIFACT_SIGNALS,
  PATTERN_MATCHES,
  // ---- production build-gate population (phase 5b, task 5)
  discoverProductionFiles,
  classifyProductionFile,
  GATE_REFUSES,
  GATE_VERDICT,
  PRODUCTION_VERDICT_EXTRA,
  buildGateGuardFiles,
  modulesNamedByGuard,
  controlledProductionModules,
  PRODUCTION_GATE_EXCLUSIONS,
  isRecordedProductionGateExclusion,
  PRODUCTION_SCOPE_SKIP,
  UNCONTROLLED_GATE_BASELINE,
  GATE_SHAPED_FLOOR,
  ratchetUncontrolledGates,
  sweepProductionGates,
};
