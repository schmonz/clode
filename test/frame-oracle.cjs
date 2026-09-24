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
//       [--seconds 12] [--rows 40] [--cols 100] \
//       [--send-hex 68690d] [--then-hex 0d@6] [--out DIR]
//
// Exit 0 when the frames match, 1 when they differ, 2 on a harness failure.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { sandbox } = require('./e2e.cjs');
const { captureFrame, seedClaudeProfile } = require('./e2e-pty.cjs');
const { diff, describe } = require('./frame-diff.cjs');
const { startMockAnthropic } = require('./mock-anthropic-helper.cjs');

function parse(argv) {
  const o = { seconds: 12, rows: 40, cols: 100, thenHex: [], out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const v = argv[i + 1];
    if (a === '--ref') { o.ref = v; i++; } else if (a === '--sub') { o.sub = v; i++; } else if (a === '--seconds') { o.seconds = parseFloat(v); i++; } else if (a === '--rows') { o.rows = parseInt(v, 10); i++; } else if (a === '--cols') { o.cols = parseInt(v, 10); i++; } else if (a === '--send-hex') { o.sendHex = v; i++; } else if (a === '--then-hex') { o.thenHex.push(v); i++; } else if (a === '--out') { o.out = v; i++; } else {
      process.stderr.write(`frame-oracle: unknown argument ${a}\n`); process.exit(2);
    }
  }
  if (!o.ref || !o.sub) { process.stderr.write('usage: frame-oracle.cjs --ref BIN --sub BIN [--seconds N] [--rows R] [--cols C] [--send-hex HEX] [--then-hex HEX@DELAY] [--out DIR]\n'); process.exit(2); }
  return o;
}

// Capture a REFERENCE and a SUBJECT frame through the same scripted pty session
// against the canned mock. Returns { ref, sub } (either may be null, with the
// reason written to stderr). Shared by the CLI below and by
// test/fidelity/interactive-frame-diff.test.cjs, so the gate measures exactly
// what an operator measures by hand.
async function captureFrames(o) {
  const mock = await startMockAnthropic({ text: 'PONG' });
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

  const opts = { seconds: o.seconds, rows: o.rows, cols: o.cols, sendHex: o.sendHex, thenHex: o.thenHex || [], env };
  // A FRESH HOME PER CAPTURE, not one shared sandbox. tui-screen ends a capture
  // with SIGKILL, and a Claude Code killed inside the fullscreen renderer leaves
  // a "didn't finish starting" marker in its profile; the NEXT process to read
  // that HOME silently falls back to the classic renderer. Sharing one HOME
  // therefore compares the reference's fullscreen frame against the subject's
  // classic-renderer frame — measured here on 2026-09-22, and it made a
  // native-vs-native run differ in 1431 cells. Same seed, separate state.
  const shoot = (label, bin) => {
    const sbx = sandbox();
    try {
      seedClaudeProfile(sbx.home, { cwd: process.cwd(), apiKey: 'sk-ant-mock-0000000000000000000000' });
      const f = captureFrame(sbx, { ...opts, cmd: [bin] });
      if (out) fs.writeFileSync(path.join(out, `${label}.json`), JSON.stringify(f));
      return f;
    } catch (e) {
      process.stderr.write(`frame-oracle: ${label} (${bin}) produced no frame: ${e.message}\n`);
      return null;
    } finally {
      try { fs.rmSync(sbx.dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  };
  try {
    return { ref: shoot('ref', o.ref), sub: shoot('sub', o.sub) };
  } finally {
    await mock.close();
  }
}

async function main() {
  const o = parse(process.argv.slice(2));
  for (const p of [o.ref, o.sub]) if (!fs.existsSync(p)) { process.stderr.write(`frame-oracle: no such binary: ${p}\n`); process.exit(2); }
  const out = o.out || fs.mkdtempSync(path.join(os.tmpdir(), 'frame-oracle-'));
  const { ref, sub } = await captureFrames({ ...o, out });
  process.stdout.write(`frames written to ${out}\n`);
  if (!ref || !sub) process.exit(2);

  const d = diff(ref, sub, { maxDetail: 20 });
  process.stdout.write(describe(ref, sub, d) + '\n');
  process.exit(d.equal ? 0 : 1);
}

module.exports = { captureFrames };

if (require.main === module) {
  main().catch((e) => { process.stderr.write('frame-oracle: ' + ((e && e.stack) || e) + '\n'); process.exit(2); });
}
