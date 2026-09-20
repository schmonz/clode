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

// ---- the control's own instrument: reading an archive's member headers ------------------
//
// The control further down asserts that STOCK cmake archive rules produce DIFFERENT archives two
// seconds apart -- a negative control, proving this host can exhibit the defect so that the green
// half is not vacuous. On a Debian-family host that premise is simply FALSE and always will be:
// their binutils is configured --enable-deterministic-archives, so `ar qc` + `ranlib` already
// zeroes every member-header timestamp. The header of scripts/ar-determinism.cjs has recorded
// that fact since the module was written; the control was never taught it, so the suite was
// permanently red on ubuntu with nothing actually wrong.
//
// Relaxing the control to a skip would reopen exactly the hole it exists to close. Instead it
// gets a THIRD outcome that is PROVED from bytes: an archiver is "deterministic by construction"
// when the stock rules and the fixed rules emit IDENTICAL bytes AND every member header carries
// timestamp 0. Two independent pieces of evidence, because either alone has an innocent reading --
// identical bytes alone could be a clock that failed to tick, and zero timestamps alone could be
// the fixed rules doing their job while the stock ones did not. Anything else, including "the two
// control runs matched but the timestamps are non-zero", is UNEXPLAINED and still fails.
//
// THE MEMBER HEADER is 60 bytes of fixed-width ASCII, the same in the GNU and BSD variants:
//
//     name[16] mtime[12] uid[6] gid[6] mode[8] size[10] "`\n"
//
// followed by `size` bytes of data padded to an even offset. Parsed here rather than shelled out
// to `ar tv`, because `ar tv` renders the stamp as a LOCALISED human date through a second
// program whose output format is not a contract -- on this darwin host the zero epoch prints as
// "Dec 31 19:00 1969", so a /1970/ regex would be reading the reader's timezone, not the archive.
// The bytes are the fact; the listing is a rendering of it.
//
// WHY THIS IS IN THE TEST and not in scripts/ar-determinism.cjs, where every other pure decision
// in this feature lives: nothing in `clode build` calls it. It exists so the control can prove
// its own premise, which makes it test apparatus. The first cut DID put it in the module, and
// test/guards-population.test.cjs's production ratchet fired -- a production file that derives a
// verdict from bytes AND throws is gate-shaped, so the module became the 30th un-controlled build
// gate against a baseline of 29. The ratchet was right: this is not a build gate, and the honest
// answer is to keep it out of production code rather than to record an exclusion claiming a gate
// is not a gate.
const AR_MAGIC = '!<arch>\n';
const AR_HEADER_BYTES = 60;

// Every member's { name, mtime }, in file order. THROWS rather than returning a short or empty
// list on anything it cannot read: a caller asking "are all the timestamps 0?" would read an
// empty array as VACUOUSLY yes, which is the same class of false green this whole file exists to
// close.
function arMemberTimestamps(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || '');
  const magic = buf.subarray(0, AR_MAGIC.length).toString('binary');
  if (magic !== AR_MAGIC) {
    throw new Error(`not an ar archive: it starts ${JSON.stringify(magic)}, not ${JSON.stringify(AR_MAGIC)}`);
  }
  const members = [];
  let off = AR_MAGIC.length;
  while (off < buf.length) {
    if (buf.length - off < AR_HEADER_BYTES) {
      throw new Error(`truncated ar member header at byte ${off}: ${buf.length - off} bytes left, `
        + `a header is ${AR_HEADER_BYTES}`);
    }
    const head = buf.subarray(off, off + AR_HEADER_BYTES).toString('binary');
    if (head.slice(58, 60) !== '`\n') {
      throw new Error(`ar member header at byte ${off} does not end in the \`\\n sentinel `
        + `(got ${JSON.stringify(head.slice(58, 60))}), so this is not a header and the walk `
        + 'cannot be trusted to have found every member');
    }
    const stamp = head.slice(16, 28).trim();
    if (!/^\d+$/.test(stamp)) {
      throw new Error(`ar member header at byte ${off} has an unreadable timestamp field `
        + `${JSON.stringify(head.slice(16, 28))}`);
    }
    const size = head.slice(48, 58).trim();
    if (!/^\d+$/.test(size)) {
      throw new Error(`ar member header at byte ${off} has an unreadable size field `
        + `${JSON.stringify(head.slice(48, 58))}, so the next member cannot be located`);
    }
    members.push({ name: head.slice(0, 16).trim(), mtime: Number(stamp) });
    off += AR_HEADER_BYTES + Number(size) + (Number(size) % 2); // members start on even offsets
  }
  if (!members.length) throw new Error('ar archive has no members, so it evidences nothing');
  return members;
}

// THE CONTROL'S OWN VERDICT, pure, over four measurements and nothing else -- no process.platform,
// no distro name, no binutils version. Same doctrine as the probe above: ask the artifact.
//
//   defect-demonstrated          the two stock runs DIFFER: the host can exhibit the defect, so
//                                the control does its usual job and the fixed pair means something
//   deterministic-by-construction stock bytes == fixed bytes AND every member timestamp is 0: the
//                                archiver zeroes stamps whatever rules you hand it (Debian-family
//                                binutils, llvm-ar), so there is no defect here to demonstrate.
//                                The control -- and ONLY the control -- is skipped, out loud.
//   unexplained                  the stock runs matched but the evidence above does not hold:
//                                something is true that nobody has explained, and certifying a
//                                green off it is precisely what the control refuses to do.
function arControlVerdict({
  control1 = '', control2 = '', fixed1 = '', controlTimestamps = [], stockRules = '',
} = {}) {
  const short = (h) => String(h).slice(0, 12);
  const stamps = (Array.isArray(controlTimestamps) ? controlTimestamps : []).map(Number);
  const nonZero = stamps.filter((t) => t !== 0);
  if (control1 !== control2) {
    return {
      outcome: 'defect-demonstrated',
      controlSkipped: false,
      line: 'ar-determinism-control: FIRED -- the stock cmake archive rules produced DIFFERENT '
        + `archives two seconds apart (sha ${short(control1)} vs ${short(control2)}), so this host `
        + 'demonstrates the defect the fixed rules repair',
    };
  }
  if (stamps.length && !nonZero.length && control1 === fixed1) {
    return {
      outcome: 'deterministic-by-construction',
      controlSkipped: true,
      line: 'ar-determinism-control: SKIPPED (archiver is deterministic by construction) -- the '
        + 'stock cmake archive rules produced byte-identical output to the fixed rules '
        + `(sha ${short(control1)}) and all ${stamps.length} ar member-header timestamps are 0, so `
        + 'this archiver cannot exhibit the defect and there is nothing here for the control to '
        + 'demonstrate; the fixed-pair assertion still ran',
    };
  }
  const why = !stamps.length
    ? 'no ar member-header timestamps could be read out of it'
    : (nonZero.length
      ? `its ar member-header timestamps are not all 0 (${nonZero.join(',')})`
      : `the fixed rules produced DIFFERENT bytes (sha ${short(fixed1)})`);
  return {
    outcome: 'unexplained',
    controlSkipped: false,
    line: 'ar-determinism-control: UNEXPLAINED -- the stock cmake archive rules'
      + (stockRules ? ` (${stockRules})` : '')
      + ` produced identical archives two seconds apart (sha ${short(control1)}), but ${why}, so `
      + 'this host cannot demonstrate the defect and the green below proves nothing. '
      + 'Do not delete this assertion -- find out why',
  };
}

test('arMemberTimestamps reads the fixed-width mtime field out of a real archive', () => {
  const ar = findTool('ar');
  const cc = findTool(process.env.CC || 'cc') || findTool('gcc') || findTool('clang');
  // REAL OBJECTS, not text members: cctools `ar` drops anything that is not a mach-o
  // ('warning: archive member not a mach-o file') and writes an archive with only a symbol
  // table, so a text-file fixture would have silently tested a one-member archive.
  if (!ar || !cc) { console.log('SKIP: need both ar and a C compiler to make a real archive'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-ardet-ts-'));
  const objs = [];
  for (let i = 0; i < 2; i += 1) {
    const src = path.join(dir, `m${i}.c`);
    fs.writeFileSync(src, `int clode_stamp_${i}(void) { return ${i}; }\n`);
    const obj = path.join(dir, `m${i}.o`);
    execFileSync(cc, ['-c', src, '-o', obj], { stdio: 'ignore' });
    objs.push(obj);
  }
  const archive = path.join(dir, 'stamped.a');
  execFileSync(ar, ['qc', archive, ...objs], { stdio: 'ignore' });
  const members = arMemberTimestamps(fs.readFileSync(archive));
  assert.ok(members.length >= 2, `both members must be walked, got ${JSON.stringify(members)}`);
  assert.ok(members.some((m) => m.name.includes('m0.o') || m.name.startsWith('#1/')),
    `the names come out of the header too: ${JSON.stringify(members)}`);
  // A stock `ar qc` on a host that is NOT deterministic by default stamps the wall clock; on one
  // that IS, it stamps 0. Both are fine here -- what is asserted is that the field was READ, as
  // a number, not that it has any particular value.
  for (const m of members) assert.ok(Number.isInteger(m.mtime) && m.mtime >= 0, JSON.stringify(m));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('arMemberTimestamps walks padding and refuses anything it cannot read', () => {
  const header = (name, mtime, size) => Buffer.from(
    name.padEnd(16) + String(mtime).padEnd(12) + '0'.padEnd(6) + '0'.padEnd(6)
    + '100644'.padEnd(8) + String(size).padEnd(10) + '`\n', 'binary');
  const archive = Buffer.concat([
    Buffer.from('!<arch>\n'),
    header('a.o/', 1758300000, 3), Buffer.from('abc\n'), // odd size -> one pad byte
    header('b.o/', 0, 2), Buffer.from('bc'),
  ]);
  assert.deepStrictEqual(arMemberTimestamps(archive),
    [{ name: 'a.o/', mtime: 1758300000 }, { name: 'b.o/', mtime: 0 }]);

  // Every refusal below would otherwise come back as "no members", and an empty list would make
  // `every timestamp is zero` VACUOUSLY true -- i.e. the parser would hand the control a reason
  // to skip itself. It throws instead.
  assert.throws(() => arMemberTimestamps(Buffer.from('not an archive at all\n')), /not an ar archive/);
  assert.throws(() => arMemberTimestamps(Buffer.concat([Buffer.from('!<arch>\n'), Buffer.alloc(20)])),
    /truncated/);
  const badMagic = Buffer.concat([Buffer.from('!<arch>\n'), header('a.o/', 0, 0)]);
  badMagic[8 + 58] = 0x58; // clobber the trailing "`\n" sentinel
  assert.throws(() => arMemberTimestamps(badMagic), /member header/);
  const blankStamp = Buffer.concat([Buffer.from('!<arch>\n'), header('a.o/', '', 0)]);
  assert.throws(() => arMemberTimestamps(blankStamp), /timestamp field/);
  assert.throws(() => arMemberTimestamps(Buffer.concat([Buffer.from('!<arch>\n')])), /no members/);
});

// The control's three outcomes, as ONE pure decision over observed bytes -- no process.platform,
// no distro sniff, nothing but four measurements.
test('arControlVerdict: stock archives that differ DEMONSTRATE the defect', () => {
  const v = arControlVerdict({
    control1: 'aaa', control2: 'bbb', fixed1: 'ccc', controlTimestamps: [1758300000, 1758300000],
  });
  assert.strictEqual(v.outcome, 'defect-demonstrated');
  assert.strictEqual(v.controlSkipped, false);
});

test('arControlVerdict: stock bytes == fixed bytes AND every timestamp 0 -> deterministic by construction', () => {
  const v = arControlVerdict({
    control1: 'same', control2: 'same', fixed1: 'same', controlTimestamps: [0, 0, 0],
  });
  assert.strictEqual(v.outcome, 'deterministic-by-construction');
  assert.strictEqual(v.controlSkipped, true);
});

// The whole point of the third outcome is that it is PROVED, so each half of the proof has to be
// load-bearing on its own: neither "the bytes matched" nor "the timestamps are zero" may certify
// alone. These two are why this is not just a relaxation of the control.
test('arControlVerdict: matching control runs with a NON-ZERO timestamp are unexplained, and still fail', () => {
  const v = arControlVerdict({
    control1: 'same', control2: 'same', fixed1: 'same', controlTimestamps: [0, 1758300000],
  });
  assert.strictEqual(v.outcome, 'unexplained');
  assert.strictEqual(v.controlSkipped, false);
  assert.match(v.line, /1758300000/, 'the line names the evidence that refused to certify');
  // And it still names the exact stock rules that produced the identical pair, which is the
  // diagnostic the pre-existing control message carried and the reason anyone could act on it.
  assert.match(arControlVerdict({
    control1: 'same', control2: 'same', fixed1: 'same', controlTimestamps: [7],
    stockRules: '<CMAKE_AR> qc <TARGET> <OBJECTS> then <CMAKE_RANLIB> <TARGET>',
  }).line, /\(<CMAKE_AR> qc <TARGET> <OBJECTS> then <CMAKE_RANLIB> <TARGET>\)/);
});

test('arControlVerdict: zero timestamps but fixed bytes that differ from stock are unexplained', () => {
  const v = arControlVerdict({
    control1: 'same', control2: 'same', fixed1: 'OTHER', controlTimestamps: [0, 0],
  });
  assert.strictEqual(v.outcome, 'unexplained');
  assert.strictEqual(v.controlSkipped, false);
  // An empty parse must never certify either (see arMemberTimestamps' refusals above).
  assert.strictEqual(arControlVerdict({
    control1: 's', control2: 's', fixed1: 's', controlTimestamps: [],
  }).outcome, 'unexplained');
});

test('each control outcome says which one it is on one greppable plain-ASCII line', () => {
  const same = 'ssssssssssssssss';
  const lines = {
    demonstrated: arControlVerdict({
      control1: 'aaaaaaaaaaaaaaaa', control2: 'bbbbbbbbbbbbbbbb', fixed1: 'c',
      controlTimestamps: [1758300000],
    }).line,
    skipped: arControlVerdict({
      control1: same, control2: same, fixed1: same, controlTimestamps: [0, 0],
    }).line,
    unexplained: arControlVerdict({
      control1: same, control2: same, fixed1: same, controlTimestamps: [7],
    }).line,
  };
  for (const [k, l] of Object.entries(lines)) {
    assert.ok(l.startsWith('ar-determinism-control: '), `${k} shares the grep prefix: ${l}`);
    assert.ok(!l.includes('\n'), `${k} is one line, not several: ${l}`);
    // eslint-disable-next-line no-control-regex
    assert.ok(/^[\x20-\x7e]*$/.test(l), `${k} is plain ASCII: ${l}`);
  }
  // The new outcome's line is asserted EXACTLY, because it is the only thing standing between a
  // reader and the conclusion that the control silently passed. It has to say SKIPPED, and it has
  // to carry the evidence it was skipped on.
  assert.strictEqual(lines.skipped,
    'ar-determinism-control: SKIPPED (archiver is deterministic by construction) -- the stock '
    + 'cmake archive rules produced byte-identical output to the fixed rules '
    + '(sha ssssssssssss) and all 2 ar member-header timestamps are 0, so this archiver cannot '
    + 'exhibit the defect and there is nothing here for the control to demonstrate; '
    + 'the fixed-pair assertion still ran');
  assert.strictEqual(lines.demonstrated,
    'ar-determinism-control: FIRED -- the stock cmake archive rules produced DIFFERENT archives '
    + 'two seconds apart (sha aaaaaaaaaaaa vs bbbbbbbbbbbb), so this host demonstrates the defect '
    + 'the fixed rules repair');
  assert.match(lines.unexplained, /^ar-determinism-control: UNEXPLAINED /);
  assert.match(lines.unexplained, /Do not delete this assertion -- find out why$/);
});

// ---- the real host, the real property, with a control that must fail -------------------
//
// The mechanism above is only worth anything if the archives it produces are actually
// identical. This runs the REAL toolchain twice, two seconds apart (archive headers keep
// whole seconds), in cmake's own shape -- create rule then finish rule -- and pairs it with a
// CONTROL run in the unfixed shape that MUST differ. Without the control a green here would
// be indistinguishable from a box whose clock or archiver never varied in the first place,
// which is exactly how this gap hid on twelve NetBSD legs.
// The control, applied. One line, hoisted out of runRealArchiveCheck so the test below can
// exercise all three CONSEQUENCES -- fires and passes, steps aside, fires and FAILS -- through
// the very same statement the real run executes, rather than through a copy of it.
function applyControlVerdict(verdict, control1, control2) {
  if (!verdict.controlSkipped) assert.notStrictEqual(control1, control2, verdict.line);
}

test('the three outcomes have the three consequences, through the statement the real run uses', () => {
  const stamps = { demonstrated: [1758300000], zero: [0, 0], odd: [7] };
  // 1. the defect is demonstrable: the control fires on two DIFFERENT archives and passes.
  applyControlVerdict(
    arControlVerdict({ control1: 'aaa', control2: 'bbb', fixed1: 'ccc', controlTimestamps: stamps.demonstrated }),
    'aaa', 'bbb');
  // 2. deterministic by construction: identical archives, and the control steps aside.
  applyControlVerdict(
    arControlVerdict({ control1: 'sss', control2: 'sss', fixed1: 'sss', controlTimestamps: stamps.zero }),
    'sss', 'sss');
  // 3. identical archives with NO such proof: the control still refuses, with today's words.
  assert.throws(() => applyControlVerdict(
    arControlVerdict({ control1: 'sss', control2: 'sss', fixed1: 'sss', controlTimestamps: stamps.odd }),
    'sss', 'sss'), /Do not delete this assertion -- find out why/);
});

// The whole measurement, for ONE pair of archivers: three real objects, archived twice two
// seconds apart through the mechanism this repo chose AND through stock cmake rules, with
// arControlVerdict reading the four results plus the stock archive's own member headers.
async function runRealArchiveCheck({ cc, ar, ranlib, source }) {
  const decision = arDeterminismDecision({ ar, ranlib, source, env: {} });
  console.log(describeArDeterminismDecision(decision));
  if (decision.state === 'unavailable') { console.log('SKIP: no runnable ar on this host'); return null; }

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

  // The control's premise, decided from the bytes in front of us rather than assumed. The stock
  // archive's OWN member headers are the second piece of evidence: identical bytes alone could be
  // a clock that failed to tick, and that must not be enough to excuse the control.
  const verdict = arControlVerdict({
    control1: sha(c1),
    control2: sha(c2),
    fixed1: sha(a1),
    controlTimestamps: arMemberTimestamps(fs.readFileSync(c1)).map((m) => m.mtime),
    stockRules: `${rules(false).create} then ${rules(false).finish}`,
  });
  console.log(verdict.line);
  // THE CONTROL, and the one condition under which it steps aside. `unexplained` lands here too
  // and fails exactly as it did before this third outcome existed -- the skip is granted only to
  // a host that PROVED it cannot exhibit the defect, never to one that merely came out equal.
  applyControlVerdict(verdict, sha(c1), sha(c2));
  assert.strictEqual(sha(a1), sha(a2),
    `two archives built ${decision.state} two seconds apart differ on ${process.platform}: `
    + `${rules(true).create} then ${rules(true).finish}`);
  fs.rmSync(dir, { recursive: true, force: true });
  return verdict;
}

test('the real toolchain produces byte-identical archives through the chosen mechanism', { timeout: 120000 }, async () => {
  const cc = findTool(process.env.CC || 'cc') || findTool('gcc') || findTool('clang');
  if (!cc) { console.log('SKIP: no C compiler on PATH, so no real objects to archive'); return; }
  await runRealArchiveCheck({ cc, ...resolveArchivers({ cmakeArgs: [], toolchainFile: '' }) });
});

// A SECOND archiver, when the host happens to have one, run through the identical machinery.
//
// This is how the third outcome gets exercised on real bytes outside CI: llvm-ar is deterministic
// by construction everywhere (it zeroes stamps unless asked for `U`), so on this darwin box --
// whose cctools `ar` is the opposite, and whose control therefore FIRES -- the two tests together
// reach both of the non-failing branches in one run. It is not a platform branch and not a
// second implementation: same function, same assertions, a different pair of tools, and it skips
// when the host has nothing else to offer.
test('a second archiver on this host runs the same three-way control', { timeout: 120000 }, async () => {
  const cc = findTool(process.env.CC || 'cc') || findTool('gcc') || findTool('clang');
  if (!cc) { console.log('SKIP: no C compiler on PATH, so no real objects to archive'); return; }
  const host = resolveArchivers({ cmakeArgs: [], toolchainFile: '' });
  const alt = [['llvm-ar', 'llvm-ranlib'], ['gar', 'granlib']]
    .map(([a, r]) => ({ ar: findTool(a), ranlib: findTool(r) }))
    .find((c) => c.ar && c.ranlib && c.ar !== host.ar);
  if (!alt) { console.log('SKIP: this host has only one archiver'); return; }
  const verdict = await runRealArchiveCheck({ cc, ...alt, source: 'second-archiver-on-this-host' });
  assert.ok(verdict && verdict.outcome, 'the second archiver must reach a verdict, not vanish');
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
