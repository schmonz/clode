'use strict';
// RATCHET 0a (grep-native plan, Task 1): A LIVE TOOL CHECK JUDGES THE TOOL_RESULT, NEVER THE
// REQUEST.
//
// WHAT HAPPENED. The Grep and Glob tools, grep/find flags, and compound Bash commands were
// broken in every clode release (2.1.185..2.1.283) while every check said green. The first of
// three causes: the live checks matched their marker against the WHOLE follow-up request
// body. That body also carries the assistant's own tool_use, which spells the command, so a
// marker the command spells (`echo MARK`, `pattern: MARK`) "came back" whether or not the
// tool ran. Such a check cannot fail on missing output. b4ff3f2 (scripts/floor-probe.mjs B1
// and B4) and f4d763d (test/fidelity/agentic-tools.test.cjs's Grep, multi-turn and hook rows)
// fixed five of them by hand. Five more still judged the raw body the day this guard was
// written, and none of the tree's live checks carried a control.
//
// TWO GUARDS, and a shared reader.
//   scripts/lib/tool-result.cjs holds the ONE reader of what the model saw of a tool
//   (toolResult/toolResultText), the ONE statement of the rule (rawBodyReads), and the control
//   every live check carries (assertFailsOnMissingOutput). It lives under scripts/lib/ because
//   floor-probe.mjs is a script and both it and the tests must reach it
//   (scripts/lib/text-probe.cjs and paint-probe.cjs are the precedent for a script library
//   the tests require).
//   GUARD 1 `live-checks-judge-output` scans the tree for live checks and their spellings.
//   GUARD 2 `missing-output-control-refuses` controls the helper's own refusal, so the
//   per-check controls stay able to fail.
//
// THE DETECTION RULE (guard 1), exactly:
//   SCOPE. Every .cjs/.mjs file under test/ and every .cjs/.mjs/.js file under scripts/
//   (floor-probe.mjs is a script). Dotfiles and node_modules are not walked. Two files are
//   skipped by name and never read (LIVE_CHECK_EXEMPT, each with its reason); "files
//   scanned" in the verdict counts them, and says how many were skipped.
//   VIEW. Each file is lexed into a CODE MASK: comments, string contents, template-literal
//   text and regex bodies become spaces (delimiters, `${...}` expressions and line breaks
//   stay), so prose in a comment or a string never reads as code. A file that does not lex
//   is a finding. Two strings are read back through the mask, at the same position: a
//   bracketed 'body' key (`q['body']`), and the literal 'tool_result' (rule 3).
//   UNITS. A unit starts at a line whose brace/paren depth is 0 and whose first column is a
//   letter, `_`, `$` or `(` (a top-level statement); at every `test(`/`it(` call, whatever
//   its depth (each test inside a describe() is its own unit; code between two tests of a
//   describe belongs to the test above it); and at a `row:` line inside a top-level
//   declaration (a floor-probe CHECKS row). It runs to the next start. A `function NAME` or
//   `const|let|var NAME =` unit is NAMED, and unit A REACHES unit B when A's code names B
//   (a call, or a reference such as `map(bodyOf)`), not after `.`, a word character or `$`,
//   transitively. Export lists are not edges.
//   SCRIPTS. A tool_use emitter call (`cannedToolUseSSE(`, `toolUseSSE(`) or a mock rule's
//   `tool:` (an object or a name). The mock's own machinery is not a script: the emitter's
//   definition, and an emitter call that forwards a RULE's tool (`toolUseSSE(rule.tool.name`).
//   LIVE CHECK. An OUTERMOST unit (nothing in the file names it) whose reach both scripts a
//   tool_use and reads what the mock received (`.requests`, `toolResult(`,
//   `toolResultText(`). So a mock built by a same-file factory still makes its test a live
//   check, and a helper shared by two tests counts once per test.
//   FINDINGS, over the live check's whole reach:
//     (1) raw body: rawBodyReads() finds a read (see its comment in scripts/lib/tool-result.cjs):
//         `.body` unless JSON.parse reads it straight through to a field other than
//         `messages` (the model, max_tokens; `messages` is the history, tool_use and all),
//         `['body']`, a destructured `{ body }` or `{ body: b }`, and JSON.stringify /
//         Object.values / Object.entries over `requests` or inside a callback over the log.
//         Selecting the follow-up by substring counts too: inside a live check the ONE reader
//         selects.
//     (2) the control: no `assertFailsOnMissingOutput(` call; a control given an inline
//         function; or a control that is NOT BOUND: no function it was given is ever called
//         in the reach, so the control proves nothing about what is judged.
//     (3) private reader, anywhere in a scanned file: the literal 'tool_result' in code (a
//         `.type` comparison either way round, `['tool_result'].includes(...)`, a `case`),
//         except as the value of a `type:` key, which builds a block rather than reading one.
//   `examined` is the number of live checks found; the floor is the inventory count.
//
// WHAT IT DOES NOT SEE, stated. It is a textual rule, and these escape it:
//   - anything across a file edge: a reader helper in another file
//     (`require('./h.cjs').allBodies(mock)`), or a tool_use scripted in one file and judged in
//     another. The reach stops at the file, as guards-population's require() edge does.
//   - a tool_use scripted without an emitter or a `tool:` rule (a hand-written SSE string):
//     that is not a live check at all, so nothing is required of it.
//   - raw reads the rule does not spell: `Object.keys(q).map((k) => q[k])`, a stringify on a
//     later line of a multi-line `for (... of X.requests)` body, a body copied into a
//     variable by a helper out of view. The run-time half (assertFailsOnMissingOutput's
//     synthetic follow-ups) catches a CONTROLLED check that reads that way, not an
//     uncontrolled judgment beside it.
//   - binding is "called at least once in the reach", not "is what the assert judges": a
//     check can call its controlled function in a log line and assert on something else, and
//     other judgments in the same check (diagnostics, skip conditions) are unbound. Controls
//     are bound per live check, not per judged tool.
//   - rule (3) misses a computed or partial spelling ('tool_' + 'result', startsWith, a regex).
//   - the mask reads a `/` after `)` as division, so a regex literal there (`if (x) /re/...`)
//     is misread; a file that then fails to lex is a finding, not a pass.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { toolResult, toolResultText, assertFailsOnMissingOutput, rawBodyReads, answeredLog } = require('../../scripts/lib/tool-result.cjs');
const { defineGuard, guardTests, checkGate, BROKEN } = require('../guard.cjs');
const { throwsAsFindings } = require('../throws-as-findings.cjs');
const { discoverFilesByExt } = require('../source-scan.cjs');

const REPO = path.resolve(__dirname, '..', '..');
const posixRel = (f) => path.relative(REPO, f).split(path.sep).join('/');

// ==========================================================================
// A synthetic follow-up request, as the target sends it after a tool call: the prompt, the
// assistant's tool_use (which spells the command), and the tool_result in the LAST user turn.
// ==========================================================================
const IN_COMMAND = 'MARK-ONLY-IN-THE-COMMAND';
function followUpBody({ id = 'toolu_unit_1', result = 'the real output', isError, extra = [] } = {}) {
  const prompt = { role: 'user', content: [{ type: 'text', text: 'run it' }] };
  const use = { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: `echo ${IN_COMMAND}` } }] };
  const block = { type: 'tool_result', tool_use_id: id, content: result };
  if (isError !== undefined) block.is_error = isError;
  return JSON.stringify({ model: 'claude-unit', messages: [...extra, prompt, use, { role: 'user', content: [block] }] });
}
const post = (body) => ({ method: 'POST', url: '/v1/messages', body });

// ==========================================================================
// THE READER
// ==========================================================================
test('toolResultText returns the tool_result text, NOT a marker only the tool_use input spells', () => {
  const body = followUpBody();
  assert.ok(body.includes(IN_COMMAND), 'the trap must exist: the request body spells the command');
  assert.strictEqual(toolResultText(body), 'the real output');
  assert.ok(!toolResultText(body).includes(IN_COMMAND),
    'the reader must not see the command: that is the whole defect this guard exists for');
});

test('toolResultText joins a block-array tool_result the way the model reads it', () => {
  const body = followUpBody({ result: [{ type: 'text', text: 'line 1\n' }, { type: 'text', text: 'line 2' }] });
  assert.strictEqual(toolResultText(body), 'line 1\nline 2');
});

test('toolResultText reads the LAST user turn of a body, never an earlier one in the history', () => {
  // An earlier turn's tool_result for another id sits in the history; the last turn carries B.
  const earlier = [
    { role: 'user', content: [{ type: 'text', text: 'first' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_A', name: 'Bash', input: { command: 'true' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_A', content: 'OLD-A' }] },
  ];
  const body = followUpBody({ id: 'toolu_B', result: 'NEW-B', extra: earlier });
  assert.strictEqual(toolResultText(body), 'NEW-B');
  assert.strictEqual(toolResultText(body, 'toolu_B'), 'NEW-B');
  assert.strictEqual(toolResultText(body, 'toolu_A'), '', 'toolu_A is history, not this turn');
});

test('toolResult over a request log finds the follow-up by parsing, and says when there is none', () => {
  const mock = { requests: [
    { method: 'GET', url: '/v1/models', body: '' },
    post(JSON.stringify({ messages: [{ role: 'user', content: 'run it' }] })),
    post(followUpBody({ id: 'toolu_log', result: 'denied: reason', isError: true })),
  ] };
  const r = toolResult(mock, 'toolu_log');
  assert.deepStrictEqual({ text: r.text, isError: r.isError }, { text: 'denied: reason', isError: true });
  assert.strictEqual(toolResultText(mock.requests, 'toolu_log'), 'denied: reason', 'an array log reads the same');
  assert.strictEqual(toolResult(mock, 'toolu_absent'), null);
  assert.strictEqual(toolResultText(mock, 'toolu_absent'), '');
  assert.throws(() => toolResultText(mock), /needs the tool_use id/,
    'a log holds many turns: reading one without naming the tool call is ambiguous');
});

test('toolFollowUpText reads the text sent beside a tool_result in its own turn, not the history or the tool_use', () => {
  const { toolFollowUpText } = require('../../scripts/lib/tool-result.cjs');
  const earlier = [
    { role: 'user', content: [{ type: 'text', text: 'first' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_A', name: 'Skill', input: { skill: 'x' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_A', content: 'Launching skill: x' }, { type: 'text', text: 'OLD BODY' }] },
  ];
  const use = { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_B', name: 'Skill', input: { skill: IN_COMMAND } }] };
  const turn = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_B', content: 'Launching skill: y' }, { type: 'text', text: 'NEW BODY' }] };
  const body = JSON.stringify({ messages: [...earlier, use, turn] });
  assert.strictEqual(toolFollowUpText(body, 'toolu_B'), 'NEW BODY');
  assert.strictEqual(toolFollowUpText(body, 'toolu_A'), null, 'toolu_A is history, not this turn');
  assert.strictEqual(toolFollowUpText({ requests: [post(body)] }, 'toolu_B'), 'NEW BODY', 'a log reads the same');
  const bare = JSON.stringify({ messages: [...earlier, use, { role: 'user', content: [turn.content[0]] }] });
  assert.strictEqual(toolFollowUpText(bare, 'toolu_B'), '', 'CONTROL: a turn with the tool_result and nothing beside it');
  assert.throws(() => toolFollowUpText(body), /name the tool_use id/);
});

// ==========================================================================
// THE CONTROL EVERY LIVE CHECK CARRIES
// ==========================================================================
const TOOL = { name: 'Bash', input: { command: 'grep -c X /dev/null; echo LIVE-$((6*7))' }, id: 'toolu_ctl_1' };

test('assertFailsOnMissingOutput accepts a check that judges a computed marker in the tool_result', () => {
  const check = (m) => toolResultText(m, TOOL.id).includes('LIVE-42');
  assert.doesNotThrow(() => assertFailsOnMissingOutput(check, TOOL));
});

test('assertFailsOnMissingOutput refuses a check that reads the raw request body', () => {
  const MARK = 'LIVE-RAW';
  const check = (m) => m.requests.some((q) => (q.body || '').includes(MARK));
  assert.throws(() => assertFailsOnMissingOutput(check, { name: 'Bash', input: { command: `echo ${MARK}` }, id: 'toolu_r' }),
    /reads a raw request body/);
});

test('assertFailsOnMissingOutput refuses a check that stringifies a logged request', () => {
  const MARK = 'LIVE-STRINGIFY';
  const check = (m) => m.requests.some((q) => JSON.stringify(q).includes(MARK));
  assert.throws(() => assertFailsOnMissingOutput(check, { name: 'Bash', input: { command: `echo ${MARK}` }, id: 'toolu_s' }),
    /reads a raw request body \(JSON\.stringify of a logged request\)/);
});

test('assertFailsOnMissingOutput refuses a check whose raw read hides in a helper its source does not show', () => {
  // The check's own source reads nothing raw, so only the run-time half can see it: the
  // synthetic follow-up carries the command, and the helper searches the whole request.
  const MARK = 'LIVE-HIDDEN';
  const everything = (m) => m.requests.map((q) => Object.keys(q).map((k) => q[k]).join(' ')).join(' ');
  const check = (m) => everything(m).includes(MARK);
  assert.throws(() => assertFailsOnMissingOutput(check, { name: 'Bash', input: { command: `echo ${MARK}` }, id: 'toolu_h' }),
    /PASSES when the tool's output is missing \(no tool_result at all\)/);
});

test('assertFailsOnMissingOutput refuses a tool_result check whose needle the command itself spells', () => {
  // A tool_result that quotes the command (an error, a shell's "not found") carries MARK.
  // b4ff3f2's answer: a COMPUTED marker, which the output spells and the command does not.
  const check = (m) => toolResultText(m, 'toolu_q').includes('LIVE-ECHO');
  assert.throws(() => assertFailsOnMissingOutput(check, { name: 'Bash', input: { command: 'echo LIVE-ECHO' }, id: 'toolu_q' }),
    /PASSES when the tool's output is missing \(an error tool_result that quotes the command\)/);
});

test('assertFailsOnMissingOutput refuses a negative-only check (it passes on an empty tool_result)', () => {
  const check = (m) => !toolResultText(m, TOOL.id).includes('Output too large');
  assert.throws(() => assertFailsOnMissingOutput(check, TOOL), /PASSES when the tool's output is missing/);
});

test('assertFailsOnMissingOutput refuses a check that returns no boolean verdict, or a tool_use with no id', () => {
  assert.throws(() => assertFailsOnMissingOutput(() => undefined, TOOL), /must return a boolean/);
  assert.throws(() => assertFailsOnMissingOutput(() => false, { name: 'Bash', input: { command: 'x' } }),
    /needs the tool_use \{ name, input, id \}/);
});

test('assertFailsOnMissingOutput with a context: the earlier call\'s real answer is present, so only this call\'s output is missing', () => {
  const BG = { name: 'Bash', input: { command: 'sleep 9', run_in_background: true }, id: 'toolu_ctx_bg' };
  const STOP = { name: 'TaskStop', input: { task_id: '<bg>' }, id: 'toolu_ctx_stop' };
  const context = [{ use: BG, content: 'Command running in background with ID: bctx01. Output is being written to: /t/x.' }];
  const idOf = (m) => { const x = /with ID: (\w+)\./.exec(toolResultText(m, BG.id)); return x ? x[1] : null; };
  // the right check: this call's answer names the id the earlier call gave
  const stopped = (m) => { const id = idOf(m); return !!id && toolResultText(m, STOP.id) === `stopped ${id}`; };
  assert.doesNotThrow(() => assertFailsOnMissingOutput(stopped, STOP, 'print', context));
  assert.ok(stopped(answeredLog(STOP, 'stopped bctx01', context)), 'it passes when this call is answered: its failures are about this call');
  // a check that judges only the context passes with this call's output missing: refused, though without the context
  // it would have failed every log (for the wrong reason: the earlier answer was missing too) and been accepted
  const contextOnly = (m) => idOf(m) === 'bctx01';
  assert.doesNotThrow(() => assertFailsOnMissingOutput(contextOnly, STOP));
  assert.throws(() => assertFailsOnMissingOutput(contextOnly, STOP, 'print', context), /PASSES when the tool's output is missing/);
  assert.throws(() => assertFailsOnMissingOutput(stopped, STOP, 'print', [{ use: BG }]), /context must be the earlier calls/);
});

test('assertFailsOnMissingOutput takes the cells a driver declares, a mode or modes, and refuses any other shape', () => {
  const check = (m) => toolResultText(m, TOOL.id).includes('LIVE-42');
  assert.doesNotThrow(() => assertFailsOnMissingOutput(check, TOOL, 'sandbox:on'));
  assert.doesNotThrow(() => assertFailsOnMissingOutput(check, TOOL, ['print', 'shell:bash']));
  for (const bad of ['', [], [''], 7, { mode: 'print' }]) {
    assert.throws(() => assertFailsOnMissingOutput(check, TOOL, bad), /modes must be a mode name or an array of them/);
  }
});

// ==========================================================================
// THE LEXER: a code mask, so the scan reads code, never prose.
// ==========================================================================
// Contents of comments, strings, template text and regex bodies become spaces; delimiters,
// `${...}` code and newlines are kept, so positions and line numbers survive. `lineDepth[k]`
// is the ({[ nesting at the start of line k. A file that ends inside a literal, or unbalanced,
// did not lex: the scan reports that as a finding rather than reading garbage as clean.
const REGEX_AFTER = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*',
  '%', '<', '>', '~', '^', 'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await']);
function lexMask(src) {
  const out = src.split('');
  const lineDepth = [0];
  const tpl = [];                       // open `${`: the brace count inside each
  let depth = 0, state = 'code', prev = '';
  const blank = (i) => { if (out[i] !== '\n') out[i] = ' '; };
  const escape = (i) => { blank(i); if (src[i + 1] !== undefined && src[i + 1] !== '\n') { blank(i + 1); return i + 1; } return i; };
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (c === '\n') {
      // A line comment ends here; a string or regex cannot span lines, so one still open
      // was misread and is closed rather than allowed to swallow the rest of the file.
      if (state === 'line' || state === 'sq' || state === 'dq' || state === 're' || state === 'recls') state = 'code';
      lineDepth.push(depth);
      continue;
    }
    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; blank(i); continue; }
      if (c === '/' && n === '*') { state = 'block'; blank(i); blank(i + 1); i++; continue; }
      if (c === "'") { state = 'sq'; continue; }
      if (c === '"') { state = 'dq'; continue; }
      if (c === '`') { state = 'tpl'; continue; }
      if (c === '/' && REGEX_AFTER.has(prev)) { state = 're'; continue; }
      // A word (so `return /re/` reads a regex and `x / 2` a division): extend the one in
      // progress, or start a new one.
      if (/[\w$]/.test(c)) { prev = /[\w$]/.test(src[i - 1] || '') && /^[\w$]+$/.test(prev) ? prev + c : c; continue; }
      if (/\s/.test(c)) continue;
      if (c === '{' || c === '(' || c === '[') {
        depth++;
        if (c === '{' && tpl.length) tpl[tpl.length - 1]++;
      } else if (c === '}' || c === ')' || c === ']') {
        if (c === '}' && tpl.length && tpl[tpl.length - 1] === 0) { tpl.pop(); state = 'tpl'; continue; }
        depth--;
        if (c === '}' && tpl.length) tpl[tpl.length - 1]--;
      }
      prev = c;
      continue;
    }
    if (state === 'line') { blank(i); continue; }
    if (state === 'block') { blank(i); if (c === '*' && n === '/') { blank(i + 1); i++; state = 'code'; } continue; }
    if (state === 'sq' || state === 'dq') {
      if (c === '\\') { i = escape(i); continue; }
      if (c === (state === 'sq' ? "'" : '"')) { state = 'code'; prev = ')'; continue; }
      blank(i);
      continue;
    }
    if (state === 'tpl') {
      if (c === '\\') { i = escape(i); continue; }
      if (c === '`') { state = 'code'; prev = ')'; continue; }
      if (c === '$' && n === '{') { tpl.push(0); state = 'code'; prev = '{'; i++; continue; }
      blank(i);
      continue;
    }
    if (state === 're' || state === 'recls') {
      if (c === '\\') { i = escape(i); continue; }
      if (state === 're' && c === '/') { state = 'code'; prev = ')'; continue; }
      if (state === 're' && c === '[') state = 'recls';
      else if (state === 'recls' && c === ']') state = 're';
      blank(i);
    }
  }
  const ok = (state === 'code' || state === 'line') && depth === 0 && tpl.length === 0;
  return { code: out.join(''), lineDepth, ok, why: ok ? '' : `ends in state ${state} at depth ${depth}` };
}

// ==========================================================================
// UNITS AND THE REFERENCE GRAPH
// ==========================================================================
// A unit starts at a top-level statement (depth 0, first column a letter, `_`, `$` or `(`),
// at every `test(`/`it(` call whatever its depth (so each test inside a describe() is a unit
// of its own; code between two tests of a describe belongs to the test above it), and at a
// `row:` line inside a top-level declaration (a floor-probe CHECKS row).
const TEST_CALL = /^\s*(?:test|it)\s*(?:\.\s*\w+\s*)?\(/;
const TITLE = /(?:test|it|describe)\s*(?:\.\s*\w+\s*)?\(\s*(['"`])((?:\\.|(?!\1).)*)\1/;
function unitsOf(src, code, lineDepth) {
  const cl = code.split('\n'), rl = src.split('\n');
  const units = [];
  let cur = null, top = null;
  for (let k = 0; k < cl.length; k++) {
    const line = cl[k];
    const isTop = lineDepth[k] === 0 && /^[A-Za-z_$(]/.test(line);
    const isTest = TEST_CALL.test(line);
    const isRow = /^\s*row\s*:/.test(line) && !!top && top.kind === 'decl';
    if (!cur || isTop || isTest || isRow) {
      const t = line.trim();
      const fn = isTop && /^(?:async\s+)?function\s*\*?\s*([\w$]+)/.exec(t);
      const decl = isTop && /^(?:const|let|var)\s+([\w$]+)\s*=/.exec(t);
      let kind = 'other', name = null;
      if (isRow) { kind = 'row'; name = `row ${((/row\s*:\s*['"]([^'"]*)['"]/.exec(rl[k])) || [])[1] || '?'}`; }
      else if (isTest) { kind = 'test'; name = `test '${(TITLE.exec(rl[k]) || [])[2] || '?'}'`; }
      else if (/^(?:module\.)?exports\b/.test(t)) kind = 'exports';
      else if (fn) { kind = 'function'; name = fn[1]; }
      else if (decl) { kind = 'decl'; name = decl[1]; }
      cur = { start: k + 1, lines: [], kind, name };
      units.push(cur);
      if (isTop) top = cur;
    }
    cur.lines.push(k);
  }
  for (const u of units) {
    u.code = u.lines.map((k) => cl[k]).join('\n');
    const raw = u.lines.map((k) => rl[k]).join('\n');
    // The view the rule reads: the mask, with a bracketed 'body' key restored (the mask blanks
    // every string, and `q['body']` is a body read spelled with one).
    u.view = u.code.replace(/\[\s*(['"`]) {4}\1\s*\]/g, (m, q, at) => {
      const orig = raw.slice(at, at + m.length);
      return /^\[\s*(['"`])body\1\s*\]$/.test(orig) ? orig : m;
    });
    u.lineAt = (at) => u.lines[u.code.slice(0, at).split('\n').length - 1];
  }
  return { units, cl, rl };
}

// SCRIPTS: a tool_use emitter call, or a mock rule's `tool:` (an object or a name). The mock's
// own machinery is not a script: the emitter's definition (`function toolUseSSE(`), and an
// emitter call that forwards whatever tool a RULE carries (`toolUseSSE(rule.tool.name, ...)`,
// floor-probe's startMock and test/mock-anthropic-child.cjs). The script there is the `tool:`
// rule its caller passes; counting the forwarder made every text-only row that shares the mock
// (floor-probe G7) a "live check".
const EMITTER = /\b(?:cannedToolUseSSE|toolUseSSE)\s*\(/g;
function scriptsToolUse(code) {
  for (const m of code.matchAll(EMITTER)) {
    if (/\bfunction\s+$/.test(code.slice(Math.max(0, m.index - 24), m.index))) continue;
    if (/^\s*[\w$.]*\.tool\b/.test(code.slice(m.index + m[0].length))) continue;
    return true;
  }
  return /\btool\s*:\s*[{A-Za-z_$]/.test(code);
}
const READS_REQUESTS = /\.requests\b|\btoolResult(?:Text)?\s*\(/;
const CONTROL_CALL = /\bassertFailsOnMissingOutput\s*\(/g;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// An edge u -> f when u's code NAMES f (a call, or a reference such as `map(bodyOf)` or
// `assertFailsOnMissingOutput(check, ...)`), not after `.`, a word character or `$`. Export
// lists are not edges: `module.exports = { f }` neither uses f nor hides it.
function refGraph(units) {
  const named = units.filter((u) => (u.kind === 'function' || u.kind === 'decl') && u.name);
  const out = new Map(units.map((u) => [u, new Set()]));
  const into = new Map(units.map((u) => [u, new Set()]));
  for (const f of named) {
    const re = new RegExp(`(?<![\\w$.])${escapeRe(f.name)}(?![\\w$])`);
    for (const u of units) {
      if (u === f || u.kind === 'exports' || !re.test(u.code)) continue;
      out.get(u).add(f);
      into.get(f).add(u);
    }
  }
  const closure = (u) => {
    const seen = new Set([u]); const todo = [u];
    while (todo.length) for (const v of out.get(todo.pop())) if (!seen.has(v)) { seen.add(v); todo.push(v); }
    return seen;
  };
  return { reach: closure, referrers: (u) => into.get(u) };
}

// ==========================================================================
// GUARD 1 — live-checks-judge-output
// ==========================================================================
// Skipped by name (counted in "files scanned", never read): the rule would misread these, and
// neither is a place the thing it forbids can hide.
const LIVE_CHECK_EXEMPT = new Map([
  ['scripts/lib/tool-result.cjs', 'the ONE reader: it parses request bodies and tool_result blocks on every '
    + 'live check\'s behalf, which is exactly what the rule sends every other file to it for'],
  ['test/build-gates/live-checks-gates.test.cjs', 'this guard: its unit tests build synthetic request logs and '
    + 'its control fixtures ARE the violations it detects'],
]);

// A private tool_result reader: the string 'tool_result' itself, anywhere in code (`.type ===
// 'tool_result'` either way round, `['tool_result'].includes(b.type)`, `case 'tool_result':`),
// except as the value of a `type:` key, which BUILDS a block rather than reading one. Found on
// the mask (a comment or prose never counts) and confirmed on the raw text at the same
// position. The mocks' routing string `'"tool_result"'` is a different literal.
function privateReaders(src, code) {
  const out = [];
  for (const m of code.matchAll(/(['"`]) {11}\1/g)) {
    if (src.slice(m.index + 1, m.index + 12) !== 'tool_result') continue;
    if (/\btype\s*:\s*$/.test(code.slice(Math.max(0, m.index - 24), m.index))) continue;
    out.push(code.slice(0, m.index).split('\n').length);
  }
  return out;
}

function scanLiveChecks({ sources }) {
  const findings = [];
  const checks = [];                     // the live checks found, for an inventory; not a verdict
  let live = 0, skipped = 0;
  const liveFiles = new Set();
  for (const { file, text } of sources) {
    if (LIVE_CHECK_EXEMPT.has(file)) { skipped++; continue; }
    const lx = lexMask(text);
    if (!lx.ok) {
      findings.push(`${file}: the scan could not lex this file (${lx.why}), so it cannot see its live checks`);
      continue;
    }
    // (3) private reader, anywhere in the file.
    for (const line of privateReaders(text, lx.code)) {
      findings.push(`${file}:${line}: a private tool_result reader. The one reader is `
        + 'scripts/lib/tool-result.cjs (toolResult/toolResultText); a second copy is free to drift');
    }
    const { units } = unitsOf(text, lx.code, lx.lineDepth);
    for (const u of units) u.scripts = scriptsToolUse(u.code);
    if (!units.some((u) => u.scripts)) continue;
    const g = refGraph(units);
    const reported = new Set();
    for (const u of units) {
      // A LIVE CHECK is an outermost unit (nothing in the file names it) whose reach both
      // scripts a tool_use and reads what the mock received.
      if (u.kind === 'exports' || g.referrers(u).size) continue;
      const scope = [...g.reach(u)].sort((a, b) => a.start - b.start);
      if (!scope.some((v) => v.scripts) || !scope.some((v) => READS_REQUESTS.test(v.code))) continue;
      live++;
      liveFiles.add(file);
      const label = u.name || `the unit at line ${u.start}`;
      checks.push(`${file}:${u.start} ${label}`);
      // (1) raw body, anywhere in the reach.
      for (const v of scope) {
        const byLine = new Map();
        for (const r of rawBodyReads(v.view)) {
          const k = v.lineAt(r.at);
          if (!byLine.has(k)) byLine.set(k, []);
          byLine.get(k).push(r.what);
        }
        for (const [k, whats] of byLine) {
          if (reported.has(k)) continue;
          reported.add(k);
          findings.push(`${file}:${k + 1}: a live check reads a raw request body (${whats.join(', ')}); `
            + `${label} judges what a request carried, and every follow-up also carries the tool_use, `
            + 'i.e. the command. Read the tool_result: toolResult()/toolResultText() in scripts/lib/tool-result.cjs');
        }
      }
      // (2) the control, and its binding to the verdict.
      const controlled = scope.flatMap((v) => [...v.code.matchAll(CONTROL_CALL)].map((m) => {
        const named = /^\s*([\w$]+)\s*,/.exec(v.code.slice(m.index + m[0].length));
        return named ? named[1] : '<inline>';
      }));
      if (!controlled.length) {
        findings.push(`${file}:${u.start}: live check ${label} carries no assertFailsOnMissingOutput(check, toolUse) `
          + 'control, so nothing proves it fails when the output is missing');
        continue;
      }
      const inline = controlled.filter((c) => c === '<inline>');
      if (inline.length) {
        findings.push(`${file}:${u.start}: live check ${label} controls an inline function, which its verdict `
          + 'cannot also call: give the check a name, pass it to the control, and judge with it');
      }
      const bound = controlled.filter((c) => c !== '<inline>').some((c) => {
        const call = new RegExp(`(?<![\\w$.])(?<!function\\s+)${escapeRe(c)}\\s*\\(`);
        return scope.some((v) => call.test(v.code));
      });
      if (!inline.length && !bound) {
        findings.push(`${file}:${u.start}: live check ${label}'s control is not bound to its verdict: no function `
          + `given to assertFailsOnMissingOutput (${controlled.join(', ')}) is ever called, so the control proves `
          + 'nothing about what is asserted');
      }
    }
  }
  return { findings, examined: live, checks,
    note: `${live} live check(s) in ${liveFiles.size} file(s); ${sources.length} file(s) scanned, `
      + `${skipped} of them skipped by name` };
}

function readLiveCheckSources() {
  const files = [
    ...discoverFilesByExt(path.join(REPO, 'test'), ['.cjs', '.mjs']),
    ...discoverFilesByExt(path.join(REPO, 'scripts'), ['.cjs', '.mjs', '.js']),
  ];
  return { sources: files.map((f) => ({ file: posixRel(f), text: fs.readFileSync(f, 'utf8') })) };
}

// THE CONTROL. Violations, two of them VERBATIM from history (the checks that said green while
// Grep and compound Bash commands were broken), the escapes the first review of this guard
// found, and legitimate files that must stay clean. Lines are kept as arrays so the historical
// source survives byte for byte.
const lines = (...ls) => ls.join('\n');
const CONTROL_SOURCES = [
  // The brief's synthetic shape: an assertion that matches followUp.body, and no control.
  { file: 'synthetic/raw-body.test.cjs', text: lines(
    "const { startMockAnthropic, cannedSSE, cannedToolUseSSE } = require('./mock-anthropic-helper.cjs');",
    "test('agentic Bash round-trip', async () => {",
    "  const MARK = 'RAW-BODY-MARK';",
    "  const ID = 'toolu_raw';",
    '  const mock = await startMockAnthropic({',
    "    respond: (body) => body.includes(ID) ? cannedSSE('DONE') : cannedToolUseSSE('Bash', { command: `echo ${MARK}` }, ID),",
    '  });',
    "  const followUp = mock.requests.find((q) => q.method === 'POST' && q.body.includes(ID));",
    '  assert.ok(followUp.body.includes(MARK));',
    '});',
  ) },
  // scripts/floor-probe.mjs row B1 before b4ff3f2, verbatim (wrapped in its CHECKS array).
  { file: 'history/floor-probe-b1-before-b4ff3f2.mjs', text: lines(
    'const CHECKS = [',
    '  {',
    "    row: 'B1',",
    "    what: 'Bash tool runs a command and returns output',",
    '    async fn(sbx) {',
    "      const ID = 'toolu_floor_bash';",
    "      const MARK = 'FLOOR-BASH-OK';",
    '      const mock = await startMock([',
    "        { match: ID, text: 'done' },                                   // the follow-up carrying tool_result",
    "        { tool: { name: 'Bash', input: { command: `echo ${MARK}` }, id: ID } },",
    '      ]);',
    '      try {',
    "        const r = await run(BIN, ['-p', 'run it', '--permission-mode', 'bypassPermissions', '--allowedTools', 'Bash'],",
    '          { home: sbx.home, cwd: sbx.cwd, extraEnv: { ANTHROPIC_BASE_URL: mock.url } });',
    '        // The proof is the tool_result echoed back to the model, not the prose:',
    "        // the bundle sends the command's OUTPUT in the follow-up request.",
    "        const echoed = mock.requests.some((q) => (q.body || '').includes(MARK));",
    '        const ok = r.code === 0 && echoed;',
    '        return { ok, how: ok ? `exit 0, tool_result carried ${MARK}` : `exit=${r.code ?? r.sig} echoed=${echoed} stderr=${JSON.stringify(r.err.slice(-160))}` };',
    '      } finally { await mock.close(); }',
    '    },',
    '  },',
    '];',
  ) },
  // test/fidelity/agentic-tools.test.cjs's followUpFor and Grep row before f4d763d, verbatim.
  { file: 'history/agentic-tools-grep-before-f4d763d.test.cjs', text: lines(
    'function followUpFor(mock, id) {',
    "  return mock.requests.find((q) => q.method === 'POST' && q.body && q.body.includes(id) && q.body.includes('tool_result'));",
    '}',
    '',
    "test('agentic Grep round-trip under tjs: search-applet path returns the match', async (t) => {",
    '  if (skipUnlessTjs(t)) return;',
    "  const bin = providerBin(); if (!bin) { t.skip('no CLODE_PROVIDER_BIN'); return; }",
    '  const { cli, dir } = stageBundle(bin);',
    "  fs.writeFileSync(path.join(dir, 'hay.txt'), `alpha\\n${MARK}\\ngamma\\n`);",
    "  const ID = 'toolu_grep_1';",
    '  const mock = await startMockAnthropic({',
    "    respond: (body) => body.includes(ID) ? cannedSSE('GREPDONE')",
    "      : cannedToolUseSSE('Grep', { pattern: MARK, path: dir, output_mode: 'content' }, ID),",
    '  });',
    '  try {',
    "    const r = await bootP(cli, dir, ['-p', 'find the needle', '--allowedTools', 'Grep'], mockEnv(dir, mock.url), 120000);",
    '    assert.strictEqual(r.status, 0, `stderr:\\n${r.stderr}`);',
    '    const followUp = followUpFor(mock, ID);',
    "    assert.ok(followUp, 'no follow-up POST carrying the Grep tool_result');",
    '    assert.match(followUp.body, new RegExp(MARK), `Grep tool_result lacks the match:\\n${followUp.body.slice(0, 1500)}`);',
    '  } finally { await mock.close(); }',
    '});',
  ) },
  // A same-file mock FACTORY: the tool_use is scripted in one unit and judged in another that
  // calls it (review 1, escape 1). Arrow and function spellings.
  { file: 'synthetic/mock-factory.test.cjs', text: lines(
    "const mkMock = () => startMockAnthropic({ respond: () => cannedToolUseSSE('Bash', { command: 'echo M' }, 'id') });",
    "function mk() { return startMockAnthropic({ respond: () => cannedToolUseSSE('Bash', { command: 'echo N' }, 'id2') }); }",
    "test('arrow factory', async () => { const mock = await mkMock(); assert.ok(mock.requests.some((q) => q.body.includes('M'))); });",
    "test('function factory', async () => { const mock = await mk(); assert.ok(mock.requests.some((q) => q.body.includes('N'))); });",
  ) },
  // A DECOY control: a control call is present, but the verdict judges the log another way
  // and never calls the controlled function (review 1, escape 2): stringifying the log,
  // parsing the history out of a body, a `{ body: b }` destructure, a body reader passed by
  // reference.
  { file: 'synthetic/decoy-control.test.cjs', text: lines(
    "const { toolResultText, assertFailsOnMissingOutput } = require('../scripts/lib/tool-result.cjs');",
    "const BASH = { name: 'Bash', input: { command: 'echo OK-$((6*7))' }, id: 'toolu_ok' };",
    "const good = (m) => toolResultText(m, BASH.id).includes('OK-42');",
    'const bodyOf = (q) => q.body;',
    "test('stringify the log', async () => {",
    '  assertFailsOnMissingOutput(good, BASH);',
    '  const mock = await startMockAnthropic({ respond: () => cannedToolUseSSE(BASH.name, BASH.input, BASH.id) });',
    '  assert.match(JSON.stringify(mock.requests), /OK/);',
    '});',
    "test('parse the history out of a body', async () => {",
    '  assertFailsOnMissingOutput(good, BASH);',
    '  const mock = await startMockAnthropic({ respond: () => cannedToolUseSSE(BASH.name, BASH.input, BASH.id) });',
    "  assert.ok(mock.requests.some((q) => JSON.stringify(JSON.parse(q.body).messages).includes('OK')));",
    '});',
    "test('destructure the body', async () => {",
    '  assertFailsOnMissingOutput(good, BASH);',
    '  const mock = await startMockAnthropic({ respond: () => cannedToolUseSSE(BASH.name, BASH.input, BASH.id) });',
    "  for (const { body: b } of mock.requests) assert.ok(b.includes('OK'));",
    '});',
    "test('a body reader passed by reference', async () => {",
    '  assertFailsOnMissingOutput(good, BASH);',
    '  const mock = await startMockAnthropic({ respond: () => cannedToolUseSSE(BASH.name, BASH.input, BASH.id) });',
    "  assert.ok(mock.requests.map(bodyOf).join('').includes('OK'));",
    '});',
    "test('an inline control', async () => {",
    "  assertFailsOnMissingOutput((m) => toolResultText(m, BASH.id).includes('OK-42'), BASH);",
    '  const mock = await startMockAnthropic({ respond: () => cannedToolUseSSE(BASH.name, BASH.input, BASH.id) });',
    "  assert.ok(toolResultText(mock, BASH.id).includes('OK'));",
    '});',
  ) },
  // `q['body']`: the mask blanks the string, so the scan restores a bracketed 'body' key before
  // the rule reads it. The control here is bound, so only the read can be the finding.
  { file: 'synthetic/bracket-body.test.cjs', text: lines(
    "const BASH = { name: 'Bash', input: { command: 'echo OK-$((6*7))' }, id: 'toolu_ok' };",
    "const good = (m) => toolResultText(m, BASH.id).includes('OK-42');",
    "test('bracketed body, bound control', async () => {",
    '  assertFailsOnMissingOutput(good, BASH);',
    '  const mock = await startMockAnthropic({ respond: () => cannedToolUseSSE(BASH.name, BASH.input, BASH.id) });',
    "  assert.ok(good(mock) || mock.requests.some((q) => q['body'].includes('OK')));",
    '});',
  ) },
  // Tests inside describe(): each test is its own unit, so a live test needs its own control,
  // and a sibling that reads the request history (and scripts no tool_use) is not flagged.
  { file: 'synthetic/describe.test.cjs', text: lines(
    "describe('d', () => {",
    "  test('a: judges the request history', async () => { const mock = await startMockAnthropic({ respond: () => cannedSSE('x') }); assert.ok(mock.requests[0].body.includes('prompt')); });",
    "  test('b: live, no control', async () => { const mock = await startMockAnthropic({ respond: () => cannedToolUseSSE('Bash', { command: 'echo M' }, 'id') }); assert.ok(toolResultText(mock, 'id').includes('M')); });",
    '});',
  ) },
  // LEGITIMATE, must stay clean: a live check judged on the tool_result with a bound control,
  // a mock that routes on the body, structured reads of the request's model (plain, with a
  // fallback, through .at(-1)), a private reader named only in a comment and a string, and the
  // --continue row (verbatim from agentic-tools.test.cjs), which judges the request history,
  // scripts no tool_use, and so is not a live check at all.
  { file: 'synthetic/legitimate.test.cjs', text: lines(
    "const { toolResultText, assertFailsOnMissingOutput } = require('../scripts/lib/tool-result.cjs');",
    "// a private reader in prose: if (b.type === 'tool_result') is not code",
    "const PROSE = \"b.type === 'tool_result'\";",
    "test('agentic Bash round-trip, judged on the tool_result', async () => {",
    "  const BASH = { name: 'Bash', input: { command: 'echo OK-$((6*7))' }, id: 'toolu_ok' };",
    "  const carries = (m) => toolResultText(m, BASH.id).includes('OK-42');",
    '  assertFailsOnMissingOutput(carries, BASH);',
    '  const mock = await startMockAnthropic({',
    "    respond: (body) => body.includes(BASH.id) ? cannedSSE('DONE') : cannedToolUseSSE(BASH.name, BASH.input, BASH.id),",
    '  });',
    '  assert.ok(carries(mock));',
    "  assert.strictEqual(JSON.parse(mock.requests[0].body).model, 'claude-opus-4-8');",
    "  assert.strictEqual(JSON.parse(mock.requests[0].body || '{}').model, 'claude-opus-4-8');",
    "  assert.strictEqual(JSON.parse(mock.requests.at(-1).body)?.max_tokens > 0, true);",
    '});',
    "test('agentic --continue restores the prior session context under tjs', async (t) => {",
    '  if (skipUnlessTjs(t)) return;',
    "  const bin = providerBin(); if (!bin) { t.skip('no CLODE_PROVIDER_BIN'); return; }",
    '  const { cli, dir } = stageBundle(bin);',
    "  const cfg = fs.mkdtempSync(path.join(os.tmpdir(), 'sesscfg-'));",
    '  const TOKEN = `${MARK}-SESSION`;',
    "  const mock = await startMockAnthropic({ respond: () => cannedSSE('TURNDONE') });",
    '  try {',
    '    const env = { ...mockEnv(dir, mock.url), CLAUDE_CONFIG_DIR: cfg };',
    "    const r1 = await bootP(cli, dir, ['-p', `remember this token: ${TOKEN}`], env, 120000);",
    '    assert.strictEqual(r1.status, 0, `turn1 stderr:\\n${r1.stderr}`);',
    '    const after1 = mock.requests.length;',
    "    const r2 = await bootP(cli, dir, ['--continue', '-p', 'what token did I give you?'], env, 120000);",
    '    assert.strictEqual(r2.status, 0, `turn2 stderr:\\n${r2.stderr}`);',
    '    const turn2 = mock.requests.slice(after1);',
    '    assert.ok(turn2.some((q) => q.body && q.body.includes(TOKEN)),',
    '      `--continue did not replay turn-1 context (token ${TOKEN} absent from turn-2 requests)`);',
    '  } finally { await mock.close(); }',
    '});',
  ) },
  // LEGITIMATE, must stay clean: floor-probe's mock machinery. The emitter's definition and a
  // forwarder of a rule's tool are not scripts, so the text-only row G7 (which reads the log
  // to see a POST landed) is not a live check; the B1-shaped row is, and is clean.
  { file: 'synthetic/mock-infrastructure.mjs', text: lines(
    'function toolUseSSE(name, input, id) { return ev(name, input, id); }',
    'function startMock(rules) {',
    '  const requests = [];',
    "  const rule = rules.find((r) => !r.match || body.includes(r.match)) || { text: 'PONG' };",
    "  res.end(rule.tool ? toolUseSSE(rule.tool.name, rule.tool.input, rule.tool.id) : textSSE(rule.text ?? 'PONG'));",
    '  return { requests };',
    '}',
    "const posted = (mock) => mock.requests.some((q) => q.method === 'POST' && /\\/messages/.test(q.url));",
    'const CHECKS = [',
    '  {',
    "    row: 'G7',",
    "    async fn() { const mock = await startMock([{ text: 'PONG' }]); return { ok: posted(mock) }; },",
    '  },',
    '  {',
    "    row: 'B1',",
    '    async fn() {',
    "      const BASH = { name: 'Bash', input: { command: 'echo FLOOR-BASH-$((6*7))' }, id: 'toolu_b1' };",
    "      const carried = (m) => toolResultText(m, BASH.id).includes('FLOOR-BASH-42');",
    '      assertFailsOnMissingOutput(carried, BASH);',
    "      const mock = await startMock([{ match: BASH.id, text: 'done' }, { tool: BASH }]);",
    '      return { ok: carried(mock) };',
    '    },',
    '  },',
    '];',
  ) },
];
const liveCheckControl = () => ({ sources: CONTROL_SOURCES });

// Measured 2026-09-27 (task-1-report.md): the tree holds 13 live tool checks. First cut 12;
// fix round 1 made the unit of a live check the OUTERMOST unit that both scripts and reads
// (so a mock factory cannot hide one), which counts quaude-naude-updateguard's shared driver
// once per acceptance test that runs it (quaude, naude). A drop means a live check was removed
// or merged (move the floor with it, saying which) or the scan went blind (a renamed mock
// emitter, a lexer regression): either way not "clean".
const guard1 = defineGuard({
  name: 'live-checks-judge-output',
  floor: 13,
  read: readLiveCheckSources,
  scan: scanLiveChecks,
  control: liveCheckControl,
});
guardTests(guard1);

// checkControl() only demands one finding. The claim is sharper: each violation is found where
// it is, and the legitimate files yield nothing.
const KIND = [
  [/^a live check reads a raw request body/, 'raw-body'],
  [/^live check .* carries no assertFailsOnMissingOutput/, 'no-control'],
  [/^live check .*'s control is not bound/, 'unbound'],
  [/^live check .* controls an inline function/, 'inline-control'],
  [/^a private tool_result reader/, 'private-reader'],
];
function findingsAt(r, file) {
  return r.findings.filter((f) => f.startsWith(`${file}:`)).map((f) => {
    const m = /^[^:]+:(\d+): (.*)$/.exec(f);
    const kind = m && (KIND.find(([re]) => re.test(m[2])) || [])[1];
    return kind ? `${m[1]} ${kind}` : f;
  });
}
test('the control finds every violation where it is, and nothing in the legitimate files', () => {
  const r = scanLiveChecks(liveCheckControl());
  const at = (file) => findingsAt(r, file);
  assert.deepStrictEqual(at('synthetic/raw-body.test.cjs'), ['8 raw-body', '9 raw-body', '2 no-control']);
  assert.deepStrictEqual(at('history/floor-probe-b1-before-b4ff3f2.mjs'), ['17 raw-body', '3 no-control']);
  // Line 2 is also a private reader: it selected the follow-up by the substring 'tool_result'.
  assert.deepStrictEqual(at('history/agentic-tools-grep-before-f4d763d.test.cjs'),
    ['2 private-reader', '2 raw-body', '20 raw-body', '5 no-control']);
  assert.deepStrictEqual(at('synthetic/mock-factory.test.cjs'),
    ['3 raw-body', '3 no-control', '4 raw-body', '4 no-control']);
  assert.deepStrictEqual(at('synthetic/decoy-control.test.cjs'), [
    '8 raw-body', '5 unbound',
    '13 raw-body', '10 unbound',
    '18 raw-body', '15 unbound',
    '4 raw-body', '20 unbound',
    '25 inline-control',
  ]);
  assert.deepStrictEqual(at('synthetic/bracket-body.test.cjs'), ['6 raw-body']);
  assert.deepStrictEqual(at('synthetic/describe.test.cjs'), ['3 no-control'],
    'test a reads the request history and scripts no tool_use: only the live sibling is a finding');
  assert.deepStrictEqual(at('synthetic/legitimate.test.cjs'), [],
    'a routing mock, structured reads of the model, prose, and a non-live --continue row are not the defect');
  assert.deepStrictEqual(at('synthetic/mock-infrastructure.mjs'), [],
    'the emitter\'s definition and a forwarder of a rule\'s tool are the mock, not a script');
  assert.strictEqual(r.examined, 14, 'live checks in the control: raw-body 1, B1 1, Grep 1, factory 2, '
    + 'decoy 5, bracket 1, describe 1, legitimate 1, B1-shaped row 1');
});

test('a private tool_result reader is found in code, whatever its shape, and not in prose or a built block', () => {
  const r = scanLiveChecks({ sources: [{ file: 'synthetic/reader.cjs', text: lines(
    "// if (b.type === 'tool_result') in a comment",
    "const s = \"b.type !== 'tool_result'\";",
    'function mine(j) {',
    "  for (const b of j) if (b && b.type === 'tool_result') return b;",
    "  return j.find((b) => 'tool_result' === b.type);",
    '}',
    "const either = (b) => ['tool_result'].includes(b.type);",
    "function sw(b) { switch (b.type) { case 'tool_result': return b; default: return null; } }",
    "const built = { type: 'tool_result', tool_use_id: 'toolu_x', content: 'x' };",
    "const routed = (body) => body.includes('\"tool_result\"');",
  ) }] });
  assert.deepStrictEqual(r.findings.map((f) => f.split(': ')[0]),
    ['synthetic/reader.cjs:4', 'synthetic/reader.cjs:5', 'synthetic/reader.cjs:7', 'synthetic/reader.cjs:8']);
});

test('the lexer keeps code and blanks prose, and a file it cannot lex is a finding, not a pass', () => {
  const src = "const a = 'x.body' + `t ${q.body} u` + /\\.body/.test(s); // c.body\nconst b = 1 / 2; x.body";
  const { code, ok } = lexMask(src);
  assert.ok(ok);
  assert.strictEqual((code.match(/\.body\b/g) || []).length, 2, `only the two code reads survive: ${code}`);
  const r = scanLiveChecks({ sources: [{ file: 'synthetic/broken.cjs', text: 'const s = `never closed' }] });
  assert.match(r.findings[0], /could not lex/);
});

test('floor fires: live-checks-judge-output goes BROKEN below its floor', () => {
  const r = checkGate({ name: 'floor-probe-1', floor: guard1.floor,
    read: () => ({ sources: CONTROL_SOURCES.slice(0, 1) }),   // one live check, far under the floor
    scan: scanLiveChecks });
  assert.strictEqual(r.verdict, BROKEN, r.message);
});

// ==========================================================================
// GUARD 2 — missing-output-control-refuses
// ==========================================================================
// assertFailsOnMissingOutput is what every live check's control stands on. If its refusal
// stopped firing, every per-check control in the tree would pass silently and guard 1 would
// still count them as present. This guard feeds it the sanctioned check (no refusal) and, as
// its control, the historical raw-body check (it must refuse).
const REFUSAL = /reads a raw request body|PASSES when the tool's output is missing/;
const sanctionedCheck = () => ({ check: (m) => toolResultText(m, TOOL.id).includes('LIVE-42'), toolUse: TOOL });
const rawBodyCheck = () => ({
  check: (m) => m.requests.some((q) => (q.body || '').includes('FLOOR-BASH-OK')),
  toolUse: { name: 'Bash', input: { command: 'echo FLOOR-BASH-OK' }, id: 'toolu_floor_bash' },
});
const scanControlRefusal = ({ check, toolUse }) =>
  throwsAsFindings(assertFailsOnMissingOutput, [check, toolUse], { examined: 1, expect: REFUSAL });

const guard2 = defineGuard({
  name: 'missing-output-control-refuses',
  floor: 1,
  read: sanctionedCheck,
  scan: scanControlRefusal,
  control: rawBodyCheck,
});
guardTests(guard2);

test('floor fires: missing-output-control-refuses goes BROKEN below its floor', () => {
  const r = checkGate({ name: 'floor-probe-2', floor: guard2.floor,
    read: () => ({}), scan: () => ({ findings: [], examined: 0 }) });
  assert.strictEqual(r.verdict, BROKEN, r.message);
});

module.exports = { lexMask, unitsOf, scanLiveChecks, readLiveCheckSources, liveCheckControl, guard1, guard2 };
