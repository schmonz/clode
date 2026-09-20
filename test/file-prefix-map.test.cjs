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
} = require('../scripts/file-prefix-map.cjs');

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

test('scripts/build-tjs.cjs composes the decision and applies the object it logged', () => {
  // Not a style check: the defect this whole pattern exists to prevent is a build whose log
  // line and command line disagree, which is what recomputing at the call site produces.
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts/build-tjs.cjs'), 'utf8');
  assert.match(src, /filePrefixMapDecision\(/);
  assert.match(src, /console\.error\(describeFilePrefixMapDecision\(/);
  assert.match(src, /applyFilePrefixMapDecision\(cmakeArgs, /);
});

test('the decision is composed with the REAL source tree and build dir', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts/build-tjs.cjs'), 'utf8');
  const block = src.slice(src.indexOf('filePrefixMapDecision('), src.indexOf('filePrefixMapDecision(') + 900);
  assert.match(block, /buildDir/, 'mapping a build dir that is not the build dir maps nothing');
  assert.match(block, /tjsDir/);
});

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

test('build-tjs.cjs passes its mappings through expandMappings, not raw', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'scripts/build-tjs.cjs'), 'utf8');
  assert.match(src, /expandMappings\(/,
    'handing the raw pair to the decision is exactly the run that came back 46/372 red');
});
