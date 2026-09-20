'use strict';
// Deterministic STATIC ARCHIVES, on every toolchain, decided by probing the archiver the
// build will actually run — not by branching on process.platform.
//
// WHY THIS IS A FILE. An engine build produces ~14 static archives (libuv.a, libqjs.a,
// libmimalloc.a, libwebsockets.a, ...) and every one of them carries timestamps in its member
// headers and in its symbol-index member. Two builds of BYTE-IDENTICAL objects therefore
// produce different archives, and the linker carries that clock onward (on darwin, straight
// into LC_UUID and the ad-hoc signature). scripts/build-tjs.cjs used to address this with a
// single line -- `process.env.ZERO_AR_DATE = '1'` -- under a comment calling it "the
// reproducible-builds.org lever ... inert on toolchains that do not read it". The first half
// was too broad and the second half was the trap: inert is not the same as handled.
//
// MEASURED 2026-09-19, live NetBSD 11.0_RC2 evbarm (`GNU ar (NetBSD Binutils nb1) 2.42`),
// two runs two seconds apart:
//
//     bare ar rc                                    DIFFERS
//     bare ar rc with ZERO_AR_DATE=1                DIFFERS     <- no effect whatsoever
//     bare ar rcD                                   IDENTICAL
//
// and in CMAKE'S OWN SHAPE, which is what actually ships (its archive rules are
// `<CMAKE_AR> qc <TARGET> <LINK_FLAGS> <OBJECTS>` followed by `<CMAKE_RANLIB> <TARGET>`):
//
//     ar qc  + ranlib                               DIFFERS
//     ar qc  + ranlib, ZERO_AR_DATE=1               DIFFERS
//     ar qcD + ranlib                               DIFFERS     <- D on `ar` alone buys NOTHING
//     ar qcD + ranlib -D                            IDENTICAL
//     ar qc  + ranlib -D                            IDENTICAL
//
// The fourth line is the one that matters and the one a "just add -D to ar" patch would have
// missed: the trailing ranlib re-stamps the symbol index that `ar -D` had just zeroed. So the
// FINISH rule moves with the CREATE rule, always.
//
// Meanwhile Apple's cctools `ar` REJECTS the flag outright (`ar: illegal option -- D`) and
// reads ZERO_AR_DATE, which GNU ar ignores. Ubuntu's binutils looked clean only because
// Debian/Ubuntu configure binutils with --enable-deterministic-archives; NetBSD does not.
// Same GNU ar, different configure flag -- which is exactly why a version string, a vendor
// name or a platform token cannot answer this question.
//
// THE PORTABLE FORM, therefore, is one goal with a capability probe, not a platform branch
// (the repo's standing "solve it portably" doctrine): run the archiver and ask it. Two
// outcomes, one goal:
//
//     ar takes D      -> teach cmake the deterministic archive rules (qcD / qD / ranlib -D)
//     ar refuses D    -> leave cmake's rules alone; ZERO_AR_DATE is this toolchain's lever
//
// SHAPE: the same house pattern as scripts/ccache-launcher.cjs and scripts/platform-tag.cjs --
// pure decision functions plus injectable I/O seams, so a test can exercise every branch
// (including the ones this host cannot reach) without require()ing scripts/build-tjs.cjs,
// which runs a whole engine build the moment it is loaded.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { findTool } = require('../libexec/clode-hosttools.cjs');

// The archive rules, spelled ONCE. `<CMAKE_AR>`/`<CMAKE_RANLIB>`/`<TARGET>`/`<OBJECTS>` are
// cmake's own placeholders, kept verbatim rather than substituted here: cmake expands them
// with the archiver IT selected, so even if the probe resolved a slightly different binary
// than cmake's CMakeFindBinUtils search would, the BUILD still runs cmake's choice -- the
// probe only ever decides whether a `D` is safe to ask for, never which program runs.
//
// These mirror cmake's defaults (CMakeCInformation.cmake) exactly except for the D:
//     CREATE  <CMAKE_AR> qc  <TARGET> <LINK_FLAGS> <OBJECTS>
//     APPEND  <CMAKE_AR> q   <TARGET> <LINK_FLAGS> <OBJECTS>
//     FINISH  <CMAKE_RANLIB> <TARGET>
// APPEND is included even though a darwin configure of the vendored tree shows only CREATE
// rules today: cmake switches to CREATE+APPEND chunking when an archive has enough objects to
// overflow the command line, which is a property of the leg's object count, not of this code.
const C_ARCHIVE_CREATE_D = '<CMAKE_AR> qcD <TARGET> <LINK_FLAGS> <OBJECTS>';
const C_ARCHIVE_APPEND_D = '<CMAKE_AR> qD <TARGET> <LINK_FLAGS> <OBJECTS>';
const C_ARCHIVE_FINISH_D = '<CMAKE_RANLIB> -D <TARGET>';

// C ONLY, and deliberately. The vendored project is `project(tjs LANGUAGES C)` and a real
// configure's CMakeCache.txt has no CMAKE_CXX_COMPILER at all, so the CXX triple would be
// three cache entries no target ever reads -- which cmake reports as "Manually-specified
// variables were not used by the project", i.e. a warning on every build of every leg that
// gets this far. If a C++ archive ever appears in the vendored tree, the grep that finds
// this comment is `CMAKE_C_ARCHIVE_`, and test/ar-determinism.test.cjs's reach guard is
// where the new case belongs.

function arDeterminismOptedOut(env = process.env) {
  return env.CLODE_TJS_AR_DETERMINISM === '0';
}

// Pure. The value of an explicitly passed `-D<var>=`, or ''. LAST wins, which is how cmake
// itself resolves a repeated -D. Same signal-reading move as ccache-launcher.cjs's
// compilerFromCmakeArgs: the arguments this build ASSEMBLED are the same arguments cmake
// will act on, so reading them back is not a second, driftable notion of the answer.
function archiverFromCmakeArgs(cmakeArgs, cmakeVar) {
  const prefix = `-D${cmakeVar}=`;
  const values = (cmakeArgs || []).filter((a) => typeof a === 'string' && a.startsWith(prefix));
  return values.length ? values[values.length - 1].slice(prefix.length) : '';
}

// Ask CMAKE what a toolchain file's CMAKE_AR/CMAKE_RANLIB evaluate to, by include()ing that
// exact file in `cmake -P` script mode and printing them.
//
// NOT A TEXT PARSE, on purpose. scripts/netbsd.toolchain.cmake DISCOVERS its cross triple
// with file(GLOB) over the tooldir plus two regex substitutions, and then builds
// `${_tooldir}/bin/${_triple}-ar` from it; scripts/darwin-ppc/-x64/-x86 and
// scripts/linux-*.toolchain.cmake do the same with a literal triple. A grep for `set(CMAKE_AR`
// would have to reimplement cmake's variable expansion and would drift from it the first time
// a toolchain file changed shape. Handing the file to cmake cannot drift: it is the same file
// and the same interpreter the real configure uses.
//
// Returns { ar, ranlib } or null when the file will not evaluate (a toolchain file whose
// required environment is absent FATAL_ERRORs by design -- see netbsd's CLODE_NETBSD_TOOLDIR
// check -- and that is a legitimate "cannot answer", not a crash).
function archiversFromToolchainFile(toolchainFile, {
  execFileSyncFn = execFileSync, mkdtempFn = defaultMkdtemp, env = process.env,
} = {}) {
  if (!toolchainFile) return null;
  const dir = mkdtempFn('clode-ar-toolchain-');
  try {
    const script = path.join(dir, 'resolve-ar.cmake');
    const answer = path.join(dir, 'answer.txt');
    // cmake path literals are '/'-separated on every platform, including Windows.
    const asCmakePath = String(toolchainFile).split(path.sep).join('/');
    const asAnswerPath = answer.split(path.sep).join('/');
    // file(WRITE), not message(): in script mode message() goes to STDERR, which
    // execFileSync does not return, and reaching for a stderr-capturing spawn here would make
    // the seam this function is injected through platform- and API-specific for no gain. A
    // file is the same answer through a channel that cannot be swallowed.
    fs.writeFileSync(script, `include("${asCmakePath}")\n`
      + `file(WRITE "${asAnswerPath}" "CLODE_AR=\${CMAKE_AR}\nCLODE_RANLIB=\${CMAKE_RANLIB}\n")\n`);
    execFileSyncFn('cmake', ['-P', script], { encoding: 'utf8', stdio: 'ignore', env });
    const text = fs.readFileSync(answer, 'utf8');
    const grab = (key) => {
      const m = text.split('\n').reverse().find((l) => l.trim().startsWith(`${key}=`));
      return m ? m.trim().slice(key.length + 1).trim() : '';
    };
    const ar = grab('CLODE_AR');
    if (!ar) return null;
    return { ar, ranlib: grab('CLODE_RANLIB') };
  } catch {
    return null;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// The stderr of `cmake -P` is what carries message(); execFileSync only returns stdout, so
// the toolchain resolver above needs both. This wrapper is the injection point tests replace.
function defaultMkdtemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// WHICH archiver, in the order of decreasing certainty, with the source NAMED so the log can
// say how sure it is:
//
//   cmake-args    the build itself passed -DCMAKE_AR: certain
//   toolchain-file  cmake evaluated the very file the configure will load: certain
//   path-after-toolchain-file-failed  there IS a toolchain file but it would not evaluate
//   path          nothing names one, so cmake will search: this is the assumption (see below)
//
// THE HONEST LIMIT OF THE LAST ONE. On a native leg nothing passes -DCMAKE_AR and there is no
// toolchain file, so cmake runs its own CMakeFindBinUtils search, which can land on a
// compiler-relative or llvm- prefixed archiver rather than the first `ar` on PATH. This code
// probes `ar` off PATH and can therefore be probing a DIFFERENT binary than cmake will run.
// That is not papered over: arCacheMismatchWarning() compares the probed archiver against the
// CMAKE_AR cmake actually recorded in CMakeCache.txt after configuring, and the build prints
// a loud line when they disagree. Note the failure mode of a wrong guess is bounded either
// way, because the rules above use `<CMAKE_AR>`: the worst case is asking for a D that
// cmake's archiver rejects (a hard, immediate build failure, not a silent wrong artifact) or
// failing to ask for one it would have taken (today's behaviour).
function resolveArchivers({
  cmakeArgs = [], toolchainFile = '', env = process.env,
  findToolFn = findTool, toolchainResolver = archiversFromToolchainFile,
} = {}) {
  const explicitAr = archiverFromCmakeArgs(cmakeArgs, 'CMAKE_AR');
  if (explicitAr) {
    return {
      ar: explicitAr,
      ranlib: archiverFromCmakeArgs(cmakeArgs, 'CMAKE_RANLIB') || onPath('ranlib'),
      source: 'cmake-args',
    };
  }
  if (toolchainFile) {
    const fromFile = toolchainResolver(toolchainFile, { env });
    if (fromFile && fromFile.ar) {
      return { ar: fromFile.ar, ranlib: fromFile.ranlib || onPath('ranlib'), source: 'toolchain-file' };
    }
    return { ar: onPath('ar'), ranlib: onPath('ranlib'), source: 'path-after-toolchain-file-failed' };
  }
  return { ar: onPath('ar'), ranlib: onPath('ranlib'), source: 'path' };

  function onPath(name) { return findToolFn(name, { env }) || name; }
}

// THE PROBE. It RUNS the tools -- there is no other honest way to know, since the answer
// turns on a configure flag chosen by whoever packaged binutils, which no version string
// reports. Cheap: two exec calls over a five-line text file, no compiler needed (`ar` does
// not care what a member contains, and both GNU and cctools `ranlib` accept an archive with
// no symbols).
//
// Three outcomes per tool, because "refused the flag" and "could not be run at all" must not
// collapse: an MSVC leg's CMAKE_AR is lib.exe, which is not an `ar` in any sense, and the
// right answer there is to change NOTHING rather than to reach for a lever it has never
// heard of. Short-circuits after `ar`: once the archiver refuses D, nothing ranlib says can
// change the outcome, and probing it anyway would be two states pretending to be four.
function probeDeterministicArchiver({
  ar = 'ar', ranlib = 'ranlib', execFileSyncFn = execFileSync, mkdtempFn = defaultMkdtemp,
} = {}) {
  const dir = mkdtempFn('clode-ar-probe-');
  const quiet = { stdio: 'ignore' };
  try {
    const member = path.join(dir, 'member.txt');
    fs.writeFileSync(member, 'clode ar determinism probe\n');
    const archive = path.join(dir, 'probe.a');
    try {
      execFileSyncFn(ar, ['qcD', archive, member], quiet);
    } catch (e) {
      return { ar: e && e.code === 'ENOENT' ? 'unavailable' : 'rejected', ranlib: 'unprobed' };
    }
    // Exit 0 is not quite enough on its own: an archiver that shrugged at an unknown modifier
    // without writing anything would look like success. The artifact has to exist.
    if (!fs.existsSync(archive)) return { ar: 'rejected', ranlib: 'unprobed' };
    try {
      execFileSyncFn(ranlib, ['-D', archive], quiet);
    } catch (e) {
      return { ar: 'accepted', ranlib: e && e.code === 'ENOENT' ? 'unavailable' : 'rejected' };
    }
    return { ar: 'accepted', ranlib: 'accepted' };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// ---- the decision, as ONE value: what happened, what cmake gets, and enough to say why ----
//
//   flags         both tools take D  -> CREATE + APPEND + FINISH, the measured-identical combo
//   partial       ar takes D, ranlib does not -> CREATE + APPEND, and a line that says this is
//                 NOT known to be enough (measured: that combination DIFFERS). Not folded into
//                 either neighbour, because a silent partial fix is the defect being closed.
//   zero-ar-date  ar refuses D -> nothing added; ZERO_AR_DATE=1 is the cctools lever
//   unavailable   ar cannot be run at all (lib.exe, or no archiver) -> nothing added
//   opted-out     CLODE_TJS_AR_DETERMINISM=0 -> nothing added, and NO tool is run
//
// THE NEGATIVE PROPERTY, same as ccache's and equally load-bearing: every state except
// `flags` and `partial` must leave the cmake argument list byte-identical to its pre-feature
// self. There is no clearing flag here (unlike ccache's empty -D): these rules are cmake's
// own defaults when unset, so a build dir configured once WITH them and then reconfigured by
// an opted-out run would keep them -- which is why the opt-out is documented as "for a fresh
// build dir", and why the log line is printed on every configure rather than only when it
// changes something.
function arDeterminismDecision({
  ar = 'ar', ranlib = 'ranlib', source = 'path', env = process.env,
  probeFn = probeDeterministicArchiver,
} = {}) {
  if (arDeterminismOptedOut(env)) {
    return { state: 'opted-out', ar, ranlib, source, probe: null, flags: [] };
  }
  const probe = probeFn({ ar, ranlib });
  const base = { ar, ranlib, source, probe };
  if (probe.ar === 'unavailable') return { ...base, state: 'unavailable', flags: [] };
  if (probe.ar !== 'accepted') return { ...base, state: 'zero-ar-date', flags: [] };
  const flags = [
    `-DCMAKE_C_ARCHIVE_CREATE=${C_ARCHIVE_CREATE_D}`,
    `-DCMAKE_C_ARCHIVE_APPEND=${C_ARCHIVE_APPEND_D}`,
  ];
  if (probe.ranlib !== 'accepted') return { ...base, state: 'partial', flags };
  flags.push(`-DCMAKE_C_ARCHIVE_FINISH=${C_ARCHIVE_FINISH_D}`);
  return { ...base, state: 'flags', flags };
}

// The ONE line scripts/build-tjs.cjs prints on every configure, whichever way the decision
// went. The lesson this copies is c2067a0's: a build decision nobody can see from the log
// hides for an unknown number of runs -- the ccache launcher was live on a Windows RELEASE
// leg for an unknown time because nothing printed it. This one was hidden worse: twelve
// NetBSD legs shipped non-reproducible archives and no log line anywhere was even wrong.
//
// PLAIN ASCII and a fixed `build-tjs: ar-determinism: ` prefix: asserted exactly in
// test/ar-determinism.test.cjs, because CI logs get grepped for it and the Windows console
// mangles anything else.
function describeArDeterminismDecision(decision) {
  const { state, ar, ranlib, source } = decision || {};
  if (state === 'flags') {
    return `build-tjs: ar-determinism: FLAGS ar=${ar} ranlib=${ranlib} source=${source} `
      + '(both accept the deterministic flag; cmake archive rules get qcD/qD and ranlib -D)';
  }
  if (state === 'partial') {
    return `build-tjs: ar-determinism: PARTIAL ar=${ar} ranlib=${ranlib} source=${source} `
      + '(ar accepts D but ranlib refuses -D, so the symbol index is re-stamped after the '
      + 'archive is written and these archives may still be nondeterministic)';
  }
  if (state === 'zero-ar-date') {
    return `build-tjs: ar-determinism: ZERO_AR_DATE ar=${ar} source=${source} `
      + '(ar rejects the D modifier; ZERO_AR_DATE=1 is this toolchain\'s lever)';
  }
  if (state === 'unavailable') {
    return `build-tjs: ar-determinism: NONE ar=${ar} source=${source} `
      + '(could not run it, so no archive rules were changed)';
  }
  if (state === 'opted-out') {
    return 'build-tjs: ar-determinism: NONE (opted out: CLODE_TJS_AR_DETERMINISM=0)';
  }
  throw new Error(`unknown ar-determinism state '${state}' — describeArDeterminismDecision must `
    + 'be taught every state arDeterminismDecision can return, or a build silently logs nothing '
    + 'about a decision that changes whether its archives are reproducible');
}

// The call site's single move, so the decision that was LOGGED is the decision that is
// APPLIED (recomputing would let the log and the command line disagree -- the class of
// defect this whole change is about).
function applyArDeterminismDecision(cmakeArgs, decision) {
  for (const f of (decision && decision.flags) || []) cmakeArgs.push(f);
  return cmakeArgs;
}

// ---- after the configure: did cmake agree with the archiver this probed? ---------------
//
// Pure. '' when they agree or when there is nothing to compare, otherwise the loud line. The
// comparison is by BASENAME without an .exe suffix, the same normalisation
// ccache-launcher.cjs uses for compilers: `/usr/bin/ar` and `ar` are the same fact, while
// `ar` and `llvm-ar` are not. This exists because the native (source=path) branch is the one
// step of the resolution that is an assumption rather than a reading, and an assumption this
// repo can check cheaply is one it should print rather than document.
function arCacheMismatchWarning({ decision, cacheAr } = {}) {
  if (!decision || !cacheAr) return '';
  const norm = (p) => String(p || '').split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
  if (norm(decision.ar) === norm(cacheAr)) return '';
  return `build-tjs: ar-determinism: WARNING probed ${decision.ar} but cmake chose ${cacheAr} `
    + `(state=${decision.state} source=${decision.source}) -- the archive-rule decision was `
    + 'made about a different program than the build will run; re-derive it from CMAKE_AR';
}

// Reads CMAKE_AR back out of a configured build dir. Returns '' when there is no cache yet
// (the first configure of a fresh dir writes it, so the caller checks AFTER configuring).
function cmakeCacheAr(buildDir, { fsm = fs } = {}) {
  try {
    const text = fsm.readFileSync(path.join(buildDir, 'CMakeCache.txt'), 'utf8');
    const line = text.split('\n').find((l) => l.startsWith('CMAKE_AR:'));
    return line ? line.slice(line.indexOf('=') + 1).trim() : '';
  } catch {
    return '';
  }
}

module.exports = {
  C_ARCHIVE_CREATE_D, C_ARCHIVE_APPEND_D, C_ARCHIVE_FINISH_D,
  arDeterminismOptedOut, archiverFromCmakeArgs, archiversFromToolchainFile, resolveArchivers,
  probeDeterministicArchiver, arDeterminismDecision, describeArDeterminismDecision,
  applyArDeterminismDecision, arCacheMismatchWarning, cmakeCacheAr,
};
