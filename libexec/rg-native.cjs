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
// A SEARCH (rg's standard printer, -l, -c) is answered here, rule by rule as native answers it
// (grep-native Task 6, "quaude's rg answers a search itself" below): the plumbing (ugrepMatches and
// ugrepMatchesAsync: an explicit file list in, rg's match byte ranges out, over a ugrep at or above
// UGREP_MIN, UGREP PROPOSING candidate lines and rg-regex.cjs's matcher DECIDING them) and rg's
// printers over rg's own text. What it does not answer yet still goes to today's rg -> ugrep
// translation, which bun-shim owns and passes in (`translate`): --json (Task 7), --files (Task
// 10), --version and --type (Task 9). The walk is ugrep's under today's flags until Task 9's.
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
//   ugrep()               the ugrep a search runs (null: this host has none)
//   missing()             the refusal when a search needs ugrep and there is none
//   matchFiles            what decides files' matches instead of ugrepMatches (tests: the matcher alone)
//   debug(argv, verdict)  told of each call's verdict (CLODE_RG_DEBUG's line)
//   translate(argv)       -> { argv: [applet, ...] } or { refuse, flag } — today's translation, for
//                         what a search does not answer yet (rgPlan)
//   spawnSync             the UNWRAPPED spawnSync to run ugrep and the applet with
//   onRejected(argv, st)  told when an applet rejected a search or the translation
// A search is searchSync's, bounded by the caller's timeout (see there).
// Returns { stdout, stderr, status, signal }, plus `refused` for a refusal and `errorCode` when
// a bound fired (node's spawnSync reports ETIMEDOUT / ENOBUFS; node-shim's ETIMEDOUT for both).
function runRg(argv, opts = {}) {
  const plan = rgPlan(argv, opts);
  if (plan.result) return plan.result;
  if (!plan.translate) return searchSync(plan, opts);
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
  try { r = spawnSync(bin, ['--version'], { encoding: 'buffer', timeout: 30000 }); } catch (e) { r = { error: e }; }
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
  const lastEnd = new Map();
  const bad = (at) => { throw new UgrepError(`rg-native: ugrep's --format output is not path NUL start SP end LF at byte ${at}`, { matches: into }); };
  const num = (j) => {
    let v = 0;
    const from = j;
    for (let d; j < buf.length && (d = buf[j]) >= 0x30 && d <= 0x39; j++) v = v * 10 + (d - 0x30);
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
  while (i < buf.length) {
    const z = buf.indexOf(0, i);
    if (z === -1) bad(i);
    const file = sameName(i, z - i) ? lastName : (lastName = buf.toString('utf8', i, z));
    lastAt = i; lastLen = z - i;
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
function matchPlan(files, prefilter, opts, perLine) {
  // A directory is searched as NOTHING (ugrep exits 0 on one without -r): the walk lists files,
  // so a directory here is the caller's mistake, refused rather than answered "no matches".
  // RG-TEXT-BOM: each file's first bytes, read here once, say whether its text is rg's decoding
  // of a byte order mark (every line then decided, whatever ugrep proposed).
  const fs = require('fs'), path = require('path');
  const bom = new Set();
  for (const f of files) {
    let st = null;
    const p = path.resolve(opts.cwd || process.cwd(), f);
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
  return { chunks, inOrder, onlyAsked, bom };
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
function rgText(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return bytes.subarray(3);
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return utf16ToUtf8(bytes.subarray(2), true);
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return utf16ToUtf8(bytes.subarray(2), false);
  return bytes;
}
// The WHATWG UTF-16 decoder (what encoding_rs implements), straight to UTF-8 bytes.
function utf16ToUtf8(b, le) {
  const out = Buffer.alloc(b.length * 2 + 4);
  let o = 0;
  const put = (c) => {
    if (c < 0x80) out[o++] = c;
    else if (c < 0x800) { out[o++] = 0xc0 | (c >> 6); out[o++] = 0x80 | (c & 0x3f); }
    else if (c < 0x10000) { out[o++] = 0xe0 | (c >> 12); out[o++] = 0x80 | ((c >> 6) & 0x3f); out[o++] = 0x80 | (c & 0x3f); }
    else { out[o++] = 0xf0 | (c >> 18); out[o++] = 0x80 | ((c >> 12) & 0x3f); out[o++] = 0x80 | ((c >> 6) & 0x3f); out[o++] = 0x80 | (c & 0x3f); }
  };
  let lead = -1;
  const n = b.length >> 1;
  for (let i = 0; i < n; i++) {
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
  if (lead !== -1 || (b.length & 1)) put(0xfffd); // one, for whatever was left over
  return out.subarray(0, o);
}

// The lines of `text` to decide: those holding a proposed offset, or (`all`) every line.
// [lineStart, lineEnd) pairs, the terminator excluded, ascending.
function candidateLines(text, proposed, all) {
  const out = [];
  const lineAt = (ls) => { let le = text.indexOf(0x0a, ls); if (le === -1) le = text.length; out.push(ls, le); return le + 1; };
  if (all) { for (let ls = 0; ls < text.length;) ls = lineAt(ls); return out; }
  const starts = new Set();
  for (const { start } of proposed || []) {
    if (start > text.length || (start === text.length && (text.length === 0 || text[text.length - 1] === 0x0a))) continue;
    starts.add(start === 0 ? 0 : text.lastIndexOf(0x0a, start - 1) + 1);
  }
  for (const ls of [...starts].sort((a, b) => a - b)) lineAt(ls);
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
  const { text, lines } = fileLines(file, proposed, opts, all);
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
  const t = rgRegexModule().translateRgRegex(pattern, { ignoreCase: !!opts.ignoreCase });
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
    const m = takesUgrepRanges(t) && !bom.has(f) ? proposed.get(f) : decideFile(f, proposed.get(f), t, opts, bom.has(f));
    if (m.length) out.set(f, m);
  }
  return out;
}

// What a failed search found before it failed, decided as any other: the error's `matches`.
// Best effort: the search has already failed, so a file that cannot be decided adds nothing.
function partialMatches(files, proposed, t, opts) {
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
  const { chunks, inOrder, onlyAsked, bom } = matchPlan(files, t.prefilter, opts, !takesUgrepRanges(t));
  const ranges = new Map();
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
    if (r.status >= 2) { readFailedChunk(toBuf(r.stdout), ranges); failed = { r, stderr: r.stderr }; break; }
    parseUgrepRanges(toBuf(r.stdout), ranges);
  }
  if (failed) throw ugrepFailed(opts.ugrep, failed.r, failed.stderr, partialMatches(files, inOrder(ranges), t, opts));
  onlyAsked(ranges);
  return decideAll(files, inOrder(ranges), bom, t, opts);
}

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
  let plan, t;
  try { t = translated(pattern, opts); assertUsableUgrep(opts); plan = matchPlan(files, t.prefilter, opts, !takesUgrepRanges(t)); } catch (e) { return Promise.reject(e); }
  const spawn = opts.spawn || require('child_process').spawn;
  const { chunks, inOrder, onlyAsked, bom } = plan;
  const aborted = () => opts.signal && opts.signal.aborted;
  const abortError = () => new UgrepError('rg-native: the search was aborted');
  const ranges = new Map();
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
      // Killed: the bytes may stop anywhere, so they are not read; the kill is the answer.
      // Exit >= 2: the failure is the answer (re-review N-1), the bytes only add the matches found first.
      if (status !== null && !signal) {
        if (status >= 2) readFailedChunk(Buffer.concat(outs), ranges);
        else { try { parseUgrepRanges(Buffer.concat(outs), ranges); } catch (e) { reject(e); return; } }
      }
      resolve({ status, signal: signal || null, stderr: Buffer.concat(errs) });
    });
  });
  const yieldLoop = () => new Promise((r) => setTimeout(r, 0));
  return (async () => {
    if (aborted()) throw abortError();
    let failed = null;
    for (const argv of chunks) {
      const r = await runOne(argv);
      // A failed chunk (killed by the caller, or exit >= 2) ends the search: no later chunk runs.
      if (r.status === null || r.status >= 2) { failed = r; break; }
      if (aborted()) throw abortError();
    }
    if (failed) throw ugrepFailed(opts.ugrep, failed, failed.stderr, partialMatches(files, inOrder(ranges), t, opts));
    onlyAsked(ranges);
    const proposed = inOrder(ranges);
    const out = new Map(), seen = new Set();
    let slice = Date.now();
    const between = async () => {
      if (Date.now() - slice > DECIDE_SLICE_MS) { await yieldLoop(); slice = Date.now(); }
      if (aborted()) throw abortError();
    };
    for (const f of files) {
      if (seen.has(f) || (!proposed.has(f) && !bom.has(f))) continue;
      seen.add(f);
      await between();
      const m = takesUgrepRanges(t) && !bom.has(f) ? proposed.get(f) : await decideFileAsync(f, proposed.get(f), t, opts, bom.has(f), between);
      if (m.length) out.set(f, m);
    }
    return out;
  })();
}

// ==== quaude's rg answers a search itself (grep-native Task 6) ===================================
// A search (rg's standard printer, -l, or -c) no longer goes through today's translation: quaude's
// rg reads rg's argv (parseRgSearch), finds what to search (its targets: stdin, named files, and a
// directory's files as ugrep's walk lists them under today's walk flags, until the plan's Task 9
// walks in JS), takes every file's matches from ugrepMatches (stdin's from the matcher alone), and
// PRINTS THEM AS rg's PRINTERS DO, from rg's own text of each file (RG-TEXT-BOM). --json (Task 7),
// --files (Task 10), --version and --type (Task 9) still go to the translation; -U refuses (Task 10).
//
// THE RULES, one statement each, every one measured against native 2.1.283's embedded rg (ripgrep
// 14.1.1) and pinned by a same-named test in test/rg-native.test.cjs (native's literals):
//   RG-ARGV                    the flags a search reads; -l and -c, the last one wins; a number
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
//                              as a match
//   RG-STDIN                   `-` searches what the caller piped in, named `<stdin>`; to rg it is a
//                              NAMED path, so a NUL in it does not end the search (review I-1)
//   RG-FIRST-MATCH             -l stops at a file's first match, -c and the standard printer
//                              without -o at a line's first (rg-regex.cjs RG-RE-EARLIEST), as rg
//                              does; -o and -c -o find every match
//   RG-EXIT                    0 found, 1 not found, 2 when any path failed (its error on stderr, the
//                              rest still searched and printed): never quaude's refusal
//   RG-BINARY-QUIT-FIRST-READ  INTERIM (the plan's Task 8 replaces it with rg's LineBuffer): a WALKED
//                              file whose first 64 KiB of text hold a NUL prints nothing; a NAMED
//                              file, and stdin, are searched as text (native's convert mode, Task 8)
//
// WHERE WE PRINT. As rg prints to a pipe or a file, which is what every surface the bundle uses
// hands it (no heading, no colour, no line numbers unless -n).

// ---- rg's argv, as a search reads it -------------------------------------------------------------
// The flags quaude's rg answers itself. Anything else is refused BY NAME, never passed on to an
// applet that reads it some other way (ugrep's -U is --binary, for one).
const LONG_BOOL = {
  '--files-with-matches': (s) => { s.mode = 'files'; }, '--count': (s) => { s.mode = 'count'; },
  '--ignore-case': (s) => { s.ignoreCase = true; }, '--case-sensitive': (s) => { s.ignoreCase = false; },
  '--line-number': (s) => { s.lineNumber = true; }, '--no-line-number': (s) => { s.lineNumber = false; },
  '--with-filename': (s) => { s.withFilename = true; }, '--no-filename': (s) => { s.withFilename = false; },
  '--null': (s) => { s.nul = true; }, '--only-matching': (s) => { s.only = true; },
  '--hidden': (s) => { s.hidden = true; }, '--no-hidden': (s) => { s.hidden = false; }, '--no-ignore': (s) => { s.noIgnore = true; },
};
const SHORT_BOOL = { l: '--files-with-matches', c: '--count', i: '--ignore-case', s: '--case-sensitive', n: '--line-number',
  N: '--no-line-number', H: '--with-filename', I: '--no-filename', 0: '--null', o: '--only-matching', '.': '--hidden' };
const LONG_VALUE = { '--after-context': 'after', '--before-context': 'before', '--context': 'context', '--max-columns': 'maxColumns',
  '--regexp': 'pattern', '--glob': 'glob', '--iglob': 'iglob', '--threads': 'threads' };
const SHORT_VALUE = { A: 'after', B: 'before', C: 'context', M: 'maxColumns', e: 'pattern', g: 'glob', j: 'threads' };
// Still today's translation's: --json (Task 7), --files (Task 10), --version and the type flags (Task 9).
const TRANSLATED_LONG = new Set(['--json', '--files', '--version', '--type', '--type-not', '--type-list', '--type-add', '--type-clear']);
const TRANSLATED_SHORT = new Set(['t', 'T', 'V']);
// The reason quaude's rg gives for a flag it cannot answer as native does (stated once; bun-shim's
// translation refuses with it too).
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
  const r = rgNumber(flag, v);
  if (r.usage) return r;
  s[key] = r.n;
  return null;
}

// parseRgSearch(argv) -> { spec } | { translate: true } | { refuse, flag } | { usage: stderr line }
function parseRgSearch(argv) {
  const s = { mode: 'standard', patterns: [], ignoreCase: false, lineNumber: false, withFilename: null, nul: false, only: false,
    before: null, after: null, context: null, maxColumns: 0, hidden: false, noIgnore: false, globs: [], threads: null, paths: [] };
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
      if (TRANSLATED_LONG.has(name)) return { translate: true };
      if (LONG_BOOL[name] && eq === -1) LONG_BOOL[name](s);
      else if (LONG_VALUE[name]) r = setValue(s, LONG_VALUE[name], name, eq !== -1 ? a.slice(eq + 1) : i + 1 < argv.length ? argv[++i] : null);
      else return cannotYet(name);
    } else {
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        if (TRANSLATED_SHORT.has(c)) return { translate: true };
        if (SHORT_VALUE[c]) { const rest = a.slice(j + 1); r = setValue(s, SHORT_VALUE[c], `-${c}`, rest !== '' ? rest : i + 1 < argv.length ? argv[++i] : null); break; }
        if (!SHORT_BOOL[c]) return cannotYet(`-${c}`);
        LONG_BOOL[SHORT_BOOL[c]](s);
      }
    }
    if (r) return r;
  }
  if (!s.patterns.length) {
    if (!pos.length) return { refuse: 'quaude answers rg with its own emulation over ugrep, on purpose, and this rg names no pattern; nothing was searched' };
    s.patterns.push(pos.shift());
  }
  if (s.patterns.length > 1) return cannotYet('-e');
  // rg with no path searches its stdin or the working directory, by what its stdin is; every rg the
  // bundle runs names one, so quaude's rg does not guess.
  if (!pos.length) return { refuse: 'quaude answers rg with its own emulation over ugrep, on purpose, and this rg names no path to search; nothing was searched' };
  s.paths = pos;
  s.before = s.before !== null ? s.before : s.context || 0;
  s.after = s.after !== null ? s.after : s.context || 0;
  s.countMatches = s.mode === 'count' && s.only;
  return { spec: s };
}

// ---- what a search searches -----------------------------------------------------------------------
// rg's error for a path, as rg spells it: `Permission denied (os error 13)`. Both halves come from
// the engine, never a table here: the number from os.constants.errno, the text from libuv's message
// for it (node puts it in the error's message; tjs answers it as `new tjs.Error(-errno)`), whose
// first letter rg's libc strerror capitalizes (they agree for the errors a search meets: ENOENT,
// EACCES, ENOTDIR; measured against native's literals in test/rg-native.test.cjs).
function sysErrorText(n) {
  try {
    const util = require('util');
    if (typeof util.getSystemErrorMessage === 'function') return util.getSystemErrorMessage(-n);
    if (typeof util.getSystemErrorMap === 'function') { const e = util.getSystemErrorMap().get(-n); if (e) return e[1]; }
  } catch { /* not this engine's */ }
  try {
    if (globalThis.tjs && typeof globalThis.tjs.Error === 'function') {
      const m = /^[A-Z0-9_]+: (.+)$/.exec(new globalThis.tjs.Error(-n).message);
      if (m) return m[1];
    }
  } catch { /* not this engine's */ }
  return null;
}
const errnoTable = () => { const os = require('os'); return (os.constants && os.constants.errno) || {}; };
const capital = (t) => t[0].toUpperCase() + t.slice(1);
function osErrorText(e) {
  const code = e && e.code;
  const n = code ? errnoTable()[code] : undefined;
  const m = /^[A-Z0-9_]+: ([^,]+)/.exec(String((e && e.message) || ''));
  const text = m ? m[1] : n !== undefined ? sysErrorText(n) : null;
  return text ? `${capital(text)}${n !== undefined ? ` (os error ${n})` : ''}` : String(code || (e && e.message) || 'unknown error');
}
// What ugrep's walk says it could not read (the platform's strerror), as rg says it: the number is
// the errno whose engine text is that text.
function strerrorText(text) {
  const want = String(text).toLowerCase();
  for (const n of Object.values(errnoTable())) {
    const t = sysErrorText(n);
    if (t && t.toLowerCase() === want) return `${text} (os error ${n})`;
  }
  return text;
}

// THE WALK, INTERIM (the plan's Task 9 replaces it with rg's own, in JS): a directory's files are
// what ugrep's walk lists under today's walk flags (bun-shim's rgToUgrep: -r, --ignore-files unless
// --no-ignore, -. for --hidden, --include/--exclude for --glob), `-l` over an empty pattern so a file
// is listed whatever it holds (an EMPTY file is not, and has no line rg could match), with no -I: a
// binary is rg's decision (RG-BINARY-QUIT-FIRST-READ), not ugrep's.
function walkArgv(spec, P) {
  const a = ['-r'];
  if (!spec.noIgnore) a.push('--ignore-files');
  if (spec.hidden) a.push('-.');
  for (const [k, g] of spec.globs) a.push(k === 'iglob' ? `--iglob=${g}` : g[0] === '!' ? `--exclude=${g.slice(1)}` : `--include=${g}`);
  return [...a, '-l', '--null', '-e', '', '--', spellForUgrep(P)];
}
// ugrep's listing of target P as [{ disp, file }] and rg's errors. ugrep prints `.`'s files bare and
// any other target's as the target (trailing slashes dropped) joined by `/` (measured, 7.8.2);
// RG-PATH-SPELLING joins them to P as rg does.
function readListing(P, stdout, stderr) {
  const spelled = spellForUgrep(P);
  const prefix = spelled === '.' || spelled === './' ? '' : spelled.replace(/\/+$/, '') + '/';
  const rel = (u) => (u === spelled || u === spelled.replace(/\/+$/, '') ? '' : prefix === '' ? u : u.startsWith(prefix) ? u.slice(prefix.length) : null);
  const disp = (r) => (r === '' ? P : P + (P.endsWith('/') ? '' : '/') + r);
  const files = [], errors = [], unknown = [];
  for (const name of toBuf(stdout).toString('utf8').split('\0')) {
    if (!name) continue;
    const r = rel(name);
    if (r === null || r === '') throw new UgrepError(`rg-native: ugrep listed ${JSON.stringify(name)}, which is not under ${JSON.stringify(P)}`);
    files.push({ disp: disp(r), file: name });
  }
  for (const line of toBuf(stderr).toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    const m = /^ugrep: (?:warning: )?cannot (?:read|open directory|open)(?: file)? (.*): ([^:]+)$/.exec(line);
    const r = m ? rel(m[1]) : null;
    if (m) errors.push(`rg: ${r === null ? m[1] : disp(r)}: ${strerrorText(m[2])}`);
    else unknown.push(`rg: ${line.replace(/^ugrep: (?:warning: )?/, '')}`);
  }
  return { files, errors, unknown };
}

// A file's text, as rg reads it (RG-TEXT-BOM); `limit` bytes of it when only its start matters.
function readRgText(file, cwd, limit) {
  const fs = require('fs'), path = require('path');
  const p = path.resolve(cwd || process.cwd(), file);
  if (!limit) return rgText(fs.readFileSync(p));
  const fd = fs.openSync(p, 'r');
  try { const b = Buffer.alloc(limit); return rgText(b.subarray(0, fs.readSync(fd, b, 0, limit, 0))); } finally { fs.closeSync(fd); }
}
const FIRST_READ = 64 * 1024;   // rg's first read of a file (grep-searcher's DEFAULT_BUFFER_CAPACITY)
const binaryAtFirstRead = (text) => text.subarray(0, FIRST_READ).indexOf(0) !== -1;

// Every line of `text` decided by the matcher alone: stdin, and matchFilesAlone.
function matchTextLines(text, t, deadline, first) { return decideLines(text, candidateLines(text, null, true), t, deadline, first); }
// matchFilesAlone(files, pattern, opts) -> Map: the same answer as ugrepMatches with no ugrep, every
// line of every file decided by the matcher (slower; what stdin always takes).
function matchFilesAlone(files, pattern, opts = {}) {
  const t = translated(pattern, opts);
  const out = new Map();
  for (const f of files) {
    if (out.has(f)) continue;
    const m = matchTextLines(readRgText(f, opts.cwd), t, opts.deadline, opts.first);
    if (m.length) out.set(f, m);
  }
  return out;
}

// ---- rg's printers -------------------------------------------------------------------------------
const NL = Buffer.from('\n');
const SEP = Buffer.from('--\n');
const OMITTED_MATCH = Buffer.from('[Omitted long matching line]');
const OMITTED_CONTEXT = Buffer.from('[Omitted long context line]');
// One file's (or stdin's) output into `out` (an array of Buffers): true when rg found something in it.
// `state.printed` carries "something was printed before" across files (RG-CONTEXT's `--`).
function printFile(spec, e, out, state) {
  const { text, matches } = e;
  if (spec.mode === 'files') { out.push(Buffer.from(e.disp + (spec.nul ? '\0' : '\n'))); return true; }
  // RG-RE-MATCH-AT-UNTERMINATED-END: such a match selects its line; it is never printed.
  const unterminated = text.length > 0 && text[text.length - 1] !== 0x0a;
  const sel = [];
  for (const m of matches) {
    const ls = m.start === 0 ? 0 : text.lastIndexOf(0x0a, m.start - 1) + 1;
    let L = sel[sel.length - 1];
    if (!L || L.ls !== ls) { L = { ls, ms: [] }; sel.push(L); }
    if (!(unterminated && m.start === text.length)) L.ms.push(m);
  }
  if (!sel.length) return false;
  const path = e.withFilename ? Buffer.from(e.disp) : null;
  // A file with a selected line prints its count, even a -c -o count of 0 (its only match was the
  // unprintable one at an unterminated end: native prints `0`); a file with none prints nothing.
  if (spec.mode === 'count') {
    const n = spec.countMatches ? sel.reduce((a, L) => a + L.ms.length, 0) : sel.length;
    out.push(...(path ? [path, Buffer.from(spec.nul ? '\0' : ':')] : []), Buffer.from(`${n}\n`));
    return true;
  }
  const cols = spec.maxColumns;
  const lineEnd = (ls) => { const i = text.indexOf(0x0a, ls); return i === -1 ? text.length : i; };
  const next = (ls) => { const i = text.indexOf(0x0a, ls); return i === -1 || i + 1 >= text.length ? -1 : i + 1; };
  const prev = (ls) => (ls === 0 ? -1 : ls < 2 ? 0 : text.lastIndexOf(0x0a, ls - 2) + 1);
  const prefix = (num, sep) => {
    const p = [];
    if (path) p.push(path, Buffer.from(spec.nul ? '\0' : sep));
    if (spec.lineNumber) p.push(Buffer.from(`${num}${sep}`));
    return p;
  };
  const emit = (ls, num, ms) => {
    const sep = ms ? ':' : '-';
    if (ms && spec.only && ms.length) {
      for (const m of ms) out.push(...prefix(num, sep), cols && m.end - m.start > cols ? OMITTED_MATCH : text.subarray(m.start, m.end), NL);
      return;
    }
    const le = lineEnd(ls), end = le < text.length ? le + 1 : le;
    if (cols && end - ls > cols) out.push(...prefix(num, sep), ms ? OMITTED_MATCH : OMITTED_CONTEXT, NL);
    else { out.push(...prefix(num, sep), text.subarray(ls, end)); if (end === le) out.push(NL); }
  };
  // Line numbers, counted forward once.
  let at = 0, atNum = 1;
  const numAt = (ls) => { for (let i = text.indexOf(0x0a, at); i !== -1 && i < ls; i = text.indexOf(0x0a, i + 1)) atNum++; at = ls; return atNum; };
  const ctx = spec.before > 0 || spec.after > 0;
  let cur = -1, curNum = 0, pend = 0;
  const drainAfter = (upTo) => {
    for (let nx; pend > 0 && (nx = next(cur)) !== -1 && (upTo === -1 || nx < upTo); pend--) { emit(nx, curNum + 1, null); cur = nx; curNum++; }
  };
  for (const L of sel) {
    const n = numAt(L.ls);
    drainAfter(L.ls);
    let first = L.ls, firstNum = n;
    for (let k = 0, p; k < spec.before && (p = prev(first)) !== -1 && (cur === -1 || p > cur); k++) { first = p; firstNum--; }
    if (ctx && state.printed && (cur === -1 || next(cur) !== first)) out.push(SEP);
    for (let ls = first, num = firstNum; ls !== L.ls; ls = next(ls), num++) emit(ls, num, null);
    emit(L.ls, n, L.ms);
    state.printed = true;
    cur = L.ls; curNum = n; pend = spec.after;
  }
  drainAfter(-1);
  return true;
}

// ---- the search, once: a generator both twins drive --------------------------------------------------
// It yields what it needs done ({ op: 'list', P }, { op: 'match', files, pattern }, { op: 'stdin' },
// { op: 'decide', text }) and is answered synchronously (runRg) or asynchronously (rgSpawn), so the
// rules above are stated once. It returns { stdout, stderr, status } or a refusal.
function* searchCore(spec, opts) {
  const fs = require('fs'), path = require('path');
  const cwd = opts.cwd || process.cwd();
  const pattern = spec.patterns[0];
  let t;
  try { t = translated(pattern, { ignoreCase: spec.ignoreCase }); } catch (e) { if (e.refused) return rgRefusal(e.message); throw e; }
  const kinds = spec.paths.map((P) => {
    if (P === '-') return { kind: 'stdin' };
    try { return { kind: fs.statSync(path.resolve(cwd, P)).isDirectory() ? 'dir' : 'file' }; } catch (e) { return { kind: 'error', e }; }
  });
  // rg walks one path that is not a directory (and anything under -j1) with walkdir, whose error for
  // a path it cannot stat says so; its parallel walker's does not (measured: nope.txt alone, with
  // -j1, and beside a.txt).
  const oneFile = spec.paths.length === 1 && kinds[0].kind !== 'dir';
  const sequential = spec.threads === 1 || oneFile;
  const withFilename = spec.withFilename !== null ? spec.withFilename : !oneFile;
  // The ugrep at or above UGREP_MIN (refused otherwise, before it is asked anything else).
  if (kinds.some((k) => k.kind === 'dir' || k.kind === 'file')) {
    const c = yield { op: 'caps' };
    if (c.refusal) return c.refusal;
  }
  const entries = [];
  for (let i = 0; i < spec.paths.length; i++) {
    const P = spec.paths[i], k = kinds[i];
    if (k.kind === 'stdin') entries.push({ disp: '<stdin>', stdin: true, walked: false });
    else if (k.kind === 'error') entries.push({ error: `rg: ${P}: ${sequential ? `IO error for operation on ${P}: ` : ''}${osErrorText(k.e)}` });
    else if (k.kind === 'file') {
      let err = null;
      try { fs.closeSync(fs.openSync(path.resolve(cwd, P), 'r')); } catch (e) { err = e; }
      entries.push(err ? { error: `rg: ${P}: ${osErrorText(err)}` } : { disp: P, file: P, walked: false });
    } else {
      const r = yield { op: 'list', P, argv: walkArgv(spec, P) };
      if (r.refusal) return r.refusal;
      const { files, errors, unknown } = readListing(P, r.stdout, r.stderr);
      // ugrep's walk exits 2 whenever it WARNS (7.8.2, measured: one unreadable file or directory),
      // and each warning is rg's own per-path error, printed above: that is rg's answer, not skew.
      // Anything else at rc >= 2 is ugrep failing: the operator hears of it, and when it listed
      // nothing and said nothing rg would say, the search refuses.
      const legit = errors.length > 0 && unknown.length === 0;
      if (r.status >= 2 && !legit && opts.onRejected) opts.onRejected([opts.ugrepName || 'ugrep', ...walkArgv(spec, P)], r.status, 'walk');
      if (r.status >= 2 && !files.length && !errors.length) return appletRejected(opts.ugrepName || 'ugrep', r.status, r.stderr);
      for (const f of files) entries.push({ ...f, walked: true });
      for (const e of [...errors, ...unknown]) entries.push({ error: e });
    }
  }
  // FIRST_MATCH: what each mode needs to know of a file's matches. -l only whether there is one,
  // -c (lines) and the standard printer without -o only which lines hold one, as rg itself stops
  // there; -o and -c -o every printable match.
  const first = spec.mode === 'files' ? 'file' : !spec.only ? 'line' : undefined;
  const files = [...new Set(entries.filter((e) => e.file).map((e) => e.file))];
  let matches = new Map(), failed = null;
  if (files.length) {
    const r = yield { op: 'match', files, pattern, first };
    if (r.refusal) return r.refusal;
    if (r.error) { failed = r.error; matches = r.error.matches || new Map(); } else matches = r.matches;
  }
  const out = [], err = [], state = { printed: false };
  let found = false, broke = !!failed;
  for (const e of entries) {
    if (e.error) { err.push(Buffer.from(e.error + '\n')); broke = true; continue; }
    let text, m;
    if (e.stdin) { text = rgText(toBuf(yield { op: 'stdin' })); m = yield { op: 'decide', text, t, first }; if (m.refusal) return m.refusal; m = m.matches; }
    else {
      m = matches.get(e.file);
      if (!m || !m.length) continue;
      // -l reads nothing of a named file, and of a walked one only what RG-BINARY-QUIT-FIRST-READ needs.
      if (spec.mode === 'files' && !e.walked) text = Buffer.alloc(0);
      else {
        try { text = readRgText(e.file, cwd, spec.mode === 'files' ? FIRST_READ : 0); } catch (x) { err.push(Buffer.from(`rg: ${e.disp}: ${osErrorText(x)}\n`)); broke = true; continue; }
      }
    }
    if (!m.length || (e.walked && binaryAtFirstRead(text))) continue;
    if (printFile(spec, { ...e, text, matches: m, withFilename }, out, state)) found = true;
  }
  // A match pass that FAILED having printed nothing refuses (the Grep tool reads a bare rc 2 with no
  // output as "No files found"); one that printed some of its answer first is rg's error after it.
  if (failed && !out.length) return appletRejected(opts.ugrepName || 'ugrep', failed.status || 2, failed.stderr || failed.message);
  if (failed) err.push(Buffer.from(`rg: ${failed.message}\n`));
  return { stdout: Buffer.concat(out), stderr: Buffer.concat(err), status: broke ? 2 : found ? 0 : 1, signal: null };
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

// The plan for one rg call: { translate } (today's translation), { result } (answered without
// searching: a refusal or rg's usage error), or { spec, ugrep } (a search quaude's rg answers).
function rgPlan(argv, opts) {
  const p = parseRgSearch(argv);
  if (p.translate) return { translate: true };
  const debug = (v) => { if (opts.debug) opts.debug(argv, v); };
  if (p.usage) { debug('=> quaude\'s rg (rg\'s own usage error)'); return { result: { stdout: Buffer.alloc(0), stderr: Buffer.from(p.usage), status: 2, signal: null } }; }
  if (p.refuse) { debug(`!! untranslatable ${p.flag || '(argv)'}`); return { result: rgRefusal(p.refuse, { flag: p.flag }) }; }
  // ugrep is needed for any file (unless the caller decides files alone) and for every directory.
  const needs = p.spec.paths.some((P) => P !== '-');
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
    caps: () => capsOutcome(ugrep && ugrepCapabilities(ugrep, { spawnSync })),
    list: ({ argv }) => {
      if (!ugrep) return { refusal: missingUgrep(opts) };
      const r = spawnSync(ugrep, argv, { cwd: opts.cwd, env, encoding: 'buffer', maxBuffer: RG_MAX_BUFFER,
        timeout: deadline ? Math.max(1, deadline - Date.now()) : undefined });
      if (r.error && r.error.code === 'ETIMEDOUT') throw timedOutError();
      if (r.error) return { refusal: couldNotRun(ugrep, r.error) };
      if (r.status === null || r.signal) return { refusal: appletRejected(ugrep, r.signal || 'killed', r.stderr) };
      return { stdout: r.stdout, stderr: r.stderr, status: r.status };
    },
    match: ({ files, pattern, first }) => {
      const o = { ugrep, cwd: opts.cwd, env, ignoreCase: spec.ignoreCase, spawnSync, deadline, first };
      try { return { matches: (opts.matchFiles || ugrepMatches)(files, pattern, o) }; } catch (e) { return matchOutcome(e, opts, ugrep); }
    },
    stdin: () => (typeof opts.input === 'string' ? Buffer.from(opts.input, 'utf8') : toBuf(opts.input)),
    decide: ({ text, t, first }) => { try { return { matches: matchTextLines(text, t, deadline, first) }; } catch (e) { return matchOutcome(e, opts, ugrep); } },
  };
  let res;
  try { res = driveSync(searchCore(spec, { cwd: opts.cwd, onRejected: opts.onRejected, ugrepName: ugrep && leafOf(ugrep) }), handlers); } catch (e) {
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
function matchTextLinesAsync(text, t, between, first) {
  return decideLinesAsync(text, candidateLines(text, null, true), t, between, first);
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
    list: async ({ argv }) => {
      if (!ugrep) return { refusal: missingUgrep(ctx) };
      const r = await runChild(ctx.spawn, ugrep, argv, { cwd: opts.cwd, env }, (c) => { current = c; });
      current = null;
      if (stopped) return {};
      if (r.error) return { refusal: couldNotRun(ugrep, r.error) };
      if (r.status === null || r.signal) return { refusal: appletRejected(ugrep, r.signal || 'killed', r.stderr) };
      return r;
    },
    match: async ({ files, pattern, first }) => {
      try {
        if (ctx.matchFiles) return { matches: ctx.matchFiles(files, pattern, { cwd: opts.cwd, ignoreCase: spec.ignoreCase, first }) };
        return { matches: await ugrepMatchesAsync(files, pattern, { ugrep, cwd: opts.cwd, env, ignoreCase: spec.ignoreCase, spawn: ctx.spawn, first,
          spawnSync: ctx.spawnSync, onChild: (c) => { current = c; }, signal: stopSignal }) };
      } catch (e) { if (stopped) return {}; return matchOutcome(e, ctx, ugrep); } finally { current = null; }
    },
    stdin: () => new Promise((resolve) => { wake = () => resolve(Buffer.alloc(0)); stdinP.then(resolve); }),
    decide: async ({ text, t, first }) => {
      try { return { matches: await matchTextLinesAsync(text, t, between, first) }; } catch (e) { if (stopped) return {}; return matchOutcome(e, ctx, ugrep); }
    },
  };
  setTimeout(async () => {
    if (sh.isDone()) return;
    child.emit('spawn');
    if (stopped) { sh.finish({ status: null, signal: stopped, stderr: null }); return; }
    let res;
    try { res = await driveAsync(searchCore(spec, { cwd: opts.cwd, onRejected: ctx.onRejected, ugrepName: ugrep && leafOf(ugrep) }), handlers, () => !!stopped); }
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

// child_process.spawn (and Bun.spawn, which bun-shim builds on it). A search is searchChild's (its
// ugrep children asynchronous, the caller's stdin read for target `-`). What still goes to today's
// translation runs its applet as a REAL asynchronous child, with the caller's stdin wired straight to
// it; its stdout streams through as it arrives, its stderr is held until it exits, because an applet
// that exits >= 2 having printed nothing has rejected the translation and its stderr becomes quaude's
// refusal. ctx: what runRg's opts carry (ugrep, missing, matchFiles, debug, translate, spawnSync,
// onRejected), plus
//   spawn                 the UNWRAPPED asynchronous spawn
function rgSpawn(argv, opts = {}, ctx) {
  const plan = rgPlan(argv, ctx);
  if (plan.result) return refusedChild(plan.result, opts);
  if (!plan.translate) return searchChild(plan, opts, ctx);
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

module.exports = { isRgExe, rgRefusal, parseRgRefusal, untranslatableReason, runRg, rgSpawn, rgExecFile, rgSpawnSync, rgExecFileSync, RG_MAX_BUFFER,
  UGREP_MIN, parseUgrepVersion, versionAtLeast, ugrepCapabilities, ugrepCapabilitiesAsync, ugrepMatchArgv, chunkFiles, parseUgrepRanges,
  ugrepMatches, ugrepMatchesAsync, matchFilesAlone, parseRgSearch, UgrepError, rgText };
