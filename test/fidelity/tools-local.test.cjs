'use strict';
// THE LOCAL FILE TOOLS END TO END: Read, Write and NotebookEdit in a built quaude, judged against native (every-tool
// plan, Phase A, Task 2).
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
// differs, is named, not hidden. Where none runs, that test skips by name; linux-x64-pty runs both (test/ci-gates.cjs
// FILES accepts no skip there).
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
const { toolResult, assertFailsOnMissingOutput } = require('../../scripts/lib/tool-result.cjs');

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
