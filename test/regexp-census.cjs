'use strict';
// Every RegExp the bundle BUILDS at run time, with its capture-group count: the instrument behind
// test/fidelity/regexp-capture-census.test.cjs.
//
// WHY RUN TIME, AND WHY NAUDE. QuickJS-ng refused a pattern with more than 254 capture groups
// (the index was a byte in its bytecode); since quickjs-ng-regexp-capture-u16.patch the engine
// allows native's 32,768 (QUICKJS_CAPTURE_LIMIT, below). A regex
// LITERAL that big fails when quaude's build compiles the graph, loudly. A pattern the bundle
// BUILDS with `new RegExp(...)` fails only when that code runs: the artifact-lead scrubber's did,
// at 559 groups, and no subagent could finish (BACKLOG.md). Its tag-scrub siblings (h6(), the
// same atomic-separator trick) sat at 251 and 229 when that was found. So this counts what the
// bundle actually builds, on real turns, under node, where every pattern compiles: node is the
// place to see how close a pattern is to QuickJS's limit before quaude meets it.
//
// HOW. naude (node on the staged cli.cjs) runs a plain -p turn and a synchronous Task turn
// against the canned mock, in a fresh CLAUDE_CONFIG_DIR, with a --require preload that wraps the
// RegExp constructor. Each construction is recorded as { captures, length, flags, at }, where
// `at` is the first stack frame outside the preload. The preload proves itself first: it builds
// a two-group probe through the same wrapper and records it under a marker.
//
// Run as a program (the guard does, through spawnSync, because the mock lives on an event loop a
// synchronous read() cannot give it): node test/regexp-census.cjs <staged-dir> <out.json>
const fs = require('node:fs');
const { spawnCollect } = require('./spawn-collect.cjs');
const { throwawayHome } = require('./throwaway-home.cjs');
const os = require('node:os');
const path = require('node:path');

const PROBE_MARK = 'clode-regexp-census-probe';
// Written to a temp file and loaded with --require. Plain ES5-ish so it runs on any node.
const PRELOAD = `'use strict';
const fs = require('fs');
const Real = RegExp;
const seen = new Map();
let constructed = 0;
function count(re) {
  try { return new Real(re.source + '|', re.flags.replace(/[gy]/g, '')).exec('').length - 1; } catch (e) { return -1; }
}
function frame() {
  const lines = String(new Error().stack).split('\\n').slice(1).map((s) => s.trim());
  const outside = lines.find((l) => l.indexOf(__filename) < 0 && !/^at (?:new )?(?:Object\\.)?(?:construct|apply) \\(/.test(l));
  return (outside || '?').replace(/^at /, '').replace(/clode-graph:%2F%24bunfs%2Froot%2F/g, '');
}
function note(re, at) {
  constructed++;
  const captures = count(re);
  const key = captures + ':' + re.source.length + ':' + at;
  const hit = seen.get(key);
  if (hit) hit.times++;
  else seen.set(key, { captures, length: re.source.length, flags: re.flags, at, times: 1 });
}
globalThis.RegExp = new Proxy(Real, {
  construct(t, args, nt) { const r = Reflect.construct(t, args, nt === globalThis.RegExp ? t : nt); note(r, frame()); return r; },
  apply(t, self, args) { const r = Reflect.apply(t, self, args); note(r, frame()); return r; },
});
note(new globalThis.RegExp('(${PROBE_MARK})(b)'), '${PROBE_MARK}');
process.on('exit', () => {
  fs.writeFileSync(process.env.CLODE_REGEXP_CENSUS_OUT, JSON.stringify({ constructed, patterns: [...seen.values()] }));
});
`;

// Two turns under naude with the preload; returns { turns: [{ name, status, answered, census }] }.
async function runTurns(stageDir, workDir) {
  const { spawn } = require('node:child_process');
  const { startMockAnthropic, cannedSSE, cannedToolUseSSE } = require('./mock-anthropic-helper.cjs');
  const preload = path.join(workDir, 'regexp-census-preload.cjs');
  fs.writeFileSync(preload, PRELOAD);
  const TASK = { name: 'Task', input: { description: 'delegate', prompt: 'answer with CENSUS-SUB-PROMPT',
    subagent_type: 'general-purpose', run_in_background: false }, id: 'toolu_census_task_1' };
  const turns = [
    { name: 'plain', prompt: 'say hi', done: 'CENSUS-PLAIN-DONE', respond: () => cannedSSE('CENSUS-PLAIN-DONE') },
    { name: 'task', prompt: 'delegate the work', done: 'CENSUS-TASK-DONE',
      respond: (body) => (body.includes('"tool_result"') && body.includes(TASK.id)) ? cannedSSE('CENSUS-TASK-DONE')
        : body.includes('CENSUS-SUB-PROMPT') ? cannedSSE('CENSUS-SUB-ANSWER')
          : cannedToolUseSSE(TASK.name, TASK.input, TASK.id) },
  ];
  const out = [];
  for (const turn of turns) {
    const mock = await startMockAnthropic({ respond: turn.respond });
    const cfg = fs.mkdtempSync(path.join(workDir, `cfg-${turn.name}-`));
    const censusFile = path.join(workDir, `census-${turn.name}.json`);
    const env = { ...process.env, ...throwawayHome(cfg), ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: 'sk-ant-mock',
      CLAUDE_CONFIG_DIR: cfg, CLODE_REGEXP_CENSUS_OUT: censusFile,
      NODE_PATH: path.join(__dirname, '..', 'deps', 'claude', 'node_modules') };
    delete env.CLODE_ENGINE;
    const r = await spawnCollect(process.execPath, ['--require', preload, path.join(stageDir, 'cli.cjs'), '-p', turn.prompt,
      '--allowedTools', 'Task'], { cwd: stageDir, env }, { timeoutMs: 180000 });
    await mock.close();
    let census = null;
    try { census = JSON.parse(fs.readFileSync(censusFile, 'utf8')); } catch { /* absent: reported below */ }
    out.push({ name: turn.name, status: r.status, signal: r.signal, answered: r.stdout.includes(turn.done),
      stderr: r.stderr.slice(0, 600), census });
  }
  return { turns: out };
}

// Synchronous wrapper for a guard's read(): the turns run in a child node process.
function censusOf(stageDir) {
  const { spawnSync } = require('node:child_process');
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'regexp-census-'));
  try {
    const outFile = path.join(workDir, 'out.json');
    const r = spawnSync(process.execPath, [__filename, stageDir, outFile], { encoding: 'utf8', timeout: 480000 });
    let out = '';
    try { out = fs.readFileSync(outFile, 'utf8'); } catch { /* absent */ }
    if (!out) throw new Error(`regexp census wrote nothing (exit ${r.status}, signal ${r.signal}): ${String(r.stderr).slice(0, 600)}`);
    return JSON.parse(out);
  } finally { fs.rmSync(workDir, { recursive: true, force: true }); }
}

if (require.main === module) {
  const [stageDir, outFile] = process.argv.slice(2);
  runTurns(stageDir, path.dirname(outFile)).then((res) => fs.writeFileSync(outFile, JSON.stringify(res)),
    (e) => { process.stderr.write(String(e && e.stack || e)); process.exit(1); });
}

// THE ENGINE'S LIMIT, which is native's: JavaScriptCore inside native Claude Code 2.1.330 accepts
// 32,768 groups and refuses 32,769 (measured 2026-11-21), and spike/quickjs/patches/
// quickjs-ng-regexp-capture-u16.patch sets CAPTURE_COUNT_MAX to match. ONE constant for both
// readers: test/engine-regexp-captures.test.cjs proves the engine accepts exactly this many and
// refuses one more, so the census below cannot judge against a limit the engine does not have.
const QUICKJS_CAPTURE_LIMIT = 32768;

module.exports = { PRELOAD, PROBE_MARK, censusOf, QUICKJS_CAPTURE_LIMIT };
