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
// way outC already legitimately is prefixed) unchanged — proven below. The
// property that matters is a SHAPE: the trailing positional argument of the
// emitted COMMAND (tjsc's input) must be the bare relative inJs, with no
// ${CMAKE_CURRENT_SOURCE_DIR}/ or ${CMAKE_CURRENT_BINARY_DIR}/ prefix — everything
// else in the line (-o's target, DEPENDS) is legitimately absolute. So we call
// the real fixup against a fixture CMakeLists and inspect what it wrote.

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
  assert.ok(outIdx > -1, `no OUTPUT for ${outC} in emitted cmake`);
  const commandIdx = emitted.indexOf('COMMAND ', outIdx);
  const blockEnd = emitted.indexOf('VERBATIM)', commandIdx);
  return emitted.slice(commandIdx, blockEnd);
}

// The one assertion this whole test exists to make airtight: tjsc's trailing
// input argument is the bare relative inJs, character-for-character — not
// "contains inJs" (an absolute-prefixed path also contains it), not "no
// CMAKE_CURRENT_BINARY_DIR nearby" (misses a CMAKE_CURRENT_SOURCE_DIR prefix,
// the actual shape this fixup itself would produce if outC's prefixing style
// leaked onto inJs). Also folds in the WORKING_DIRECTORY check the first draft
// asserted separately and weakly: a relative input only resolves correctly
// because cwd is the source tree, so the two are checked as one property, in
// the same custom_command block.
function assertRelativeTjscInput(commandBlock, inJs) {
  const commandLineEnd = commandBlock.indexOf('\n');
  const commandLine = commandBlock.slice(0, commandLineEnd === -1 ? undefined : commandLineEnd);
  const tokens = commandLine.trim().split(/\s+/);
  const last = tokens[tokens.length - 1];
  assert.strictEqual(last, inJs,
    `tjsc's input argument must be the bare relative path "${inJs}"; got "${last}" — an `
    + 'absolute path here leaks straight into the generated C symbol name '
    + '(get_c_name, src/qjsc.c:191): on Windows, the drive colon and every backslash '
    + 'each become a distinct C syntax error, times every bundle.');
  assert.match(commandBlock, /WORKING_DIRECTORY \$\{CMAKE_CURRENT_SOURCE_DIR\}/,
    'WORKING_DIRECTORY must be the source tree, in the SAME block as this COMMAND — '
    + 'that is what makes the relative input above resolve at all');
}

test('the emitted rule hands tjsc a bare relative input path, not an absolute one', () => {
  const fixup = loadFixup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-bytecode-rule-'));
  try {
    fs.writeFileSync(path.join(dir, 'CMakeLists.txt'),
      'add_executable(tjsc src/qjsc.c)\nadd_executable(tjs-cli src/main.c)\n');
    fixup(dir, SAMPLE_PAIRS);
    const emitted = fs.readFileSync(path.join(dir, 'CMakeLists.txt'), 'utf8');
    for (const { outC, inJs } of SAMPLE_PAIRS) {
      assertRelativeTjscInput(commandBlockFor(emitted, outC), inJs);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('PROOF: the shape assertion rejects the realistic regression (input made absolute)', () => {
  // The regression this gate exists to catch: someone "cleans up" the rule by
  // prefixing tjsc's input the same way outC already legitimately is — the
  // change that shipped, unnoticed, as `const uint32_t tjs__internal_D:\...`.
  // Construct it by hand and confirm the tightened assertion actually rejects
  // it — a negative assertion nobody has watched reject a real bad input is
  // not yet a gate.
  const goodBlock = 'COMMAND ${CLODE_HOST_TJSC} -m -s -o ${CMAKE_CURRENT_SOURCE_DIR}/src/bundles/c/core/polyfills.c'
    + ' -n "tjs:internal/polyfills" -p tjs__ src/bundles/js/core/polyfills.js\n'
    + '    WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}\n';
  assertRelativeTjscInput(goodBlock, 'src/bundles/js/core/polyfills.js'); // sanity: the good shape passes

  const regressedBlock = goodBlock.replace(
    'src/bundles/js/core/polyfills.js\n',
    '${CMAKE_CURRENT_SOURCE_DIR}/src/bundles/js/core/polyfills.js\n');
  let caught = null;
  try {
    assertRelativeTjscInput(regressedBlock, 'src/bundles/js/core/polyfills.js');
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, 'the tightened assertion must throw on an absolute-input emission, and did not');
  assert.match(caught.message, /must be the bare relative path/);
  console.log(`PROOF captured rejection: ${caught.message}`);
});
