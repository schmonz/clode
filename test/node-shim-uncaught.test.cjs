'use strict';
// Uncaught exceptions from timer callbacks must route through
// process.emit('uncaughtException') — matching host node — so a registered
// handler runs and the PROCESS SURVIVES. Claude Code installs an
// uncaughtException handler (crash telemetry + recovery); without this routing,
// a throw inside a setTimeout callback (the AsyncAgent stall watchdog is one)
// bypasses that handler and HARD-CRASHES the process. Real daily-driver bug:
// a background subagent's stall-watchdog callback threw a "not a function" that
// native Claude Code logs-and-continues, but quaude died on. Diff-reducing vs
// naude (which runs on real node and already has this).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

// A setTimeout callback throws; a registered uncaughtException handler must catch
// it and the process must keep running long enough to hit the later timer. The
// observable answer must match host node exactly.
const PROG = `
const out = [];
process.on('uncaughtException', (e) => { out.push('caught:' + e.message); });
setTimeout(() => { throw new TypeError('boom is not a function'); }, 0);
setTimeout(() => { out.push('survived'); console.log(JSON.stringify(out)); process.exit(0); }, 80);
`;

test('timer-callback throw routes to uncaughtException + survives, vs host node', (t) => {
  if (skipUnlessTjs(t)) return;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-uncaught-'));
  const f = path.join(base, 'prog.cjs');
  fs.writeFileSync(f, PROG);
  const nodeOut = require('node:child_process')
    .execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim();
  // Sanity: host node must itself survive-and-report (guards against a bad fixture).
  assert.strictEqual(nodeOut, '["caught:boom is not a function","survived"]');
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, `shim did not survive (exit ${r.status}); stderr:\n${r.stderr}`);
  assert.strictEqual(r.stdout.trim(), nodeOut);
});

// With NO uncaughtException handler, a timer-callback throw must still terminate
// non-zero (node's default: print + exit 1) — the fix must not silently swallow.
const PROG_NOHANDLER = `
setTimeout(() => { throw new TypeError('unhandled boom'); }, 0);
setTimeout(() => { console.log('SHOULD-NOT-REACH'); process.exit(0); }, 80);
`;

test('timer-callback throw with no handler still exits non-zero', (t) => {
  if (skipUnlessTjs(t)) return;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-uncaught-nh-'));
  const f = path.join(base, 'prog.cjs');
  fs.writeFileSync(f, PROG_NOHANDLER);
  const r = runLoader(f);
  assert.notStrictEqual(r.status, 0, 'a throw with no handler must not exit 0');
  assert.ok(!/SHOULD-NOT-REACH/.test(r.stdout), 'must not continue past an unhandled throw');
});
