'use strict';
// The verdict table for every CLODE_* name test/env-inventory.cjs reports as read by SHIPPED
// code (libexec/**, scripts/**). Run the inventory FIRST and classify what it actually
// reports — this file is not transcribed from any plan or spec; it is what remains after
// running `node -e "require('./env-inventory.cjs').indexEnvReads()"` and looking at each
// name's real call site(s).
//
// THE RULE (verbatim from the phase-3b spec):
//   absorbed      the value changes WHAT GETS BUILT (a real or overdue candidate for
//                 declaration on clode's CLI surface, libexec/cli-surface.cjs — some of
//                 these already are, phase 3a; others are decided-but-not-yet-wired, phase
//                 3b; recording the verdict here does not itself wire the flag).
//   env-only      the value changes how the build is OBSERVED or PLUMBED (hermeticity,
//                 diagnostics, host-tool location, output-path relocation) rather than what
//                 gets produced — putting it on --help would document a knob nobody who
//                 isn't already inside this repo's test/CI machinery should be touching.
//   dead          only a test reads it. Structurally cannot occur among the entries below,
//                 because this table only covers names the inventory reports with at least
//                 one PROD reader (see env-verdicts.test.cjs's `shipped` filter) — a name
//                 doesn't qualify for a verdict here at all unless shipped code reads it.
//                 Kept as a real VERDICT_KINDS member for the day a currently-prod-read name
//                 loses its last production call site and becomes test-only without being
//                 deleted from here first; the gate's "phantom" check is what catches that.
//   phase4-engine the scripts/build-tjs.cjs cluster (plus its two platform-tag.cjs helpers,
//                 CLODE_TJS_LOCAL_ROOT/CLODE_TJS_VENDOR, which exist only to compute the
//                 same engine-build cache dir build-tjs.cjs uses). Options to a COMPILE;
//                 `clode build` requires no compiler and no cmake by invariant, so compile
//                 options belong to the program that compiles. Phase 4 moves the engine
//                 build to cmake, where they become typed options with defaults and a cache
//                 instead of undocumented env vars. Decided in BACKLOG.md at 12e28ff — not
//                 re-derived here.
//
// TWO CLUSTERS WERE HANDED DOWN ALREADY DECIDED (phase-3b task-1 brief) rather than derived
// by this file — their `because` strings say so explicitly, and are not this agent's words.
const VERDICT_KINDS = ['absorbed', 'env-only', 'dead', 'phase4-engine'];

// clode-paths.cjs's plumbing seven — ENV-ONLY BY NECESSITY, not by taste: the test/CI
// harness sets these once per run and they must survive three layers of spawn into a worker
// that parses its own argv (clode-main -> clode-build -> a spawned build/test worker). A
// flag cannot do that — it would have to be re-typed at every spawn site — so making these
// flags would be a regression, not an improvement.
const PLUMBING_BECAUSE = 'env-only by necessity: the harness sets this once and it must '
  + 'survive three layers of spawn into a worker that parses its own argv; a CLI flag '
  + 'cannot survive that chain, so making this a flag would be a regression, not a feature.';

// The shim's own diagnostics — env-only because nobody wants `--shim-handle-dump` in a
// shipped binary's help. These exist to be set by a developer chasing a shim bug, invisible
// to the ordinary invocation `clode <verb>` takes.
const SHIM_DIAG_BECAUSE = 'env-only: shim-internal diagnostics for chasing a node-shim bug '
  + '(trace/probe/handle-dump output). Nobody wants a `--shim-handle-dump` flag cluttering a '
  + "shipped binary's --help; these are for a developer with the source, not an end user.";

const APPLET_BECAUSE = 'env-only: overrides which host binary the bun-shim/target-env applet '
  + 'resolver uses for this external tool at RUNTIME (inside a built quaude/naude), not a '
  + "build-time input — it changes where the shim looks, never what clode's own build "
  + 'produces. Sibling of the other applet overrides in this same resolution family. '
  + 'SCOPE NOTE (fix round 3): this sentence is true of CLODE_RG / CLODE_BFS / CLODE_UGREP '
  + 'and of NOTHING ELSE. It used to cover CLODE_ZSTD too, which is false on both halves — '
  + "zstd's consumer runs during `clode build`, not at target runtime. CLODE_ZSTD now has "
  + 'its own entry; do not re-attach this constant to a name whose reader is a build step.';

// The host-provision.cjs REGISTRY's override variables — CLODE_SHA256 / CLODE_TAR /
// CLODE_GZIP / CLODE_UNZIP (CLODE_ZSTD is the same family but earns its own text below,
// because its failure mode is sharper). Read INDIRECTLY, as `env[req.overrideEnv]` at
// host-provision.cjs:281, which is why none of them had a verdict until the indirect
// detector (test/env-indirect.cjs) went in.
//
// These run DURING a build (clode-net.cjs verifies a download's digest, clode-node.cjs and
// naude-sea.cjs and clode-rcodesign.cjs unpack tarballs, build-tjs.cjs unzips), so the
// "runtime, not build-time" reasoning that fits the applet overrides does not apply. They
// are env-only for a different and better reason: they name WHICH HOST PROGRAM performs a
// step whose OUTPUT is fixed. The registry runs a known-answer test on whatever it
// resolves — a digest of known bytes, a tar round-trip, a gzip/zip blob with known
// plaintext — so an override that is not the tool it claims to be is REFUSED rather than
// used, and an override that passes produces byte-identical results to the default. A knob
// that cannot change the artifact is not a build input.
const HOST_TOOL_BECAUSE = 'env-only: names which host program host-provision.cjs uses for '
  + 'this step (resolved indirectly as `env[req.overrideEnv]` from its REGISTRY row). These '
  + 'steps run during a build AND, for tar, inside an already-built naude — naude-entry.cjs '
  + "requires host-provision.cjs precisely so runtime provision('tar') works in the SEA. "
  + 'The registry KAT-tests whatever it resolves and refuses an override that fails, so an '
  + 'override that passes does the step correctly for what the KAT covers — hashing, and a '
  + 'round trip of one plain regular file. That is a real floor, not a byte-equivalence '
  + 'proof: no KAT here exercises modes, symlinks or ownership, and this repo has already '
  + 'shipped a copy that dropped mode. A host-tool LOCATION override for a host that keeps '
  + 'the tool somewhere unusual — same family as CLODE_NPM, not a build-input selector.';

// CLODE_TTY_MOUSE / CLODE_TTY_FOCUS — the one pair in this table whose classification has a
// fact to face rather than route around: libexec/node-shim/modules/tty.cjs documents them,
// in its own words, as USER-FACING OPT-INS ("Opt back in per capability: CLODE_TTY_MOUSE=1 /
// CLODE_TTY_FOCUS=1"). So the usual env-only sentence — "a knob nobody outside this repo's
// test/CI machinery should be touching" — is simply false about them, and picking env-only
// on the strength of that sentence would be picking a verdict to avoid work.
//
// They are env-only anyway, on the RULE rather than on that sentence. The axis is what the
// value changes, and these change neither what `clode build` produces nor how a build is
// observed: NO clode verb reads them. They are read inside an ALREADY-BUILT quaude, by the
// shim, while the product is running, to re-enable the terminal mouse/focus tracking quaude
// suppresses by default (proven RUINOUS on slow hardware — Tiger, SGR motion flooding input
// until the login prompt could not be submitted).
//
// WHY NOT 'absorbed', explicitly. Assertion 3 in env-verdicts.test.cjs would then require
// them on libexec/cli-surface.cjs's table, i.e. in `clode --help`. That would document, in
// clode's help, two knobs clode itself never reads — a false help sentence in the one binary
// whose --help is its only documentation, which this repo counts as a real defect. The
// binary that SHOULD document them is the built quaude, whose --help is upstream Claude
// Code's text and not clode's to author.
//
// THE HONEST RESIDUE, recorded rather than hidden by the verdict: today these are documented
// only in a source comment no user of a shipped binary can see. That is a documentation gap
// in the built target's surface, not a misclassification here. Filed in BACKLOG.md.
const TTY_BECAUSE = 'env-only BY THE RULE, not by the usual "internal knob" reasoning — this '
  + 'IS user-facing (tty.cjs documents it as an opt-in). It is env-only because no clode verb '
  + 'reads it at all: the reader is libexec/node-shim/modules/tty.cjs (via _ttyEnv -> '
  + 'tjs.env[name]) inside an ALREADY-BUILT quaude at runtime, re-enabling terminal tracking '
  + "quaude suppresses by default because the event flood starves keystrokes on slow "
  + "hardware. Declaring it 'absorbed' would put it in `clode --help`, documenting a knob "
  + 'clode never reads; its documentation home is the built target, not clode\'s CLI surface. '
  + 'That the target does not yet document it is a real gap, filed in BACKLOG.md.';

const VERDICTS = [
  // ---- Already declared in libexec/cli-surface.cjs (phase 3a) — genuinely absorbed. ----
  { name: 'CLODE_NO_WATCH', verdict: 'absorbed',
    because: "declared on the 'build' verb in cli-surface.cjs (as CLODE_NO_WATCH=1): "
      + 'disables the opportunistic update-signal check a build runs, already documented '
      + 'and rendered into --help.' },
  { name: 'CLODE_TJS', verdict: 'absorbed',
    because: "declared on the 'build' verb in cli-surface.cjs: selects the tjs engine "
      + "template 'clode build' embeds — a real build-input selector, already documented." },
  { name: 'CLODE_TARGET_TEMPLATE', verdict: 'absorbed',
    because: 'declared on BOTH the build verb and the checkout-only bootstrap verb in '
      + 'cli-surface.cjs: an operator-built cross engine used instead of the published '
      + 'template — selects a build input, already documented.' },
  { name: 'CLODE_CHANGELOG_URL', verdict: 'absorbed',
    because: "declared on both 'fetch' and 'read-anthropic-tea-leaves' in cli-surface.cjs: "
      + 'the release-notes source for the post-update signals digest, already documented.' },
  { name: 'CLODE_VERBOSE', verdict: 'absorbed',
    because: "declared as a global env in cli-surface.cjs: the --verbose global's "
      + 'environment twin, already documented (same pattern as --verbose itself).' },
  { name: 'CLODE_CLAUDE_BIN', verdict: 'absorbed',
    because: 'declared as a global env in cli-surface.cjs: the upstream claude binary to '
      + 'extract from — the first tier of resolveClaudeBin\'s precedence chain, already '
      + 'documented.' },
  { name: 'CLODE_NODE', verdict: 'absorbed',
    because: 'declared as a global env in cli-surface.cjs: the host node to run with, '
      + 'already documented.' },
  { name: 'CLODE_MAIN_BUNDLE', verdict: 'absorbed',
    because: 'declared on the checkout-only bootstrap verb in cli-surface.cjs: the esbuilt '
      + "clode-main bundle bootstrap embeds — a build input (which bundle becomes clode's "
      + 'own body), already documented there even though it is read from clode-build.cjs.' },

  // ---- The remaining build-inputs-proper candidates clode-build.cjs reads (BACKLOG.md, ----
  // ---- "PHASE 3B SPECCED", the eight-decision absorption pool) — genuinely absorbed, ----
  // ---- and WIRED onto cli-surface.cjs's table by phase 3b task 2 (declared on both the ----
  // ---- 'build' and checkout-only 'bootstrap' verbs — measured, not guessed, at ----
  // ---- clode-build.cjs:1129-1189, the shared --target/--list-targets call chain both ----
  // ---- verbs run through before branching on `self`). ----
  { name: 'CLODE_ENGINE_RECIPE', verdict: 'absorbed',
    because: 'read by clode-build.cjs; declared on both the build and bootstrap verbs in '
      + "cli-surface.cjs — checked against a --target engine template's recipe to catch a "
      + 'mismatch, changing what gets built.' },
  { name: 'CLODE_RELEASE_BASE', verdict: 'absorbed',
    because: 'read by clode-build.cjs; declared on both the build and bootstrap verbs in '
      + "cli-surface.cjs — overrides the base URL a --target build resolves its templates "
      + 'manifest and engine against, changing what gets fetched into the build.' },
  { name: 'CLODE_TEMPLATES_BASEURL', verdict: 'absorbed',
    because: 'read by clode-build.cjs; declared on both the build and bootstrap verbs in '
      + "cli-surface.cjs — selects where a --target build's engine templates are fetched "
      + 'from, a real build-input override.' },
  { name: 'CLODE_TEMPLATES_BLOB', verdict: 'absorbed',
    because: 'read by clode-build.cjs; declared on both the build and bootstrap verbs in '
      + 'cli-surface.cjs — an explicit templates blob to build a --target engine from '
      + 'instead of resolving one, a build-input override.' },
  { name: 'CLODE_TEMPLATES_MANIFEST', verdict: 'absorbed',
    because: 'read by clode-build.cjs; declared on both the build and bootstrap verbs in '
      + 'cli-surface.cjs — an explicit templates manifest to build --target/--list-targets '
      + 'from, a build-input override.' },
  { name: 'CLODE_TJS_PIN', verdict: 'absorbed',
    because: 'read by clode-build.cjs; declared on both the build and bootstrap verbs in '
      + "cli-surface.cjs — checked against a --target engine template's pin to catch a "
      + 'mismatch, changing what gets built.' },
  { name: 'CLODE_ALLOW_FOREIGN_CARVE', verdict: 'absorbed',
    because: 'read by clode-build.cjs; declared on the build verb ONLY in cli-surface.cjs, '
      + "as CLODE_ALLOW_FOREIGN_CARVE=1 — deliberately DOCUMENTED BUT NOT GIVEN A FLAG "
      + '(phase 3b task 2\'s decision, recorded in both cli-surface.cjs and BACKLOG.md): it '
      + 'disables the carve-vs-target-platform safety check rather than selecting an input, '
      + "and a discoverable --allow-foreign-carve flag would invite reaching for it to get "
      + 'past a build failure instead of fetching a matching provider. The KIND is still '
      + 'absorbed: it changes whether a build proceeds with a foreign-carved input at all, '
      + "which is a WHAT-GETS-BUILT decision even though the UI stays an awkward env var. "
      + 'Not declared on bootstrap: the guard is gated `!self`, so bootstrap never reads it.' },

  // ---- clode-paths.cjs's plumbing seven — decided already, used verbatim. ----
  { name: 'CLODE_STATE_ROOT', verdict: 'env-only', because: PLUMBING_BECAUSE },
  { name: 'CLODE_CACHE', verdict: 'env-only',
    because: PLUMBING_BECAUSE + ' (Also already declared as a global env in '
      + 'cli-surface.cjs\'s --help text — documented AND env-only are not in tension here: '
      + "env-only says it can't become a flag, not that it can't be documented as env.)" },
  { name: 'CLODE_DEPS', verdict: 'env-only', because: PLUMBING_BECAUSE },
  { name: 'CLODE_PROVIDERS', verdict: 'env-only', because: PLUMBING_BECAUSE },
  { name: 'CLODE_NODES', verdict: 'env-only', because: PLUMBING_BECAUSE },
  { name: 'CLODE_TRACE_LOG', verdict: 'env-only', because: PLUMBING_BECAUSE },
  { name: 'CLODE_WATCH_DIR', verdict: 'env-only', because: PLUMBING_BECAUSE },

  // ---- Shim diagnostics — decided already, used verbatim. ----
  { name: 'CLODE_SHIM_PROBE', verdict: 'env-only', because: SHIM_DIAG_BECAUSE },
  { name: 'CLODE_SHIM_TRACE', verdict: 'env-only', because: SHIM_DIAG_BECAUSE },
  { name: 'CLODE_SHIM_DEBUG', verdict: 'env-only', because: SHIM_DIAG_BECAUSE },
  { name: 'CLODE_SHIM_HANDLE_DUMP', verdict: 'env-only', because: SHIM_DIAG_BECAUSE },
  { name: 'CLODE_PROBE', verdict: 'env-only', because: SHIM_DIAG_BECAUSE },
  { name: 'CLODE_RG_DEBUG', verdict: 'env-only', because: SHIM_DIAG_BECAUSE },

  // ---- Host-applet resolution overrides (bun-shim.cjs / target-env.cjs). ----
  { name: 'CLODE_BFS', verdict: 'env-only', because: APPLET_BECAUSE },
  { name: 'CLODE_RG', verdict: 'env-only', because: APPLET_BECAUSE },
  { name: 'CLODE_UGREP', verdict: 'env-only', because: APPLET_BECAUSE },

  // ---- host-provision.cjs's REGISTRY overrides — reached INDIRECTLY (see the ----
  // ---- HOST_TOOL_BECAUSE note above and test/env-indirect.cjs for why they were ----
  // ---- invisible to the inventory until 2026-09-13). ----
  { name: 'CLODE_SHA256', verdict: 'env-only', because: HOST_TOOL_BECAUSE
    + ' Consumers: clode-net.cjs (verify a download) and clode-update.cjs; the registry KAT '
    + 'hashes known bytes and compares the parsed digest, so a non-sha256 "sha256" is refused.' },
  { name: 'CLODE_TAR', verdict: 'env-only', because: HOST_TOOL_BECAUSE
    + ' Consumers: clode-node.cjs, naude-sea.cjs, clode-rcodesign.cjs; the registry KAT is a '
    + 'create+extract round-trip compared byte-exactly, so a tar that cannot do both is refused.' },
  { name: 'CLODE_GZIP', verdict: 'env-only', because: HOST_TOOL_BECAUSE
    + ' Consumer: clode-net.cjs; the registry KAT inflates an embedded blob and compares the '
    + 'exact plaintext, so an override that is not a gzip decompressor is refused.' },
  { name: 'CLODE_UNZIP', verdict: 'env-only', because: HOST_TOOL_BECAUSE
    + ' Consumers: clode-node.cjs and scripts/build-tjs.cjs; the registry KAT extracts an '
    + "embedded zip and compares its single entry's exact content." },
  { name: 'CLODE_ZSTD', verdict: 'env-only',
    because: 'CORRECTED (fix round 3): this was carrying APPLET_BECAUSE, which is wrong on '
      + 'both the WHEN and the WHAT. Its consumer is not the runtime applet resolver — it is '
      + 'libexec/bun-graph.cjs, reached from clode-extract.cjs / extract-claude-js.cjs DURING '
      + '`clode build`, decoding the zstd-framed assets upstream started shipping; '
      + 'bun-graph.cjs:197-199 says outright that "without this, the shipped builder cannot '
      + 'carve upstream 2.1.251+ at all" (tjs has no zstd and node-shim/modules/zlib.cjs '
      + 'deliberately has none, so on a published clode the external decoder is the ONLY one '
      + 'there is). It is still env-only, for the HOST_TOOL_BECAUSE reason rather than a '
      + 'runtime one: it names which host program decodes, not what gets built. That holds '
      + 'only because the resolution goes through host-provision.cjs and its KAT — '
      + 'bun-graph.cjs:216-219 records the failure mode when it does not (a "zstd" that exits '
      + '0 and echoes its input makes the carve embed the COMPRESSED FRAME as the asset text, '
      + 'and the built target dies on its first real turn), which is exactly why the '
      + 'known-answer test there uses a genuinely COMPRESSED frame and not a raw block.' },

  // ---- The built target's own tty tracking opt-ins (node-shim/modules/tty.cjs). ----
  // ---- Reached indirectly via _ttyEnv(name) -> tjs.env[name]; see test/env-indirect.cjs. ----
  { name: 'CLODE_TTY_MOUSE', verdict: 'env-only', because: TTY_BECAUSE
    + ' This one re-enables mouse tracking (\\e[?1000/1001/1002/1003h).' },
  { name: 'CLODE_TTY_FOCUS', verdict: 'env-only', because: TTY_BECAUSE
    + ' This one re-enables focus reporting (\\e[?1004h).' },

  // ---- The scripts/build-tjs.cjs engine-build-knob cluster, decided phase4-engine. ----
  // ---- CLODE_TJS_LOCAL_ROOT and CLODE_TJS_VENDOR ride along: they exist only in ----
  // ---- scripts/platform-tag.cjs to compute the SAME engine-vendor cache dir ----
  // ---- build-tjs.cjs itself uses, measured to bring the cluster to exactly 21 ----
  // ---- (BACKLOG.md's own count, +1 for phase 4c3 task 1's CLODE_TJS_CCACHE, ----
  // ---- +1 for CLODE_ESBUILD — the npm escape hatch in ensureEsbuild). ----
  { name: 'CLODE_COSMOCC', verdict: 'phase4-engine', because: 'scripts/build-tjs.cjs '
    + 'compile-option cluster; see the file header for the phase-4/cmake reason.' },
  { name: 'CLODE_ESBUILD', verdict: 'phase4-engine',
    because: 'scripts/build-tjs.cjs ensureEsbuild: hands the SOURCE phase a pinned-0.28.1 '
      + 'esbuild so it never shells to npm. It exists because npm is a Node program and '
      + 'every other phase of the engine build is now proven to run with no Node on PATH; '
      + 'same compile-option cluster as the rest of this list, for the same phase-4 reason.' },
  { name: 'CLODE_TJS_ATOMIC_SHIM', verdict: 'phase4-engine', because: 'scripts/build-tjs.cjs '
    + 'compile-option cluster; see the file header for the phase-4/cmake reason.' },
  { name: 'CLODE_TJS_BUILD', verdict: 'phase4-engine', because: 'scripts/build-tjs.cjs '
    + 'compile-option cluster; see the file header for the phase-4/cmake reason.' },
  { name: 'CLODE_TJS_CCACHE', verdict: 'phase4-engine',
    because: 'read by scripts/ccache-launcher.cjs (required from scripts/build-tjs.cjs) as '
      + 'the =0 opt-out for the compiler-launcher probe; same compile-option cluster as the '
      + 'rest of this list, for the same phase-4/cmake reason.' },
  { name: 'CLODE_TJS_CROSS_FILE', verdict: 'phase4-engine', because: 'scripts/build-tjs.cjs '
    + 'compile-option cluster; see the file header for the phase-4/cmake reason.' },
  { name: 'CLODE_TJS_DARWIN_POLL', verdict: 'phase4-engine', because: 'scripts/build-tjs.cjs '
    + 'compile-option cluster; see the file header for the phase-4/cmake reason.' },
  { name: 'CLODE_TJS_FFI', verdict: 'phase4-engine', because: 'scripts/build-tjs.cjs '
    + 'compile-option cluster; see the file header for the phase-4/cmake reason.' },
  { name: 'CLODE_TJS_LOCAL_ROOT', verdict: 'phase4-engine',
    because: 'read by both scripts/build-tjs.cjs and scripts/platform-tag.cjs to compute '
      + 'the same engine-vendor cache dir the compile-option cluster uses; travels with it '
      + 'to phase 4 rather than splitting one cache location across two verdicts.' },
  { name: 'CLODE_TJS_MACOS_ARCH', verdict: 'phase4-engine', because: 'scripts/build-tjs.cjs '
    + 'compile-option cluster; see the file header for the phase-4/cmake reason.' },
  { name: 'CLODE_TJS_MACOS_MIN', verdict: 'phase4-engine', because: 'scripts/build-tjs.cjs '
    + 'compile-option cluster; see the file header for the phase-4/cmake reason.' },
  { name: 'CLODE_TJS_MACOS_SDK', verdict: 'phase4-engine', because: 'scripts/build-tjs.cjs '
    + 'compile-option cluster; see the file header for the phase-4/cmake reason.' },
  { name: 'CLODE_TJS_MIMALLOC', verdict: 'phase4-engine', because: 'scripts/build-tjs.cjs '
    + 'compile-option cluster; see the file header for the phase-4/cmake reason.' },
  { name: 'CLODE_TJS_OUT', verdict: 'phase4-engine', because: 'scripts/build-tjs.cjs '
    + 'compile-option cluster; see the file header for the phase-4/cmake reason.' },
  { name: 'CLODE_TJS_REGEN', verdict: 'phase4-engine', because: 'scripts/build-tjs.cjs '
    + 'compile-option cluster; see the file header for the phase-4/cmake reason.' },
  { name: 'CLODE_TJS_SMOKE', verdict: 'phase4-engine', because: 'scripts/build-tjs.cjs '
    + 'compile-option cluster; see the file header for the phase-4/cmake reason.' },
  { name: 'CLODE_TJS_STATIC', verdict: 'phase4-engine', because: 'scripts/build-tjs.cjs '
    + 'compile-option cluster; see the file header for the phase-4/cmake reason.' },
  { name: 'CLODE_TJS_TARGET', verdict: 'phase4-engine', because: 'scripts/build-tjs.cjs '
    + 'compile-option cluster; see the file header for the phase-4/cmake reason.' },
  { name: 'CLODE_TJS_VENDOR', verdict: 'phase4-engine',
    because: 'read by scripts/platform-tag.cjs to compute the same engine-vendor cache dir '
      + 'the build-tjs.cjs compile-option cluster uses; travels with it to phase 4.' },
  { name: 'CLODE_TJS_WASM', verdict: 'phase4-engine', because: 'scripts/build-tjs.cjs '
    + 'compile-option cluster; see the file header for the phase-4/cmake reason.' },
  { name: 'CLODE_TJS_WIN_MINGW', verdict: 'phase4-engine', because: 'scripts/build-tjs.cjs '
    + 'compile-option cluster; see the file header for the phase-4/cmake reason.' },
  { name: 'CLODE_TJS_WIN_MSVC', verdict: 'phase4-engine', because: 'scripts/build-tjs.cjs '
    + 'compile-option cluster; see the file header for the phase-4/cmake reason.' },

  // ---- Everything else: classified fresh, one at a time, from its own call site. ----
  { name: 'CLODE_ALLOW_CYCLIC_REQUIRES', verdict: 'env-only',
    because: 'a bisection escape hatch in scripts/merge-step.mjs\'s own safety check '
      + '(refuse-vs-proceed past a cyclic require the SCC merge could not convert). Read '
      + 'directly by `node scripts/merge-step.mjs`, never through clode dispatch — it '
      + 'changes how a regen diagnostic behaves, not what a `clode build` produces.' },
  { name: 'CLODE_ASSET_NAME', verdict: 'env-only',
    because: 'overrides the WHOLE artifact directory name scripts/platform-tag.cjs derives '
      + "(so a CI release leg's dir can carry its deliberate floor/arch spelling). An "
      + 'output-location override for the release pipeline, not a change to what is inside '
      + 'the artifact.' },
  { name: 'CLODE_BUILD_SCRATCH', verdict: 'env-only',
    because: 'relocates the scratch/tmp working directory scripts/build-scratch.cjs hands '
      + 'out (CI\'s build-leg action sets it to a workspace-local dir). A location override '
      + 'for hermeticity, same shape as the clode-paths.cjs plumbing cluster; never changes '
      + 'build content.' },
  { name: 'CLODE_FETCH_PLATFORM', verdict: 'absorbed',
    because: 'read by libexec/clode-update.cjs to choose which upstream provider '
      + "platform-arch gets fetched, overriding process.platform/arch detection — and it "
      + "was already user-facing before this task: clode-main.cjs's own usage error for "
      + '`fetch claude --target` tells the user to "Set CLODE_FETCH_PLATFORM to choose the '
      + 'upstream build deliberately". Declared on the fetch verb in cli-surface.cjs by '
      + 'phase 3b task 2 — a real build-input selector, now in the declared table where '
      + 'that error message already implied it belonged.' },
  { name: 'CLODE_LIBEXEC', verdict: 'env-only',
    because: 'overrides where clode-main.cjs looks for its own libexec/ directory — '
      + 'self-location plumbing for running from a non-standard layout (a checkout with an '
      + 'unusual tree, or a test harness), not a build-content selector.' },
  { name: 'CLODE_NPM', verdict: 'env-only',
    because: 'overrides which npm binary libexec/clode-deps.cjs invokes to install deps '
      + '(used verbatim, matching `${CLODE_NPM:-...}`). A host-tool-location override, '
      + 'sibling of the CLODE_DEPS plumbing it lives next to in the same file; changes how '
      + 'dependency provisioning is PLUMBED, not what a build produces.' },
  { name: 'CLODE_PROVIDER_BIN', verdict: 'env-only',
    because: 'read only by scripts/probe-run.mjs, the shim-probe diagnostic driver, to '
      + 'point it at a specific packaged CC provider binary to test against. A diagnostic '
      + "tool's own configuration, not part of `clode`'s user-facing surface." },
  { name: 'CLODE_RELEASES_URL', verdict: 'env-only',
    because: 'overrides the releases-index URL libexec/clode-update.cjs and '
      + 'target-update-check.cjs query for auto-update signals — a hermeticity knob so '
      + 'tests can point at a local server instead of the real downloads.claude.ai, not a '
      + "user-facing configuration point (no verb's positional or --target selects a "
      + 'releases feed).' },
  { name: 'CLODE_SIGNALS_DIR', verdict: 'env-only',
    because: 'relocates where libexec/clode-update.cjs writes/reads its update-signal '
      + 'snapshot files (falling back to the checkout\'s own signals/ dir otherwise). A '
      + 'location override for test/CI hermeticity, same shape as the clode-paths.cjs '
      + 'plumbing cluster.' },
  { name: 'CLODE_TIMEOUT_SCALE', verdict: 'env-only',
    because: 'scales self-check and floor-probe timeouts (scripts/build-naude.mjs, '
      + 'scripts/floor-probe.mjs) up for a slow or loaded box. Changes how a check is '
      + 'OBSERVED (how long it waits before declaring a hang), never what gets built.' },
  { name: 'CLODE_UPDATE_CHANNEL', verdict: 'env-only',
    because: 'CORRECTED (fix round 2 — the prior correction itself misstated the '
      + 'precedence): NOT the env twin of fetch\'s `[channel|version]` positional — that '
      + "positional resolves through libexec/clode-update.cjs's OWN resolveChannel (an "
      + 'explicit arg wins; else settings.json\'s autoUpdatesChannel; else \'latest\' — see '
      + 'clode-update.cjs:124-129, comment and code agree), which never reads this '
      + 'variable. The only reader is a DIFFERENT resolveChannel in '
      + 'libexec/target-update-check.cjs:17, whose header says it "Runs INSIDE a built '
      + 'target (quaude/naude) with NO clode builder present" — this is the shipped '
      + "product checking for its own update at RUNTIME, not an input to `clode build` or "
      + "clode's fetch verb. Same situation as CLODE_RELEASES_URL (own verdict entry in "
      + 'this file, found by name rather than position): both are read by that same file '
      + 'for that same runtime check, and neither is a user-facing configuration point.' },
  { name: 'CLODE_UPSTREAM_NOTES_REEXEC', verdict: 'env-only',
    because: 'a SELF-SET re-exec sentinel, not a knob anyone is meant to set. '
      + 'scripts/upstream-release-notes.mjs re-execs itself with NODE_USE_ENV_PROXY=1 when a '
      + 'proxy is configured and Node is not already honoring it; proxyReexecEnv() reads '
      + '`env[REEXEC_SENTINEL]` (line 284, the const at line 78) purely to guarantee "never '
      + 'twice" — the re-exec sets it in the child, and seeing it set is how the child knows '
      + 'not to re-exec again. Reached indirectly, which is why it had no verdict until '
      + 'test/env-indirect.cjs. It is read by a release-notes DIAGNOSTIC run as `node '
      + "scripts/upstream-release-notes.mjs`, never through clode dispatch, and it cannot "
      + 'change what any build produces; putting a loop-guard on --help would document an '
      + 'implementation detail as a feature.' },
  { name: 'CLODE_VERSION_DIR', verdict: 'absorbed',
    because: 'the second tier of resolveClaudeBin\'s precedence chain in '
      + 'libexec/clode-resolve.cjs, directly below the already-absorbed CLODE_CLAUDE_BIN '
      + '("CLODE_CLAUDE_BIN > CLODE_VERSION_DIR > provider current"): an explicit installed-'
      + 'version directory to extract from. Same KIND of candidate as its sibling — it '
      + 'selects the build input — and declared beside it as a global env in '
      + 'cli-surface.cjs by phase 3b task 2.' },
  { name: 'CLODE_WATCH_INTERVAL', verdict: 'env-only',
    because: 'CORRECTED (fix round 1): libexec/clode-watch.cjs:286-287 throttles how often '
      + 'a BACKGROUND update-notification check fires (default once a day) — it never '
      + 'touches what a build produces. Feature-proximity to the already-absorbed '
      + 'CLODE_NO_WATCH is not the rule\'s test; the closer analogy is CLODE_TIMEOUT_SCALE '
      + 'above, correctly env-only because it changes how a check is OBSERVED, never what '
      + 'gets built. Same shape here.' },
];

module.exports = { VERDICTS, VERDICT_KINDS };
