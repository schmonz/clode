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
const DESTRUCTURES_DEFINEGUARD = /\{[^}]*\bdefineGuard\b[^}]*\}\s*=\s*require\(['"]\.\/guard\.cjs['"]\)/;
const CALLS_BARE_DEFINEGUARD = /(?<![.\w])defineGuard\s*\(/;
function deriveMigrated() {
  const files = discoverTestFiles(__dirname)
    .filter((f) => f !== path.join(__dirname, 'guards-population.test.cjs'))
    .sort();
  const migrated = [];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    if (!DESTRUCTURES_DEFINEGUARD.test(src)) continue;
    if (!CALLS_BARE_DEFINEGUARD.test(src)) continue;
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

module.exports = {
  classifyTestFile,
  discoverTestFiles,
  isRecordedExclusion,
  GUARD_EXCLUSIONS,
  MIGRATED,
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
};
