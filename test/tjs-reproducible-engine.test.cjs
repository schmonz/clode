'use strict';
// The engine must build to the SAME BYTES twice (phase 4c3 review, finding "§5 the
// reproducibility question", 2026-09-19).
//
// WHAT WAS BELIEVED, AND WAS WRONG. Phase 4c3 task 2 reported the shipped `tjs` as
// irreducibly nondeterministic on macOS for TWO reasons: mimalloc's build banner, and "a
// fresh LC_UUID the Apple linker assigns on every link". The second one is false. ld64's
// LC_UUID is a CONTENT HASH, not a per-link nonce — two links of identical objects to an
// identical output path produce an identical UUID, verified directly (three links of one
// object: one UUID; and a relink to the same path after a one-second wait: byte-identical
// binaries). The differing UUIDs observed were a CONSEQUENCE of differing content, not an
// independent cause.
//
// So there was exactly ONE cause, three bytes wide: `__TIME__` inside
// deps/mimalloc/src/options.c's verbose banner. (`__DATE__` is stable within a day and
// contributed nothing, which is why it took a build straddling a minute boundary to see.)
// Remove it and the whole linked binary — UUID, code signature and all — becomes
// reproducible. `fixupMimallocBuildBanner` in scripts/build-tjs.cjs does that, and this
// file is what says so out loud.
//
// WHY A SOURCE FIXUP AND NOT A COMPILE FLAG. `-Wno-builtin-macro-redefined
// -D__DATE__=... -D__TIME__=...` also works (measured: object AND linked binary
// byte-identical across builds >1s apart) but it is a gcc/clang spelling that MSVC does
// not accept, and this repo builds two Windows legs with `cl`. A source edit is one
// implementation for all 42 legs — the house doctrine — and it rides the SAME anchored,
// content-verified, unconditional source-phase machinery as the other ~50 fixups, which
// throws loudly if upstream moves the line instead of silently doing nothing. That last
// property is the one that matters here: this repo has a scar where src/js patches were
// silently dropped because regeneration was opt-in, and an edit that can be skipped in
// silence is worse than no edit at all.
//
// WHY NOT SOURCE_DATE_EPOCH. Nothing in this repo honours it (checked: zero references
// outside this file's own comment). It is also the weaker lever for this job: it makes a
// build reproducible only among builders who all export the SAME value, so every leg,
// every CI job and every developer would have to agree on one — whereas baking the epoch
// literal in makes the engine reproducible with no environment coordination at all.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { tjsVendorParentDir } = require('../scripts/platform-tag.cjs');
const { defineGuard, guardTests } = require('./guard.cjs');
const { copyCheckout } = require('./engine-build-harness.cjs');

const REPO = path.resolve(__dirname, '..');
const SHARED = path.join(tjsVendorParentDir(), 'txiki.js');

// Both levers are worth nothing if the build can reach the end without applying them, so
// the wiring is scanned as text — through defineGuard, so the scan is PROVEN able to fail
// rather than merely green. scripts/build-tjs.cjs cannot be require()d: it runs a whole
// engine build the moment it is loaded (see test/ccache.test.cjs's header).
//
// PURE: `src` is the already-read scripts/build-tjs.cjs text.
function scanReproWiring({ src }) {
  const findings = [];
  let examined = 0;

  examined++;
  if (src.split('\n').filter((l) => /^\s*fixupMimallocBuildBanner\(tjsDir\);\s*$/.test(l)).length !== 1) {
    findings.push('scripts/build-tjs.cjs must call `fixupMimallocBuildBanner(tjsDir);` exactly '
      + 'once, unconditionally, in the source phase — an edit that can be skipped in silence '
      + 'is the src/js-patches scar');
  }

  examined++;
  if (!/function fixupMimallocBuildBanner\(dir\) \{/.test(src)) {
    findings.push('fixupMimallocBuildBanner is not defined');
  }

  examined++;
  if (!/throw new Error\('fixup mimalloc-build-banner: anchor not found/.test(src)) {
    findings.push('the banner fixup must THROW when its anchor is gone (a txiki bump moves the '
      + 'line), not quietly no-op — an unapplied fixup silently un-reproduces every build');
  }

  // THE THIRD CAUSE, and the one that makes the engine a function of THE BUILDER'S GIT
  // CHECKOUT rather than of its own sources. MEASURED 2026-09-20, from a path-independence
  // double build: 371 of 372 objects identical, and
  // deps/mimalloc/.../options.c.o differing by 87 bytes, carrying
  //
  //     git v0.20260831.1-323-g611c0ab   vs   git v0.20260831.1-324-g72097c4
  //
  // -- THIS repo's `git describe`, which moved because a commit landed between the two
  // builds. deps/mimalloc/CMakeLists.txt:88 tests for `${CMAKE_SOURCE_DIR}/.git/index` and
  // then runs `git describe` with NO working directory, so it answers about whatever
  // directory cmake was launched from, and defines MI_GIT_DESCRIBE from it.
  //
  // Consequence, which is worse than one unstable object: every commit to clode changes the
  // engine's bytes, whether or not it changes an engine source, so no engine hash can ever
  // be a function of the recipe and rebuild-and-verify cannot work. The existing
  // `reproducible` verdicts held only because both of their builds happened inside one
  // un-committed window.
  examined++;
  if (src.split('\n').filter((l) => /^\s*fixupMimallocGitDescribe\(tjsDir\);\s*$/.test(l)).length !== 1) {
    findings.push('scripts/build-tjs.cjs must call `fixupMimallocGitDescribe(tjsDir);` exactly '
      + 'once, unconditionally, in the source phase — without it mimalloc defines '
      + "MI_GIT_DESCRIBE from whatever `git describe` says in cmake's working directory, and "
      + "the engine's bytes become a function of the BUILDER's checkout state");
  }

  examined++;
  if (!/throw new Error\('fixup mimalloc-git-describe: anchor not found/.test(src)) {
    findings.push('the git-describe fixup must THROW when its anchor is gone, not quietly '
      + 'no-op — an unapplied fixup silently un-reproduces every build');
  }

  examined++;
  if (src.split('\n').filter((l) => /^process\.env\.ZERO_AR_DATE = '1';$/.test(l)).length !== 1) {
    findings.push("scripts/build-tjs.cjs must set `process.env.ZERO_AR_DATE = '1';` exactly once "
      + 'at top level, so every ar/libtool cmake spawns inherits it — without it the static '
      + 'archives carry member mtimes and the linked engine differs between two builds of '
      + 'identical sources');
  }

  return { findings, examined };
}

const reproWiringGuard = defineGuard({
  name: 'engine-reproducibility-wiring',
  read: () => ({ src: fs.readFileSync(path.join(REPO, 'scripts/build-tjs.cjs'), 'utf8') }),
  scan: scanReproWiring,
  // Six independent facts in one named file — the exact measured count.
  floor: 6,
  // Models the regression precisely: a build script that has lost both levers.
  control: () => ({ src: '// a source phase with no banner fixup and no archive-date lever\n' }),
});
guardTests(reproWiringGuard);

// THE SECOND CAUSE, found by actually running the whole-binary acceptance after the banner
// fix rather than by declaring victory at the object grain: with all 371 objects byte-
// identical, two linked engines STILL differed (16 bytes of LC_UUID plus ~555 bytes of
// re-hashed ad-hoc code signature). The differing inputs were the 14 static archives --
// Apple's `ar`/`libtool` writes each member's mtime into the archive header, so libuv.a and
// friends differ between two builds of identical objects, and ld64 folds that into the UUID
// it derives. (This is ALSO why "the linker assigns a random UUID" looked true: the UUID
// really is content-derived, but one of the contents it derives from was a clock.)
//
// ZERO_AR_DATE=1 is the reproducible-builds.org lever for exactly this, read by Apple's
// cctools ar and libtool; GNU binutils `ar` ignores it (it wants `-D`, and most distros
// already build it deterministic by default). Setting it unconditionally is ONE
// implementation for every leg rather than a darwin branch -- it is inert where it is not
// understood. VERIFIED, not assumed: `ar qc` twice over one touched object produced two
// different archives here, and two full engine builds with ZERO_AR_DATE=1 set produced
// byte-identical `tjs` binaries (sha256 e9c5c7881971, twice).
// The real thing: drive the actual source phase and look at the tree it produced. Against
// a THROWAWAY copy-on-write copy, never the shared checkout — test/ccache.test.cjs already
// uses this recipe, and mutating ~/.cache/clode/tjs-vendor here would race the one other
// test file that legitimately owns that tree.
// copyCheckout now lives in test/engine-build-harness.cjs — this was one of FOUR
// byte-identical copies (see that file's header). Same recipe, one home, and the
// process.platform branch gone: the fast-copy flags are tried in turn rather than
// selected, which is what the branch fell through to anyway.

test('a real source phase leaves NO __DATE__/__TIME__ anywhere in the engine sources', (t) => {
  if (!fs.existsSync(path.join(SHARED, 'CMakeLists.txt'))) {
    t.skip(`no vendor checkout at ${SHARED} — run \`node scripts/build-tjs.cjs --source-only\` once`);
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tjs-repro-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  const vendorParent = path.join(dir, 'vendor');
  fs.mkdirSync(vendorParent, { recursive: true });
  const tree = path.join(vendorParent, 'txiki.js');
  copyCheckout(SHARED, tree);

  execFileSync(process.execPath, ['scripts/build-tjs.cjs', '--source-only'],
    { cwd: REPO, stdio: 'pipe', encoding: 'utf8',
      env: { ...process.env, CLODE_TJS_VENDOR: vendorParent } });

  // The banner itself: replaced, and by the epoch literals, not by something that only
  // LOOKS stable.
  const options = fs.readFileSync(path.join(tree, 'deps/mimalloc/src/options.c'), 'utf8');
  assert.ok(!/__DATE__|__TIME__/.test(options), 'mimalloc still bakes __DATE__/__TIME__');
  assert.match(options, /"Jan {2}1 1970", "00:00:00"/);

  // The SWEEP, which is the part that survives a txiki version bump: nothing ELSE in the
  // tree may reference these macros either. A new dependency (or a moved banner) that
  // reintroduces one re-breaks reproducibility everywhere, and the fixup's own anchor
  // check cannot see that — only a tree-wide look can.
  // Restricted to COMPILED sources: node_modules ships syntax-highlighting grammars for C
  // that list every predefined macro by name, and those are data the build never reads.
  const COMPILED = ['*.c', '*.h', '*.cc', '*.cpp', '*.hpp', '*.cxx', '*.m', '*.S', '*.s', '*.inc'];
  const hits = spawnSync('grep', ['-rIl', '--exclude-dir=.git', '--exclude-dir=node_modules',
    ...COMPILED.map((g) => `--include=${g}`), '-e', '__DATE__', '-e', '__TIME__', tree],
    { encoding: 'utf8' });
  assert.ok(hits.status === 0 || hits.status === 1, `grep failed: ${hits.stderr}`);
  const files = hits.stdout.split('\n').filter(Boolean).map((p) => path.relative(tree, p));
  assert.deepStrictEqual(files, [],
    'a source file in the patched engine tree still references __DATE__/__TIME__ — every one '
    + 'of them makes the compiled object (and the whole linked engine) differ between two '
    + 'builds of identical sources. Neutralise it the same way fixupMimallocBuildBanner does:\n'
    + files.join('\n'));
});
