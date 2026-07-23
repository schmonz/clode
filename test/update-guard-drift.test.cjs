'use strict';
// Task 3: quaude-bootstrap.mjs cannot require('./update-guard.cjs') (it is
// compiled RAW to tjs bytecode with no local imports), so it carries an
// INLINE copy of guardVerdict. This test forces the two copies to move
// together: extract the text between the agreed
// `// >>> guardVerdict ... >>>` / `// <<< guardVerdict <<<` markers from both
// files and assert they are byte-identical (after trimming).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const START = /\/\/ >>> guardVerdict.*>>>\s*\n/;
const END = /\/\/ <<< guardVerdict <<</;

function extract(file) {
  const src = fs.readFileSync(file, 'utf8');
  const startMatch = START.exec(src);
  assert.ok(startMatch, `${file}: missing "// >>> guardVerdict ... >>>" marker`);
  const startIdx = startMatch.index + startMatch[0].length;
  const endMatch = END.exec(src);
  assert.ok(endMatch, `${file}: missing "// <<< guardVerdict <<<" marker`);
  assert.ok(endMatch.index > startIdx, `${file}: markers out of order`);
  return src.slice(startIdx, endMatch.index).trim();
}

test('quaude-bootstrap.mjs carries a byte-identical inline copy of update-guard.cjs\'s guardVerdict', () => {
  const canonical = extract(path.join(__dirname, '..', 'libexec', 'update-guard.cjs'));
  const inlined = extract(path.join(__dirname, '..', 'libexec', 'quaude-bootstrap.mjs'));
  assert.strictEqual(inlined, canonical);
});

const START_G = /\/\/ >>> guardGating.*>>>\s*\n/;
const END_G = /\/\/ <<< guardGating <<</;
function extractGating(file) {
  const src = fs.readFileSync(file, 'utf8');
  const sm = START_G.exec(src);
  assert.ok(sm, `${file}: missing guardGating start marker`);
  const startIdx = sm.index + sm[0].length;
  const em = END_G.exec(src);
  assert.ok(em, `${file}: missing guardGating end marker`);
  assert.ok(em.index > startIdx, `${file}: guardGating markers out of order`);
  return src.slice(startIdx, em.index).trim();
}

test('quaude-bootstrap.mjs carries a byte-identical inline copy of update-guard.cjs guardGating', () => {
  const canonical = extractGating(path.join(__dirname, '..', 'libexec', 'update-guard.cjs'));
  const inlined = extractGating(path.join(__dirname, '..', 'libexec', 'quaude-bootstrap.mjs'));
  assert.strictEqual(inlined, canonical);
});
