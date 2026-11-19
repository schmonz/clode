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
// A SEARCH (rg's standard printer, -l, -c, --json) is answered here, rule by rule as native answers
// it (grep-native Tasks 6 and 7, "quaude's rg answers a search itself" below): the plumbing
// (ugrepMatches and ugrepMatchesAsync: an explicit file list in, rg's match byte ranges out, over a
// ugrep at or above UGREP_MIN, UGREP PROPOSING candidate lines and rg-regex.cjs's matcher DECIDING
// them) and rg's printers over rg's own text. A directory is WALKED as rg walks it, in JS (rg-walk.cjs:
// rg's ignore rules, glob dialect, --type and order; grep-native Task 9), and ugrep searches the files it
// lists; --version and --type-list are answered from rg-types.cjs, generated from native; -U searches with
// rg's multi-line searcher, and --files lists what rg's walk reaches (grep-native Task 10). NOTHING goes to
// the old rg -> ugrep translation any more: what quaude's rg cannot answer as native does, it refuses by name.
//
// Loaded by bun-shim.cjs as `require(__dirname + '/rg-native.cjs')`, so it travels beside
// bun-shim.cjs in every packaging (test/shim-companions.test.cjs), with its own companion
// rg-regex.cjs. CommonJS under tjs and under node alike; beyond that companion it requires only
// node builtins.
const { EventEmitter } = require('events');
const { Readable } = require('stream');
// rg's regex dialect, decided in JS (grep-native Task 5b): this module's own companion, required
// the same way bun-shim.cjs requires this one, so it travels beside it (test/shim-companions
// .test.cjs). Loaded on the first search, not at startup: every quaude loads this module, and
// most sessions search nothing.
let _rgRegex = null;
const rgRegexModule = () => _rgRegex || (_rgRegex = require(__dirname + '/rg-regex.cjs'));
// rg's walk (rg-walk.cjs) and its type table and version text (rg-types.cjs, generated from native): this
// module's companions too (grep-native Task 9), required the same way, on first use.
let _rgWalk = null, _rgTypes = null;
const rgWalkModule = () => _rgWalk || (_rgWalk = require(__dirname + '/rg-walk.cjs'));
const rgTypesModule = () => _rgTypes || (_rgTypes = require(__dirname + '/rg-types.cjs'));

// Is this executable rg? By BASENAME, never by the exact string `rg`: the bundle resolves
// rg as `Bun.which('rg') ?? 'rg'`, which was an absolute path whenever the host had an rg
// installed, and matching only `rg` let that host rg answer every Grep and Glob call
// (measured 2026-09-27, report-grep.md). bun-shim's Bun.which('rg') now answers quaude's own
// absolute path (RG_PATH, grep-native Task 10b), a path no file is ever written at. On Windows Bun.which answers whichever PATHEXT
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

const stripDot = (p) => (p.startsWith('./') ? p.slice(2) : p);
const toBuf = (b) => (b == null ? Buffer.alloc(0) : Buffer.isBuffer(b) ? b : Buffer.from(b));
const firstLine = (buf) => toBuf(buf).toString('utf8').split('\n').map((l) => l.trim()).find(Boolean) || '';

// What a ugrep match pass that failed comes to: quaude's rg refuses, naming what ugrep said (the Grep tool
// reads a bare rc 2 with no output as "No files found"). `onRejected(argv, status)` lets the caller surface
// it to the operator as well.
function appletRejected(bin, status, stderr) {
  const said = firstLine(stderr);
  return rgRefusal(`${leafOf(bin)}, which quaude answers rg with on purpose, rejected this search`
    + `${said ? ` (${said})` : ` (exit ${status})`}; nothing was found`);
}

// THE SYNCHRONOUS RUN, for the synchronous surfaces only (spawnSync, execFileSync): they block
// their caller by contract, as node's do. Every other surface runs the search asynchronously
// (rgSpawn below), so the event loop keeps turning and the caller's bounds can end the search.
//
// argv: rg's arguments (no argv[0]). opts:
//   cwd, env              where and with what the search runs (env defaults to process.env)
//   input                 what the caller hands the child's stdin (rg reads it for target `-`), or a function
//                         answering it, called only when the search reaches stdin (a command's fd 0: rg-entry.cjs)
//   implicit              what a pathless search searches, 'stdin' or 'cwd' (RG-IMPLICIT-PATH: a command's
//                         question, rg-entry.cjs); absent, a pathless search refuses
//   stream, sink,         RG-STREAM (a command's search): stdin and named files searched as they are read, the
//   stdinChunk            output handed to sink(buf) as it is printed (stdout comes back empty), stdin pulled a
//                         piece at a time from stdinChunk() (a Buffer, null at its end; a throw is rg's error)
//   timeout, maxBuffer,   the caller's own bounds, when it named them
//   killSignal
//   ugrep()               the ugrep a search runs (null: this host has none)
//   missing()             the refusal when a search needs ugrep and there is none
//   matchFiles            what decides files' matches instead of ugrepMatches (tests: the matcher alone)
//   debug(argv, verdict)  told of each call's verdict (CLODE_RG_DEBUG's line)
//   spawnSync             the UNWRAPPED spawnSync to run ugrep with
//   onRejected(argv, st)  told when ugrep failed a search's match pass
// A search is searchSync's, bounded by the caller's timeout (see there).
// Returns { stdout, stderr, status, signal }, plus `refused` for a refusal and `errorCode` when
// a bound fired (node's spawnSync reports ETIMEDOUT / ENOBUFS; node-shim's ETIMEDOUT for both).
// RG-SPAWN-CWD: a spawned rg's working directory is the directory its spawn's cwd names when the child starts: the
// child chdir()s there before exec. The 2.1.283 bundle on Linux hands its Grep's rg a cwd of /proc/self/fd/N, a
// directory it holds open (fd N is still the caller's at that chdir), so rg runs in that directory and never sees the
// name. quaude's rg runs inside the caller, where N names the same directory now: a cwd naming a descriptor is
// resolved once, up front, to the directory it names, and the search runs from there, as rg's does. Any other cwd is
// taken as given (it names its directory the same way before and after a chdir). One that does not resolve to a
// plain ABSOLUTE path stays as it was, and its target is refused as before (RG-REFUSE-SPECIAL-FILE).
const DESCRIPTOR_CWD = /^\/(?:dev\/fd|proc\/(?:self|thread-self|\d+)\/fd)\/\d+$/;
function rgSpawnCwd(cwd, { realpath = (p) => require('fs').realpathSync(p) } = {}) {
  if (typeof cwd !== 'string' || !DESCRIPTOR_CWD.test(cwd)) return cwd;
  let real;
  try { real = realpath(cwd); } catch { return cwd; }
  // an absolute path that is no descriptor name, or nothing: a relative answer would move the search
  return typeof real === 'string' && require('path').isAbsolute(real) && !DESCRIPTOR_PATH.test(real) ? real : cwd;
}
const withSpawnCwd = (opts) => {
  const cwd = rgSpawnCwd(opts && opts.cwd);
  return cwd === (opts && opts.cwd) ? opts : { ...opts, cwd };
};

function runRg(argv, opts = {}) {
  opts = withSpawnCwd(opts);
  const plan = rgPlan(argv, opts);
  if (plan.result) return plan.result;
  return searchSync(plan, opts);
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
//                       passed. rg's binary quit and convert rules are the printers' (RG-BINARY-*)
//   -Y                  empty matches are reported (without it ugrep drops them, and a pattern
//                       like `e*` matches every line in rg but only some in ugrep), so a
//                       prefilter that can match empty proposes every line
//   -H --null %F        `path\0`, so ANY path is unambiguous (a newline in a name included)
//   %b %e %~            the match's byte offsets from the start of the file, then a newline
//                       (LF here; ugrep's help says "LF or CRLF", unmeasured on Windows, so
//                       the parser takes either)
// On the plumbing's probes (literals, several matches per line, CRLF, NUL, invalid UTF-8, empty
// matches) all three versions give byte-identical output. Their REGEX DIALECTS differ (from rg's
// and from each other: alternation, \b on UTF-8, [[:alpha:]]), so ugrep's matches are only
// PROPOSALS: ugrep is given rg-regex.cjs's prefilter (a superset of rg's lines) and rg-regex.cjs
// decides every proposed line (grep-native Task 5b). The FLOOR is 5.0.0: 3.11.2
// exits 0 on an unreadable file (5.0.0 and 7.8.2 exit 2), so a failed search could pass for a
// clean one. ugrep 7's `--from=FILE` and `%[0]U` are absent before it, so the file list is argv
// (in chunks) and the NUL comes from --null: one way, every version at or above the floor.
const UGREP_MIN = '5.0.0';
const UGREP_RANGE_FORMAT = '--format=%F%b %e%~';
// `%u` first: one record per matching LINE (its first match), which is all the matcher needs to
// decide that line (review P1). Measured alike on 7.8.2 (macOS, NetBSD 11) and 5.0.0 (noble),
// empty matches under -Y included, so it needs no capability gate.
const UGREP_LINE_FORMAT = '--format=%u%F%b %e%~';
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
  try { r = spawnSync(bin, ['--version'], { encoding: 'buffer', timeout: opts.timeout || 30000 }); } catch (e) { r = { error: e }; }
  // The CALLER's timeout ended it (runRg's deadline): that says nothing about this ugrep, so it is
  // not remembered; the search ends, timed out.
  if (opts.timeout && r && r.error && r.error.code === 'ETIMEDOUT') throw timedOutError();
  return capsFrom(bin, r);
}
// The same, without blocking: what the asynchronous surfaces ask (a first Grep would otherwise hold
// the event loop for one `ugrep --version`). Same cache.
function ugrepCapabilitiesAsync(bin, opts = {}) {
  if (_ugrepCaps.has(bin)) return Promise.resolve(_ugrepCaps.get(bin));
  return runChild(opts.spawn || require('child_process').spawn, bin, ['--version'], { env: process.env }, () => {})
    .then((r) => (_ugrepCaps.has(bin) ? _ugrepCaps.get(bin) : capsFrom(bin, r)));
}
function capsFrom(bin, r) {
  const version = r && !r.error ? parseUgrepVersion(toBuf(r.stdout).toString('utf8')) : null;
  const format = !!version && versionAtLeast(version, UGREP_MIN);
  const reason = format ? null
    : version ? `ugrep ${version} is older than ${UGREP_MIN}, the oldest ugrep quaude's rg is measured against`
      : `${leafOf(bin)} did not answer as ugrep (${(r && r.error && (r.error.code || r.error.message)) || `exit ${r && r.status}`})`;
  const caps = { bin, version, format, reason };
  _ugrepCaps.set(bin, caps);
  return caps;
}

// ugrep's argv for a candidate search, before the files. `prefilter` is rg-regex.cjs's: a pattern
// in ugrep's own dialect whose lines are a SUPERSET of rg's, case folding already spelled into
// it (rg's folding, not ugrep's -i, which is never passed). `perLine`: one record per line (`%u`),
// for lines the matcher decides; without it, every match (RG-RE-LITERAL-RANGES).
function ugrepMatchArgv(prefilter, { perLine = false } = {}) {
  return ['-Y', '-H', '--null', perLine ? UGREP_LINE_FORMAT : UGREP_RANGE_FORMAT, '-e', prefilter, '--'];
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
// `refused` is set (the RG-RE-* rule) when the PATTERN is one quaude's rg cannot answer exactly
// (rg-regex.cjs REFUSALS); the message is then the refusal's reason, for rgRefusal.
class UgrepError extends Error {
  constructor(message, { status = null, signal = null, stderr = '', matches = new Map(), refused = null, timedOut = false } = {}) {
    super(message);
    this.name = 'UgrepError';
    Object.assign(this, { status, signal, stderr, matches, refused, timedOut });
  }
}

// ugrep's `path\0start end\n` records into Map<path, [{start, end}]>, in one pass.
// RG-EMPTY-AFTER-MATCH: rg (Rust regex's find_iter) never reports an empty match at the end of
// the match before it; ugrep -Y does (`e*` on "needle": rg 1-1 2-3 4-4, ugrep 1-1 2-3 3-3 4-4),
// so such a match is dropped here. Measured against native on text, CRLF and a file with no
// final newline.
function parseUgrepRanges(buf, into = new Map()) {
  const p = ugrepRangeParser(into);
  p.push(buf);
  return p.end();
}
// The same, fed as the bytes arrive (the asynchronous twin parses each chunk of ugrep's output as it
// comes, so a long answer never holds the event loop in one parse: Task 7 review I2). push(chunk) reads
// every complete record and keeps the incomplete tail; end() returns the Map, or throws when what is
// left is not a record. RG-EMPTY-AFTER-MATCH holds across chunks.
function ugrepRangeParser(into = new Map()) {
  const lastEnd = new Map();
  let pending = Buffer.alloc(0), seen = 0;
  const NEED_MORE = {};
  const parse = (buf, final) => {
    const bad = (at) => { throw new UgrepError(`rg-native: ugrep's --format output is not path NUL start SP end LF at byte ${seen + at}`, { matches: into }); };
    const short = (at) => { if (final) bad(at); throw NEED_MORE; };
    const num = (j) => {
      let v = 0;
      const from = j;
      for (let d; j < buf.length && (d = buf[j]) >= 0x30 && d <= 0x39; j++) v = v * 10 + (d - 0x30);
      if (j === buf.length) short(j);
      return j === from ? bad(from) : [v, j];
    };
    let i = 0;
    // ugrep names the file in every record; the name is decoded once per run of the same bytes.
    let lastName = null, lastAt = 0, lastLen = -1;
    const sameName = (at, len) => {
      if (len !== lastLen) return false;
      for (let k = 0; k < len; k++) if (buf[at + k] !== buf[lastAt + k]) return false;
      return true;
    };
    try {
      while (i < buf.length) {
        const z = buf.indexOf(0, i);
        if (z === -1) short(i);
        let [start, j] = num(z + 1);
        if (buf[j] !== 0x20) bad(j);
        let end;
        [end, j] = num(j + 1);
        if (buf[j] === 0x0d) j++;
        if (j === buf.length) short(j);
        if (buf[j] !== 0x0a) bad(j);
        const file = sameName(i, z - i) ? lastName : (lastName = buf.toString('utf8', i, z));
        lastAt = i; lastLen = z - i;
        i = j + 1;
        if (start === end && lastEnd.get(file) === end) continue;
        lastEnd.set(file, end);
        let list = into.get(file);
        if (!list) { list = []; into.set(file, list); }
        list.push({ start, end });
      }
    } catch (e) { if (e !== NEED_MORE) throw e; }
    return i;
  };
  return {
    push(chunk) {
      const buf = pending.length ? Buffer.concat([pending, toBuf(chunk)]) : toBuf(chunk);
      const used = parse(buf, false);
      seen += used;
      pending = buf.subarray(used);
    },
    end() { if (pending.length) parse(pending, true); return into; },
  };
}

// The plan both twins share: each distinct file once, spelled for ugrep, in chunks; and how to
// read the ranges back in the caller's order (a file without a match has no entry).
// A generator (it yields every SNIFF_SLICE files of its BOM sniff, an open, a 4-byte read and a close each, so
// the asynchronous twin hands the event loop back across a large walk: Task 9 review I-2, 915 ms held over
// 18.7k files); matchPlan drains it at once.
const SNIFF_SLICE = 256;
function matchPlan(files, prefilter, opts, perLine) { return drain(matchPlanGen(files, prefilter, opts, perLine)); }
function* matchPlanGen(files, prefilter, opts, perLine) {
  // A directory is searched as NOTHING (ugrep exits 0 on one without -r): the walk lists files,
  // so a directory here is the caller's mistake, refused rather than answered "no matches".
  // RG-TEXT-BOM: each file's first bytes, read here once, say whether its text is rg's decoding
  // of a byte order mark (every line then decided, whatever ugrep proposed).
  const fs = require('fs'), path = require('path');
  const bom = new Set();
  // A file the walk listed (opts.known) is a regular file already (N-2): it is not stat'ed again, only
  // sniffed (an empty or one-byte file reads short and holds no BOM).
  const known = opts.known || new Set();
  let n = 0;
  for (const f of files) {
    if (++n % SNIFF_SLICE === 0) yield;
    const p = path.resolve(opts.cwd || process.cwd(), f);
    if (known.has(f)) { if (hasBom(readHead(p))) bom.add(f); continue; }
    let st = null;
    try { st = fs.statSync(p); } catch { /* a missing file is ugrep's to report */ }
    if (st && st.isDirectory()) throw new UgrepError(`rg-native: ${f} is a directory; ugrepMatches searches files only`);
    if (st && st.isFile() && st.size >= 2 && hasBom(readHead(p))) bom.add(f);
  }
  const spelled = [...new Set(files.map(spellForUgrep))];
  const asked = new Set(spelled);
  const argv = ugrepMatchArgv(prefilter, { perLine });
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
  return { chunks, inOrder, onlyAsked, bom, asked };
}
// ---- rg's text, and rg's matcher over the lines ugrep proposed -----------------------------------
// RG-TEXT-BOM (measured against native 2.1.283): rg searches what its decoder makes of a byte
// order mark. A UTF-8 BOM (EF BB BF) is stripped; UTF-16 (FF FE little-endian, FE FF big-endian)
// is transcoded to UTF-8 the WHATWG way (encoding_rs: an unpaired surrogate, and an odd last byte,
// each one U+FFFD); offsets are into that text (`ab needle` after either BOM: 3-9). A UTF-32 BOM
// is not rg's: FF FE 00 00 reads as UTF-16LE, 00 00 FE FF as plain bytes. ugrep reads all four
// its own way, so a file with ANY of them has every line decided here (`all`), and ugrep's
// proposals for it are not used.
const BOMS = [[0xef, 0xbb, 0xbf], [0xff, 0xfe], [0xfe, 0xff], [0x00, 0x00, 0xfe, 0xff]];
const hasBom = (head) => BOMS.some((m) => m.every((b, i) => head[i] === b));
function readHead(p) {
  const fs = require('fs');
  let fd = null;
  try {
    fd = fs.openSync(p, 'r');
    const b = Buffer.alloc(4);
    return b.subarray(0, fs.readSync(fd, b, 0, 4, 0));
  } catch { return Buffer.alloc(0); } finally { if (fd !== null) try { fs.closeSync(fd); } catch { /* closed */ } }
}
function rgText(bytes) { return rgTextRead(bytes).text; }
// rg's text, and HOW ITS READER HANDS IT OVER (RG-BINARY-QUIT reads in these steps): { text, read }.
// read.bounds: the text offsets no single read crosses, ascending (past them a read is as long as the
// line buffer's free room); read.snap: a read cut short by that room ends on a character boundary (the
// UTF-16 decoder writes whole characters). Measured against native 2.1.283 (test/rg-native.test.cjs):
//   plain   encoding_rs_io's BomPeeker reads 3 bytes to sniff a BOM and hands them over as the FIRST
//           read, so a newline in the first 3 bytes ends rg's first fill there
//   bom8    the BOM is dropped and nothing else is sniffed: every read is as long as there is room
//   utf16   the decoder reads 8 KiB of the file at a time into its own buffer and hands over what it
//           decodes: one read per 8 KiB, the first one (after the peek's third byte) 4,096 code units,
//           every later one 4,096 more; a lead surrogate at a read's end waits for the next
// `stdin`: rg reads its stdin through std's 8 KiB BufReader, which the 3-byte peek fills first: the
// next read is the rest of those 8 KiB, then (RG-STDIN-ALL-THERE) as long as there is room, as when the
// caller's whole input has already arrived (the UTF-16 decoder's 8 KiB reads then start at byte 8192).
// RG-STDIN-ALL-THERE is ONE behaviour everywhere (the user's doctrine: an I/O-chunking artifact, like
// RG-MMAP-EVERYWHERE), and a NAMED macOS PIPE-CAPACITY DIVERGENCE: a read from a pipe hands over what the
// pipe holds, and a macOS pipe holds 64 KiB, so there native's first fill past the BufReader's 8 KiB
// ends at the pipe's capacity when one writer fills it at once (`-n -C 1` over 65,547 bytes whose NUL is
// at 65536: macOS one-shot writers 64 KiB first 20 of 20 in Task 8's re-review (spawnSync, spawn, 4 KiB
// chunks, `cat |`), 15 and 18 of 20 under spawnSync re-measured 2026-10-04, the rest whole; a file
// descriptor as stdin whole 10 of 10; only a writer that pauses varies). Linux reads the whole input,
// 40 of 40. Only the standard printer's RG-BINARY-CONVERT stop over more than 8 KiB of stdin depends
// on it; test/rg-native.test.cjs P8_MACOS_PIPE_DIVERGENCE keeps macOS native's literal beside Linux's,
// and requires macOS native still to print it.
const STDIN_BUF = 8 * 1024;
function rgTextRead(bytes, { stdin = false } = {}) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: bytes.subarray(3), read: { kind: 'bom8', bounds: stdin ? [STDIN_BUF - 3] : [], snap: false } };
  }
  for (const le of [true, false]) {
    if (bytes.length >= 2 && bytes[0] === (le ? 0xff : 0xfe) && bytes[1] === (le ? 0xfe : 0xff)) {
      const ends = [];
      const text = utf16ToUtf8(bytes.subarray(2), le, { first: stdin ? (STDIN_BUF - 2) / 2 : 4096, every: 4096, ends });
      return { text, read: { kind: 'utf16', bounds: ends, snap: true } };
    }
  }
  return { text: bytes, read: { kind: 'plain', bounds: stdin ? [3, STDIN_BUF] : [3], snap: false } };
}
// The WHATWG UTF-16 decoder (what encoding_rs implements), straight to UTF-8 bytes. `chunks`: where the
// output stands after each read of the decoder (code unit `first`, then every `every` more; a pending
// lead surrogate not yet written), pushed onto chunks.ends, and before a last U+FFFD written at the end.
function utf16ToUtf8(b, le, chunks = null) {
  const out = Buffer.alloc(b.length * 2 + 4);
  let o = 0;
  const put = (c) => {
    if (c < 0x80) out[o++] = c;
    else if (c < 0x800) { out[o++] = 0xc0 | (c >> 6); out[o++] = 0x80 | (c & 0x3f); }
    else if (c < 0x10000) { out[o++] = 0xe0 | (c >> 12); out[o++] = 0x80 | ((c >> 6) & 0x3f); out[o++] = 0x80 | (c & 0x3f); }
    else { out[o++] = 0xf0 | (c >> 18); out[o++] = 0x80 | ((c >> 12) & 0x3f); out[o++] = 0x80 | ((c >> 6) & 0x3f); out[o++] = 0x80 | (c & 0x3f); }
  };
  const mark = () => { const e = chunks.ends; if (o > (e.length ? e[e.length - 1] : 0)) e.push(o); };
  let lead = -1, nextMark = chunks ? chunks.first : -1;
  const n = b.length >> 1;
  for (let i = 0; i < n; i++) {
    if (i === nextMark) { mark(); nextMark += chunks.every; }
    const u = le ? b[2 * i] | (b[2 * i + 1] << 8) : (b[2 * i] << 8) | b[2 * i + 1];
    if (lead !== -1) {
      const l = lead;
      lead = -1;
      if (u >= 0xdc00 && u <= 0xdfff) { put(0x10000 + ((l - 0xd800) << 10) + (u - 0xdc00)); continue; }
      put(0xfffd);                       // an unpaired lead; this unit is read afresh
    }
    if (u >= 0xd800 && u <= 0xdbff) lead = u;
    else if (u >= 0xdc00 && u <= 0xdfff) put(0xfffd);
    else put(u);
  }
  if (chunks) mark();
  if (lead !== -1 || (b.length & 1)) put(0xfffd); // one, for whatever was left over
  if (chunks) mark();
  return out.subarray(0, o);
}

// The lines of `text` to decide: those holding a proposed offset, or (`all`) every line.
// [lineStart, lineEnd) pairs, the terminator excluded, ascending.
// A generator: it yields every SLICE_LINES lines (so the asynchronous twin can hand the loop back on a
// file of 200,000 lines; Task 7 review I2) and returns the pairs; candidateLines drains it at once.
const SLICE_LINES = 4096;
const drain = (gen) => { let r = gen.next(); while (!r.done) r = gen.next(); return r.value; };
async function drainAsync(gen, between) { let r = gen.next(); while (!r.done) { await between(); r = gen.next(); } return r.value; }
function candidateLines(text, proposed, all) { return drain(candidateLinesGen(text, proposed, all)); }
function* candidateLinesGen(text, proposed, all) {
  const out = [];
  let n = 0;
  const lineAt = (ls) => { let le = text.indexOf(0x0a, ls); if (le === -1) le = text.length; out.push(ls, le); return le + 1; };
  if (all) { for (let ls = 0; ls < text.length;) { ls = lineAt(ls); if (++n % SLICE_LINES === 0) yield; } return out; }
  // ugrep proposes in file order, so line starts come ascending: each is taken once, found scanning
  // back no further than the line before (linear; a set and a sort of 200,000 starts held the loop).
  // Proposals out of order (never measured) are sorted first.
  let list = proposed || [];
  for (let k = 1; k < list.length; k++) if (list[k].start < list[k - 1].start) { list = list.slice().sort((a, b) => a.start - b.start); break; }
  let next = 0;
  for (const { start } of list) {
    if (start > text.length || (start === text.length && (text.length === 0 || text[text.length - 1] === 0x0a))) continue;
    if (start < next) continue;                     // on the line just taken
    next = lineAt(lineStart(text, start, next));
    if (++n % SLICE_LINES === 0) yield;
  }
  return out;
}

// One file's text and the lines of it to decide.
function fileLines(file, proposed, opts, all) {
  const fs = require('fs'), path = require('path');
  let bytes;
  try { bytes = fs.readFileSync(path.resolve(opts.cwd || process.cwd(), file)); } catch (e) {
    throw new UgrepError(`rg-native: ${file} could not be read after ugrep searched it (${e.code || e.message})`);
  }
  const text = rgText(bytes);
  return { text, lines: candidateLines(text, proposed, all) };
}
// rg-regex's refusals, as the one failure type this plumbing throws.
function asUgrepError(e) {
  return e && e.name === 'RgRegexRefusal' ? new UgrepError(rgRegexModule().refusalReason(e), { refused: e.rule }) : e;
}
// One file: its matches, as rg's matcher finds them on the lines ugrep proposed.
function decideFile(file, proposed, t, opts, all) {
  const { text, lines } = fileLines(file, proposed, opts, all);
  return decideLines(text, lines, t, opts.deadline, opts.first);
}
// The lines' matches, in order. With a `deadline` (the synchronous caller's own timeout, ms since the
// epoch) each line is decided in slices and the search ends, timed out, once it passes: the
// synchronous surfaces cannot be aborted, so the caller's timeout is what bounds them (beyond
// RG-RE-REFUSE-COST's per-line budget, which holds with or without one).
// `first` (FIRST_MATCH): 'file' stops at the first line with a match (-l), 'line' takes one match
// per line (-c); either way only WHICH lines match is answered, by an earliest search
// (rg-regex.cjs RG-RE-EARLIEST), so those spans are never printed.
function decideLines(text, lines, t, deadline, first) {
  const out = [];
  const vo = first ? { first: true } : undefined;
  try {
    for (let i = 0; i < lines.length; i += 2) {
      let r;
      if (!deadline) r = rgRegexModule().verifyLine(text, lines[i], lines[i + 1], t, vo);
      else {
        const v = rgRegexModule().lineVerifier(text, lines[i], lines[i + 1], t, vo);
        while ((r = v.run(DECIDE_SLICE_STEPS)) === null) if (Date.now() > deadline) throw timedOutError();
        if (Date.now() > deadline) throw timedOutError();
      }
      for (const m of r) out.push(m);
      if (first === 'file' && out.length) break;
    }
  } catch (e) { throw asUgrepError(e); }
  return out;
}
const timedOutError = () => new UgrepError('rg-native: the search passed its caller\'s timeout', { timedOut: true });
// The same, for the asynchronous twin: each line is decided in slices of DECIDE_SLICE_STEPS, and
// `between()` runs after every slice (it yields to the event loop and throws on an abort), so a
// long line no longer holds the loop for its whole search (review I2).
const DECIDE_SLICE_STEPS = 1 << 16;
async function decideFileAsync(file, proposed, t, opts, all, between) {
  const { text } = fileLines(file, [], opts, false);
  const lines = await drainAsync(candidateLinesGen(text, proposed, all), between);
  return decideLinesAsync(text, lines, t, between, opts.first);
}
async function decideLinesAsync(text, lines, t, between, first) {
  const out = [];
  const vo = first ? { first: true } : undefined;
  for (let i = 0; i < lines.length; i += 2) {
    let r;
    try {
      const v = rgRegexModule().lineVerifier(text, lines[i], lines[i + 1], t, vo);
      while ((r = v.run(DECIDE_SLICE_STEPS)) === null) await between();
    } catch (e) { throw asUgrepError(e); }
    for (const m of r) out.push(m);
    if (first === 'file' && out.length) break;
    await between();
  }
  return out;
}
// The pattern, as rg-regex reads it; a refusal is a UgrepError naming its rule, before any ugrep.
function translated(pattern, opts) {
  const t = rgRegexModule().translateRgRegex(pattern, { ignoreCase: !!opts.ignoreCase, multiline: !!opts.multiline, dotall: !!opts.dotall });
  if (t.refuse) throw new UgrepError(t.refuse, { refused: t.rule });
  return t;
}
// RG-RE-LITERAL-RANGES (review P2): for a case-sensitive plain literal (rg-regex's RG-RE-LITERAL),
// ugrep's own ranges ARE rg's in a file with no BOM: a literal is its UTF-8 bytes, found leftmost
// and without overlap by both, and no dialect question arises (no class, no assertion, no case).
// So those files are neither read nor decided. test/rg-native.test.cjs proves the two paths equal
// over a hostile corpus (invalid UTF-8 beside the literal, overlapping occurrences, CJK, emoji).
const takesUgrepRanges = (t) => !!t.prog.lit;
// Every file ugrep proposed a line in, and every file with a BOM, decided: the caller's order.
function decideAll(files, proposed, bom, t, opts) {
  const out = new Map(), seen = new Set();
  for (const f of files) {
    if (seen.has(f) || (!proposed.has(f) && !bom.has(f))) continue;
    seen.add(f);
    if (opts.deadline && Date.now() > opts.deadline) throw timedOutError();
    const m = takesUgrepRanges(t) && !bom.has(f) ? proposed.get(f) : decideFile(f, proposed.get(f), t, opts, bom.has(f));
    if (m.length) out.set(f, m);
  }
  return out;
}

// RG-MULTILINE (-U, a pattern rg searches with its multi-line searcher): ugrep, given the multi-line
// prefilter (rg-regex.cjs: a FILE filter), PROPOSES files, and searchCore searches each one whole as rg's
// multi-line searcher does (multilineSearch). The Map holds every proposed file, and every file with a BOM
// (its text is not its bytes), each mapped to PROPOSED.
const PROPOSED = true;
function proposedFiles(files, proposed, bom) {
  const out = new Map();
  for (const f of files) if (proposed.has(f) || bom.has(f)) out.set(f, PROPOSED);
  return out;
}
const perLineFor = (t) => t.multiLine || !takesUgrepRanges(t);

// What a failed search found before it failed, decided as any other: the error's `matches`.
// Best effort: the search has already failed, so a file that cannot be decided adds nothing.
function partialMatches(files, proposed, t, opts) {
  if (t.multiLine) return proposedFiles(files, proposed, new Set());
  const out = new Map();
  for (const f of files) {
    if (out.has(f) || !proposed.has(f)) continue;
    try { const m = decideFile(f, proposed.get(f), t, opts, false); if (m.length) out.set(f, m); } catch { /* already failed */ }
  }
  return out;
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
// A chunk that exited 2 having only WARNED about paths it was asked to search (ugrep 7.8.2, measured:
// `ugrep: warning: cannot read X: Permission denied`, `ugrep: warning: X: No such file or directory`;
// it searched the rest and printed their records) answered with rg's own per-path errors: those
// paths' errors, never ugrep failing (Task 6 re-review N3). [{ file, text }], the text as rg spells
// it; null when any line of its stderr is something else (an infrastructure failure).
function perPathWarnings(stderr, asked) {
  const out = [];
  for (const line of toBuf(stderr).toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    const m = /^ugrep: (?:warning: )?(?:cannot (?:read|open)(?: file)? )?(.+): ([^:]+)$/.exec(line);
    const n = m && asked.has(m[1]) ? errnoOfText(m[2]) : undefined;
    if (n === undefined) return null;
    out.push({ file: m[1], text: `${m[2]} (os error ${n})` });
  }
  return out.length ? out : null;
}
const ugrepFailed = (bin, r, stderr, matches) => new UgrepError(
  `${leafOf(bin)} failed (${r.signal ? `signal ${r.signal}` : `exit ${r.status}`})${firstLine(stderr) ? `: ${firstLine(stderr)}` : ''}`,
  { status: r.status, signal: r.signal || null, stderr: toBuf(stderr).toString('utf8'), matches });

// ugrepMatches(files, pattern, opts) -> Map<file, [{start, end}]>: where rg's `pattern` matches
// in each of `files` (relative to opts.cwd, or absolute), as rg's MATCHER finds them (its
// printers then decide what to print: RG-RE-MATCH-AT-UNTERMINATED-END, rg-regex.cjs). ugrep,
// given rg-regex's prefilter, PROPOSES candidate lines; rg-regex's matcher DECIDES each one
// (grep-native Task 5b). opts: ugrep (the binary), cwd, env, ignoreCase (rg's -i), spawnSync (the
// UNWRAPPED one, under bun-shim), argvBudget. Throws UgrepError when ugrep fails or is below
// UGREP_MIN, and (with `refused`) when the pattern is one quaude's rg cannot answer exactly.
// Synchronous: for the synchronous rg surfaces; ugrepMatchesAsync is the same search for the
// asynchronous ones.
function ugrepMatches(files, pattern, opts = {}) {
  if (!files.length) return new Map();
  const t = translated(pattern, opts);
  assertUsableUgrep(opts);
  const spawnSync = opts.spawnSync || require('child_process').spawnSync;
  const { chunks, inOrder, onlyAsked, bom, asked } = matchPlan(files, t.prefilter, opts, perLineFor(t));
  const ranges = new Map(), pathErrors = [];
  let failed = null;
  for (const argv of chunks) {
    if (opts.deadline && Date.now() > opts.deadline) throw timedOutError();
    const r = spawnSync(opts.ugrep, argv, { cwd: opts.cwd, env: opts.env || process.env, encoding: 'buffer', maxBuffer: RG_MAX_BUFFER,
      timeout: opts.deadline ? Math.max(1, opts.deadline - Date.now()) : undefined });
    if (r.error && r.error.code === 'ETIMEDOUT') throw timedOutError();
    if (r.error) throw new UgrepError(`${leafOf(opts.ugrep)} could not be run (${r.error.code || r.error.message})`);
    // Killed: the bytes may stop anywhere, so they are not read; the kill is the answer.
    if (r.status === null || r.signal) { failed = { r, stderr: r.stderr }; break; }
    // A failed chunk ends the search: the answer is already an error, so no later chunk runs.
    // Its status comes first (re-review N-1): what it printed is read only for the matches it
    // found before failing.
    const warned = r.status >= 2 ? perPathWarnings(r.stderr, asked) : null;
    if (r.status >= 2 && !warned) { readFailedChunk(toBuf(r.stdout), ranges); failed = { r, stderr: r.stderr }; break; }
    parseUgrepRanges(toBuf(r.stdout), ranges);
    if (warned) pathErrors.push(...warned);
  }
  if (failed) throw ugrepFailed(opts.ugrep, failed.r, failed.stderr, partialMatches(files, inOrder(ranges), t, opts));
  onlyAsked(ranges);
  if (t.multiLine) return withPathErrors(proposedFiles(files, inOrder(ranges), bom), pathErrors);
  return withPathErrors(decideAll(files, inOrder(ranges), bom, t, opts), pathErrors);
}
// The answer's per-path errors ride on the Map (`pathErrors`, ugrep's spelling of each path), so the
// Map stays what every caller iterates.
const withPathErrors = (m, errs) => { if (errs.length) m.pathErrors = errs; return m; };

// The asynchronous twin: a Promise of the same Map, the chunks run one after another as real
// children. opts.spawn is the UNWRAPPED spawn; opts.onChild(child) is told of each child, so the
// caller can end the search (kill) when its own bounds fire. Deciding the proposed lines is JS
// work, done in slices of steps (decideFileAsync), and the twin hands the event loop back once
// DECIDE_SLICE_MS of it have passed, inside a line as between lines and files (the caller's timers
// and kill() keep turning); opts.signal, once aborted, ends the search with a UgrepError at the
// next slice.
const DECIDE_SLICE_MS = 20;
function ugrepMatchesAsync(files, pattern, opts = {}) {
  if (!files.length) return Promise.resolve(new Map());
  // The floor check runs ugrep --version synchronously, ONCE per binary per process (cached).
  let t;
  try { t = translated(pattern, opts); assertUsableUgrep(opts); } catch (e) { return Promise.reject(e); }
  const spawn = opts.spawn || require('child_process').spawn;
  // the plan, sniffed in slices (matchPlanGen) inside the run below
  let chunks, inOrder, onlyAsked, bom, asked;
  const aborted = () => opts.signal && opts.signal.aborted;
  const abortError = () => new UgrepError('rg-native: the search was aborted');
  const ranges = new Map(), pathErrors = [];
  const runOne = (argv) => new Promise((resolve, reject) => {
    let child;
    try { child = spawn(opts.ugrep, argv, { cwd: opts.cwd, env: opts.env || process.env, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { reject(new UgrepError(`${leafOf(opts.ugrep)} could not be run (${e.code || e.message})`)); return; }
    if (opts.onChild) opts.onChild(child);
    const outs = [], errs = [];
    let settled = false;
    child.stdout.on('data', (d) => outs.push(toBuf(d)));
    child.stderr.on('data', (d) => errs.push(toBuf(d)));
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      reject(new UgrepError(`${leafOf(opts.ugrep)} could not be run (${e.code || e.message})`));
    });
    child.on('close', (status, signal) => {
      if (settled) return;
      settled = true;
      // Its output is read by the caller, in slices (readRecords). A chunk that only warned about
      // paths is rg's per-path errors, the rest answered.
      const warned = status >= 2 && !signal ? perPathWarnings(Buffer.concat(errs), asked) : null;
      resolve({ status, signal: signal || null, stderr: Buffer.concat(errs), warned, outs });
    });
  });
  const yieldLoop = () => new Promise((r) => setTimeout(r, 0));
  let slice = Date.now();
  const between = async () => {
    if (Date.now() - slice > DECIDE_SLICE_MS) { await yieldLoop(); slice = Date.now(); }
    if (aborted()) throw abortError();
  };
  // ugrep's records, read PARSE_SLICE bytes at a time with the loop handed back between (Task 7 review
  // I2: 200,000 records took 480 ms in one parse under tjs). Killed, or exit >= 2 (re-review N-1): the
  // failure is the answer, and the complete records before any bad byte only add the matches found
  // first. Otherwise a bad record is the answer.
  const PARSE_SLICE = 64 * 1024;
  const readRecords = async (r, failedRun) => {
    const parser = ugrepRangeParser(ranges);
    try {
      for (const b of r.outs) for (let i = 0; i < b.length; i += PARSE_SLICE) { parser.push(b.subarray(i, i + PARSE_SLICE)); await between(); }
      parser.end();
    } catch (e) { if (!failedRun || !(e instanceof UgrepError)) throw e; }
  };
  return (async () => {
    if (aborted()) throw abortError();
    ({ chunks, inOrder, onlyAsked, bom, asked } = await drainAsync(matchPlanGen(files, t.prefilter, opts, perLineFor(t)), between));
    let failed = null;
    for (const argv of chunks) {
      const r = await runOne(argv);
      // A failed chunk (killed by the caller, or exit >= 2) ends the search: no later chunk runs.
      const failedRun = r.status === null || r.signal || (r.status >= 2 && !r.warned);
      if (!r.signal && r.status !== null) await readRecords(r, failedRun);
      if (failedRun) { failed = r; break; }
      if (r.warned) pathErrors.push(...r.warned);
      if (aborted()) throw abortError();
    }
    if (failed) throw ugrepFailed(opts.ugrep, failed, failed.stderr, partialMatches(files, inOrder(ranges), t, opts));
    onlyAsked(ranges);
    const proposed = inOrder(ranges);
    if (t.multiLine) return withPathErrors(proposedFiles(files, proposed, bom), pathErrors);
    const out = new Map(), seen = new Set();
    for (const f of files) {
      if (seen.has(f) || (!proposed.has(f) && !bom.has(f))) continue;
      seen.add(f);
      await between();
      const m = takesUgrepRanges(t) && !bom.has(f) ? proposed.get(f) : await decideFileAsync(f, proposed.get(f), t, opts, bom.has(f), between);
      if (m.length) out.set(f, m);
    }
    return withPathErrors(out, pathErrors);
  })();
}

// ==== quaude's rg answers a search itself (grep-native Task 6) ===================================
// A search (rg's standard printer, -l, -c, or --json) no longer goes through today's translation: quaude's
// rg reads rg's argv (parseRgSearch), finds what to search (its targets: stdin, named files, and a
// directory's files as rg's walk finds them: rg-walk.cjs, RG-WALK-* and the rules it states, Task 9),
// takes every file's matches from ugrepMatches (stdin's from the matcher alone), and PRINTS THEM AS
// rg's PRINTERS DO, from rg's own text of each file (RG-TEXT-BOM). --type and --type-not select through
// rg's type table (RG-TYPE), --version and --type-list answer from it (RG-VERSION, RG-TYPE-LIST:
// rg-types.cjs); --files lists and -U searches multi-line (Task 10: "rg --files" and "rg's multi-line
// search" below). The JSON printer's own rules (RG-JSON, RG-JSON-CONTEXT, RG-JSON-BYTES, RG-JSON-ESCAPE,
// RG-JSON-ONLY-MATCHING) are stated where it is, "rg's JSON Lines printer" below.
//
// THE RULES, one statement each, every one measured against native 2.1.283's embedded rg (ripgrep
// 14.1.1) and pinned by a same-named test in test/rg-native.test.cjs (native's literals):
//   RG-ARGV                    the flags a search reads; -l, -c and --json, the last one wins; a number
//                              flag that is not a number is rg's own usage error; `--` ends flags
//   RG-FILES-NULL              -l: `path` then \n, or \0 under --null
//   RG-COUNT-NONZERO           -c: `[path SEP]N\n` per file with a selected line; a file with none
//                              prints nothing (and -c -o prints the 0 of a file selected only by
//                              an unprintable match)
//   RG-COUNT-MATCHES           -c -o counts printable matches, not lines
//   RG-WITH-FILENAME           the path is printed unless the search is one path that is not a
//                              directory (a file, or stdin); -H and --no-filename override
//   RG-PATH-SPELLING           a walked file is its target joined as Rust's Path::join joins
//                              (`.` -> ./a.txt, `one/` -> one/only.txt, `one//` -> one//only.txt)
//   RG-EXPLICIT-FILE           a NAMED file is searched whatever --glob, --hidden or ignore rules say
//   RG-STANDARD-LINES          `[path SEP][N SEP]line`: SEP `:` on a match, `-` on context, \0
//                              after the path under --null; the line's terminator kept (\r\n too)
//                              and \n added to a line that has none
//   RG-CONTEXT                 -A/-B/-C (-A/-B over -C), merged, `--` between groups that do not
//                              touch and between files
//   RG-ONLY-MATCHING           -o: each printable match on its own line; a selected line with none
//                              prints whole (grep-printer's sink_fast)
//   RG-MAX-COLUMNS             -l, -c: nothing; the standard printer: a line whose bytes, terminator
//                              included, pass N prints as `[Omitted long matching line]` (or
//                              `context`), a -o match by its own bytes; 0 means no limit
//   RG-RE-MATCH-AT-UNTERMINATED-END (the printers' half) the matcher's match at the end of an
//                              unterminated last line selects the line but is never printed or counted
//                              as a match (--json: a match message with submatches [])
//   RG-STDIN                   `-` searches what the caller piped in, named `<stdin>`; to rg it is a
//                              NAMED path, so a NUL in it does not end the search (review I-1)
//   RG-FIRST-MATCH             -l stops at a file's first match, -c and the standard printer
//                              without -o at a line's first (rg-regex.cjs RG-RE-EARLIEST), as rg
//                              does; -o and -c -o find every match
//   RG-SPECIAL-FILE            a NAMED path that is neither a regular file nor a directory, decided
//                              unread: /dev/null is an empty file, one that cannot be opened (a
//                              socket) is rg's per-path error; a walked one is skipped, as rg skips it
//   RG-REFUSE-SPECIAL-FILE     a named /dev/stdin, /dev/fd/N, /proc/self/fd/N, FIFO, character device
//                              other than /dev/null, or block device refuses: rg reads it until it
//                              ends; quaude's rg cannot without blocking or reading its caller's input
//   RG-EXIT                    0 found, 1 not found, 2 when any path failed (its error on stderr, the
//                              rest still searched and printed): never quaude's refusal
//   RG-BINARY-QUIT, RG-BINARY-CONVERT, RG-BINARY-MMAP  (grep-native Task 8) what a NUL does to a walked
//                              file, a named one or stdin, and a named one rg memory-maps: stated where
//                              they are, "rg's binary detection" below
//   RG-WALK-*, RG-IGNORE-*, RG-GLOB-*, RG-HIDDEN, RG-TYPE, RG-REFUSE-NAME-NOT-UTF8  (grep-native Task 9)
//                              which files a directory search reaches, and in which order: stated where
//                              they are, libexec/rg-walk.cjs; RG-VERSION, RG-VERSION-SIMD, RG-TYPE-LIST in
//                              libexec/rg-types.cjs
//
// WHERE WE PRINT. As rg prints to a pipe or a file, which is what every surface the bundle uses
// hands it (no heading, no colour, no line numbers unless -n).

// ---- rg's argv, as a search reads it -------------------------------------------------------------
// The flags quaude's rg answers itself. Anything else is refused BY NAME, never passed on to an
// applet that reads it some other way (ugrep's -U is --binary, for one).
const LONG_BOOL = {
  '--files-with-matches': (s) => { s.mode = 'files'; }, '--count': (s) => { s.mode = 'count'; }, '--json': (s) => { s.mode = 'json'; },
  '--ignore-case': (s) => { s.ignoreCase = true; }, '--case-sensitive': (s) => { s.ignoreCase = false; },
  '--line-number': (s) => { s.lineNumber = true; }, '--no-line-number': (s) => { s.lineNumber = false; },
  '--with-filename': (s) => { s.withFilename = true; }, '--no-filename': (s) => { s.withFilename = false; },
  '--null': (s) => { s.nul = true; }, '--only-matching': (s) => { s.only = true; },
  '--hidden': (s) => { s.hidden = true; }, '--no-hidden': (s) => { s.hidden = false; }, '--no-ignore': (s) => { s.noIgnore = true; },
  '--multiline': (s) => { s.multiline = true; }, '--no-multiline': (s) => { s.multiline = false; },
  '--multiline-dotall': (s) => { s.dotall = true; }, '--no-multiline-dotall': (s) => { s.dotall = false; },
  '--files': (s) => { s.mode = 'list'; },
  // RG-WALK-FOLLOW, RG-NO-IGNORE's --no-ignore-vcs (rg-walk.cjs)
  '--follow': (s) => { s.follow = true; }, '--no-follow': (s) => { s.follow = false; },
  '--no-ignore-vcs': (s) => { s.noIgnoreVcs = true; }, '--ignore-vcs': (s) => { s.noIgnoreVcs = false; },
  // RG-NO-MESSAGES (fix round 2, review N2: 2.1.283's environment scan passes these): rg's error and ignore-file
  // messages are not written, the exit status still says an error happened; --no-heading is what rg does printing
  // to a pipe anyway (as quaude's rg always prints)
  '--no-messages': (s) => { s.noMessages = true; }, '--messages': (s) => { s.noMessages = false; },
  '--no-heading': () => {},
  // RG-CONFIG (rg-entry.cjs): quaude's rg reads no config file, so --no-config changes nothing it does; the command
  // reads it to know that native's rg would not read RIPGREP_CONFIG_PATH either
  '--no-config': (s) => { s.noConfig = true; },
};
const SHORT_BOOL = { l: '--files-with-matches', c: '--count', i: '--ignore-case', s: '--case-sensitive', n: '--line-number',
  N: '--no-line-number', H: '--with-filename', I: '--no-filename', 0: '--null', o: '--only-matching', '.': '--hidden', U: '--multiline', L: '--follow' };
const LONG_VALUE = { '--after-context': 'after', '--before-context': 'before', '--context': 'context', '--max-columns': 'maxColumns',
  '--regexp': 'pattern', '--glob': 'glob', '--iglob': 'iglob', '--threads': 'threads', '--type': 'type', '--type-not': 'typeNot',
  '--sort': 'sort', '--sortr': 'sortr', '--max-depth': 'maxDepth', '--maxdepth': 'maxDepth', '--max-filesize': 'maxFilesize',
  '--color': 'color' };
const SHORT_VALUE = { A: 'after', B: 'before', C: 'context', M: 'maxColumns', e: 'pattern', g: 'glob', j: 'threads', t: 'type', T: 'typeNot', d: 'maxDepth' };
// rg's special modes, answered whatever else the argv holds (RG-VERSION, RG-TYPE-LIST: rg-types.cjs).
const SPECIAL_LONG = { '--version': 'version', '--type-list': 'type-list' };
const SPECIAL_SHORT = { V: 'version-short' };
// RG-SORT-MODIFIED: --sort/--sortr's choices, as rg spells its usage error for any other; `modified` is
// answered, `none` sorts nothing, and path/accessed/created refuse by name (no upstream tool passes them).
const SORT_CHOICES = new Set(['path', 'modified', 'accessed', 'created', 'none']);
// The reason quaude's rg gives for a flag it cannot answer as native does (stated once; the Bash tool's
// `rg`, rg-entry.cjs, is this same rg).
const untranslatableReason = (flag) => `quaude answers rg with its own emulation over ugrep, on purpose, and it cannot yet give ${flag} `
  + 'the answer native\'s rg gives, so it refuses rather than answer differently; nothing was searched';
const cannotYet = (flag) => ({ refuse: untranslatableReason(flag), flag });

// A number as rg reads one (a Rust u64), or rg's own usage error for it.
function rgNumber(flag, v) {
  const why = v === '' ? 'cannot parse integer from empty string'
    : !/^\+?[0-9]+$/.test(v) ? 'invalid digit found in string'
      : BigInt(v) > 18446744073709551615n ? 'number too large to fit in target type' : null;
  return why ? { usage: `rg: error parsing flag ${flag}: value is not a valid number: ${why}\n` } : { n: Number(v) };
}
function setValue(s, key, flag, v) {
  if (v === null || v === undefined) return cannotYet(flag);   // no value at all: rg's clap error, not measured
  if (key === 'pattern') { s.patterns.push(v); return null; }
  if (key === 'glob' || key === 'iglob') { s.globs.push([key, v]); return null; }
  if (key === 'type' || key === 'typeNot') { s.types.push([key, v]); return null; }
  // RG-MAX-FILESIZE (rg-walk.cjs): grep-cli's parse_human_readable_size, its errors as rg words them
  if (key === 'maxFilesize') {
    const bad = (why) => ({ usage: `rg: error parsing flag ${flag}: invalid size: ${why}\n` });
    const m = /^([0-9]+)([KMG])?$/.exec(v);
    if (!m) return bad(`invalid format for size '${v}', which should be a non-empty sequence of digits followed by an optional 'K', 'M' or 'G' suffix`);
    const U64 = 18446744073709551615n, n = BigInt(m[1]);
    if (n > U64) return bad(`invalid integer found in size '${v}': number too large to fit in target type`);
    const size = n * (m[2] === 'G' ? 1n << 30n : m[2] === 'M' ? 1n << 20n : m[2] === 'K' ? 1n << 10n : 1n);
    if (size > U64) return bad(`size too big in '${v}'`);
    s.maxFilesize = Number(size);
    return null;
  }
  // --color: printing to a pipe, rg's `never` and `auto` are the same; `always` and `ansi` are refused by name
  if (key === 'color') {
    if (!['never', 'auto', 'always', 'ansi'].includes(v)) return { usage: `rg: error parsing flag ${flag}: choice '${v}' is unrecognized\n` };
    return v === 'never' || v === 'auto' ? null : cannotYet(`${flag}=${v}`);
  }
  if (key === 'sort' || key === 'sortr') {
    if (!SORT_CHOICES.has(v)) return { usage: `rg: error parsing flag ${flag}: choice '${v}' is unrecognized\n` };
    if (v !== 'none' && v !== 'modified') return cannotYet(`${flag}=${v}`);
    s.sort = v === 'none' ? null : { kind: v, reverse: key === 'sortr' };
    return null;
  }
  const r = rgNumber(flag, v);
  if (r.usage) return r;
  s[key] = r.n;
  return null;
}

// parseRgSearch(argv, { implicit }) -> { spec } | { special } | { refuse, flag } | { usage: stderr line }
// implicit: what a pathless rg searches, as only a command can tell (RG-IMPLICIT-PATH, rg-entry.cjs decides it from
// its fd 0): 'stdin' or 'cwd'; absent, a pathless search refuses (every rg the bundle spawns names a path).
function parseRgSearch(argv, { implicit = null } = {}) {
  const s = { mode: 'standard', patterns: [], ignoreCase: false, lineNumber: null, withFilename: null, nul: false, only: false, multiline: false, dotall: false,
    before: null, after: null, context: null, maxColumns: 0, hidden: false, noIgnore: false, globs: [], types: [], threads: null, paths: [],
    sort: null, maxDepth: null, follow: false, noIgnoreVcs: false, maxFilesize: null, noMessages: false };
  let special = null;
  const pos = [];
  let end = false;
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (end || a === '-' || a[0] !== '-') { pos.push(a); continue; }
    if (a === '--') { end = true; continue; }
    let r = null;
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a : a.slice(0, eq);
      if (SPECIAL_LONG[name] && eq === -1) special = special || SPECIAL_LONG[name];
      else if (LONG_BOOL[name] && eq === -1) LONG_BOOL[name](s);
      else if (LONG_VALUE[name]) r = setValue(s, LONG_VALUE[name], name, eq !== -1 ? a.slice(eq + 1) : i + 1 < argv.length ? argv[++i] : null);
      else return cannotYet(name);
    } else {
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        if (SPECIAL_SHORT[c]) { special = special || SPECIAL_SHORT[c]; continue; }
        if (SHORT_VALUE[c]) { const rest = a.slice(j + 1); r = setValue(s, SHORT_VALUE[c], `-${c}`, rest !== '' ? rest : i + 1 < argv.length ? argv[++i] : null); break; }
        if (!SHORT_BOOL[c]) return cannotYet(`-${c}`);
        LONG_BOOL[SHORT_BOOL[c]](s);
      }
    }
    if (r) return r;
  }
  if (special) return { special };
  // RG-FILES: --files lists the files a search would search; every positional is a path and a pattern is
  // never read. The LAST of --files, -l, -c and --json decides (ripgrep 14.1.1's Mode::update lets any mode
  // override, whatever its comment says: `--files -l x t` searches t for x, measured).
  if (s.mode === 'list') {
    // RG-IMPLICIT-PATH: a pathless --files lists ./ whatever its stdin is (hiargs.rs: only a search reads stdin)
    if (!pos.length && implicit) { s.paths = ['.']; s.implicit = true; return { spec: s }; }
    if (!pos.length) return { refuse: 'quaude answers rg with its own emulation over ugrep, on purpose, and this rg --files names no path to list; nothing was listed' };
    if (pos.includes('-')) return cannotYet('--files over -');
    s.paths = pos;
    return { spec: s };
  }
  if (!s.patterns.length) {
    if (!pos.length) return { refuse: 'quaude answers rg with its own emulation over ugrep, on purpose, and this rg names no pattern; nothing was searched' };
    s.patterns.push(pos.shift());
  }
  if (s.patterns.length > 1) return cannotYet('-e');
  // RG-IMPLICIT-PATH: rg with no path searches its stdin or the working directory, by what its stdin is. Only a
  // command knows its stdin (rg-entry.cjs); every rg the bundle runs names a path, so with no `implicit` quaude's
  // rg does not guess. ./ is searched as `.` and printed without its `./` (s.implicit: rg's strip_dot_prefix).
  if (!pos.length && implicit === 'stdin') { pos.push('-'); s.implicitStdin = true; }
  else if (!pos.length && implicit === 'cwd') { pos.push('.'); s.implicit = true; }
  if (!pos.length) return { refuse: 'quaude answers rg with its own emulation over ugrep, on purpose, and this rg names no path to search; nothing was searched' };
  s.paths = pos;
  s.before = s.before !== null ? s.before : s.context || 0;
  s.after = s.after !== null ? s.after : s.context || 0;
  s.countMatches = s.mode === 'count' && s.only;
  // RG-JSON: line numbers unless -N.
  if (s.mode === 'json') s.lineNumber = s.lineNumber !== false;
  return { spec: s };
}

// ---- what a search searches -----------------------------------------------------------------------
// rg's error for a path, as rg spells it: `Permission denied (os error 13)`. Both halves come from
// the engine, never a table here: the number from os.constants.errno, the text from libuv's message
// for it (node puts it in the error's message; tjs answers it as `new tjs.Error(-errno)`), whose
// first letter rg's libc strerror capitalizes (they agree for the errors a search meets: ENOENT,
// EACCES, ENOTDIR; measured against native's literals in test/rg-native.test.cjs).
// RG-ERROR-TEXT: rg prints its platform's C library text for an errno (Rust's io::Error formats strerror_r),
// so quaude's rg asks the engine for strerror(3) (txiki-strerror.patch: __tjs_fs_sync.strerror) and prints that,
// as written. That holds on POSIX only, and the words are the ENGINE's libc's: a NAMED DIVERGENCE on Linux, an
// artifact of our libc choice, stated here once (Task 11 review I1). quaude's published Linux engine is static musl
// (linux-x64-musl), native's rg is linked against glibc, and musl words 74 of errnos 0..133 differently (measured
// 2026-10-05): ELOOP "Symbolic link loop" (glibc "Too many levels of symbolic links"), ENAMETOOLONG "Filename too
// long" ("File name too long"), EIO "I/O error" ("Input/output error"), EOPNOTSUPP "Not supported" ("Operation not
// supported"). The errno number, and every other byte, are native's. test/rg-walk.test.cjs judges native's rows
// through musl's words on a musl engine (told by its strerror(0)), exactly on a glibc one. On WINDOWS rg prints FormatMessageW's text with the raw Win32 code
// (`The system cannot find the file specified. (os error 2)`, `Access is denied. (os error 5)`), and this prints
// the MSVC CRT's strerror with the CRT errno libuv mapped it to (`No such file or directory (os error 2)`,
// `Permission denied (os error 13)`): libuv has lost the Win32 code, so Windows is a named divergence, unmeasured. libuv's own table (what tjs.Error and node's messages carry, capitalized below) is the fallback
// where an engine has no such binding: NODE (naude, and the test runner) exposes none, so there the text of an
// errno whose libuv wording differs from the libc's (ELOOP, ENAMETOOLONG, an errno libuv cannot name) is libuv's,
// a named divergence of the node engine only (test/rg-walk.test.cjs maps native's rows through it for node).
const engineStrerror = () => (globalThis.__tjs_fs_sync && typeof globalThis.__tjs_fs_sync.strerror === 'function' ? globalThis.__tjs_fs_sync.strerror : null);
function sysErrorText(n) {
  const strerror = engineStrerror();
  if (strerror) { try { return strerror(n); } catch { /* fall back */ } }
  try {
    const util = require('util');
    if (typeof util.getSystemErrorMessage === 'function') return util.getSystemErrorMessage(-n);
    if (typeof util.getSystemErrorMap === 'function') { const e = util.getSystemErrorMap().get(-n); if (e) return e[1]; }
  } catch { /* not this engine's */ }
  try {
    if (globalThis.tjs && typeof globalThis.tjs.Error === 'function') {
      // `ENOENT: no such file or directory`; an errno libuv has no name for, `Unknown system error -102: ...`
      const m = /^(?:[A-Z0-9_]+: (.+)|([^:]+): .*)$/.exec(new globalThis.tjs.Error(-n).message);
      if (m) return m[1] || m[2];
    }
  } catch { /* not this engine's */ }
  return null;
}
const errnoTable = () => { const os = require('os'); return (os.constants && os.constants.errno) || {}; };
const capital = (t) => t[0].toUpperCase() + t.slice(1);
function osErrorText(e) {
  const code = e && e.code;
  // An errno libuv has no name for (EOPNOTSUPP on darwin: node says `Unknown system error -102`, tjs
  // `EUNKNOWN`) still carries its number.
  let n = code ? errnoTable()[code] : undefined;
  if (n === undefined && e && typeof e.errno === 'number' && e.errno !== 0) n = Math.abs(e.errno);
  const libc = n !== undefined && engineStrerror() ? sysErrorText(n) : null;
  if (libc) return `${libc} (os error ${n})`;
  // An ENGINE (not node) without the binding: below the runtime floor (scripts/engine-api-floor.cjs).
  // The fallback below still answers, so nothing throws; CLODE_ENGINE_FLOOR_LOG is how a gate hears it.
  if (n !== undefined && globalThis.__tjs_fs_sync && !engineStrerror()) {
    // node-shim's own writer (globalThis.__nodeShim, installed by its loader): an engine run always
    // has one, and node, which has no engine floor, has none.
    const ns = globalThis.__nodeShim;
    if (ns && typeof ns.engineFloorLog === 'function') ns.engineFloorLog(`rg-native: this engine has no __tjs_fs_sync.strerror (txiki-strerror.patch); errno ${n} falls back to libuv's text`);
  }
  const m = /^[A-Z0-9_]+: ([^,]+)/.exec(String((e && e.message) || ''));
  const text = m ? m[1] : n !== undefined ? sysErrorText(n) : null;
  return text ? `${capital(text)}${n !== undefined ? ` (os error ${n})` : ''}` : String(code || (e && e.message) || 'unknown error');
}
// What ugrep says it could not read (the platform's strerror), as rg says it: the number is
// the errno whose engine text is that text.
function errnoOfText(text) {
  const want = String(text).toLowerCase();
  for (const n of Object.values(errnoTable())) {
    const t = sysErrorText(n);
    if (t && t.toLowerCase() === want) return n;
  }
  return undefined;
}

// A file's bytes, as rg opens them (its text and binary detection: rgView).
function readRgBytes(file, cwd) {
  const fs = require('fs'), path = require('path');
  return fs.readFileSync(path.resolve(cwd || process.cwd(), file));
}

// ---- rg's binary detection (grep-native Task 8) -----------------------------------------------------
// grep-searcher 0.1.14 (line_buffer.rs, searcher/glue.rs, searcher/core.rs, searcher/mmap.rs),
// encoding_rs_io 0.1.7, grep-printer 0.2.2 and ripgrep 14.1.1's hiargs.rs, read from the crates; every
// rule measured against native 2.1.283 and pinned by test/rg-native.test.cjs's P8 rows. rg looks for a
// NUL as it reads, and what it does on finding one depends on how the file came to be searched:
//   RG-BINARY-QUIT    a WALKED file (rg's "implicit" detection): rg reads into a 64 KiB line buffer,
//                     fill by fill (rgTextRead's reads; each fill reads until it holds a newline, growing
//                     the buffer threefold when a line fills it; between fills it keeps the last
//                     max(-A, -B) + 1 lines it may still print as context, unless it printed past them).
//                     The fill that meets the first NUL ends the search before any of it is searched: what
//                     rg prints is what the fills before it held. --json: those lines, binary_offset the
//                     NUL's offset, bytes_searched the bytes rg had let go of (late.dat: a match at 0, NUL at
//                     120030: 65526, the whole lines of the first fill; 65502 under -C 1). -c prints NOTHING
//                     for a file with a NUL anywhere (the count is squashed); -l lists a file whose first
//                     match came before that fill. The standard printer ends with `[path: ]WARNING: stopped
//                     searching binary file after match (found "\0" byte around offset N)` when it printed
//                     a match.
//   RG-BINARY-CONVERT a NAMED file or stdin, read as above ("explicit" detection, never a filter): every
//                     NUL is a line break (the line after `\0\1\2\n` in early.dat is line 4) and the
//                     search reads to the end. --json: those lines (a NUL's line ends `\n`), binary_offset the
//                     first NUL, bytes_searched the whole text. -l and -c count those lines. The standard
//                     printer prints what the fills before the NUL's fill held, stops at the first line
//                     it would print from that fill on, and ends `[path: ]binary file matches (found "\0"
//                     byte around offset N)` when it saw a match (the one it stopped at included).
//   RG-BINARY-MMAP    a NAMED file, when every path is a regular file and there are at most 10 (rg
//                     memory-maps them), and the file has no BOM (that one is read as RG-BINARY-CONVERT): a
//                     NUL stays inside its line. rg looks in the first 64 KiB, then in each line it prints.
//                     --json: binary_offset the first NUL found so, bytes_searched that offset (else the
//                     whole text). The standard printer stops at the first line it would print once one is
//                     found, with RG-BINARY-CONVERT's last line. -l and -c: as for text.
//   RG-MMAP-EVERYWHERE (user ruling 2026-10-04) RG-BINARY-MMAP on EVERY host, macOS included. rg's own
//                     predicate (hiargs.rs) is the one above plus "and not macOS", and that clause is a
//                     performance hunch, not behaviour anyone chose: grep-searcher 0.1.14 mmap.rs:73-75,
//                     "I guess memory maps on macOS aren't great. Should re-evaluate." quaude never maps a
//                     file; it answers as rg searching a map does, the same on every host. So on macOS a
//                     named binary's answer is Linux native's, not macOS native's (early.dat: lines 1 and 3,
//                     bytes_searched 19, where macOS native says 1 and 4, 40): THE ONE WRITTEN PLATFORM
//                     DIVERGENCE, its macOS literals kept as the record (scripts/lib/rg-probe.cjs
//                     MMAP_EVERYWHERE, test/rg-native.test.cjs P8_MACOS_DIVERGENCE).
// A NUL in rg's TEXT counts (a UTF-16 file's decoded U+0000, not the zero bytes of its code units).
// NOT MODELLED (named, BACKLOG): rg's line buffer is one per searching thread and keeps its grown size
// for the next file that thread searches; quaude's rg starts every file at 64 KiB (native agrees unless
// an earlier file on the same thread held a line longer than 64 KiB). Under -j1 that order is rg's walk,
// which quaude's rg now walks, but carrying the size needs every walked file READ, the ones ugrep finds
// no match in too (rg grows its buffer on any long line it reads), and no upstream tool passes -j1:
// BACKLOG. A UTF-16 read the line buffer's room cuts short is taken to end on a whole character.
const RG_BUFFER = 64 * 1024;          // grep-searcher's DEFAULT_BUFFER_CAPACITY
// The fills hand the loop back every 64 reads OR every FILL_TICK_BYTES read, whichever comes first: with lines of
// hundreds of KB the buffer grows and 64 reads covered a 55 MB file, one yield for all of it (Task 10b fix round;
// counted by searchStats.ticks.fill and .filled, test/rg-native.test.cjs).
const FILL_TICK_BYTES = 1024 * 1024;
const MMAP_MAX_PATHS = 10;            // hiargs.rs: memory maps for at most 10 paths, all files
// How rg searches one target: 'quit' (walked), 'convert' (named or stdin), 'mmap' (named, RG-BINARY-MMAP).
function binaryHow(e, mmap) { return e.walked ? 'quit' : e.stdin || !mmap ? 'convert' : 'mmap'; }
// Whether rg memory-maps this search's named files (RG-BINARY-MMAP): every path (`-` too, as a file of
// that name) a regular file, following symlinks; at most 10. On every host (RG-MMAP-EVERYWHERE).
function mmapsNamedFiles(spec, cwd) {
  if (spec.paths.length > MMAP_MAX_PATHS) return false;
  const fs = require('fs'), path = require('path');
  return spec.paths.every((P) => { try { return fs.statSync(path.resolve(cwd, P)).isFile(); } catch { return false; } });
}
// rg's view of one file: { how, text, read, nul }. text is rg's text (RG-TEXT-BOM) with, for
// RG-BINARY-CONVERT, every NUL a newline; nul the first NUL's offset (-1: none). A file with a BOM is read,
// never mapped (grep-searcher's slice_needs_transcoding).
function rgView(bytes, how, { stdin = false } = {}) {
  const { text, read } = rgTextRead(bytes, { stdin });
  const h = how === 'mmap' && read.kind !== 'plain' ? 'convert' : how;
  const nul = text.indexOf(0);
  if (nul === -1 || h !== 'convert') return { how: h, text, read, nul };
  const conv = Buffer.from(text);
  for (let i = nul; i !== -1; i = conv.indexOf(0, i + 1)) conv[i] = 0x0a;
  return { how: h, text: conv, read, nul };
}
// One read of rg's reader: (at, room) -> how many bytes of the text it hands over (rgTextRead's bounds;
// a UTF-16 read cut short by the room ends on a whole character, one with fewer than 4 bytes of room
// hands over as much of the next character as fits: encoding_rs_io's tiny transcoder).
function rgReader(text, read) {
  let bi = 0;
  return (at, room) => {
    while (bi < read.bounds.length && read.bounds[bi] <= at) bi++;
    const lim = bi < read.bounds.length ? Math.min(read.bounds[bi], text.length) : text.length;
    let n = Math.min(room, lim - at);
    if (read.snap && n < lim - at) {
      if (room < 4) { let e = at + 1; while (e < lim && (text[e] & 0xc0) === 0x80) e++; n = Math.min(room, e - at); }
      else while (n > 0 && (text[at + n] & 0xc0) === 0x80) n--;
    }
    return Math.max(0, n);
  };
}
// lines.rs `preceding`: the start of the line `count` lines before the last line of [from, to).
function precedingStart(t, from, to, count) {
  let pos = to;
  if (pos === from) return from;
  if (t[pos - 1] === 0x0a) pos--;
  for (;;) {
    const ls = lineStart(t, pos, from);
    if (ls === from) return from;
    if (count === 0) return ls;
    if (ls - 1 === from) return from;
    count--; pos = ls - 1;
  }
}
// rg's LineBuffer and ReadByLine over a view, fill by fill, until the fill that meets the first NUL (or
// the end). `visited(from, to)`: the end of the last line rg sank (printed, or context) while searching
// [from, to), -1 for none (what the next roll keeps depends on it). Returns { met: the NUL ended it,
// searched: where the last fill searched before that one ended, from: where that fill's search began,
// bytes: what rg had let go of when it stopped (its absolute_byte_offset), cap: the buffer's size then }.
// `stopAfter`: stop once a fill searched past that offset (-l: rg stops at its first match). `partial`:
// the text is only a prefix of the file, so a read that reaches its end cannot be trusted: { more: true }
// asks for a longer one (a NUL found inside it, or a fill that ended before it, stands). A generator: it
// yields TICK now and then.
function* lineBufferFills(v, { quit, maxContext, visited, cap = RG_BUFFER, stopAfter = -1, partial = false }) {
  const t = v.text, reader = rgReader(t, v.read);
  let A = 0, end = 0, lastLT = 0, at = 0, from = 0, reads = 0, sinceTick = 0;
  for (;;) {
    // core.roll: what the search let go of in the buffer it searched ([A, A + lastLT))
    let consumed = lastLT;
    if (maxContext > 0 && lastLT > 0) {
      const lv = visited(from, A + lastLT);
      consumed = Math.max(precedingStart(t, A, A + lastLT, maxContext) - A, lv < 0 ? 0 : lv - A);
    }
    const oldLen = lastLT, searched = A + lastLT;
    if (stopAfter >= 0 && searched > stopAfter) return { met: false, searched, from: -1, bytes: A, cap };
    A += consumed; end -= consumed; lastLT = end;
    // LineBuffer.fill: read until the new bytes hold a newline, or a NUL ends a quit
    let didread = false, met = false;
    for (;;) {
      if (cap - end === 0) cap += Math.max(1, cap) * 2;
      const n = reader(at, cap - end);
      if (n === 0) { if (partial) return { more: true }; lastLT = end; didread = lastLT > 0; break; }
      const oldend = end;
      end += n; at += n;
      searchStats.filled += n; sinceTick += n;
      if (++reads % 64 === 0 || sinceTick >= FILL_TICK_BYTES) { sinceTick = 0; searchStats.ticks.fill++; yield TICK; }
      if (v.nul !== -1 && v.nul < A + end) {
        met = true;
        if (quit) { end = v.nul - A; lastLT = end; break; }
      }
      if (partial && at === t.length) return { more: true };
      const ls = lineStart(t, A + end, A + oldend);
      if (ls > A + oldend) { lastLT = ls - A; didread = true; break; }
    }
    if (met) return { met: true, searched, from: searched, bytes: A, cap };
    if (!didread) return { met: false, searched, from: -1, bytes: A, cap };
    if (consumed === 0 && oldLen === lastLT) return { met: false, searched, from: -1, bytes: A + oldLen, cap };
    from = searched;
  }
}
// -l on a walked file (RG-BINARY-QUIT): rg stops at the file's first match, so whether it lists the file
// depends only on the bytes up to the end of the fill that holds that match, or the NUL that comes first.
// Those are read, a prefix of the file doubled until the fills decide, never the whole of a large file
// (Task 8 review I-1: reading every listed file whole took an 800 MB log from 10 MB of memory to 814,
// and a 3 GiB one failed outright where native answers in milliseconds). true when rg lists it.
function* walkedListed(file, cwd, m, spec) {
  const fs = require('fs'), path = require('path');
  const fd = fs.openSync(path.resolve(cwd || process.cwd(), file), 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const maxContext = Math.max(spec.before, spec.after);
    // a UTF-16 file's text is about half its bytes, so twice the match's offset, and two fills more
    let want = Math.min(size, 2 * m[0].end + 2 * RG_BUFFER);
    for (;;) {
      const b = Buffer.alloc(want);
      let n = 0;
      for (let r; n < want && (r = fs.readSync(fd, b, n, want - n, n)) > 0;) n += r;
      searchStats.read += n;
      const partial = n < size, v = rgView(b.subarray(0, n), 'quit');
      if (!partial && v.nul === -1) return true;
      if (m[0].start < v.text.length) {
        const sel = yield* selectedLines(v.text, [m[0]]);
        const pairs = maxContext > 0 ? yield* sunkLines(v.text, sel, spec) : [];
        const f = yield* lineBufferFills(v, { quit: true, maxContext, visited: visitedIn(pairs), partial, stopAfter: sel[0].ls });
        if (!f.more) return !f.met || f.searched > sel[0].ls;
      }
      want = Math.min(size, want * 2);
    }
  } finally { fs.closeSync(fd); }
}
// The lines rg sinks, in order, as [where they are searched from, end of the line]: a match and its
// before-context at the match, an after-context line at itself (RG-CONTEXT, eachPrintedLine).
function* sunkLines(text, sel, spec) {
  const out = [];
  let n = 0;
  for (const ev of eachPrintedLine(text, sel, spec)) {
    if (ev === GAP) continue;
    const le = lineEndAt(text, ev.ls);
    out.push(ev.at, le < text.length ? le + 1 : le);
    if (++n % TICK_EVERY === 0) { searchStats.ticks.sunk++; yield TICK; }
  }
  return out;
}
// visited() for lineBufferFills over sunkLines' pairs: the regions it asks about ascend.
function visitedIn(pairs) {
  let i = 0;
  return (from, to) => {
    let last = -1;
    while (i < pairs.length && pairs[i] < to) { if (pairs[i] >= from) last = pairs[i + 1]; i += 2; }
    return last;
  };
}
// What rg's binary detection makes of one file's search: { squash } (-c prints nothing), or { text, sel,
// bin } with text and sel cut to what rg searched (RG-BINARY-QUIT), and bin what the printers report:
// { offset (the NUL, -1 until RG-BINARY-MMAP finds one), bytes (bytes_searched), quit, stopAt (the
// standard printer's RG-BINARY-CONVERT stop), mmap, window }. null when the text holds no NUL.
function* binaryOutcome(v, sel, spec) {
  if (v.nul === -1) return { text: v.text, sel, bin: null };
  const maxContext = Math.max(spec.before, spec.after);
  const fills = function* () {
    const pairs = maxContext > 0 ? yield* sunkLines(v.text, sel, spec) : [];
    return yield* lineBufferFills(v, { quit: v.how === 'quit', maxContext, visited: visitedIn(pairs) });
  };
  if (v.how === 'quit') {
    if (spec.mode === 'count') return { squash: true };
    const f = yield* fills();
    return { text: v.text.subarray(0, f.searched), sel: sel.filter((L) => L.ls < f.searched), bin: { offset: v.nul, bytes: f.bytes, quit: true } };
  }
  if (v.how === 'convert') {
    const stopAt = spec.mode === 'standard' ? (yield* fills()).from : -1;
    return { text: v.text, sel, bin: { offset: v.nul, bytes: v.text.length, stopAt } };
  }
  const window = v.nul < Math.min(v.text.length, RG_BUFFER);
  return { text: v.text, sel, bin: { offset: window ? v.nul : -1, mmap: true, window } };
}
// RG-BINARY-MMAP's look inside each line rg prints: (ls, end) -> the first NUL in [ls, end), or -1. Lines
// come in ascending order, so the text is scanned once.
function nulFinder(text) {
  let next = -2;
  return (ls, end) => {
    if (next === -1) return -1;
    if (next < ls) next = text.indexOf(0, ls);
    return next !== -1 && next < end ? next : -1;
  };
}
// The standard printer's last line for a file with binary data (grep-printer's write_binary_message).
const binaryMessage = (bin, path, off) => Buffer.from(`${path ? path + ': ' : ''}${bin.quit ? 'WARNING: stopped searching binary file after match' : 'binary file matches'}`
  + ` (found "${BACKSLASH}0" byte around offset ${off})\n`);

// Every line of `text` decided by the matcher alone: stdin, and matchFilesAlone.
function matchTextLines(text, t, deadline, first) { return decideLines(text, candidateLines(text, null, true), t, deadline, first); }
// matchFilesAlone(files, pattern, opts) -> Map: the same answer as ugrepMatches with no ugrep, every
// line of every file decided by the matcher (slower; what stdin always takes).
function matchFilesAlone(files, pattern, opts = {}) {
  const t = translated(pattern, opts);
  if (t.multiLine) return new Map(files.map((f) => [f, PROPOSED]));
  const out = new Map();
  for (const f of files) {
    if (out.has(f)) continue;
    const m = matchTextLines(rgText(readRgBytes(f, opts.cwd)), t, opts.deadline, opts.first);
    if (m.length) out.set(f, m);
  }
  return out;
}

// ---- rg's printers -------------------------------------------------------------------------------
const NL = Buffer.from('\n');
const SEP = Buffer.from('--\n');
const OMITTED_MATCH = Buffer.from('[Omitted long matching line]');
const OMITTED_CONTEXT = Buffer.from('[Omitted long context line]');
// A file's selected lines: [{ ls, ms }] ascending, ms its printable matches. RG-RE-MATCH-AT-
// UNTERMINATED-END: the matcher's match at the end of an unterminated last line selects that line and
// is never printed or counted (rg's printers drop an empty match at the end of a line's bytes).
// LINEAR in the text: the matches ascend, so a match at or before the current line's terminator is on
// that line, and a later one's line start is found scanning back no further than that terminator
// (scanning back from every match to its line's start was quadratic on a minified line).
function* selectedLines(text, matches) {
  let n = 0;
  const unterminated = text.length > 0 && text[text.length - 1] !== 0x0a;
  const sel = [];
  let L = null, le = -1;
  for (const m of matches) {
    if (!L || m.start > le) {
      const ls = lineStart(text, m.start, le + 1);
      L = { ls, ms: [] }; sel.push(L);
      le = lineEndAt(text, ls);
    }
    if (!(unterminated && m.start === text.length)) L.ms.push(m);
    if (++n % SLICE_LINES === 0) { searchStats.ticks.select++; yield TICK; }
  }
  return sel;
}
// RG-CONTEXT, stated once for every printer: each selected line with spec.before lines before it and
// spec.after after it, merged where they meet. Yields { ls, num, L, at } for every line printed, in order (L
// the selected line, null for a context line; `at` where rg's search was when it printed the line: an
// after-context line's own start, a before-context line's match's, RG-BINARY-QUIT's and -CONVERT's fills),
// and GAP before a line that does not follow the one printed before it in this file (and before the first).
const GAP = { gap: true };
function* eachPrintedLine(text, sel, spec, firstNum = 1) {
  const next = (ls) => { const i = text.indexOf(0x0a, ls); return i === -1 || i + 1 >= text.length ? -1 : i + 1; };
  const prev = (ls) => (ls === 0 ? -1 : ls < 2 ? 0 : text.lastIndexOf(0x0a, ls - 2) + 1);
  // Line numbers, counted forward once, from the number of the text's first line (a window's, streamed).
  let at = 0, atNum = firstNum;
  const numAt = (ls) => { for (let i = text.indexOf(0x0a, at); i !== -1 && i < ls; i = text.indexOf(0x0a, i + 1)) atNum++; at = ls; return atNum; };
  let cur = -1, curNum = 0, pend = 0;
  const drainAfter = (upTo) => {
    const got = [];
    for (let nx; pend > 0 && (nx = next(cur)) !== -1 && (upTo === -1 || nx < upTo); pend--) { got.push({ ls: nx, num: curNum + 1, L: null, at: nx }); cur = nx; curNum++; }
    return got;
  };
  for (const L of sel) {
    const n = numAt(L.ls);
    yield* drainAfter(L.ls);
    let first = L.ls, firstNum = n;
    for (let k = 0, p; k < spec.before && (p = prev(first)) !== -1 && (cur === -1 || p > cur); k++) { first = p; firstNum--; }
    if (cur === -1 || next(cur) !== first) yield GAP;
    for (let ls = first, num = firstNum; ls !== L.ls; ls = next(ls), num++) yield { ls, num, L: null, at: L.ls };
    yield { ls: L.ls, num: n, L, at: L.ls };
    cur = L.ls; curNum = n; pend = spec.after;
  }
  yield* drainAfter(-1);
}
// WHAT THE LAST SEARCH DID, counted: the tests' instrument (test/rg-native.test.cjs), because an
// operation count holds on any host under any load, where a wall-clock bound does not (Task 7 re-review
// I-1, M1). printed: the bytes the printers produced, before any caller truncated them (the search stops
// once past the caller's maxBuffer); scannedBack: the bytes stepped over finding lines' starts (linear:
// a bounded multiple of the text's length, see test/rg-native.test.cjs); read: the bytes -l read of
// walked files (walkedListed's prefixes).
// TEST-ONLY, AND MODULE-GLOBAL: one object for the whole process, reset by every search as it starts,
// so two searches running at once (the async twin yields mid-search) clobber each other's counts. It is
// an instrument for a test that runs one search at a time, never an answer: no production consumer may
// read or trust it.
// ticks: how often a listing's three stages handed control back (the walk, RG-SORT-MODIFIED's stat, the printing):
// counted, so a stage that stops yielding is seen however fast this host is (fix round 2, review N3).
const searchStats = { printed: 0, scannedBack: 0, read: 0, filled: 0, ticks: { walk: 0, sort: 0, list: 0, fill: 0, select: 0, sunk: 0 } };
// The start of the line holding offset `at`, stepping back no further than `floor` (the start of the
// first line it could be: the one after the last line taken). Every printer and the candidate lines find
// line starts HERE, so searchStats.scannedBack counts every step.
// The engine's own backward search does the stepping (a byte loop in JS took 891 ms over 50 MB under
// tjs, holding the event loop for a fill; lastIndexOf takes 16 ms: Task 8 review I-2).
function lineStart(text, at, floor) {
  const ls = at > floor ? floor + text.subarray(floor, at).lastIndexOf(0x0a) + 1 : at;
  searchStats.scannedBack += at - ls;
  return ls;
}
// How often a printer hands control back (TICK: the asynchronous twin yields the event loop there once
// its slice is spent, the synchronous one checks its deadline), in lines or matches printed.
const TICK = { op: 'tick' }, TICK_EVERY = 256;
// What a search prints, written into one growing buffer as it goes (its length is what stops a search
// past the caller's maxBuffer; a list of every piece, concatenated at the end, held the loop a second
// for the 5 million pieces of -n -o over 200,000 lines). With a `sink` (a command's stdout: rg-entry.cjs) it
// is handed on as it goes instead, every 64 KiB and at each flush(), as rg writes as it searches; the sink
// throwing (a reader that went away) ends the search there. len counts everything printed either way.
const OUT_FLUSH = 64 * 1024;
function outBuffers(sink) {
  let w = new ByteWriter(OUT_FLUSH), handed = 0;
  // what the sink throws is the caller's (marked, so no search reads it as a file's error)
  const flush = () => {
    if (!sink || !w.len) return;
    const b = w.done(); handed += b.length; w = new ByteWriter(OUT_FLUSH);
    try { sink(b); } catch (e) { if (e && typeof e === 'object') e.fromSink = true; throw e; }
  };
  return {
    get len() { return handed + w.len; },
    push(...bs) { for (const b of bs) w.bytes(b); if (sink && w.len >= OUT_FLUSH) flush(); },
    flush,
    done: () => { if (!sink) return w.done(); flush(); return Buffer.alloc(0); },
  };
}
// A line's end: the index of its \n, or the text's end.
function lineEndAt(text, ls) { const i = text.indexOf(0x0a, ls); return i === -1 ? text.length : i; }

// One file's (or stdin's) output into `out` (outBuffers): true when rg found something in it.
// `state.printed` carries "something was printed before" across files (RG-CONTEXT's `--`); `state.json`
// the JSON printer's running totals (its summary); `state.limit` the caller's maxBuffer, past which it
// stops (Task 7 review I2: what execFile would kill the child for). e.sel: the file's selected lines
// (selectedLines), cut to what rg searched; e.bin: binaryOutcome's report, null for text; neither for a
// -l whose file was not read. A generator: it yields TICK.
function* printFile(spec, e, out, state) {
  const { text } = e;
  if (spec.mode === 'files') {
    if (e.sel && !e.sel.length) return false;
    out.push(Buffer.from(e.disp + (spec.nul ? '\0' : '\n')));
    return true;
  }
  const sel = e.sel;
  if (!sel.length) return false;
  // A file with a selected line prints its count, even a -c -o count of 0 (its only match was the
  // unprintable one at an unterminated end: native prints `0`); a file with none prints nothing.
  if (spec.mode === 'count') { printCount(spec, e, out, countOf(spec, sel)); return true; }
  const p = linePrinter(spec, e, out, state, e.bin);
  for (const ev of eachPrintedLine(text, sel, spec)) if (!(yield* p.event(ev, text, 0))) break;
  return yield* p.end(text.length);
}
// -c's count of a file's selected lines (-c -o: of their printable matches), and its line.
const countOf = (spec, sel) => (spec.countMatches ? sel.reduce((a, L) => a + L.ms.length, 0) : sel.length);
function printCount(spec, e, out, n) {
  out.push(...(e.withFilename ? [Buffer.from(e.disp), Buffer.from(spec.nul ? '\0' : ':')] : []), Buffer.from(`${n}\n`));
}
// THE PRINTERS OF LINES, stated once for the whole-text search (printFile) and the streamed one (streamEntry):
// the standard printer and the JSON printer, fed eachPrintedLine's events in order, a window of the file at a
// time. event(ev, text, base): `text` holds the event's line, `base` is the text's offset in the file (rg's
// absolute_offset); false once the printer stopped (RG-BINARY-*'s stop, or the caller's maxBuffer). end(textLen)
// writes what follows the last line (the binary message; JSON's end message, textLen the file's whole text)
// and answers whether rg found something. `bin` (binaryOutcome's report, null for text) may be set later, by
// setBin, before the events it governs (streamEntry learns of a NUL as it reads).
function linePrinter(spec, e, out, state, bin) {
  return spec.mode === 'json' ? jsonPrinter(spec, e, out, state, bin) : standardPrinter(spec, e, out, state, bin);
}
function standardPrinter(spec, e, out, state, binAt) {
  let bin = binAt;
  const path = e.withFilename ? Buffer.from(e.disp) : null;
  const cols = spec.maxColumns;
  const prefix = (num, sep) => {
    const p = [];
    if (path) p.push(path, Buffer.from(spec.nul ? '\0' : sep));
    if (spec.lineNumber) p.push(Buffer.from(`${num}${sep}`));
    return p;
  };
  const ctx = spec.before > 0 || spec.after > 0;
  // RG-BINARY-CONVERT and RG-BINARY-MMAP: the first line rg would print once it has seen binary data
  // ends the file (a match among them counts toward its last line); RG-BINARY-MMAP finds a NUL past its
  // first 64 KiB in the lines it prints.
  let off = bin ? bin.offset : -1;
  let nulIn = null, nulText = null;
  const stops = (ev, text) => {
    if (!bin) return false;
    if (bin.stopAt >= 0) return ev.at >= bin.stopAt;
    if (!bin.mmap) return false;
    if (bin.window) return true;
    if (off !== -1) return true;
    if (nulText !== text) { nulIn = nulFinder(text); nulText = text; }
    const le = lineEndAt(text, ev.ls), z = nulIn(ev.ls, le < text.length ? le + 1 : le);
    if (z !== -1) off = z + ev.base;
    return z !== -1;
  };
  // `--` before a group: between files only once the file prints a line (grep-printer's search
  // separator), inside a file at once (the searcher's context break, written before the line it precedes
  // is judged). A GAP is acted on at the line it precedes: nothing it reads changes between the two.
  let n = 0, matches = 0, wrote = false, pendingSep = false, gap = false, done = false;
  return {
    setBin(b) { bin = b; off = b ? b.offset : -1; },
    *event(ev, text, base) {
      if (done) return false;
      if (ev === GAP) { gap = true; return true; }
      if (gap) { gap = false; if (ctx && state.printed) { if (wrote) out.push(SEP); else pendingSep = true; } }
      const { ls, num, L } = ev;
      if (stops({ ...ev, base }, text)) { if (L) matches++; done = true; return false; }
      if (pendingSep) { out.push(SEP); pendingSep = false; }
      wrote = true;
      const ms = L && L.ms;
      const sep = ms ? ':' : '-';
      if (ms) { state.printed = true; matches++; }
      if (ms && spec.only && ms.length) {
        for (const m of ms) {
          out.push(...prefix(num, sep), cols && m.end - m.start > cols ? OMITTED_MATCH : text.subarray(m.start, m.end), NL);
          if (out.len > state.limit) { done = true; return false; }
          if (++n % TICK_EVERY === 0) yield TICK;
        }
        return true;
      }
      const le = lineEndAt(text, ls), end = le < text.length ? le + 1 : le;
      if (cols && end - ls > cols) out.push(...prefix(num, sep), ms ? OMITTED_MATCH : OMITTED_CONTEXT, NL);
      else { out.push(...prefix(num, sep), text.subarray(ls, end)); if (end === le) out.push(NL); }
      if (out.len > state.limit) { done = true; return false; }
      if (++n % TICK_EVERY === 0) yield TICK;
      return true;
    },
    // eslint-disable-next-line require-yield
    *end() {
      if (bin && off !== -1 && matches > 0) { out.push(binaryMessage(bin, e.withFilename ? e.disp : null, off)); state.printed = true; }
      return matches > 0;
    },
    get matches() { return matches; },
  };
}

// ---- rg's JSON Lines printer (grep-native Task 7) -------------------------------------------------
// grep-printer 0.2.2's JSON sink and ripgrep 14.1.1's summary (read from the crates), every rule
// measured against native 2.1.283 and pinned by test/rg-native.test.cjs's P7 rows:
//   RG-JSON          per file with a selected line: `begin`, a `match` per selected line (`context`
//                    around them), `end` with the file's stats; then ONE `summary` after every file,
//                    whatever was found (rc 1 and rc 2 too). line_number unless -N (null then); the
//                    path always (-H, --no-filename and --null change nothing); --max-columns changes
//                    nothing. A match's `lines` are its line's bytes with their terminator,
//                    `absolute_offset` the line's offset into rg's text, `submatches` every match on
//                    it (start/end from the line's start). The end's stats: searches 1,
//                    searches_with_match 1, bytes_searched the text's length (the whole file, as
//                    rg's decoder gave it), bytes_printed the bytes of this file's begin, match and
//                    context messages, matched_lines, matches; the summary sums the files that printed
//                    (a file with no match adds nothing) with serde_json's sorted keys, elapsed_total
//                    the whole run. Elapsed times are wall-clock readings (rg-probe.cjs normalizes
//                    them, its one named --json normalization).
//   RG-JSON-CONTEXT  a context line is a `context` message, submatches []; groups are not separated
//   RG-JSON-BYTES    `lines`, a submatch's `match` and `path` are {"text": ...} when they are UTF-8
//                    (Rust's str::from_utf8), else {"bytes": standard base64 with padding}
//   RG-JSON-ESCAPE   serde_json: `"` and `\` escaped, \b \f \n \r \t, every other C0 control as
//                    \u00XX in lowercase hex; DEL and everything at or above U+0080 raw
//   RG-JSON-ONLY-MATCHING  -o changes nothing
// The bytes a JSON message is written into, grown by doubling: one buffer per file, so printing every
// match of a minified line costs no allocation per match (building each piece as its own Buffer took
// 25 s under tjs for the 5 MB line test/rg-native.test.cjs times; native ~100 ms).
class ByteWriter {
  constructor(n = 4096) { this.buf = Buffer.alloc(n); this.len = 0; }
  room(n) {
    if (this.len + n <= this.buf.length) return;
    const b = Buffer.alloc(Math.max(this.buf.length * 2, this.len + n));
    this.buf.copy(b, 0, 0, this.len);
    this.buf = b;
  }
  ascii(str) { this.room(str.length); for (let i = 0; i < str.length; i++) this.buf[this.len++] = str.charCodeAt(i); }
  bytes(b, from = 0, to = b.length) { this.room(to - from); b.copy(this.buf, this.len, from, to); this.len += to - from; }
  done() { return this.buf.subarray(0, this.len); }
}
// RG-JSON-ESCAPE: what serde_json writes for each byte it escapes (nothing else is escaped).
const BACKSLASH = String.fromCharCode(0x5c);
const JSON_ESCAPE = [];
for (let c = 0; c < 0x20; c++) JSON_ESCAPE[c] = BACKSLASH + 'u00' + c.toString(16).padStart(2, '0');
for (const [c, e] of [[0x22, '"'], [0x5c, BACKSLASH], [0x08, 'b'], [0x0c, 'f'], [0x0a, 'n'], [0x0d, 'r'], [0x09, 't']]) JSON_ESCAPE[c] = BACKSLASH + e;
// Rust's str::from_utf8: shortest forms only, no surrogates, nothing past U+10FFFF. utf8Step checks
// the sequences that START before `stop` (none may run past `end`): the index after them, or -1.
function isUtf8(b, i, end) { return utf8Step(b, i, end, end) !== -1; }
function utf8Step(b, i, end, stop) {
  while (i < stop) {
    const c = b[i];
    if (c < 0x80) { i++; continue; }
    const n = c >= 0xc2 && c <= 0xdf ? 1 : c >= 0xe0 && c <= 0xef ? 2 : c >= 0xf0 && c <= 0xf4 ? 3 : 0;
    if (n === 0 || i + n >= end) return -1;
    const c1 = b[i + 1];
    const lo = c === 0xe0 ? 0xa0 : c === 0xf0 ? 0x90 : 0x80, hi = c === 0xed ? 0x9f : c === 0xf4 ? 0x8f : 0xbf;
    if (c1 < lo || c1 > hi) return -1;
    for (let k = 2; k <= n; k++) if (b[i + k] < 0x80 || b[i + k] > 0xbf) return -1;
    i += n + 1;
  }
  return i;
}
// RG-JSON-BYTES: grep-printer's Data, written into `w`: {"text": the bytes, escaped} when they are
// UTF-8, else {"bytes": standard base64}.
function jsonData(w, b, from = 0, to = b.length) { drain(jsonDataGen(w, b, from, to)); }
// The same as a generator that yields every JSON_SLICE bytes, for a whole line (a minified 5 MB line
// held the loop a second in one call under tjs: Task 7 review I2).
const JSON_SLICE = 64 * 1024;
function* jsonDataGen(w, b, from = 0, to = b.length) {
  let i = from;
  while (i < to) {
    i = utf8Step(b, i, to, Math.min(to, i + JSON_SLICE));
    if (i === -1) { w.ascii(`{"bytes":"${Buffer.from(b.subarray(from, to)).toString('base64')}"}`); return; }
    if (i < to) yield;
  }
  w.ascii('{"text":"');
  let run = from;
  for (let s0 = from; s0 < to; s0 += JSON_SLICE) {
    const e0 = Math.min(to, s0 + JSON_SLICE);
    for (let k = s0; k < e0; k++) {
      const c = b[k];
      if (c >= 0x20 && c !== 0x22 && c !== 0x5c) continue;
      if (run < k) w.bytes(b, run, k);
      w.ascii(JSON_ESCAPE[c]);
      run = k + 1;
    }
    if (e0 < to) yield;
  }
  if (run < to) w.bytes(b, run, to);
  w.ascii('"}');
}
// A wall-clock reading in ns, and grep-printer's NiceDuration of a span of them: its own field order,
// or serde_json's sorted one (the summary's).
const clockNs = () => (typeof performance !== 'undefined' && performance.now ? Math.round(performance.now() * 1e6) : Date.now() * 1e6);
function jsonDuration(ns, sorted) {
  const secs = Math.floor(ns / 1e9), nanos = Math.round(ns - secs * 1e9), human = `${(ns / 1e9).toFixed(6)}s`;
  return sorted ? `{"human":"${human}","nanos":${nanos},"secs":${secs}}` : `{"secs":${secs},"nanos":${nanos},"human":"${human}"}`;
}
// The running totals the summary sums (only files that printed add to them).
const jsonTotals = () => ({ startNs: clockNs(), elapsedNs: 0, searches: 0, withMatch: 0, bytesSearched: 0, bytesPrinted: 0, matchedLines: 0, matches: 0 });
function jsonPrinter(spec, e, out, state, binAt) {
  let bin = binAt;
  const totals = state.json;
  const t0 = clockNs();
  const pw = new ByteWriter(64);
  jsonData(pw, Buffer.from(e.disp));
  const path = Buffer.from(pw.done());
  // One writer for this file's messages, handed to `out` a window at a time (flush) and at the end;
  // `printed` counts what it held (bytes_printed: the begin, match and context messages).
  let w = new ByteWriter(), printed = 0, begun = false, stopped = false;
  let matchedLines = 0, matches = 0, n = 0;
  // RG-BINARY-*: the end message's binary_offset (RG-BINARY-MMAP: found in the first line printed that
  // holds a NUL, past its first 64 KiB) and bytes_searched.
  let off = bin ? bin.offset : -1;
  let nulIn = null, nulText = null;
  // Past the caller's maxBuffer the rest is never printed: what is written so far goes out, unfinished,
  // as a killed rg's would.
  const full = () => out.len + w.len > state.limit;
  const stop = () => { out.push(w.done()); w = new ByteWriter(); stopped = true; return false; };
  return {
    setBin(b) { bin = b; off = b ? b.offset : -1; },
    flush() { if (w.len) { printed += w.len; out.push(w.done()); w = new ByteWriter(); } },
    *event(ev, text, base) {
      if (stopped) return false;
      if (ev === GAP) return true;
      if (!begun) { begun = true; w.ascii('{"type":"begin","data":{"path":'); w.bytes(path); w.ascii('}}\n'); }
      const { ls, num, L } = ev;
      const le = lineEndAt(text, ls), end = le < text.length ? le + 1 : le;
      if (bin && bin.mmap && off === -1) {
        if (nulText !== text) { nulIn = nulFinder(text); nulText = text; }
        const z = nulIn(ls, end);
        if (z !== -1) off = z + base;
      }
      w.ascii(L ? '{"type":"match","data":{"path":' : '{"type":"context","data":{"path":'); w.bytes(path);
      w.ascii(',"lines":');
      // a line longer than what is left of maxBuffer stops inside it, as a killed rg's output would
      for (const slice of jsonDataGen(w, text, ls, end)) { if (full()) return stop(); yield slice || TICK; }
      w.ascii(`,"line_number":${spec.lineNumber ? num : 'null'},"absolute_offset":${ls + base},"submatches":[`);
      if (L) {
        matchedLines++; matches += L.ms.length;
        for (let i = 0; i < L.ms.length; i++) {
          const m = L.ms[i];
          w.ascii(i ? ',{"match":' : '{"match":'); jsonData(w, text, m.start, m.end); w.ascii(`,"start":${m.start - ls},"end":${m.end - ls}}`);
          if (++n % TICK_EVERY === 0) { if (full()) return stop(); yield TICK; }
        }
      }
      w.ascii(']}}\n');
      if (full()) return stop();
      if (++n % TICK_EVERY === 0) yield TICK;
      return true;
    },
    // eslint-disable-next-line require-yield
    *end(textLen) {
      if (stopped) return begun;
      if (!begun) return false;
      printed += w.len;
      const ns = clockNs() - t0;
      w.ascii('{"type":"end","data":{"path":'); w.bytes(path);
      const searched = !bin ? textLen : bin.mmap ? (off !== -1 ? off : textLen) : bin.bytes;
      w.ascii(`,"binary_offset":${off !== -1 ? off : 'null'},"stats":{"elapsed":${jsonDuration(ns, false)},"searches":1,"searches_with_match":1,"bytes_searched":${searched},`
        + `"bytes_printed":${printed},"matched_lines":${matchedLines},"matches":${matches}}}}\n`);
      out.push(w.done()); w = new ByteWriter(); stopped = true;
      Object.assign(totals, { elapsedNs: totals.elapsedNs + ns, searches: totals.searches + 1, withMatch: totals.withMatch + 1,
        bytesSearched: totals.bytesSearched + searched, bytesPrinted: totals.bytesPrinted + printed,
        matchedLines: totals.matchedLines + matchedLines, matches: totals.matches + matches });
      return true;
    },
  };
}
// ripgrep's summary: serde_json's json! value, so every object's keys are sorted.
function jsonSummary(t) {
  return Buffer.from(`{"data":{"elapsed_total":${jsonDuration(clockNs() - t.startNs, true)},"stats":{"bytes_printed":${t.bytesPrinted},`
    + `"bytes_searched":${t.bytesSearched},"elapsed":${jsonDuration(t.elapsedNs, true)},"matched_lines":${t.matchedLines},"matches":${t.matches},`
    + `"searches":${t.searches},"searches_with_match":${t.withMatch}}},"type":"summary"}\n`);
}

// RG-SPECIAL-FILE / RG-REFUSE-SPECIAL-FILE (Task 6 re-review N1, Task 7 review I1; measured against
// native 2.1.283): what a NAMED special path is to quaude's rg, decided WITHOUT READING IT.
//   - /dev/stdin, /dev/std{out,err}, /dev/fd/N, /proc/self/fd/N (by name, as given or as it resolves)
//     are the rg CHILD's descriptors to native; quaude's rg runs inside its caller, so they would be
//     the CALLER's (an O_NONBLOCK open of /dev/fd/0 on macOS is a dup keeping fd 0's blocking mode: the
//     read held the whole engine). Refused.
//   - RG-PID-FD: /proc/<pid>/fd/N with a NUMERIC pid names the same open file to every process that opens
//     it, rg's child included (the 2.1.283 bundle on Linux names a file it holds open that way, its own
//     pid, for its Grep's single-file searches). So it is a path like any other, classified by what it is
//     below: a regular file or a directory is searched, the rest as the rules here say.
//   - a FIFO: rg reads it until a writer closes it (none: it waits). Refused.
//   - a character device: /dev/null (by identity: its resolved path) is an empty file (rc 1, or the
//     other paths' answer); any other is refused, never read (a nonblocking read of a terminal eats
//     keystrokes typed ahead into a live TUI; /dev/zero native reads until it is killed).
//   - anything else (a socket, a block device) is opened without blocking and closed unread: an open
//     that fails is rg's per-path error (a unix socket: `Operation not supported on socket (os error
//     102)`, the rest answered, rc 2); one that opens is refused (native reads it to its end).
// The type is the engine's Stats' (node-shim's reads the mode bits since Task 7 review I3).
const DESCRIPTOR_PATH = /^\/(?:dev\/(?:std(?:in|out|err)$|fd\/)|proc\/(?:self|thread-self|\d+)\/fd\/)/;
const PID_FD_PATH = /^\/proc\/\d+\/fd\/\d+$/;
// A named path refused as a process's own descriptor (above): a descriptor name, but not a numeric pid's (RG-PID-FD).
const descriptorRefused = (p) => !PID_FD_PATH.test(p) && isDescriptorPath(p);
function isDescriptorPath(p) {
  if (DESCRIPTOR_PATH.test(p)) return true;
  try { return DESCRIPTOR_PATH.test(require('fs').realpathSync(p)); } catch { return false; }
}
function specialKind(p, st) {
  if (st.isFIFO()) return { kind: 'refuse' };
  const fs = require('fs');
  if (st.isCharacterDevice()) {
    let real = null;
    try { real = fs.realpathSync(p); } catch { /* not resolvable: not /dev/null */ }
    return real === '/dev/null' ? { kind: 'empty' } : { kind: 'refuse' };
  }
  const c = fs.constants || {};
  let fd;
  try { fd = fs.openSync(p, (c.O_RDONLY || 0) | (c.O_NONBLOCK || 0)); } catch (e) { return { kind: 'openError', e }; }
  try { fs.closeSync(fd); } catch { /* closed */ }
  return { kind: 'refuse' };
}

// ---- rg's multi-line search (grep-native Task 10) -------------------------------------------------------
// grep-searcher 0.1.14 (searcher/glue.rs MultiLine, searcher/core.rs, lines.rs) and grep-printer 0.2.2
// (json.rs, summary.rs, standard.rs, util.rs find_iter_at_in_context), read from the crates; every rule
// measured against native 2.1.283 and pinned by test/rg-multiline.test.cjs (native's literals):
//   RG-MULTILINE            -U (--multiline) with a pattern that can match a \n, or holds ^ or $ (rg-regex.cjs
//                           canMatchNewline): rg reads the whole text (RG-TEXT-BOM's) and searches it with its
//                           multi-line searcher. Each search is one leftmost-first find over the text from where
//                           the last match ended (pos), the haystack STARTING THERE (so ^ and \b see no byte
//                           before it: RG-MULTILINE-SLICE); an empty match moves pos one byte on. Each match is
//                           widened to its whole lines (lines::locate: a match ending just after a \n ends
//                           there), and a match whose lines touch or overlap the last one's grows that block;
//                           a block is printed once the next match lies past it, or at the end. --multiline-
//                           dotall (only under -U) makes `.` match \n, as (?s) does.
//   RG-MULTILINE-LINE-MODE  any other pattern under -U is searched line by line, as without -U (grep-searcher's
//                           multi_line_with_matcher: \n is in the pattern's non-matching bytes)
//   RG-MULTILINE-PRINTED    what the printers find in a block is found again, as grep-printer finds it: from the
//                           block's start, the haystack the text from its START up to 128 bytes past the block
//                           (MAX_LOOK_AHEAD), stopping at the first match that starts at or past the block's end.
//                           --json: ONE match message per block, `lines` its bytes, line_number its first line's,
//                           submatches those matches (offsets from the block's start), matched_lines the block's
//                           line count; context messages per line. -c (and -c -o) counts those matches, not lines;
//                           -l lists the file when the FIRST block holds one (and stops there); a file whose
//                           count is 0 prints nothing. The standard printer prints each line of a block as a
//                           match (`:`), numbered from its first; -o each match's part of each line it spans.
//                           A re-found match can reach past its block (the searcher's slice saw a `^` the printer's
//                           haystack does not): --json then slices past the block, and rg PANICS (measured: `rg -U
//                           --json 'a|^b|b\nc\nd'` over `ab\nc\nd\n`, "range end index 6 out of range for slice of
//                           length 3", no exit status); quaude's rg refuses that search by name. -c, -l, -o and the
//                           standard printer answer it, as rg's do.
//   RG-MULTILINE-CONTEXT    -A/-B/-C count lines from a block's first line back and its last line on (core.rs
//                           before_context_by_line / after_context_by_line), `--` between groups that do not touch
//   RG-MULTILINE-BINARY     rg looks for a NUL in the text's first 64 KiB before it searches, then in each block
//                           and context line it is about to print. A WALKED file (quit): a NUL in the first 64 KiB
//                           ends it unsearched (nothing printed); one found later ends the search before that
//                           block, -c printing nothing for the file. A NAMED file or stdin: the search goes on
//                           (no NUL is a line break here: rg converts only what it reads through its line
//                           buffer), and the standard printer stops at the first block or line it would print once
//                           one was found, ending `binary file matches (found "\0" byte around offset N)`.
//                           --json: binary_offset the NUL found, bytes_searched it when it lies before where the
//                           search stopped, else where it stopped.
//   RG-NEWLINE-NEEDS-U      without -U a pattern that can match only \n where a class stands (`a\nb`, `[\n]`,
//                           `\x0a`, a literal newline) is rg's own error: rc 2, its two-paragraph message, nothing
//                           searched
// Bounded as the line searcher is: one step budget per file (RG-RE-REFUSE-COST: twice lineStepBudget of
// the text, its finds and the printers' together), every search run in slices (the async twin yields the
// loop between them), and the caller's maxBuffer stops the printing.
const MAX_LOOK_AHEAD = 128;           // grep-printer lib.rs
const NEWLINE_NEEDS_U = Buffer.from(`rg: the literal "${BACKSLASH}n" is not allowed in a regex\n\n`
  + 'Consider enabling multiline mode with the --multiline flag (or -U for short).\n'
  + 'When multiline mode is enabled, new line characters can be matched.\n');
// One search, leftmost-first, of the haystack [from, end) at `at` (opts: matchIter's), run in slices.
function* mlRun(text, from, end, t, opts) {
  const it = rgRegexModule().matchIter(text, from, end, t, opts);
  let r;
  while ((r = it.run(DECIDE_SLICE_STEPS)) === null) yield TICK;
  return r;
}
// RG-MULTILINE-PRINTED: find_iter_at_in_context over a block [s, e).
function* mlPrinted(text, s, e, t, budget) {
  return yield* mlRun(text, 0, Math.min(text.length, e + MAX_LOOK_AHEAD), t, { at: s, stopAt: e, budget });
}
// The number of lines of [s, e) (grep-searcher's LineIter: a last line without a \n counts).
function mlLineCount(text, s, e) {
  let n = 0;
  for (let i = text.indexOf(0x0a, s); i !== -1 && i < e; i = text.indexOf(0x0a, i + 1)) n++;
  return e > s && text[e - 1] !== 0x0a ? n + 1 : n;
}
// The lines of [s, e), each [ls, le) with le past its \n (lines.rs LineStep).
function* mlLines(text, s, e) {
  for (let ls = s; ls < e;) {
    const nl = text.indexOf(0x0a, ls);
    const le = nl === -1 || nl >= e ? e : nl + 1;
    yield [ls, le];
    ls = le;
  }
}
// grep-searcher's MultiLine over `text`, into `sink` (the printer: matched / context / contextBreak /
// binaryData / finish, each as grep-printer's Sink does). quit: a walked file (RG-MULTILINE-BINARY).
function* multilineSearch(text, t, spec, sink, quit) {
  const len = text.length;
  const total = 2 * rgRegexModule().lineStepBudget(len);
  const budget = { left: total, total, what: `a multi-line search of ${len} bytes` };
  sink.budget = budget;
  let pos = 0, binOff = -1, lastVisited = 0, afterLeft = 0, hasSunk = false, lastMatch = null;
  let lineNo = 1, counted = 0;
  const anyCtx = spec.before > 0 || spec.after > 0;
  const countLines = (upto) => {
    if (counted >= upto) return;
    for (let i = text.indexOf(0x0a, counted); i !== -1 && i < upto; i = text.indexOf(0x0a, i + 1)) lineNo++;
    counted = upto;
  };
  // the first NUL at or after p, cached (the places asked about mostly ascend)
  let nulFrom = 0, nulAt = text.indexOf(0);
  const nulAtOrAfter = (p) => {
    if (!(p >= nulFrom && (nulAt === -1 || p <= nulAt))) { nulFrom = p; nulAt = text.indexOf(0, p); }
    return nulAt;
  };
  // core.rs detect_binary: true when the search must stop
  const detectBinary = (s, e) => {
    if (binOff !== -1) return quit;
    const i = nulAtOrAfter(s);
    if (i === -1 || i >= e) return false;
    binOff = i;
    sink.binaryData(i);
    return quit;
  };
  const sinkBreak = function* (start) { if (anyCtx && hasSunk && lastVisited < start) yield* sink.contextBreak(); };
  const coreMatched = function* (s, e) {
    if (detectBinary(s, e)) return false;
    yield* sinkBreak(s);
    countLines(s);
    if (!(yield* sink.matched(s, e, lineNo))) return false;
    lastVisited = e; afterLeft = spec.after; hasSunk = true;
    return true;
  };
  const contextLine = function* (s, e, after) {
    if (detectBinary(s, e)) return false;
    countLines(s);
    if (!(yield* sink.context(s, e, lineNo))) return false;
    lastVisited = e; hasSunk = true;
    if (after) afterLeft--;
    return true;
  };
  const afterContext = function* (upto) {
    if (afterLeft === 0) return true;
    for (const [ls, le] of mlLines(text, lastVisited, upto)) {
      if (!(yield* contextLine(ls, le, true))) return false;
      if (afterLeft === 0) break;
    }
    return true;
  };
  const beforeContext = function* (upto) {
    if (spec.before === 0 || lastVisited >= upto) return true;
    for (const [ls, le] of mlLines(text, precedingStart(text, lastVisited, upto, spec.before - 1), upto)) {
      yield* sinkBreak(ls);
      if (!(yield* contextLine(ls, le, false))) return false;
    }
    return true;
  };
  const sinkContext = function* (r) { return (yield* afterContext(r.s)) && (yield* beforeContext(r.s)); };
  const sinkMatched = function* (r) { return r.s === r.e ? false : yield* coreMatched(r.s, r.e); };
  // lines.rs locate, linear over a text of many matches: a match's line start is searched for only over the
  // bytes since the last match's start (none of which held a \n back to that match's line start: review I-2 of
  // the fix round, each match had rescanned its whole line), line ends cached
  let lsFloor = 0, scanTo = 0, nlFrom = 0, nlAt = -2;
  const nlAtOrAfter = (p) => {
    if (!(nlAt !== -2 && p >= nlFrom && (nlAt === -1 || p <= nlAt))) { nlFrom = p; nlAt = text.indexOf(0x0a, p); }
    return nlAt;
  };
  const locate = (m) => {
    // matches ascend, so [scanTo, m.start) is new; a \n in it starts the line after it, else lsFloor stands
    const back = lineStart(text, m.start, scanTo);
    const ls = back > scanTo ? back : lsFloor;
    lsFloor = ls; scanTo = m.start;
    let le;
    if (m.end > ls && text[m.end - 1] === 0x0a) le = m.end;
    else { const nl = nlAtOrAfter(m.end); le = nl === -1 ? len : nl + 1; }
    return { s: ls, e: le };
  };
  const step = function* () {
    const found = yield* mlRun(text, pos, len, t, { once: true, budget });
    if (!found.length) { pos = len; return true; }
    const m = found[0];
    pos = m.end;
    if (m.start === m.end && pos < len) pos++;
    const line = locate(m);
    if (!lastMatch) { lastMatch = line; return true; }
    if (lastMatch.e >= line.s) { lastMatch = { s: lastMatch.s, e: line.e }; return true; }
    const prev = lastMatch;
    lastMatch = line;
    if (!(yield* sinkContext(prev))) return false;
    return yield* sinkMatched(prev);
  };
  if (!detectBinary(0, Math.min(len, RG_BUFFER))) {
    let keep = true, finds = 0;
    while (pos < len && keep) {
      keep = yield* step();
      // a text of many short blocks hands the loop back too, not only a long find (mlRun's slices)
      if (++finds % TICK_EVERY === 0) yield TICK;
    }
    if (keep && lastMatch) {
      const lm = lastMatch;
      lastMatch = null;
      if (yield* sinkContext(lm)) yield* sinkMatched(lm);
    }
    if (keep) yield* afterContext(len);
  }
  yield* sink.finish(binOff !== -1 && binOff < pos ? binOff : pos, binOff);
}
// The printers, as grep-printer's sinks over the multi-line searcher (RG-MULTILINE-PRINTED). Each returns a
// sink for multilineSearch; found() says whether rg counts the file as a match (its exit status).
function mlSink(spec, e, text, t, out, state, quit) {
  const sink = { budget: null, *contextBreak() {}, binaryData() {} };
  const printed = (s, e2) => mlPrinted(text, s, e2, t, sink.budget);
  const full = () => out.len > state.limit;
  if (spec.mode === 'files' || spec.mode === 'count') {
    let count = 0;
    sink.matched = function* (s, e2) { count += (yield* printed(s, e2)).length; return spec.mode !== 'files'; };
    sink.context = function* () { return true; };
    sink.finish = function* (bytes, binOff) {
      if (binOff !== -1 && quit) { count = 0; return; }      // summary.rs: the count squashed
      if (count === 0) return;
      if (spec.mode === 'files') out.push(Buffer.from(e.disp + (spec.nul ? '\0' : '\n')));
      else out.push(...(e.withFilename ? [Buffer.from(e.disp), Buffer.from(spec.nul ? '\0' : ':')] : []), Buffer.from(`${count}\n`));
    };
    sink.found = () => count > 0;
    return sink;
  }
  if (spec.mode === 'json') {
    const totals = state.json, t0 = clockNs();
    const pw = new ByteWriter(64);
    jsonData(pw, Buffer.from(e.disp));
    const path = Buffer.from(pw.done());
    let begun = false, bytesPrinted = 0, matchCount = 0, matchedLines = 0, matches = 0;
    const emit = (w) => { const b = w.done(); bytesPrinted += b.length; out.push(b); };
    const begin = () => {
      if (begun) return;
      begun = true;
      const w = new ByteWriter(64);
      w.ascii('{"type":"begin","data":{"path":'); w.bytes(path); w.ascii('}}\n');
      emit(w);
    };
    const message = function* (kind, s, e2, num, ms) {
      const w = new ByteWriter();
      w.ascii(`{"type":"${kind}","data":{"path":`); w.bytes(path); w.ascii(',"lines":');
      for (const slice of jsonDataGen(w, text, s, e2)) yield slice || TICK;
      w.ascii(`,"line_number":${spec.lineNumber ? num : 'null'},"absolute_offset":${s},"submatches":[`);
      ms.forEach((m, i) => {
        w.ascii(i ? ',{"match":' : '{"match":'); jsonData(w, text, m.start, m.end); w.ascii(`,"start":${m.start - s},"end":${m.end - s}}`);
      });
      w.ascii(']}}\n');
      emit(w);
    };
    sink.matched = function* (s, e2, num) {
      begin();
      matchCount++;
      const ms = yield* printed(s, e2);
      // A printed match reaching past its block: grep-printer slices past the block's bytes and rg PANICS
      // (RG-MULTILINE-PRINTED, measured above); quaude's rg refuses rather than invent an answer.
      for (const m of ms) {
        if (m.end > e2) {
          throw new UgrepError('quaude answers rg with its own emulation over ugrep, on purpose, and under -U a match its printer found '
            + `at byte ${m.start} reaches past the lines rg's searcher gave it (byte ${e2}), where rg's --json printer panics `
            + '(slicing past those lines; RG-MULTILINE-PRINTED); the search had started, and nothing it found is printed',
          { refused: 'RG-MULTILINE-PRINTED' });
        }
      }
      matches += ms.length; matchedLines += mlLineCount(text, s, e2);
      yield* message('match', s, e2, num, ms);
      return !full();
    };
    sink.context = function* (s, e2, num) { begin(); yield* message('context', s, e2, num, []); return !full(); };
    sink.finish = function* (bytes, binOff) {
      if (!begun || full()) return;
      const ns = clockNs() - t0;
      const w = new ByteWriter();
      w.ascii('{"type":"end","data":{"path":'); w.bytes(path);
      w.ascii(`,"binary_offset":${binOff !== -1 ? binOff : 'null'},"stats":{"elapsed":${jsonDuration(ns, false)},"searches":1,"searches_with_match":${matchCount > 0 ? 1 : 0},`
        + `"bytes_searched":${bytes},"bytes_printed":${bytesPrinted},"matched_lines":${matchedLines},"matches":${matches}}}}\n`);
      out.push(w.done());
      Object.assign(totals, { elapsedNs: totals.elapsedNs + ns, searches: totals.searches + 1, withMatch: totals.withMatch + (matchCount > 0 ? 1 : 0),
        bytesSearched: totals.bytesSearched + bytes, bytesPrinted: totals.bytesPrinted + bytesPrinted,
        matchedLines: totals.matchedLines + matchedLines, matches: totals.matches + matches });
    };
    sink.found = () => matchCount > 0;
    return sink;
  }
  // the standard printer
  const path = e.withFilename ? Buffer.from(e.disp) : null;
  const ctx = spec.before > 0 || spec.after > 0, cols = spec.maxColumns;
  let matchCount = 0, binOff = -1, wroteHere = false;
  const prelude = () => { if (!wroteHere) { wroteHere = true; if (ctx && state.printed) out.push(SEP); } state.printed = true; };
  const prefix = (num, sep) => {
    const p = [];
    if (path) p.push(path, Buffer.from(spec.nul ? '\0' : sep));
    if (spec.lineNumber) p.push(Buffer.from(`${num}${sep}`));
    return p;
  };
  const line = (ls, le, num, sep, omitted) => {
    if (cols && le - ls > cols) out.push(...prefix(num, sep), omitted, NL);
    else { out.push(...prefix(num, sep), text.subarray(ls, le)); if (le === ls || text[le - 1] !== 0x0a) out.push(NL); }
  };
  sink.binaryData = (off) => { binOff = off; };
  sink.contextBreak = function* () { out.push(SEP); };
  sink.matched = function* (s, e2, num) {
    matchCount++;
    const ms = spec.only ? yield* printed(s, e2) : [];
    if (!quit && binOff !== -1) return false;
    prelude();
    if (!ms.length) {
      let i = 0;
      for (const [ls, le] of mlLines(text, s, e2)) { line(ls, le, num + i++, ':', OMITTED_MATCH); if (i % TICK_EVERY === 0) yield TICK; }
      return !full();
    }
    // sink_slow_multi_line_only_matching
    let midx = 0, count = 0;
    for (const [ls0, le0] of mlLines(text, s, e2)) {
      let ls = ls0;
      const le = text[le0 - 1] === 0x0a ? le0 - 1 : le0;
      while (ls < le) {
        if (ms[midx].end <= ls) { if (midx + 1 < ms.length) { midx++; continue; } break; }
        const m = ms[midx];
        if (ls < m.start) { ls = Math.min(le, m.start); continue; }
        const upto = Math.min(le, m.end);
        out.push(...prefix(num + count, ':'));
        out.push(cols && upto - ls > cols ? OMITTED_MATCH : text.subarray(ls, upto), NL);
        ls = upto;
      }
      count++;
      if (count % TICK_EVERY === 0) yield TICK;
    }
    return !full();
  };
  sink.context = function* (s, e2, num) {
    if (!quit && binOff !== -1) return false;
    prelude();
    line(s, e2, num, '-', OMITTED_CONTEXT);
    return !full();
  };
  sink.finish = function* () {
    if (binOff !== -1 && matchCount > 0) { out.push(binaryMessage({ quit }, path ? e.disp : null, binOff)); state.printed = true; }
  };
  sink.found = () => matchCount > 0;
  return sink;
}

// ---- rg --files (grep-native Task 10: the Glob tool) ------------------------------------------------------
// ripgrep 14.1.1's main.rs `files` and hiargs.rs `sort`, read from the crate; measured against native 2.1.283:
//   RG-FILES          --files lists every file the walk reaches (rg-walk.cjs: its ignore rules, globs, --iglob,
//                     --hidden, --no-ignore, types; a NAMED file is listed whatever they say), each as the walk
//                     spells it, then \n, or \0 under --null; rc 0 when it listed one, 1 when none, 2 when the
//                     walk met an error (on stderr, the rest listed). The Glob tool's Read-deny `--iglob`s and
//                     orphan `--glob`s exclude as rg's glob dialect reads them (Task 9's walk), so nothing denied
//                     is listed (the old ugrep/bfs translation leaked them).
//   RG-SORT-MODIFIED  --sort=modified walks on ONE thread (rg-walk's -j1 order) and then orders the files by
//                     their modification time (stat, following a symlink), oldest first, to the nanosecond, with
//                     a STABLE sort (equal times keep the walk's order) and a file whose time cannot be read
//                     last; --sortr=modified reverses the comparison, not the ties. A sort's choice that is not
//                     a choice is rg's usage error; --sort=none sorts nothing.
// RG-SORT-MODIFIED over what the walk found (hiargs.rs `sort`): every file (stdin too, whose path `-` has no
// time, unless a file of that name is there), stably by modification time; errors and messages first, as rg
// prints them while it walks, before anything is searched or listed.
function* sortedByModified(spec, entries, cwd) {
  const fs = require('fs'), path = require('path');
  const keyed = [], rest = [];
  let n = 0;
  for (const e of entries) {
    if (!e.file && !e.stdin) { rest.push(e); continue; }
    let t = null;
    try { t = fs.statSync(path.resolve(cwd, e.stdin ? '-' : e.file), { bigint: true }).mtimeNs; } catch { /* sorted last */ }
    keyed.push({ e, t, i: keyed.length });
    if (++n % TICK_EVERY === 0) { searchStats.ticks.sort++; yield TICK; }
  }
  const sign = spec.sort.reverse ? -1 : 1;
  keyed.sort((a, b) => {
    const o = a.t !== null && b.t !== null ? (a.t < b.t ? -1 : a.t > b.t ? 1 : 0) : a.t !== null ? -1 : b.t !== null ? 1 : 0;
    return o * sign || a.i - b.i;
  });
  return [...rest, ...keyed.map((k) => k.e)];
}
function* printListing(spec, entries, cwd, sink) {
  const out = outBuffers(sink), err = [];
  let broke = false, listed = 0;
  const list = spec.sort ? yield* sortedByModified(spec, entries, cwd) : entries;
  const term = spec.nul ? '\0' : '\n';
  for (const e of list) {
    if (e.error) { err.push(Buffer.from(e.error + '\n')); broke = true; continue; }
    if (e.message) { err.push(Buffer.from(e.message + '\n')); continue; }
    if (!e.file) continue;
    out.push(Buffer.from(e.disp + term));
    if (++listed % TICK_EVERY === 0) { searchStats.ticks.list++; yield TICK; }
  }
  return { stdout: out.done(), stderr: spec.noMessages ? Buffer.alloc(0) : Buffer.concat(err), status: broke ? 2 : listed ? 0 : 1, signal: null };
}

// ---- RG-STREAM: a search as rg makes it, as the bytes arrive (grep-native Task 10c fix round, review I-2) ----
// rg searches as it reads: a 64 KiB line buffer at a time, printing as it goes, its memory bounded by that buffer
// (and the longest line), `yes needle | rg needle | head -1` ending at once. quaude's rg answered a search whole:
// stdin read to its end, every match found, then everything printed, so `yes | rg | head -1` never ended and a
// 138 MB file under `| head -1` took 117 s and 1.77 GB. A COMMAND's search (rg-entry.cjs) streams stdin and every
// named file instead: windows of whole lines, each searched by the matcher (rg-regex.cjs decides every line, as
// stdin always was), printed by the same printers (linePrinter, printCount) with what the window must carry
// (line numbers, offsets, the context lines it may still print, the `--` state), and handed to the command's
// stdout as they finish. What a later byte could still change is held back until it cannot:
//   RG-BINARY-CONVERT  (stdin; a named file rg does not map) the standard printer stops at the fill that meets
//              the first NUL, so lines are printed only once the fill they were searched in has ended without one:
//              StreamFills is lineBufferFills, run as the bytes arrive (rg's own buffer: what is held is what rg holds)
//   RG-BINARY-MMAP  (a named file rg maps) a NUL in its first 64 KiB stops before the first line: nothing is
//              printed before 64 KiB (or the end) is read
// Context needs no holding back: each line is printed once (the window remembers the last it printed), and a window
// keeps the -A + -B + 2 lines before what it has not printed, so it derives their context, and the `--` between
// groups, as the whole text does. Everything else of a line is the line's own. The answer is the whole-text search's, byte for byte, which
// test/rg-stream.test.cjs holds over every printer, window and NUL position; the gate judges both against native.
// NOT STREAMED: a multi-line search (rg reads those whole too), a UTF-16 text (rg's decoder; searched whole), and a
// WALKED file (each read whole, as before: its binary quit reads in fills a walk's ugrep pass has already looked at).
// A named file is read 64 KiB at a time, rg's own buffer: the first window is searched as soon as its first read is
// in (fix round 2: a 1 MiB read plus the next before anything printed held a big file's first line ~2 s in a quaude).
const STREAM_READ = 64 * 1024;
const utf16Head = (h) => h.length >= 2 && ((h[0] === 0xff && h[1] === 0xfe) || (h[0] === 0xfe && h[1] === 0xff));

// lineBufferFills (RG-BINARY-CONVERT, quit false), as the text arrives: advance() runs rg's fills as far as the
// bytes so far allow (a read is as long as there is room, RG-STDIN-ALL-THERE, so a fill waits for that room or the
// end), and answers { wait } (searchStart: where the fill being read began its search; everything before it was
// searched by fills that held no NUL), { met: stopAt } (the fill that met the first NUL began its search there),
// or { done } (the end, no NUL). `T(abs)`: the window, (text, base). visited(from, to) as lineBufferFills'.
class StreamFills {
  constructor(read, maxContext) {
    this.bounds = read.bounds; this.bi = 0; this.maxContext = maxContext;
    this.A = 0; this.end = 0; this.lastLT = 0; this.at = 0; this.from = 0; this.cap = RG_BUFFER;
    this.top = true; this.searchStart = 0; this.searched = 0; this.oldLen = 0; this.consumed = 0; this.met = false; this.didread = false;
  }
  advance(text, base, avail, eof, nul, visited) {
    const rel = (x) => x - base;
    for (;;) {
      if (this.top) {
        let consumed = this.lastLT;
        if (this.maxContext > 0 && this.lastLT > 0) {
          const lv = visited(this.from, this.A + this.lastLT);
          consumed = Math.max(precedingStart(text, rel(this.A), rel(this.A + this.lastLT), this.maxContext) + base - this.A, lv < 0 ? 0 : lv - this.A);
        }
        this.oldLen = this.lastLT; this.searched = this.A + this.lastLT; this.consumed = consumed;
        this.A += consumed; this.end -= consumed; this.lastLT = this.end;
        this.didread = false; this.met = false; this.top = false; this.searchStart = this.searched;
      }
      for (;;) {
        if (this.cap - this.end === 0) this.cap += Math.max(1, this.cap) * 2;
        while (this.bi < this.bounds.length && this.bounds[this.bi] <= this.at) this.bi++;
        const lim = this.bi < this.bounds.length ? this.bounds[this.bi] : Infinity;
        const want = Math.min(this.cap - this.end, lim - this.at);
        if (avail - this.at < want && !eof) return { wait: true, searchStart: this.searchStart };
        const n = Math.min(want, avail - this.at);
        if (n <= 0) { this.lastLT = this.end; this.didread = this.lastLT > 0; break; }
        const oldend = this.end;
        this.end += n; this.at += n;
        searchStats.filled += n;
        if (nul !== -1 && nul < this.A + this.end) this.met = true;
        const ls = lineStart(text, rel(this.A + this.end), rel(this.A + oldend)) + base;
        if (ls > this.A + oldend) { this.lastLT = ls - this.A; this.didread = true; break; }
      }
      this.top = true;
      if (this.met) return { met: true, stopAt: this.searched };
      if (!this.didread || (this.consumed === 0 && this.oldLen === this.lastLT)) return { done: true };
      this.from = this.searched;
    }
  }
}

// One streamed target (stdin, or a named file), into `out`: { found, error (stderr bytes), whole (a UTF-16 stdin's
// bytes, to be searched whole) }. ctx: { cwd, how ('convert' or 'mmap'), first, deadline }.
function* streamEntry(spec, e, t, out, state, ctx) {
  const fs = require('fs'), path = require('path');
  let how = ctx.how;
  // the source: stdin through the command (op stdinChunk: a Buffer, null at its end, or { error }), a named file here
  let fd = null, closed = false;
  const errorLine = (x) => Buffer.from(`rg: ${e.disp}: ${osErrorText(x)}\n`);
  if (!e.stdin) {
    try { fd = fs.openSync(path.resolve(ctx.cwd, e.file), 'r'); } catch (x) { return { error: errorLine(x) }; }
  }
  const chunkBuf = e.stdin ? null : Buffer.alloc(ctx.readSize || STREAM_READ);
  const next = function* () {
    if (closed) return null;
    if (e.stdin) {
      const r = yield { op: 'stdinChunk' };
      if (r && r.error) throw r.error;
      if (!r || !r.length) { closed = true; return null; }
      return toBuf(r);
    }
    const n = fs.readSync(fd, chunkBuf, 0, chunkBuf.length, null);
    if (!n) { closed = true; return null; }
    return Buffer.from(chunkBuf.subarray(0, n));
  };
  try {
    // RG-TEXT-BOM: a UTF-8 BOM is dropped; UTF-16 is searched whole (rg's decoder); the reads' bounds are rgTextRead's
    let head = Buffer.alloc(0);
    while (head.length < 3) { const c = yield* next(); if (!c) break; head = Buffer.concat([head, c]); }
    if (utf16Head(head)) {
      const all = [head];
      for (let c; (c = yield* next());) all.push(c);
      return { whole: Buffer.concat(all) };
    }
    const bom8 = head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf;
    const read = bom8 ? { bounds: e.stdin ? [STDIN_BUF - 3] : [] } : { bounds: e.stdin ? [3, STDIN_BUF] : [3] };
    if (bom8 && how === 'mmap') how = 'convert';            // a file with a BOM is read, never mapped (rgView)
    const convert = how === 'convert';
    const ctxLines = Math.max(spec.before, spec.after);
    const lead = spec.before + spec.after + 2;
    // the window: rg's text (a convert search's NULs made newlines) from `base`; lineBase the number of its first line
    let buf = Buffer.alloc(0), base = 0, total = 0, lineBase = 1, nul = -1, eof = false, wm = -1, pending = [];
    // pieces wait in `pending` until the next window is searched (joined once, not a piece at a time)
    const append = (c) => {
      const z = c.indexOf(0);
      if (nul === -1 && z !== -1) nul = total + z;
      let v = c;
      if (convert && z !== -1) { v = Buffer.from(c); for (let i = z; i !== -1; i = v.indexOf(0, i + 1)) v[i] = 0x0a; }
      pending.push(v);
      total += c.length;
    };
    const join = () => { if (pending.length) { buf = Buffer.concat([buf, ...pending]); pending = []; } };
    append(bom8 ? head.subarray(3) : head);
    const mode = spec.mode;
    const printer = mode === 'standard' || mode === 'json' ? linePrinter(spec, e, out, state, how === 'mmap' ? { offset: -1, mmap: true, window: false } : null) : null;
    const fills = convert && mode === 'standard' ? new StreamFills(read, ctxLines) : null;
    let met = false, stopAtAbs = -1, finished = false, found = false, counted = 0, countSeen = false, mmapDecided = how !== 'mmap';
    // drop what no later window can need: before `keep` (absolute, a line start)
    const dropTo = (keep) => {
      if (keep <= base) return;
      const k = keep - base;
      for (let i = buf.indexOf(0x0a); i !== -1 && i < k; i = buf.indexOf(0x0a, i + 1)) lineBase++;
      buf = buf.subarray(k); base = keep;
    };
    const backLines = (absPos, n) => {      // the start of the line n lines before the one holding absPos
      let p = Math.max(0, Math.min(absPos, base + buf.length) - base);
      p = lineStart(buf, p, 0);
      for (let i = 0; i < n && p > 0; i++) p = lineStart(buf, p - 1, 0);
      return p + base;
    };
    // A window is searched once what arrived since the last one is at least as much as what that one kept (and 4 KiB):
    // every byte is searched a bounded number of times, however small the pieces stdin hands over.
    let fresh = head.length, primed = true;      // the BOM sniff's read is the first window's
    while (!finished) {
      if (!primed) {
        const c = yield* next();
        if (c) { append(c); fresh += c.length; } else eof = true;
      }
      primed = false;
      if (!eof && fresh < Math.max(4096, buf.length)) continue;
      join();
      fresh = 0;
      // whole lines only, until the end (lineStart: the start of the line after the last newline, 0 for none)
      const complete = eof ? buf.length : lineStart(buf, buf.length, 0);
      if (!complete && !eof) continue;
      const text = buf.subarray(0, complete);
      if (ctx.deadline && Date.now() > ctx.deadline) throw timedOutError();
      const ms = matchTextLines(text, t, ctx.deadline, ctx.first);
      const sel = yield* selectedLines(text, ms);
      if (mode === 'files') {
        if (sel.some((L) => L.ls + base > wm)) { out.push(Buffer.from(e.disp + (spec.nul ? '\0' : '\n'))); found = true; finished = true; break; }
        wm = base + complete - 1;
        dropTo(base + complete);
        if (eof) break;
        continue;
      }
      if (mode === 'count') {
        for (const L of sel) if (L.ls + base > wm) { counted += spec.countMatches ? L.ms.length : 1; countSeen = true; }
        if (complete) wm = base + complete - 1;
        dropTo(base + complete);
        if (eof) break;
        continue;
      }
      // the standard and JSON printers: which events are final
      if (!mmapDecided && (eof || total >= RG_BUFFER)) {
        mmapDecided = true;
        if (nul !== -1 && nul < Math.min(total, RG_BUFFER)) printer.setBin({ offset: nul, mmap: true, window: true });
      }
      const events = [...eachPrintedLine(text, sel, spec, lineBase)];
      let cut = Infinity;
      if (!eof && !mmapDecided) cut = 0;
      if (fills && !met) {
        const visited = (from, to) => {
          let last = -1;
          for (const ev of events) {
            if (ev === GAP) continue;
            const at = ev.at + base;
            if (at >= to) break;
            if (at >= from) { const le = lineEndAt(text, ev.ls); last = (le < text.length ? le + 1 : le) + base; }
          }
          return last;
        };
        const f = fills.advance(buf, base, total, eof, nul, visited);
        if (f.met) { met = true; stopAtAbs = f.stopAt; }
        else if (f.wait) cut = Math.min(cut, f.searchStart - base);
      }
      // the printer's stop compares a window's own offsets
      if (met) printer.setBin({ offset: nul, bytes: total, stopAt: stopAtAbs - base });
      let gap = false;
      for (const ev of events) {
        if (ev === GAP) { gap = true; continue; }
        if (ev.ls + base <= wm) { gap = false; continue; }
        if (ev.at >= cut) break;
        if (gap) { gap = false; yield* printer.event(GAP, text, base); }
        if (!(yield* printer.event(ev, text, base))) { finished = true; break; }
        wm = ev.ls + base;
      }
      if (printer.flush) printer.flush();
      out.flush();
      if (finished || eof) break;
      // keep: the lines a later window may print or need (lead lines before what is not yet final), and rg's buffer
      const anchor = Math.min(cut === Infinity ? base + complete : base + cut, base + complete);
      let keep = backLines(anchor, lead);
      if (fills) keep = Math.min(keep, backLines(fills.A, ctxLines + 2));
      dropTo(keep);
    }
    if (mode === 'files') return { found };
    if (mode === 'count') { if (countSeen) { printCount(spec, e, out, counted); found = true; } out.flush(); return { found }; }
    if (convert && mode === 'json' && nul !== -1) printer.setBin({ offset: nul, bytes: total });
    found = yield* printer.end(total);
    if (printer.flush) printer.flush();
    out.flush();
    return { found };
  } catch (x) {
    if (x && x.timedOut) throw x;
    if (x && (x.sinkClosed || x.fromSink)) throw x;
    if (x instanceof Error && typeof x.errno === 'number') return { error: errorLine(x) };
    throw x;
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* closed */ }
  }
}

// ---- the search, once: a generator both twins drive --------------------------------------------------
// It yields what it needs done ({ op: 'caps' }, { op: 'match', files, pattern }, { op: 'stdin' },
// { op: 'decide', text }, TICK) and is answered synchronously (runRg) or asynchronously (rgSpawn), so the
// rules above are stated once. It returns { stdout, stderr, status } or a refusal. A directory is walked
// here, in JS, as rg walks it (rg-walk.cjs), and ugrep searches the files it lists.
function* searchCore(spec, opts) {
  searchStats.ticks = { walk: 0, sort: 0, list: 0, fill: 0, select: 0, sunk: 0 };
  const fs = require('fs'), path = require('path');
  const cwd = opts.cwd || process.cwd();
  const pattern = spec.patterns[0];
  // rg reads its types, then its globs, before it searches anything (hiargs.rs): an unknown type or a
  // glob that does not parse is rg's own error, rc 2, whatever else the search would have found.
  let walker;
  try { walker = rgWalkModule().makeWalker(spec, { cwd, env: opts.env }); } catch (e) {
    if (e && e.name === 'WalkUsage') return { stdout: Buffer.alloc(0), stderr: Buffer.from(`rg: ${e.message}\n`), status: 2, signal: null };
    throw e;
  }
  let t = null;
  if (spec.mode !== 'list') try { t = translated(pattern, spec); } catch (e) {
    // RG-NEWLINE-NEEDS-U: rg's own error for a \n without -U
    if (e.refused === 'RG-RE-REFUSE-NEWLINE') return { stdout: Buffer.alloc(0), stderr: NEWLINE_NEEDS_U, status: 2, signal: null };
    if (e.refused) return rgRefusal(e.message);
    throw e;
  }
  const kinds = spec.paths.map((P) => {
    if (P === '-') return { kind: 'stdin' };
    if (process.platform !== 'win32' && descriptorRefused(path.resolve(cwd, P))) return { kind: 'refuse' };
    try {
      const st = fs.statSync(path.resolve(cwd, P));
      return { kind: st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'special', st };
    } catch (e) { return { kind: 'error', e }; }
  });
  // A NAMED path that is neither a regular file nor a directory: RG-SPECIAL-FILE answers it as native
  // does (an empty device is an empty file; one that cannot be opened is rg's per-path error), and
  // RG-REFUSE-SPECIAL-FILE refuses one that can block or never end. A walked one is skipped, as native
  // skips it (the walk lists regular files only: RG-WALK-SYMLINK).
  for (let i = 0; i < spec.paths.length; i++) {
    if (kinds[i].kind === 'special') kinds[i] = specialKind(path.resolve(cwd, spec.paths[i]), kinds[i].st);
    if (kinds[i].kind === 'refuse') {
      return rgRefusal(`quaude answers rg with its own emulation over ugrep, on purpose, and ${spec.paths[i]} is a descriptor, a FIFO `
        + 'or a device, which rg reads until it ends and quaude\'s rg cannot read without blocking its caller or reading the caller\'s '
        + 'own input (RG-REFUSE-SPECIAL-FILE); nothing was searched');
    }
  }
  const pastDeadline = () => { if (opts.deadline && Date.now() > opts.deadline) throw timedOutError(); };
  // rg walks one path that is not a directory (and anything under -j1) with walkdir, whose error for
  // a path it cannot stat says so; its parallel walker's does not (measured: nope.txt alone, with
  // -j1, and beside a.txt).
  const oneFile = spec.paths.length === 1 && kinds[0].kind !== 'dir';
  // a sort walks on one thread (hiargs.rs: `low.sort.is_some()` means 1 thread)
  const sequential = spec.threads === 1 || oneFile || !!spec.sort;
  const withFilename = spec.withFilename !== null ? spec.withFilename : !oneFile;
  // The ugrep at or above UGREP_MIN (refused otherwise, before it is asked anything else). A listing asks
  // ugrep nothing.
  if (spec.mode !== 'list' && kinds.some((k) => k.kind === 'dir' || k.kind === 'file')) {
    const c = yield { op: 'caps' };
    if (c.refusal) return c.refusal;
  }
  const entries = [];
  for (let i = 0; i < spec.paths.length; i++) {
    const P = spec.paths[i], k = kinds[i];
    // RG-IGNORE-PARENTS: on ONE thread a root that is no directory, stdin aside, drops the ancestors the last
    // one built (walk.rs's sequential walker: `self.ig = self.ig_root.clone()`); the parallel walk never drops
    // them (every root starts from ig_root's clone and its cache; measured 12 of 12, ruling G26)
    if (sequential && k.kind !== 'stdin' && k.kind !== 'dir') walker.dropParents();
    if (k.kind === 'stdin') entries.push({ disp: '<stdin>', stdin: true, walked: false });
    else if (k.kind === 'error') entries.push({ error: `rg: ${P}: ${sequential ? `IO error for operation on ${P}: ` : ''}${osErrorText(k.e)}` });
    else if (k.kind === 'openError') entries.push({ error: `rg: ${P}: ${osErrorText(k.e)}` });
    else if (k.kind === 'empty') continue;
    else if (k.kind === 'file') {
      let err = null;
      try { fs.closeSync(fs.openSync(path.resolve(cwd, P), 'r')); } catch (e) { err = e; }
      entries.push(err ? { error: `rg: ${P}: ${osErrorText(err)}` } : { disp: P, file: P, walked: false });
    } else {
      // RG-WALK-*: the directory, walked as rg walks it; its files, rg's messages and errors, in rg's order.
      try {
        for (const w of walker.walk(P, { sequential, errText: osErrorText, tick: TICK })) {
          if (w === TICK) { searchStats.ticks.walk++; yield TICK; continue; }
          // RG-IMPLICIT-PATH: a pathless search prints each file without the ./ it walked from; the walk's own errors keep it
          if (w.file) entries.push({ disp: spec.implicit ? stripDot(w.file) : w.file, file: w.file, walked: true });
          else entries.push(w);
        }
      } catch (e) {
        if (e && e.name === 'WalkRefusal') return rgRefusal(`quaude answers rg with its own emulation over ugrep, on purpose, and ${e.message}; nothing was searched`);
        throw e;
      }
    }
  }
  if (spec.mode === 'list') return yield* printListing(spec, entries, cwd, opts.sink);
  // RG-SORT-MODIFIED: a search under --sort=modified searches (and prints) its files in that order too
  if (spec.sort) entries.splice(0, entries.length, ...(yield* sortedByModified(spec, entries, cwd)));
  // FIRST_MATCH: what each mode needs to know of a file's matches. -l only whether there is one,
  // -c (lines) and the standard printer without -o only which lines hold one, as rg itself stops
  // there; -o and -c -o every printable match.
  // --json reports every match on a selected line (-o or not: RG-JSON-ONLY-MATCHING).
  const first = spec.mode === 'files' ? 'file' : spec.mode !== 'json' && !spec.only ? 'line' : undefined;
  // RG-STREAM (a command's search: rg-entry.cjs): stdin and every NAMED file are searched as they are read
  // (streamEntry), never whole, so they take no part in the match pass; a UTF-16 file (rg's decoder) and a
  // multi-line search (rg reads those whole too) are searched as before.
  const streams = (en) => !!opts.stream && !t.multiLine && (en.stdin || (en.file && !en.walked && !utf16Head(readHead(path.resolve(cwd, en.file)))));
  for (const en of entries) if (streams(en)) en.streamed = true;
  const files = [...new Set(entries.filter((e) => e.file && !e.streamed).map((e) => e.file))];
  let matches = new Map();
  searchStats.printed = 0; searchStats.scannedBack = 0; searchStats.read = 0; searchStats.filled = 0;
  const out = outBuffers(opts.sink), err = [], state = { printed: false, json: spec.mode === 'json' ? jsonTotals() : null,
    limit: typeof opts.maxBuffer === 'number' && opts.maxBuffer >= 0 ? opts.maxBuffer : Infinity };
  let found = false, broke = false;
  // RG-STDERR-ORDER: what ugrep could not read is written where the walk met that file (below), so on one thread a
  // walk's message (an ignore file that does not parse) and a search's error keep rg's order; one for a path no
  // entry names is written first.
  const pathErrors = new Map();
  if (files.length) {
    // N-2: every walked file is known to be a regular file, so the match pass need not stat it again.
    const r = yield { op: 'match', files, pattern, first, known: new Set(entries.filter((e) => e.walked).map((e) => e.file)) };
    if (r.refusal) return r.refusal;
    // A match pass that FAILED refuses, whatever it printed first (Task 6 re-review N3): the Grep tool
    // reads a bare rc 2 with no output as "No files found", and rc-2 output as the whole answer.
    if (r.error) return appletRejected(opts.ugrepName || 'ugrep', r.error.status || 2, r.error.stderr || r.error.message);
    matches = r.matches;
    // What it only warned about is rg's per-path error (RG-EXIT), the rest answered.
    for (const w of matches.pathErrors || []) {
      const e = entries.find((x) => x.file && spellForUgrep(x.file) === w.file);
      if (!e) { err.push(Buffer.from(`rg: ${w.file}: ${w.text}\n`)); broke = true; continue; }
      if (!pathErrors.has(e.file)) pathErrors.set(e.file, []);
      pathErrors.get(e.file).push(Buffer.from(`rg: ${e.disp}: ${w.text}\n`));
    }
  }
  // RG-BINARY-MMAP: whether rg memory-maps this search's named files (never on macOS).
  const mmap = mmapsNamedFiles(spec, cwd);
  // A literal's matches are the same in a file's bytes and in RG-BINARY-CONVERT's text (it holds no
  // newline or NUL), so ugrep's ranges stand; anything else is decided again over rg's text.
  const literal = takesUgrepRanges(t);
  for (const e of entries) {
    if (e.error) { err.push(Buffer.from(e.error + '\n')); broke = true; continue; }
    // RG-IGNORE-FILE-ERRORS: rg's message about an ignore file it read, which leaves the exit status be
    if (e.message) { err.push(Buffer.from(e.message + '\n')); continue; }
    if (e.streamed) {
      const r = yield* streamEntry(spec, { ...e, withFilename }, t, out, state, { cwd, how: binaryHow(e, mmap), first, deadline: opts.deadline, readSize: opts.streamRead });
      if (r.error) { err.push(r.error); broke = true; }
      if (r.found) found = true;
      if (!r.whole) { if (out.len > state.limit) break; yield TICK; continue; }
      e.wholeStdin = r.whole;                 // a UTF-16 stdin: searched whole, below
    }
    if (e.file && pathErrors.has(e.file)) { err.push(...pathErrors.get(e.file)); pathErrors.delete(e.file); broke = true; }
    if (t.multiLine) {
      // RG-MULTILINE: each file ugrep proposed (stdin always), read whole and searched as rg's multi-line
      // searcher does, a walked one with binary quit (RG-MULTILINE-BINARY)
      let bytes;
      if (e.stdin) bytes = toBuf(yield { op: 'stdin' });
      else {
        if (!matches.has(e.file)) continue;
        pastDeadline();
        try { bytes = readRgBytes(e.file, cwd); } catch (x) { err.push(Buffer.from(`rg: ${e.disp}: ${osErrorText(x)}\n`)); broke = true; continue; }
      }
      const text = rgText(bytes);
      const sink = mlSink(spec, { ...e, withFilename }, text, t, out, state, !!e.walked);
      try { yield* multilineSearch(text, t, spec, sink, !!e.walked); } catch (x) {
        const u = asUgrepError(x);
        if (u instanceof UgrepError && u.refused) return rgRefusal(u.message);
        throw x;
      }
      if (sink.found()) found = true;
      if (out.len > state.limit) break;
      yield TICK;
      continue;
    }
    let v = null, m;
    const how = binaryHow(e, mmap);
    if (e.stdin) {
      v = rgView(e.wholeStdin || toBuf(yield { op: 'stdin' }), how, { stdin: true });
      m = yield { op: 'decide', text: v.text, t, first };
      if (m.refusal) return m.refusal;
      m = m.matches;
    } else {
      m = matches.get(e.file);
      if (!m || !m.length) continue;
      pastDeadline();
      if (spec.mode === 'files' && e.walked) {
        // -l of a walked file reads only what rg's line buffer would have before it answers.
        let listed;
        try { listed = yield* walkedListed(e.file, cwd, m, spec); } catch (x) { err.push(Buffer.from(`rg: ${e.disp}: ${osErrorText(x)}\n`)); broke = true; continue; }
        if (!listed) continue;
      } else if (!(spec.mode === 'files' && (how === 'mmap' || literal))) {
        // -l reads nothing of a named file whose matches stand whatever its bytes hold.
        try { v = rgView(readRgBytes(e.file, cwd), how); } catch (x) { err.push(Buffer.from(`rg: ${e.disp}: ${osErrorText(x)}\n`)); broke = true; continue; }
        if (v.how === 'convert' && v.nul !== -1 && !(literal && v.read.kind === 'plain')) {
          m = yield { op: 'decide', text: v.text, t, first };
          if (m.refusal) return m.refusal;
          m = m.matches;
        }
      }
    }
    if (!m.length) continue;
    let fe = { ...e, matches: m, withFilename };
    if (v) {
      const sel = yield* selectedLines(v.text, m);
      const o = yield* binaryOutcome(v, sel, spec);
      if (o.squash) continue;
      fe = { ...fe, text: o.text, sel: o.sel, bin: o.bin };
    }
    if (yield* printFile(spec, fe, out, state)) found = true;
    // Past the caller's maxBuffer: nothing more is printed (its execFile kills the child here).
    if (out.len > state.limit) break;
    yield TICK;
  }
  // RG-JSON: one summary after every file, whatever was found.
  if (state.json && out.len <= state.limit) out.push(jsonSummary(state.json));
  searchStats.printed = out.len;
  // RG-NO-MESSAGES: every message rg would write (per-path errors, ignore-file errors) unwritten; the status stays
  return { stdout: out.done(), stderr: spec.noMessages ? Buffer.alloc(0) : Buffer.concat(err), status: broke ? 2 : found ? 0 : 1, signal: null };
}

// How a step the core asked for ended in a refusal or a failure: refusals stop the search; a ugrep
// that failed is rg's error (exit 2, the rest answered), and is surfaced to the operator.
function matchOutcome(e, opts, ugrep) {
  if (!(e instanceof UgrepError)) throw e;
  if (e.timedOut) throw e;
  if (e.refused) return { refusal: rgRefusal(e.message) };
  if (opts.onRejected) opts.onRejected([ugrep || 'ugrep', `(${e.message})`], e.status || 2, 'match pass');
  return { error: e };
}

// The plan for one rg call: { result } (answered without searching: a refusal or rg's usage error), or
// { spec, ugrep } (a search or a listing quaude's rg answers).
function rgPlan(argv, opts) {
  const p = parseRgSearch(argv, { implicit: opts.implicit });
  const debug = (v) => { if (opts.debug) opts.debug(argv, v); };
  if (p.usage) { debug('=> quaude\'s rg (rg\'s own usage error)'); return { result: { stdout: Buffer.alloc(0), stderr: Buffer.from(p.usage), status: 2, signal: null } }; }
  if (p.refuse) { debug(`!! untranslatable ${p.flag || '(argv)'}`); return { result: rgRefusal(p.refuse, { flag: p.flag }) }; }
  if (p.special) {
    debug(`=> quaude's rg (${p.special})`);
    const t = rgTypesModule();
    const text = p.special === 'type-list' ? t.typeListText() : t.versionText({ short: p.special === 'version-short' });
    return { result: { stdout: Buffer.from(text, 'utf8'), stderr: Buffer.alloc(0), status: 0, signal: null } };
  }
  // ugrep is needed for any file (unless the caller decides files alone) and for every directory.
  // A listing (--files) needs no ugrep: the walk is quaude's own (RG-FILES).
  const needs = p.spec.mode !== 'list' && p.spec.paths.some((P) => P !== '-');
  let ugrep = null;
  if (needs) {
    ugrep = opts.ugrep ? opts.ugrep() : null;
    if (!ugrep && !opts.matchFiles) {
      debug('!! needs ugrep');
      return { result: missingUgrep(opts) };
    }
  }
  debug(`=> quaude's rg over ${ugrep || '(no ugrep)'}`);
  return { spec: p.spec, ugrep };
}

// ---- the two drivers ---------------------------------------------------------------------------
// What a step the core asked for returned; a throw ends the search (a timeout, a kill).
function driveSync(gen, handlers) {
  let r = gen.next();
  while (!r.done) r = gen.next(handlers[r.value.op](r.value));
  return r.value;
}
async function driveAsync(gen, handlers, stopped) {
  let r = gen.next();
  while (!r.done) {
    const v = await handlers[r.value.op](r.value);
    if (stopped()) throw new UgrepError('rg-native: the search was stopped');
    r = gen.next(v);
  }
  return r.value;
}
// A ugrep below the floor (or not ugrep at all) refuses; none at all is the listing's or the match's
// to refuse (a named file decided by the matcher alone needs none).
function capsOutcome(caps) {
  return !caps || caps.format ? {} : { refusal: rgRefusal(caps.reason) };
}
const missingUgrep = (opts) => (opts.missing ? opts.missing()
  : rgRefusal('quaude answers rg with ugrep, on purpose, and this host has no ugrep (set CLODE_UGREP or install ugrep); nothing was searched'));

// A search's synchronous run (runRg's, for spawnSync and execFileSync). Bounded by the caller's
// timeout when it names one (every ugrep run and every slice of deciding checks it, ETIMEDOUT as
// node reports it), and per line by RG-RE-REFUSE-COST with or without one. The 2.1.283 bundle calls
// rg through no synchronous surface (measured, Task 5b review), so this is the bound for anyone who does.
function searchSync(plan, opts) {
  const spawnSync = opts.spawnSync || require('child_process').spawnSync;
  const env = opts.env || process.env;
  const deadline = typeof opts.timeout === 'number' && opts.timeout > 0 ? Date.now() + opts.timeout : 0;
  const { spec, ugrep } = plan;
  const handlers = {
    caps: () => capsOutcome(ugrep && ugrepCapabilities(ugrep, { spawnSync, timeout: deadline ? Math.max(1, deadline - Date.now()) : undefined })),
    match: ({ files, pattern, first, known }) => {
      const o = { ugrep, cwd: opts.cwd, env, ignoreCase: spec.ignoreCase, multiline: spec.multiline, dotall: spec.dotall, spawnSync, deadline, first, known };
      try { return { matches: (opts.matchFiles || ugrepMatches)(files, pattern, o) }; } catch (e) { return matchOutcome(e, opts, ugrep); }
    },
    // input: the bytes, or (a command's fd 0: rg-entry.cjs) a function read only when the search reaches stdin
    stdin: () => { const i = typeof opts.input === 'function' ? opts.input() : opts.input; return typeof i === 'string' ? Buffer.from(i, 'utf8') : toBuf(i); },
    // RG-STREAM: the next piece of a command's stdin (a Buffer, null at its end), or { error } (rg's for <stdin>)
    stdinChunk: () => { try { return opts.stdinChunk ? opts.stdinChunk() : null; } catch (e) { return { error: e }; } },
    decide: ({ text, t, first }) => { try { return { matches: matchTextLines(text, t, deadline, first) }; } catch (e) { return matchOutcome(e, opts, ugrep); } },
    // printing: the caller's timeout is checked as it goes
    tick: () => { if (deadline && Date.now() > deadline) throw timedOutError(); return null; },
  };
  let res;
  try { res = driveSync(searchCore(spec, { cwd: opts.cwd, env, onRejected: opts.onRejected, ugrepName: ugrep && leafOf(ugrep), deadline, maxBuffer: opts.maxBuffer,
    stream: !!opts.stream, sink: opts.sink, streamRead: opts.streamRead }), handlers); } catch (e) {
    if (e && e.timedOut) return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), status: null, signal: opts.killSignal || 'SIGTERM', errorCode: 'ETIMEDOUT' };
    throw e;
  }
  if (typeof opts.maxBuffer === 'number' && res.stdout && res.stdout.length > opts.maxBuffer) {
    return { stdout: res.stdout.subarray(0, opts.maxBuffer), stderr: res.stderr, status: null, signal: opts.killSignal || 'SIGTERM', errorCode: 'ENOBUFS' };
  }
  return res;
}

// A child process run to its end: { stdout, stderr, status, signal } or { error }; `onChild` is told
// of it (so a kill can reach it).
function runChild(spawn, bin, argv, o, onChild) {
  return new Promise((resolve) => {
    let c;
    try { c = spawn(bin, argv, { cwd: o.cwd, env: o.env, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { resolve({ error: e }); return; }
    onChild(c);
    const outs = [], errs = [];
    let settled = false;
    c.stdout.on('data', (d) => outs.push(toBuf(d)));
    c.stderr.on('data', (d) => errs.push(toBuf(d)));
    c.on('error', (e) => { if (!settled) { settled = true; resolve({ error: e }); } });
    c.on('close', (status, signal) => { if (!settled) { settled = true; resolve({ stdout: Buffer.concat(outs), stderr: Buffer.concat(errs), status, signal: signal || null }); } });
  });
}
// Every line of `text` decided by the matcher, in slices, `between()` after each (it yields to the
// event loop and throws once the search is stopped).
async function matchTextLinesAsync(text, t, between, first) {
  return decideLinesAsync(text, await drainAsync(candidateLinesGen(text, null, true), between), t, between, first);
}

// A search's asynchronous run (rgSpawn's, for spawn, execFile and Bun.spawn): a child of node's shape
// whose work is ugrep children run one after another and the matcher in slices, so the event loop
// keeps turning, and whose kill() (the caller's own, or its signal or timeout) ends the ugrep running
// and stops the search at its next step. Its stdin is read when a target is `-` (RG-STDIN), and
// ignored otherwise, as rg ignores it.
function searchChild(plan, opts, ctx) {
  const { Writable } = require('stream');
  const { spec, ugrep } = plan;
  let current = null, stopped = null, wake = null;
  const sh = childShell(opts, (sig) => {
    stopped = stopped || sig;
    if (current) { try { current.kill(sig); } catch { /* gone */ } }
    if (wake) wake();
    return true;
  });
  const { child } = sh;
  child.pid = undefined;                    // no process of its own
  const wantsStdin = spec.paths.includes('-');
  let stdinDone;
  const stdinP = new Promise((resolve) => { stdinDone = resolve; });
  if (stdioSlots(opts)[0] === 'pipe') {
    const chunks = [];
    child.stdin = new Writable({ write(c, enc, cb) { if (wantsStdin) chunks.push(toBuf(c)); cb(); } });
    child.stdin.on('finish', () => stdinDone(Buffer.concat(chunks)));
  } else { child.stdin = null; stdinDone(Buffer.alloc(0)); }
  const env = opts.env || process.env;
  const stopSignal = { get aborted() { return !!stopped; } };
  let slice = Date.now();
  const between = async () => {
    if (Date.now() - slice > DECIDE_SLICE_MS) { await new Promise((r) => setTimeout(r, 0)); slice = Date.now(); }
    if (stopped) throw new UgrepError('rg-native: the search was stopped');
  };
  const handlers = {
    caps: async () => capsOutcome(ugrep && await ugrepCapabilitiesAsync(ugrep, { spawn: ctx.spawn })),
    match: async ({ files, pattern, first, known }) => {
      try {
        const how = { ignoreCase: spec.ignoreCase, multiline: spec.multiline, dotall: spec.dotall };
        if (ctx.matchFiles) return { matches: ctx.matchFiles(files, pattern, { cwd: opts.cwd, ...how, first }) };
        return { matches: await ugrepMatchesAsync(files, pattern, { ugrep, cwd: opts.cwd, env, ...how, spawn: ctx.spawn, first, known,
          spawnSync: ctx.spawnSync, onChild: (c) => { current = c; }, signal: stopSignal }) };
      } catch (e) { if (stopped) return {}; return matchOutcome(e, ctx, ugrep); } finally { current = null; }
    },
    stdin: () => new Promise((resolve) => { wake = () => resolve(Buffer.alloc(0)); stdinP.then(resolve); }),
    decide: async ({ text, t, first }) => {
      try { return { matches: await matchTextLinesAsync(text, t, between, first) }; } catch (e) { if (stopped) return {}; return matchOutcome(e, ctx, ugrep); }
    },
    // printing: the event loop is handed back once a slice is spent (Task 7 review I2)
    tick: async () => {
      if (Date.now() - slice > DECIDE_SLICE_MS) { await new Promise((r) => setTimeout(r, 0)); slice = Date.now(); }
      return null;
    },
  };
  setTimeout(async () => {
    if (sh.isDone()) return;
    child.emit('spawn');
    if (stopped) { sh.finish({ status: null, signal: stopped, stderr: null }); return; }
    let res;
    try { res = await driveAsync(searchCore(spec, { cwd: opts.cwd, env, onRejected: ctx.onRejected, ugrepName: ugrep && leafOf(ugrep), maxBuffer: ctx.maxBuffer }), handlers, () => !!stopped); }
    catch (e) { res = stopped ? null : rgRefusal(`quaude's rg failed (${(e && e.message) || e}); nothing was found`); }
    if (stopped || !res) { sh.finish({ status: null, signal: stopped, stderr: null }); return; }
    sh.out(toBuf(res.stdout));
    sh.finish(res);
  }, 0);
  return child;
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

// child_process.spawn (and Bun.spawn, which bun-shim builds on it): searchChild's (its ugrep children
// asynchronous, the caller's stdin read for target `-`), or a refusal's. ctx: what runRg's opts carry
// (ugrep, missing, matchFiles, debug, spawnSync, onRejected), plus
//   spawn                 the UNWRAPPED asynchronous spawn
//   maxBuffer             (rgExecFile's) where a search stops printing; spawn has no such bound
function rgSpawn(argv, opts = {}, ctx) {
  opts = withSpawnCwd(opts);
  const plan = rgPlan(argv, ctx);
  if (plan.result) return refusedChild(plan.result, opts);
  return searchChild(plan, opts, ctx);
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
  // The search stops printing once past maxBuffer (as execFile would kill the child there).
  const child = rgSpawn(argv, { ...o, stdio: 'pipe' }, { ...ctx, maxBuffer });
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

module.exports = { isRgExe, rgRefusal, parseRgRefusal, untranslatableReason, runRg, rgSpawnCwd, descriptorRefused, rgSpawn, rgExecFile, rgSpawnSync, rgExecFileSync, RG_MAX_BUFFER,
  UGREP_MIN, parseUgrepVersion, versionAtLeast, ugrepCapabilities, ugrepCapabilitiesAsync, ugrepMatchArgv, chunkFiles, parseUgrepRanges,
  ugrepMatches, ugrepMatchesAsync, matchFilesAlone, parseRgSearch, UgrepError, rgText, searchStats, FILL_TICK_BYTES, osErrorText };
