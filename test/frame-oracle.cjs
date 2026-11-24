#!/usr/bin/env node
'use strict';
// frame-oracle.cjs — drive a REFERENCE and a SUBJECT through the same scripted
// session under a pty and report, cell by cell, how the screens differ.
//
// This is the instrument for `Bun.ant.CellSegmenter`: the only ground truth for
// a screen model is the screen native Claude Code actually paints, so the
// reference is the native binary and the subject is a built quaude. What it can
// and cannot distinguish is PROVEN in test/frame-diff.test.cjs — read that
// before trusting an answer from here.
//
// It is a CLI and deliberately NOT a test: it spawns real Claude Code builds,
// which on darwin reach the Keychain, so it runs when a human asks for it.
//
// NEVER uses real credentials. A local canned mock (test/mock-anthropic-helper)
// stands in for the Messages API and ANTHROPIC_BASE_URL points at it, so a
// scripted turn costs nothing and reaches no network.
//
//   node test/frame-oracle.cjs --ref /path/to/claude --sub /path/to/quaude \
//       [--rows 40] [--cols 100] [--send HEX [--until TEXT]]... [--resize COLSxROWS]... \
//       [--wait MS]... [--out DIR]
//
// The steps run in order once boot has settled, and the frames compared are each side's LAST
// step's, taken once that step's output has settled (tui-screen.cjs --script); --until holds the
// --send before it until TEXT is on screen. With no step the frames are the settled boot screen.
// There is no fixed window: a frame taken at a clock time is a guess a loaded box outruns
// (test/fixed-window-captures.test.cjs).
//
// Exit 0 when the frames match, 1 when they differ, 2 on a harness failure.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sandbox } = require('./e2e.cjs');
const { captureSession, seedClaudeProfile } = require('./e2e-pty.cjs');
const { debugFileArgs, readLog, assertDebugLogClean } = require('./debug-log-gate.cjs');
const { diff, describe } = require('./frame-diff.cjs');
const { startMockAnthropic } = require('./mock-anthropic-helper.cjs');

function parse(argv) {
  const o = { rows: 40, cols: 100, script: [], out: null };
  const step = (k, v) => { o.script.push({ label: `step ${o.script.length + 1}`, [k]: v }); };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const v = argv[i + 1];
    if (a === '--ref') { o.ref = v; i++; } else if (a === '--sub') { o.sub = v; i++; } else if (a === '--rows') { o.rows = parseInt(v, 10); i++; } else if (a === '--cols') { o.cols = parseInt(v, 10); i++; } else if (a === '--send') { step('send', v); i++; } else if (a === '--resize') { step('resize', v); i++; } else if (a === '--wait') { step('wait', parseInt(v, 10)); i++; } else if (a === '--until') {
      const last = o.script[o.script.length - 1];
      if (!last || last.send === undefined) { process.stderr.write('frame-oracle: --until follows a --send\n'); process.exit(2); }
      last.until = v; i++;
    } else if (a === '--out') { o.out = v; i++; } else {
      process.stderr.write(`frame-oracle: unknown argument ${a}\n`); process.exit(2);
    }
  }
  if (!o.ref || !o.sub) { process.stderr.write('usage: frame-oracle.cjs --ref BIN --sub BIN [--rows R] [--cols C] [--send HEX [--until TEXT]]... [--resize COLSxROWS]... [--wait MS]... [--out DIR]\n'); process.exit(2); }
  if (o.script.length === 0) o.script = undefined;
  return o;
}

// Capture a REFERENCE and a SUBJECT frame through the same scripted pty session
// against the canned mock. Returns { ref, sub, settled: { ref, sub }, debugLog } (a frame
// may be null, with the reason written to stderr). Shared by the CLI below and by
// test/fidelity/interactive-frame-diff.test.cjs, so the gate measures exactly
// what an operator measures by hand.
//
// The frame is each side's LAST step's (o.script, tui-screen.cjs --script steps), taken once
// that step's output has settled; with no script, the settled boot screen. `settled` says
// whether it did: a frame taken at its step's cap is a finding for the caller, never a frame
// to compare as if it were the answer. This used to be a fixed window (`seconds`, keys at
// fixed delays), which a loaded box outruns (test/fixed-window-captures.test.cjs).
//
// Both sides get the same scene: `mockText` is what the canned mock answers a turn
// with (default PONG), `env` is extra environment for the child, and `settings` is
// written to its ~/.claude/settings.json. The capture is ASYNCHRONOUS: the mock lives
// in this process, and a synchronous capture froze it for the whole run, so a typed
// turn spun forever without the mock ever seeing a request (measured 2026-09-25).
async function captureFrames(o) {
  const script = o.script || [{ label: 'boot settled', wait: 1 }];
  const opts = { script, settleMs: o.settleMs, maxSettleMs: o.maxSettleMs, bootSettleMs: o.bootSettleMs,
    bootMaxMs: o.bootMaxMs, rows: o.rows, cols: o.cols };
  const meta = new WeakMap();   // frame -> whether its session reached and settled its last step
  const r = await inScene(o, async (sbx, env, cmd) => {
    const s = await captureSession(sbx, { ...opts, env, cmd });
    const last = s.frames[s.frames.length - 1];
    if (!last) throw new Error('the session produced no frame');
    // a side that died before its last step has fewer frames than steps + boot: not settled
    meta.set(last.frame, last.settled && s.frames.length === script.length + 1);
    return last.frame;
  });
  const settled = { ref: !!(r.ref && meta.get(r.ref)), sub: !!(r.sub && meta.get(r.sub)) };
  return { ref: r.ref, sub: r.sub, settled, debugLog: r.debugLog };
}

// The same two-sided capture for a SCRIPTED SESSION (tui-screen.cjs --script): a frame
// per step, each taken when output settles. o: { ref, sub, script, settleMs, maxSettleMs,
// bootSettleMs, bootMaxMs, rows, cols, mockText, env, settings, out }; unset limits take
// tui-screen's measured defaults. Returns { ref, sub }, each { format, exit, frames } or
// null. Same scene, mock and fresh-HOME rule as captureFrames, because it is inScene too.
async function captureSessions(o) {
  const opts = { script: o.script, settleMs: o.settleMs, maxSettleMs: o.maxSettleMs,
    bootSettleMs: o.bootSettleMs, bootMaxMs: o.bootMaxMs, rows: o.rows, cols: o.cols };
  return inScene(o, (sbx, env, cmd) => captureSession(sbx, { ...opts, env, cmd }));
}

// THE SCENE both captures run in, stated once: one canned mock for both sides, the same
// environment and settings, a fresh identically seeded HOME per side, the reference first
// and then the subject (sequential, so the two never compete for the machine).
// capture(sbx, env, cmd) takes one side's shot; a shot that throws is reported and null.
//
// THE DEBUG LOG (test/debug-log-gate.cjs): each side runs with a --debug-file in its own sandbox, and once both shots
// are taken the SUBJECT's log is held to the reference's. A finding throws, with the lines, so every frame and session
// gate built on this fails on what quaude logged, not only on what it painted. The judgement is the result's debugLog.
async function inScene(o, capture) {
  const mock = await startMockAnthropic({ text: o.mockText || 'PONG' });
  const out = o.out || null;
  if (out) fs.mkdirSync(out, { recursive: true });

  // The driver's own scratch locators (it loads node-pty from the per-platform
  // harness dir), plus the mock endpoint and a hard no to the auto-updater.
  const env = {
    ANTHROPIC_BASE_URL: mock.url,
    ANTHROPIC_API_KEY: 'sk-ant-mock-0000000000000000000000',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
  };
  for (const k of ['TMPDIR', 'CLODE_BUILD_SCRATCH']) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, o.env || {});

  // A FRESH HOME PER CAPTURE, not one shared sandbox. tui-screen ends a capture
  // with SIGKILL, and a Claude Code killed inside the fullscreen renderer leaves
  // a "didn't finish starting" marker in its profile; the NEXT process to read
  // that HOME silently falls back to the classic renderer. Sharing one HOME
  // therefore compares the reference's fullscreen frame against the subject's
  // classic-renderer frame — measured here on 2026-09-22, and it made a
  // native-vs-native run differ in 1431 cells. Same seed, separate state.
  const logs = {};
  const shoot = async (label, bin) => {
    const sbx = sandbox();
    const debugFile = path.join(sbx.dir, `${label}-debug.log`);
    try {
      seedClaudeProfile(sbx.home, { cwd: process.cwd(), apiKey: 'sk-ant-mock-0000000000000000000000' });
      if (o.settings) {
        fs.mkdirSync(path.join(sbx.home, '.claude'), { recursive: true });
        fs.writeFileSync(path.join(sbx.home, '.claude', 'settings.json'), JSON.stringify(o.settings));
      }
      const f = await capture(sbx, env, [bin, ...debugFileArgs(debugFile)]);
      if (out) fs.writeFileSync(path.join(out, `${label}.json`), JSON.stringify(f));
      return f;
    } catch (e) {
      process.stderr.write(`frame-oracle: ${label} (${bin}) produced no frame: ${e.message}\n`);
      return null;
    } finally {
      logs[label] = readLog(debugFile);
      try { fs.rmSync(sbx.dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  };
  try {
    const ref = await shoot('ref', o.ref);
    const sub = await shoot('sub', o.sub);
    // a side that produced no frame is the caller's finding already; its log is judged only when it painted
    const debugLog = sub ? assertDebugLogClean({ label: `frame-oracle: subject ${o.sub}`, quaude: logs.sub, reference: ref ? logs.ref : null }) : null;
    return { ref, sub, debugLog };
  } finally {
    await mock.close();
  }
}

async function main() {
  const o = parse(process.argv.slice(2));
  for (const p of [o.ref, o.sub]) if (!fs.existsSync(p)) { process.stderr.write(`frame-oracle: no such binary: ${p}\n`); process.exit(2); }
  const out = o.out || fs.mkdtempSync(path.join(os.tmpdir(), 'frame-oracle-'));
  const { ref, sub, settled } = await captureFrames({ ...o, out });
  process.stdout.write(`frames written to ${out}\n`);
  if (!ref || !sub) process.exit(2);
  for (const side of ['ref', 'sub']) {
    if (!settled[side]) process.stderr.write(`frame-oracle: the ${side} frame was taken at its step's cap, not settled\n`);
  }
  if (!settled.ref || !settled.sub) process.exit(2);

  const d = diff(ref, sub, { maxDetail: 20 });
  process.stdout.write(describe(ref, sub, d) + '\n');
  process.exit(d.equal ? 0 : 1);
}

module.exports = { captureFrames, captureSessions };

if (require.main === module) {
  main().catch((e) => { process.stderr.write('frame-oracle: ' + ((e && e.stack) || e) + '\n'); process.exit(2); });
}
