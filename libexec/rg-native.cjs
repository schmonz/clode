'use strict';
// rg-native.cjs — quaude's rg. Every rg the bundle spawns is answered HERE, never by a
// host ripgrep.
//
// WHY QUAUDE HAS ITS OWN rg (memory rg-divergence-is-intentional, host-applets-config-is-
// foundational). rg is Rust and cannot run everywhere quaude does (NetBSD/sparc, Tiger PPC,
// Haiku); ugrep can. So quaude answers rg with ugrep, ON PURPOSE, and "install ripgrep" is
// never the remedy. Native Claude Code embeds its own rg; this module is what stands in for
// it, and the goal is native's answer byte for byte (test/fidelity/rg-differential.test.cjs
// judges exactly that, against native's embedded rg).
//
// SHAPE. bun-shim.cjs routes every spawn surface the bundle can reach rg through here
// (child_process execFile/execFileSync/spawn/spawnSync — node-shim's under quaude, node's
// under naude — and Bun.spawn/Bun.spawnSync), matching the executable by BASENAME (isRgExe),
// so `/opt/pkg/bin/rg` (what Bun.which answers when an rg is installed) and a bare `rg` are
// the same call. No rg process ever starts. The ASYNC surfaces get rgSpawn/rgExecFile: the
// applet quaude answers rg with runs as a real asynchronous child behind a child of node's
// shape, so the event loop keeps turning, the caller's stdin reaches it, and the caller's
// signal, kill(), timeout and maxBuffer end it. The SYNC surfaces get runRg (blocking, as
// theirs do in node) through rgSpawnSync/rgExecFileSync. A refusal is a child that started
// no process at all.
//
// FOR NOW both delegate to today's rg -> ugrep translation, which bun-shim owns and passes in
// (`translate`), and run the applet it names. The emulation proper replaces that delegation
// rule by rule, each rule measured from native. Its plumbing is here (ugrepMatches and
// ugrepMatchesAsync: an explicit file list in, rg's match byte ranges out, over a ugrep at or
// above UGREP_MIN); the walk, rg's printers, JSON Lines, binary rules, ignore rules, globs and
// types come next.
//
// Loaded by bun-shim.cjs as `require(__dirname + '/rg-native.cjs')`, so it travels beside
// bun-shim.cjs in every packaging (test/shim-companions.test.cjs). CommonJS under tjs and
// under node alike; it requires only node builtins.
const { EventEmitter } = require('events');
const { Readable } = require('stream');

// Is this executable rg? By BASENAME, never by the exact string `rg`: the bundle resolves
// rg as `Bun.which('rg') ?? 'rg'`, which is an absolute path whenever the host has an rg
// installed, and matching only `rg` let that host rg answer every Grep and Glob call
// (measured 2026-09-27, report-grep.md). On Windows Bun.which answers whichever PATHEXT
// spelling it found (`rg.exe`, or a `rg.cmd`/`rg.bat` shim a package manager installed), so
// every one of those is rg too, in any case.
function isRgExe(file) {
  if (typeof file !== 'string' || file === '') return false;
  return /^rg(?:\.(?:exe|com|bat|cmd))?$/i.test(leafOf(file));
}

// An executable's leaf name. ONE rule on every platform (test/windows-path-ratchet.test.cjs's
// slash-only-pathedness): a win32 path may be C:\x\rg.exe, a\rg or C:rg, so both separators
// and a drive prefix end the directory part everywhere. On a POSIX host that also reads a
// file literally named `a\rg` as rg, which only ever refuses more, never runs a host rg.
function leafOf(file) {
  return String(file).split(/[\\/]/).pop().replace(/^[A-Za-z]:/, '');
}

// THE HONEST REFUSAL: a failed child, rc 2, nothing on stdout, the flag and the reason on
// stderr. Used whenever quaude's rg cannot give native's answer; it never falls through to a
// host rg and never tells anyone to install ripgrep.
//
// THE SPELLING IS LOAD-BEARING. `rg: error parsing flag <flag>: <reason>` is native rg's own
// spelling of a usage error (2.1.283's embedded ripgrep 14.1.1 prints `rg: error parsing flag
// --max-columns: value is not a valid number: ...`), and it is one of the five spellings
// upstream's Grep/Glob consumer shows the model as an error ("Search failed ... ripgrep
// rejected the pattern, glob, or file type without searching:" plus this stderr; `oX` and its
// usage-error regex `TQ` in 2.1.283's chunk-9yjanq6m.js). Every other rc 2 with no output,
// that consumer reads as "no results", which is exactly the silent wrong answer ("No files
// found") this replaces. test/build-gates/rg-probe-gates.test.cjs reads that regex from the
// pinned carve, by structure, and requires this spelling to pass it.
//
// REFUSAL_LINE is this spelling, stated ONCE: rgRefusal writes it and parseRgRefusal reads it
// back (the tests and the differential's tally read refusals only through it).
const REFUSAL_LINE = /^rg: error parsing flag(?: (\S+))?: (.*)$/m;
function rgRefusal(reason, { flag } = {}) {
  const line = `rg: error parsing flag${flag ? ' ' + flag : ''}: ${reason}\n`;
  return { stdout: Buffer.alloc(0), stderr: Buffer.from(line, 'utf8'), status: 2, signal: null, refused: reason };
}
// A refusal of quaude's rg in some text (its stderr, or a tool_result quoting it):
// { flag, reason }, flag null when the refusal names none; null when the text holds none.
// Only quaude's own reasons count: native's real usage errors share the prefix.
function parseRgRefusal(text) {
  const m = REFUSAL_LINE.exec(String(text == null ? '' : text));
  return m && /quaude answers rg/.test(m[2]) ? { flag: m[1] || null, reason: m[2] } : null;
}

// Output a synthesized child may hold. rg's own output has no limit; this bounds what a sync
// run may buffer when the caller named none (execFile names its maxBuffer, 20 MB in 2.1.283).
const RG_MAX_BUFFER = 256 * 1024 * 1024;

const toBuf = (b) => (b == null ? Buffer.alloc(0) : Buffer.isBuffer(b) ? b : Buffer.from(b));
const firstLine = (buf) => toBuf(buf).toString('utf8').split('\n').map((l) => l.trim()).find(Boolean) || '';

// What an applet run comes to when the applet could not be run at all (ENOENT, EACCES, ...):
// a refusal naming the applet, never a fall-through to anything else.
function couldNotRun(bin, e) {
  return rgRefusal(`${leafOf(bin)}, which quaude answers rg with on purpose, could not be run `
    + `(${(e && (e.code || e.message)) || 'unknown error'}); nothing was searched`);
}

// What an applet that exited >= 2 having printed NOTHING comes to: it rejected the translated
// search, so quaude's rg refuses, naming what the applet said. `onRejected(argv, status)` lets
// the caller surface it to the operator as well.
function appletRejected(bin, status, stderr) {
  const said = firstLine(stderr);
  return rgRefusal(`${leafOf(bin)}, which quaude answers rg with on purpose, rejected this search`
    + `${said ? ` (${said})` : ` (exit ${status})`}; nothing was found`);
}

// THE SYNCHRONOUS RUN, for the synchronous surfaces only (spawnSync, execFileSync): they block
// their caller by contract, as node's do. Every other surface runs the applet asynchronously
// (rgSpawn below), so the event loop keeps turning and the caller's bounds can end the search.
//
// argv: rg's arguments (no argv[0]). opts:
//   cwd, env              where and with what the search runs (env defaults to process.env)
//   input                 what the caller hands the child's stdin (rg reads it for target `-`)
//   timeout, maxBuffer,   the caller's own bounds, when it named them
//   killSignal
//   translate(argv)       -> { argv: [applet, ...] } or { refuse, flag } — today's translation
//   spawnSync             the UNWRAPPED spawnSync to run the applet with
//   onRejected(argv, st)  told when the applet rejected the translation
// Returns { stdout, stderr, status, signal }, plus `refused` for a refusal and `errorCode` when
// a bound fired (node's spawnSync reports ETIMEDOUT / ENOBUFS; node-shim's ETIMEDOUT for both).
function runRg(argv, opts = {}) {
  const t = opts.translate(argv);
  if (t.refuse) return rgRefusal(t.refuse, { flag: t.flag });
  const [bin, ...rest] = t.argv;
  const r = opts.spawnSync(bin, rest, {
    cwd: opts.cwd, env: opts.env || process.env, encoding: 'buffer',
    // Bytes, always: the run itself is encoding 'buffer', which node will not decode a string with.
    input: typeof opts.input === 'string' ? Buffer.from(opts.input, 'utf8') : opts.input,
    killSignal: opts.killSignal,
    timeout: typeof opts.timeout === 'number' && opts.timeout > 0 ? opts.timeout : undefined,
    maxBuffer: typeof opts.maxBuffer === 'number' ? opts.maxBuffer : RG_MAX_BUFFER,
  });
  const stdout = toBuf(r.stdout), stderr = toBuf(r.stderr);
  const code = r.error && r.error.code;
  // A bound fired: the caller's own timeout or maxBuffer killed the run, which is what it would
  // see from rg too, so it is reported the way node reports it, not as a refusal.
  if (code === 'ETIMEDOUT' || code === 'ENOBUFS') {
    return { stdout, stderr, status: null, signal: r.signal || opts.killSignal || 'SIGTERM', errorCode: code };
  }
  if (r.error) return couldNotRun(bin, r.error);
  if (r.status >= 2 && stdout.length === 0) {
    if (opts.onRejected) opts.onRejected(t.argv, r.status);
    return appletRejected(bin, r.status, stderr);
  }
  return { stdout, stderr, status: r.status, signal: r.signal || null };
}

// ---- ugrep: the files in, rg's match byte ranges out --------------------------------------
// THE PLUMBING THE EMULATION STANDS ON (grep-native Task 5). ugrep is the search engine; quaude
// decides WHICH files are searched (the walk, rg's ignore and glob rules) and hands ugrep that
// explicit list, and ugrep answers WHERE each match is: byte offsets into the file, binaries
// searched as text. The printers re-derive everything rg prints (lines, line numbers, context,
// JSON, binary quit and convert) from those ranges and the file bytes.
//
// MEASURED (2026-10-03) on ugrep 7.8.2 (this Mac and NetBSD 11 pkgsrc), 5.0.0 (Ubuntu noble's
// apt, which CI installs) and 3.11.2 (Debian bookworm's apt), and every range cross-checked
// against native's embedded rg --json submatches on the fixture tree (test/rg-native.test.cjs):
//   (no flag)           binaries (a NUL, early or past 64 KiB; invalid UTF-8) are searched as
//                       text: under --format ugrep reports their matches like any file's, and
//                       -a changed nothing on any version or file measured, so it is not
//                       passed. rg's binary quit and convert rules are the printers' (Task 8)
//   -Y                  empty matches are reported (without it ugrep drops them, and a pattern
//                       like `e*` matches every line in rg but only some in ugrep)
//   -H --null %F        `path\0`, so ANY path is unambiguous (a newline in a name included)
//   %b %e %~            the match's byte offsets from the start of the file, then a newline
//                       (LF here; ugrep's help says "LF or CRLF", unmeasured on Windows, so
//                       the parser takes either)
// On the plumbing's probes (literals, several matches per line, CRLF, NUL, invalid UTF-8, empty
// matches) all three versions give byte-identical output. Their REGEX DIALECTS differ (from rg's
// and from each other: alternation, \b on UTF-8, [[:alpha:]]; BACKLOG), which is a matter for the
// pattern, not for this plumbing. The FLOOR is 5.0.0: 3.11.2
// exits 0 on an unreadable file (5.0.0 and 7.8.2 exit 2), so a failed search could pass for a
// clean one. ugrep 7's `--from=FILE` and `%[0]U` are absent before it, so the file list is argv
// (in chunks) and the NUL comes from --null: one way, every version at or above the floor.
const UGREP_MIN = '5.0.0';
const UGREP_RANGE_FORMAT = '--format=%F%b %e%~';
// A command line's worth of file names. Windows caps the WHOLE command line at 32,767
// characters; half of that leaves room for quoting and the fixed arguments.
const ARGV_BUDGET = 16 * 1024;

function parseUgrepVersion(text) {
  const m = /^ugrep (\d+)\.(\d+)\.(\d+)\b/m.exec(String(text == null ? '' : text));
  return m ? `${+m[1]}.${+m[2]}.${+m[3]}` : null;
}
function versionAtLeast(v, min) {
  const a = String(v).split('.').map(Number), b = String(min).split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return true;
}

// What this ugrep can do for quaude's rg: { bin, version, format, reason }. `format` is true
// when the version is at or above the measured floor; `reason` says why not, for an honest
// refusal. One `--version` run per binary per process.
const _ugrepCaps = new Map();
function ugrepCapabilities(bin, opts = {}) {
  if (_ugrepCaps.has(bin)) return _ugrepCaps.get(bin);
  const spawnSync = opts.spawnSync || require('child_process').spawnSync;
  let r;
  try { r = spawnSync(bin, ['--version'], { encoding: 'buffer', timeout: 30000 }); } catch (e) { r = { error: e }; }
  const version = r && !r.error ? parseUgrepVersion(toBuf(r.stdout).toString('utf8')) : null;
  const format = !!version && versionAtLeast(version, UGREP_MIN);
  const reason = format ? null
    : version ? `ugrep ${version} is older than ${UGREP_MIN}, the oldest ugrep quaude's rg is measured against`
      : `${leafOf(bin)} did not answer as ugrep (${(r && r.error && (r.error.code || r.error.message)) || `exit ${r && r.status}`})`;
  const caps = { bin, version, format, reason };
  _ugrepCaps.set(bin, caps);
  return caps;
}

// ugrep's argv for a match-range search, before the files.
function ugrepMatchArgv(pattern, opts = {}) {
  return ['-Y', '-H', '--null', UGREP_RANGE_FORMAT, ...(opts.ignoreCase ? ['-i'] : []), '-e', pattern, '--'];
}

// A name ugrep could read as an option or as stdin (`-`, `-x`) goes in as `./-`, `./-x`: every
// name ugrepMatches is given is a FILE. rg's POSITIONAL `-` means stdin, not a file named `-`;
// the emulation answers that in its stdin branch and must never pass it in here.
const spellForUgrep = (f) => (f.startsWith('-') ? './' + f : f);

// Files, greedily, into lists whose names (plus a separator each) fit `budget` bytes; a name
// longer than the budget gets a list of its own.
function chunkFiles(files, budget = ARGV_BUDGET) {
  const out = [];
  let cur = [], size = 0;
  for (const f of files) {
    const n = Buffer.byteLength(f) + 1;
    if (cur.length && size + n > budget) { out.push(cur); cur = []; size = 0; }
    cur.push(f); size += n;
  }
  if (cur.length) out.push(cur);
  return out;
}

// ugrep gave no usable answer: it exited >= 2, died of a signal, could not be run, or printed
// something that is not the records asked for. Never "no matches". It carries what ugrep said
// and the matches it found before failing; ONE type, so a caller handles every way the search
// can fail the same way.
class UgrepError extends Error {
  constructor(message, { status = null, signal = null, stderr = '', matches = new Map() } = {}) {
    super(message);
    this.name = 'UgrepError';
    Object.assign(this, { status, signal, stderr, matches });
  }
}

// ugrep's `path\0start end\n` records into Map<path, [{start, end}]>, in one pass.
// RG-EMPTY-AFTER-MATCH: rg (Rust regex's find_iter) never reports an empty match at the end of
// the match before it; ugrep -Y does (`e*` on "needle": rg 1-1 2-3 4-4, ugrep 1-1 2-3 3-3 4-4),
// so such a match is dropped here. Measured against native on text, CRLF and a file with no
// final newline.
function parseUgrepRanges(buf, into = new Map()) {
  const lastEnd = new Map();
  const bad = (at) => { throw new UgrepError(`rg-native: ugrep's --format output is not path NUL start SP end LF at byte ${at}`, { matches: into }); };
  const num = (j) => {
    let v = 0;
    const from = j;
    for (let d; j < buf.length && (d = buf[j]) >= 0x30 && d <= 0x39; j++) v = v * 10 + (d - 0x30);
    return j === from ? bad(from) : [v, j];
  };
  let i = 0;
  while (i < buf.length) {
    const z = buf.indexOf(0, i);
    if (z === -1) bad(i);
    const file = buf.toString('utf8', i, z);
    let [start, j] = num(z + 1);
    if (buf[j] !== 0x20) bad(j);
    let end;
    [end, j] = num(j + 1);
    if (buf[j] === 0x0d) j++;
    if (buf[j] !== 0x0a) bad(j);
    i = j + 1;
    if (start === end && lastEnd.get(file) === end) continue;
    lastEnd.set(file, end);
    let list = into.get(file);
    if (!list) { list = []; into.set(file, list); }
    list.push({ start, end });
  }
  return into;
}

// The plan both twins share: each distinct file once, spelled for ugrep, in chunks; and how to
// read the ranges back in the caller's order (a file without a match has no entry).
function matchPlan(files, pattern, opts) {
  // A directory is searched as NOTHING (ugrep exits 0 on one without -r): the walk lists files,
  // so a directory here is the caller's mistake, refused rather than answered "no matches".
  const fs = require('fs'), path = require('path');
  for (const f of files) {
    let st = null;
    try { st = fs.statSync(path.resolve(opts.cwd || process.cwd(), f)); } catch { /* a missing file is ugrep's to report */ }
    if (st && st.isDirectory()) throw new UgrepError(`rg-native: ${f} is a directory; ugrepMatches searches files only`);
  }
  const spelled = [...new Set(files.map(spellForUgrep))];
  const asked = new Set(spelled);
  const argv = ugrepMatchArgv(pattern, opts);
  const chunks = chunkFiles(spelled, opts.argvBudget || ARGV_BUDGET).map((c) => [...argv, ...c]);
  // Every path ugrep reported must be one it was asked about; a match it places anywhere else
  // cannot be answered for, so it is refused, never dropped.
  const onlyAsked = (ranges) => {
    for (const k of ranges.keys()) {
      if (!asked.has(k)) throw new UgrepError(`rg-native: ugrep reported a match in ${JSON.stringify(k)}, which it was not asked for`);
    }
  };
  const inOrder = (ranges) => {
    const out = new Map();
    for (const f of files) {
      const got = ranges.get(spellForUgrep(f));
      if (got && !out.has(f)) out.set(f, got.slice());
    }
    return out;
  };
  return { chunks, inOrder, onlyAsked };
}
// The floor, ENFORCED: a ugrep below UGREP_MIN (or no ugrep at all) is refused before it runs,
// never asked: 3.11.2 answers a missing file with exit 0 and nothing printed, "no matches".
function assertUsableUgrep(opts) {
  const caps = ugrepCapabilities(opts.ugrep, { spawnSync: opts.spawnSync });
  if (!caps.format) throw new UgrepError(caps.reason);
}
// What a chunk that exited >= 2 printed: the records before any bad byte are its partial
// matches; a bad tail is dropped, because the failure (status, stderr) is already the answer.
function readFailedChunk(buf, ranges) {
  try { parseUgrepRanges(buf, ranges); } catch (e) { if (!(e instanceof UgrepError)) throw e; }
}
const ugrepFailed = (bin, r, stderr, matches) => new UgrepError(
  `${leafOf(bin)} failed (${r.signal ? `signal ${r.signal}` : `exit ${r.status}`})${firstLine(stderr) ? `: ${firstLine(stderr)}` : ''}`,
  { status: r.status, signal: r.signal || null, stderr: toBuf(stderr).toString('utf8'), matches });

// ugrepMatches(files, pattern, opts) -> Map<file, [{start, end}]>: where `pattern` matches in
// each of `files` (relative to opts.cwd, or absolute), as rg's submatches would place them.
// opts: ugrep (the binary), cwd, env, ignoreCase, spawnSync (the UNWRAPPED one, under
// bun-shim), argvBudget. Throws UgrepError when ugrep fails or is below UGREP_MIN. Synchronous: for the synchronous
// rg surfaces; ugrepMatchesAsync is the same search for the asynchronous ones.
function ugrepMatches(files, pattern, opts = {}) {
  if (!files.length) return new Map();
  assertUsableUgrep(opts);
  const spawnSync = opts.spawnSync || require('child_process').spawnSync;
  const { chunks, inOrder, onlyAsked } = matchPlan(files, pattern, opts);
  const ranges = new Map();
  let failed = null;
  for (const argv of chunks) {
    const r = spawnSync(opts.ugrep, argv, { cwd: opts.cwd, env: opts.env || process.env, encoding: 'buffer', maxBuffer: RG_MAX_BUFFER });
    if (r.error) throw new UgrepError(`${leafOf(opts.ugrep)} could not be run (${r.error.code || r.error.message})`, { matches: inOrder(ranges) });
    // Killed: the bytes may stop anywhere, so they are not read; the kill is the answer.
    if (r.status === null || r.signal) { failed = { r, stderr: r.stderr }; break; }
    // A failed chunk ends the search: the answer is already an error, so no later chunk runs.
    // Its status comes first: what it printed is read only for the matches it found before
    // failing, and a bad tail there says nothing the failure does not (re-review N-1).
    if (r.status >= 2) { readFailedChunk(toBuf(r.stdout), ranges); failed = { r, stderr: r.stderr }; break; }
    parseUgrepRanges(toBuf(r.stdout), ranges);
  }
  const out = inOrder(ranges);
  if (failed) throw ugrepFailed(opts.ugrep, failed.r, failed.stderr, out);
  onlyAsked(ranges);
  return out;
}

// The asynchronous twin: a Promise of the same Map, the chunks run one after another as real
// children. opts.spawn is the UNWRAPPED spawn; opts.onChild(child) is told of each child, so the
// caller can end the search (kill) when its own bounds fire.
function ugrepMatchesAsync(files, pattern, opts = {}) {
  if (!files.length) return Promise.resolve(new Map());
  // The floor check runs ugrep --version synchronously, ONCE per binary per process (cached).
  let plan;
  try { assertUsableUgrep(opts); plan = matchPlan(files, pattern, opts); } catch (e) { return Promise.reject(e); }
  const spawn = opts.spawn || require('child_process').spawn;
  const { chunks, inOrder, onlyAsked } = plan;
  const ranges = new Map();
  const runOne = (argv) => new Promise((resolve, reject) => {
    let child;
    try { child = spawn(opts.ugrep, argv, { cwd: opts.cwd, env: opts.env || process.env, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { reject(new UgrepError(`${leafOf(opts.ugrep)} could not be run (${e.code || e.message})`, { matches: inOrder(ranges) })); return; }
    if (opts.onChild) opts.onChild(child);
    const outs = [], errs = [];
    let settled = false;
    child.stdout.on('data', (d) => outs.push(toBuf(d)));
    child.stderr.on('data', (d) => errs.push(toBuf(d)));
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      reject(new UgrepError(`${leafOf(opts.ugrep)} could not be run (${e.code || e.message})`, { matches: inOrder(ranges) }));
    });
    child.on('close', (status, signal) => {
      if (settled) return;
      settled = true;
      // Killed: the bytes may stop anywhere, so they are not read; the kill is the answer.
      // Exit >= 2: the failure is the answer, and the bytes only add the matches found first.
      if (status !== null && !signal) {
        if (status >= 2) readFailedChunk(Buffer.concat(outs), ranges);
        else { try { parseUgrepRanges(Buffer.concat(outs), ranges); } catch (e) { reject(e); return; } }
      }
      resolve({ status, signal: signal || null, stderr: Buffer.concat(errs) });
    });
  });
  return (async () => {
    let failed = null;
    for (const argv of chunks) {
      const r = await runOne(argv);
      // A failed chunk (killed by the caller, or exit >= 2) ends the search: no later chunk runs.
      if (r.status === null || r.status >= 2) { failed = r; break; }
    }
    const out = inOrder(ranges);
    if (failed) throw ugrepFailed(opts.ugrep, failed, failed.stderr, out);
    onlyAsked(ranges);
    return out;
  })();
}

// ---- the children the async surfaces get ----------------------------------------------------
// node's stdio slots: 'pipe' (the default) gets a stream; anything else does not.
function stdioSlots(opts) {
  const s = opts && opts.stdio;
  const one = (i) => (Array.isArray(s) ? (s[i] === undefined || s[i] === null ? 'pipe' : s[i]) : (s || 'pipe'));
  return [one(0), one(1), one(2)];
}
function abortError(signal) {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError'; e.code = 'ABORT_ERR';
  if (signal && signal.reason !== undefined) e.cause = signal.reason;
  return e;
}
function endedWritable() {
  const w = new EventEmitter();
  w.writable = false; w.destroyed = false;
  w.write = () => false;
  w.end = (chunk, enc, cb) => {
    const f = [chunk, enc, cb].find((x) => typeof x === 'function');
    if (f) queueMicrotask(f);
    return w;
  };
  w.destroy = () => { w.destroyed = true; return w; };
  w.cork = () => {}; w.uncork = () => {}; w.setDefaultEncoding = () => w;
  return w;
}
const toFd = (fd, buf) => { if (buf.length) { try { (fd === 1 ? process.stdout : process.stderr).write(buf); } catch { /* closed */ } } };

// The child shape both kinds share: streams per slot, kill, and the bounds node's spawn honours
// (`signal`: an 'error' carrying an AbortError, then the kill; `timeout`: the kill). `kill(sig)`
// is how each kind ends its run. finish({ status, signal, stderr }) ends the child: the
// streams end, then 'exit', then 'close' — the order a real child's listeners rely on.
function childShell(opts, kill) {
  const [, outSlot, errSlot] = stdioSlots(opts);
  const child = new EventEmitter();
  child.stdout = outSlot === 'pipe' ? new Readable({ read() {} }) : null;
  child.stderr = errSlot === 'pipe' ? new Readable({ read() {} }) : null;
  child.exitCode = null; child.signalCode = null; child.killed = false;
  let done = false, timer = null, unlisten = null;
  // killed only when the signal was delivered, as node sets it: a kill() after the applet
  // exited (before its 'close') delivers nothing, and must not suppress the rc-2 refusal.
  child.kill = (sig) => {
    if (done) return false;
    const delivered = !!kill(sig || 'SIGTERM');
    if (delivered) child.killed = true;
    return delivered;
  };
  child.ref = () => child; child.unref = () => child;
  const out = (buf) => { if (child.stdout) { if (buf.length) child.stdout.push(buf); } else if (outSlot === 'inherit') toFd(1, buf); };
  const finish = ({ status, signal, stderr }) => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    // node's spawn takes its 'abort' listener off when the child ends. The 2.1.283 Grep tool
    // hands every rg the SAME tool-context signal, so one left behind per search (holding its
    // child and the stdout it buffered) would grow with every search of a session.
    if (unlisten) { unlisten(); unlisten = null; }
    if (child.stdout) child.stdout.push(null);
    const err = toBuf(stderr);
    if (child.stderr) { if (err.length) child.stderr.push(err); child.stderr.push(null); } else if (errSlot === 'inherit') toFd(2, err);
    child.exitCode = status; child.signalCode = signal || null;
    child.emit('exit', status, signal || null);
    setTimeout(() => child.emit('close', status, signal || null), 0);
  };
  const killSignal = opts.killSignal || 'SIGTERM';
  if (typeof opts.timeout === 'number' && opts.timeout > 0) timer = setTimeout(() => child.kill(killSignal), opts.timeout);
  const signal = opts.signal;
  if (signal) {
    const onAbort = () => { if (done) return; child.kill(killSignal); child.emit('error', abortError(signal)); };
    if (signal.aborted) process.nextTick(onAbort);
    else {
      signal.addEventListener('abort', onAbort, { once: true });
      unlisten = () => signal.removeEventListener('abort', onAbort);
    }
  }
  return { child, out, finish, isDone: () => done };
}

// A child that never started a process: a refusal, answered on the next turn of the loop (the
// caller attaches its listeners first, as with a real child). Killed or aborted first, it ends
// with that signal instead.
function refusedChild(r, opts) {
  let killedWith = null, sh = null;
  sh = childShell(opts, (sig) => { killedWith = sig; setTimeout(() => sh.finish({ status: null, signal: sig, stderr: null }), 0); return true; });
  const { child } = sh;
  child.pid = undefined;                    // no process was started
  child.stdin = stdioSlots(opts)[0] === 'pipe' ? endedWritable() : null;
  setTimeout(() => {
    if (sh.isDone()) return;
    child.emit('spawn');
    if (killedWith) return;
    sh.out(toBuf(r.stdout));
    sh.finish(r);
  }, 0);
  return child;
}

// child_process.spawn (and Bun.spawn, which bun-shim builds on it): the applet runs as a REAL
// asynchronous child, with the caller's stdin wired straight to it (the bundle pipes a
// task-output file into rg's stdin for target `-`). Its stdout streams through as it arrives; its
// stderr is held until it exits, because an applet that exits >= 2 having printed nothing has
// rejected the translation and its stderr becomes quaude's refusal. ctx:
//   translate(argv)       today's translation (see runRg)
//   spawn                 the UNWRAPPED asynchronous spawn
//   onRejected(argv, st)  told when the applet rejected the translation
function rgSpawn(argv, opts = {}, ctx) {
  const t = ctx.translate(argv);
  if (t.refuse) return refusedChild(rgRefusal(t.refuse, { flag: t.flag }), opts);
  const [bin, ...rest] = t.argv;
  const inSlot = stdioSlots(opts)[0];
  let applet;
  try {
    applet = ctx.spawn(bin, rest, { cwd: opts.cwd, env: opts.env || process.env, windowsHide: opts.windowsHide,
      stdio: [inSlot === 'pipe' ? 'pipe' : inSlot, 'pipe', 'pipe'] });
  } catch (e) { return refusedChild(couldNotRun(bin, e), opts); }
  const sh = childShell(opts, (sig) => { try { return applet.kill(sig); } catch { return false; } });
  const { child } = sh;
  child.pid = applet.pid;
  child.stdin = applet.stdin || null;
  if (child.stdin) child.stdin.on('error', () => {});   // a search that ends early closes its stdin
  let printed = 0;
  const errs = [];
  applet.stdout.on('data', (d) => { printed += d.length; sh.out(toBuf(d)); });
  applet.stderr.on('data', (d) => { errs.push(toBuf(d)); });
  applet.on('spawn', () => { child.pid = applet.pid; child.emit('spawn'); });
  applet.on('error', (e) => { if (!sh.isDone() && !child.killed) { const r = couldNotRun(bin, e); sh.finish(r); } });
  applet.on('close', (code, signal) => {
    const stderr = Buffer.concat(errs);
    if (code >= 2 && printed === 0 && !child.killed) {
      if (ctx.onRejected) ctx.onRejected(t.argv, code);
      sh.finish(appletRejected(bin, code, stderr));
      return;
    }
    sh.finish({ status: code, signal, stderr });
  });
  return child;
}

// child_process.execFile: the child, plus (err, stdout, stderr) once it closes, with node's
// fields: an AbortError for an abort; for the maxBuffer bound (node's default 1 MiB), the child
// killed and ERR_CHILD_PROCESS_STDIO_MAXBUFFER, which the 2.1.283 Grep/Glob consumer reads as
// "output passed the limit" (a plain kill it reads as "timed out"); otherwise code, or
// killed + signal, and cmd.
function rgExecFile(argv, opts, cb, file, ctx) {
  const o = opts || {};
  const enc = o.encoding === undefined ? 'utf8' : o.encoding;
  const conv = (b) => (enc === 'buffer' || enc === null ? b : b.toString(enc));
  const maxBuffer = typeof o.maxBuffer === 'number' ? o.maxBuffer : 1024 * 1024;
  const child = rgSpawn(argv, { ...o, stdio: 'pipe' }, ctx);
  const outs = [], errs = [];
  let outLen = 0, errLen = 0, overflow = null, aborted = null;
  child.stdout.on('data', (d) => {
    outLen += d.length; outs.push(d);
    if (outLen > maxBuffer && !overflow) { overflow = 'stdout'; child.kill(o.killSignal || 'SIGTERM'); }
  });
  child.stderr.on('data', (d) => {
    errLen += d.length; errs.push(d);
    if (errLen > maxBuffer && !overflow) { overflow = 'stderr'; child.kill(o.killSignal || 'SIGTERM'); }
  });
  child.on('error', (e) => { aborted = e; });
  child.on('close', (code, signal) => {
    if (typeof cb !== 'function') return;
    const so = Buffer.concat(outs).subarray(0, maxBuffer), se = Buffer.concat(errs).subarray(0, maxBuffer);
    const stdout = conv(so), stderr = conv(se);
    if (aborted) { cb(aborted, stdout, stderr); return; }
    const cmd = [file, ...argv].join(' ');
    if (overflow) {
      const e = new RangeError(`${overflow} maxBuffer length exceeded`);
      e.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'; e.cmd = cmd;
      cb(e, stdout, stderr); return;
    }
    if (code === 0) { cb(null, stdout, stderr); return; }
    const err = new Error(`Command failed: ${cmd}\n${se.toString('utf8')}`);
    err.code = code; err.killed = child.killed && signal != null; err.signal = signal; err.cmd = cmd;
    cb(err, stdout, stderr);
  });
  return child;
}

// child_process.spawnSync, node's result shape.
function rgSpawnSync(r, opts = {}) {
  const enc = opts.encoding;
  const conv = (b) => ((enc && enc !== 'buffer') ? toBuf(b).toString(enc) : toBuf(b));
  const [, outSlot, errSlot] = stdioSlots(opts);
  const slot = (s, b, fd) => {
    if (s === 'pipe') return conv(b);
    if (s === 'inherit') toFd(fd, toBuf(b));
    return null;
  };
  const stdout = slot(outSlot, r.stdout, 1), stderr = slot(errSlot, r.stderr, 2);
  const out = { pid: 0, output: [null, stdout, stderr], stdout, stderr, status: r.status, signal: r.signal || null };
  if (r.errorCode) out.error = Object.assign(new Error(`spawnSync rg ${r.errorCode}`), { code: r.errorCode, errno: r.errorCode, syscall: 'spawnSync rg' });
  return out;
}

// child_process.execFileSync: stdout, or a throw carrying node's fields.
function rgExecFileSync(r, opts, file, args) {
  const s = rgSpawnSync(r, opts || {});
  if (s.error) throw s.error;
  if (s.status !== 0) {
    const cmd = [file, ...(args || [])].join(' ');
    const e = new Error(`Command failed: ${cmd}\n${toBuf(r.stderr).toString('utf8')}`);
    Object.assign(e, { status: s.status, signal: s.signal, stdout: s.stdout, stderr: s.stderr, output: s.output, pid: 0 });
    throw e;
  }
  return s.stdout;
}

module.exports = { isRgExe, rgRefusal, parseRgRefusal, runRg, rgSpawn, rgExecFile, rgSpawnSync, rgExecFileSync, RG_MAX_BUFFER,
  UGREP_MIN, parseUgrepVersion, versionAtLeast, ugrepCapabilities, ugrepMatchArgv, chunkFiles, parseUgrepRanges,
  ugrepMatches, ugrepMatchesAsync, UgrepError };
