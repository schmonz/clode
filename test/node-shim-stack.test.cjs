'use strict';
// Characterization: tjs's default JS stack must be big enough to LOAD THE SHIM.
// txiki-default-stack-size.patch raises TJS__DEFAULT_STACK_SIZE from txiki's
// stock 1MB release default to 4MB, because the real extracted Claude Code
// bundle (cli.cjs, ~22MB minified) recurses past 1MB at startup and a stock tjs
// dies with "Maximum call stack size exceeded" before the CJS entry finishes
// evaluating — the SOLE wall on the `--version` boot (M2 milestone).
//
// WHAT THIS ASSERTS: the node-shim loader loads, under tjs, at the DEFAULT stack
// — no flags — which is the exact configuration the boot uses. That is the
// requirement. A stock 1MB tjs cannot do it: the loader overflows before it ever
// reaches the entry (measured on darwin-arm64, 2026-07-17). So this fails loudly
// if the patch is missing or tjs was not rebuilt, without asserting HOW the stack
// got big enough.
//
// WHY NOT A RECURSION DEPTH (it used to be `depth >= 3000`): frame SIZE is
// toolchain-specific, so a frame count measures the compiler, not the patch. The
// same 4MB bought 3966 frames here and 2123 on linux-x64-musl — which failed the
// hardcoded 3000 and kept node-shim-oracle red for weeks, while that very engine
// was building and PONGing a real quaude in the musl leg. I.e. the test called a
// working engine broken. "The loader loads" has no such calibration to get wrong.
//
// (Do not rebuild this on `--stack-size`: passing an explicit 4194304 makes the
// loader overflow even though the patched 4MB DEFAULT runs it fine, so that flag
// does not map onto the limit this patch sets. The default is the thing that
// ships and the thing the boot uses; test that.)
//
// The real bundle actually booting is proven where it belongs — the PONG smoke in
// every tjs leg. This is the cheap canary that names the cause.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

test('tjs loads the node-shim at its default stack (a stock 1MB tjs cannot)', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-stack-'));
  const f = path.join(dir, 'entry.cjs');
  // Deliberately trivial: the stack this test is about is spent LOADING the shim,
  // not running the entry. Anything the entry does would only muddy the signal.
  fs.writeFileSync(f, 'console.log(JSON.stringify({ loaded: true }));\n');

  const r = runLoader(f);
  assert.strictEqual(r.status, 0,
    'tjs could not load the node-shim at its DEFAULT stack — the boot wall is back; '
    + `is txiki-default-stack-size.patch applied and tjs rebuilt?\n${r.stderr}`);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), { loaded: true },
    `the shim loaded but the entry did not run cleanly: ${r.stdout}`);
});
