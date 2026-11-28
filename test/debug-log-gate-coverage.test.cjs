'use strict';
// THE RATCHET FOR THE RATCHET: every harness file that runs a quaude (a built one, or the carve under tjs + node-shim)
// reads that run's --debug log through test/debug-log-gate.cjs, or says by name why it cannot. Without this, the next
// driver written beside the choke points spawns quaude its own way and its log goes unread again, which is how
// `zlib.gzipSync not implemented`, `A bundled root does not parse: TypeError: not a function` and `timeout of 5000ms
// exceeded` sat for weeks in logs the drivers produced (test/debug-log-gate.cjs WHY).
//
// THE RULE, per file under test/ and scripts/ (comments stripped, so prose naming a spawn is not one):
//   SPAWNS  the file runs a quaude: it calls builtQuaude() or quaudeBesideNative(), names runQuaudeModel or
//           runQuaudeModelAsync, or puts the carve after the node-shim loader (`LOADER, cli` / `LOADER, staged.cli`: tjs
//           run loader cli.cjs). These are the ways this repo resolves a quaude; an operator tool handed a binary on its
//           command line (scripts/tui-probe.mjs) is not a harness and is not seen.
//   READS   the file goes through a CHOKE POINT that reads the log itself (driveTool, frame-oracle's captureSessions or
//           captureFrames), or calls the gate (assertDebugLogClean, judgeDebugLog, runScanned).
//   A file that SPAWNS and does not READ fails here unless EXEMPT names it with the reason its run has no log to read.
//   Each CHOKE POINT must itself pass a debug file (debugFileArgs) and judge it (assertDebugLogClean).
//   An EXEMPT file that no longer spawns, or now reads, is a stale exemption: also a finding.
// BLIND SPOT, stated: the unit is the FILE. A file that reads one run's log and spawns another quaude its own way
// passes; the choke points exist so that a new spawn has no reason to be hand-rolled.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { stripComments } = require('./strip-comments.cjs');
const { defineGuard, guardTests } = require('./guard.cjs');

const REPO = path.resolve(__dirname, '..');
const SPAWNS = [
  /(?<!function )\bbuiltQuaude\(\)/,
  /\brunQuaudeModel(?:Async)?\b/,   // a call, or the runner taken by name (apicheck's `models.runQuaudeModel`)
  /\bquaudeBesideNative\(/,
  /\bLOADER,\s*(?:staged\.)?cli\b/,
];
const READS = /\b(?:driveTool|captureSessions|captureFrames|assertDebugLogClean|judgeDebugLog|runScanned)\(/;
const CHOKE_POINTS = ['test/tool-driver.cjs', 'test/frame-oracle.cjs'];
// The gate's own files, and the definitions the patterns name (built-binary defines builtQuaude, oracle-models the
// quaude-model runners, live-frame-gate quaudeBesideNative): a definition is not a run.
const NOT_HARNESS = new Set(['test/debug-log-gate.cjs', 'test/debug-log-gate-coverage.test.cjs',
  'test/built-binary.cjs', 'test/oracle-models.cjs', 'test/live-frame-gate.cjs']);

// { file: why its quaude run has no debug log to read }. Each is a decision; keep it to runs that are not a Claude
// Code session (a version string, a build, ripgrep) or that cannot write one.
const EXEMPT = Object.freeze({
  'test/built-binary.test.cjs': 'checks builtQuaude() returns a real executable; it runs no session',
  'test/oracle-models.test.cjs': 'drives the quaude-model runners against a FAKE spawn (argv and env shape); no quaude runs',
  'test/live-frame-gate.test.cjs': 'unit tests of the gate\'s version check against fake binaries; no session runs',
  'test/fidelity/rg-differential.test.cjs': 'runs the built quaude AS rg (argv0 `rg`, its embedded ripgrep replacement), '
    + 'never Claude Code: there is no Claude Code debug log to write',
  'test/tjs-tls-trust.test.cjs': 'runs the built quaude with --version only (its boot-time CA-bundle guard, read through '
    + 'a CLODE_PROBE script): no session, so no debug log',
  'test/credential-store-attempted.test.cjs': 'a probe of the credential-store call the bundle makes BEFORE any request, '
    + 'pointed at an unroutable API (127.0.0.1:1) on purpose: its log is connection refusals by design, and the probe '
    + 'runs inside a guard (defineGuard) whose verdict is the security(1) call, not the turn',
  'test/keychain-capability.test.cjs': 'drives upstream\'s credential STORE from an entry module of its own added to '
    + 'the staged graph (mutate, then readAsync, with a fake security on PATH): no Claude Code session runs, so no '
    + 'debug log is written',
  'scripts/probe-run.mjs': 'a profiler: it runs scripts/apicheck.mjs\'s corpus through a TAPPED runner to count shim '
    + 'hits, and apicheck does not judge logs under injected runners; apicheck run as itself reads them (its Axis 4)',
  'test/doctor-cli-parity.test.cjs': '`doctor` and `--version` only (the CLI surface, compared to native as text): no turn',
  'test/e2e-ctrlz-tui.test.cjs': 'job control (SIGTSTP/SIGCONT) of a booted TUI, live-render gated (CLODE_LIVE_RENDER); '
    + 'its process is stopped and killed by design, so a log would end mid-write. The interactive session the gate '
    + 'reads is test/fidelity/debug-log-interactive.test.cjs\'s (boot, a turn, /tui, /quit)',
  'test/fidelity/update-notify.pty.test.cjs': 'the update NOTICE on boot against a fake manifest server, live-render '
    + 'gated: a synchronous 16 s capture (boot, /status) that tui-screen ends with SIGKILL, so no turn and a log cut '
    + 'mid-write. The interactive boot the gate reads is test/fidelity/debug-log-interactive.test.cjs\'s session',
});

function walk(rel, out) {
  for (const e of fs.readdirSync(path.join(REPO, rel), { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'fixtures' || e.name === 'evidence') continue;
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) walk(r, out);
    else if (/\.(?:cjs|mjs|js)$/.test(e.name)) out.push(r);
  }
  return out;
}
const source = (rel) => stripComments(fs.readFileSync(path.join(REPO, rel), 'utf8'));
const spawns = (src) => SPAWNS.some((re) => re.test(src));

// -> [finding] for the tree, or for the { rel: src } a control hands it
function coverageFindings(files, exempt = EXEMPT, chokePoints = CHOKE_POINTS) {
  const out = [];
  for (const [rel, src] of Object.entries(files)) {
    if (NOT_HARNESS.has(rel)) continue;
    const s = spawns(src), r = READS.test(src);
    if (rel in exempt) {
      if (!s) out.push(`${rel}: EXEMPT, but it no longer runs a quaude; drop the exemption`);
      else if (r) out.push(`${rel}: EXEMPT, but it now reads the debug log; drop the exemption`);
    } else if (s && !r) {
      out.push(`${rel}: runs a quaude and reads no --debug log (call a choke point, driveTool / captureSessions / `
        + 'captureFrames, or the gate, runScanned / assertDebugLogClean / judgeDebugLog; or EXEMPT it with the reason)');
    }
  }
  for (const c of chokePoints) {
    const src = files[c];
    if (src === undefined) { out.push(`${c}: a CHOKE POINT that does not exist`); continue; }
    if (!/\bdebugFileArgs\(/.test(src) || !/\bassertDebugLogClean\(/.test(src)) {
      out.push(`${c}: a CHOKE POINT must pass quaude a debug file (debugFileArgs) and judge it (assertDebugLogClean)`);
    }
  }
  return out;
}

// The guard (test/guard.cjs): examined is the number of files that run a quaude, floor 10 (2026-11-23: 21 of them), so
// a SPAWNS pattern that silently stopped matching reads BROKEN, not clean.
const CHOKE_STUB = 'debugFileArgs(f); assertDebugLogClean(x);';
guardTests(defineGuard({
  name: 'debug-log-gate-coverage',
  floor: 10,
  read() {
    const files = {};
    for (const rel of [...walk('test', []), ...walk('scripts', [])]) files[rel] = source(rel);
    return { files, exempt: EXEMPT };
  },
  scan({ files, exempt }) {
    const findings = Object.keys(exempt).filter((rel) => !(rel in files)).map((rel) => `EXEMPT names ${rel}, which is not in the tree`);
    findings.push(...coverageFindings(files, exempt));
    const examined = Object.entries(files).filter(([rel, src]) => !NOT_HARNESS.has(rel) && spawns(src)).length;
    return { findings, examined };
  },
  // a harness that runs a built quaude its own way and reads nothing, among ten that read
  control() {
    const files = { 'test/tool-driver.cjs': CHOKE_STUB, 'test/frame-oracle.cjs': CHOKE_STUB,
      'test/planted.test.cjs': 'const q = builtQuaude(); spawn(q.path, ["-p", "hi"]);' };
    for (let i = 0; i < 10; i++) files[`test/ok-${i}.test.cjs`] = 'const q = builtQuaude(); driveTool({ quaude: q.path });';
    return { files, exempt: {} };
  },
}));

// The control: each way round the rule is a finding (planted sources, the tree untouched).
test('the coverage rule fails a planted spawn that reads nothing, a stale exemption, and a choke point that stopped reading', () => {
  const choke = { 'test/tool-driver.cjs': CHOKE_STUB, 'test/frame-oracle.cjs': CHOKE_STUB };
  const plant = (src, extra = {}) => coverageFindings({ ...choke, 'test/x.test.cjs': src, ...extra }, { 'test/old.test.cjs': 'reason' });
  const stale = { 'test/old.test.cjs': 'const q = builtQuaude(); driveTool({ quaude: q.path });' };
  assert.deepStrictEqual(plant('const q = builtQuaude(); spawn(q.path, ["-p", "hi"]);', { 'test/old.test.cjs': 'builtQuaude()' }).length, 1);
  assert.deepStrictEqual(plant('spawn(tjs, ["run", LOADER, cli, "-p", "hi"]);', { 'test/old.test.cjs': 'builtQuaude()' }).length, 1);
  assert.deepStrictEqual(plant('runQuaudeModelAsync(cli, ["-p", "hi"]);', { 'test/old.test.cjs': 'builtQuaude()' }).length, 1);
  assert.deepStrictEqual(plant('const q = builtQuaude(); driveTool({ quaude: q.path });', { 'test/old.test.cjs': 'builtQuaude()' }), []);
  assert.deepStrictEqual(plant('runScanned(f, (d) => runQuaudeModelAsync(cli, ["-p", "hi", ...d]));', { 'test/old.test.cjs': 'builtQuaude()' }), []);
  assert.match(plant('', stale).join('\n'), /old\.test\.cjs: EXEMPT, but it now reads/);
  assert.match(plant('', { 'test/old.test.cjs': 'nothing' }).join('\n'), /old\.test\.cjs: EXEMPT, but it no longer runs/);
  assert.match(coverageFindings({ 'test/tool-driver.cjs': 'spawn(bin, args)', 'test/frame-oracle.cjs': choke['test/frame-oracle.cjs'] }, {}).join('\n'),
    /tool-driver\.cjs: a CHOKE POINT must pass/);
  // a comment naming a spawn is not one (the tree's sources are read comment-stripped)
  assert.deepStrictEqual(coverageFindings({ ...choke, 'test/y.test.cjs': stripComments('// builtQuaude() runs here\nconst a = 1;') }, {}), []);
});
