'use strict';
// Phase 4c-2. cmake must REGENERATE src/bundles/c/** from src/bundles/js/**.
//
// WHY THIS EXISTS: txiki's Makefile declares that rule (one per bundle) and
// ships the .c pre-built; its CMakeLists does NOT — it lists the .c as plain
// sources. clode drives cmake directly, bypassing the Makefile, so a patch to
// src/js/** changed the esbuilt .js while the .c that actually compiled stayed
// pristine. A correct AbortSignal.timeout patch plus its C binding built clean
// and changed nothing, with no failure signal anywhere.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defineGuard, guardTests } = require('./guard.cjs');

const repo = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(repo, 'scripts/build-tjs.cjs'), 'utf8');

test('a fixup injects bytecode regeneration rules into the vendored CMakeLists', () => {
  assert.match(src, /function fixupTjsCmakeBytecodeRules\(/,
    'the rule must be injected by a fixup, not re-derived imperatively in JS');
});

test('the rule uses a HOST tjsc, because add_custom_command runs on the build host', () => {
  // A cross build's in-tree tjsc is a TARGET binary this host cannot execute.
  assert.match(src, /CLODE_HOST_TJSC/,
    'the injected rule must consume a host tjsc passed in as a cache variable');
});

// ---- the Windows symbol-name hazard: checked against EMITTED cmake --------
//
// A source-text keyword search here is inert: it can assert "WORKING_DIRECTORY
// appears somewhere" and "CMAKE_CURRENT_BINARY_DIR does not precede -o...
// CMAKE_CURRENT_SOURCE_DIR" without ever looking at what tjsc's actual input
// argument is. Both survive the real regression (prefixing the input the same
// way outC already legitimately is prefixed) unchanged — proven by this guard's
// control. The property that matters is a SHAPE: the trailing positional
// argument of the emitted COMMAND (tjsc's input) must be the bare relative
// inJs, with no ${CMAKE_CURRENT_SOURCE_DIR}/ or ${CMAKE_CURRENT_BINARY_DIR}/
// prefix — everything else in the line (-o's target, DEPENDS) is legitimately
// absolute. So we call the real fixup against a fixture CMakeLists and inspect
// what it wrote.
//
// REGISTERED THROUGH the guard machinery in phase 4c-2 fix round 1, not left
// as a plain test with a hand-rolled PROOF beside it. The hand-rolled version worked, but
// it made this file a scanner-shaped test outside the guard population, and the
// exclusion written for it had to claim "there is no fixed artifact to scan" —
// which overstates, since the two tests above do read scripts/build-tjs.cjs and
// derive findings from its bytes. Registering is the honest answer: read()
// produces the emission, scan() judges the shape, control() IS the old PROOF
// (the realistic regression, hand-built, which the scan must reject), and the
// machinery reports CANNOT FAIL if it ever stops rejecting it.

// Brace-balanced extraction (test/tjs-bytecode-regen.test.cjs's house pattern):
// a non-greedy regex breaks the moment the function body contains its own '}'.
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start > -1, `function ${name} not found in build-tjs.cjs`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

function loadFixup() {
  const fnSrc = extractFunction(src, 'fixupTjsCmakeBytecodeRules');
  // eslint-disable-next-line no-new-func
  const factory = new Function('fs', 'path', 'console', `${fnSrc}\nreturn fixupTjsCmakeBytecodeRules;`);
  return factory(fs, path, console);
}

const SAMPLE_PAIRS = [
  { outC: 'src/bundles/c/core/polyfills.c', name: 'tjs:internal/polyfills', prefix: 'tjs__', inJs: 'src/bundles/js/core/polyfills.js' },
  { outC: 'src/bundles/c/stdlib/assert.c', name: 'tjs:assert', prefix: 'tjs__', inJs: 'src/bundles/js/stdlib/assert.js' },
];

function commandBlockFor(emitted, outC) {
  const outputMarker = `OUTPUT \${CMAKE_CURRENT_SOURCE_DIR}/${outC}`;
  const outIdx = emitted.indexOf(outputMarker);
  if (outIdx === -1) return null;
  const commandIdx = emitted.indexOf('COMMAND ', outIdx);
  const blockEnd = emitted.indexOf('VERBATIM)', commandIdx);
  return emitted.slice(commandIdx, blockEnd);
}

// PURE. The one judgement this whole file exists to make airtight: tjsc's
// trailing input argument is the bare relative inJs, character-for-character —
// not "contains inJs" (an absolute-prefixed path also contains it), not "no
// CMAKE_CURRENT_BINARY_DIR nearby" (misses a CMAKE_CURRENT_SOURCE_DIR prefix,
// the actual shape this fixup itself would produce if outC's prefixing style
// leaked onto inJs). Also folds in the WORKING_DIRECTORY check an early draft
// asserted separately and weakly: a relative input only resolves correctly
// because cwd is the source tree, so the two are judged as one property, in the
// same custom_command block.
function scanTjscInputShape({ emitted, pairs }) {
  const findings = [];
  let examined = 0;
  for (const { outC, inJs } of pairs) {
    const block = commandBlockFor(emitted, outC);
    if (block === null) {
      findings.push(`no add_custom_command OUTPUT for ${outC} in the emitted cmake — `
        + 'the rule for this bundle was not injected at all, so nothing regenerates it');
      continue;
    }
    examined++;
    const commandLineEnd = block.indexOf('\n');
    const commandLine = block.slice(0, commandLineEnd === -1 ? undefined : commandLineEnd);
    const tokens = commandLine.trim().split(/\s+/);
    const last = tokens[tokens.length - 1];
    if (last !== inJs) {
      findings.push(`tjsc's input argument must be the bare relative path "${inJs}"; got `
        + `"${last}" — an absolute path here leaks straight into the generated C symbol `
        + 'name (get_c_name, src/qjsc.c:191): on Windows, the drive colon and every '
        + 'backslash each become a distinct C syntax error, times every bundle');
    }
    if (!/WORKING_DIRECTORY \$\{CMAKE_CURRENT_SOURCE_DIR\}/.test(block)) {
      findings.push(`${outC}: WORKING_DIRECTORY must be the source tree, in the SAME block `
        + 'as this COMMAND — that is what makes the relative input above resolve at all');
    }
  }
  return { findings, examined };
}

const bytecodeRuleGuard = defineGuard({
  name: 'bytecode-rule-relative-input',
  // One per sample pair: a core bundle and a stdlib bundle, which are the two
  // outC shapes the fixup emits. EXACT — if a pair stops producing a command
  // block the scan reports it as a finding AND examined falls, so the guard says
  // BROKEN rather than quietly judging fewer rules than it claims to.
  floor: 2,
  // THE ARTIFACT IS BUILT HERE, by the production fixup, against a fixture this
  // test owns: the subject is what that call WRITES, so there is nothing in the
  // tree to read instead.
  read: () => {
    const fixup = loadFixup();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-bytecode-rule-'));
    try {
      fs.writeFileSync(path.join(dir, 'CMakeLists.txt'),
        'add_executable(tjsc src/qjsc.c)\nadd_executable(tjs-cli src/main.c)\n');
      fixup(dir, SAMPLE_PAIRS);
      return { emitted: fs.readFileSync(path.join(dir, 'CMakeLists.txt'), 'utf8'), pairs: SAMPLE_PAIRS };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
  scan: scanTjscInputShape,
  // THE REGRESSION THIS GATE EXISTS TO CATCH, hand-built: someone "cleans up"
  // the rule by prefixing tjsc's input the same way outC already legitimately
  // is — the change that shipped, unnoticed, as
  //     const uint32_t tjs__internal_D:\a\_temp\...\path_size = 89;
  // A negative assertion nobody has watched reject a real bad input is not yet
  // a gate, so the machinery re-watches it on every run.
  control: () => ({
    emitted: 'add_custom_command(\n'
      + '    OUTPUT ${CMAKE_CURRENT_SOURCE_DIR}/src/bundles/c/core/polyfills.c\n'
      + '    COMMAND ${CLODE_HOST_TJSC} -m -s -o ${CMAKE_CURRENT_SOURCE_DIR}/src/bundles/c/core/polyfills.c'
      + ' -n "tjs:internal/polyfills" -p tjs__ ${CMAKE_CURRENT_SOURCE_DIR}/src/bundles/js/core/polyfills.js\n'
      + '    DEPENDS ${CMAKE_CURRENT_SOURCE_DIR}/src/bundles/js/core/polyfills.js ${CLODE_HOST_TJSC}\n'
      + '    WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}\n'
      + '    COMMENT "tjsc src/bundles/c/core/polyfills.c"\n'
      + '    VERBATIM)\n',
    pairs: [SAMPLE_PAIRS[0]],
  }),
});
guardTests(bytecodeRuleGuard);

// ---- TWO EMITTERS, ONE JOB: the tjsc argv must be identical ----------------
//
// There are two places that decide what arguments tjsc is called with:
// fixupTjsCmakeBytecodeRules' emitted COMMAND (every build except one) and
// regenBytecodeArrays' imperative `run(tjsc, [...])` loop (--regen-only, which
// exists solely for the netbsd-sparc in-guest bake, whose cmake never gets a
// CLODE_HOST_TJSC). Today they agree.
//
// WHAT WAS ALREADY GATED, AND WHY IT IS ONLY HALF: both emitters read the same
// bytecodeBundlePairs() table (test/tjs-bytecode-regen.test.cjs), so neither can
// know about a bundle the other does not. That closes divergence in WHICH
// bundles get compiled and closes nothing about HOW. A `-M`, a dropped `-s`, a
// changed module-name flag landing in one emitter and not the other would make
// netbsd-sparc ship bytecode generated with different flags from the other 41
// legs — silently, and detectable only as a runtime difference in a guest
// nobody can attach a debugger to. That is the same divergence class that
// already cost this repo the moduleMeta incident (one emitter regenerated, the
// other did not), halved rather than closed.
//
// So: extract both argument lists and compare them. The per-bundle VALUES are
// legitimately spelled differently — the cmake rule writes
// ${CMAKE_CURRENT_SOURCE_DIR}/<outC> where the JS loop passes an absolute
// outAbs, and cmake wants the module name quoted where an execFileSync argv
// must not be — so values are normalized to placeholders and the FLAGS, in
// order, are what must match exactly.

const TJSC_VALUE_FLAGS = new Set(['-o', '-n', '-p']);

function normalizeTjscArgv(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (TJSC_VALUE_FLAGS.has(tok) && i + 1 < tokens.length) {
      out.push(tok, `<${tok.slice(1)}>`);
      i++;
      continue;
    }
    // The trailing positional is tjsc's INPUT (bytecode-rule-relative-input
    // above judges its exact spelling; here only its POSITION matters).
    out.push(i === tokens.length - 1 ? '<input>' : tok);
  }
  return out;
}

// The emitted COMMAND line, minus the program itself (cmake names it through
// the ${CLODE_HOST_TJSC} cache variable; the JS loop has it in a binding).
function emittedTjscArgv(emitted, outC) {
  const block = commandBlockFor(emitted, outC);
  assert.ok(block, `no add_custom_command OUTPUT for ${outC} in the emitted cmake`);
  const line = block.split('\n')[0].trim();
  const tokens = line.split(/\s+/);
  assert.strictEqual(tokens[0], 'COMMAND', 'the extracted block must start at COMMAND');
  assert.strictEqual(tokens[1], '${CLODE_HOST_TJSC}',
    'the emitted COMMAND must invoke the host tjsc cache variable');
  return tokens.slice(2);
}

// The imperative loop's argv, read out of build-tjs.cjs's source text: the
// array literal in `run(tjsc, ['-m', '-s', ...], { cwd: tjsDir })`. Identifiers
// (outAbs, name, prefix, inJs) stay as-is and are normalized away above.
function imperativeTjscArgv(buildSrc) {
  const line = buildSrc.split('\n').find((l) => l.includes("run(tjsc, ['-m'"));
  assert.ok(line, 'the imperative tjsc invocation (run(tjsc, [\'-m\'...) was not found');
  const open = line.indexOf('[');
  const close = line.indexOf(']', open);
  return line.slice(open + 1, close).split(',')
    .map((t) => t.trim().replace(/^'(.*)'$/, '$1'));
}

function assertEmittersAgreeOnTjscArgv({ emitted, outC, buildSrc }) {
  assert.deepStrictEqual(
    normalizeTjscArgv(emittedTjscArgv(emitted, outC)),
    normalizeTjscArgv(imperativeTjscArgv(buildSrc)),
    'the injected cmake COMMAND and regenBytecodeArrays must hand tjsc the SAME flags in '
    + 'the SAME order. They do not, which means one build path now compiles bytecode '
    + 'differently from the other — and the path that would ship the odd one out is '
    + '--regen-only, i.e. the netbsd-sparc in-guest bake, the one leg no CI log shows you '
    + 'the compiler command for');
}

function emitSample() {
  const fixup = loadFixup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-bytecode-argv-'));
  try {
    fs.writeFileSync(path.join(dir, 'CMakeLists.txt'),
      'add_executable(tjsc src/qjsc.c)\nadd_executable(tjs-cli src/main.c)\n');
    fixup(dir, SAMPLE_PAIRS);
    return fs.readFileSync(path.join(dir, 'CMakeLists.txt'), 'utf8');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('bytecode: both emitters hand tjsc the same flags, in the same order', () => {
  assertEmittersAgreeOnTjscArgv({
    emitted: emitSample(),
    outC: SAMPLE_PAIRS[0].outC,
    buildSrc: src,
  });
});

test('bytecode: PROOF — the argv-equality check rejects a flag added to one emitter only', () => {
  const emitted = emitSample();
  // (a) The imperative side gains a flag the cmake rule does not have. This is
  // the shape that ships: someone tunes --regen-only for the sparc guest, the
  // other 41 legs keep the old flags, and nothing says so.
  const impDrift = src.replace("run(tjsc, ['-m', '-s', '-o'",
    "run(tjsc, ['-m', '-s', '-M', '-o'");
  assert.notStrictEqual(impDrift, src, 'the imperative argv anchor moved — re-derive this PROOF');
  assert.throws(() => assertEmittersAgreeOnTjscArgv({ emitted, outC: SAMPLE_PAIRS[0].outC, buildSrc: impDrift }),
    /SAME flags in the SAME order/);

  // (b) The cmake side loses one. `-s` (strip) dropped from the rule alone
  // would leave 41 legs shipping unstripped bytecode and sparc shipping
  // stripped — a size and behaviour difference with no failure anywhere.
  const cmakeDrift = emitted.replace('${CLODE_HOST_TJSC} -m -s -o', '${CLODE_HOST_TJSC} -m -o');
  assert.notStrictEqual(cmakeDrift, emitted, 'the emitted COMMAND anchor moved — re-derive this PROOF');
  assert.throws(() => assertEmittersAgreeOnTjscArgv({ emitted: cmakeDrift, outC: SAMPLE_PAIRS[0].outC, buildSrc: src }),
    /SAME flags in the SAME order/);
});
