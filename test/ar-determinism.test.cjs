'use strict';
// scripts/ar-determinism.cjs — making the ~14 static archives an engine build produces
// byte-identical between two builds of identical objects, on EVERY toolchain rather than
// on the two that happened to be clean.
//
// THE MEASUREMENT THIS FILE EXISTS TO DEFEND (taken 2026-09-19 on a live NetBSD 11.0_RC2
// evbarm guest, `GNU ar (NetBSD Binutils nb1) 2.42`, two runs two seconds apart):
//
//     ar rc          (bare, no ranlib)              DIFFERS
//     ZERO_AR_DATE=1 ar rc                          DIFFERS   <- no effect at all
//     ar rcD         (bare, no ranlib)              IDENTICAL
//
// and then, because cmake does NOT invoke `ar rc` — its archive rules are
// `<CMAKE_AR> qc <TARGET> ...` followed by `<CMAKE_RANLIB> <TARGET>` — the same three-way
// test run in CMAKE'S OWN SHAPE, which is the shape that actually ships:
//
//     ar qc  + ranlib                               DIFFERS
//     ZERO_AR_DATE=1 ar qc + ranlib                 DIFFERS
//     ar qcD + ranlib                               DIFFERS   <- the D on `ar` is NOT enough
//     ar qcD + ranlib -D                            IDENTICAL
//     ar qc  + ranlib -D                            IDENTICAL
//
// That fourth line is the whole reason this is a module and not a one-word patch: the
// trailing `ranlib` re-stamps the symbol-index member that `ar -D` just zeroed, so a fix
// that touches only CMAKE_C_ARCHIVE_CREATE buys nothing. CMAKE_C_ARCHIVE_FINISH has to
// move with it.
//
// And on this darwin host, Apple's cctools `ar` REJECTS the flag outright
// (`ar: illegal option -- D`), while cctools reads ZERO_AR_DATE — which GNU ar ignores.
// There is no single portable incantation, so the honest portable form is a PROBE: run the
// `ar` cmake will actually use and ask it.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const {
  archiverFromCmakeArgs, resolveArchivers, probeDeterministicArchiver,
  arDeterminismOptedOut, arDeterminismDecision, describeArDeterminismDecision,
  applyArDeterminismDecision, arCacheMismatchWarning,
  C_ARCHIVE_CREATE_D, C_ARCHIVE_APPEND_D, C_ARCHIVE_FINISH_D,
} = require('../scripts/ar-determinism.cjs');
const { findTool } = require('../libexec/clode-hosttools.cjs');
const { defineGuard, guardTests } = require('./guard.cjs');

const repo = path.join(__dirname, '..');
// The same stand-in scripts/build-tjs.cjs's cmakeArgs starts life as; every negative
// ("this leg's command line did not change") assertion compares against a copy of it.
const BASE_ARGS = Object.freeze(['-DCMAKE_BUILD_TYPE=Release', '-DTJS_USE_ADA=OFF']);

// ---- which archiver: reading the one cmake will use, not the one on PATH ----------

test('archiverFromCmakeArgs reads an explicitly passed -DCMAKE_AR (last wins, as cmake does)', () => {
  assert.strictEqual(archiverFromCmakeArgs([...BASE_ARGS], 'CMAKE_AR'), '');
  assert.strictEqual(
    archiverFromCmakeArgs([...BASE_ARGS, '-DCMAKE_AR=/opt/a/ar', '-DCMAKE_AR=/opt/b/ar'], 'CMAKE_AR'),
    '/opt/b/ar');
  assert.strictEqual(
    archiverFromCmakeArgs([...BASE_ARGS, '-DCMAKE_RANLIB=/opt/b/ranlib'], 'CMAKE_RANLIB'),
    '/opt/b/ranlib');
});

// THE CROSS-LEG ANSWER, and why it is not a text parse. Twelve of the fleet's legs build
// through a CMAKE_TOOLCHAIN_FILE that names its own archiver -- scripts/netbsd.toolchain.cmake
// DISCOVERS the cross triple with file(GLOB) and a regex, so `set(CMAKE_AR ...)` cannot be read
// off with a grep without reimplementing cmake's expansion (and drifting from it the first time
// a toolchain file changes shape). So this asks CMAKE ITSELF: `cmake -P` a two-line script that
// include()s the very same toolchain file and prints CMAKE_AR. Same file, same interpreter, one
// notion of the answer.
test('resolveArchivers asks cmake to evaluate the toolchain file (the cross legs\' real ar)', () => {
  if (!findTool('cmake')) { console.log('SKIP: no cmake on PATH'); return; }
  const tc = path.join(repo, 'scripts/darwin-x64.toolchain.cmake');
  const got = resolveArchivers({ cmakeArgs: [...BASE_ARGS], toolchainFile: tc });
  assert.strictEqual(got.source, 'toolchain-file');
  assert.strictEqual(got.ar, 'x86_64-apple-darwin10-ar');
  assert.strictEqual(got.ranlib, 'x86_64-apple-darwin10-ranlib');
});

test('resolveArchivers falls back to PATH, and says so, when a toolchain file will not evaluate', () => {
  if (!findTool('cmake')) { console.log('SKIP: no cmake on PATH'); return; }
  const bad = path.join(os.tmpdir(), `clode-no-such-toolchain-${process.pid}.cmake`);
  const got = resolveArchivers({ cmakeArgs: [...BASE_ARGS], toolchainFile: bad });
  assert.strictEqual(got.source, 'path-after-toolchain-file-failed',
    'an unevaluable toolchain file must degrade to a NAMED fallback, not silently look like a '
    + 'successful resolution');
  assert.ok(got.ar, 'the fallback still has to name an archiver');
});

test('resolveArchivers prefers an explicit -DCMAKE_AR over both', () => {
  const got = resolveArchivers({
    cmakeArgs: [...BASE_ARGS, '-DCMAKE_AR=/opt/x/ar', '-DCMAKE_RANLIB=/opt/x/ranlib'],
    toolchainFile: '',
  });
  assert.strictEqual(got.source, 'cmake-args');
  assert.strictEqual(got.ar, '/opt/x/ar');
  assert.strictEqual(got.ranlib, '/opt/x/ranlib');
});

// ---- the probe: it RUNS the tool, and the injected runner proves which branch is which --

// A fake execFileSync standing in for a whole toolchain. `accepts` lists the tools that
// tolerate the deterministic flag; anything else throws the way the real one does.
function fakeRunner({ accepts = [], missing = [] } = {}) {
  const calls = [];
  return {
    calls,
    run(file, args) {
      calls.push([file, ...args]);
      if (missing.includes(file)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }
      if (accepts.includes(file)) {
        // The real `ar qcD <archive> <member>` CREATES the archive; the probe checks for it,
        // so the fake has to as well or the accepted branch is never reachable.
        if (args[0] && args[0].includes('c')) fs.writeFileSync(args[1], '!<arch>\n');
        return '';
      }
      throw new Error(`${file}: illegal option -- D`);
    },
  };
}

test('probeDeterministicArchiver: a GNU-shaped toolchain accepts both', () => {
  const f = fakeRunner({ accepts: ['ar', 'ranlib'] });
  const got = probeDeterministicArchiver({ ar: 'ar', ranlib: 'ranlib', execFileSyncFn: f.run });
  assert.deepStrictEqual(got, { ar: 'accepted', ranlib: 'accepted' });
  assert.ok(f.calls.some((c) => c[0] === 'ar' && c[1] === 'qcD'),
    'the probe must actually invoke ar with the D modifier, not reason about it');
  assert.ok(f.calls.some((c) => c[0] === 'ranlib' && c[1] === '-D'));
});

test('probeDeterministicArchiver: an Apple-shaped toolchain rejects at ar, and stops there', () => {
  const f = fakeRunner({ accepts: ['ranlib'] });
  const got = probeDeterministicArchiver({ ar: 'ar', ranlib: 'ranlib', execFileSyncFn: f.run });
  assert.deepStrictEqual(got, { ar: 'rejected', ranlib: 'unprobed' });
  assert.ok(!f.calls.some((c) => c[0] === 'ranlib'),
    'once ar refuses the flag the ranlib answer cannot change the outcome, so it is not asked');
});

test('probeDeterministicArchiver: a tool that cannot be executed is unavailable, not rejected', () => {
  const f = fakeRunner({ accepts: ['ar', 'ranlib'], missing: ['lib.exe'] });
  assert.deepStrictEqual(
    probeDeterministicArchiver({ ar: 'lib.exe', ranlib: 'ranlib', execFileSyncFn: f.run }),
    { ar: 'unavailable', ranlib: 'unprobed' });
  const g = fakeRunner({ accepts: ['ar'], missing: ['ranlib'] });
  assert.deepStrictEqual(
    probeDeterministicArchiver({ ar: 'ar', ranlib: 'ranlib', execFileSyncFn: g.run }),
    { ar: 'accepted', ranlib: 'unavailable' });
});

// ---- the decision, and the cmake arguments it does or does NOT add --------------------

const decide = (probe, extra = {}) => arDeterminismDecision({
  ar: 'ar', ranlib: 'ranlib', source: 'path', env: {}, probeFn: () => probe, ...extra,
});

test('both accept -> state flags, and exactly the three archive rules are pushed', () => {
  const d = decide({ ar: 'accepted', ranlib: 'accepted' });
  assert.strictEqual(d.state, 'flags');
  assert.deepStrictEqual(applyArDeterminismDecision([...BASE_ARGS], d), [
    ...BASE_ARGS,
    `-DCMAKE_C_ARCHIVE_CREATE=${C_ARCHIVE_CREATE_D}`,
    `-DCMAKE_C_ARCHIVE_APPEND=${C_ARCHIVE_APPEND_D}`,
    `-DCMAKE_C_ARCHIVE_FINISH=${C_ARCHIVE_FINISH_D}`,
  ]);
  // The measured lesson, asserted as a shape: the FINISH rule is not optional garnish.
  assert.ok(C_ARCHIVE_FINISH_D.includes('-D') && C_ARCHIVE_FINISH_D.includes('<CMAKE_RANLIB>'),
    'ar qcD without ranlib -D measured DIFFERS on NetBSD; the finish rule carries the fix');
  // <CMAKE_AR>/<CMAKE_RANLIB> placeholders, never a resolved path: cmake substitutes the
  // archiver IT chose, so a probe that guessed slightly wrong still cannot make the build
  // run the wrong binary.
  assert.ok(C_ARCHIVE_CREATE_D.startsWith('<CMAKE_AR> '));
});

test('ar rejects -> state zero-ar-date, and the cmake argv is byte-identical to before', () => {
  const d = decide({ ar: 'rejected', ranlib: 'unprobed' });
  assert.strictEqual(d.state, 'zero-ar-date');
  assert.deepStrictEqual(applyArDeterminismDecision([...BASE_ARGS], d), [...BASE_ARGS]);
});

test('ar unavailable, or opted out -> also no new cmake arguments at all', () => {
  const unavailable = decide({ ar: 'unavailable', ranlib: 'unprobed' });
  assert.strictEqual(unavailable.state, 'unavailable');
  assert.deepStrictEqual(applyArDeterminismDecision([...BASE_ARGS], unavailable), [...BASE_ARGS]);
  const off = arDeterminismDecision({
    ar: 'ar', ranlib: 'ranlib', source: 'path',
    env: { CLODE_TJS_AR_DETERMINISM: '0' },
    probeFn: () => { throw new Error('the opt-out must short-circuit BEFORE running any tool'); },
  });
  assert.strictEqual(off.state, 'opted-out');
  assert.deepStrictEqual(applyArDeterminismDecision([...BASE_ARGS], off), [...BASE_ARGS]);
  assert.ok(arDeterminismOptedOut({ CLODE_TJS_AR_DETERMINISM: '0' }));
  assert.ok(!arDeterminismOptedOut({}));
});

// A toolchain whose ar takes D but whose ranlib does not would be SILENTLY nondeterministic
// if it were folded into either neighbouring state -- the create rule lands, the finish rule
// does not, and the measurement above says that combination DIFFERS. It gets its own state
// and its own loud line rather than a rounding.
test('ar accepts but ranlib does not -> partial: create/append only, and the log says so', () => {
  const d = decide({ ar: 'accepted', ranlib: 'rejected' });
  assert.strictEqual(d.state, 'partial');
  assert.deepStrictEqual(applyArDeterminismDecision([...BASE_ARGS], d), [
    ...BASE_ARGS,
    `-DCMAKE_C_ARCHIVE_CREATE=${C_ARCHIVE_CREATE_D}`,
    `-DCMAKE_C_ARCHIVE_APPEND=${C_ARCHIVE_APPEND_D}`,
  ]);
  assert.match(describeArDeterminismDecision(d), /PARTIAL/);
  assert.match(describeArDeterminismDecision(d), /may still be nondeterministic/);
});

// ---- the log line: a contract, asserted exactly (see ccache-launcher.cjs for the why) ----

test('every state describes itself on one greppable plain-ASCII line', () => {
  const lines = [
    describeArDeterminismDecision(decide({ ar: 'accepted', ranlib: 'accepted' })),
    describeArDeterminismDecision(decide({ ar: 'rejected', ranlib: 'unprobed' })),
    describeArDeterminismDecision(decide({ ar: 'accepted', ranlib: 'rejected' })),
    describeArDeterminismDecision(decide({ ar: 'unavailable', ranlib: 'unprobed' })),
    describeArDeterminismDecision(arDeterminismDecision({
      ar: 'ar', ranlib: 'ranlib', source: 'path', env: { CLODE_TJS_AR_DETERMINISM: '0' },
      probeFn: () => ({ ar: 'accepted', ranlib: 'accepted' }),
    })),
  ];
  for (const l of lines) {
    assert.ok(l.startsWith('build-tjs: ar-determinism: '),
      `every line shares the grep prefix: ${l}`);
    assert.ok(!l.includes('\n'), `one line, not several: ${l}`);
    // eslint-disable-next-line no-control-regex
    assert.ok(/^[\x20-\x7e]*$/.test(l), `plain ASCII (the Windows console mangles the rest): ${l}`);
  }
  assert.strictEqual(lines[0],
    'build-tjs: ar-determinism: FLAGS ar=ar ranlib=ranlib source=path '
    + '(both accept the deterministic flag; cmake archive rules get qcD/qD and ranlib -D)');
  assert.strictEqual(lines[1],
    'build-tjs: ar-determinism: ZERO_AR_DATE ar=ar source=path '
    + '(ar rejects the D modifier; ZERO_AR_DATE=1 is this toolchain\'s lever)');
  assert.strictEqual(lines[3],
    'build-tjs: ar-determinism: NONE ar=ar source=path '
    + '(could not run it, so no archive rules were changed)');
  assert.strictEqual(lines[4],
    'build-tjs: ar-determinism: NONE (opted out: CLODE_TJS_AR_DETERMINISM=0)');
});

test('describeArDeterminismDecision refuses to be silent about a state it was never taught', () => {
  assert.throws(() => describeArDeterminismDecision({ state: 'something-new' }), /something-new/);
});

// ---- the probe resolved an archiver; did cmake agree? ---------------------------------
//
// The one genuinely unproven step is the NATIVE case: nothing passes -DCMAKE_AR and there is
// no toolchain file, so this code probes `ar` off PATH while cmake runs its own
// CMakeFindBinUtils search (which can prefer a compiler-relative or llvm- prefixed one). Rather
// than assert they always agree, the build CHECKS after configuring -- CMakeCache.txt records
// the archiver cmake actually chose -- and says so out loud when they differ.
test('arCacheMismatchWarning is silent on agreement and loud on disagreement', () => {
  const d = decide({ ar: 'accepted', ranlib: 'accepted' });
  assert.strictEqual(arCacheMismatchWarning({ decision: d, cacheAr: 'ar' }), '');
  assert.strictEqual(arCacheMismatchWarning({ decision: d, cacheAr: '' }), '',
    'no cache entry to compare against is not a disagreement');
  const warn = arCacheMismatchWarning({ decision: d, cacheAr: '/usr/bin/llvm-ar' });
  assert.match(warn, /^build-tjs: ar-determinism: WARNING /);
  assert.match(warn, /llvm-ar/);
  assert.match(warn, /\bar\b/);
});

// ---- the real host, the real property, with a control that must fail -------------------
//
// The mechanism above is only worth anything if the archives it produces are actually
// identical. This runs the REAL toolchain twice, two seconds apart (archive headers keep
// whole seconds), in cmake's own shape -- create rule then finish rule -- and pairs it with a
// CONTROL run in the unfixed shape that MUST differ. Without the control a green here would
// be indistinguishable from a box whose clock or archiver never varied in the first place,
// which is exactly how this gap hid on twelve NetBSD legs.
test('the real toolchain produces byte-identical archives through the chosen mechanism', { timeout: 120000 }, async () => {
  const cc = findTool(process.env.CC || 'cc') || findTool('gcc') || findTool('clang');
  if (!cc) { console.log('SKIP: no C compiler on PATH, so no real objects to archive'); return; }
  const resolved = resolveArchivers({ cmakeArgs: [], toolchainFile: '' });
  const decision = arDeterminismDecision({ ...resolved, env: {} });
  console.log(describeArDeterminismDecision(decision));
  if (decision.state === 'unavailable') { console.log('SKIP: no runnable ar on this host'); return; }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-ardet-real-'));
  const objs = [];
  for (let i = 0; i < 3; i += 1) {
    const src = path.join(dir, `o${i}.c`);
    fs.writeFileSync(src, `int clode_probe_${i}(void) { return ${i}; }\n`);
    const obj = path.join(dir, `o${i}.o`);
    execFileSync(cc, ['-c', src, '-o', obj], { stdio: 'ignore' });
    objs.push(obj);
  }
  const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

  // FIXED = what applyArDeterminismDecision just decided, expanded exactly the way cmake
  // expands its archive rules; CONTROL = what cmake would have run without this change.
  const rules = (fixed) => {
    const args = applyArDeterminismDecision([], decision);
    const create = args.find((a) => a.startsWith('-DCMAKE_C_ARCHIVE_CREATE='));
    const finish = args.find((a) => a.startsWith('-DCMAKE_C_ARCHIVE_FINISH='));
    return {
      create: (fixed && create ? create.split('=').slice(1).join('=') : '<CMAKE_AR> qc <TARGET> <OBJECTS>'),
      finish: (fixed && finish ? finish.split('=').slice(1).join('=') : '<CMAKE_RANLIB> <TARGET>'),
    };
  };
  const build = (out, fixed) => {
    const { create, finish } = rules(fixed);
    // ZERO_AR_DATE rides along on the FIXED run only -- it is the other half of the same
    // decision (the lever cctools reads and GNU ar ignores), so the fixed/control pair is
    // "this repo's mechanism" vs "stock cmake", not "one flag" vs "no flag".
    //
    // DELETED, not set to '': cctools tests `getenv("ZERO_AR_DATE") != NULL`, so an EMPTY
    // value is still ON. The first draft of this test set '' for the control and the control
    // came back IDENTICAL on darwin -- the assertion below caught it, which is the entire
    // reason the control is an assertion and not a comment.
    const env = { ...process.env };
    delete env.ZERO_AR_DATE;
    if (fixed && decision.state === 'zero-ar-date') env.ZERO_AR_DATE = '1';
    for (const tmpl of [create, finish]) {
      const words = tmpl.replace('<CMAKE_AR>', decision.ar).replace('<CMAKE_RANLIB>', decision.ranlib)
        .split(' ').filter(Boolean);
      const expanded = [];
      for (const w of words) {
        if (w === '<TARGET>') expanded.push(out);
        else if (w === '<OBJECTS>') expanded.push(...objs);
        else if (w === '<LINK_FLAGS>') continue;
        else expanded.push(w);
      }
      execFileSync(expanded[0], expanded.slice(1), { stdio: 'ignore', env });
    }
  };

  const a1 = path.join(dir, 'fixed-1.a'); const c1 = path.join(dir, 'ctrl-1.a');
  build(a1, true); build(c1, false);
  await new Promise((r) => setTimeout(r, 2100)); // archive headers store whole seconds
  const a2 = path.join(dir, 'fixed-2.a'); const c2 = path.join(dir, 'ctrl-2.a');
  build(a2, true); build(c2, false);

  assert.notStrictEqual(sha(c1), sha(c2),
    `the CONTROL (stock cmake archive rules: ${rules(false).create} then ${rules(false).finish}) `
    + 'produced identical archives two seconds apart, so this host cannot demonstrate the defect '
    + 'and the green below proves nothing. Do not delete this assertion -- find out why');
  assert.strictEqual(sha(a1), sha(a2),
    `two archives built ${decision.state} two seconds apart differ on ${process.platform}: `
    + `${rules(true).create} then ${rules(true).finish}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- reach: does a cache-level archive rule actually get into the SUBPROJECTS? ---------
//
// The vendored tree adds every archive-producing dependency with add_subdirectory
// (mimalloc, libuv, libwebsockets, quickjs, sqlite3, miniz, wurl, mbedtls), so a cache
// variable reaches them by cmake's ordinary directory-scope inheritance. "By ordinary
// inheritance" is a claim, so a real cmake run makes it a fact -- on a two-file synthetic
// project rather than the 46-second vendored configure, because the mechanism under test is
// cmake's, not txiki's.
test('a -D archive rule reaches a subproject added with add_subdirectory', () => {
  if (!findTool('cmake')) { console.log('SKIP: no cmake on PATH'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-ardet-reach-'));
  fs.mkdirSync(path.join(dir, 'src/sub'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/CMakeLists.txt'),
    'cmake_minimum_required(VERSION 3.16)\nproject(reach LANGUAGES C)\nadd_subdirectory(sub)\n');
  fs.writeFileSync(path.join(dir, 'src/sub/CMakeLists.txt'),
    'add_library(subarchive STATIC a.c)\n');
  fs.writeFileSync(path.join(dir, 'src/sub/a.c'), 'int a(void){return 0;}\n');
  const r = spawnSync('cmake', [
    '-S', path.join(dir, 'src'), '-B', path.join(dir, 'build'), '-DCMAKE_BUILD_TYPE=Release',
    `-DCMAKE_C_ARCHIVE_CREATE=${C_ARCHIVE_CREATE_D}`,
    `-DCMAKE_C_ARCHIVE_FINISH=${C_ARCHIVE_FINISH_D}`,
  ], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `synthetic configure failed:\n${r.stdout}\n${r.stderr}`);
  const rules = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name === 'link.txt' || e.name === 'build.ninja') rules.push(fs.readFileSync(p, 'utf8'));
    }
  };
  walk(path.join(dir, 'build'));
  const text = rules.join('\n');
  assert.ok(/\bqcD\b/.test(text),
    `the subproject's archive rule did not inherit the cache-level create rule:\n${text}`);
  assert.ok(/ranlib.* -D /.test(text) || /-D <TARGET>/.test(text) || / -D /.test(text),
    `the subproject's archive rule did not inherit the cache-level finish rule:\n${text}`);
  fs.rmSync(dir, { recursive: true, force: true });
});

// The one way reach can be lost: a vendored CMakeLists that sets the archive rules ITSELF,
// shadowing the cache entry for its own directory. mbedtls does exactly that, and it is the
// reason a darwin configure shows 11 archives on `ar qcD` and 3 on `ar Scr`. That is harmless
// TODAY (the mbedtls override is guarded by CMAKE_C_COMPILER_ID MATCHES "AppleClang", and the
// AppleClang legs are the ones whose ar rejects D and which ride ZERO_AR_DATE instead) --
// but only until a vendor bump adds an unguarded one, which would silently take three
// archives back out of the fix. This guard is how that gets noticed.
const archiveOverrideGuard = defineGuard({
  name: 'vendored-archive-rule-overrides',
  // The traversal below reaches ~15 CMakeLists; anything under half of that means
  // add_subdirectory() stopped being how this tree composes and the guard is now blind.
  floor: 8,
  read() {
    const root = path.join(repo, 'spike/quickjs/vendor/txiki.js');
    const top = path.join(root, 'CMakeLists.txt');
    if (!fs.existsSync(top)) {
      return { skip: 'the vendored txiki.js tree is not present (it is fetched, not committed)' };
    }
    // FOLLOW add_subdirectory(), DO NOT WALK THE TREE. Two reasons, and the second one is
    // what makes this a better guard rather than merely a faster one:
    //   * cost -- the vendored tree is 2029 directories and 522 cmake files, and on the
    //     author's box a readdir walk of it takes 20-60 SECONDS. A guard that expensive gets
    //     turned off, and a guard that is off is the thing this repo keeps finding.
    //   * precision -- the set of files cmake actually processes IS the add_subdirectory
    //     closure. Walking the tree would also read deps/libwebsockets/test-apps and
    //     deps/wamr (1090 of those directories), where an archive-rule override would be
    //     true and irrelevant, i.e. a false finding waiting to happen.
    const seen = new Set();
    const files = [];
    const visit = (dir) => {
      const f = path.join(dir, 'CMakeLists.txt');
      if (seen.has(f) || !fs.existsSync(f)) return;
      seen.add(f);
      const text = fs.readFileSync(f, 'utf8');
      files.push({ path: path.relative(repo, f).split(path.sep).join('/'), text });
      for (const m of text.matchAll(/add_subdirectory\s*\(\s*([^\s)]+)/g)) {
        const sub = m[1].replace(/^"|"$/g, '');
        if (sub.includes('${')) continue; // a computed path: not resolvable without cmake
        visit(path.resolve(dir, sub));
      }
    };
    visit(root);
    return { files };
  },
  scan({ files }) {
    // KNOWN and reasoned about: mbedtls's AppleClang-only `Scr` / `ranlib -c` pair, which is
    // why a darwin configure of this tree shows 11 archives on the cache rule and 3 on
    // mbedtls's own. Harmless as long as it stays AppleClang-guarded, because the AppleClang
    // legs are exactly the ones whose ar rejects D and which ride ZERO_AR_DATE instead -- so
    // the guard checks the GUARD, not just the file.
    const MBEDTLS = 'spike/quickjs/vendor/txiki.js/deps/mbedtls/library/CMakeLists.txt';
    const findings = [];
    for (const f of files) {
      const lines = f.text.split('\n');
      lines.forEach((line, i) => {
        if (!/^\s*set\s*\(\s*CMAKE_(C|CXX)_ARCHIVE_(CREATE|APPEND|FINISH)\b/.test(line)) return;
        if (f.path === MBEDTLS) {
          // Walk back to the enclosing if(): it must still be the AppleClang one.
          const before = lines.slice(Math.max(0, i - 6), i).join('\n');
          if (/AppleClang/.test(before)) return;
          findings.push(`${f.path}:${i + 1}: mbedtls's archive-rule override is no longer `
            + `AppleClang-guarded, so it now shadows the deterministic rules on legs that DO `
            + `take them: ${line.trim()}`);
          return;
        }
        findings.push(`${f.path}:${i + 1}: shadows the cache-level archive rule, so this `
          + `subproject's archives opt out of scripts/ar-determinism.cjs: ${line.trim()}`);
      });
    }
    return { findings, examined: files.length };
  },
  control() {
    return {
      files: [
        { path: 'spike/quickjs/vendor/txiki.js/deps/newdep/CMakeLists.txt',
          text: 'add_library(newdep STATIC a.c)\nset(CMAKE_C_ARCHIVE_CREATE "<CMAKE_AR> qc <TARGET> <OBJECTS>")\n' },
        // The second half of the control: the known mbedtls override losing its AppleClang
        // guard must ALSO be reported, or the carve-out above is an unbounded exemption.
        { path: 'spike/quickjs/vendor/txiki.js/deps/mbedtls/library/CMakeLists.txt',
          text: 'if(WIN32)\n    set(CMAKE_C_ARCHIVE_CREATE   "<CMAKE_AR> Scr <TARGET> <OBJECTS>")\nendif()\n' },
      ],
    };
  },
});

guardTests(archiveOverrideGuard);
