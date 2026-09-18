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

test('the rule passes a RELATIVE input path — the Windows symbol-name hazard', () => {
  // tjsc builds the C identifier from everything after the last '/' (get_c_name,
  // src/qjsc.c:191). An absolute Windows path has no '/', so it leaks whole into
  // the symbol: `const uint32_t tjs__internal_D:\a\_temp\...\path_size`. That is
  // one C2143 for the drive colon plus one C2017 per backslash, times 18 bundles.
  const fn = src.slice(src.indexOf('function fixupTjsCmakeBytecodeRules('));
  const body = fn.slice(0, fn.indexOf('\nfunction '));
  assert.match(body, /WORKING_DIRECTORY/,
    'the custom command must run in the source tree so a relative input resolves');
  assert.doesNotMatch(body, /\$\{CMAKE_CURRENT_BINARY_DIR\}[^\n]*-o[^\n]*\$\{CMAKE_CURRENT_SOURCE_DIR\}/,
    'do not pass an absolute input path');
});
