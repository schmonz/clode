'use strict';
// The build-path-independence lever, and the five outcomes of probing for it.
//
// THE MEASURED PROBLEM THIS SERVES. The engine was byte-reproducible only when built from
// an IDENTICAL ABSOLUTE PATH: two runs of test/repro-double-build.cjs differing solely in
// their mkdtemp suffix (same length, different characters) produced different engines, and
// moving the build path between two otherwise-identical builds changed 47 of 372 objects.
// Absolute paths are baked into the objects. `-ffile-prefix-map` is the reproducible-builds
// lever for exactly that and appeared NOWHERE in this repo.
//
// EVERY BRANCH IS EXERCISED HERE, including the ones this host cannot reach — same shape as
// test/ar-determinism.test.cjs, and for the same reason: the compiler that needs the OTHER
// answer (MSVC's cl, which has /PATHMAP and no -ffile-prefix-map) is on a leg with no
// hardware here.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  SOURCE_SENTINEL, BUILD_SENTINEL,
  filePrefixMapOptedOut, prefixMapFlags, probeFilePrefixMap, filePrefixMapDecision,
  describeFilePrefixMapDecision, applyFilePrefixMapDecision, resolveCompiler, expandMappings,
  probeOsoPrefix, osoPrefixDecision, describeOsoPrefixDecision, applyOsoPrefixDecision,
} = require('../scripts/file-prefix-map.cjs');
const { defineGuard, guardTests } = require('./guard.cjs');

const MAPPINGS = [['/tmp/b/build', BUILD_SENTINEL], ['/tmp/b/src', SOURCE_SENTINEL]];

// ---- the flags themselves ---------------------------------------------------------------

test('the modern spelling is ONE flag per mapping', () => {
  assert.deepStrictEqual(prefixMapFlags('file-prefix-map', MAPPINGS), [
    `-ffile-prefix-map=/tmp/b/build=${BUILD_SENTINEL}`,
    `-ffile-prefix-map=/tmp/b/src=${SOURCE_SENTINEL}`,
  ]);
});

test('the split spelling covers BOTH halves, or it covers neither', () => {
  // -fdebug-prefix-map alone remaps debug info and leaves __FILE__ alone; -fmacro-prefix-map
  // alone does the reverse. A toolchain too old for -ffile-prefix-map needs the pair, and
  // half of it is the silent partial fix this repo keeps finding.
  const flags = prefixMapFlags('split-prefix-map', MAPPINGS);
  assert.deepStrictEqual(flags, [
    `-fdebug-prefix-map=/tmp/b/build=${BUILD_SENTINEL}`,
    `-fmacro-prefix-map=/tmp/b/build=${BUILD_SENTINEL}`,
    `-fdebug-prefix-map=/tmp/b/src=${SOURCE_SENTINEL}`,
    `-fmacro-prefix-map=/tmp/b/src=${SOURCE_SENTINEL}`,
  ]);
});

test('the BUILD mapping is emitted before the SOURCE mapping', () => {
  // Not cosmetic. If a caller puts the build dir INSIDE the source tree the two prefixes
  // overlap, and gcc and clang do not agree on whether the first or the last match wins.
  // Ordering most-specific-first makes the nested case right under the "first match" rule
  // and harmless under the other, because the two sentinels are distinct either way.
  const [first] = prefixMapFlags('file-prefix-map', MAPPINGS);
  assert.match(first, /\/build=/);
});

test('sentinels are absolute and obviously not a real path', () => {
  for (const s of [SOURCE_SENTINEL, BUILD_SENTINEL]) {
    assert.match(s, /^\//, 'a relative sentinel would make __FILE__ resolve against the CWD '
      + 'of whoever later reads an assertion message');
  }
  assert.notStrictEqual(SOURCE_SENTINEL, BUILD_SENTINEL,
    'collapsing both roots to one sentinel throws away which tree a file came from, for '
    + 'nothing — the property wanted is that the path is FIXED, not that it is absent');
});

// ---- the probe: five outcomes, and the two this host cannot reach are still exercised ----

test('the probe RUNS the compiler rather than reading its version', () => {
  // Whether a toolchain takes this flag turns on its version AND its vendor AND, for
  // clang-cl, its driver mode. The repo's standing answer to that shape is to run the tool.
  const seen = [];
  const r = probeFilePrefixMap({
    cc: 'cc',
    execFileSyncFn: (bin, args) => { seen.push([bin, args]); },
    mkdtempFn: () => fs.mkdtempSync(path.join(os.tmpdir(), 'fpm-probe-test-')),
    existsFn: () => true,
  });
  assert.strictEqual(r, 'file-prefix-map');
  assert.strictEqual(seen.length, 1, 'the modern spelling worked, so nothing else is tried');
  assert.ok(seen[0][1].some((a) => a.startsWith('-ffile-prefix-map=')));
});

test('a compiler that refuses the modern spelling falls back to the split pair', () => {
  const r = probeFilePrefixMap({
    cc: 'cc',
    execFileSyncFn: (bin, args) => {
      if (args.some((a) => a.startsWith('-ffile-prefix-map='))) throw new Error('unknown argument');
    },
    mkdtempFn: () => fs.mkdtempSync(path.join(os.tmpdir(), 'fpm-probe-test-')),
    existsFn: () => true,
  });
  assert.strictEqual(r, 'split-prefix-map');
});

test('a compiler that refuses BOTH is unsupported, not silently "fine"', () => {
  // This is cl.exe. It has /PATHMAP and neither of these, and the honest answer is to
  // change nothing and SAY the leg is uncovered.
  const r = probeFilePrefixMap({
    cc: 'cl',
    execFileSyncFn: () => { throw new Error('unknown option'); },
    mkdtempFn: () => fs.mkdtempSync(path.join(os.tmpdir(), 'fpm-probe-test-')),
    existsFn: () => true,
  });
  assert.strictEqual(r, 'unsupported');
});

test('a compiler that cannot be RUN AT ALL is a different answer from one that refused', () => {
  const enoent = Object.assign(new Error('nope'), { code: 'ENOENT' });
  const r = probeFilePrefixMap({
    cc: 'no-such-cc',
    execFileSyncFn: () => { throw enoent; },
    mkdtempFn: () => fs.mkdtempSync(path.join(os.tmpdir(), 'fpm-probe-test-')),
    existsFn: () => true,
  });
  assert.strictEqual(r, 'unavailable');
});

test('exit 0 is not enough — the object has to exist', () => {
  // A driver that shrugged at an unknown flag without compiling would otherwise look like
  // success. Same trap ar-determinism.cjs closes for `ar qcD`.
  const r = probeFilePrefixMap({
    cc: 'cc',
    execFileSyncFn: () => {},
    mkdtempFn: () => fs.mkdtempSync(path.join(os.tmpdir(), 'fpm-probe-test-')),
    existsFn: () => false,
  });
  assert.strictEqual(r, 'unsupported');
});

test('THE REAL COMPILER ON THIS HOST takes the modern spelling', () => {
  // The one un-mocked probe: the point of a capability probe is that it answers about the
  // tool that is actually here.
  assert.strictEqual(probeFilePrefixMap({ cc: process.env.CC || 'cc' }), 'file-prefix-map');
});

// ---- the decision, and the negative property every non-acting state owes ----------------

test('opting out runs NO tool and changes NO argument', () => {
  let ran = false;
  const d = filePrefixMapDecision({
    cc: 'cc', mappings: MAPPINGS, env: { CLODE_TJS_FILE_PREFIX_MAP: '0' },
    probeFn: () => { ran = true; return 'file-prefix-map'; },
  });
  assert.strictEqual(d.state, 'opted-out');
  assert.strictEqual(ran, false, 'an opt-out that still probes is a probe nobody asked for');
  assert.deepStrictEqual(d.flags, []);
});

for (const state of ['unsupported', 'unavailable', 'opted-out']) {
  test(`a '${state}' decision leaves cmakeArgs BYTE-IDENTICAL to its pre-feature self`, () => {
    const env = state === 'opted-out' ? { CLODE_TJS_FILE_PREFIX_MAP: '0' } : {};
    const d = filePrefixMapDecision({ cc: 'cc', mappings: MAPPINGS, env, probeFn: () => state });
    const before = ['-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_C_FLAGS=-Wno-error=unused-variable'];
    const after = applyFilePrefixMapDecision([...before], d);
    assert.deepStrictEqual(after, before,
      'a leg this feature cannot help must build exactly the command line it built before');
  });
}

// ---- REACH: the flags must land where every subproject inherits them --------------------

test('the flags go into CMAKE_C_FLAGS, APPENDED to whatever is already there', () => {
  // WHY CMAKE_C_FLAGS AND NOT A TARGET PROPERTY. The engine is nine add_subdirectory()
  // projects (quickjs, mimalloc, libuv, sqlite3, wurl, miniz, mbedtls, libwebsockets, wamr)
  // plus txiki's own targets. CMAKE_C_FLAGS is a directory-scope variable every one of them
  // inherits; a target_compile_options on `tjs` would reach one of ten. The archive work
  // found that a cache-level setting reached only 11 of 14 archives, so reach is VERIFIED
  // (test/repro-double-build's build.ninja scan) rather than assumed — but it starts by
  // being asked for in the one place that can carry it.
  const d = filePrefixMapDecision({ cc: 'cc', mappings: MAPPINGS, env: {}, probeFn: () => 'file-prefix-map' });
  const args = applyFilePrefixMapDecision(
    ['-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_C_FLAGS=-Wno-error=unused-variable'], d);
  const flags = args.filter((a) => a.startsWith('-DCMAKE_C_FLAGS='));
  assert.strictEqual(flags.length, 1, 'a SECOND -DCMAKE_C_FLAGS would silently drop the first');
  assert.match(flags[0], /-Wno-error=unused-variable/, 'the existing demotions must survive');
  assert.match(flags[0], /-ffile-prefix-map=/);
});

test('with no existing CMAKE_C_FLAGS it creates one', () => {
  const d = filePrefixMapDecision({ cc: 'cc', mappings: MAPPINGS, env: {}, probeFn: () => 'file-prefix-map' });
  const args = applyFilePrefixMapDecision(['-DCMAKE_BUILD_TYPE=Release'], d);
  assert.strictEqual(args.filter((a) => a.startsWith('-DCMAKE_C_FLAGS=')).length, 1);
});

test('and it appends to the LAST -DCMAKE_C_FLAGS, which is the one cmake obeys', () => {
  const d = filePrefixMapDecision({ cc: 'cc', mappings: MAPPINGS, env: {}, probeFn: () => 'file-prefix-map' });
  const args = applyFilePrefixMapDecision(['-DCMAKE_C_FLAGS=-first', '-DCMAKE_C_FLAGS=-second'], d);
  assert.strictEqual(args[0], '-DCMAKE_C_FLAGS=-first', 'the ignored one is left alone');
  assert.match(args[1], /^-DCMAKE_C_FLAGS=-second -ffile-prefix-map=/);
});

// ---- the log line, asserted exactly, because CI logs get grepped for it ------------------

test('every state prints one greppable ASCII line in the house prefix', () => {
  for (const state of ['file-prefix-map', 'split-prefix-map', 'unsupported', 'unavailable']) {
    const d = filePrefixMapDecision({ cc: 'cc', mappings: MAPPINGS, env: {}, probeFn: () => state });
    const line = describeFilePrefixMapDecision(d);
    assert.match(line, /^build-tjs: file-prefix-map: /,
      'same prefix shape as `build-tjs: ccache:` and `build-tjs: ar-determinism:`');
    assert.doesNotMatch(line, /[^\x20-\x7e]/,
      'plain ASCII: the leg this line matters most on is the Windows one, whose console '
      + 'mangles UTF-8 punctuation');
    assert.ok(!/\n/.test(line), 'ONE line');
  }
});

test('the UNSUPPORTED line names the compiler and says the leg is not covered', () => {
  const d = filePrefixMapDecision({ cc: 'cl', source: 'cmake-args', mappings: MAPPINGS, env: {},
    probeFn: () => 'unsupported' });
  const line = describeFilePrefixMapDecision(d);
  assert.match(line, /NONE/);
  assert.match(line, /cl/);
  assert.match(line, /PATHMAP/,
    'the MSVC answer exists and is NOT this flag; a reader of that leg\'s log must be told '
    + 'which lever it would take rather than left thinking none exists');
});

test('an unknown state THROWS rather than logging a blank line', () => {
  assert.throws(() => describeFilePrefixMapDecision({ state: 'sideways' }), /unknown/,
    'a blank line reads as "no decision was made", which is the failure mode the whole '
    + 'log-the-decision pattern exists to prevent');
});

// ---- resolving WHICH compiler to probe ---------------------------------------------------

test('an explicitly passed -DCMAKE_C_COMPILER is the compiler, with certainty named', () => {
  const r = resolveCompiler({ cmakeArgs: ['-DCMAKE_C_COMPILER=gcc', '-DCMAKE_C_COMPILER=cl'] });
  assert.strictEqual(r.cc, 'cl', 'LAST wins, which is how cmake resolves a repeated -D');
  assert.strictEqual(r.source, 'cmake-args');
});

test('a cross leg resolves its compiler from the TOOLCHAIN FILE, not from PATH', () => {
  // The whole point on a cross leg: the host cc may take the flag while the target's does
  // not, or the reverse. ar-determinism.cjs learned this the same way.
  const r = resolveCompiler({
    toolchainFile: '/x/netbsd.toolchain.cmake',
    toolchainResolver: () => ({ cc: '/tool/bin/aarch64--netbsd-gcc' }),
  });
  assert.strictEqual(r.cc, '/tool/bin/aarch64--netbsd-gcc');
  assert.strictEqual(r.source, 'toolchain-file');
});

test('a toolchain file that will not evaluate is SAID, not silently treated as native', () => {
  const r = resolveCompiler({ toolchainFile: '/x/t.cmake', toolchainResolver: () => null,
    findToolFn: () => '/usr/bin/cc' });
  assert.strictEqual(r.source, 'path-after-toolchain-file-failed');
});

test('with nothing naming a compiler, the answer is PATH and the log says it is a guess', () => {
  const r = resolveCompiler({ findToolFn: () => '/usr/bin/cc' });
  assert.strictEqual(r.cc, '/usr/bin/cc');
  assert.strictEqual(r.source, 'path');
});

// ---- the build actually asks for it ------------------------------------------------------

test('scripts/file-prefix-map.cjs is ENGINE RECIPE SOURCE', async () => {
  // It decides what compiler flags the engine is built with. Edit it and the engine's bytes
  // change, so a cache keyed on the recipe must invalidate. Same argument that put
  // scripts/ccache-launcher.cjs and scripts/ar-determinism.cjs in the list.
  const { FILES } = await import('../scripts/engine-recipe.mjs');
  assert.ok(FILES.includes('scripts/file-prefix-map.cjs'),
    'a build-flag decision outside the recipe means the tjs cache can restore an engine '
    + 'built by a different recipe than the one in the tree');
});

// ---- THE /private FINDING: a mapping that matches the wrong spelling maps nothing --------
//
// MEASURED 2026-09-20, from the first path-perturbation run WITH the flag on. The source
// tree mapped correctly -- objects carried `/clode/tjs/src/version.c` -- and 46 of 372
// objects STILL differed, every one of them in txiki's own target, because each carried the
// build directory in full:
//
//     /private/var/folders/.../repro-double-build-P4Tg0c/build-root/out-.../build
//
// with a `/private` on the front. On macOS /var is a symlink to /private/var, and the
// compiler records DWARF's DW_AT_comp_dir from getcwd(), which resolves it. build-tjs.cjs
// composes its build dir from CLODE_TJS_BUILD, which is the /var spelling, so the prefix
// this repo asked to map and the prefix the compiler wrote down were different strings and
// the mapping matched nothing.
//
// Not a darwin quirk to branch on: any host with a symlinked build path (a /home ->
// /usr/home BSD, an automounted network path, a container bind mount) has the same shape.
// The portable answer is to map BOTH spellings.

test('each root is mapped under BOTH the given path and its resolved path', () => {
  const pairs = expandMappings([['/var/b', BUILD_SENTINEL], ['/var/s', SOURCE_SENTINEL]],
    { realpathFn: (p) => `/private${p}` });
  assert.deepStrictEqual(pairs, [
    ['/private/var/b', BUILD_SENTINEL], ['/var/b', BUILD_SENTINEL],
    ['/private/var/s', SOURCE_SENTINEL], ['/var/s', SOURCE_SENTINEL],
  ]);
});

test('a root whose real path IS its given path is mapped once, not twice', () => {
  const pairs = expandMappings([['/b', BUILD_SENTINEL]], { realpathFn: (p) => p });
  assert.deepStrictEqual(pairs, [['/b', BUILD_SENTINEL]]);
});

test('a root that cannot be resolved is still mapped under the name it has', () => {
  // The build dir is created before this runs, but a caller (or a future reordering) may
  // hand a path that does not exist yet. Dropping the mapping entirely would be the silent
  // failure; keeping the literal one is the behaviour before this fix.
  const pairs = expandMappings([['/nope', BUILD_SENTINEL]], {
    realpathFn: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); },
  });
  assert.deepStrictEqual(pairs, [['/nope', BUILD_SENTINEL]]);
});

// ---- THE LINKER'S OWN COPY OF THE PATHS -------------------------------------------------
//
// MEASURED 2026-09-20, the run after the /private fix: all 372 OBJECTS came back
// byte-identical across two different absolute paths, and the linked engine still differed
// -- 5,444,224 vs 5,445,264 bytes. The delta is in the symbol table (`strsize` 243,672 vs
// 244,688, +1016) and its cause is 46 N_OSO stabs, ld64's DEBUG MAP: with -g on (txiki's
// own CMakeLists adds it), the linker records the ABSOLUTE PATH of every object it read, so
// a longer build directory makes a longer binary. 46 entries times the 22-character
// difference between the two directory names is 1012 bytes, plus alignment.
//
// -ffile-prefix-map cannot reach this. It is a COMPILER flag and the objects were already
// clean; the paths are written by the linker, from its own command line. ld64's lever is
// `-oso_prefix <path>`, which STRIPS that prefix from the recorded names, leaving
// `CMakeFiles/tjs.dir/src/foo.c.o`. GNU ld does not record object paths in the first place
// and rejects the option, which is the correct outcome there: nothing to fix, nothing
// added.

test('the oso-prefix probe LINKS, because accepting a flag is not the same as needing it', () => {
  const seen = [];
  const r = probeOsoPrefix({
    cc: 'cc',
    execFileSyncFn: (bin, args) => { seen.push(args); },
    mkdtempFn: () => fs.mkdtempSync(path.join(os.tmpdir(), 'oso-probe-test-')),
    existsFn: () => true,
  });
  assert.strictEqual(r, 'oso-prefix');
  assert.ok(seen.some((a) => a.some((x) => /^-Wl,-oso_prefix,/.test(x))));
});

test('a linker that rejects it is unsupported, and nothing is added', () => {
  const r = probeOsoPrefix({
    cc: 'gcc', execFileSyncFn: () => { throw new Error('ld: unknown options'); },
    mkdtempFn: () => fs.mkdtempSync(path.join(os.tmpdir(), 'oso-probe-test-')),
    existsFn: () => true,
  });
  assert.strictEqual(r, 'unsupported');
  const d = osoPrefixDecision({ cc: 'gcc', prefix: '/b/', env: {}, probeFn: () => 'unsupported' });
  assert.deepStrictEqual(applyOsoPrefixDecision(['-DCMAKE_BUILD_TYPE=Release'], d),
    ['-DCMAKE_BUILD_TYPE=Release']);
});

test('a compiler driver that cannot be run at all is unavailable, not "rejected"', () => {
  const enoent = Object.assign(new Error('nope'), { code: 'ENOENT' });
  assert.strictEqual(probeOsoPrefix({
    cc: 'no-such-cc', execFileSyncFn: () => { throw enoent; },
    mkdtempFn: () => fs.mkdtempSync(path.join(os.tmpdir(), 'oso-probe-test-')),
    existsFn: () => true,
  }), 'unavailable');
});

test('THE REAL LINKER ON THIS HOST takes -oso_prefix', () => {
  assert.strictEqual(probeOsoPrefix({ cc: process.env.CC || 'cc' }), 'oso-prefix');
});

test('the prefix is RESOLVED, or it strips nothing while looking like it worked', () => {
  // Measured by hand on this host: `-Wl,-oso_prefix,/tmp/osotest/` was ACCEPTED, exited 0,
  // and left `OSO /private/tmp/osotest/m.o` untouched. The same /private trap as the
  // compiler mapping, with a worse failure mode -- ld64 does not complain about a prefix
  // that matches nothing.
  const d = osoPrefixDecision({ cc: 'cc', prefix: '/var/b', env: {},
    realpathFn: (p) => `/private${p}`, probeFn: () => 'oso-prefix' });
  assert.ok(d.flags.some((f) => f.includes('/private/var/b')), JSON.stringify(d.flags));
});

test('the prefix ends in a separator, so a sibling directory is not half-stripped', () => {
  const d = osoPrefixDecision({ cc: 'cc', prefix: '/b/build', env: {},
    realpathFn: (p) => p, probeFn: () => 'oso-prefix' });
  assert.ok(d.flags.every((f) => /\/$/.test(f)), JSON.stringify(d.flags));
});

test('it appends to CMAKE_EXE_LINKER_FLAGS without dropping the static leg\'s -static', () => {
  const d = osoPrefixDecision({ cc: 'cc', prefix: '/b/', env: {}, realpathFn: (p) => p,
    probeFn: () => 'oso-prefix' });
  const args = applyOsoPrefixDecision(['-DCMAKE_EXE_LINKER_FLAGS=-static'], d);
  assert.strictEqual(args.length, 1, 'a SECOND -DCMAKE_EXE_LINKER_FLAGS would drop the first');
  assert.match(args[0], /-static/);
  assert.match(args[0], /-oso_prefix/);
});

test('opting out of the compiler mapping opts out of the linker one too', () => {
  // One knob. Two levers for one property, and a build that maps its objects but not its
  // debug map is the partial fix in a new costume.
  let ran = false;
  const d = osoPrefixDecision({ cc: 'cc', prefix: '/b/', env: { CLODE_TJS_FILE_PREFIX_MAP: '0' },
    probeFn: () => { ran = true; return 'oso-prefix'; } });
  assert.strictEqual(d.state, 'opted-out');
  assert.strictEqual(ran, false);
  assert.deepStrictEqual(d.flags, []);
});

test('every oso-prefix state prints one greppable ASCII line', () => {
  for (const state of ['oso-prefix', 'unsupported', 'unavailable']) {
    const d = osoPrefixDecision({ cc: 'cc', prefix: '/b/', env: {}, realpathFn: (p) => p,
      probeFn: () => state });
    const line = describeOsoPrefixDecision(d);
    assert.match(line, /^build-tjs: oso-prefix: /);
    assert.doesNotMatch(line, /[^\x20-\x7e]/);
  }
  assert.throws(() => describeOsoPrefixDecision({ state: 'sideways' }), /unknown/);
});



// ---- A CMAKE TOOLCHAIN FILE DECLINES BOTH LEVERS ----------------------------------------
//
// THE REGRESSION THIS PINS, measured in CI run 35530707866 (2026-09-20). Creating a
// `-DCMAKE_C_FLAGS=` where the argv had none does not merely ADD a flag. cmake seeds the
// CMAKE_C_FLAGS *cache entry* from CMAKE_<LANG>_FLAGS_INIT only when that entry does not
// already exist, so a `-D` on the command line silently DISCARDS everything the toolchain
// file set through _INIT. Proved by hand with cmake 4.3.3, not inferred:
//
//     toolchain only          CMAKE_C_FLAGS=[-isystem /tmp/cosmo-compat -Wno-error=...]
//     + -DCMAKE_C_FLAGS=...   CMAKE_C_FLAGS=[-ffile-prefix-map=/a=/b]      <-- _INIT gone
//
// Every one of this repo's seven toolchain files delivers its ESSENTIALS that way, so the
// partition in that run was exact -- every leg with a toolchain file failed, every leg
// without one passed. cosmo lost `-isystem scripts/cosmo-compat` and died on a missing
// sys/syslog.h; netbsd-mips64eb lost `--sysroot` and compiled against the HOST's headers.
//
// THE THREE DARWIN LEGS HAD NOT FIRED YET -- they are not in the `ci` workflow. They lose
// `-mmacosx-version-min`, and if osxcross's ld64 takes -oso_prefix they lose it from the
// LINK line too. A dropped compat floor is the failure mode this repo cares most about,
// because it BUILDS GREEN and only fails on the old machine nobody in CI owns.
//
// So: when a toolchain file is in play, decline. Same escape hatch unsupported /
// unavailable / opted-out already take, and it leaves the argv byte-identical to its
// pre-feature self. The cost is that those legs keep baking the build path in -- which is
// what they did every day before this feature, and what test/repro-verdicts.cjs still
// records for all 40 of them (`unproven`). Broadening path-independence to cross legs means
// delivering the mapping through the configure's CFLAGS/LDFLAGS environment instead, which
// cmake APPENDS to _INIT rather than replacing; that reaches cmake's own try_compile probes
// too, so it is a separate piece of work and not this one.

const NETBSD_CROSS = '/w/scripts/netbsd.toolchain.cmake';

test('a toolchain file DECLINES the compiler mapping, and does not even probe', () => {
  let ran = false;
  const d = filePrefixMapDecision({
    cc: '/w/nbsd-tool/bin/mips64--netbsd-gcc', source: 'toolchain-file',
    crossFile: NETBSD_CROSS, mappings: MAPPINGS, env: {},
    probeFn: () => { ran = true; return 'file-prefix-map'; },
  });
  assert.strictEqual(d.state, 'cross-toolchain');
  assert.deepStrictEqual(d.flags, [],
    'the probe ACCEPTED -- the decline is about where the flag would have to ride, not '
    + 'about whether the compiler takes it');
  assert.strictEqual(ran, false,
    'a lever that is going to be declined must not pay for an answer it cannot use');
});

test('a toolchain file DECLINES the linker mapping too', () => {
  // One property, two levers: declining the compiler half and keeping the linker half
  // would still create a -DCMAKE_EXE_LINKER_FLAGS= and still take the darwin floor out of
  // the link line. That is the silent partial fix in a new costume.
  let ran = false;
  const d = osoPrefixDecision({
    cc: 'x86_64-apple-darwin10-cc', source: 'toolchain-file', crossFile: NETBSD_CROSS,
    prefix: '/b/build', env: {}, realpathFn: (p) => p,
    probeFn: () => { ran = true; return 'oso-prefix'; },
  });
  assert.strictEqual(d.state, 'cross-toolchain');
  assert.deepStrictEqual(d.flags, []);
  assert.strictEqual(ran, false);
});

test('THE CROSS ARGV GOES THROUGH BYTE-IDENTICAL -- the real one, from the failed run', () => {
  // Copied from tjs-slow / leg (netbsd-mips64eb) of run 35530707866, minus the
  // -DCMAKE_C_FLAGS= this feature added. Applying both decisions to it must give back the
  // same array, element for element: that IS the property, and an argv assembled by hand
  // in a test would not have caught that this one has no -DCMAKE_C_FLAGS at all.
  const before = [
    '-S', '/w/_temp/tjs-vendor/txiki.js', '-B', '/tmp/clode-tjs-build/tjs-out-1e5abf/build',
    '-DCMAKE_BUILD_TYPE=Release', '-DTJS_USE_ADA=OFF', '-DBUILD_WITH_WASM=OFF',
    '-DBUILD_WITH_MIMALLOC=OFF', '-DBUILD_WITH_FFI=OFF',
    `-DCMAKE_TOOLCHAIN_FILE=${NETBSD_CROSS}`,
    '-DCMAKE_C_COMPILER_LAUNCHER=/usr/bin/ccache',
    '-DCMAKE_C_ARCHIVE_CREATE=<CMAKE_AR> qcD <TARGET> <LINK_FLAGS> <OBJECTS>',
    '-DCMAKE_C_ARCHIVE_APPEND=<CMAKE_AR> qD <TARGET> <LINK_FLAGS> <OBJECTS>',
    '-DCMAKE_C_ARCHIVE_FINISH=<CMAKE_RANLIB> -D <TARGET>',
    '-DCLODE_HOST_TJSC=/tmp/clode-tjs-build/tjs-out-1e5abf/build-host-tjsc/tjsc',
  ];
  const argv = [...before];
  applyFilePrefixMapDecision(argv, filePrefixMapDecision({
    cc: 'mips64--netbsd-gcc', source: 'toolchain-file', crossFile: NETBSD_CROSS,
    mappings: MAPPINGS, env: {}, probeFn: () => 'file-prefix-map',
  }));
  applyOsoPrefixDecision(argv, osoPrefixDecision({
    cc: 'mips64--netbsd-gcc', source: 'toolchain-file', crossFile: NETBSD_CROSS,
    prefix: '/tmp/clode-tjs-build/tjs-out-1e5abf/build', env: {}, realpathFn: (p) => p,
    probeFn: () => 'oso-prefix',
  }));
  assert.deepStrictEqual(argv, before,
    'a cross leg must configure exactly the command line it configured before this feature '
    + 'existed -- run 35530707866 is what one extra -D costs');
});

test('EVERY toolchain file that carries _INIT flags is covered, darwin floors included', () => {
  // Data-driven off the directory, not a hand-written list: an eighth toolchain file added
  // next month is covered the day it lands, which is the only way this pin survives.
  const dir = path.join(__dirname, '..', 'scripts');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.toolchain.cmake')).sort();
  assert.ok(files.length >= 7, `expected the repo's toolchain files, found ${files.length}`);
  let withInit = 0;
  let withFloor = 0;
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8');
    if (!/_FLAGS_INIT/.test(text)) continue;
    withInit++;
    if (/-mmacosx-version-min/.test(text)) withFloor++;
    const crossFile = path.join(dir, f);
    const base = ['-DCMAKE_BUILD_TYPE=Release', `-DCMAKE_TOOLCHAIN_FILE=${crossFile}`];
    const cd = filePrefixMapDecision({ cc: 'cc', source: 'toolchain-file', crossFile,
      mappings: MAPPINGS, env: {}, probeFn: () => 'file-prefix-map' });
    const od = osoPrefixDecision({ cc: 'cc', source: 'toolchain-file', crossFile,
      prefix: '/b/build', env: {}, realpathFn: (p) => p, probeFn: () => 'oso-prefix' });
    assert.deepStrictEqual(applyFilePrefixMapDecision([...base], cd), base,
      `${f}: a -DCMAKE_C_FLAGS= created here DISCARDS this file's CMAKE_C_FLAGS_INIT`);
    assert.deepStrictEqual(applyOsoPrefixDecision([...base], od), base,
      `${f}: a -DCMAKE_EXE_LINKER_FLAGS= created here DISCARDS this file's `
      + 'CMAKE_EXE_LINKER_FLAGS_INIT');
  }
  assert.strictEqual(withInit, files.length,
    'every toolchain file here delivers its essentials through _INIT; if one stops doing '
    + 'that, this test has to be re-read rather than silently narrowed');
  assert.strictEqual(withFloor, 3,
    'darwin-x64, darwin-x86 and darwin-ppc carry -mmacosx-version-min through _INIT. Those '
    + 'three legs are NOT in the `ci` workflow, so a floor dropped from CMAKE_C_FLAGS or '
    + 'CMAKE_EXE_LINKER_FLAGS builds perfectly GREEN and ships a binary that refuses to '
    + 'start on the oldest macOS the asset name promises');
});

test("the declined line says NONE, names the toolchain file, and stays greppable ASCII", () => {
  for (const describe of [describeFilePrefixMapDecision, describeOsoPrefixDecision]) {
    const line = describe({ state: 'cross-toolchain', cc: 'mips64--netbsd-gcc',
      source: 'toolchain-file', crossFile: NETBSD_CROSS, prefix: '/b/build/', mappings: MAPPINGS });
    assert.match(line, /^build-tjs: (file-prefix-map|oso-prefix): NONE /);
    assert.match(line, /netbsd\.toolchain\.cmake/,
      'a declined decision that does not say WHICH file declined it is a decision nobody '
      + 'can act on');
    assert.match(line, /_INIT/, 'and it has to name the mechanism, or the next reader '
      + 'deletes the decline as superstition');
    assert.doesNotMatch(line, /[^\x20-\x7e]/);
    assert.ok(!/\n/.test(line), 'ONE line');
  }
});

// ---- THE WIRING, as a standing guard -----------------------------------------------------
//
// Both levers are worth nothing if the build can reach the end without composing them, and
// the defect this whole decide-once/log-that/apply-that pattern exists to prevent is a build
// whose LOG LINE and COMMAND LINE disagree — which is exactly what recomputing at the call
// site produces. So the wiring is scanned as TEXT, through defineGuard so the scan is proven
// able to fail rather than merely green. scripts/build-tjs.cjs cannot be require()d: it runs
// a whole engine build the moment it is loaded.
//
// PURE: `src` is the already-read scripts/build-tjs.cjs text.
function scanFilePrefixMapWiring({ src }) {
  const findings = [];
  let examined = 0;

  const facts = [
    [/filePrefixMapDecision\(/, 'the compiler-mapping decision is never composed'],
    [/console\.error\(describeFilePrefixMapDecision\(/,
      'the compiler-mapping decision is composed but never LOGGED — an invisible build '
      + 'decision hides for an unknown number of runs (c2067a0\'s lesson)'],
    [/applyFilePrefixMapDecision\(cmakeArgs, /,
      'the compiler-mapping decision is composed and logged but never APPLIED, so the log '
      + 'line and the command line disagree'],
    [/osoPrefixDecision\(/, 'the linker half is never composed, so ld64 keeps writing every '
      + "object's absolute path into the debug map and the engine stays path-dependent"],
    [/console\.error\(describeOsoPrefixDecision\(/, 'the linker decision is never logged'],
    [/applyOsoPrefixDecision\(cmakeArgs, /, 'the linker decision is never applied'],
    [/expandMappings\(/, 'the mappings are handed over RAW, without their resolved spellings '
      + '— exactly the run that came back 46 of 372 red with the flag present and inert'],
  ];
  for (const [re, why] of facts) {
    examined++;
    if (!re.test(src)) findings.push(`scripts/build-tjs.cjs: ${why}`);
  }

  // The decision has to be composed from the REAL two roots. Mapping a build dir that is
  // not the build dir maps nothing, silently.
  examined++;
  const at = src.indexOf('filePrefixMapDecision(');
  const block = at === -1 ? '' : src.slice(at, at + 900);
  if (!/buildDir/.test(block) || !/tjsDir/.test(block)) {
    findings.push('scripts/build-tjs.cjs: the file-prefix-map decision is not composed from '
      + 'buildDir and tjsDir — a mapping whose FROM is not the directory the compiler will '
      + 'see rewrites nothing and reports success');
  }

  // AND FROM crossFile, at BOTH call sites. Without it neither decision can know a
  // toolchain file is in play, so both create a -D that DISCARDS that file's _INIT: the
  // netbsd --sysroot, the cosmo -isystem, the darwin -mmacosx-version-min floor. That is
  // run 35530707866, in which every leg with a toolchain file failed and every leg without
  // one passed. The compiler half is checked separately from the linker half because the
  // darwin files carry the floor in CMAKE_EXE_LINKER_FLAGS_INIT too, and wiring only one
  // of them back would still drop it from the link line — and that BUILDS GREEN.
  for (const [call, which] of [['filePrefixMapDecision(', 'compiler-mapping'],
    ['osoPrefixDecision(', 'linker-mapping']]) {
    examined++;
    const i = src.indexOf(call);
    const b = i === -1 ? '' : src.slice(i, i + 900);
    // `crossFile,` -- the shorthand PROPERTY, not any mention. Both call sites already
    // say `toolchainFile: crossFile ? ... : ''` to resolve the compiler, so scanning for
    // the bare identifier is a check that passes on the broken source: one of the ~14
    // gates found unable to fail in this repo. Verified RED against the pre-fix file.
    if (!/\bcrossFile\s*,/.test(b)) {
      findings.push(`scripts/build-tjs.cjs: the ${which} decision is not told about `
        + 'crossFile, so on a cross leg it creates a -D that discards the toolchain file\'s '
        + '_INIT flags');
    }
  }

  return { findings, examined };
}

const wiringGuard = defineGuard({
  name: 'build-path-mapping-wiring',
  read: () => ({ src: fs.readFileSync(path.join(__dirname, '..', 'scripts/build-tjs.cjs'), 'utf8') }),
  scan: scanFilePrefixMapWiring,
  // Ten independent facts in one named file — the exact measured count.
  floor: 10,
  // Models the regression precisely: a source phase that has lost both levers.
  control: () => ({ src: '// a build with no path mapping at all\n' }),
});
guardTests(wiringGuard);
