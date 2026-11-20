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
const { toolResult, toolResultText, toolFollowUpText, assertFailsOnMissingOutput, answeredLog } = require('../../scripts/lib/tool-result.cjs');

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
// The tree's files (not a repository's .git, .claude or README, which the permission-mode turn below lays beside them).
const readTree = (work) => Object.fromEntries(fs.readdirSync(work, { withFileTypes: true })
  .filter((e) => e.isFile() && e.name !== 'README').map((e) => e.name).sort().map((f) => [f, fs.readFileSync(path.join(work, f), 'utf8')]));

const BASE = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tools-local-')));
process.on('exit', () => { try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* best effort */ } });
const W = (f) => path.join(BASE, 'work', f);

// THE CALLS, in the order the mock asks for them.
const READ = { name: 'Read', input: { file_path: W('a.txt') }, id: 'toolu_tl_read_a' };
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
  toolu_tl_read_a: { text: '1\tone\n2\ttwo\n3\tthree\n4\tfour\n5\tfive\n6\t', isError: false },
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
// <tmp>/claude-<uid>/<cwd slug>/<session uuid>/tasks/<id>.output. And the background process must really be gone
// after TaskStop (sleepSurvivors).
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
// The background command is this file-process's own (37.<pid> seconds), so the survivor check below can find it by
// name without touching another run's.
const T_BG = { name: 'Bash', input: { command: `sleep 37.${process.pid}`, description: 'wait', run_in_background: true }, id: 'toolu_tk_bg' };
const T_STOP = { name: 'TaskStop', input: { task_id: '<the background id>' }, id: 'toolu_tk_stop' };
const T_STOP_AGAIN = { name: 'TaskStop', input: { task_id: '<the background id>' }, id: 'toolu_tk_restop' };
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
  toolu_tk_stop: { text: `{"message":"Successfully stopped task: <ID> (${T_BG.input.command})","task_id":"<ID>","task_type":"local_bash","command":"${T_BG.input.command}"}`, isError: false },
  toolu_tk_restop: { text: '<tool_use_error>No task found with ID: <ID></tool_use_error>', isError: true },
  toolu_tk_kill_none: { text: '<tool_use_error>No task found with ID: no-such-task</tool_use_error>', isError: true },
};
// What the background call really answers (its shape, as measured), for the TaskStop controls' context: with it in
// the log, a TaskStop check can only fail because TaskStop's own output is missing.
const BG_ANSWER = 'Command running in background with ID: bctxsample. Output is being written to: '
  + '/t/claude-501/-t-work/00000000-0000-0000-0000-000000000000/tasks/bctxsample.output. You will be notified when it '
  + 'completes. To check interim output, use Read on that file path.';
const BG_CONTEXT = [{ use: T_BG, content: BG_ANSWER }];
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
// The background call, by shape: native's sentence around this side's own sandboxed output path (raw.tmp, which
// driveTool puts beside every log it returns; a synthetic control log has none, so there the path may be any, and the
// check fails there for the reason the control means: the call's answer is missing).
const tBg = (m) => {
  const r = toolResult(m, T_BG.id);
  const id = bgIdOf(m);
  if (!r || r.isError || !id) return false;
  const tmp = typeof m.tmp === 'string' ? escRe(m.tmp) : '/.+';
  const shape = new RegExp(`^Command running in background with ID: ${id}\\. Output is being written to: ${tmp}/claude-\\d+/[^/]+/[0-9a-f-]{36}/tasks/${id}\\.output\\. You will be notified when it completes\\. To check interim output, use Read on that file path\\.$`);
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
  // TaskStop's checks also read the background call's answer: their controls carry it (BG_CONTEXT), and each is shown
  // to pass when its own answer is there, so the control's failures are about TaskStop's output alone
  assertFailsOnMissingOutput(tStop, T_STOP, 'print', BG_CONTEXT);
  assertFailsOnMissingOutput(tStopAgain, T_STOP_AGAIN, 'print', BG_CONTEXT);
  assert.ok(tStop(answeredLog(T_STOP, TASK_NATIVE[T_STOP.id].text.split('<ID>').join('bctxsample'), BG_CONTEXT)),
    'the TaskStop check passes on its own answer with the context');
  assert.ok(tStopAgain(answeredLog(T_STOP_AGAIN, TASK_NATIVE[T_STOP_AGAIN.id].text.split('<ID>').join('bctxsample'), BG_CONTEXT, true)),
    'the second TaskStop check passes on its own answer with the context');
  assertFailsOnMissingOutput(tKillNone, T_KILL_NONE);
}

function taskFindings(label, side) {
  const out = [];
  if (side.status !== 0) out.push(`${label}: the turn exited ${side.status}${side.signal ? ` (${side.signal})` : ''}: ${side.stderr.slice(0, 800)}`);
  for (const [USE, same] of taskVerdicts(side.raw)) {
    if (!same) out.push(`${label}: ${USE.id} ${USE.name} sent ${JSON.stringify(side.sent[USE.id])}\n    got: ${JSON.stringify(toolResult(side.raw, USE.id))}`);
  }
  return out;
}

// TaskStop's answer says the task stopped; this checks the process did: no process runs T_BG's command (polled for a
// few seconds, as a kill lands asynchronously). Survivors are listed and then killed, so a failure here does not leak
// into the next test. -> a finding, or null.
// SCOPED BY NAME, NOT BY TREE (fix round 2 asked for test/proc-tree.cjs's walk; it cannot see this): the check runs
// after the CLI has exited, so a surviving sleep has lost its ancestry (its shell's parent is gone; the kernel
// reparented it to init or a subreaper), and descendants(process.pid) would never list it: a check that cannot fail.
// The name is this process's own instead (sleep 37.<pid>), so the box-wide table finds only this run's sleep.
async function sleepSurvivors(label) {
  const { execFileSync } = require('node:child_process');
  const live = () => execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n')
    .map((l) => /^\s*(\d+)\s+(.*)$/.exec(l)).filter((x) => x && x[2].trim() === T_BG.input.command).map((x) => Number(x[1]));
  let pids = live();
  for (let i = 0; pids.length && i < 30; i++) { await new Promise((r) => setTimeout(r, 100)); pids = live(); }
  if (!pids.length) return null;
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  return `${label}: TaskStop answered "stopped" but \`${T_BG.input.command}\` survived (pid ${pids.join(', ')})`;
}

test('TaskCreate, TaskGet, TaskUpdate, TaskList and TaskStop in a built quaude: every tool_result equals native\'s', { skip: SKIP }, async (t) => {
  const q = builtQuaude();
  if (q.skip) { t.skip(q.skip); return; }
  taskControls();
  const r = await driveTool({ script: TASK_SCRIPT, quaude: q.path,
    nativeSkip: 'native is judged against the same recorded answers by the next test' });
  const got = taskFindings('quaude', r.quaude);
  const survived = await sleepSurvivors('quaude');
  if (survived) got.push(survived);
  assert.deepStrictEqual(got, [], `${got.length} finding(s) against native's answers:\n${got.join('\n')}`);
});

test('native answers the task script as TASK_NATIVE records', { skip: SKIP }, async (t) => {
  const native = rgOracle(process.env);
  if (!native) { t.skip(rgOracleSkip(process.env)); return; }
  taskControls();
  const r = await driveTool({ script: TASK_SCRIPT, native, quaudeSkip: 'quaude is judged by the test above' });
  const got = taskFindings('native', r.native);
  const survived = await sleepSurvivors('native');
  if (survived) got.push(survived);
  if (got.length) t.diagnostic(`measured:\n${JSON.stringify(r.native.results, null, 1)}`);
  assert.deepStrictEqual(got, [], `native moved:\n${got.join('\n')}`);
});

// ==========================================================================
// SKILL, THE WORKTREE TOOLS, THE CRON TOOLS AND ScheduleWakeup (every-tool Task 4)
// ==========================================================================
// One turn over a git repository holding a project skill: Skill loads it (and refuses an unknown one); CronList,
// CronCreate, CronList, CronDelete of the id CronCreate answered, and CronDelete of an unknown id (the cron tools are
// on unless CLAUDE_CODE_DISABLE_CRON; every job is session-only, so nothing outlives the turn, and none fires: the one
// job is due on 1 January at 03:00 and is deleted at once); ScheduleWakeup schedules and then stops (its answer names
// the clock time of the wakeup, so it is judged by shape); ExitWorktree outside a worktree refuses, EnterWorktree
// makes one, and ExitWorktree removes it and its branch, which the tree left after the turn shows.
//
// MEASURED on native 2.1.283 darwin-arm64 (2026-11-20) and a quaude built from this tree. Driving it found two
// defects, both fixed: the shim's readdir/readlink ignored `encoding: 'buffer'`, so quaude's ExitWorktree "could not
// remove" the worktree native removed (test/node-shim-fs-walk.test.cjs has the differential row); and a mock-id
// hazard in driveTool (an id inside another read as answered), now refused there.
// The same base as the Read/Write turn's, so the permission-mode turn below can lay both fixtures in one working
// directory (driveTool lays a fresh <base>/work before each turn).
const S_BASE = BASE;
const S_WORK = path.join(S_BASE, 'work');
const S_WT = path.join(S_WORK, '.claude', 'worktrees', 'wt-drive');
const SKILL_BODY = 'Say hello to $ARGUMENTS.';
const layRepo = (work) => {
  const skill = path.join(work, '.claude', 'skills', 'greet');
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), `---\nname: greet\ndescription: Greet someone by name\n---\n${SKILL_BODY}\n`);
  fs.writeFileSync(path.join(work, 'README'), 'a repository for the worktree tools\n');
  const { execFileSync } = require('node:child_process');
  for (const args of [['init', '-q', '-b', 'main'], ['add', '-A'], ['commit', '-q', '-m', 'init']]) execFileSync('git', args, { cwd: work, stdio: 'ignore' });
};
// What the turn left: the worktrees git knows and the worktree-* branches (none of either once ExitWorktree removed it).
const readRepo = (work) => {
  const { execFileSync } = require('node:child_process');
  const git = (...a) => execFileSync('git', a, { cwd: work, encoding: 'utf8' });
  return { worktrees: git('worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length,
    branches: git('branch', '--list', 'worktree-*').trim(), wtDir: fs.existsSync(S_WT) };
};
const S_SKILL = { name: 'Skill', input: { skill: 'greet', args: 'Ada' }, id: 'toolu_ss_skill' };
const S_NOSKILL = { name: 'Skill', input: { skill: 'no-such-skill' }, id: 'toolu_ss_unknown' };
const C_LIST_0 = { name: 'CronList', input: {}, id: 'toolu_sc_list0' };
const C_CREATE = { name: 'CronCreate', input: { cron: '0 3 1 1 *', prompt: 'say the new year', recurring: false }, id: 'toolu_sc_create' };
const C_LIST_1 = { name: 'CronList', input: {}, id: 'toolu_sc_list1' };
const C_DELETE = { name: 'CronDelete', input: { id: '<the id CronCreate answered>' }, id: 'toolu_sc_delete' };
const C_NODELETE = { name: 'CronDelete', input: { id: 'deadbeef' }, id: 'toolu_sc_nodel' };
// noop: true is the input's flag for "nothing else to do this turn": the tool schedules and the turn may end (the
// answer says so); without it the schedule is the same, so the flag only names the sentence native answers with.
const W_SCHED = { name: 'ScheduleWakeup', input: { delaySeconds: 120, reason: 'wait for the build', prompt: '/loop check the build', noop: true }, id: 'toolu_sw_sched' };
const W_STOP = { name: 'ScheduleWakeup', input: { stop: true }, id: 'toolu_sw_halt' };
const WT_NOEXIT = { name: 'ExitWorktree', input: { action: 'keep' }, id: 'toolu_sx_outside' };
const WT_ENTER = { name: 'EnterWorktree', input: { name: 'wt-drive' }, id: 'toolu_se_enter' };
const WT_REMOVE = { name: 'ExitWorktree', input: { action: 'remove' }, id: 'toolu_sx_remove' };
// The job id, read from CronCreate's tool_result (null when it sent none).
const cronIdOf = (m) => { const x = /^Scheduled one-shot task ([0-9a-f]{8}) /.exec(toolResultText(m, C_CREATE.id)); return x ? x[1] : null; };
const SESSION_SCRIPT = [{ tool: S_SKILL }, { tool: S_NOSKILL }, { tool: C_LIST_0 }, { tool: C_CREATE }, { tool: C_LIST_1 },
  { tool: C_DELETE, inputFrom: (log) => ({ id: cronIdOf(log) || 'no-cron-id' }) }, { tool: C_NODELETE }, { tool: W_SCHED },
  { tool: W_STOP }, { tool: WT_NOEXIT }, { tool: WT_ENTER }, { tool: WT_REMOVE }];

// MEASURED: native's answers; <CRON> is the job id, <WORK> the turn's working directory, <WT> the worktree.
const SESSION_NATIVE = {
  toolu_ss_skill: { text: 'Launching skill: greet', isError: false },
  toolu_ss_unknown: { text: '<tool_use_error>Unknown skill: no-such-skill</tool_use_error>', isError: true },
  toolu_sc_list0: { text: 'No scheduled jobs.', isError: false },
  toolu_sc_create: { text: `Scheduled one-shot task <CRON> (0 3 1 1 *). Session-only (not written to disk, dies when Claude exits). It will fire once then auto-delete.`, isError: false },
  toolu_sc_list1: { text: `<CRON> ${String.fromCodePoint(0x2014)} 0 3 1 1 * (one-shot) [session-only]: say the new year`, isError: false },
  toolu_sc_delete: { text: 'Cancelled job <CRON>.', isError: false },
  toolu_sc_nodel: { text: "<tool_use_error>No scheduled job with id 'deadbeef'</tool_use_error>", isError: true },
  toolu_sw_halt: { text: `Loop stopped ${String.fromCodePoint(0x2014)} cancelled 1 pending wakeup(s); no further dynamic-loop wakeups scheduled. If you armed a Monitor for this loop, TaskStop it now; otherwise nothing more to do this turn.`, isError: false },
  toolu_sx_outside: { text: `<tool_use_error>No-op: there is no active EnterWorktree session to exit. This tool only operates on worktrees created by EnterWorktree in the current session ${String.fromCodePoint(0x2014)} it will not touch worktrees created manually or in a previous session. No filesystem changes were made.</tool_use_error>`, isError: true },
  toolu_se_enter: { text: 'Created worktree at <WT> on branch worktree-wt-drive. The session is now working in the worktree. Use ExitWorktree to leave mid-session, or exit the session to be prompted.', isError: false },
  toolu_sx_remove: { text: 'Exited and removed worktree at <WT>. Session is now back in <WORK>.', isError: false },
};
// The tree native left: the main worktree alone, no worktree branch, no worktree directory.
const REPO_NATIVE = { worktrees: 1, branches: '', wtDir: false };
// ScheduleWakeup by shape: native's sentence around the wakeup's clock time and its delay from now.
const W_SCHED_SHAPE = new RegExp(`^Next wakeup scheduled for \\d\\d:\\d\\d:\\d\\d \\(in \\d+s\\)\\. Nothing more to do this turn ${String.fromCodePoint(0x2014)} the harness re-invokes you when the wakeup fires or a task-notification arrives\\.$`);
const sessionWant = (USE, m) => {
  const w = SESSION_NATIVE[USE.id];
  if (!w) return null;
  const cron = cronIdOf(m);
  if (w.text.includes('<CRON>') && !cron) return null;
  return { text: w.text.split('<CRON>').join(cron).split('<WT>').join(S_WT).split('<WORK>').join(S_WORK), isError: w.isError };
};
const sessionSame = (r, USE, m) => {
  const w = sessionWant(USE, m);
  return !!r && !!w && r.text === w.text && r.isError === w.isError;
};
// Skill answers in two parts: the tool_result, and the skill's body ($ARGUMENTS filled in) as text in the same turn,
// after "Base directory for this skill: <dir>" (MEASURED, native 2.1.283). Both must reach the model.
const SKILL_SENT = `Base directory for this skill: ${path.join(S_WORK, '.claude', 'skills', 'greet')}\n\n${SKILL_BODY.replace('$ARGUMENTS', 'Ada')}\n`;
const sSkill = (m) => sessionSame(toolResult(m, S_SKILL.id), S_SKILL, m) && toolFollowUpText(m, S_SKILL.id) === SKILL_SENT;
const sNoSkill = (m) => sessionSame(toolResult(m, S_NOSKILL.id), S_NOSKILL, m);
const cList0 = (m) => sessionSame(toolResult(m, C_LIST_0.id), C_LIST_0, m);
const cCreate = (m) => sessionSame(toolResult(m, C_CREATE.id), C_CREATE, m);
const cList1 = (m) => sessionSame(toolResult(m, C_LIST_1.id), C_LIST_1, m);
const cDelete = (m) => sessionSame(toolResult(m, C_DELETE.id), C_DELETE, m);
const cNoDelete = (m) => sessionSame(toolResult(m, C_NODELETE.id), C_NODELETE, m);
const wSched = (m) => { const r = toolResult(m, W_SCHED.id); return !!r && !r.isError && W_SCHED_SHAPE.test(r.text); };
const wStop = (m) => sessionSame(toolResult(m, W_STOP.id), W_STOP, m);
const wtNoExit = (m) => sessionSame(toolResult(m, WT_NOEXIT.id), WT_NOEXIT, m);
const wtEnter = (m) => sessionSame(toolResult(m, WT_ENTER.id), WT_ENTER, m);
const wtRemove = (m) => sessionSame(toolResult(m, WT_REMOVE.id), WT_REMOVE, m);
const sessionVerdicts = (m) => [[S_SKILL, sSkill(m)], [S_NOSKILL, sNoSkill(m)], [C_LIST_0, cList0(m)], [C_CREATE, cCreate(m)],
  [C_LIST_1, cList1(m)], [C_DELETE, cDelete(m)], [C_NODELETE, cNoDelete(m)], [W_SCHED, wSched(m)], [W_STOP, wStop(m)],
  [WT_NOEXIT, wtNoExit(m)], [WT_ENTER, wtEnter(m)], [WT_REMOVE, wtRemove(m)]];
// What CronCreate answers, for the controls of the calls whose check reads its id.
const CRON_CONTEXT = [{ use: C_CREATE, content: SESSION_NATIVE[C_CREATE.id].text.split('<CRON>').join('0abc1234') }];

function sessionControls() {
  assertFailsOnMissingOutput(sSkill, S_SKILL);
  assert.ok(!sSkill(answeredLog(S_SKILL, SESSION_NATIVE[S_SKILL.id].text)),
    'the Skill check fails on the right tool_result when the skill\'s body did not reach the model');
  assertFailsOnMissingOutput(sNoSkill, S_NOSKILL);
  assertFailsOnMissingOutput(cList0, C_LIST_0);
  assertFailsOnMissingOutput(cCreate, C_CREATE);
  assertFailsOnMissingOutput(cNoDelete, C_NODELETE);
  assertFailsOnMissingOutput(wSched, W_SCHED);
  assertFailsOnMissingOutput(wStop, W_STOP);
  assertFailsOnMissingOutput(wtNoExit, WT_NOEXIT);
  assertFailsOnMissingOutput(wtEnter, WT_ENTER);
  assertFailsOnMissingOutput(wtRemove, WT_REMOVE);
  // CronList's second answer and CronDelete's read the id CronCreate answered: their controls carry that answer, and
  // each check is shown to pass on its own answer with it, so a control's failure is about that call's output alone
  assertFailsOnMissingOutput(cList1, C_LIST_1, 'print', CRON_CONTEXT);
  assertFailsOnMissingOutput(cDelete, C_DELETE, 'print', CRON_CONTEXT);
  assert.ok(cList1(answeredLog(C_LIST_1, SESSION_NATIVE[C_LIST_1.id].text.split('<CRON>').join('0abc1234'), CRON_CONTEXT)),
    'the second CronList check passes on its own answer with CronCreate\'s');
  assert.ok(cDelete(answeredLog(C_DELETE, SESSION_NATIVE[C_DELETE.id].text.split('<CRON>').join('0abc1234'), CRON_CONTEXT)),
    'the CronDelete check passes on its own answer with CronCreate\'s');
}

function sessionFindings(label, side) {
  const out = [];
  if (side.status !== 0) out.push(`${label}: the turn exited ${side.status}${side.signal ? ` (${side.signal})` : ''}: ${side.stderr.slice(0, 800)}`);
  for (const [USE, same] of sessionVerdicts(side.raw)) {
    if (!same) out.push(`${label}: ${USE.id} ${USE.name} sent ${JSON.stringify(side.sent[USE.id])}\n    got: ${JSON.stringify(toolResult(side.raw, USE.id))}`);
  }
  try { assert.deepStrictEqual(side.inspected, REPO_NATIVE); } catch { out.push(`${label}: the repository left ${JSON.stringify(side.inspected)}, native's ${JSON.stringify(REPO_NATIVE)}`); }
  return out;
}

test('Skill, the worktree tools, the cron tools and ScheduleWakeup in a built quaude: every tool_result, and the repository left, equal native\'s', { skip: SKIP }, async (t) => {
  const q = builtQuaude();
  if (q.skip) { t.skip(q.skip); return; }
  sessionControls();
  const r = await driveTool({ script: SESSION_SCRIPT, base: S_BASE, quaude: q.path, setup: layRepo, inspect: readRepo,
    nativeSkip: 'native is judged against the same recorded answers by the next test' });
  const got = sessionFindings('quaude', r.quaude);
  assert.deepStrictEqual(got, [], `${got.length} finding(s) against native's answers:\n${got.join('\n')}`);
});

test('native answers the session script as SESSION_NATIVE records', { skip: SKIP }, async (t) => {
  const native = rgOracle(process.env);
  if (!native) { t.skip(rgOracleSkip(process.env)); return; }
  sessionControls();
  const r = await driveTool({ script: SESSION_SCRIPT, base: S_BASE, native, setup: layRepo, inspect: readRepo,
    quaudeSkip: 'quaude is judged by the test above' });
  const got = sessionFindings('native', r.native);
  if (got.length) t.diagnostic(`measured:\n${JSON.stringify(r.native.results, null, 1)}`);
  assert.deepStrictEqual(got, [], `native moved:\n${got.join('\n')}`);
});

// ==========================================================================
// ReportFindings, Workflow AND ListAgents (every-tool Task 5)
// ==========================================================================
// One turn: ReportFindings with no findings, with one, and without `findings` (a validation error); Workflow with no
// script, name, scriptPath or runId (a validation error), a saved name that does not exist, and the smallest honest
// inline script (a meta literal and `return { answer: 42 }`: it calls no agent(), so nothing reaches the mock or any
// API; Workflow returns at once with the run's task id, and the run is in the background); ListAgents, with no other
// session on the box's sandboxed home.
//
// MEASURED on native 2.1.283 darwin-arm64 and a quaude built from this tree (2026-11-20). Every answer is native's,
// with ONE NAMED DIVERGENCE: ListAgents. Native starts its UDS peer-messaging server at startup (the debug log:
// "[uds-messaging] Listening: /tmp/cc-socks-<uid>/<pid>.sock") and so names this session ("This session is
// work-NN [ref] ...") above "No reachable agents ...". Under quaude net.createServer is the named throwing stub
// (libexec/node-shim/modules/net.cjs; BACKLOG.md, "`net.createServer` is a named throwing stub"), the debug log says
// "[uds-messaging] Failed to create server: Error: quaude does not support the sandbox yet: net.createServer", so the
// session has no address and ListAgents answers "No reachable agents." alone. The quaude test holds THAT answer, so a
// shim that grows a server turns it red and this pin is updated to native's on purpose, never left behind.
const R_NONE = { name: 'ReportFindings', input: { findings: [] }, id: 'toolu_r5_none' };
const R_ONE = { name: 'ReportFindings', input: { level: 'low', findings: [{ file: 'a.js', line: 3, summary: 'Off by one in the loop bound.',
  failure_scenario: 'n=0 reads index -1', category: 'correctness', verdict: 'CONFIRMED' }] }, id: 'toolu_r5_one' };
const R_BAD = { name: 'ReportFindings', input: {}, id: 'toolu_r5_bad' };
const F_NONE = { name: 'Workflow', input: {}, id: 'toolu_w5_noinput' };
const F_NAME = { name: 'Workflow', input: { name: 'no-such-workflow' }, id: 'toolu_w5_unknown' };
const WF_SCRIPT = "export const meta = { name: 'noop', description: 'returns a constant, spawns nothing' }\nreturn { answer: 42 }";
const F_RUN = { name: 'Workflow', input: { script: WF_SCRIPT }, id: 'toolu_w5_run' };
const A_LIST = { name: 'ListAgents', input: {}, id: 'toolu_a5_list' };
const T5_SCRIPT = [{ tool: R_NONE }, { tool: R_ONE }, { tool: R_BAD }, { tool: F_NONE }, { tool: F_NAME }, { tool: F_RUN },
  { tool: A_LIST }];
const EM = String.fromCodePoint(0x2014);
const T5_NATIVE = {
  toolu_r5_none: { text: 'No findings reported.', isError: false },
  toolu_r5_one: { text: '1 finding reported.', isError: false },
  toolu_r5_bad: { text: '<tool_use_error>InputValidationError: ReportFindings failed due to the following issue:\nThe parameter `findings` type is expected as `array` but provided as `unknown`</tool_use_error>', isError: true },
  toolu_w5_noinput: { text: '<tool_use_error>InputValidationError: [\n  {\n    "code": "custom",\n    "path": [],\n    "message": "Must provide script, name, scriptPath, or runId"\n  }\n]</tool_use_error>', isError: true },
  toolu_w5_unknown: { text: '<tool_use_error>Workflow "no-such-workflow" not found. Available: deep-research</tool_use_error>', isError: true },
};
// Workflow's launch answer, by shape: native's text around the run's task id, run id and the session's project dir
// (each the same everywhere it recurs: the backreferences).
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const F_RUN_SHAPE = new RegExp('^' + [
  'Workflow launched in background\\. Task ID: (\\w+)',
  'Summary: returns a constant, spawns nothing',
  'Transcript dir: (/[^\\s"]+/\\.claude/projects/[^/\\s"]+/[0-9a-f-]{36})/subagents/workflows/(wf_[0-9a-f]{8}-[0-9a-f]{3})',
  'Script file: \\2/workflows/scripts/noop-\\3\\.js',
  esc('(Edit this file with Write/Edit and re-invoke Workflow with {scriptPath: "') + '\\2/workflows/scripts/noop-\\3\\.js' + esc('"} to iterate without resending the script.)'),
  'Run ID: \\3',
  esc('To resume after editing the script: Workflow({scriptPath: "') + '\\2/workflows/scripts/noop-\\3\\.js' + esc('", resumeFromRunId: "')
    + '\\3' + esc(`"}) ${EM} completed agents return cached results (cached results may themselves be empty ${EM} inspect journal.jsonl before assuming there is something to recover).`),
  '',
  'You will be notified when it completes\\. Use /workflows to watch live progress\\.',
].join('\\n') + '$');
// ListAgents: native names the session (work-<id> [<6 hex>]); quaude, with no messaging server, does not (above).
const A_NATIVE_SHAPE = new RegExp(`^This session is work-[0-9a-z]+ \\[[0-9a-f]{6}\\] ${EM} the name other sessions use to message it \\(it is not listed below; a message to it would be a message to yourself\\)\\.\\n\\nNo reachable agents ${EM} no other Claude session is running on this machine right now \\(peer messaging itself is available; a session appears here once it is started\\)\\.$`);
const A_QUAUDE = { text: 'No reachable agents.', isError: false };
const t5Same = (r, w) => !!r && !!w && r.text === w.text && r.isError === w.isError;
const rNone = (m) => t5Same(toolResult(m, R_NONE.id), T5_NATIVE[R_NONE.id]);
const rOne = (m) => t5Same(toolResult(m, R_ONE.id), T5_NATIVE[R_ONE.id]);
const rBad = (m) => t5Same(toolResult(m, R_BAD.id), T5_NATIVE[R_BAD.id]);
const fNone = (m) => t5Same(toolResult(m, F_NONE.id), T5_NATIVE[F_NONE.id]);
const fName = (m) => t5Same(toolResult(m, F_NAME.id), T5_NATIVE[F_NAME.id]);
const fRun = (m) => { const r = toolResult(m, F_RUN.id); return !!r && !r.isError && F_RUN_SHAPE.test(r.text); };
const aListNative = (m) => { const r = toolResult(m, A_LIST.id); return !!r && !r.isError && A_NATIVE_SHAPE.test(r.text); };
const aListQuaude = (m) => t5Same(toolResult(m, A_LIST.id), A_QUAUDE);
const t5Verdicts = (m, side) => [[R_NONE, rNone(m)], [R_ONE, rOne(m)], [R_BAD, rBad(m)], [F_NONE, fNone(m)], [F_NAME, fName(m)],
  [F_RUN, fRun(m)], [A_LIST, side === 'native' ? aListNative(m) : aListQuaude(m)]];

function t5Controls() {
  assertFailsOnMissingOutput(rNone, R_NONE);
  assertFailsOnMissingOutput(rOne, R_ONE);
  assertFailsOnMissingOutput(rBad, R_BAD);
  assertFailsOnMissingOutput(fNone, F_NONE);
  assertFailsOnMissingOutput(fName, F_NAME);
  assertFailsOnMissingOutput(fRun, F_RUN);
  assertFailsOnMissingOutput(aListNative, A_LIST);
  assertFailsOnMissingOutput(aListQuaude, A_LIST);
  // the two ListAgents judgments are not each other: native's answer is not quaude's pin, nor the reverse
  const nativeAnswer = `This session is work-01 [744172] ${EM} the name other sessions use to message it (it is not listed below; a message to it would be a message to yourself).\n\nNo reachable agents ${EM} no other Claude session is running on this machine right now (peer messaging itself is available; a session appears here once it is started).`;
  assert.ok(aListNative(answeredLog(A_LIST, nativeAnswer)) && !aListQuaude(answeredLog(A_LIST, nativeAnswer)));
  assert.ok(aListQuaude(answeredLog(A_LIST, A_QUAUDE.text)) && !aListNative(answeredLog(A_LIST, A_QUAUDE.text)));
  // the run's CONTROL: launched but never completed, completed with another result, or no record, each fails
  assert.ok(workflowRan(WORKFLOW_LEFT));
  for (const records of [[{ ...WORKFLOW_LEFT.records[0], status: 'running', result: undefined }], [{ ...WORKFLOW_LEFT.records[0], result: { answer: 41 } }], []]) {
    assert.ok(!workflowRan({ ...WORKFLOW_LEFT, records }), `a run record ${JSON.stringify(records)} is not a run that returned 42`);
  }
}

// What the run left: the run's script file, byte for byte the script sent; its journal's first entry; and its run
// record's verdict, which shows the script RAN in the workflow runtime (node:vm under quaude, the path where host node
// once segfaulted) and returned { answer: 42 }: status "completed", the result, no agents. Native writes the record
// within the turn (durationMs 6 measured), so a runtime that never ran the script, or returned something else, differs.
const readWorkflow = (work, base) => {
  const found = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else found.push(p); } };
  walk(base);
  const script = found.filter((p) => /[\\/]workflows[\\/]scripts[\\/]noop-wf_[0-9a-f-]+\.js$/.test(p));
  const journal = found.filter((p) => /[\\/]subagents[\\/]workflows[\\/]wf_[0-9a-f-]+[\\/]journal\.jsonl$/.test(p));
  const records = found.filter((p) => /[\\/]workflows[\\/]wf_[0-9a-f-]+\.json$/.test(p)).map((p) => {
    try { const j = JSON.parse(fs.readFileSync(p, 'utf8')); return { status: j.status, result: j.result, agentCount: j.agentCount, workflowName: j.workflowName }; } catch { return 'unreadable'; }
  });
  const left = { scripts: script.map((p) => fs.readFileSync(p, 'utf8')), journal: journal.map((p) => fs.readFileSync(p, 'utf8').split('\n')[0]), records };
  // What was read is removed: the next turn on the same base (the permission-mode turns share one) reads its own run.
  for (const p of [...script, ...journal, ...found.filter((q) => /[\\/]workflows[\\/]wf_[0-9a-f-]+\.json$/.test(q))]) fs.rmSync(p, { force: true });
  return left;
};
const WORKFLOW_LEFT = { scripts: [WF_SCRIPT], journal: ['{"type":"launched"}'],
  records: [{ status: 'completed', result: { answer: 42 }, agentCount: 0, workflowName: 'noop' }] };
// The run's judgment, and its control: a launch whose script never completed (or returned anything but 42) is a finding.
const workflowRan = (inspected) => { try { assert.deepStrictEqual(inspected, WORKFLOW_LEFT); return true; } catch { return false; } };

function t5Findings(label, side) {
  const out = [];
  if (side.status !== 0) out.push(`${label}: the turn exited ${side.status}${side.signal ? ` (${side.signal})` : ''}: ${side.stderr.slice(0, 800)}`);
  for (const [USE, same] of t5Verdicts(side.raw, label)) {
    if (!same) out.push(`${label}: ${USE.id} ${USE.name} sent ${JSON.stringify(side.sent[USE.id])}\n    got: ${JSON.stringify(toolResult(side.raw, USE.id))}`);
  }
  if (!workflowRan(side.inspected)) out.push(`${label}: the workflow left ${JSON.stringify(side.inspected)}, native's ${JSON.stringify(WORKFLOW_LEFT)}`);
  return out;
}

test('ReportFindings, Workflow and ListAgents in a built quaude: every tool_result equals native\'s (ListAgents: the named divergence)', { skip: SKIP }, async (t) => {
  const q = builtQuaude();
  if (q.skip) { t.skip(q.skip); return; }
  t5Controls();
  const r = await driveTool({ script: T5_SCRIPT, quaude: q.path, inspect: readWorkflow,
    nativeSkip: 'native is judged against the same recorded answers by the next test' });
  const got = t5Findings('quaude', r.quaude);
  assert.deepStrictEqual(got, [], `${got.length} finding(s) against native's answers:\n${got.join('\n')}`);
});

test('native answers the Task 5 script as T5_NATIVE records', { skip: SKIP }, async (t) => {
  const native = rgOracle(process.env);
  if (!native) { t.skip(rgOracleSkip(process.env)); return; }
  t5Controls();
  const r = await driveTool({ script: T5_SCRIPT, native, inspect: readWorkflow, quaudeSkip: 'quaude is judged by the test above' });
  const got = t5Findings('native', r.native);
  if (got.length) t.diagnostic(`measured:\n${JSON.stringify(r.native.results, null, 1)}`);
  assert.deepStrictEqual(got, [], `native moved:\n${got.join('\n')}`);
});

// ==========================================================================
// THE PERMISSION MODES AND `unlisted` (every-tool Task 5 fix round 1, ruling E9)
// ==========================================================================
// The cells beside print: the same calls in -p turns that change ONE thing, --permission-mode <m>, or the tools not
// named in --allowedTools (`unlisted`). One turn per mode carries every call above plus an Edit and a foreground Bash
// (measured: a quaude turn costs ~25 s, almost all of it start-up, so four turns per mode would cost four times as
// much for the same calls). Its working directory holds both fixtures: the Read/Write tree, and the git repository
// with the greet skill (layRepo commits the tree with it).
//
// MEASURED on native 2.1.283 darwin-arm64 (2026-11-20): in acceptEdits, auto, bypassPermissions and dontAsk every
// answer is print's (every scripted tool is in --allowedTools). In plan, the writes are refused ("Cannot write to
// <path> while in plan mode."), so the tree stays as laid. Unlisted, the writes ask for a grant -p cannot give
// ("Claude requested permissions to write to <path>, but you haven't granted it yet."), the Task* list tools are off
// ("No such tool available: X. X is disabled for this session, in subagents as well as here."; the Edit is refused
// the same way as the writes, and the foreground Bash runs), and an inline
// Workflow script waits for review ("Review dynamic workflow before running"), so no run is made.
const E_EDIT = { name: 'Edit', input: { file_path: W('a.txt'), old_string: 'two', new_string: 'TWO' }, id: 'toolu_m6_edit' };
const B_ECHO = { name: 'Bash', input: { command: 'echo mode-turn-$((6*7))', description: 'Print a marker' }, id: 'toolu_m6_bash' };
const MODE_SCRIPT = [...SCRIPT, { tool: E_EDIT }, { tool: B_ECHO }, ...TASK_SCRIPT, ...T5_SCRIPT, ...SESSION_SCRIPT];
const MODE_ARGS = {
  'permission:acceptEdits': { args: ['--permission-mode', 'acceptEdits'] },
  'permission:auto': { args: ['--permission-mode', 'auto'] },
  'permission:bypassPermissions': { args: ['--permission-mode', 'bypassPermissions'] },
  'permission:dontAsk': { args: ['--permission-mode', 'dontAsk'] },
  'permission:plan': { args: ['--permission-mode', 'plan'] },
  unlisted: { allowedTools: null },
};
const layBoth = (work) => { layTree(work); layRepo(work); };
const readBoth = (work, base) => ({ tree: readTree(work), gitState: readRepo(work), workflow: readWorkflow(work, base) });
// The two calls only this turn makes, as print answers them (Edit's success, unlike Write's, has no file-state note).
const EDIT_DONE = { text: `The file ${W('a.txt')} has been updated successfully.`, isError: false };
const ECHO_DONE = { text: 'mode-turn-42', isError: false };
const mEdit = (m) => t5Same(toolResult(m, E_EDIT.id), EDIT_DONE);
const mEcho = (m) => t5Same(toolResult(m, B_ECHO.id), ECHO_DONE);
// What each mode changes, call by call (MEASURED above); every call not named answers as in print.
const PLAN_REFUSED = (f) => ({ text: `Cannot write to ${W(f)} while in plan mode.`, isError: true });
const UNGRANTED = (f) => ({ text: `Claude requested permissions to write to ${W(f)}, but you haven't granted it yet.`, isError: true });
const TASK_OFF = (name) => ({ text: `<tool_use_error>Error: No such tool available: ${name}. ${name} is disabled for this session, in subagents as well as here.</tool_use_error>`, isError: true });
const B_OLD = { text: '1\told\n2\t', isError: false };
const modeWant = {
  'permission:plan': { [WRITE_NEW.id]: PLAN_REFUSED('new.txt'), [WRITE_UNREAD.id]: PLAN_REFUSED('b.txt'), [READ_B.id]: B_OLD,
    [WRITE_OVER.id]: PLAN_REFUSED('b.txt'), [NB_REPLACE.id]: PLAN_REFUSED('n.ipynb'), [E_EDIT.id]: PLAN_REFUSED('a.txt') },
  unlisted: { [WRITE_NEW.id]: UNGRANTED('new.txt'), [WRITE_UNREAD.id]: UNGRANTED('b.txt'), [READ_B.id]: B_OLD,
    [WRITE_OVER.id]: UNGRANTED('b.txt'), [NB_REPLACE.id]: UNGRANTED('n.ipynb'), [E_EDIT.id]: UNGRANTED('a.txt'),
    ...Object.fromEntries([T_CREATE_1, T_CREATE_2, T_LIST_1, T_GET_1, T_START_1, T_BLOCK_2, T_GET_2, T_GET_NONE, T_DONE_1, T_LIST_2]
      .map((U) => [U.id, TASK_OFF(U.name)])),
    [F_RUN.id]: { text: 'Review dynamic workflow before running', isError: true } },
};
// The calls' verdicts in `mode`: a call the mode changes is judged on the mode's answer (modeSame), any other by its
// print check.
const modeSame = (m, USE, mode) => t5Same(toolResult(m, USE.id), modeWant[mode][USE.id]);
const modeVerdicts = (m, mode, side) => [...verdicts(m), [E_EDIT, mEdit(m)], [B_ECHO, mEcho(m)], ...taskVerdicts(m),
  ...t5Verdicts(m, side), ...sessionVerdicts(m)]
  .map(([USE, same]) => [USE, modeWant[mode] && modeWant[mode][USE.id] ? modeSame(m, USE, mode) : same]);
// What the turn leaves, by mode: print's, or (plan, unlisted) the tree as laid and, unlisted, no workflow run.
const LAID = { 'a.txt': TREE['a.txt'], 'b.txt': TREE['b.txt'], 'n.ipynb': TREE['n.ipynb'] };
const modeLeft = (mode) => {
  const edited = { ...DISK, 'a.txt': TREE['a.txt'].replace('two', 'TWO') };
  const tree = mode === 'permission:plan' || mode === 'unlisted' ? LAID : edited;
  return { tree, gitState: REPO_NATIVE, workflow: mode === 'unlisted' ? { scripts: [], journal: [], records: [] } : WORKFLOW_LEFT };
};

// The controls, with the cells they drive declared: every tool of the turn, in every mode it runs in.
function modeControls() {
  // each declares its cells as a literal list, the gate's rule (test/build-gates/tool-coverage-gates.test.cjs)
  assertFailsOnMissingOutput(readWhole, READ, ['permission:acceptEdits', 'permission:auto', 'permission:bypassPermissions', 'permission:dontAsk', 'permission:plan', 'unlisted']);
  assertFailsOnMissingOutput(writeNew, WRITE_NEW, ['permission:acceptEdits', 'permission:auto', 'permission:bypassPermissions', 'permission:dontAsk', 'permission:plan', 'unlisted']);
  assertFailsOnMissingOutput(nbReplace, NB_REPLACE, ['permission:acceptEdits', 'permission:auto', 'permission:bypassPermissions', 'permission:dontAsk', 'permission:plan', 'unlisted']);
  assertFailsOnMissingOutput(mEdit, E_EDIT, ['permission:acceptEdits', 'permission:auto', 'permission:bypassPermissions', 'permission:dontAsk', 'permission:plan', 'unlisted']);
  assertFailsOnMissingOutput(mEcho, B_ECHO, ['permission:acceptEdits', 'permission:auto', 'permission:bypassPermissions', 'permission:dontAsk', 'permission:plan', 'unlisted']);
  assertFailsOnMissingOutput(tCreate1, T_CREATE_1, ['permission:acceptEdits', 'permission:auto', 'permission:bypassPermissions', 'permission:dontAsk', 'permission:plan', 'unlisted']);
  assertFailsOnMissingOutput(tGetNone, T_GET_NONE, ['permission:acceptEdits', 'permission:auto', 'permission:bypassPermissions', 'permission:dontAsk', 'permission:plan', 'unlisted']);
  assertFailsOnMissingOutput(tList1, T_LIST_1, ['permission:acceptEdits', 'permission:auto', 'permission:bypassPermissions', 'permission:dontAsk', 'permission:plan', 'unlisted']);
  assertFailsOnMissingOutput(tStart1, T_START_1, ['permission:acceptEdits', 'permission:auto', 'permission:bypassPermissions', 'permission:dontAsk', 'permission:plan', 'unlisted']);
  assertFailsOnMissingOutput(tKillNone, T_KILL_NONE, ['permission:acceptEdits', 'permission:auto', 'permission:bypassPermissions', 'permission:dontAsk', 'permission:plan', 'unlisted']);
  assertFailsOnMissingOutput(sSkill, S_SKILL, ['permission:acceptEdits', 'permission:auto', 'permission:bypassPermissions', 'permission:dontAsk', 'permission:plan', 'unlisted']);
  assertFailsOnMissingOutput(wtEnter, WT_ENTER, ['permission:acceptEdits', 'permission:auto', 'permission:bypassPermissions', 'permission:dontAsk', 'permission:plan', 'unlisted']);
  assertFailsOnMissingOutput(wtRemove, WT_REMOVE, ['permission:acceptEdits', 'permission:auto', 'permission:bypassPermissions', 'permission:dontAsk', 'permission:plan', 'unlisted']);
  assertFailsOnMissingOutput(cCreate, C_CREATE, ['permission:acceptEdits', 'permission:auto', 'permission:bypassPermissions', 'permission:dontAsk', 'permission:plan', 'unlisted']);
  assertFailsOnMissingOutput(cList0, C_LIST_0, ['permission:acceptEdits', 'permission:auto', 'permission:bypassPermissions', 'permission:dontAsk', 'permission:plan', 'unlisted']);
  assertFailsOnMissingOutput(cNoDelete, C_NODELETE, ['permission:acceptEdits', 'permission:auto', 'permission:bypassPermissions', 'permission:dontAsk', 'permission:plan', 'unlisted']);
  assertFailsOnMissingOutput(cList1, C_LIST_1, ['permission:acceptEdits', 'permission:auto', 'permission:bypassPermissions', 'permission:dontAsk', 'permission:plan', 'unlisted'], CRON_CONTEXT);
  assertFailsOnMissingOutput(wSched, W_SCHED, ['permission:acceptEdits', 'permission:auto', 'permission:bypassPermissions', 'permission:dontAsk', 'permission:plan', 'unlisted']);
  assertFailsOnMissingOutput(rOne, R_ONE, ['permission:acceptEdits', 'permission:auto', 'permission:bypassPermissions', 'permission:dontAsk', 'permission:plan', 'unlisted']);
  assertFailsOnMissingOutput(fName, F_NAME, ['permission:acceptEdits', 'permission:auto', 'permission:bypassPermissions', 'permission:dontAsk', 'permission:plan', 'unlisted']);
  assertFailsOnMissingOutput(aListNative, A_LIST, ['permission:acceptEdits', 'permission:auto', 'permission:bypassPermissions', 'permission:dontAsk', 'permission:plan', 'unlisted']);
  assertFailsOnMissingOutput(aListQuaude, A_LIST, ['permission:acceptEdits', 'permission:auto', 'permission:bypassPermissions', 'permission:dontAsk', 'permission:plan', 'unlisted']);
  assertFailsOnMissingOutput(tBg, T_BG, ['permission:acceptEdits', 'permission:auto', 'permission:bypassPermissions', 'permission:dontAsk', 'permission:plan', 'unlisted']);
  assertFailsOnMissingOutput(tStop, T_STOP, ['permission:acceptEdits', 'permission:auto', 'permission:bypassPermissions', 'permission:dontAsk', 'permission:plan', 'unlisted'], BG_CONTEXT);
  assertFailsOnMissingOutput(tGet1, T_GET_1, ['permission:acceptEdits', 'permission:auto', 'permission:bypassPermissions', 'permission:dontAsk', 'permission:plan', 'unlisted']);
  // a mode's changed answers have controls of their own: each fails on print's answer, and passes on its own
  for (const mode of ['permission:plan', 'unlisted']) {
    for (const USE of [WRITE_NEW, NB_REPLACE]) {
      assert.ok(!modeSame(answeredLog(USE, want(USE).text), USE, mode), `${mode} ${USE.id}: print's answer is not this mode's`);
      assert.ok(modeSame(answeredLog(USE, modeWant[mode][USE.id].text, [], true), USE, mode), `${mode} ${USE.id}: its own answer passes`);
    }
  }
}

function modeFindings(label, side, mode) {
  const out = [];
  if (side.status !== 0) out.push(`${label} ${mode}: the turn exited ${side.status}${side.signal ? ` (${side.signal})` : ''}: ${side.stderr.slice(0, 800)}`);
  for (const [USE, same] of modeVerdicts(side.raw, mode, label)) {
    if (!same) out.push(`${label} ${mode}: ${USE.id} ${USE.name} sent ${JSON.stringify(side.sent[USE.id])}\n    got: ${JSON.stringify(toolResult(side.raw, USE.id))}`);
  }
  const left = modeLeft(mode);
  try { assert.deepStrictEqual(side.inspected, left); } catch { out.push(`${label} ${mode}: it left ${JSON.stringify(side.inspected)}\n    native's ${JSON.stringify(left)}`); }
  return out;
}

for (const mode of Object.keys(MODE_ARGS)) {
  test(`every Phase A call in a built quaude in ${mode}: each tool_result, and what the turn left, equal native's`, { skip: SKIP }, async (t) => {
    const q = builtQuaude();
    if (q.skip) { t.skip(q.skip); return; }
    modeControls();
    const r = await driveTool({ script: MODE_SCRIPT, base: BASE, quaude: q.path, setup: layBoth, inspect: readBoth, ...MODE_ARGS[mode],
      nativeSkip: 'native is judged against the same recorded answers by its own test' });
    const got = modeFindings('quaude', r.quaude, mode);
    const survived = await sleepSurvivors('quaude');
    if (survived) got.push(survived);
    assert.deepStrictEqual(got, [], `${got.length} finding(s) against native's answers:\n${got.join('\n')}`);
  });
  test(`native answers every Phase A call in ${mode} as recorded`, { skip: SKIP }, async (t) => {
    const native = rgOracle(process.env);
    if (!native) { t.skip(rgOracleSkip(process.env)); return; }
    modeControls();
    const r = await driveTool({ script: MODE_SCRIPT, base: BASE, native, setup: layBoth, inspect: readBoth, ...MODE_ARGS[mode],
      quaudeSkip: 'quaude is judged by its own test' });
    const got = modeFindings('native', r.native, mode);
    const survived = await sleepSurvivors('native');
    if (survived) got.push(survived);
    assert.deepStrictEqual(got, [], `native moved:\n${got.join('\n')}`);
  });
}
