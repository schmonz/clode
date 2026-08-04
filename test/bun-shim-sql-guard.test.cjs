'use strict';
// Bun.SQL is upstream's guarded "claude gateway" path: upstream checks
// `typeof Bun > "u"` before ever touching Bun.SQL, which is true (guard fires,
// friendly message) under real Node but FALSE under quaude/naude because
// bun-shim.cjs defines a Bun global at all. That defeat let control fall
// through to `new Bun.SQL(...)`, which the shim never implemented, so the user
// saw the bare, unhelpful "Bun.SQL is not a constructor" instead of upstream's
// own "claude gateway requires the native binary". We keep the Bun global
// (removing it breaks far more than this) and instead give Bun.SQL a
// constructor that throws upstream's own message. Contrast Bun.WebView, which
// is correctly ABSENT from the shim so upstream's `"WebView" in Bun`
// feature-detect reads false and that branch is skipped cleanly — adding SQL
// must not disturb that pattern for WebView or anything else.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLoader, skipUnlessTjs, REPO } = require('./node-shim-helper.cjs');

const SHIM = path.join(REPO, 'libexec/bun-shim.cjs');

function writeProg(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bun-shim-sql-'));
  const f = path.join(dir, 'p.cjs');
  fs.writeFileSync(f, `require(${JSON.stringify(SHIM)});\n${body}`);
  return f;
}

test('Bun.SQL throws upstream\'s own gateway message, not "not a constructor"', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = writeProg(`
    try { new Bun.SQL('x'); console.log('NO-THROW'); }
    catch (e) { console.log('THREW: ' + e.message); }
  `);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /THREW: claude gateway requires the native binary/,
    'upstream guards this path with typeof Bun > "u", which our Bun global defeats; ' +
    'SQL must throw upstream\'s own message instead of "Bun.SQL is not a constructor"');
  assert.doesNotMatch(r.stdout, /not a constructor/);
});

test('"WebView" in Bun still reads false (SQL addition does not disturb other feature-detects)', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = writeProg(`console.log(JSON.stringify({ webview: "WebView" in Bun, sql: "SQL" in Bun }));`);
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), { webview: false, sql: true });
});
