'use strict';
// Task 3: quaude-bootstrap.mjs's inline guardVerdict is PURE (no tjs globals
// touched in its body) but lives inside a `tjs:`-importing ES module that
// cannot be require()'d or --check'd under host node. Extract just the
// marked source (same markers test/update-guard-drift.test.cjs checks for
// byte-identity), `new Function` it, and assert it produces the SAME
// verdicts as the canonical libexec/update-guard.cjs for the same corpus
// test/update-guard.test.cjs exercises.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { guardVerdict: canonicalGuardVerdict } = require('../libexec/update-guard.cjs');

const START = /\/\/ >>> guardVerdict.*>>>\s*\n/;
const END = /\/\/ <<< guardVerdict <<</;

function loadInlinedGuardVerdict() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'libexec', 'quaude-bootstrap.mjs'), 'utf8');
  const startMatch = START.exec(src);
  assert.ok(startMatch, 'quaude-bootstrap.mjs: missing "// >>> guardVerdict ... >>>" marker');
  const startIdx = startMatch.index + startMatch[0].length;
  const endMatch = END.exec(src);
  assert.ok(endMatch, 'quaude-bootstrap.mjs: missing "// <<< guardVerdict <<<" marker');
  const body = src.slice(startIdx, endMatch.index).trim();
  // The marked block is plain top-level statements (consts + a function
  // declaration), not an expression — wrap it in a Function body that
  // declares them, then returns the function, so the caller gets a callable.
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${body}\nreturn guardVerdict;`);
  return factory();
}

const CORPUS = {
  deny: [
    'claude update',
    'bash -c "claude update"',
    'npm i -g @anthropic-ai/claude-code',
  ],
  allow: [
    'claude --version',
    'npm i lodash',
  ],
};

test('quaude-bootstrap.mjs inline guardVerdict matches libexec/update-guard.cjs on the shared corpus', () => {
  const inlined = loadInlinedGuardVerdict();
  for (const cmd of CORPUS.deny) {
    assert.deepStrictEqual(inlined(cmd), canonicalGuardVerdict(cmd), `deny mismatch for: ${cmd}`);
    assert.ok(canonicalGuardVerdict(cmd), `corpus sanity: expected canonical DENY for: ${cmd}`);
  }
  for (const cmd of CORPUS.allow) {
    assert.deepStrictEqual(inlined(cmd), canonicalGuardVerdict(cmd), `allow mismatch for: ${cmd}`);
    assert.strictEqual(canonicalGuardVerdict(cmd), null, `corpus sanity: expected canonical ALLOW for: ${cmd}`);
  }
});
