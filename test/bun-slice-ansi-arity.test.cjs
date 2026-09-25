'use strict';
// GUARD: every Bun.sliceAnsi call in the carved bundle passes at most THREE arguments.
//
// WHY. bun-shim's Bun.sliceAnsi is libexec/unicode-text.cjs's, which implements everything
// native's does EXCEPT an ellipsis of nonzero width (the 4th argument, a string or
// { ellipsis }). It REFUSES one with a throw rather than answer differently from native —
// and inside Ink's layout a throw is a dropped frame: the 2.1.278 TUI painted nothing for a
// day for exactly that reason (a Bun.sliceAnsi that threw on every call). The bundle passes
// no ellipsis today; the day an upstream bump starts passing one, this goes red at carve
// time, naming the call, instead of a user meeting a blank screen.
//
// Measured 2026-09-25 on the 2.1.278 carve (darwin-arm64): 5 references to sliceAnsi, all
// `Bun.sliceAnsi(text, start, end)` in 3 call sites (Ink's clip/truncate and a line
// wrapper). The 2.1.251 carve references it 0 times (the bundle adopted it in 2.1.278, though
// Bun 1.4.1 already had it).
//
// WHAT COUNTS. Every `sliceAnsi` in the carve must be a direct call on Bun (`Bun.sliceAnsi(`,
// `Bun?.sliceAnsi(`, `Bun.sliceAnsi?.(`) with at most 3 top-level arguments. Any other
// reference (an alias, a destructure, `Bun["sliceAnsi"]`'s neighbour) is a finding too: a
// call through an alias could pass a 4th argument this scan cannot see.
//
// The carve is read the way inspect-claude-bundle reads it: a 2.1.243+ carve carries every
// module's source JSON-escaped twice inside one string literal, so it is DECODED first
// (decodeGraphRunner) and the scan sees the modules' real source, where `"` is a quote.
//
// WHERE IT RUNS FOR REAL. The suite's CLODE_PROVIDER_BIN is the pinned provider, which does
// not reference Bun.sliceAnsi yet, so there it SKIPS saying so. CI's linux-x64-pty job runs
// it against the text oracle native (the version libexec/unicode-text.cjs was generated
// from), which does. read() decides "references it at all" with a plain substring test and
// scan() counts with its own parser, so a parser that stopped matching reads BROKEN (floor
// 1), never as a skip.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const assert = require('node:assert');
const { defineGuard, guardTests } = require('./guard.cjs');
const { decodeGraphRunner } = require('../libexec/inspect-claude-bundle.cjs');

const REPO = path.resolve(__dirname, '..');
const EXTRACT = path.join(REPO, 'libexec', 'extract-claude-js.cjs');
const MAX_ARGS = 3;

// The number of top-level arguments of the call whose `(` is at `open`, or -1 when the
// text ends first. Strings, template literals and nested brackets are skipped; a backslash
// outside a string (a regex literal's `\)`) skips the next character.
function argCount(text, open) {
  let depth = 0, commas = 0, any = false;
  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') { i++; any = true; continue; }
    if (ch === '"' || ch === "'" || ch === '`') {
      for (i++; i < text.length && text[i] !== ch; i++) if (text[i] === '\\') i++;
      any = true; continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') { depth++; any = true; continue; }
    if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return any ? commas + 1 : 0;
      depth--; continue;
    }
    if (ch === ',' && depth === 0) { commas++; continue; }
    if (!/\s/.test(ch)) any = true;
  }
  return -1;
}

function scanSliceAnsiCalls({ text, what }) {
  const findings = [];
  const re = /\bsliceAnsi\b/g;
  let m, examined = 0;
  while ((m = re.exec(text)) !== null) {
    examined++;
    const before = text.slice(Math.max(0, m.index - 8), m.index);
    const after = /^\s*(?:\?\.\s*)?\(/.exec(text.slice(m.index + m[0].length, m.index + m[0].length + 8));
    const at = text.slice(Math.max(0, m.index - 40), m.index + 60).replace(/\s+/g, ' ');
    if (!/\bBun\s*\??\.\s*$/.test(before) || !after) {
      findings.push(`not a direct Bun.sliceAnsi call, so its arguments cannot be counted: ...${at}...`);
      continue;
    }
    const n = argCount(text, m.index + m[0].length + after[0].length - 1);
    if (n < 0 || n > MAX_ARGS) {
      findings.push(`Bun.sliceAnsi called with ${n < 0 ? 'an unterminated argument list' : n + ' arguments'}: ...${at}... `
        + '— a 4th argument is an ellipsis, which libexec/unicode-text.cjs refuses (throws); implement it '
        + "from native's measured behaviour before this bundle ships");
    }
  }
  return { findings, examined, note: what };
}

guardTests(defineGuard({
  name: 'bun-slice-ansi-arity',
  floor: 1,
  read() {
    const bin = process.env.CLODE_PROVIDER_BIN;
    if (!bin || !fs.existsSync(bin)) return { skip: 'no CLODE_PROVIDER_BIN (point it at a real claude binary to run this gate)' };
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slice-arity-'));
    try {
      const cli = path.join(dir, 'cli.cjs');
      const ex = spawnSync(process.execPath, [EXTRACT, bin, cli], { encoding: 'utf8' });
      if (ex.status !== 0) throw new Error(`extract-claude-js could not carve ${bin}: ${(ex.stderr || '').slice(0, 400)}`);
      const decoded = decodeGraphRunner(cli);
      const text = decoded !== null ? decoded : fs.readFileSync(cli, 'latin1');
      if (!text.includes('sliceAnsi')) return { skip: `the carve of ${bin} never references Bun.sliceAnsi (the bundle adopted it in 2.1.278)` };
      return { text, what: `the carve of ${bin}` };
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  },
  scan: scanSliceAnsiCalls,
  // The regression itself: a bundle that starts truncating with an ellipsis, beside the
  // three-argument shape every current call has, so the control clears the floor on the
  // clean call and its finding is the 4-argument one.
  control: () => ({ text: 'let c=Bun.sliceAnsi(i,a,a+o);let t=Bun.sliceAnsi(n,s,u,"\\u2026");', what: 'synthetic control' }),
}));

// The parser's edge cases, each a real shape: nested calls and a string holding a comma are
// one argument each; an alias and an unterminated call are findings, not silently uncounted.
test('the arity scan counts top-level arguments and refuses what it cannot count', () => {
  const count = (t) => scanSliceAnsiCalls({ text: t, what: 'x' });
  assert.deepStrictEqual(count('Bun.sliceAnsi(f(a,b),[1,2],{x:1,y:2})').findings, []);
  assert.deepStrictEqual(count('Bun.sliceAnsi(s,",",`a,${b}`)').findings, []);
  assert.deepStrictEqual(count('Bun?.sliceAnsi(s,0,1);Bun.sliceAnsi?.(s)').findings, []);
  assert.strictEqual(count('Bun.sliceAnsi(s,0,1,e)').findings.length, 1);
  assert.strictEqual(count('Bun.sliceAnsi(s,0,1,{ellipsis:e})').findings.length, 1);
  assert.strictEqual(count('let q=Bun.sliceAnsi;q(s,0,1,e)').findings.length, 1, 'an alias is a finding');
  assert.strictEqual(count('Bun.sliceAnsi(s,0').findings.length, 1, 'an unterminated call is a finding');
  assert.strictEqual(count('').examined, 0);
});
