'use strict';
// Characterization: the loader's minimal ESM->CJS transpile + Intl.Segmenter
// polyfill let the ESM-only text deps in deps/claude (string-width / strip-ansi and
// their ESM graph) load and run under tjs with results identical to the genuine
// packages under host node. (wrap-ansi was characterized here too until it left
// deps/claude on 2026-09-26: Bun.wrapAnsi is libexec/unicode-text.cjs's now.) The -p
// boot's Bun.stringWidth path depends on this. The oracle is the SAME packages loaded
// via host node's native ESM (dynamic import), so this asserts real equivalence, not a
// hand-rolled table.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

const ESC = String.fromCharCode(27);
const INPUTS = ['PONG', 'hello world', ESC + '[31mred' + ESC + '[0m', '古池や', 'a' + '\u0301'];

// Oracle: the real ESM packages under host node.
async function hostWidths() {
  const root = path.resolve(__dirname, '..', 'deps', 'claude', 'node_modules');
  const sw = (await import(path.join(root, 'string-width', 'index.js'))).default;
  const sa = (await import(path.join(root, 'strip-ansi', 'index.js'))).default;
  return {
    widths: INPUTS.map((s) => sw(s)),
    stripped: sa(ESC + '[31mred' + ESC + '[0m'),
  };
}

test('ESM text deps (string-width/strip-ansi) match host node under tjs', async (t) => {
  if (skipUnlessTjs(t)) return;
  const oracle = await hostWidths();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-esm-'));
  const f = path.join(dir, 'esm.cjs');
  // require() the ESM packages THROUGH the loader (transpiled) and emit the same
  // measurements; NODE_PATH points the loader's resolver at the repo deps.
  fs.writeFileSync(f, `
const D = (m) => (m && m.default) || m; // same interop bun-shim uses for ESM deps
const stringWidth = D(require('string-width'));
const stripAnsi = D(require('strip-ansi'));
const ESC = String.fromCharCode(27);
const INPUTS = ['PONG', 'hello world', ESC + '[31mred' + ESC + '[0m', '古池や', 'a' + '\\u0301'];
console.log(JSON.stringify({
  widths: INPUTS.map((s) => stringWidth(s)),
  stripped: stripAnsi(ESC + '[31mred' + ESC + '[0m'),
}));
`);
  const r = runLoader(f, [], { env: { NODE_PATH: path.resolve(__dirname, '..', 'deps', 'claude', 'node_modules') } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), oracle);
});
