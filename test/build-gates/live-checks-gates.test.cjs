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
// written, and none of the tree's twelve live checks carried a control.
//
// TWO GUARDS, and a shared reader.
//   scripts/lib/tool-result.cjs holds the ONE reader of what the model saw of a tool
//   (toolResult/toolResultText) and the control every live check carries
//   (assertFailsOnMissingOutput). It lives under scripts/lib/ because floor-probe.mjs is a
//   script and both it and the tests must reach it (scripts/lib/text-probe.cjs and
//   paint-probe.cjs are the precedent for a script library the tests require).
//   GUARD 1 `live-checks-judge-output` scans the tree for live checks and their spellings.
//   GUARD 2 `missing-output-control-refuses` controls the helper's own refusal, so the
//   per-check controls stay able to fail.
//
// THE DETECTION RULE (guard 1), exactly:
//   SCOPE. Every .cjs/.mjs file under test/ and every .cjs/.mjs/.js file under scripts/
//   (floor-probe.mjs is a script). Dotfiles and node_modules are not walked. Three files are
//   examined and then exempted by name (LIVE_CHECK_EXEMPT below, each with its reason).
//   VIEW. Each file is lexed into a CODE MASK: comments, string contents, template-literal
//   text and regex bodies become spaces (delimiters, `${...}` expressions and line breaks
//   stay). Every pattern below is matched against the mask, so prose in a comment or a
//   string never reads as code.
//   UNITS. A unit starts at a line whose brace/paren depth is 0 and whose first column is a
//   letter, `_`, `$` or `(` (a top-level statement: a `test(...)`, a function, a declaration),
//   or at a line whose code starts with `row:` (a floor-probe CHECKS row). It runs to the
//   next start. A `function NAME` or `const|let|var NAME =` unit is callable by NAME: unit A
//   CALLS unit B when A's code contains `NAME(` not preceded by `.`, a word character or `$`.
//   LIVE CHECK. A unit that SCRIPTS a tool_use turn itself (`cannedToolUseSSE(`,
//   `toolUseSSE(`, or a mock rule `tool: {...}` / `tool: NAME`) and READS what the mock
//   received (`.requests`, `toolResult(`, `toolResultText(`), itself or through a unit it
//   calls. Its SCOPE is the unit, every unit it calls, and every unit that calls it,
//   transitively, within the file.
//   FINDINGS.
//     (1) raw body: a line in a live check's scope where rawBodyReads() (the helper's
//         statement of the rule) finds `.body` (other than as the whole argument of
//         JSON.parse, which reads a structured field such as the model), or a destructured
//         `{ body }`. That covers judging (`followUp.body.includes(MARK)`), aggregating
//         (`requests.map((q) => q.body)`) and selecting by substring
//         (`find((q) => q.body.includes(id))`): inside a live check the ONE reader selects too.
//     (2) no control: a live check whose scope has no `assertFailsOnMissingOutput(` call.
//     (3) private reader: anywhere in a scanned file, a comparison of `.type` with the
//         string 'tool_result'. A second reader is a second statement of the rule, free to
//         drift.
//   `examined` is the number of live checks found; the floor is the inventory count.
//
// WHAT IT DOES NOT SEE, stated. A live check whose scripting or reading lives in ANOTHER file
// (the scope stops at the file's edge, as guards-population's require() edge does); a body
// read spelled `q['body']` (the mask blanks the string; the runtime rule in
// assertFailsOnMissingOutput reads the check's raw source and does see it); a log judged
// without touching `.body` at all (`JSON.stringify(q).includes(M)`), which the per-check
// control catches at run time instead, because the synthetic follow-up carries the command.
// Controls are counted per live check, not per judged tool: a live check that judges two tools
// needs one control call to pass here, though every check in the tree carries one per tool.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { toolResult, toolResultText, assertFailsOnMissingOutput, rawBodyReads } = require('../../scripts/lib/tool-result.cjs');
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

test('assertFailsOnMissingOutput refuses a check that passes on the synthetic follow-up without spelling .body', () => {
  // No `.body` in the source, so only the run-time half can see it: the synthetic follow-up
  // carries the command, and a check that searches the whole request finds it there.
  const MARK = 'LIVE-STRINGIFY';
  const check = (m) => m.requests.some((q) => JSON.stringify(q).includes(MARK));
  assert.throws(() => assertFailsOnMissingOutput(check, { name: 'Bash', input: { command: `echo ${MARK}` }, id: 'toolu_s' }),
    /PASSES when the tool's output is missing/);
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
// UNITS AND THE CALL GRAPH
// ==========================================================================
function unitsOf(src, code, lineDepth) {
  const cl = code.split('\n'), rl = src.split('\n');
  const units = [];
  let cur = null;
  for (let k = 0; k < cl.length; k++) {
    const line = cl[k];
    const top = lineDepth[k] === 0 && /^[A-Za-z_$(]/.test(line);
    // A floor-probe CHECKS row: only inside a top-level declaration, so an object with a
    // `row:` key inside a test never splits that test.
    const row = /^\s*row\s*:/.test(line) && !!cur && (cur.kind === 'decl' || cur.kind === 'row');
    if (!cur || top || row) {
      let kind = 'other', name = null;
      const fn = /^(?:async\s+)?function\s*\*?\s*([\w$]+)/.exec(line);
      const decl = /^(?:const|let|var)\s+([\w$]+)\s*=/.exec(line);
      if (row) { kind = 'row'; name = `row ${((/row\s*:\s*['"]([^'"]*)['"]/.exec(rl[k])) || [])[1] || '?'}`; }
      else if (/^(?:test|it)\s*(?:\.\s*\w+\s*)?\(/.test(line)) {
        kind = 'test';
        name = `test '${((/\(\s*(['"`])((?:\\.|(?!\1).)*)\1/.exec(rl[k])) || [])[2] || '?'}'`;
      } else if (fn) { kind = 'function'; name = fn[1]; }
      else if (decl) { kind = 'decl'; name = decl[1]; }
      cur = { start: k + 1, lines: [], kind, name };
      units.push(cur);
    }
    cur.lines.push(k);
  }
  for (const u of units) u.code = u.lines.map((k) => cl[k]).join('\n');
  return { units, cl, rl };
}

// A mock rule's `tool:` takes an inline object or a named one (`{ tool: BASH }`): the first
// cut matched only `tool: {`, and moving floor-probe's B1 to a named tool_use dropped the count
// from 12 to 11 — the floor's job, done on its first day.
const SCRIPTS_TOOL_USE = /\bcannedToolUseSSE\s*\(|\btoolUseSSE\s*\(|\btool\s*:\s*[{A-Za-z_$]/;
const READS_REQUESTS = /\.requests\b|\btoolResult(?:Text)?\s*\(/;
const CARRIES_CONTROL = /\bassertFailsOnMissingOutput\s*\(/;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function callGraph(units) {
  const named = units.filter((u) => (u.kind === 'function' || u.kind === 'decl') && u.name);
  const calls = new Map(units.map((u) => [u, new Set()]));
  const calledBy = new Map(units.map((u) => [u, new Set()]));
  for (const f of named) {
    const re = new RegExp(`(?<![\\w$.])${escapeRe(f.name)}\\s*\\(`);
    for (const u of units) {
      if (u === f || !re.test(u.code)) continue;
      calls.get(u).add(f);
      calledBy.get(f).add(u);
    }
  }
  const closure = (u, edges) => {
    const seen = new Set([u]); const todo = [u];
    while (todo.length) for (const v of edges.get(todo.pop())) if (!seen.has(v)) { seen.add(v); todo.push(v); }
    return seen;
  };
  return { callees: (u) => closure(u, calls), callers: (u) => closure(u, calledBy) };
}

// ==========================================================================
// GUARD 1 — live-checks-judge-output
// ==========================================================================
// Examined, then exempted by name. Each is a file the rule would misread, never one it would
// catch doing the thing it forbids.
const LIVE_CHECK_EXEMPT = new Map([
  ['scripts/lib/tool-result.cjs', 'the ONE reader: it parses request bodies and tool_result blocks on every '
    + 'live check\'s behalf, which is exactly what the rule sends every other file to it for'],
  ['test/build-gates/live-checks-gates.test.cjs', 'this guard: its unit tests build synthetic request logs and '
    + 'its control fixtures ARE the violations it detects'],
  ['test/mock-anthropic-child.cjs', 'the mock itself, run as a child: it scripts tool_use turns FOR a caller '
    + 'and writes the request log (method, url) to a file; it judges nothing'],
]);

// A private tool_result reader: `.type` compared with the string 'tool_result', either order.
// Matched on the MASK (so a comment or a string that merely mentions it does not count) and
// confirmed on the raw text at the same position (the mask blanked the string's contents).
const TYPE_VS_STRING = [/\.type\s*[!=]==?\s*(['"`])\s*\1/g, /(['"`])\s*\1\s*[!=]==?\s*[\w$.]+\.type\b/g];

function scanLiveChecks({ sources }) {
  const findings = [];
  let live = 0;
  const liveFiles = new Set();
  for (const { file, text } of sources) {
    if (LIVE_CHECK_EXEMPT.has(file)) continue;
    const lx = lexMask(text);
    if (!lx.ok) {
      findings.push(`${file}: the scan could not lex this file (${lx.why}), so it cannot see its live checks`);
      continue;
    }
    const { units, cl, rl } = unitsOf(text, lx.code, lx.lineDepth);
    // (3) private reader, anywhere in the file.
    cl.forEach((line, k) => {
      for (const re of TYPE_VS_STRING) {
        for (const m of line.matchAll(re)) {
          if (!/tool_result/.test(rl[k].slice(m.index, m.index + m[0].length))) continue;
          findings.push(`${file}:${k + 1}: a private tool_result reader. The one reader is `
            + 'scripts/lib/tool-result.cjs (toolResult/toolResultText); a second copy is free to drift');
        }
      }
    });
    const g = callGraph(units);
    const reported = new Set();
    for (const u of units) {
      if (!SCRIPTS_TOOL_USE.test(u.code)) continue;
      const down = g.callees(u);
      if (![...down].some((v) => READS_REQUESTS.test(v.code))) continue;
      live++;
      liveFiles.add(file);
      const scope = [...new Set([...down, ...g.callers(u)])].sort((a, b) => a.start - b.start);
      const label = u.name || `the unit at line ${u.start}`;
      // (1) raw body, on every line of the scope.
      for (const v of scope) {
        for (const k of v.lines) {
          const reads = rawBodyReads(cl[k]);
          if (!reads.length || reported.has(k)) continue;
          reported.add(k);
          findings.push(`${file}:${k + 1}: a live check reads a raw request body (${reads.join(', ')}); `
            + `${label} judges what a request carried, and every follow-up also carries the tool_use, `
            + 'i.e. the command. Read the tool_result: toolResult()/toolResultText() in scripts/lib/tool-result.cjs');
        }
      }
      // (2) the control.
      if (!scope.some((v) => CARRIES_CONTROL.test(v.code))) {
        findings.push(`${file}:${u.start}: live check ${label} carries no assertFailsOnMissingOutput(check, toolUse) `
          + 'control, so nothing proves it fails when the output is missing');
      }
    }
  }
  return { findings, examined: live,
    note: `${live} live check(s) in ${liveFiles.size} file(s), of ${sources.length} file(s) scanned` };
}

function readLiveCheckSources() {
  const files = [
    ...discoverFilesByExt(path.join(REPO, 'test'), ['.cjs', '.mjs']),
    ...discoverFilesByExt(path.join(REPO, 'scripts'), ['.cjs', '.mjs', '.js']),
  ];
  return { sources: files.map((f) => ({ file: posixRel(f), text: fs.readFileSync(f, 'utf8') })) };
}

// THE CONTROL. Three violations, two of them VERBATIM from history (the checks that said green
// while Grep and compound Bash commands were broken), and one legitimate file that must stay
// clean. Lines are kept as arrays so the historical source survives byte for byte.
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
  // LEGITIMATE, must stay clean: a live check judged on the tool_result with its control, a
  // mock that routes on the body, a structured read of the request's model, a private reader
  // named only in a comment and a string, and the --continue row (verbatim from
  // agentic-tools.test.cjs), which judges the request history, scripts no tool_use, and so is
  // not a live check at all.
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
];
const liveCheckControl = () => ({ sources: CONTROL_SOURCES });

// Measured 2026-09-27 (task-1-report.md, Step 1): the tree holds 12 live tool checks. A drop
// means a live check was removed or merged (move the floor with it, saying which) or the
// scan went blind (a renamed mock emitter, a lexer regression): either way not "clean".
const guard1 = defineGuard({
  name: 'live-checks-judge-output',
  floor: 12,
  read: readLiveCheckSources,
  scan: scanLiveChecks,
  control: liveCheckControl,
});
guardTests(guard1);

// checkControl() only demands one finding. The claim is sharper: each violation is found
// where it is, and the legitimate file yields nothing.
test('the control finds every historical violation where it is, and nothing in the legitimate file', () => {
  const r = scanLiveChecks(liveCheckControl());
  const at = (file) => r.findings.filter((f) => f.startsWith(`${file}:`)).map((f) => {
    const m = /^[^:]+:(\d+): (a live check reads a raw request body|live check|a private tool_result reader)/.exec(f);
    return m ? `${m[1]} ${m[2] === 'live check' ? 'no-control' : m[2] === 'a private tool_result reader' ? 'private-reader' : 'raw-body'}` : f;
  });
  assert.deepStrictEqual(at('synthetic/raw-body.test.cjs'), ['8 raw-body', '9 raw-body', '2 no-control']);
  assert.deepStrictEqual(at('history/floor-probe-b1-before-b4ff3f2.mjs'), ['17 raw-body', '3 no-control']);
  assert.deepStrictEqual(at('history/agentic-tools-grep-before-f4d763d.test.cjs'),
    ['2 raw-body', '20 raw-body', '5 no-control']);
  assert.deepStrictEqual(at('synthetic/legitimate.test.cjs'), [],
    'a routing mock, a JSON.parse of the model, prose, and a non-live --continue row are not the defect');
  assert.strictEqual(r.examined, 4, 'four live checks in the control: three violations and one clean');
});

test('a private tool_result reader is found in code, and not in a comment or a string', () => {
  const r = scanLiveChecks({ sources: [{ file: 'synthetic/reader.cjs', text: lines(
    "// if (b.type === 'tool_result') in a comment",
    "const s = \"b.type !== 'tool_result'\";",
    'function mine(j) {',
    "  for (const b of j) if (b && b.type === 'tool_result') return b;",
    "  return j.find((b) => 'tool_result' === b.type);",
    '}',
  ) }] });
  assert.deepStrictEqual(r.findings.map((f) => f.split(': ')[0]), ['synthetic/reader.cjs:4', 'synthetic/reader.cjs:5']);
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
    read: () => liveCheckControl(),          // 4 live checks, far under the tree's 12
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
