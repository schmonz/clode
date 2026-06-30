#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { createRequire } = require('node:module');
// The PTY/TUI harness deps live in a SEPARATE manifest (test/package.json ->
// test/node_modules), NOT the root package.json. The root node_modules must stay
// free of the shipped runtime deps (the fail-loud ext-dep tests require their
// absence), so the harness can't ride along on a root `npm install`. Resolve as a
// file under test/ would, so it finds test/node_modules.
const req = createRequire(path.join(__dirname, 'package.json'));
const missing = [];
for (const m of ['node-pty', '@xterm/headless']) {
  try { req.resolve(m); } catch { missing.push(m); }
}
if (missing.length) {
  process.stderr.write(
    'test harness deps missing: ' + missing.join(', ') + '\n' +
    'run `npm install --prefix test` in the repo (node-pty needs a prebuilt binary or a C++ toolchain).\n' +
    'These are test-only deps (test/package.json) — they are NOT part of the shipped package.\n');
  process.exit(1);
}
process.exit(0);
