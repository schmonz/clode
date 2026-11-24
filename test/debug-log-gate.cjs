'use strict';
// THE DEBUG-LOG GATE: every run of a built quaude (or of the carve under tjs + node-shim) writes a --debug-file, and
// the log is held to test/debug-log-scan.cjs before the test may pass. The harness choke points call it, so a driver
// written tomorrow inherits it: test/tool-driver.cjs (every tool driver, -p and the interactive pty turn, and so the
// NetBSD/arm64 evidence lanes that run those drivers in the guest), test/frame-oracle.cjs (the interactive frame and
// session diffs); every other caller wraps its run in runScanned (the quaude-model runners of test/oracle-models.cjs
// included) or calls assertDebugLogClean itself; and test/fidelity/debug-log-errors.test.cjs (a -p turn) and
// debug-log-interactive.test.cjs (a pty session) exist for it. test/debug-log-gate-coverage.test.cjs fails
// on a file that spawns a quaude any other way without naming why.
//
// WHY. quaude's --debug log said, for weeks, `zlib.gzipSync not implemented`, `A bundled root does not parse: TypeError:
// not a function` (16 times a start), `timeout of 5000ms exceeded` on every redirect-following request, and `connect
// ETIMEDOUT`, while every visible turn still answered. A human read ONE live NetBSD log (2026-11-23) and found all four.
// The drivers ran quaude hundreds of times a day; nothing read what it logged.
//
// TWO MODES.
//   differential  a reference log of the same scenario exists (native Claude Code beside quaude in a tool driver, the
//                 reference side of a frame-oracle capture, naude beside quaude): debug-log-scan's three checks, all of
//                 them (shim faults; timeouts the reference lacks; [ERROR] shapes the reference lacks, less KNOWN).
//   absolute      no reference ran (NetBSD has no native; a CI suite row's minimised carve does not run): shim faults
//                 and every timeout shape, less KNOWN. The [ERROR] shapes are not judged without a reference (native
//                 logs some on every turn: a 401 from api.anthropic.com for the mock key, the lock-file ENOENT).
//
// THE NETWORK. 2.1.330 sends its bootstrap, fast-mode probe, MCP registry and event export to https://api.anthropic.com
// whatever ANTHROPIC_BASE_URL says, and nothing in the bundle moves them: BASE_API_URL comes from a config chosen by a
// function that returns "prod" on every build, CLAUDE_CODE_CUSTOM_OAUTH_URL is refused unless it is one of three
// Anthropic hosts, and CLAUDE_LOCAL_OAUTH_API_BASE is read only by the "local" config that "prod" never selects
// (measured in the 2.1.330 carve, 2026-11-23). Turning the traffic off (CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC) would
// also turn off the requests that found the Writable _final bug, so the gate keeps them and says where it depends on the
// host: in differential mode both sides meet the same network, so an unreachable host cancels out; in absolute mode a
// timeout is a finding only when api.anthropic.com:443 accepted a connection from this box (apiReachable), and the
// result carries a note saying the timeout rule was not applied when it did not.
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { findings, shape } = require('./debug-log-scan.cjs');

// KNOWN: the lines quaude may log that the rules would otherwise fail, [{ match, reason, example }]. `match` is tested
// against the line and against its shape (numbers folded to N, paths to <path>); `example` is a verbatim line it must
// match both ways (test/fidelity/debug-log-errors.test.cjs holds every entry to its example). Each is a RULED or
// FILED divergence, and its reason names where: the backlog item whose closing retires it. Adding one is a decision; never "noise".
const KNOWN = Object.freeze([
  { match: /\[uds-messaging\] Failed to create server: Error: quaude does not support the sandbox yet: net\.createServer/,
    reason: 'net.createServer is an honest throwing stub (USER ruling M1, 2026-11-18; test/shim-surface/golden.json, the '
      + 'http.request/net.createServer note; BACKLOG "`net.createServer` is a named throwing stub"): quaude serves no UDS '
      + 'messaging socket',
    example: '2026-11-23T13:29:30.313Z [ERROR] [uds-messaging] Failed to create server: Error: quaude does not support the sandbox yet: net.createServer' },
  { match: /is configured to go through the proxy .* but this client cannot tunnel TLS through a proxy/,
    reason: 'ERR_SHIM_HTTPS_PROXY_UNSUPPORTED, the honest refusal of an https origin through an HTTP(S)_PROXY (BACKLOG '
      + '"HTTP(S)_PROXY is silently ignored under quaude", its STILL OPEN half: the engine cannot start TLS on the CONNECT '
      + 'tunnel\'s socket). test/fidelity/webfetch.test.cjs routes every non-local request to a dead proxy on purpose, '
      + 'so its quaude turn logs this for api.anthropic.com where native logs a refused connection',
    example: '2026-11-24T02:15:29.995Z [ERROR] Failed to fetch MCP registry: node-shim: https://api.anthropic.com is configured to go through the proxy http://127.0.0.1:62215/, but this client cannot tunnel TLS through a proxy: a CONNECT tunnel needs TLS started over an existing socket' },
  { match: /[1N]P event logging: (?:\d+|N) events failed to export \(this runtime has no Bun\.FetchSession\)/,
    reason: 'the 1P exporter posts through Bun.FetchSession, which neither bun-shim nor naude provides (BACKLOG "1P event '
      + 'export never sends under quaude or naude: neither runtime has `Bun.FetchSession`"). naude logs it too, so a '
      + 'naude reference cancels it; native Bun sends, so against native it is quaude-only',
    example: '2026-11-23T13:25:21.281Z [ERROR] 1P event logging: 5 events failed to export (this runtime has no Bun.FetchSession)' },
  { match: /Failed to flush logs to Datadog: AxiosError: timeout of (?:\d+|N)ms exceeded/,
    reason: 'FOUND BY THIS GATE (2026-11-23), not yet root-caused: on a turn longer than ~15 s quaude\'s Datadog log '
      + 'flush (axios POST to http-intake.logs.us5.datadoghq.com) times out where native\'s, on the same turn, logs '
      + 'nothing (BACKLOG "quaude\'s Datadog log flush times out where native\'s does not"). KNOWN so the tool drivers '
      + 'stay a ratchet for everything else; closing the backlog item removes this entry',
    example: '2026-11-24T02:19:50.385Z [ERROR] Failed to flush logs to Datadog: AxiosError: timeout of 5000ms exceeded' },
  { match: /\[ERROR\] Failed to save config with lock: Error: ENOENT: no such file or directory, lstat '(?:[^']*\.claude\.json|<path>)'/,
    reason: 'the BUNDLE\'s first-run config race, on either runtime: naude logs it in one fresh home and not the next, '
      + 'so a differential read sees it on one side by chance (BACKLOG "The bundle\'s first-run config race logs `Failed '
      + 'to save config with lock: ... ENOENT` on either runtime"). Not a shim divergence',
    example: "2026-11-24T03:08:01.446Z [ERROR] Failed to save config with lock: Error: ENOENT: no such file or directory, lstat '/var/folders/y5/T/lockenoent-HnUhgE/quaude/.claude.json'" },
]);
const isKnown = (line, known) => known.some((k) => k.match.test(line) || k.match.test(shape(line)));

const DEBUG_LINE = /^\S+ \[(DEBUG|INFO|WARN|ERROR)\] /m;
// Flags, so they go BEFORE any `--` in the argv: after it they are prompt words, and the run writes no log (a case of
// test/fidelity/agentic-sandbox-fail-closed.test.cjs that ends `-- <prompt>` did exactly that; this gate said so).
const debugFileArgs = (file) => ['--debug-file', file];
function readLog(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

// Did api.anthropic.com:443 accept a TCP connection from this box? Asked once per process, in a child so a caller that
// is not async can ask it too. CLODE_DEBUG_LOG_NETWORK=reachable|unreachable answers it without asking (a test of the
// gate, or a box that knows).
let reach;
const PROBE = "const s=require('node:net').connect(443,'api.anthropic.com');s.setTimeout(5000);"
  + "s.on('connect',()=>process.exit(0));s.on('timeout',()=>process.exit(1));s.on('error',()=>process.exit(1));";
function apiReachable(env = process.env) {
  if (env.CLODE_DEBUG_LOG_NETWORK === 'reachable') return true;
  if (env.CLODE_DEBUG_LOG_NETWORK === 'unreachable') return false;
  if (reach === undefined) reach = spawnSync(process.execPath, ['-e', PROBE], { timeout: 10000, stdio: 'ignore' }).status === 0;
  return reach;
}

// judgeDebugLog({ label, quaude, reference, known, reachable }) -> { findings: [string], notes: [string], mode }
//   quaude     the subject's log text (null: it wrote none, itself a finding: the debug file was not honoured)
//   reference  the reference side's log text of the same scenario, or null/undefined when none ran
function judgeDebugLog({ label = 'quaude', quaude, reference, known = KNOWN, reachable } = {}) {
  const out = { findings: [], notes: [], mode: null };
  if (quaude == null) {
    out.findings.push(`${label} wrote no debug log (--debug-file not honoured, or it died first), so nothing it logged could be judged`);
    return out;
  }
  if (!DEBUG_LINE.test(quaude)) {
    out.findings.push(`${label}'s debug log holds no debug line (${quaude.length} bytes${quaude ? `, beginning ${JSON.stringify(quaude.slice(0, 200))}` : ''}), so nothing it logged could be judged`);
    return out;
  }
  if (reference != null && DEBUG_LINE.test(reference)) {
    out.mode = 'differential';
    const f = findings({ quaude, naude: reference });
    for (const l of f.shimFaults) if (!isKnown(l, known)) out.findings.push(`shim fault: ${l}`);
    for (const l of f.timeouts) if (!isKnown(l, known)) out.findings.push(`timeout the reference does not log: ${l}`);
    for (const s of f.newErrors) if (!isKnown(s, known)) out.findings.push(`[ERROR] shape the reference does not log (KNOWN does not name it): ${s}`);
    return out;
  }
  out.mode = 'absolute';
  out.notes.push(`${label}: no reference log for this scenario, so the absolute rules alone (shim faults, timeouts; KNOWN)`);
  const f = findings({ quaude, naude: '' });
  for (const l of f.shimFaults) if (!isKnown(l, known)) out.findings.push(`shim fault: ${l}`);
  const net = reachable === undefined ? apiReachable() : reachable;
  if (net) {
    for (const l of f.timeouts) if (!isKnown(l, known)) out.findings.push(`timeout: ${l}`);
  } else if (f.timeouts.length) {
    out.notes.push(`${label}: api.anthropic.com:443 is not reachable from this box, so ${f.timeouts.length} timeout line(s) `
      + 'were NOT judged (absolute mode has no reference to cancel the network out)');
  }
  return out;
}

// The judgement as a test failure: throws an Error naming every offending line, else returns the judgement.
function assertDebugLogClean(args) {
  const j = judgeDebugLog(args);
  if (j.findings.length) {
    const label = args.label || 'quaude';
    throw new Error(`${label}'s --debug log (${j.mode || 'unread'}) says what it must not `
      + '(test/debug-log-gate.cjs; the class: a shim failure the visible turn hides):\n  '
      + j.findings.join('\n  ') + (j.notes.length ? `\n${j.notes.join('\n')}` : ''));
  }
  return j;
}

// ONE quaude run, its log read and judged: run(extraArgs) spawns the subject with extraArgs (the --debug-file flags)
// appended to its argv and returns (or resolves to) its result; the log at `file` is then judged against
// opts.reference (a reference side's log text, or none) and removed. A finding throws; else the result is returned
// with .debugLog (the text) and .debugJudgement. Sync when run is.
function runScanned(file, run, opts = {}) {
  fs.rmSync(file, { force: true });
  const judge = (r) => {
    const log = readLog(file);
    fs.rmSync(file, { force: true });
    const j = assertDebugLogClean({ label: opts.label, quaude: log, reference: opts.reference });
    return Object.assign(r, { debugLog: log, debugJudgement: j });
  };
  const r = run(debugFileArgs(file));
  return r && typeof r.then === 'function' ? r.then(judge) : judge(r);
}
// A reference side's run, its log kept for the subject's judgement (never judged itself): -> result with .debugLog.
function runReference(file, run) {
  fs.rmSync(file, { force: true });
  const keep = (r) => { const log = readLog(file); fs.rmSync(file, { force: true }); return Object.assign(r, { debugLog: log }); };
  const r = run(debugFileArgs(file));
  return r && typeof r.then === 'function' ? r.then(keep) : keep(r);
}

module.exports = { KNOWN, isKnown, runScanned, runReference, DEBUG_LINE, debugFileArgs, readLog, apiReachable, judgeDebugLog, assertDebugLogClean };
