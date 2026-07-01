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

// Resolving node-pty is NOT enough: it spawns through a prebuilt `spawn-helper`
// binary that must be EXECUTABLE. An extraction/copy that drops the +x bit leaves
// resolve() green but every pty.spawn() failing with "posix_spawnp failed" at test
// time. So do a real spawn smoke; if it trips, restore the +x bit on any bundled
// spawn-helper and retry once before failing loud.
const fs = require('node:fs');
function chmodSpawnHelpers() {
  let fixed = 0;
  const base = path.dirname(req.resolve('node-pty'));            // .../node-pty/lib
  const prebuilds = path.join(base, '..', 'prebuilds');
  let dirs = [];
  try { dirs = fs.readdirSync(prebuilds); } catch { /* none */ }
  for (const d of dirs) {
    const h = path.join(prebuilds, d, 'spawn-helper');
    try { fs.chmodSync(h, 0o755); fixed++; } catch { /* not this platform */ }
  }
  return fixed;
}
function spawnSmoke() {
  const pty = req('node-pty');
  const child = pty.spawn('/bin/sh', ['-c', 'exit 0'], { name: 'xterm-256color', cols: 20, rows: 5 });
  try { child.kill(); } catch { /* already gone */ }
}
try {
  spawnSmoke();
} catch (e) {
  if (process.platform !== 'win32' && /posix_spawn|spawn-helper|EACCES|ENOENT/i.test(String(e && e.message))) {
    const n = chmodSpawnHelpers();
    if (n) process.stderr.write('preflight: restored +x on ' + n + ' node-pty spawn-helper(s)\n');
    try {
      spawnSmoke();
    } catch (e2) {
      process.stderr.write('node-pty cannot spawn a pty even after fixing spawn-helper perms: ' + (e2 && e2.message) + '\n');
      process.exit(1);
    }
  } else {
    process.stderr.write('node-pty cannot spawn a pty: ' + (e && e.message) + '\n');
    process.exit(1);
  }
}
process.exit(0);
