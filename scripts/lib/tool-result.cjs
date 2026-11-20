'use strict';
// WHAT THE MODEL SAW OF A TOOL CALL, and the control every live tool check carries. A test
// and probe library: scripts/floor-probe.mjs and the tests that drive a real turn against a
// mock require it. Nothing a product build runs requires it.
//
// THE TRAP. After a tool call the target sends the model a follow-up request. Only one part of
// it is the tool's output: the tool_result block in the LAST user turn. Everything else is
// context the model already had: the system prompt, the tool definitions, and the assistant's
// own tool_use, which spells the command. A check that searches the whole body for a marker
// the command spells (`echo MARK`, `pattern: MARK`) passes whether or not the tool ran. Every
// clode release from 2.1.185 to 2.1.283 shipped a broken Grep and Glob, broken grep/find
// flags and broken compound Bash commands while checks shaped exactly like that said green
// (memory: instruments-lie-check-them-first; b4ff3f2 and f4d763d fixed the first three).
//
// So there is ONE reader (toolResult / toolResultText) and ONE rule (rawBodyReads), and every
// live check carries a control (assertFailsOnMissingOutput) proving its judgment fails when
// the output is missing. test/build-gates/live-checks-gates.test.cjs holds the tree to all
// three.

// The parsed request bodies of `source`, in order. `source` is one request body (the JSON
// text, or the parsed object), a mock (anything with a `requests` array of { body }), or such
// an array itself. A body that does not parse (a GET, a non-JSON side call) is not a turn.
function bodiesOf(source) {
  const parse = (b) => {
    if (b && typeof b === 'object') return b;
    try { return JSON.parse(String(b)); } catch { return null; }
  };
  if (typeof source === 'string' || (source && Array.isArray(source.messages))) return [parse(source)];
  const log = Array.isArray(source) ? source : (source && Array.isArray(source.requests) ? source.requests : []);
  return log.map((q) => parse(q && typeof q === 'object' && 'body' in q ? q.body : q));
}

const isSingleBody = (source) => typeof source === 'string' || !!(source && Array.isArray(source.messages));

// What the model reads of a tool_result's content: the string, or the text of its blocks.
function textOf(content) {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map((c) => (c && c.text) || '').join('') : '';
}

// The tool_result for tool_use `id` as the model saw it: { text, isError, content }, or null
// when no request carried one. Read from the LAST user turn of a request, never from its
// history, and from the FIRST request in a log whose last user turn carries it (the follow-up
// that answered the tool call). With a single body `id` may be omitted: every tool_result of
// that turn, joined. A log without an id is refused: it holds many turns.
function toolResult(source, id) {
  if (!isSingleBody(source) && (typeof id !== 'string' || !id)) {
    throw new Error('toolResult: reading a request LOG needs the tool_use id: a log holds many '
      + 'turns, and reading "the" tool_result without naming the call is ambiguous');
  }
  for (const body of bodiesOf(source)) {
    const turns = body && Array.isArray(body.messages) ? body.messages.filter((m) => m && m.role === 'user') : [];
    const last = turns[turns.length - 1];
    if (!last || !Array.isArray(last.content)) continue;
    const blocks = last.content.filter((b) => b && b.type === 'tool_result' && (id === undefined || b.tool_use_id === id));
    if (!blocks.length) continue;
    return {
      text: blocks.map((b) => textOf(b.content)).join(''),
      isError: blocks.some((b) => b.is_error === true),
      content: blocks.length === 1 ? blocks[0].content : blocks.map((b) => b.content),
    };
  }
  return null;
}

// The tool_result's text, '' when none was sent.
function toolResultText(source, id) {
  const r = toolResult(source, id);
  return r ? r.text : '';
}

// What the target sent the model ALONGSIDE tool_use `id`'s tool_result, in the same last user turn: the text of the
// blocks other than tool_results, joined, or null when no request carried that tool_result. A tool may answer in two
// parts: Skill's tool_result says "Launching skill: <name>", and the skill's body, $ARGUMENTS filled in, follows it as a
// text block of the same turn (measured on native 2.1.283, every-tool Task 4). Like toolResult, it reads the turn that
// answered the call, never the history and never the tool_use, so a marker only the tool_use input spells is not seen.
function toolFollowUpText(source, id) {
  if (typeof id !== 'string' || !id) throw new Error('toolFollowUpText: name the tool_use id whose turn to read');
  for (const body of bodiesOf(source)) {
    const turns = body && Array.isArray(body.messages) ? body.messages.filter((m) => m && m.role === 'user') : [];
    const last = turns[turns.length - 1];
    if (!last || !Array.isArray(last.content)) continue;
    if (!last.content.some((b) => b && b.type === 'tool_result' && b.tool_use_id === id)) continue;
    return last.content.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('');
  }
  return null;
}

// THE RULE, stated once: a live check never reads a logged request's raw body, or the log
// itself, as text. Returns [{ at, what }] for each read found in `code` (at = index), [] when
// none. The spellings:
//   `.body`, `['body']`, and a destructured body (`{ body }`, `{ body: b }`) bound by `=`,
//   an arrow's parameter list or a for-of;
//   EXCEPT `JSON.parse(X.body)` (optionally `|| '{}'` / `?? ...`) read straight through to a
//   field other than `messages` -- the model, the max_tokens: a structured field, not the
//   history. `.messages` IS the history, tool_use and all, so it counts as a read;
//   JSON.stringify / Object.values / Object.entries over anything naming `requests`, and one
//   of them inside a callback of `.requests.some|find|map|...(` or on a `for (... of
//   X.requests)` line: stringifying a request searches its body.
// Applied twice: over the test tree by the build gate (on a code mask, so prose never counts),
// and at run time over each check's own source by assertFailsOnMissingOutput.
function closeParen(s, open) {
  let d = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') d++;
    else if (s[i] === ')' && --d === 0) return i;
  }
  return -1;
}
function openParen(s, at) {
  let d = 0;
  for (let i = at - 1; i >= 0; i--) {
    if (s[i] === ')') d++;
    else if (s[i] === '(') { if (d === 0) return i; d--; }
  }
  return -1;
}
// The `(...)` argument text of the call whose name ends at s[i] (s[i] is at or before its '(').
function argOf(s, i) {
  const open = s.indexOf('(', i);
  const close = open < 0 ? -1 : closeParen(s, open);
  return close < 0 ? '' : s.slice(open + 1, close);
}
// `.body` read straight through JSON.parse to a field that is not the history.
function isStructuredParse(s, at) {
  const open = openParen(s, at);
  if (open < 0 || !/JSON\.parse\s*$/.test(s.slice(Math.max(0, open - 24), open))) return false;
  const close = closeParen(s, open);
  if (close < 0) return false;
  const fallback = /^\s*(?:(?:\|\||\?\?)\s*(?:(['"`])[^'"`]*\1|\{\s*\}|[\w$.]+))?\s*$/;
  if (!fallback.test(s.slice(at + '.body'.length, close))) return false;
  const field = /^\s*(?:\?\.|\.)\s*([\w$]+)|^\s*\[\s*(['"`])([\w$]+)\2\s*\]/.exec(s.slice(close + 1));
  const name = field && (field[1] || field[3]);
  return !!name && name !== 'messages';
}
const STRINGIFY = /\b(?:JSON\.stringify|Object\.(?:values|entries))\s*\(/g;
function rawBodyReads(code) {
  const s = String(code);
  const out = [];
  for (const m of s.matchAll(/\.body\b/g)) {
    if (!isStructuredParse(s, m.index)) out.push({ at: m.index, what: '.body' });
  }
  for (const m of s.matchAll(/\[\s*(['"`])body\1\s*\]/g)) out.push({ at: m.index, what: m[0] });
  for (const m of s.matchAll(/\{[^{}]*\bbody\b[^{}]*\}\s*(?:\)\s*=>|=(?![=>])|of\b)/g)) {
    out.push({ at: m.index, what: `destructured ${m[0].replace(/\s+/g, ' ')}` });
  }
  for (const m of s.matchAll(STRINGIFY)) {
    if (/\brequests\b/.test(argOf(s, m.index))) out.push({ at: m.index, what: `${m[0].replace(/\s*\($/, '')} over the request log` });
  }
  const inLog = [];
  for (const m of s.matchAll(/\.requests\s*\.\s*(?:some|every|find|findLast|findIndex|filter|map|flatMap|forEach|reduce)\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    inLog.push([open, closeParen(s, open)]);
  }
  for (const m of s.matchAll(/\bof\s+[\w$.]*\brequests\b/g)) {
    const eol = s.indexOf('\n', m.index);
    inLog.push([m.index, eol < 0 ? s.length : eol]);
  }
  for (const m of s.matchAll(STRINGIFY)) {
    if (out.some((r) => r.at === m.index)) continue;
    if (inLog.some(([a, b]) => m.index > a && (b < 0 || m.index < b))) {
      out.push({ at: m.index, what: `${m[0].replace(/\s*\($/, '')} of a logged request` });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

// The command text of a tool_use: a Bash command, or every string the input carries.
function commandText(input) {
  if (input && typeof input.command === 'string') return input.command;
  const strings = [];
  const walk = (v) => {
    if (typeof v === 'string') strings.push(v);
    else if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k]);
  };
  walk(input);
  return strings.length ? strings.join('\n') : JSON.stringify(input === undefined ? {} : input);
}

// Every way the output can be missing while the command text is still in the request: the
// shapes a check must FAIL on. The command rides in the prompt and in the tool_use on every
// one; the last two put it in the tool_result itself, as an error or a shell that echoes a
// command it could not run would.
// `context` (optional): the earlier calls of the turn, each { use, content[, isError] } (a tool_use and the
// tool_result it really got), so a check that reads an earlier call's answer (TaskStop reads the id a background
// Bash answered with) sees it, and fails only because THIS call's output is missing. Each earlier call gets the
// follow-up request that answered it, as a real turn sends it.
function turnShape(toolUse, context = []) {
  const cmd = commandText(toolUse.input);
  const prompt = { role: 'user', content: [{ type: 'text', text: `run this: ${cmd}` }] };
  const useOf = (u) => ({ role: 'assistant', content: [{ type: 'tool_use', id: u.id, name: u.name, input: u.input }] });
  const history = [prompt];
  const bodies = [{ model: 'claude-synthetic', system: cmd, messages: [prompt] }];
  for (const c of context) {
    history.push(useOf(c.use), { role: 'user', content: [{ type: 'tool_result', tool_use_id: c.use.id, content: c.content, ...(c.isError ? { is_error: true } : {}) }] });
    bodies.push({ model: 'claude-synthetic', system: cmd, messages: history.slice() });
  }
  const use = useOf(toolUse);
  const log = (last) => ({
    requests: [...bodies, { model: 'claude-synthetic', system: cmd, messages: [...history, use, last] }]
      .map((b) => ({ method: 'POST', url: '/v1/messages', body: JSON.stringify(b) })),
  });
  const result = (extra) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUse.id, ...extra }] });
  return { cmd, log, result };
}
// The turn with this call ANSWERED by `content`: the positive side of a control, for a check that also reads the
// context (it must PASS here, so its failures on the missing-output logs are about this call's output).
function answeredLog(toolUse, content, context = [], isError = false) {
  const { log, result } = turnShape(toolUse, context);
  return log(result({ content, ...(isError ? { is_error: true } : {}) }));
}
function missingOutputLogs(toolUse, context = []) {
  const { cmd, log, result } = turnShape(toolUse, context);
  return [
    { why: 'no tool_result at all', log: log({ role: 'user', content: [{ type: 'text', text: 'continue' }] }) },
    { why: 'an empty tool_result', log: log(result({ content: '' })) },
    { why: 'an empty tool_result block list', log: log(result({ content: [] })) },
    { why: 'an error tool_result that quotes the command', log: log(result({ content: cmd, is_error: true })) },
    { why: 'a tool_result that only echoes the command', log: log(result({ content: [{ type: 'text', text: cmd }] })) },
  ];
}

// THE CONTROL. `check` is the live check's judgment, a function of the request log (the mock,
// or anything toolResult reads) returning a boolean. `command` is the tool_use exactly as the
// mock scripts it, { name, input, id }: the id matters because the check looks its result up
// by id, and a control fed some other id would fail for the wrong reason and prove nothing.
// Refuses a check whose own source reads a raw request body, and a check that passes on any
// log in missingOutputLogs(). Share one `command` object between the mock and this call, so
// the control cannot drift from what the real run sends.
// `modes` (optional) declares the cells the driver covers, a mode name or an array of them
// ('print' when absent): test/build-gates/tool-coverage-gates.test.cjs reads it from the source,
// as string literals, and counts the tool x mode cells where a CI job runs this test. Here it is
// only checked for shape: the control proves the judgment, not the mode.
// `context` (optional, after modes): the earlier calls the check reads, [{ use, content[, isError] }], each with the
// answer it really got (missingOutputLogs). Without it, a check that also needs an earlier call's answer fails on
// every missing-output log for the wrong reason (that answer is missing too) and proves nothing about its own call.
// A DRIVEN cell's check must also FAIL on the harness's answer for a tool that is not registered ("No such tool
// available: <name>", final-review I3): a check that passed there would read an unregistered tool as driven. Only
// assertNotRegistered, whose check must pass there, skips that row.
function assertFailsOnMissingOutput(check, command, modes, context) {
  failsOnMissingOutput(check, command, modes, context);
  const use = command;
  for (const absent of [`<tool_use_error>Error: No such tool available: ${use.name}</tool_use_error>`,
    `<tool_use_error>Error: No such tool available: ${use.name}. ${use.name} is disabled for this session, in subagents as well as here.</tool_use_error>`]) {
    if (check(answeredLog(use, absent, context || [], true)) !== false) {
      throw new Error(`assertFailsOnMissingOutput: this check PASSES on "No such tool available: ${use.name}", the answer of a `
        + 'target that does not register the tool, so an unregistered tool would read as driven. Judge the tool\'s own '
        + 'answer; a cell where the tool is not registered is proven with assertNotRegistered.');
    }
  }
}
function failsOnMissingOutput(check, command, modes, context) {
  if (modes !== undefined && !(typeof modes === 'string' && modes)
    && !(Array.isArray(modes) && modes.length && modes.every((m) => typeof m === 'string' && m))) {
    throw new Error(`assertFailsOnMissingOutput: modes must be a mode name or an array of them, got ${JSON.stringify(modes)}`);
  }
  if (typeof check !== 'function') {
    throw new Error('assertFailsOnMissingOutput: `check` must be the live check\'s judgment, a function '
      + 'of the request log that returns a boolean');
  }
  const use = command || {};
  if (typeof use.id !== 'string' || !use.id || typeof use.name !== 'string' || !use.input || typeof use.input !== 'object') {
    throw new Error('assertFailsOnMissingOutput: needs the tool_use { name, input, id } the mock scripts, '
      + `got ${JSON.stringify(command)}`);
  }
  const reads = rawBodyReads(String(check));
  if (reads.length) {
    throw new Error(`assertFailsOnMissingOutput: this check reads a raw request body (${reads.map((r) => r.what).join(', ')}). `
      + 'Every follow-up also carries the tool_use, i.e. the command, so the check can pass on the command '
      + 'text alone. Judge toolResult()/toolResultText() instead.');
  }
  if (context !== undefined && !(Array.isArray(context) && context.every((c) => c && c.use && typeof c.use.id === 'string'
    && typeof c.use.name === 'string' && c.use.input && typeof c.use.input === 'object'
    && (typeof c.content === 'string' || Array.isArray(c.content))))) {
    throw new Error('assertFailsOnMissingOutput: context must be the earlier calls, [{ use: { name, input, id }, content[, isError] }]');
  }
  for (const v of missingOutputLogs(use, context || [])) {
    const verdict = check(v.log);
    if (typeof verdict !== 'boolean') {
      throw new Error(`assertFailsOnMissingOutput: the check must return a boolean verdict; it returned ${typeof verdict}`);
    }
    if (verdict) {
      throw new Error(`assertFailsOnMissingOutput: this check PASSES when the tool's output is missing (${v.why}). `
        + `It cannot tell the command text (${JSON.stringify(commandText(use.input))}) from output the model saw. `
        + 'Judge the tool_result for something only real output contains: a COMPUTED marker the command does '
        + 'not spell (scripts/floor-probe.mjs B1 echoes FLOOR-BASH-$((6*7)) and looks for FLOOR-BASH-42).');
    }
  }
}

// THE NOT-APPLICABLE CONTROL (every-tool ruling E10): a cell where the tool is NOT REGISTERED in that mode (the Task
// list tools when unlisted). Neither driven nor exempted: test/build-gates/tool-coverage-gates.test.cjs counts it
// not-applicable only where a CI job runs a check this control vetted, so the cell is proven on every run by the
// target's own answer. `answers` is { absent, registered }: `absent` is the harness's answer to a call of a tool it
// does not have (it must spell "No such tool available: <name>"), `registered` the tool's own answer elsewhere (print's).
// The check must fail on every missing-output log (assertFailsOnMissingOutput), PASS on `absent` and FAIL on
// `registered`: so a target that does register the tool fails the check, and the cell goes red.
function assertNotRegistered(check, command, modes, answers) {
  failsOnMissingOutput(check, command, modes);
  const { absent, registered } = answers || {};
  const text = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b && b.text) || '').join('') : null);
  if (text(absent) === null || text(registered) === null) {
    throw new Error('assertNotRegistered: answers must be { absent, registered }, each a tool_result content');
  }
  if (!text(absent).includes(`No such tool available: ${command.name}`)) {
    throw new Error(`assertNotRegistered: the absent answer must be the harness's "No such tool available: ${command.name}", `
      + `got ${JSON.stringify(text(absent).slice(0, 120))}`);
  }
  if (check(answeredLog(command, absent, [], true)) !== true) {
    throw new Error(`assertNotRegistered: the check does not pass on the absent answer for ${command.name}`);
  }
  if (check(answeredLog(command, registered)) !== false) {
    throw new Error(`assertNotRegistered: the check PASSES on ${command.name}'s registered answer, so a target that registers `
      + 'the tool would still read as not applicable');
  }
}

module.exports = { toolResult, toolResultText, toolFollowUpText, rawBodyReads, assertFailsOnMissingOutput, answeredLog,
  assertNotRegistered };
