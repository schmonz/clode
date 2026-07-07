'use strict';
// Characterization: the patched tjs default JS stack size (txiki-default-stack-
// size.patch bumps TJS__DEFAULT_STACK_SIZE from txiki's stock 1MB release
// default to 4MB). The real extracted Claude Code bundle (cli.cjs, ~22MB
// minified) recurses deeper at startup than 1MB admits, so a stock tjs
// overflows with "Maximum call stack size exceeded" before the CJS entry
// finishes evaluating — the SOLE wall on the `--version` boot (M2 milestone).
//
// This is a CAPACITY wall, so the invariant is not exact depth-equality with
// host node (engine-specific), but that BOTH host node and the patched tjs
// admit a recursion depth the boot requires — comfortably past the ~1034
// frames the stock 1MB default allowed for this frame shape. The fixture
// descends until it overflows and reports the depth reached; the run itself
// goes through the loader at the DEFAULT stack (no --stack-size flag), i.e. the
// exact configuration the `--version` boot uses.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

// Depth the stock 1MB default reached for this frame shape was ~1034; the real
// bundle needs more than 1MB to boot. 3000 is safely above the stock ceiling
// and comfortably below what the 4MB patched default (~4x) admits.
const THRESHOLD = 3000;
const PROG = `
function depth(n) { try { return depth(n + 1); } catch (e) { return n; } }
const d = depth(0);
console.log(JSON.stringify({ ok: d >= ${THRESHOLD}, depth: d }));
`;

test('patched tjs default stack admits the recursion depth the bundle boot needs', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-stack-'));
  const f = path.join(dir, 'depth.cjs');
  fs.writeFileSync(f, PROG);

  const nodeOut = JSON.parse(require('node:child_process')
    .execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  assert.strictEqual(nodeOut.ok, true, `host node only reached depth ${nodeOut.depth}`);

  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  const tjsOut = JSON.parse(r.stdout.trim());
  assert.strictEqual(tjsOut.ok, true,
    `patched tjs only reached depth ${tjsOut.depth} (< ${THRESHOLD}); ` +
    `is txiki-default-stack-size.patch applied and tjs rebuilt?`);
});
