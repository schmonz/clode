'use strict';
// run-crashes: a test file whose PROCESS died (a signal: SIGSEGV, SIGABRT, SIGBUS, ...) is named, and what evidence
// exists is KEPT, outside the per-run root the runner removes at exit.
//
// WHY (2026-11-20): test/procfs-linux-only.test.cjs killed node with SIGSEGV twice in one day under a full suite's
// load and never alone (BACKLOG.md). The first time the forced-win32 pass deleted its TAP and only said "reported NO
// tests"; the second time the TAP said `signal: 'SIGSEGV'` and nothing else survived. A crash that cannot be repeated
// on demand has to leave its evidence the first time.
//
// WHAT IS KEPT, per crash, in <original temp>/clode-test-crashes/<when>-<runner pid>-<file>/ (a STABLE name,
// test/run-tmp.cjs: kept on purpose, never judged a leak):
//   - tap.txt: the file's `not ok` block from the TAP;
//   - every node diagnostic report the run wrote (the runner passes --report-on-fatalerror with --report-directory
//     under its root: a V8 fatal error, an OOM, an abort writes one; a bare SIGSEGV does not);
//     NOT A SIGSEGV: --report-on-fatalerror fires on V8/node fatal errors (OOM, a failed CHECK, an abort through
//     node's handler), not on a signal the kernel delivers, so a segfault leaves no node report anywhere. On Linux,
//     and so in CI, this keeps only tap.txt for one: no system crash reporter is read there, and a core needs
//     `ulimit -c unlimited` plus a core_pattern the runner does not have (ubuntu-latest pipes cores to apport;
//     BACKLOG.md says what capturing one in CI would take);
//   - on macOS, the system's crash report for each node that crashed since the pass began (ReportCrash writes
//     ~/Library/Logs/DiagnosticReports/node-*.ips, with the native stack, for any process that dies of a signal).
//     That is the only native stack on offer without a core dump, which for node is gigabytes and filled this disk
//     once already. It is READ from the real home (the suite's own HOME is a sandbox), never written.
const fs = require('node:fs');
const path = require('node:path');

const CRASHES_DIR = 'clode-test-crashes';

// The files whose process died of a signal, from a node --test TAP: [{ file, signal, block }].
function crashedFiles(tapText) {
  const out = [];
  const lines = String(tapText || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^not ok \d+ - (.+?)\s*$/.exec(lines[i]);
    if (!m) continue;
    const block = [lines[i]];
    let signal = null;
    for (let j = i + 1; j < lines.length && /^\s/.test(lines[j]); j++) {
      block.push(lines[j]);
      const s = /^\s+signal:\s*'?(SIG[A-Z0-9]+)'?\s*$/.exec(lines[j]);
      if (s) signal = s[1];
      if (/^\s+\.\.\.\s*$/.test(lines[j])) break;
    }
    if (signal) out.push({ file: m[1], signal, block: block.join('\n') });
  }
  return out;
}

// The macOS crash reports for node written at or after `since` (ms) under `home` (the REAL home, which test/run.mjs
// has from test/suite-home.cjs realHome): their paths, oldest first. [] elsewhere.
function systemCrashReports(since, { platform = process.platform, home = null } = {}) {
  if (platform !== 'darwin' || !home) return [];
  const dir = path.join(home, 'Library', 'Logs', 'DiagnosticReports');
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((n) => /^node[-_.].*\.(ips|crash)$/.test(n))
    .map((n) => path.join(dir, n))
    .filter((p) => { try { return fs.statSync(p).mtimeMs >= since; } catch { return false; } })
    .sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
}

// Keep the evidence of one pass's crashes. -> [{ file, signal, kept }] (kept: the directory, with what it holds).
function keepCrashes(tapText, { original, diagDir, since, home = null, pid = process.pid, now = new Date(), reports = (t) => systemCrashReports(t, { home }) } = {}) {
  const crashes = crashedFiles(tapText);
  if (!crashes.length) return [];
  const diag = (() => { try { return fs.readdirSync(diagDir).map((n) => path.join(diagDir, n)); } catch { return []; } })();
  const sys = reports(since);
  const when = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return crashes.map((c) => {
    const kept = path.join(original, CRASHES_DIR, `${when}-${pid}-${path.basename(c.file).replace(/[^A-Za-z0-9_.-]/g, '_')}`);
    fs.mkdirSync(kept, { recursive: true });
    fs.writeFileSync(path.join(kept, 'tap.txt'), `${c.block}\n`);
    for (const p of [...diag, ...sys]) { try { fs.copyFileSync(p, path.join(kept, path.basename(p))); } catch { /* gone */ } }
    return { file: c.file, signal: c.signal, kept, held: fs.readdirSync(kept).sort() };
  });
}

// The runner's lines for them.
function crashLines(kept) {
  return kept.map((k) => `run: CRASH: ${k.file} died of ${k.signal}; evidence kept in ${k.kept} (${k.held.join(', ')})`);
}

module.exports = { CRASHES_DIR, crashedFiles, systemCrashReports, keepCrashes, crashLines };
