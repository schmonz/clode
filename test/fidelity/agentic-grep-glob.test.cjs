'use strict';
// The Grep and Glob tools, and the Bash tool's `rg`, END TO END against native (grep-native Task 11).
//
// WHAT IS JUDGED. A quaude BUILT from this tree (test/built-binary.cjs) runs one -p turn with `--allowedTools
// Grep,Glob,Bash` against a canned mock that asks, one tool_use per follow-up, for every call in SCRIPT: Grep in each
// output_mode (files_with_matches with and without glob/type/-i, content with -n/-C/-A/-B/-i/-o/multiline/head_limit/
// offset, count), over a directory holding a binary file (the tool's own "binary file matches" handling), on a path
// outside the working directory (--add-dir), with no match; Glob by pattern, with a path inside and outside the
// working directory, with no match; and `rg` typed into the Bash tool. Each tool_result (its text and is_error, as
// the model reads it: scripts/lib/tool-result.cjs) must equal NATIVE's, byte for byte, with nothing normalized but
// the temp dir's own path (<B>).
//
// TWICE, on two PATHs: one holding no rg at all, and one whose first entry is a TRIPWIRE rg (a shell script that
// prints TRIPWIRE-HOST-RG-RAN). The Grep and Glob tools must never run it: they answer as native does on both
// (quaude's rg is its own, libexec/rg-native.cjs; bun-shim's Bun.which('rg') answers quaude's own path). The Bash tool's
// `rg` DOES run it, on native as on quaude: upstream's snapshot defines its rg function only inside an "is rg
// installed?" guard, so a host rg the user installed is the one their shell runs (user ruling 2026-10-04); without
// one, the Bash tool's rg is quaude's tested rg (libexec/rg-entry.cjs), and native's answer is the literal below.
//
// NATIVE is native Claude Code 2.1.283's answer to this exact script over this exact tree (MEASURED below), run the
// same way: same mock, same tree and mtimes, same flags, SHELL=bash. Measured on darwin-arm64 and linux-x64 (they
// agree: no call here names a binary file, the one place native's own platforms differ, RG-MMAP-EVERYWHERE).
// Re-measure at a pin bump with CLODE_E2E_NATIVE=1 (the second test): it runs the provider instead and fails, printing
// the table it measured, wherever native's answer moved.
//
// WHY A SIBLING OF agentic-tools: that file drives the bundle under the dev loader; this one drives what a user runs
// (the built binary, whose bootstrap answers `rg` before the bundle loads), and native too.
const test = require('node:test');
const { spawnCollect } = require('../spawn-collect.cjs');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { builtQuaude } = require('../built-binary.cjs');
const { providerBin, skipReason } = require('../provider-resolve.cjs');
const { throwawayHome } = require('../throwaway-home.cjs');
const { startMockAnthropic, cannedSSE, cannedToolUseSSE } = require('../mock-anthropic-helper.cjs');
const { toolResult, assertFailsOnMissingOutput } = require('../../scripts/lib/tool-result.cjs');

// THE TREE: <B>/work is the working directory, <B>/outside is added with --add-dir. Every file gets its own mtime
// (T0 + dt): files_with_matches and Glob list newest first, and a tie would leave the order to the walk.
const T0 = 1700000000;
const TREE = [
  ['work/src/app.js', "const alpha = 1;\nfunction findNeedle() {\n  return 'needle one';\n}\n// NEEDLE in caps\nconst beta = 2;\n", 9],
  ['work/src/util.py', 'def needle():\n    return 2\n', 8],
  ['work/docs/notes.md', '# Notes\nthe needle is here\nend\n', 7],
  ['work/docs/guide.md', '# Guide\nno match here\n', 6],
  ['work/data/blob.bin', 'a needle line\n\0\0binary\nneedle again\n', 5],
  ['work/data/plain.txt', 'needle in plain text\n', 4.5],
  // a NUL past rg's first 64 KiB read of a walked file: what came before it is searched, then rg stops (RG-BINARY-QUIT)
  // and its JSON carries the binary_offset the Grep tool turns into its "binary file matches" note
  ['work/data/late.bin', `needle before the nul\n${`${'x'.repeat(99)}\n`.repeat(700)}\0\nneedle after the nul\n`, 4.2],
  ['work/multi.txt', 'start\nfoo bar\nbaz qux\nend\n', 4],
  ['work/.hidden.txt', 'needle hidden\n', 3],
  ['work/lines.txt', 'needle 1\nneedle 2\nother\nneedle 3\nneedle 4\nneedle 5\n', 2],
  ['outside/far.txt', 'far needle\n', 1],
  ['outside/deep/x.js', 'needle x\n', 0.5],
];
function makeTree(base) {
  for (const [rel, text, dt] of TREE) {
    const p = path.join(base, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
    fs.utimesSync(p, T0 + dt, T0 + dt);
  }
  return { base, work: path.join(base, 'work'), outside: path.join(base, 'outside') };
}

// THE CALLS, each the tool_use object the mock scripts and the control is given (relative paths resolve against the
// working directory, as the tools resolve them). A content or count call over a directory names at most ONE file
// that prints: rg's parallel walk prints files in no fixed order (native's own order varied across runs here), and
// the tool does not sort them. files_with_matches and Glob sort by mtime, so they may span many.
const G_FILES = { name: 'Grep', input: { pattern: 'needle' }, id: 'toolu_g_files' };
const G_FILES_GLOB = { name: 'Grep', input: { pattern: 'needle', glob: '*.md' }, id: 'toolu_g_files_glob' };
const G_FILES_TYPE = { name: 'Grep', input: { pattern: 'needle', type: 'py' }, id: 'toolu_g_files_type' };
const G_FILES_I = { name: 'Grep', input: { pattern: 'NEEDLE', path: 'src', '-i': true }, id: 'toolu_g_files_i' };
const G_CONTENT = { name: 'Grep', input: { pattern: 'needle', path: 'src/app.js', output_mode: 'content' }, id: 'toolu_g_content' };
const G_CONTENT_IC = { name: 'Grep', input: { pattern: 'needle', path: 'src/app.js', output_mode: 'content', '-i': true, '-C': 1 }, id: 'toolu_g_content_ic' };
const G_CONTENT_A = { name: 'Grep', input: { pattern: 'needle', path: 'lines.txt', output_mode: 'content', '-A': 1, '-n': false }, id: 'toolu_g_content_a' };
const G_CONTENT_B = { name: 'Grep', input: { pattern: 'other', path: 'lines.txt', output_mode: 'content', '-B': 2 }, id: 'toolu_g_content_b' };
const G_CONTENT_O = { name: 'Grep', input: { pattern: 'need\\w+', path: 'src/app.js', output_mode: 'content', '-o': true, '-i': true }, id: 'toolu_g_content_o' };
const G_MULTILINE = { name: 'Grep', input: { pattern: 'bar\\nbaz', path: 'multi.txt', output_mode: 'content', multiline: true }, id: 'toolu_g_multiline' };
const G_HEAD = { name: 'Grep', input: { pattern: 'needle', path: 'lines.txt', output_mode: 'content', head_limit: 2 }, id: 'toolu_g_head' };
const G_OFFSET = { name: 'Grep', input: { pattern: 'needle', path: 'lines.txt', output_mode: 'content', head_limit: 2, offset: 2 }, id: 'toolu_g_offset' };
const G_COUNT = { name: 'Grep', input: { pattern: 'needle', path: 'lines.txt', output_mode: 'count' }, id: 'toolu_g_count' };
const G_COUNT_DIR = { name: 'Grep', input: { pattern: 'needle', path: 'docs', output_mode: 'count' }, id: 'toolu_g_count_dir' };
const G_BIN_FILES = { name: 'Grep', input: { pattern: 'needle', path: 'data' }, id: 'toolu_g_bin_files' };
const G_BIN_CONTENT = { name: 'Grep', input: { pattern: 'needle', path: 'data', glob: '*.bin', output_mode: 'content' }, id: 'toolu_g_bin_content' };
const G_BIN_COUNT = { name: 'Grep', input: { pattern: 'needle', path: 'data', output_mode: 'count' }, id: 'toolu_g_bin_count' };
const G_OUTSIDE = { name: 'Grep', input: { pattern: 'needle', path: '../outside/far.txt', output_mode: 'content' }, id: 'toolu_g_outside' };
const G_OUTSIDE_FILES = { name: 'Grep', input: { pattern: 'needle', path: '../outside' }, id: 'toolu_g_outside_files' };
const G_NONE = { name: 'Grep', input: { pattern: 'zzzz-no-such' }, id: 'toolu_g_none' };
const GL_JS = { name: 'Glob', input: { pattern: '**/*.js' }, id: 'toolu_gl_js' };
const GL_PATH = { name: 'Glob', input: { pattern: '*.md', path: 'docs' }, id: 'toolu_gl_path' };
const GL_OUTSIDE = { name: 'Glob', input: { pattern: '**/*', path: '../outside' }, id: 'toolu_gl_outside' };
const GL_NONE = { name: 'Glob', input: { pattern: '*.nothing' }, id: 'toolu_gl_none' };
const B_RG = { name: 'Bash', input: { command: 'rg -j1 -n needle src/app.js docs', description: 'search' }, id: 'toolu_b_rg' };
const B_RG_COUNT = { name: 'Bash', input: { command: 'rg -j1 -c needle docs lines.txt data', description: 'count' }, id: 'toolu_b_rg_count' };
const B_RG_NONE = { name: 'Bash', input: { command: 'rg zzzz-no-such; echo rc=$?', description: 'miss' }, id: 'toolu_b_rg_none' };

// The mock's script: one tool_use per follow-up, in this order, then a closing text turn.
function drive(USE) { return { use: USE, emit: () => cannedToolUseSSE(USE.name, USE.input, USE.id) }; }
const SCRIPT = [
  drive(G_FILES), drive(G_FILES_GLOB), drive(G_FILES_TYPE), drive(G_FILES_I),
  drive(G_CONTENT), drive(G_CONTENT_IC), drive(G_CONTENT_A), drive(G_CONTENT_B), drive(G_CONTENT_O),
  drive(G_MULTILINE), drive(G_HEAD), drive(G_OFFSET), drive(G_COUNT), drive(G_COUNT_DIR),
  drive(G_BIN_FILES), drive(G_BIN_CONTENT), drive(G_BIN_COUNT), drive(G_OUTSIDE), drive(G_OUTSIDE_FILES), drive(G_NONE),
  drive(GL_JS), drive(GL_PATH), drive(GL_OUTSIDE), drive(GL_NONE),
  drive(B_RG), drive(B_RG_COUNT), drive(B_RG_NONE),
];

// MEASURED: native 2.1.283's tool_results for SCRIPT, as { text, isError }; <B> is the temp dir.
const NATIVE = {
  toolu_g_files: { text: "Found 7 files\nsrc/app.js\nsrc/util.py\ndocs/notes.md\ndata/plain.txt\ndata/late.bin\n.hidden.txt\nlines.txt", isError: false },
  toolu_g_files_glob: { text: "Found 1 file\ndocs/notes.md", isError: false },
  toolu_g_files_type: { text: "Found 1 file\nsrc/util.py", isError: false },
  toolu_g_files_i: { text: "Found 2 files\nsrc/app.js\nsrc/util.py", isError: false },
  toolu_g_content: { text: "3:  return \'needle one\';", isError: false },
  toolu_g_content_ic: { text: "1-const alpha = 1;\n2:function findNeedle() {\n3:  return \'needle one\';\n4-}\n5:// NEEDLE in caps\n6-const beta = 2;", isError: false },
  toolu_g_content_a: { text: "needle 1\nneedle 2\nother\nneedle 3\nneedle 4\nneedle 5", isError: false },
  toolu_g_content_b: { text: "1-needle 1\n2-needle 2\n3:other", isError: false },
  toolu_g_content_o: { text: "2:Needle\n3:needle\n5:NEEDLE", isError: false },
  toolu_g_multiline: { text: "2:foo bar\n3:baz qux", isError: false },
  toolu_g_head: { text: "1:needle 1\n2:needle 2\n\n[Showing results with pagination = limit: 2]", isError: false },
  toolu_g_offset: { text: "4:needle 3\n5:needle 4\n\n[Showing results with pagination = limit: 2, offset: 2]", isError: false },
  toolu_g_count: { text: "lines.txt:5\n\nFound 5 total occurrences across 1 file.", isError: false },
  toolu_g_count_dir: { text: "docs/notes.md:1\n\nFound 1 total occurrence across 1 file.", isError: false },
  toolu_g_bin_files: { text: "Found 2 files\ndata/plain.txt\ndata/late.bin", isError: false },
  toolu_g_bin_content: { text: "data/late.bin:1:needle before the nul\ndata/late.bin:binary file matches (found \"\\0\" byte around offset 70022)", isError: false },
  toolu_g_bin_count: { text: "data/plain.txt:1\n\nFound 1 total occurrence across 1 file.", isError: false },
  toolu_g_outside: { text: "1:far needle", isError: false },
  toolu_g_outside_files: { text: "Found 2 files\n<B>/outside/far.txt\n<B>/outside/deep/x.js", isError: false },
  toolu_g_none: { text: "No files found", isError: false },
  toolu_gl_js: { text: "src/app.js", isError: false },
  toolu_gl_path: { text: "docs/guide.md\ndocs/notes.md", isError: false },
  toolu_gl_outside: { text: "<B>/outside/deep/x.js\n<B>/outside/far.txt", isError: false },
  toolu_gl_none: { text: "No files found", isError: false },
  toolu_b_rg: { text: "src/app.js:3:  return \'needle one\';\ndocs/notes.md:2:the needle is here", isError: false },
  toolu_b_rg_count: { text: "docs/notes.md:1\nlines.txt:5\ndata/plain.txt:1", isError: false },
  toolu_b_rg_none: { text: "rc=1", isError: false },
};
// ...and where a tripwire rg is first on PATH: only the Bash tool's rg changes (it runs the host rg, as native does).
const NATIVE_TRIPWIRE = {
  toolu_b_rg: { text: "Exit code 99\nTRIPWIRE-HOST-RG-RAN -j1 -n needle src/app.js docs", isError: true },
  toolu_b_rg_count: { text: "Exit code 99\nTRIPWIRE-HOST-RG-RAN -j1 -c needle docs lines.txt data", isError: true },
  toolu_b_rg_none: { text: "TRIPWIRE-HOST-RG-RAN zzzz-no-such\nrc=99", isError: false },
};
const PATH_MODES = ['no rg on PATH', 'a tripwire rg first on PATH'];

// The turn being judged (set by judge() before any check runs): which PATH, and the tree's temp dir.
let judged = { mode: PATH_MODES[0], base: '' };
function want(USE) {
  const w = (judged.mode === PATH_MODES[1] && NATIVE_TRIPWIRE[USE.id]) || NATIVE[USE.id];
  return w && { text: w.text.split('<B>').join(judged.base), isError: w.isError };
}
const sameAs = (r, USE) => { const w = want(USE); return !!r && !!w && r.text === w.text && r.isError === w.isError; };

// One check per call: the tool_result for that call's id equals native's.
const gFiles = (m) => sameAs(toolResult(m, G_FILES.id), G_FILES);
const gFilesGlob = (m) => sameAs(toolResult(m, G_FILES_GLOB.id), G_FILES_GLOB);
const gFilesType = (m) => sameAs(toolResult(m, G_FILES_TYPE.id), G_FILES_TYPE);
const gFilesI = (m) => sameAs(toolResult(m, G_FILES_I.id), G_FILES_I);
const gContent = (m) => sameAs(toolResult(m, G_CONTENT.id), G_CONTENT);
const gContentIC = (m) => sameAs(toolResult(m, G_CONTENT_IC.id), G_CONTENT_IC);
const gContentA = (m) => sameAs(toolResult(m, G_CONTENT_A.id), G_CONTENT_A);
const gContentB = (m) => sameAs(toolResult(m, G_CONTENT_B.id), G_CONTENT_B);
const gContentO = (m) => sameAs(toolResult(m, G_CONTENT_O.id), G_CONTENT_O);
const gMultiline = (m) => sameAs(toolResult(m, G_MULTILINE.id), G_MULTILINE);
const gHead = (m) => sameAs(toolResult(m, G_HEAD.id), G_HEAD);
const gOffset = (m) => sameAs(toolResult(m, G_OFFSET.id), G_OFFSET);
const gCount = (m) => sameAs(toolResult(m, G_COUNT.id), G_COUNT);
const gCountDir = (m) => sameAs(toolResult(m, G_COUNT_DIR.id), G_COUNT_DIR);
const gBinFiles = (m) => sameAs(toolResult(m, G_BIN_FILES.id), G_BIN_FILES);
const gBinContent = (m) => sameAs(toolResult(m, G_BIN_CONTENT.id), G_BIN_CONTENT);
const gBinCount = (m) => sameAs(toolResult(m, G_BIN_COUNT.id), G_BIN_COUNT);
const gOutside = (m) => sameAs(toolResult(m, G_OUTSIDE.id), G_OUTSIDE);
const gOutsideFiles = (m) => sameAs(toolResult(m, G_OUTSIDE_FILES.id), G_OUTSIDE_FILES);
const gNone = (m) => sameAs(toolResult(m, G_NONE.id), G_NONE);
const glJs = (m) => sameAs(toolResult(m, GL_JS.id), GL_JS);
const glPath = (m) => sameAs(toolResult(m, GL_PATH.id), GL_PATH);
const glOutside = (m) => sameAs(toolResult(m, GL_OUTSIDE.id), GL_OUTSIDE);
const glNone = (m) => sameAs(toolResult(m, GL_NONE.id), GL_NONE);
const bRg = (m) => sameAs(toolResult(m, B_RG.id), B_RG);
const bRgCount = (m) => sameAs(toolResult(m, B_RG_COUNT.id), B_RG_COUNT);
const bRgNone = (m) => sameAs(toolResult(m, B_RG_NONE.id), B_RG_NONE);
// Every verdict on a turn: each call's check, called by name (the control above each is bound to it).
const verdicts = (m) => [
  [G_FILES, gFiles(m)], [G_FILES_GLOB, gFilesGlob(m)], [G_FILES_TYPE, gFilesType(m)], [G_FILES_I, gFilesI(m)],
  [G_CONTENT, gContent(m)], [G_CONTENT_IC, gContentIC(m)], [G_CONTENT_A, gContentA(m)], [G_CONTENT_B, gContentB(m)],
  [G_CONTENT_O, gContentO(m)], [G_MULTILINE, gMultiline(m)], [G_HEAD, gHead(m)], [G_OFFSET, gOffset(m)],
  [G_COUNT, gCount(m)], [G_COUNT_DIR, gCountDir(m)], [G_BIN_FILES, gBinFiles(m)], [G_BIN_CONTENT, gBinContent(m)],
  [G_BIN_COUNT, gBinCount(m)], [G_OUTSIDE, gOutside(m)], [G_OUTSIDE_FILES, gOutsideFiles(m)], [G_NONE, gNone(m)],
  [GL_JS, glJs(m)], [GL_PATH, glPath(m)], [GL_OUTSIDE, glOutside(m)], [GL_NONE, glNone(m)], [B_RG, bRg(m)],
  [B_RG_COUNT, bRgCount(m)], [B_RG_NONE, bRgNone(m)],
];

// Each control, before any turn: every check must FAIL when its tool's output is missing.
// (The Bash rows run with SHELL=bash: they declare that cell too, for test/build-gates/tool-coverage-gates.test.cjs.)
function controls() {
  for (const mode of PATH_MODES) {
    judged = { mode, base: '/nonexistent-e2e-base' };
    assertFailsOnMissingOutput(gFiles, G_FILES);
    assertFailsOnMissingOutput(gFilesGlob, G_FILES_GLOB);
    assertFailsOnMissingOutput(gFilesType, G_FILES_TYPE);
    assertFailsOnMissingOutput(gFilesI, G_FILES_I);
    assertFailsOnMissingOutput(gContent, G_CONTENT);
    assertFailsOnMissingOutput(gContentIC, G_CONTENT_IC);
    assertFailsOnMissingOutput(gContentA, G_CONTENT_A);
    assertFailsOnMissingOutput(gContentB, G_CONTENT_B);
    assertFailsOnMissingOutput(gContentO, G_CONTENT_O);
    assertFailsOnMissingOutput(gMultiline, G_MULTILINE);
    assertFailsOnMissingOutput(gHead, G_HEAD);
    assertFailsOnMissingOutput(gOffset, G_OFFSET);
    assertFailsOnMissingOutput(gCount, G_COUNT);
    assertFailsOnMissingOutput(gCountDir, G_COUNT_DIR);
    assertFailsOnMissingOutput(gBinFiles, G_BIN_FILES);
    assertFailsOnMissingOutput(gBinContent, G_BIN_CONTENT);
    assertFailsOnMissingOutput(gBinCount, G_BIN_COUNT);
    assertFailsOnMissingOutput(gOutside, G_OUTSIDE);
    assertFailsOnMissingOutput(gOutsideFiles, G_OUTSIDE_FILES);
    assertFailsOnMissingOutput(gNone, G_NONE);
    assertFailsOnMissingOutput(glJs, GL_JS);
    assertFailsOnMissingOutput(glPath, GL_PATH);
    assertFailsOnMissingOutput(glOutside, GL_OUTSIDE);
    assertFailsOnMissingOutput(glNone, GL_NONE);
    assertFailsOnMissingOutput(bRg, B_RG, ['print', 'shell:bash']);
    assertFailsOnMissingOutput(bRgCount, B_RG_COUNT, ['print', 'shell:bash']);
    assertFailsOnMissingOutput(bRgNone, B_RG_NONE, ['print', 'shell:bash']);
  }
}

// What the turn inherits: none of the caller's own Claude Code session (a test run from inside one carries
// CLAUDE_CODE_ENTRYPOINT and friends, which change which tools register) nor its API settings.
function baseEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(CLAUDE|ANTHROPIC)/.test(k)) env[k] = v;
  return env;
}
// THE PATH WITH NO rg (review M2). Dropping every directory that holds an rg also drops what sits beside it: where rg
// lives with ugrep and bash (Homebrew's bin, pkgsrc's /opt/pkg/bin), quaude's rg would lose its ugrep and the turn would
// fail for a reason that is not the product's. So a directory holding an rg is replaced by one of its own (under
// `scratch`) linking every other entry of it: only rg is hidden, everything else still resolves.
function pathWithoutRg(PATH, scratch) {
  return PATH.split(path.delimiter).filter(Boolean).map((d, i) => {
    if (!fs.existsSync(path.join(d, 'rg'))) return d;
    const twin = path.join(scratch, `path-${i}`);
    fs.mkdirSync(twin, { recursive: true });
    for (const e of fs.readdirSync(d)) if (e !== 'rg') try { fs.symlinkSync(path.join(d, e), path.join(twin, e)); } catch { /* unlinkable: not a tool */ }
    return twin;
  }).join(path.delimiter);
}
const resolveBin = (name, PATH) => PATH.split(path.delimiter).map((d) => d && path.join(d, name)).find((p) => p && fs.existsSync(p)) || null;

function runTurn(bin, cwd, env, timeoutMs) {
  return spawnCollect(bin, ['-p', 'search the tree', '--allowedTools', 'Grep,Glob,Bash', '--add-dir', '../outside'],
    { cwd, env }, { timeoutMs }).then(({ status, signal, stderr }) => ({ status, signal, stderr }));
}

// One turn of SCRIPT by `bin` on `mode`'s PATH; every check judged. -> { findings, measured }.
async function judge(bin, mode) {
  const t = makeTree(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'grep-glob-e2e-'))));
  try {
    const trip = path.join(t.base, 'trip');
    fs.mkdirSync(trip);
    fs.writeFileSync(path.join(trip, 'rg'), '#!/bin/sh\necho TRIPWIRE-HOST-RG-RAN "$@"\nexit 99\n', { mode: 0o755 });
    const host = baseEnv();
    const noRg = pathWithoutRg(host.PATH || '', path.join(t.base, 'no-rg'));
    const PATH = mode === PATH_MODES[1] ? `${trip}${path.delimiter}${noRg}` : noRg;
    const bash = resolveBin('bash', noRg);
    const mock = await startMockAnthropic({
      respond: (body) => { const next = SCRIPT.find((s) => !body.includes(s.use.id)); return next ? next.emit() : cannedSSE('E2E-DONE'); },
    });
    try {
      const env = { ...host, ...throwawayHome(t.base), PATH, SHELL: bash, ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: 'sk-ant-mock' };
      const r = await runTurn(bin, t.work, env, 240000);
      const findings = [];
      if (r.status !== 0) findings.push(`${mode}: the turn exited ${r.status}${r.signal ? ` (${r.signal})` : ''}: ${r.stderr.slice(0, 800)}`);
      judged = { mode, base: t.base };
      const measured = {};
      for (const [USE, same] of verdicts(mock)) {
        const got = toolResult(mock, USE.id);
        measured[USE.id] = got && { text: got.text.split(t.base).join('<B>'), isError: got.isError };
        if (!same) findings.push(`${mode}: ${USE.id} ${JSON.stringify(USE.input)}\n    native: ${JSON.stringify(want(USE))}\n    got:    ${JSON.stringify(measured[USE.id])}`);
      }
      return { findings, measured };
    } finally { await mock.close(); }
  } finally { fs.rmSync(t.base, { recursive: true, force: true }); }
}

test('pathWithoutRg hides only rg: a tool beside it still resolves (review M2)', { skip: process.platform === 'win32' ? 'symlinks and a POSIX PATH' : false }, () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'no-rg-path-')));
  try {
    const bin = path.join(d, 'bin'), other = path.join(d, 'other');
    for (const [dir, names] of [[bin, ['rg', 'ugrep', 'bash']], [other, ['zsh']]]) {
      fs.mkdirSync(dir);
      for (const n of names) fs.writeFileSync(path.join(dir, n), '#!/bin/sh\n', { mode: 0o755 });
    }
    const P = pathWithoutRg([bin, other].join(path.delimiter), path.join(d, 'scratch'));
    assert.strictEqual(resolveBin('rg', P), null);
    for (const n of ['ugrep', 'bash', 'zsh']) assert.ok(resolveBin(n, P), `${n} must still resolve`);
    assert.ok(P.split(path.delimiter).includes(other), 'a directory with no rg is kept as it is');
  } finally { fs.rmSync(d, { recursive: true, force: true }); }
});

const SKIP = process.platform === 'win32' ? 'the tripwire is a shell script and the Bash rows need bash' : false;

test('Grep, Glob and the Bash tool\'s rg in a built quaude: every tool_result equals native\'s, with no rg and with a tripwire rg on PATH', { skip: SKIP }, async (t) => {
  const q = builtQuaude();
  if (q.skip) { t.skip(q.skip); return; }
  controls();
  const findings = [];
  for (const mode of PATH_MODES) findings.push(...(await judge(q.path, mode)).findings);
  assert.deepStrictEqual(findings, [], `${findings.length} tool_result(s) differ from native's:\n${findings.join('\n')}`);
});

// THE INSTRUMENT: native itself, against the literals (opt-in: it runs the provider's own turn, so it is a measurement
// to repeat at a pin bump, not a check on this tree). On a difference it prints what it measured, to paste above.
test('native answers this script as NATIVE records (CLODE_E2E_NATIVE=1)', { skip: SKIP || (process.env.CLODE_E2E_NATIVE !== '1' && 'opt-in: CLODE_E2E_NATIVE=1 re-measures native') }, async (t) => {
  const bin = providerBin(process.env);
  if (!bin) { t.skip(skipReason(process.env)); return; }
  controls();
  const findings = [], measured = {};
  for (const mode of PATH_MODES) {
    const r = await judge(bin, mode);
    findings.push(...r.findings);
    measured[mode] = r.measured;
  }
  if (findings.length) t.diagnostic(`measured:\n${JSON.stringify(measured, null, 1)}`);
  if (process.env.CLODE_E2E_NATIVE_OUT) fs.writeFileSync(process.env.CLODE_E2E_NATIVE_OUT, JSON.stringify(measured, null, 1));
  assert.deepStrictEqual(findings, [], `native moved:\n${findings.join('\n')}`);
});
