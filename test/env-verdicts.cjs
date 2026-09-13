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
//   phase4-engine the scripts/build-tjs.mjs cluster (plus its two platform-tag.cjs helpers,
//                 CLODE_TJS_LOCAL_ROOT/CLODE_TJS_VENDOR, which exist only to compute the
//                 same engine-build cache dir build-tjs.mjs uses). Options to a COMPILE;
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
  + 'produces. Sibling of the other applet overrides in this same resolution family.';

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
  // ---- just not yet wired onto cli-surface.cjs's table. That wiring is a later task's ----
  // ---- job; this verdict only records that the KIND is right. ----
  { name: 'CLODE_ENGINE_RECIPE', verdict: 'absorbed',
    because: 'read by clode-build.cjs; one of the eight decided phase-3b absorption '
      + 'candidates (BACKLOG.md, 2026-09-13) — selects the engine recipe a build uses, '
      + 'changing what gets built. Not yet declared in cli-surface.cjs; that wiring is a '
      + 'later task.' },
  { name: 'CLODE_RELEASE_BASE', verdict: 'absorbed',
    because: 'read by clode-build.cjs; one of the eight decided phase-3b absorption '
      + 'candidates — overrides the base URL a release build resolves published inputs '
      + 'against, changing what gets fetched into the build. Not yet declared in '
      + 'cli-surface.cjs.' },
  { name: 'CLODE_TEMPLATES_BASEURL', verdict: 'absorbed',
    because: 'read by clode-build.cjs; one of the eight decided phase-3b absorption '
      + "candidates — selects where a build's engine templates are fetched from, a real "
      + 'build-input override. Not yet declared in cli-surface.cjs.' },
  { name: 'CLODE_TEMPLATES_BLOB', verdict: 'absorbed',
    because: 'read by clode-build.cjs; one of the eight decided phase-3b absorption '
      + 'candidates — an explicit templates blob to build from instead of resolving one, '
      + 'a build-input override. Not yet declared in cli-surface.cjs.' },
  { name: 'CLODE_TEMPLATES_MANIFEST', verdict: 'absorbed',
    because: 'read by clode-build.cjs; one of the eight decided phase-3b absorption '
      + 'candidates — an explicit templates manifest to build from, a build-input override. '
      + 'Not yet declared in cli-surface.cjs.' },
  { name: 'CLODE_TJS_PIN', verdict: 'absorbed',
    because: 'read by clode-build.cjs; one of the eight decided phase-3b absorption '
      + 'candidates — pins which engine version a build targets, changing what gets built. '
      + 'Not yet declared in cli-surface.cjs.' },
  { name: 'CLODE_ALLOW_FOREIGN_CARVE', verdict: 'absorbed',
    because: 'read by clode-build.cjs; one of the eight decided phase-3b absorption '
      + 'candidates, though BACKLOG.md leaves its exact MECHANISM open deliberately — "it '
      + 'disables a safety check rather than selecting an input, which makes it a different '
      + 'KIND of candidate", to be answered by measurement rather than opinion. The KIND '
      + 'recorded here is still absorbed: it changes whether a build proceeds with a '
      + 'foreign-carved input at all, which is a WHAT-GETS-BUILT decision even if the '
      + 'eventual UI is not a plain flag.' },

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

  // ---- Host-applet resolution overrides (bun-shim.cjs / target-env.cjs / bun-graph.cjs). ----
  { name: 'CLODE_BFS', verdict: 'env-only', because: APPLET_BECAUSE },
  { name: 'CLODE_RG', verdict: 'env-only', because: APPLET_BECAUSE },
  { name: 'CLODE_UGREP', verdict: 'env-only', because: APPLET_BECAUSE },
  { name: 'CLODE_ZSTD', verdict: 'env-only', because: APPLET_BECAUSE },

  // ---- The scripts/build-tjs.mjs engine-build-knob cluster, decided phase4-engine. ----
  // ---- CLODE_TJS_LOCAL_ROOT and CLODE_TJS_VENDOR ride along: they exist only in ----
  // ---- scripts/platform-tag.cjs to compute the SAME engine-vendor cache dir ----
  // ---- build-tjs.mjs itself uses, measured to bring the cluster to exactly 20 ----
  // ---- (BACKLOG.md's own count). ----
  { name: 'CLODE_COSMOCC', verdict: 'phase4-engine', because: 'scripts/build-tjs.mjs '
    + 'compile-option cluster; see the file header for the phase-4/cmake reason.' },
  { name: 'CLODE_TJS_ATOMIC_SHIM', verdict: 'phase4-engine', because: 'scripts/build-tjs.mjs '
    + 'compile-option cluster; see the file header for the phase-4/cmake reason.' },
  { name: 'CLODE_TJS_BUILD', verdict: 'phase4-engine', because: 'scripts/build-tjs.mjs '
    + 'compile-option cluster; see the file header for the phase-4/cmake reason.' },
  { name: 'CLODE_TJS_CROSS_FILE', verdict: 'phase4-engine', because: 'scripts/build-tjs.mjs '
    + 'compile-option cluster; see the file header for the phase-4/cmake reason.' },
  { name: 'CLODE_TJS_DARWIN_POLL', verdict: 'phase4-engine', because: 'scripts/build-tjs.mjs '
    + 'compile-option cluster; see the file header for the phase-4/cmake reason.' },
  { name: 'CLODE_TJS_FFI', verdict: 'phase4-engine', because: 'scripts/build-tjs.mjs '
    + 'compile-option cluster; see the file header for the phase-4/cmake reason.' },
  { name: 'CLODE_TJS_LOCAL_ROOT', verdict: 'phase4-engine',
    because: 'read by both scripts/build-tjs.mjs and scripts/platform-tag.cjs to compute '
      + 'the same engine-vendor cache dir the compile-option cluster uses; travels with it '
      + 'to phase 4 rather than splitting one cache location across two verdicts.' },
  { name: 'CLODE_TJS_MACOS_ARCH', verdict: 'phase4-engine', because: 'scripts/build-tjs.mjs '
    + 'compile-option cluster; see the file header for the phase-4/cmake reason.' },
  { name: 'CLODE_TJS_MACOS_MIN', verdict: 'phase4-engine', because: 'scripts/build-tjs.mjs '
    + 'compile-option cluster; see the file header for the phase-4/cmake reason.' },
  { name: 'CLODE_TJS_MACOS_SDK', verdict: 'phase4-engine', because: 'scripts/build-tjs.mjs '
    + 'compile-option cluster; see the file header for the phase-4/cmake reason.' },
  { name: 'CLODE_TJS_MIMALLOC', verdict: 'phase4-engine', because: 'scripts/build-tjs.mjs '
    + 'compile-option cluster; see the file header for the phase-4/cmake reason.' },
  { name: 'CLODE_TJS_OUT', verdict: 'phase4-engine', because: 'scripts/build-tjs.mjs '
    + 'compile-option cluster; see the file header for the phase-4/cmake reason.' },
  { name: 'CLODE_TJS_REGEN', verdict: 'phase4-engine', because: 'scripts/build-tjs.mjs '
    + 'compile-option cluster; see the file header for the phase-4/cmake reason.' },
  { name: 'CLODE_TJS_SMOKE', verdict: 'phase4-engine', because: 'scripts/build-tjs.mjs '
    + 'compile-option cluster; see the file header for the phase-4/cmake reason.' },
  { name: 'CLODE_TJS_STATIC', verdict: 'phase4-engine', because: 'scripts/build-tjs.mjs '
    + 'compile-option cluster; see the file header for the phase-4/cmake reason.' },
  { name: 'CLODE_TJS_TARGET', verdict: 'phase4-engine', because: 'scripts/build-tjs.mjs '
    + 'compile-option cluster; see the file header for the phase-4/cmake reason.' },
  { name: 'CLODE_TJS_VENDOR', verdict: 'phase4-engine',
    because: 'read by scripts/platform-tag.cjs to compute the same engine-vendor cache dir '
      + 'the build-tjs.mjs compile-option cluster uses; travels with it to phase 4.' },
  { name: 'CLODE_TJS_WASM', verdict: 'phase4-engine', because: 'scripts/build-tjs.mjs '
    + 'compile-option cluster; see the file header for the phase-4/cmake reason.' },
  { name: 'CLODE_TJS_WIN_MINGW', verdict: 'phase4-engine', because: 'scripts/build-tjs.mjs '
    + 'compile-option cluster; see the file header for the phase-4/cmake reason.' },
  { name: 'CLODE_TJS_WIN_MSVC', verdict: 'phase4-engine', because: 'scripts/build-tjs.mjs '
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
      + "platform-arch gets fetched, overriding process.platform/arch detection — and it is "
      + "already user-facing: clode-main.cjs's own usage error for `fetch claude --target` "
      + 'tells the user to "Set CLODE_FETCH_PLATFORM to choose the upstream build '
      + 'deliberately". A real build-input selector already surfaced in an error message, '
      + 'just not yet in cli-surface.cjs\'s declared table.' },
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
  { name: 'CLODE_UPDATE_CHANNEL', verdict: 'absorbed',
    because: 'the env twin of an ALREADY-DOCUMENTED input: fetch\'s '
      + "`[channel|version]` positional tail. resolveChannel's own precedence is "
      + '"explicit arg > CLODE_UPDATE_CHANNEL env > \'latest\'" — exactly the --verbose / '
      + 'CLODE_VERBOSE pattern already absorbed above. Selects which release channel gets '
      + 'fetched, a real build input; not yet declared in cli-surface.cjs\'s env table.' },
  { name: 'CLODE_VERSION_DIR', verdict: 'absorbed',
    because: 'the second tier of resolveClaudeBin\'s precedence chain in '
      + 'libexec/clode-resolve.cjs, directly below the already-absorbed CLODE_CLAUDE_BIN '
      + '("CLODE_CLAUDE_BIN > CLODE_VERSION_DIR > provider current"): an explicit installed-'
      + "version directory to extract from. Same KIND of candidate as its sibling — it "
      + 'selects the build input — just not yet declared in cli-surface.cjs.' },
  { name: 'CLODE_WATCH_INTERVAL', verdict: 'absorbed',
    because: 'a real user-facing tunable for the already-absorbed watch feature: the '
      + 'throttle interval (default one day) between clode-watch.cjs\'s update-signal '
      + 'cycles, sibling of the already-declared CLODE_NO_WATCH on the same feature. '
      + 'Belongs on the same verbs\' env table; not yet added.' },
];

module.exports = { VERDICTS, VERDICT_KINDS };
