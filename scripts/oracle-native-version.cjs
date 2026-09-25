#!/usr/bin/env node
'use strict';
// Print the Claude Code version libexec/unicode-text.cjs's generated table was built
// from, so CI installs EXACTLY that native as the text oracle. One source: the header.
//
// It judges, it is never built from: the text gates (test/fidelity/text-differential,
// test/unicode-data-fresh, scripts/cell-profile-diff.cjs) SKIP or refuse against any other
// native (ruling R11), so a CI job that installed the wrong one would go green having judged
// nothing. UPSTREAM_PIN is a different question (what quaude is built from) and may lag.
//
// Exit 0 printing `x.y.z`, or 2 refusing (no generated region, or a header naming no
// version) — a CI step that cannot name its oracle must fail, not install `@undefined`.
// test/build-gates/oracle-native-version-gates.test.cjs controls both refusals.
const fs = require('node:fs');
const path = require('node:path');

function oracleNativeVersion(src) {
  const m = src.match(/const UNICODE_DATA = (\{.*\});\n/);
  if (!m) throw new Error('no generated UNICODE_DATA in libexec/unicode-text.cjs');
  const header = JSON.parse(m[1]).header || {};
  const v = (String(header.nativeClaude || '').match(/^\d+\.\d+\.\d+/) || [])[0];
  if (!v) throw new Error(`the generated header names no Claude version (nativeClaude: ${JSON.stringify(header.nativeClaude)})`);
  return v;
}

module.exports = { oracleNativeVersion };

if (require.main === module) {
  try {
    const src = fs.readFileSync(path.join(__dirname, '..', 'libexec', 'unicode-text.cjs'), 'utf8');
    process.stdout.write(oracleNativeVersion(src) + '\n');
  } catch (e) {
    process.stderr.write(`oracle-native-version: ${e.message}\n`);
    process.exit(2);
  }
}
