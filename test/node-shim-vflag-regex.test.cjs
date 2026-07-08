'use strict';
// Characterization: the loader rewrites `v`-flag (unicodeSets) regex character
// classes built solely of Unicode property escapes into the equivalent
// alternation, working around a quickjs-ng (this tjs) libregexp bug where such a
// class matches characters it must NOT (e.g. `/[\p{Control}\p{Format}]/v` matches
// the ASCII letter "t"). That bug made string-width@>=7 throw
// `Expected a code point, got undefined` inside Claude Code's REPL module init,
// leaving the TUI unpainted (13-byte paint stall). See
// spike/quickjs/results/phase3-m1-tui-boot.md.
//
// Oracle = host node's genuinely-correct property-escape semantics.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLoader, skipUnlessTjs, REPO } = require('./node-shim-helper.cjs');

test('v-flag property-escape char classes behave like host node under tjs', (t) => {
  if (skipUnlessTjs(t)) return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-vflag-'));
  const f = path.join(dir, 'vflag.cjs');
  // Literal v-flag classes of only property escapes: the loader rewrites these to
  // alternations, so they must match ONLY their property members (not "t"/"a").
  fs.writeFileSync(f, `
const lead = /^[\\p{Default_Ignorable_Code_Point}\\p{Control}\\p{Format}\\p{Mark}\\p{Surrogate}]+/v;
const zero = /^(?:\\p{Default_Ignorable_Code_Point}|\\p{Control}|\\p{Format}|\\p{Mark}|\\p{Surrogate})+$/v;
const out = {
  leadMatchesT: lead.test('t'),           // must be false
  leadStripsT: 't'.replace(lead, ''),     // must stay 't'
  zeroMatchesT: zero.test('t'),           // must be false
  // a genuine zero-width char (ZWSP U+200B, a Format char) must still match:
  leadMatchesZwsp: lead.test('\\u200B'),  // must be true
};
console.log(JSON.stringify(out));
`);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim());
  assert.strictEqual(out.leadMatchesT, false, 'v-flag class must not match ASCII "t"');
  assert.strictEqual(out.leadStripsT, 't', 'baseVisible("t") must stay "t"');
  assert.strictEqual(out.zeroMatchesT, false, 'alternation must not match "t"');
  assert.strictEqual(out.leadMatchesZwsp, true, 'must still match a real zero-width char');
});

test('string-width on mixed non-ASCII+ASCII input matches host node (no throw)', async (t) => {
  if (skipUnlessTjs(t)) return;
  // This exact shape ("←/→ to navigate ·") is what Claude Code's REPL footer
  // measures at init: non-ASCII (bypasses string-width's ASCII fast path) with
  // ASCII-letter graphemes that the buggy class would strip to "".
  const INPUT = '←/→ to navigate · ';
  const root = path.join(REPO, 'node_modules');
  const oracle = (await import(path.join(root, 'string-width', 'index.js'))).default(INPUT);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-sw-'));
  const f = path.join(dir, 'sw.cjs');
  fs.writeFileSync(f, `
const D = (m) => (m && m.default) || m;
const stringWidth = D(require('string-width'));
console.log(String(stringWidth(${JSON.stringify(INPUT)})));
`);
  const r = runLoader(f, [], { env: { NODE_PATH: root } });
  assert.strictEqual(r.status, 0, 'string-width must not throw under tjs: ' + r.stderr);
  assert.strictEqual(Number(r.stdout.trim()), oracle, 'width must equal host node');
});
