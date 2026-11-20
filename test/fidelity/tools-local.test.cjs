'use strict';
// THE LOCAL TOOLS END TO END: Read, Write and NotebookEdit (every-tool plan, Phase A, Task 2), and the Task* tools
// and TaskStop (Task 3, the second half of this file), in a built quaude, judged against native.
//
// WHAT IS JUDGED. One -p turn (test/tool-driver.cjs driveTool) against a canned mock that asks, one tool_use per
// follow-up, for every call in SCRIPT, over a tree laid fresh in <B>/work: Read a whole file, a line range
// (offset/limit) and a missing file; Write a new file, overwrite a file the turn never read, Read it, overwrite it
// again; Read a notebook (.ipynb) and replace one of its cells with NotebookEdit. Each tool_result (its text and
// is_error, as the model reads it: scripts/lib/tool-result.cjs) must equal NATIVE's, byte for byte, with nothing
// normalized but the temp dir's own path (<B>); and the tree left on disk must equal native's (DISK).
//
// NATIVE is native Claude Code 2.1.283's answer to this exact script over this exact tree, MEASURED with driveTool's
// native side (darwin-arm64, 2026-11-19; the quaude built from this tree gave the same, every call and the disk). The
// second test runs native itself against the same literals wherever it runs (driveTool's default native: the pinned
// provider when it RUNS here, never PATH's claude), so a native that moved, or another platform's native that
// differs, is named, not hidden. Where none runs, that test skips by name. linux-x64-pty and node-shim-oracle-darwin
// each install the pinned native that runs and build the quaude from it, and run both tests (test/ci-gates.cjs FILES
// accepts no skip in either). The native test passes driveTool's quaudeSkip, so tool-coverage-gates counts only the
// first test as driving a quaude cell.
//
// MEASURED ALONG THE WAY (2.1.283, both engines): Write over a file the turn never read SUCCEEDS in a -p turn ("has
// been updated successfully"), as Edit's read-before-edit does not apply to it here; a Read of a missing file is an
// error result naming the working directory; Read numbers lines `N<TAB>` and shows the empty line after a final
// newline; Read renders a notebook as <cell id> blocks; NotebookEdit's replace writes `source` as one string.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { driveTool } = require('../tool-driver.cjs');
const { builtQuaude } = require('../built-binary.cjs');
const { rgOracle, rgOracleSkip } = require('../provider-resolve.cjs');
const { toolResult, toolResultText, assertFailsOnMissingOutput } = require('../../scripts/lib/tool-result.cjs');

// The tree, laid fresh before each side's turn. <B> is a temp dir both sides share, so the absolute paths the tool_use
// inputs must name are the same for both.
const NOTEBOOK = {
  cells: [
    { cell_type: 'markdown', id: 'c-md', metadata: {}, source: ['# Title\n'] },
    { cell_type: 'code', id: 'c-code', execution_count: null, metadata: {}, outputs: [], source: ['x = 6 * 7\n', 'print(x)\n'] },
  ],
  metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' } },
  nbformat: 4, nbformat_minor: 5,
};
const TREE = { 'a.txt': 'one\ntwo\nthree\nfour\nfive\n', 'b.txt': 'old\n', 'n.ipynb': JSON.stringify(NOTEBOOK, null, 1) };
const layTree = (work) => { for (const [f, text] of Object.entries(TREE)) fs.writeFileSync(path.join(work, f), text); };
const readTree = (work) => Object.fromEntries(fs.readdirSync(work).sort().map((f) => [f, fs.readFileSync(path.join(work, f), 'utf8')]));

const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tools-local-')));
process.on('exit', () => { try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* best effort */ } });
const W = (f) => path.join(BASE, 'work', f);

// THE CALLS, in the order the mock asks for them.
const READ = { name: 'Read', input: { file_path: W('a.txt') }, id: 'toolu_tl_read' };
const READ_RANGE = { name: 'Read', input: { file_path: W('a.txt'), offset: 2, limit: 2 }, id: 'toolu_tl_read_range' };
const READ_MISSING = { name: 'Read', input: { file_path: W('nope.txt') }, id: 'toolu_tl_read_missing' };
const WRITE_NEW = { name: 'Write', input: { file_path: W('new.txt'), content: 'fresh\n' }, id: 'toolu_tl_write_new' };
const WRITE_UNREAD = { name: 'Write', input: { file_path: W('b.txt'), content: 'over\n' }, id: 'toolu_tl_write_unread' };
const READ_B = { name: 'Read', input: { file_path: W('b.txt') }, id: 'toolu_tl_read_b' };
const WRITE_OVER = { name: 'Write', input: { file_path: W('b.txt'), content: 'again\n' }, id: 'toolu_tl_write_over' };
const READ_NB = { name: 'Read', input: { file_path: W('n.ipynb') }, id: 'toolu_tl_read_nb' };
const NB_REPLACE = { name: 'NotebookEdit', input: { notebook_path: W('n.ipynb'), cell_id: 'c-code', new_source: 'y = 3 + 4\nprint(y)' }, id: 'toolu_tl_nb_replace' };
const SCRIPT = [{ tool: READ }, { tool: READ_RANGE }, { tool: READ_MISSING }, { tool: WRITE_NEW }, { tool: WRITE_UNREAD },
  { tool: READ_B }, { tool: WRITE_OVER }, { tool: READ_NB }, { tool: NB_REPLACE }];

// MEASURED: native 2.1.283's tool_results for SCRIPT, as { text, isError }; <B> is the temp dir. The em dash is built
// from its code point (memory: tool-hazard-unicode-escapes).
const STATE_CURRENT = `(file state is current in your context ${String.fromCodePoint(0x2014)} no need to Read it back)`;
const NATIVE = {
  toolu_tl_read: { text: '1\tone\n2\ttwo\n3\tthree\n4\tfour\n5\tfive\n6\t', isError: false },
  toolu_tl_read_range: { text: '2\ttwo\n3\tthree', isError: false },
  toolu_tl_read_missing: { text: 'File does not exist. Note: your current working directory is <B>/work.', isError: true },
  toolu_tl_write_new: { text: `File created successfully at: <B>/work/new.txt ${STATE_CURRENT}`, isError: false },
  toolu_tl_write_unread: { text: `The file <B>/work/b.txt has been updated successfully. ${STATE_CURRENT}`, isError: false },
  toolu_tl_read_b: { text: '1\tover\n2\t', isError: false },
  toolu_tl_write_over: { text: `The file <B>/work/b.txt has been updated successfully. ${STATE_CURRENT}`, isError: false },
  toolu_tl_read_nb: { text: '<cell id="c-md"><cell_type>markdown</cell_type># Title\n</cell id="c-md">\n'
    + '<cell id="c-code">x = 6 * 7\nprint(x)\n</cell id="c-code">', isError: false },
  toolu_tl_nb_replace: { text: 'Updated cell c-code with y = 3 + 4\nprint(y)', isError: false },
};
// ...and the tree native left: a.txt untouched, new.txt created, b.txt overwritten twice, the code cell replaced (its
// source one string now, the rest of the notebook as it was, re-serialized with one-space indent).
const NB_AFTER = { ...NOTEBOOK, cells: [NOTEBOOK.cells[0], { ...NOTEBOOK.cells[1], source: 'y = 3 + 4\nprint(y)' }] };
const DISK = { 'a.txt': TREE['a.txt'], 'b.txt': 'again\n', 'n.ipynb': JSON.stringify(NB_AFTER, null, 1), 'new.txt': 'fresh\n' };

const want = (USE) => { const w = NATIVE[USE.id]; return w && { text: w.text.split('<B>').join(BASE), isError: w.isError }; };
const sameAs = (r, USE) => { const w = want(USE); return !!r && !!w && r.text === w.text && r.isError === w.isError; };

// One check per call: the tool_result for that call's id equals native's.
const readWhole = (m) => sameAs(toolResult(m, READ.id), READ);
const readRange = (m) => sameAs(toolResult(m, READ_RANGE.id), READ_RANGE);
const readMissing = (m) => sameAs(toolResult(m, READ_MISSING.id), READ_MISSING);
const writeNew = (m) => sameAs(toolResult(m, WRITE_NEW.id), WRITE_NEW);
const writeUnread = (m) => sameAs(toolResult(m, WRITE_UNREAD.id), WRITE_UNREAD);
const readB = (m) => sameAs(toolResult(m, READ_B.id), READ_B);
const writeOver = (m) => sameAs(toolResult(m, WRITE_OVER.id), WRITE_OVER);
const readNb = (m) => sameAs(toolResult(m, READ_NB.id), READ_NB);
const nbReplace = (m) => sameAs(toolResult(m, NB_REPLACE.id), NB_REPLACE);
const verdicts = (m) => [[READ, readWhole(m)], [READ_RANGE, readRange(m)], [READ_MISSING, readMissing(m)],
  [WRITE_NEW, writeNew(m)], [WRITE_UNREAD, writeUnread(m)], [READ_B, readB(m)], [WRITE_OVER, writeOver(m)],
  [READ_NB, readNb(m)], [NB_REPLACE, nbReplace(m)]];

// Each control: every check must FAIL when its tool's output is missing.
function controls() {
  assertFailsOnMissingOutput(readWhole, READ);
  assertFailsOnMissingOutput(readRange, READ_RANGE);
  assertFailsOnMissingOutput(readMissing, READ_MISSING);
  assertFailsOnMissingOutput(writeNew, WRITE_NEW);
  assertFailsOnMissingOutput(writeUnread, WRITE_UNREAD);
  assertFailsOnMissingOutput(readB, READ_B);
  assertFailsOnMissingOutput(writeOver, WRITE_OVER);
  assertFailsOnMissingOutput(readNb, READ_NB);
  assertFailsOnMissingOutput(nbReplace, NB_REPLACE);
}

// Every finding on one side's turn: its exit, each call's verdict, and the tree it left.
function findings(label, side) {
  const out = [];
  if (side.status !== 0) out.push(`${label}: the turn exited ${side.status}${side.signal ? ` (${side.signal})` : ''}: ${side.stderr.slice(0, 800)}`);
  for (const [USE, same] of verdicts(side.raw)) {
    if (!same) out.push(`${label}: ${USE.id} ${USE.name}\n    native: ${JSON.stringify(want(USE))}\n    got:    ${JSON.stringify(toolResult(side.raw, USE.id))}`);
  }
  if (JSON.stringify(side.inspected) !== JSON.stringify(DISK)) {
    out.push(`${label}: the tree left on disk differs from native's\n    native: ${JSON.stringify(DISK)}\n    got:    ${JSON.stringify(side.inspected)}`);
  }
  return out;
}

const SKIP = process.platform === 'win32' ? 'the recorded answers name POSIX paths' : false;

test('Read, Write and NotebookEdit in a built quaude: every tool_result, and the tree left, equal native\'s', { skip: SKIP }, async (t) => {
  const q = builtQuaude();
  if (q.skip) { t.skip(q.skip); return; }
  controls();
  const r = await driveTool({ script: SCRIPT, base: BASE, quaude: q.path, setup: layTree, inspect: readTree,
    nativeSkip: 'native is judged against the same recorded answers by the next test' });
  const got = findings('quaude', r.quaude);
  assert.deepStrictEqual(got, [], `${got.length} finding(s) against native's answers:\n${got.join('\n')}`);
});

// THE INSTRUMENT: native itself, against the literals, wherever a native runs. On a difference it prints what it
// measured.
test('native answers this script as NATIVE records', { skip: SKIP }, async (t) => {
  const native = rgOracle(process.env);
  if (!native) { t.skip(rgOracleSkip(process.env)); return; }
  controls();
  const r = await driveTool({ script: SCRIPT, base: BASE, native, setup: layTree, inspect: readTree,
    quaudeSkip: 'quaude is judged by the test above' });
  const got = findings('native', r.native);
  if (got.length) {
    const measured = Object.fromEntries(SCRIPT.map((s) => [s.tool.id, r.native.results[s.tool.id]
      && { text: r.native.results[s.tool.id].text.split(BASE).join('<B>'), isError: r.native.results[s.tool.id].isError }]));
    t.diagnostic(`measured:\n${JSON.stringify(measured, null, 1)}`);
  }
  assert.deepStrictEqual(got, [], `native moved:\n${got.join('\n')}`);
});

// ==========================================================================
// THE TASK LIST AND TaskStop (every-tool Task 3)
// ==========================================================================
// One turn: create two tasks, list them, get one, mark it in progress, make the second blocked by it, get that, get a
// task that does not exist, complete the first, list again; then start a background Bash, stop it with TaskStop (its
// task_id is the id the Bash call answered with, read from the log as the turn runs: driveTool's inputFrom), stop it
// again, and stop an unknown id through TaskStop's alias KillShell (its deprecated shell_id). The Task* tools register
// unless CLAUDE_CODE_ENABLE_TASKS=false (the carve's todo opt-in; naming them in --allowedTools opts in as well).
//
// MEASURED on native 2.1.283 darwin-arm64 (2026-11-19) and a quaude built from this tree, the same on every call. Task
// ids count from 1 per session; a background task's id is random, and its output lands under CLAUDE_CODE_TMPDIR,
// which driveTool points into each side's sandbox, so those two calls are judged by shape: the id, and the path
// <tmp>/claude-<uid>/<cwd slug>/<session uuid>/tasks/<id>.output.
const T_CREATE_1 = { name: 'TaskCreate', input: { subject: 'Write the parser', description: 'Parse the input file', activeForm: 'Writing the parser' }, id: 'toolu_tk_create_1' };
const T_CREATE_2 = { name: 'TaskCreate', input: { subject: 'Test the parser', description: 'Cover every branch' }, id: 'toolu_tk_create_2' };
const T_LIST_1 = { name: 'TaskList', input: {}, id: 'toolu_tk_list_1' };
const T_GET_1 = { name: 'TaskGet', input: { taskId: '1' }, id: 'toolu_tk_get_1' };
const T_START_1 = { name: 'TaskUpdate', input: { taskId: '1', status: 'in_progress' }, id: 'toolu_tk_start_1' };
const T_BLOCK_2 = { name: 'TaskUpdate', input: { taskId: '2', addBlockedBy: ['1'] }, id: 'toolu_tk_block_2' };
const T_GET_2 = { name: 'TaskGet', input: { taskId: '2' }, id: 'toolu_tk_get_2' };
const T_GET_NONE = { name: 'TaskGet', input: { taskId: '99' }, id: 'toolu_tk_get_none' };
const T_DONE_1 = { name: 'TaskUpdate', input: { taskId: '1', status: 'completed' }, id: 'toolu_tk_done_1' };
const T_LIST_2 = { name: 'TaskList', input: {}, id: 'toolu_tk_list_2' };
const T_BG = { name: 'Bash', input: { command: 'sleep 30', description: 'wait', run_in_background: true }, id: 'toolu_tk_bg' };
const T_STOP = { name: 'TaskStop', input: { task_id: '<the background id>' }, id: 'toolu_tk_stop' };
const T_STOP_AGAIN = { name: 'TaskStop', input: { task_id: '<the background id>' }, id: 'toolu_tk_stop_again' };
const T_KILL_NONE = { name: 'KillShell', input: { shell_id: 'no-such-task' }, id: 'toolu_tk_kill_none' };
// The background id, read from the Bash call's tool_result (null when it sent none).
const bgIdOf = (m) => { const x = /^Command running in background with ID: (\w+)\./.exec(toolResultText(m, T_BG.id)); return x ? x[1] : null; };
const stopInput = (log) => ({ task_id: bgIdOf(log) || 'no-background-id' });
const TASK_SCRIPT = [{ tool: T_CREATE_1 }, { tool: T_CREATE_2 }, { tool: T_LIST_1 }, { tool: T_GET_1 }, { tool: T_START_1 },
  { tool: T_BLOCK_2 }, { tool: T_GET_2 }, { tool: T_GET_NONE }, { tool: T_DONE_1 }, { tool: T_LIST_2 }, { tool: T_BG },
  { tool: T_STOP, inputFrom: stopInput }, { tool: T_STOP_AGAIN, inputFrom: stopInput }, { tool: T_KILL_NONE }];

// MEASURED: native's answers; <ID> is the background id.
const TASK_NATIVE = {
  toolu_tk_create_1: { text: 'Task #1 created successfully: Write the parser', isError: false },
  toolu_tk_create_2: { text: 'Task #2 created successfully: Test the parser', isError: false },
  toolu_tk_list_1: { text: '#1 [pending] Write the parser\n#2 [pending] Test the parser', isError: false },
  toolu_tk_get_1: { text: 'Task #1: Write the parser\nStatus: pending\nDescription: Parse the input file', isError: false },
  toolu_tk_start_1: { text: 'Updated task #1 status', isError: false },
  toolu_tk_block_2: { text: 'Updated task #2 blockedBy', isError: false },
  toolu_tk_get_2: { text: 'Task #2: Test the parser\nStatus: pending\nDescription: Cover every branch\nBlocked by: #1', isError: false },
  toolu_tk_get_none: { text: 'Task not found', isError: false },
  toolu_tk_done_1: { text: 'Updated task #1 status', isError: false },
  toolu_tk_list_2: { text: '#1 [completed] Write the parser\n#2 [pending] Test the parser', isError: false },
  toolu_tk_stop: { text: '{"message":"Successfully stopped task: <ID> (sleep 30)","task_id":"<ID>","task_type":"local_bash","command":"sleep 30"}', isError: false },
  toolu_tk_stop_again: { text: '<tool_use_error>No task found with ID: <ID></tool_use_error>', isError: true },
  toolu_tk_kill_none: { text: '<tool_use_error>No task found with ID: no-such-task</tool_use_error>', isError: true },
};
// The side being judged: its CLAUDE_CODE_TMPDIR (set before any check runs).
let taskTmp = '/nonexistent-task-tmp';
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const taskWant = (USE, m) => { const w = TASK_NATIVE[USE.id]; const id = bgIdOf(m); return w && id && { text: w.text.split('<ID>').join(id), isError: w.isError }; };
const taskSame = (r, USE, m) => {
  const w = USE.id === T_KILL_NONE.id || !TASK_NATIVE[USE.id].text.includes('<ID>') ? TASK_NATIVE[USE.id] : taskWant(USE, m);
  return !!r && !!w && r.text === w.text && r.isError === w.isError;
};
const tCreate1 = (m) => taskSame(toolResult(m, T_CREATE_1.id), T_CREATE_1, m);
const tCreate2 = (m) => taskSame(toolResult(m, T_CREATE_2.id), T_CREATE_2, m);
const tList1 = (m) => taskSame(toolResult(m, T_LIST_1.id), T_LIST_1, m);
const tGet1 = (m) => taskSame(toolResult(m, T_GET_1.id), T_GET_1, m);
const tStart1 = (m) => taskSame(toolResult(m, T_START_1.id), T_START_1, m);
const tBlock2 = (m) => taskSame(toolResult(m, T_BLOCK_2.id), T_BLOCK_2, m);
const tGet2 = (m) => taskSame(toolResult(m, T_GET_2.id), T_GET_2, m);
const tGetNone = (m) => taskSame(toolResult(m, T_GET_NONE.id), T_GET_NONE, m);
const tDone1 = (m) => taskSame(toolResult(m, T_DONE_1.id), T_DONE_1, m);
const tList2 = (m) => taskSame(toolResult(m, T_LIST_2.id), T_LIST_2, m);
// The background call, by shape: native's sentence around this side's own sandboxed output path.
const tBg = (m) => {
  const r = toolResult(m, T_BG.id);
  const id = bgIdOf(m);
  if (!r || r.isError || !id) return false;
  const shape = new RegExp(`^Command running in background with ID: ${id}\\. Output is being written to: ${escRe(taskTmp)}/claude-\\d+/[^/]+/[0-9a-f-]{36}/tasks/${id}\\.output\\. You will be notified when it completes\\. To check interim output, use Read on that file path\\.$`);
  return shape.test(r.text);
};
const tStop = (m) => taskSame(toolResult(m, T_STOP.id), T_STOP, m);
const tStopAgain = (m) => taskSame(toolResult(m, T_STOP_AGAIN.id), T_STOP_AGAIN, m);
const tKillNone = (m) => taskSame(toolResult(m, T_KILL_NONE.id), T_KILL_NONE, m);
const taskVerdicts = (m) => [[T_CREATE_1, tCreate1(m)], [T_CREATE_2, tCreate2(m)], [T_LIST_1, tList1(m)], [T_GET_1, tGet1(m)],
  [T_START_1, tStart1(m)], [T_BLOCK_2, tBlock2(m)], [T_GET_2, tGet2(m)], [T_GET_NONE, tGetNone(m)], [T_DONE_1, tDone1(m)],
  [T_LIST_2, tList2(m)], [T_BG, tBg(m)], [T_STOP, tStop(m)], [T_STOP_AGAIN, tStopAgain(m)], [T_KILL_NONE, tKillNone(m)]];

function taskControls() {
  assertFailsOnMissingOutput(tCreate1, T_CREATE_1);
  assertFailsOnMissingOutput(tCreate2, T_CREATE_2);
  assertFailsOnMissingOutput(tList1, T_LIST_1);
  assertFailsOnMissingOutput(tGet1, T_GET_1);
  assertFailsOnMissingOutput(tStart1, T_START_1);
  assertFailsOnMissingOutput(tBlock2, T_BLOCK_2);
  assertFailsOnMissingOutput(tGet2, T_GET_2);
  assertFailsOnMissingOutput(tGetNone, T_GET_NONE);
  assertFailsOnMissingOutput(tDone1, T_DONE_1);
  assertFailsOnMissingOutput(tList2, T_LIST_2);
  assertFailsOnMissingOutput(tBg, T_BG);
  assertFailsOnMissingOutput(tStop, T_STOP);
  assertFailsOnMissingOutput(tStopAgain, T_STOP_AGAIN);
  assertFailsOnMissingOutput(tKillNone, T_KILL_NONE);
}

function taskFindings(label, side) {
  const out = [];
  if (side.status !== 0) out.push(`${label}: the turn exited ${side.status}${side.signal ? ` (${side.signal})` : ''}: ${side.stderr.slice(0, 800)}`);
  taskTmp = side.tmp;
  for (const [USE, same] of taskVerdicts(side.raw)) {
    if (!same) out.push(`${label}: ${USE.id} ${USE.name} sent ${JSON.stringify(side.sent[USE.id])}\n    got: ${JSON.stringify(toolResult(side.raw, USE.id))}`);
  }
  return out;
}

test('TaskCreate, TaskGet, TaskUpdate, TaskList and TaskStop in a built quaude: every tool_result equals native\'s', { skip: SKIP }, async (t) => {
  const q = builtQuaude();
  if (q.skip) { t.skip(q.skip); return; }
  taskControls();
  const r = await driveTool({ script: TASK_SCRIPT, quaude: q.path,
    nativeSkip: 'native is judged against the same recorded answers by the next test' });
  const got = taskFindings('quaude', r.quaude);
  assert.deepStrictEqual(got, [], `${got.length} finding(s) against native's answers:\n${got.join('\n')}`);
});

test('native answers the task script as TASK_NATIVE records', { skip: SKIP }, async (t) => {
  const native = rgOracle(process.env);
  if (!native) { t.skip(rgOracleSkip(process.env)); return; }
  taskControls();
  const r = await driveTool({ script: TASK_SCRIPT, native, quaudeSkip: 'quaude is judged by the test above' });
  const got = taskFindings('native', r.native);
  if (got.length) t.diagnostic(`measured:\n${JSON.stringify(r.native.results, null, 1)}`);
  assert.deepStrictEqual(got, [], `native moved:\n${got.join('\n')}`);
});
