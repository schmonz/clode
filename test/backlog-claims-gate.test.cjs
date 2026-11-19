'use strict';
// backlog-claims-gate.test.cjs — observability Task 2 (plan 2026-10-05, Job 0: "observe our current state more
// accurately than yesterday"). Every entry in BACKLOG.md says whether what it claims was MEASURED, and how and when,
// or says plainly that it was not.
//
// WHY. On 2026-10-05 the BACKLOG said sandboxed Bash under quaude refused every call ("nothing runs, every Bash
// call that session"). It ran calls 2 and 3 UNSANDBOXED: it failed OPEN. The entry even said "measured
// 2026-10-05" in its prose, about a different sentence than the one that was wrong, and nothing told a reader which
// sentence that word covered. A claim nobody re-ran reads exactly like one somebody did. This gate makes the difference
// a visible, parseable line that sits in the entry it describes.
//
// THE FORMAT (one rule a reader and this gate agree on). An ENTRY is a heading of ANY level (`#` to `######`, outside a
// ``` fence) with its OWN body: the lines up to the next heading of any level. Two exceptions: the file's first heading,
// when it is level 1, is the title (its body is the preamble); and a heading with no body text of its own whose NEXT
// heading is deeper is a container (it introduces children). A bodiless heading followed by a sibling, a shallower
// heading or the end of file is NOT a container: it is an entry with no marker, so a bare heading cannot dodge the
// gate. Every entry is presumed to state a consequence or a behaviour (the scope is the ENTRY, never an English
// sentence: parsing sentences for "consequence words" is the heuristic this gate deliberately does not have), so every
// entry carries at least one MARKER: a paragraph that begins at column 0 with one of
//
//   Measured: <the command, probe or test id that measured it> (YYYY-MM-DD)
//       what was run, then the date it was run. Text must come before the date. The date must be real, not after
//       today and not before 2026-01-01. Every repo path it names (test/, scripts/, libexec/, src/, man/, spike/,
//       .github/; extension or not) must be a git-tracked file or a directory holding one. (deps/ is populated by
//       the build, not tracked, so it is not checked.) An entry may hold several, one per claim measured.
//   Unmeasured. <what is not measured, and what would measure it>
//       the honest answer; the text after the period may not be empty. May sit beside Measured lines (an entry
//       measured in part).
//   No open claim: <why>
//       the entry is closed (RESOLVED, RETRACTED, kept for its reasoning) or is an introduction whose claims live in
//       the entries under it. It cannot sit beside a Measured or Unmeasured line in the same entry, and it cannot sit
//       under a heading that says OPEN or STILL (a cheap tripwire for a closed mark on an open entry).
//
// A marker is the FIRST line of a paragraph (after a blank line, or the body's first line); it may wrap onto following
// lines and ends at a blank line. A marker inside a bullet, a quote, a fence or the middle of a paragraph does not
// count: column 0, paragraph start only, so a wrapped line of prose is never mistaken for one.
//
// BLIND SPOTS, stated once:
// (1) The unit is the entry, not the sentence. One marker satisfies the gate for the whole entry, so a Measured line
//     that covers one claim leaves that entry's other claims looking covered. Whether a marker covers what the entry
//     says is the reader's judgement (and the writer's honesty); this gate checks only that the entry SAYS.
// (2) It cannot tell that a Measured command was really run, or still passes: it checks the date is plausible and
//     that the paths it names exist. A stale Measured line stays green until someone re-measures.
// (3) `No open claim:` is the writer's word. Beyond the OPEN/STILL heading tripwire, an entry marked so that still
//     holds an open claim (in its prose, say "Still to verify") passes.
// (4) The preamble (the title's own body) is not an entry.
//
// THE CONTROL is the real escape: the sandbox entry's heading and first paragraph exactly as they stood at 1031c3a
// (2026-10-05), which said "measured" in prose and was wrong. It carries no marker, so the gate must name it.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { defineGuard, guardTests } = require('./guard.cjs');

const REPO = path.resolve(__dirname, '..');
const FILE = 'BACKLOG.md';

const HEADING_RE = /^(#{1,6}) (.*)$/;
const FENCE_RE = /^\s*```/;
const MEASURED_RE = /^Measured: /;
const UNMEASURED_RE = /^Unmeasured\.(.*)$/;
const NO_CLAIM_RE = /^No open claim: /;
const DATE_RE = /\((\d{4})-(\d{2})-(\d{2})\)/g;
// A repo path a Measured line names: under one of the tree's top-level code directories, with or without an extension
// (man/clode.1, scripts/stage0.mjs, libexec/node-shim/modules/os.cjs:111). A trailing "." or ":" ends the sentence or
// starts a line number and is not part of the path.
const REPO_PATH_RE = /(?<![\w./-])(?:test|scripts|libexec|src|man|spike|\.github)\/[\w./-]*[\w-]/g;
// No measurement in this file predates the project; a date before this is a typo, not a measurement.
const EARLIEST = '2026-01-01';
// A heading that still calls itself open cannot hold "No open claim".
const OPEN_WORD_RE = /\b(?:OPEN|STILL)\b/;

// text -> [{ line, level, heading, body: [{ n, text, fenced }], container }] for every heading of ANY level (1..6)
// outside a fence, except a level-1 heading that is the file's first heading (the title: its body is the preamble).
// A heading with no body text of its own is a CONTAINER, and not an entry, only when the next heading is deeper (it
// introduces children). A bodiless heading followed by a sibling, a shallower heading or the end of the file is an
// entry with nothing in it, and so has no marker.
function entries(text) {
  const out = [];
  let cur = null;
  let fenced = false;
  let first = true;
  text.split('\n').forEach((l, i) => {
    if (FENCE_RE.test(l)) { fenced = !fenced; if (cur) cur.body.push({ n: i + 1, text: l, fenced: true }); return; }
    const m = !fenced && HEADING_RE.exec(l);
    if (m) {
      const title = first && m[1].length === 1;
      first = false;
      cur = title ? null : { line: i + 1, level: m[1].length, heading: m[2].trim(), body: [] };
      if (cur) out.push(cur);
      return;
    }
    if (cur) cur.body.push({ n: i + 1, text: l, fenced });
  });
  out.forEach((e, k) => {
    const next = out[k + 1];
    e.container = !e.body.some((b) => b.text.trim()) && !!next && next.level > e.level;
  });
  return out;
}

// body -> [{ kind, n, text }]: each marker paragraph, joined to one line. A marker is the FIRST line of a paragraph (the
// body's first line, or one after a blank line), at column 0, outside a fence; the paragraph runs to the next blank
// line. A line inside a paragraph never starts a marker, even if it happens to begin with "Measured: ".
function markers(body) {
  const out = [];
  let cur = null;
  let paragraphStart = true;
  for (const { n, text, fenced } of body) {
    if (!text.trim()) { cur = null; paragraphStart = true; continue; }
    const kind = (fenced || !paragraphStart) ? null
      : MEASURED_RE.test(text) ? 'measured'
        : UNMEASURED_RE.test(text) ? 'unmeasured'
          : NO_CLAIM_RE.test(text) ? 'no-claim' : null;
    paragraphStart = false;
    if (kind) { cur = { kind, n, text }; out.push(cur); continue; }
    if (cur && !fenced) cur.text += ` ${text.trim()}`;
    else cur = null;
  }
  return out;
}

// A path is tracked when it is a tracked file, or a directory holding one.
function isTracked(tracked, p) {
  if (tracked.has(p)) return true;
  const dir = p.endsWith('/') ? p : `${p}/`;
  for (const t of tracked) if (t.startsWith(dir)) return true;
  return false;
}

function realDate(y, m, d) {
  const t = new Date(Date.UTC(+y, +m - 1, +d));
  return t.getUTCFullYear() === +y && t.getUTCMonth() === +m - 1 && t.getUTCDate() === +d;
}

// PURE. { file, text, tracked: Set<path>, today: 'YYYY-MM-DD' } -> { findings, examined, note }
function scanBacklog({ file, text, tracked, today }) {
  const findings = [];
  let examined = 0;
  const tally = { measured: 0, unmeasured: 0, 'no-claim': 0 };
  for (const e of entries(text)) {
    if (e.container) continue; // no text of its own, and a deeper heading follows
    examined++;
    const where = `${file}:${e.line} "${e.heading.slice(0, 100)}"`;
    const ms = markers(e.body);
    if (!ms.length) {
      findings.push(`${where}: states a consequence with neither "Measured: <what> (YYYY-MM-DD)" nor "Unmeasured. <why>" `
        + '(nor "No open claim: <why>"), at column 0 in its own body');
      continue;
    }
    const kinds = new Set(ms.map((m) => m.kind));
    for (const k of kinds) tally[k]++;
    if (kinds.has('no-claim') && OPEN_WORD_RE.test(e.heading)) {
      findings.push(`${where}: its heading says ${OPEN_WORD_RE.exec(e.heading)[0]}, and it is marked "No open claim:"; `
        + 'retitle it or mark what is open');
    }
    if (kinds.has('no-claim') && kinds.size > 1) {
      findings.push(`${where}: says "No open claim:" and also carries a Measured/Unmeasured line; it is one or the other`);
    }
    for (const m of ms) {
      const at = `${file}:${m.n} (in "${e.heading.slice(0, 60)}")`;
      if (m.kind === 'unmeasured' && !UNMEASURED_RE.exec(m.text)[1].trim()) {
        findings.push(`${at}: a bare "Unmeasured." must say what is unmeasured and what would measure it`);
      }
      if (m.kind === 'no-claim' && !m.text.replace(NO_CLAIM_RE, '').trim()) {
        findings.push(`${at}: "No open claim:" must say why`);
      }
      if (m.kind !== 'measured') continue;
      const dates = [...m.text.matchAll(DATE_RE)];
      if (!dates.length) findings.push(`${at}: a Measured line needs the date it was run, as (YYYY-MM-DD)`);
      else if (!m.text.slice('Measured: '.length, dates[0].index).replace(/[\s.,;:]/g, '')) {
        findings.push(`${at}: a Measured line names what ran before its date; a bare date measured nothing`);
      }
      for (const [, y, mo, d] of dates) {
        const iso = `${y}-${mo}-${d}`;
        if (!realDate(y, mo, d)) findings.push(`${at}: (${iso}) is not a real date`);
        else if (iso > today) findings.push(`${at}: (${iso}) is after today (${today}); a measurement cannot be dated ahead`);
        else if (iso < EARLIEST) findings.push(`${at}: (${iso}) is before ${EARLIEST}, older than anything this file measures`);
      }
      for (const [p] of m.text.matchAll(REPO_PATH_RE)) {
        if (!isTracked(tracked, p)) {
          findings.push(`${at}: names ${p}, which is not a tracked file or directory; a Measured line names what ran`);
        }
      }
    }
  }
  return {
    findings, examined,
    note: `${examined} entries of ${file}: ${tally.measured} with a Measured line, ${tally.unmeasured} with an Unmeasured `
      + `line, ${tally['no-claim']} with no open claim`,
  };
}

function readBacklog() {
  const text = fs.readFileSync(path.join(REPO, FILE), 'utf8');
  const tracked = new Set(execFileSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8' }).split('\0').filter(Boolean));
  // The LOCAL date: a measurement is dated where it was taken, and UTC would call a morning one "after today" east
  // of Greenwich.
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { file: FILE, text, tracked, today };
}

// The sandbox entry as it stood at 1031c3a (2026-10-05): heading and first paragraph, verbatim. Its "measured" is in
// prose, about the failure to initialize; the consequence it states ("nothing runs, every Bash call that session")
// was never measured and was wrong (calls 2 and 3 ran unsandboxed). The gate must name it.
const PRE_FIX_SANDBOX_ENTRY = [
  '### 1. `net.createServer` is ABSENT ' + String.fromCodePoint(0x2014) + ' UDS peer messaging is silently off under quaude',
  '',
  '**AND SANDBOXED BASH NEVER RUNS UNDER QUAUDE (measured 2026-10-05, grep-native Task 11, macOS arm64 and Linux',
  'x64).** With `{"sandbox":{"enabled":true}}` in the settings, a Bash call that writes inside and outside the',
  'working directory: native runs it sandboxed (inside written, outside refused: `Operation not permitted` on macOS,',
  '`Read-only file system` under bwrap on Linux); quaude answers `Sandbox is enabled but failed to initialize: not a',
  'function. Sandboxing is disabled for the rest of this session; restart to retry.` (is_error, nothing runs, every',
  'Bash call that session). The debug log says only `Failed to initialize sandbox: not a function`; the sandbox\'s',
  'network proxies are servers the bundle makes with `createServer` (`__.createServer(); y.listen(0,"127.0.0.1")`,',
  'the SOCKS server\'s `t3.createServer(...)`), so this gap is the likely cause, unconfirmed. On Linux it used to fail',
  'earlier: the sandbox\'s dependency check looked for rg on PATH and said dependencies are missing; since grep-native',
  'Task 10b Bun.which(RG_PATH) answers, the check passes and initialization is what fails. Neither ever sandboxed.',
  '',
].join('\n');

const guard = defineGuard({
  name: 'backlog-claims-measured',
  // Measured 2026-11-18: 236 entries (level 2..4 headings with a body of their own). The floor sits well under that,
  // so ordinary deletion of done entries (the file's own rule: done items are deleted) does not trip it, while a parse
  // that went blind (a heading syntax change, the file moved or emptied) reads BROKEN rather than clean.
  floor: 120,
  read: readBacklog,
  scan: scanBacklog,
  control: () => ({ file: 'BACKLOG.md@1031c3a', text: PRE_FIX_SANDBOX_ENTRY, tracked: new Set(), today: '2026-10-05' }),
});
guardTests(guard);

test('the control names the pre-fix sandbox entry, and nothing else', () => {
  const r = scanBacklog(guard.control());
  assert.strictEqual(r.examined, 1);
  assert.strictEqual(r.findings.length, 1);
  assert.match(r.findings[0], /^BACKLOG\.md@1031c3a:1 "1\. `net\.createServer` is ABSENT/);
  assert.match(r.findings[0], /neither "Measured: /);
});

const T = (text) => scanBacklog({ file: 'B', text, tracked: new Set(['test/x.test.cjs']), today: '2026-11-18' });

test('each marker form passes an entry; a marker in a bullet, a quote or a fence does not', () => {
  assert.deepStrictEqual(T('## a\nclaim\n\nMeasured: test/x.test.cjs (2026-11-18)\n').findings, []);
  assert.deepStrictEqual(T('## a\nclaim\n\nUnmeasured. Needs a Windows box.\n').findings, []);
  assert.deepStrictEqual(T('## a\nclaim\n\nNo open claim: resolved by abc123.\n').findings, []);
  assert.strictEqual(T('## a\nclaim\n- Measured: test/x.test.cjs (2026-11-18)\n').findings.length, 1);
  assert.strictEqual(T('## a\nclaim\n> Unmeasured. no.\n').findings.length, 1);
  assert.strictEqual(T('## a\nclaim\n```\nUnmeasured. no.\n```\n').findings.length, 1);
  // Mid-paragraph is prose, not a marker: only a paragraph's first line can be one.
  assert.strictEqual(T('## a\nclaim, and the next line wraps\nUnmeasured. no.\n').findings.length, 1);
});

test('a container heading is not an entry; a fenced "#" line is not a heading; the level-1 preamble is not an entry', () => {
  const r = T('# title\npreamble\n## parent\n### child\nclaim\n```\n## not a heading\n```\n\nUnmeasured. x.\n');
  assert.strictEqual(r.examined, 1);
  assert.deepStrictEqual(r.findings, []);
});

test('a Measured line needs a real, past date and names only tracked tests', () => {
  assert.match(T('## a\nMeasured: by hand\n').findings[0], /needs the date/);
  assert.match(T('## a\nMeasured: x (2026-02-30)\n').findings[0], /not a real date/);
  assert.match(T('## a\nMeasured: x (2026-11-19)\n').findings[0], /after today/);
  assert.match(T('## a\nMeasured: test/gone.test.cjs (2026-11-18)\n').findings[0], /not a tracked file/);
  // A wrapped marker paragraph carries its date on a later line.
  assert.deepStrictEqual(T('## a\nMeasured: a long command\nthat wraps (2026-11-18)\n').findings, []);
});

// The second control: the dodge a review found in the first version of this gate, which treated EVERY bodiless
// heading as a container. A bare heading stating a claim, with no body, read as examined 0.
const BARE_HEADING_DODGE = '## quaude sandbox fails closed\n';

test('a bare heading is an entry, not a container: the dodge is named (control)', () => {
  const r = T(BARE_HEADING_DODGE);
  assert.strictEqual(r.examined, 1);
  assert.strictEqual(r.findings.length, 1);
  assert.match(r.findings[0], /^B:1 "quaude sandbox fails closed": states a consequence/);
  // A bodiless heading followed by a SIBLING or a SHALLOWER heading is an entry too; only a deeper next heading
  // makes it a container.
  assert.strictEqual(T('## a\n## b\nUnmeasured. x.\n').findings.length, 1);
  assert.strictEqual(T('### a\n## b\nUnmeasured. x.\n').findings.length, 1);
  assert.deepStrictEqual(T('## a\n### b\nUnmeasured. x.\n').findings, []);
});

test('##### headings and text after a mid-file "#" heading are entries of their own', () => {
  // A level-5 heading is its own entry, not folded into its parent's marker.
  const five = T('## a\nUnmeasured. x.\n##### deep claim\nprose\n');
  assert.strictEqual(five.examined, 2);
  assert.match(five.findings[0], /"deep claim"/);
  // A level-1 heading after the title is an entry; the text under it is checked.
  const mid = T('# title\npreamble\n## a\nUnmeasured. x.\n# Part two\nclaim with no marker\n');
  assert.strictEqual(mid.examined, 2);
  assert.match(mid.findings[0], /"Part two"/);
});

test('a heading that says OPEN or STILL cannot be marked No open claim', () => {
  assert.match(T('## OPEN thing\nNo open claim: done.\n').findings[0], /says OPEN/);
  assert.match(T('## STILL broken\nNo open claim: done.\n').findings[0], /says STILL/);
  assert.deepStrictEqual(T('## OPEN thing\nUnmeasured. x.\n').findings, []);
  assert.deepStrictEqual(T('## reopened, still\nNo open claim: lower-case words are prose.\n').findings, []);
});

test('a Measured line names what ran before its date, a sane date, and only paths that exist', () => {
  assert.match(T('## a\nMeasured: (2026-11-18)\n').findings[0], /names what ran before its date/);
  assert.match(T('## a\nMeasured: x (2019-01-01)\n').findings[0], /before 2026-01-01/);
  assert.match(T('## a\nMeasured: scripts/gone.mjs (2026-11-18)\n').findings[0], /scripts\/gone\.mjs, which is not/);
  assert.match(T('## a\nMeasured: man/gone.1 (2026-11-18)\n').findings[0], /man\/gone\.1, which is not/);
  // A line number and a sentence's full stop are not part of the path; a directory holding a tracked file counts.
  assert.deepStrictEqual(T('## a\nMeasured: test/x.test.cjs:12 and test/. (2026-11-18)\n').findings, []);
  assert.deepStrictEqual(T('## a\nMeasured: grep over test/ and test/x.test.cjs. (2026-11-18)\n').findings, []);
});

test('Unmeasured and No open claim must say why; No open claim stands alone', () => {
  assert.match(T('## a\nUnmeasured.\n').findings[0], /bare "Unmeasured\."/);
  assert.match(T('## a\nNo open claim: \n').findings[0], /must say why/);
  assert.match(T('## a\nNo open claim: done.\n\nUnmeasured. x.\n').findings[0], /one or the other/);
  // Measured and Unmeasured together is an entry measured in part, and passes.
  assert.deepStrictEqual(T('## a\nMeasured: x (2026-11-18)\n\nUnmeasured. y needs Haiku.\n').findings, []);
});

// ---- UNMEASURED in code comments -------------------------------------------------------------------------------------
// A code comment that says UNMEASURED is a claim the backlog must carry, or it rots where no gate reads it (final review,
// observability plan). Each such comment cites the entry: BACKLOG "<the start of its heading>", and that heading must
// exist in BACKLOG.md, so the entry's own Measured/Unmeasured marker (the guard above) holds it.
const CITE_RE = /BACKLOG "([^"]+)"/;
function scanCodeUnmeasured({ files, headings }) {
  const findings = [];
  let examined = 0;
  for (const [file, text] of files) {
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      if (!/^\s*(?:\/\/|#|\*)/.test(line) || !/\bUNMEASURED\b/.test(line)) return;
      examined++;
      // the citation may wrap onto the comment's next line
      const m = CITE_RE.exec(line) || CITE_RE.exec(`${line} ${lines[i + 1] || ''}`.replace(/\s*(?:\/\/|#|\*)\s*/g, ' '));
      if (!m) { findings.push(`${file}:${i + 1}: an UNMEASURED comment cites no BACKLOG entry (BACKLOG "<heading>")`); return; }
      if (!headings.some((h) => h.startsWith(m[1]))) findings.push(`${file}:${i + 1}: cites BACKLOG "${m[1]}", which no BACKLOG.md heading starts with`);
    });
  }
  return { findings, examined, note: `${examined} UNMEASURED code comment(s) in ${files.length} file(s)` };
}
guardTests(defineGuard({
  name: 'code-unmeasured-cites-backlog',
  // Measured 2026-11-19: three (libexec/node-shim/internal/priority.cjs, test/file-watchdog-sleeper.cjs,
  // test/node-shim-os-priority-win32.test.cjs).
  floor: 3,
  read: () => {
    const list = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', 'libexec', 'scripts', 'test', '.github'],
      { cwd: REPO, encoding: 'utf8' }).split('\0').filter((f) => /\.(?:c|m)?js$|\.ya?ml$|\.sh$/.test(f) && f !== 'test/backlog-claims-gate.test.cjs'
        && fs.existsSync(path.join(REPO, f)));
    const headings = fs.readFileSync(path.join(REPO, FILE), 'utf8').split('\n').map((l) => (HEADING_RE.exec(l) || [])[2]).filter(Boolean);
    return { files: list.map((f) => [f, fs.readFileSync(path.join(REPO, f), 'utf8')]), headings };
  },
  scan: scanCodeUnmeasured,
  control: () => ({ files: [['x.cjs', '// UNMEASURED on a real Windows box.\n// UNMEASURED (BACKLOG "gone entry")\n']], headings: ['present'] }),
}));
test('code-unmeasured-cites-backlog: a citation wrapped onto the next comment line counts', () => {
  const r = scanCodeUnmeasured({ files: [['x.cjs', '// a claim, UNMEASURED on a real\n// Windows box: BACKLOG "present heading".\n']], headings: ['present heading, in full'] });
  assert.deepStrictEqual(r.findings, []);
  assert.strictEqual(scanCodeUnmeasured(guardControl()).findings.length, 2);
});
function guardControl() { return { files: [['x.cjs', '// UNMEASURED on a real Windows box.\n// UNMEASURED (BACKLOG "gone entry")\n']], headings: ['present'] }; }
