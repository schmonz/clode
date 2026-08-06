'use strict';
// A timer must never fire EARLY, however much work ran before it was armed.
//
// Engine bug fixed 2026-08-06 (patches/txiki-timer-update-time.patch): libuv
// schedules a timer at `loop->time + delay` and only refreshes `loop->time` at
// the top of each uv_run iteration. txiki's setTimeout called uv_timer_start
// without uv_update_time first, so every timer armed during the INITIAL
// synchronous execution used the clock as of loop init — firing early by exactly
// however long the script had already been running.
//
// Measured before the fix, on BARE tjs: burn 120ms, then setTimeout(200) fired
// after 81ms (119ms early). It surfaced through the node-shim, whose ~33ms of
// startup made the bundle's first timer fire ~33ms early — but the defect is the
// engine's and scales with whatever ran first, so these run the bare engine.
//
// It cost real debugging time in a way the size understates: an
// AbortSignal.timeout(700) fetch rejected at 667ms, which reads as a fetch
// aborting BEFORE its own signal could fire until you separate the two events.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { skipUnlessTjs, engineSpawn } = require('./node-shim-helper.cjs');

// Burn synchronously, THEN arm. `armed` is captured after the burn, so a correct
// engine reports ~delay no matter how large the burn is.
function fixture(burnMs, delayMs) {
  return `
    const t0 = Date.now();
    while (Date.now() - t0 < ${burnMs}) { /* spin */ }
    const armed = Date.now();
    setTimeout(() => { console.log(JSON.stringify({ actual: Date.now() - armed })); }, ${delayMs});
  `;
}

function runBoth(burnMs, delayMs) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'timer-clock-'));
  const f = path.join(dir, 'p.js');
  fs.writeFileSync(f, fixture(burnMs, delayMs));
  try {
    const [cmd, argv] = engineSpawn(['run', f]);
    const t = spawnSync(cmd, argv, { encoding: 'utf8', timeout: 30000 });
    const n = execFileSync(process.execPath, [f], { encoding: 'utf8', timeout: 30000 });
    return {
      tjs: JSON.parse((t.stdout || '').trim() || '{}'),
      node: JSON.parse(n.trim()),
      stderr: t.stderr || '',
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// EARLY is the bug and is never acceptable; LATE is ordinary scheduler noise on
// a loaded box, so the bound is deliberately one-sided and generous upward.
const EARLY_TOLERANCE_MS = 25;

for (const burn of [0, 60, 150]) {
  test(`tjs timers: setTimeout(200) armed after ${burn}ms of sync work does not fire early`, (t) => {
    if (skipUnlessTjs(t)) return;
    const { tjs, node, stderr } = runBoth(burn, 200);
    assert.ok(typeof tjs.actual === 'number', `no engine result; stderr: ${stderr}`);
    // Pre-fix, burn=150 produced actual≈50 here against node's ≈205.
    assert.ok(tjs.actual >= 200 - EARLY_TOLERANCE_MS,
      `fired ${200 - tjs.actual}ms EARLY (actual=${tjs.actual}ms, node=${node.actual}ms) — ` +
      'the loop clock was stale when the timer was armed');
    // Sanity-anchor the oracle so a broken fixture cannot make this vacuous.
    assert.ok(node.actual >= 200 - EARLY_TOLERANCE_MS,
      `node oracle itself fired early (${node.actual}ms) — fixture is wrong, not the engine`);
  });
}

// The scaling property is what identifies THIS bug rather than generic jitter:
// pre-fix the error tracked the burn exactly (burn 120 -> 119ms early), so a
// bigger burn must not produce a bigger error.
test('tjs timers: the error does NOT scale with work done before arming', (t) => {
  if (skipUnlessTjs(t)) return;
  const small = runBoth(0, 200);
  const large = runBoth(300, 200);
  assert.ok(typeof small.tjs.actual === 'number' && typeof large.tjs.actual === 'number');
  const drift = small.tjs.actual - large.tjs.actual;   // pre-fix: ≈300
  assert.ok(drift < 100,
    `a 300ms burn shifted the timer by ${drift}ms (small=${small.tjs.actual}, large=${large.tjs.actual}) — ` +
    'the deadline is still being computed from a stale loop clock');
});
