'use strict';
// THE FIRST-RUN TRANSCRIPT, JUDGED (scripts/first-run.mjs). A step is one command a new user types, driven under a PTY
// by test/tui-screen.cjs with --chunk-log: every chunk the child wrote, { ms, text }, and a last line { ms, exit }.
// From that alone, findings a person at the terminal would have felt:
//   - silence: no output for gapMs (default 10 s) — the "is it hung?" moment;
//   - a frozen spinner: a spinner that was painting (it repaints every ~100 ms) stopped for spinnerMs (2 s) and then
//     went on — the builder's loop was blocked (the 2026-11-25 "Extracting bundle… (0.0s)");
//   - a wide line: printed text wider than the terminal (cols, default 80), which the terminal wrapped;
//   - an exit that was not 0, or no exit at all (the step was stopped).
// Pure: the harness and its test feed it records.

// The one escape grammar (libexec/unicode-text.cjs, Bun.stripANSI's): what the terminal would not show is not text.
const { stripAnsi } = require('../../libexec/unicode-text.cjs');
const SPINNER = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✻✽✶✳✢·*]\s+\S.*?\(\d+(?:\.\d+)?s\)|\(\d+(?:\.\d+)?s\)\s*$/m;

const plain = (s) => stripAnsi(String(s));

function parseChunkLog(text) {
  const chunks = []; let exit = null;
  for (const l of String(text).split('\n')) {
    if (!l.trim()) continue;
    const r = JSON.parse(l);
    if (r.exit) exit = { ms: r.ms, ...r.exit };
    else chunks.push({ ms: r.ms, text: String(r.text) });
  }
  return { chunks, exit };
}

// The visible lines a stream printed: split on newline AND carriage return (a spinner redraws its line with \r), ANSI
// removed. A cursor-addressed TUI (quaude's) is judged on its screen frames instead, so `lines` is for line-mode output.
function printedLines(chunks) {
  return plain(chunks.map((c) => c.text).join('')).split(/\r\n|\n|\r/);
}

function stepFindings({ name, chunks, exit, gapMs = 10000, spinnerMs = 2000, cols = 80, lineMode = true }) {
  const findings = [];
  let prev = 0; let prevText = '';
  for (const c of chunks) {
    const gap = c.ms - prev;
    if (gap >= spinnerMs && SPINNER.test(plain(prevText))) {
      findings.push({ kind: 'frozen-spinner', step: name, at: prev, ms: gap, detail: plain(prevText).trim().split(/\r|\n/).pop().trim() });
    } else if (gap >= gapMs) {
      findings.push({ kind: 'silence', step: name, at: prev, ms: gap, detail: prev === 0 ? 'nothing printed after the command started' : `after "${plain(prevText).trim().slice(-60)}"` });
    }
    prev = c.ms; prevText = c.text;
  }
  if (exit && exit.ms - prev >= gapMs) findings.push({ kind: 'silence', step: name, at: prev, ms: exit.ms - prev, detail: 'before exiting' });
  if (lineMode) {
    for (const l of new Set(printedLines(chunks))) {
      const w = [...l.replace(/\s+$/, '')].length;
      if (w > cols) findings.push({ kind: 'wide-line', step: name, width: w, detail: l.trim().slice(0, 100) });
    }
  }
  if (!exit) findings.push({ kind: 'no-exit', step: name, detail: 'the step was stopped, it never exited on its own' });
  else if (exit.code !== 0 || exit.signal) findings.push({ kind: 'exit', step: name, detail: `exited ${exit.code}${exit.signal ? ` (${exit.signal})` : ''}` });
  return findings;
}

// A transcript a person (or Claude) reads: each step's command, its seconds, its printed lines (spinner frames
// collapsed to their last state), then the findings.
function renderTranscript(steps) {
  const out = [];
  for (const s of steps) {
    const secs = s.exit ? (s.exit.ms / 1000).toFixed(1) : '?';
    out.push(`$ ${s.command}    [${secs}s${s.exit ? `, exit ${s.exit.code}` : ', stopped'}]`);
    const lines = []; let last = null;
    for (const l of printedLines(s.chunks)) {
      const t = l.replace(/\s+$/, '');
      if (!t) continue;
      const key = t.replace(/\(\d+(?:\.\d+)?s\)/g, '(…s)').replace(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/, '');
      if (key === last) { lines[lines.length - 1] = t; continue; }
      lines.push(t); last = key;
    }
    for (const l of (s.screen ? s.screen.split('\n') : lines)) out.push(`  ${l}`);
    out.push('');
  }
  return out.join('\n');
}

module.exports = { parseChunkLog, printedLines, stepFindings, renderTranscript, plain, SPINNER };
