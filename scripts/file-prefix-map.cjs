'use strict';
// BUILD-PATH INDEPENDENCE — make the absolute path a build ran from stop appearing in the
// engine it produces, decided by probing the compiler the build will actually run.
//
// THE MEASURED PROBLEM. As of 2026-09-20 the engine was byte-reproducible only when built
// from an IDENTICAL ABSOLUTE PATH. Two runs of test/repro-double-build.cjs differing solely
// in their mkdtemp suffix -- same length, different characters -- produced 559224b9... and
// 5901f0fe..., and moving CLODE_TJS_OUT/CLODE_TJS_BUILD between two otherwise-identical
// builds changed 47 of 372 objects and the linked size (5,464,448 -> 5,466,496). The
// darwin-arm64 verdict therefore carried a caveat: "reproducible AT A FIXED BUILD PATH".
//
// That is enough for the property a cache threatens (same host, same place, twice), and it
// forecloses the stronger one: DIFFERENT MACHINE, SAME BYTES, which is what a
// rebuild-and-verify attestation would have to rest on. Two builds on two machines never
// share a build directory, so a verdict conditional on the build directory cannot travel.
//
// THE LEVER is reproducible-builds.org's: -ffile-prefix-map=OLD=NEW rewrites the path in
// BOTH the debug info and the preprocessor's __FILE__, so an object stops recording where
// it was compiled. Supported by gcc >= 8 and by clang; the older halves are
// -fdebug-prefix-map (gcc >= 4.3, debug info only) and -fmacro-prefix-map (gcc >= 8,
// __FILE__ only), and taking one without the other is the silent partial fix this repo
// keeps finding. It appeared NOWHERE here before this file.
//
// CAPABILITY PROBE, NOT A PLATFORM BRANCH -- house doctrine, and load-bearing rather than
// stylistic. This repo compiles the engine with Apple clang, six vintages of GNU gcc across
// eleven operating systems, MSVC cl, cosmocc and a NetBSD cross-toolchain built from source
// during the job. Whether a given one of those takes this flag turns on its version AND its
// vendor AND its driver mode, which no platform token reports. So: run it and ask.
//
// FIVE OUTCOMES, deliberately not three: "refused the flag", "refused BOTH spellings" and
// "could not be run at all" have different consequences, and an MSVC leg must land in a
// state that changes NOTHING rather than reaching for a lever it has never heard of.
//
//     file-prefix-map    cc takes -ffile-prefix-map        -> one flag per mapping
//     split-prefix-map   it takes the older PAIR instead   -> two flags per mapping
//     unsupported        it takes neither (this is cl)     -> nothing added
//     unavailable        it cannot be run at all           -> nothing added
//     opted-out          CLODE_TJS_FILE_PREFIX_MAP=0       -> nothing added, nothing run
//
// WHAT IS MAPPED, and what that costs. Two roots, to two fixed sentinels: the vendored
// source tree and the build directory. Mapping to a sentinel rather than to `.` is the
// reproducible-builds convention and it keeps __FILE__ ABSOLUTE, which matters because the
// only runtime reader of __FILE__ in this engine is txiki's assertion macro
// (src/utils.h:83) -- a relative path there would resolve against whatever directory the
// user happened to run quaude from. The visible cost is exactly that: an assertion failure
// now prints /clode/tjs/src/foo.c instead of a path on the build machine. Nothing in the
// engine OPENS a __FILE__ path, so nothing breaks; a build-machine path in a user-facing
// assertion was never useful to that user anyway.
//
// SHAPE: the same house pattern as scripts/ccache-launcher.cjs and
// scripts/ar-determinism.cjs -- pure decision functions plus injectable I/O seams, so a
// test can exercise every branch (including the ones this host cannot reach) without
// require()ing scripts/build-tjs.cjs, which runs a whole engine build the moment it loads.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { findTool } = require('../libexec/clode-hosttools.cjs');

// The two fixed destinations. Absolute (see the __FILE__ note above), distinct from each
// other (which tree a file came from is information worth keeping; the property wanted is
// that the path is FIXED, not that it is gone), and obviously not a real directory on any
// machine, so a path that leaks through the mapping is recognisable on sight.
const SOURCE_SENTINEL = '/clode/tjs';
const BUILD_SENTINEL = '/clode/build';

function filePrefixMapOptedOut(env = process.env) {
  return env.CLODE_TJS_FILE_PREFIX_MAP === '0';
}

// Pure. The compile flags for a kind and a list of [from, to] mappings.
//
// ORDER: the caller passes the BUILD mapping first. If a build directory is placed inside
// the source tree the two prefixes overlap, and gcc and clang do not agree on whether the
// first or the last match wins; most-specific-first is correct under the "first match" rule
// and harmless under the other, because the sentinels are distinct either way.
function prefixMapFlags(kind, mappings) {
  const out = [];
  for (const [from, to] of mappings || []) {
    if (kind === 'file-prefix-map') {
      out.push(`-ffile-prefix-map=${from}=${to}`);
    } else if (kind === 'split-prefix-map') {
      // BOTH halves, always. -fdebug-prefix-map alone leaves __FILE__ carrying the build
      // path; -fmacro-prefix-map alone leaves the debug info carrying it. Half of this is
      // a fix that reads as done and is not.
      out.push(`-fdebug-prefix-map=${from}=${to}`);
      out.push(`-fmacro-prefix-map=${from}=${to}`);
    } else {
      throw new Error(`prefixMapFlags: unknown kind '${kind}'`);
    }
  }
  return out;
}

// BOTH SPELLINGS OF EACH ROOT: the path as this build names it, and the path the operating
// system resolves it to.
//
// MEASURED 2026-09-20, and this is the whole reason the first attempt at this feature
// measured as a no-op on txiki's own 46 objects. On macOS /var is a symlink to /private/var;
// the compiler records DWARF's DW_AT_comp_dir from getcwd(), which resolves it, while
// build-tjs.cjs composes its build dir from CLODE_TJS_BUILD, which does not. Two different
// strings for one directory, and a prefix map only ever matches a string. The flag was
// present, accepted and logged, and rewrote nothing.
//
// PORTABLE, not a darwin branch: any host whose build path goes through a symlink -- a
// /home -> /usr/home BSD, an automounted network path, a container bind mount -- has the
// same shape, and asking the OS which is which costs one lstat.
//
// REALPATH FIRST, then the literal: they are different strings so order cannot change the
// outcome here, but it keeps the more-resolved form ahead of the less-resolved one, which
// is the direction any future nesting would want.
function expandMappings(pairs, { realpathFn = fs.realpathSync } = {}) {
  const out = [];
  const seen = new Set();
  for (const [from, to] of pairs || []) {
    let real = from;
    try { real = realpathFn(from); } catch { /* not created yet: the literal is all there is */ }
    for (const candidate of [real, from]) {
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      out.push([candidate, to]);
    }
  }
  return out;
}

function defaultMkdtemp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// THE PROBE. It COMPILES -- there is no other honest way to know, since the answer turns on
// the driver's own argument table. Cheap: one (at most two) compiles of a four-line file.
//
// -Werror is on the probe line deliberately: several drivers report an unrecognised -f
// argument as a WARNING and carry on, which would otherwise read as acceptance while the
// flag did nothing at all. With -Werror that warning is a non-zero exit, i.e. the same
// answer as a refusal, which is the answer that leads to the safe behaviour.
//
// Exit 0 is still not quite enough on its own -- a driver that shrugged without producing
// anything would look like success -- so the object has to EXIST. Same trap
// ar-determinism.cjs closes for `ar qcD`.
function probeFilePrefixMap({
  cc = 'cc', execFileSyncFn = execFileSync, mkdtempFn = defaultMkdtemp, existsFn = fs.existsSync,
} = {}) {
  const dir = mkdtempFn('clode-fpm-probe-');
  try {
    const src = path.join(dir, 'probe.c');
    fs.writeFileSync(src, 'int clode_file_prefix_map_probe(void) { return 0; }\n');
    const mapping = [[dir, '/clode/probe']];
    let sawEnoent = false;
    for (const kind of ['file-prefix-map', 'split-prefix-map']) {
      const obj = path.join(dir, `${kind}.o`);
      try {
        execFileSyncFn(cc, [...prefixMapFlags(kind, mapping), '-Werror', '-c', src, '-o', obj],
          { stdio: 'ignore' });
      } catch (e) {
        if (e && e.code === 'ENOENT') sawEnoent = true;
        continue;
      }
      if (existsFn(obj)) return kind;
    }
    return sawEnoent ? 'unavailable' : 'unsupported';
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// ---- WHICH compiler to probe ------------------------------------------------------------
//
// Same four-way resolution, and the same honest limit, as scripts/ar-determinism.cjs's
// resolveArchivers: `cmake-args` and `toolchain-file` are readings, `path` is an assumption,
// and the assumption is CHECKED after the configure against what cmake actually recorded
// (cacheMismatchWarning below) rather than merely documented.
//
// Unlike the archiver case, a wrong guess here is not bounded to a hard build failure: a
// compiler that would have taken the flag but was not probed simply keeps baking paths in,
// silently. That is why the mismatch warning exists and why the log line names its source.
function compilerFromToolchainFile(toolchainFile, {
  execFileSyncFn = execFileSync, mkdtempFn = defaultMkdtemp, env = process.env,
} = {}) {
  if (!toolchainFile) return null;
  const dir = mkdtempFn('clode-fpm-toolchain-');
  try {
    const script = path.join(dir, 'resolve-cc.cmake');
    const answer = path.join(dir, 'answer.txt');
    const asCmakePath = String(toolchainFile).split(path.sep).join('/');
    const asAnswerPath = answer.split(path.sep).join('/');
    fs.writeFileSync(script, `include("${asCmakePath}")\n`
      + `file(WRITE "${asAnswerPath}" "CLODE_CC=\${CMAKE_C_COMPILER}\n")\n`);
    execFileSyncFn('cmake', ['-P', script], { encoding: 'utf8', stdio: 'ignore', env });
    const text = fs.readFileSync(answer, 'utf8');
    const line = text.split('\n').reverse().find((l) => l.trim().startsWith('CLODE_CC='));
    const cc = line ? line.trim().slice('CLODE_CC='.length).trim() : '';
    return cc ? { cc } : null;
  } catch {
    return null;
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function resolveCompiler({
  cmakeArgs = [], toolchainFile = '', env = process.env,
  findToolFn = findTool, toolchainResolver = compilerFromToolchainFile,
} = {}) {
  const prefix = '-DCMAKE_C_COMPILER=';
  const explicit = (cmakeArgs || []).filter((a) => typeof a === 'string' && a.startsWith(prefix));
  if (explicit.length) {
    return { cc: explicit[explicit.length - 1].slice(prefix.length), source: 'cmake-args' };
  }
  if (toolchainFile) {
    const fromFile = toolchainResolver(toolchainFile, { env });
    if (fromFile && fromFile.cc) return { cc: fromFile.cc, source: 'toolchain-file' };
    return { cc: findToolFn('cc', { env }) || 'cc', source: 'path-after-toolchain-file-failed' };
  }
  return { cc: findToolFn('cc', { env }) || 'cc', source: 'path' };
}

// ---- the decision, as ONE value ---------------------------------------------------------
//
// THE NEGATIVE PROPERTY, same as ccache's and ar-determinism's: every state except
// file-prefix-map and split-prefix-map must leave the cmake argument list byte-identical to
// its pre-feature self. There is no clearing flag: the flags ride inside CMAKE_C_FLAGS,
// which build-tjs.cjs passes explicitly on every configure, so a build dir configured once
// WITH them and reconfigured by an opted-out run gets the opted-out value.
function filePrefixMapDecision({
  cc = 'cc', source = 'path', mappings = [], env = process.env, probeFn = probeFilePrefixMap,
} = {}) {
  if (filePrefixMapOptedOut(env)) {
    return { state: 'opted-out', cc, source, mappings, flags: [] };
  }
  const state = probeFn({ cc });
  const base = { state, cc, source, mappings };
  if (state === 'file-prefix-map' || state === 'split-prefix-map') {
    return { ...base, flags: prefixMapFlags(state, mappings) };
  }
  return { ...base, flags: [] };
}

// The ONE line scripts/build-tjs.cjs prints on every configure, whichever way it went.
// PLAIN ASCII and a fixed `build-tjs: file-prefix-map: ` prefix, asserted exactly in
// test/file-prefix-map.test.cjs: CI logs get grepped for it, and the Windows console
// mangles anything else.
//
// A STATE THIS FUNCTION DOES NOT KNOW IS AN ERROR, not an empty string. A blank line reads
// as "no decision was made", which is the failure mode the whole log-the-decision pattern
// exists to prevent, and it would be introduced by the most likely future edit.
function describeFilePrefixMapDecision(decision) {
  const { state, cc, source, mappings } = decision || {};
  const where = `cc=${cc} source=${source}`;
  const maps = (mappings || []).map(([from, to]) => `${from}=${to}`).join(' ');
  if (state === 'file-prefix-map') {
    return `build-tjs: file-prefix-map: FILE ${where} (-ffile-prefix-map accepted; ${maps})`;
  }
  if (state === 'split-prefix-map') {
    return `build-tjs: file-prefix-map: SPLIT ${where} (-ffile-prefix-map refused, the older `
      + `-fdebug-prefix-map/-fmacro-prefix-map pair accepted; ${maps})`;
  }
  if (state === 'unsupported') {
    return `build-tjs: file-prefix-map: NONE ${where} (this compiler takes neither `
      + '-ffile-prefix-map nor the -fdebug-prefix-map/-fmacro-prefix-map pair, so the '
      + 'absolute build path stays baked into these objects and this leg is NOT '
      + 'path-independent. MSVC cl is the known case; its own lever is /PATHMAP plus '
      + 'link.exe /Brepro, neither of which this repo uses yet)';
  }
  if (state === 'unavailable') {
    return `build-tjs: file-prefix-map: NONE ${where} (could not run it, so no compile `
      + 'flags were changed)';
  }
  if (state === 'opted-out') {
    return 'build-tjs: file-prefix-map: NONE (opted out: CLODE_TJS_FILE_PREFIX_MAP=0)';
  }
  throw new Error(`unknown file-prefix-map state '${state}' — describeFilePrefixMapDecision `
    + 'must be taught every state filePrefixMapDecision can return, or a build silently logs '
    + 'nothing about a decision that changes whether its bytes depend on where it ran');
}

// The call site's single move, so the decision that was LOGGED is the decision that is
// APPLIED.
//
// INTO CMAKE_C_FLAGS, and appended to whatever is already there. That variable is the one
// place a flag reaches all nine add_subdirectory() projects (quickjs, mimalloc, libuv,
// sqlite3, wurl, miniz, mbedtls, libwebsockets, wamr) as well as txiki's own targets:
// cmake initialises each subdirectory's scope from it, and every subproject here that
// touches it APPENDS (`set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} ...")`) rather than replacing.
// A target_compile_options on `tjs` would have reached one project of ten. Reach is
// VERIFIED after the configure by scanning the generated build.ninja, not assumed -- the
// archive work found a cache-level setting reaching only 11 of 14 archives.
//
// The LAST -DCMAKE_C_FLAGS is the one extended, because that is the one cmake obeys.
function applyFilePrefixMapDecision(cmakeArgs, decision) {
  const flags = (decision && decision.flags) || [];
  if (flags.length === 0) return cmakeArgs;
  const prefix = '-DCMAKE_C_FLAGS=';
  let last = -1;
  for (let i = 0; i < cmakeArgs.length; i++) {
    if (typeof cmakeArgs[i] === 'string' && cmakeArgs[i].startsWith(prefix)) last = i;
  }
  if (last === -1) {
    cmakeArgs.push(prefix + flags.join(' '));
  } else {
    cmakeArgs[last] = `${cmakeArgs[last]} ${flags.join(' ')}`;
  }
  return cmakeArgs;
}

// ---- after the configure: did cmake agree with the compiler this probed? -----------------
//
// Pure. '' when they agree or there is nothing to compare, otherwise the loud line. Compared
// by basename without .exe, the same normalisation ccache-launcher.cjs uses: `/usr/bin/cc`
// and `cc` are the same fact, `cc` and `clang` are not.
function ccCacheMismatchWarning({ decision, cacheCc } = {}) {
  if (!decision || !cacheCc) return '';
  const norm = (p) => String(p || '').split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
  if (norm(decision.cc) === norm(cacheCc)) return '';
  return `build-tjs: file-prefix-map: WARNING probed ${decision.cc} but cmake chose ${cacheCc} `
    + `(state=${decision.state} source=${decision.source}) -- the path-mapping decision was `
    + 'made about a different program than the build will run';
}

function cmakeCacheCc(buildDir, { fsm = fs } = {}) {
  try {
    const text = fsm.readFileSync(path.join(buildDir, 'CMakeCache.txt'), 'utf8');
    const line = text.split('\n').find((l) => l.startsWith('CMAKE_C_COMPILER:'));
    return line ? line.slice(line.indexOf('=') + 1).trim() : '';
  } catch {
    return '';
  }
}

module.exports = {
  SOURCE_SENTINEL, BUILD_SENTINEL,
  filePrefixMapOptedOut, prefixMapFlags, expandMappings, probeFilePrefixMap,
  compilerFromToolchainFile, resolveCompiler,
  filePrefixMapDecision, describeFilePrefixMapDecision, applyFilePrefixMapDecision,
  ccCacheMismatchWarning, cmakeCacheCc,
};
