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
// THE FORMAT (one rule a reader and this gate agree on). An ENTRY is a heading of level 2 to 4 (`##`, `###`, `####`,
// outside a ``` fence) with its OWN body: the lines up to the next heading of any level. A heading with no body text
// before its first child heading is a container and is not an entry. Every entry is presumed to state a consequence
// or a behaviour (the scope is the ENTRY, never an English sentence: parsing sentences for "consequence words" is the
// heuristic this gate deliberately does not have), so every entry carries at least one MARKER: a paragraph that begins
// at column 0 with one of
//
//   Measured: <the command, probe or test id that measured it> (YYYY-MM-DD)
//       what was run, and the date it was run. The date must be a real date, not after today. A `test/...` file it
//       names must be a git-tracked file. An entry may hold several, one per claim measured.
//   Unmeasured. <what is not measured, and what would measure it>
//       the honest answer; the text after the period may not be empty. May sit beside Measured lines (an entry
//       measured in part).
//   No open claim: <why>
//       the entry is closed (RESOLVED, RETRACTED, kept for its reasoning) or is an introduction whose claims live in
//       the entries under it. It cannot sit beside a Measured or Unmeasured line in the same entry.
//
// A marker is the FIRST line of a paragraph (after a blank line, or the body's first line); it may wrap onto following
// lines and ends at a blank line. A marker inside a bullet, a quote, a fence or the middle of a paragraph does not
// count: column 0, paragraph start only, so a wrapped line of prose is never mistaken for one.
//
// BLIND SPOTS, stated once:
// (1) The unit is the entry, not the sentence. One marker satisfies the gate for the whole entry, so a Measured line
//     that covers one claim leaves that entry's other claims looking covered. Whether a marker covers what the entry
//     says is the reader's judgement (and the writer's honesty); this gate checks only that the entry SAYS.
// (2) It cannot tell that a Measured command was really run, or still passes: it checks the date is real and not in
//     the future, and that a test file it names exists. A stale Measured line stays green until someone re-measures.
// (3) `No open claim:` is the writer's word. An entry marked so that still holds an open claim passes.
// (4) Prose under a level-1 heading (the file's own preamble) is not an entry.
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

const HEADING_RE = /^(#{2,4}) (.*)$/;
const FENCE_RE = /^\s*```/;
const MEASURED_RE = /^Measured: /;
const UNMEASURED_RE = /^Unmeasured\.(.*)$/;
const NO_CLAIM_RE = /^No open claim: /;
const DATE_RE = /\((\d{4})-(\d{2})-(\d{2})\)/g;
const TEST_PATH_RE = /\btest\/[\w./-]+\.(?:cjs|mjs|js)\b/g;

// text -> [{ line, heading, body: [{ n, text, fenced }] }] for every heading of level 2..4 outside a fence.
function entries(text) {
  const out = [];
  let cur = null;
  let fenced = false;
  text.split('\n').forEach((l, i) => {
    if (FENCE_RE.test(l)) { fenced = !fenced; if (cur) cur.body.push({ n: i + 1, text: l, fenced: true }); return; }
    const m = !fenced && HEADING_RE.exec(l);
    if (m) { cur = { line: i + 1, heading: m[2].trim(), body: [] }; out.push(cur); return; }
    if (/^# /.test(l) && !fenced) { cur = null; return; }
    if (cur) cur.body.push({ n: i + 1, text: l, fenced });
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
    if (!e.body.some((b) => b.text.trim())) continue; // a container: no text of its own
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
      for (const [, y, mo, d] of dates) {
        const iso = `${y}-${mo}-${d}`;
        if (!realDate(y, mo, d)) findings.push(`${at}: (${iso}) is not a real date`);
        else if (iso > today) findings.push(`${at}: (${iso}) is after today (${today}); a measurement cannot be dated ahead`);
      }
      for (const [p] of m.text.matchAll(TEST_PATH_RE)) {
        if (!tracked.has(p)) findings.push(`${at}: names ${p}, which is not a tracked file; a Measured line names what ran`);
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

test('Unmeasured and No open claim must say why; No open claim stands alone', () => {
  assert.match(T('## a\nUnmeasured.\n').findings[0], /bare "Unmeasured\."/);
  assert.match(T('## a\nNo open claim: \n').findings[0], /must say why/);
  assert.match(T('## a\nNo open claim: done.\n\nUnmeasured. x.\n').findings[0], /one or the other/);
  // Measured and Unmeasured together is an entry measured in part, and passes.
  assert.deepStrictEqual(T('## a\nMeasured: x (2026-11-18)\n\nUnmeasured. y needs Haiku.\n').findings, []);
});
