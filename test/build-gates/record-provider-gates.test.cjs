'use strict';
// The gate inside `scripts/record-provider.mjs`: every native Claude Code a CI job installs is recorded (path, size,
// SHA-256) right after the install, and a job that records an oracle holds it to the record at its end
// (`--verify`), so a native rewritten mid-job (CI 45354661143: a self-update, the first suspect) is a refusal by name.
//
// WHY A GUARD. The script derives a verdict from bytes and refuses, so the production-gate sweep
// (test/guards-population.cjs) counts it gate-shaped; and its value depends on CI calling it after EVERY install: an
// install with no record is an instrument nothing can hold to anything. This is that census, and its control.
//
// THE RULE, over .github/**/*.yml: every `npm i|install` of an @anthropic-ai/claude-code package with -g or --prefix
// is followed within 8 lines by `scripts/record-provider.mjs` (bare for the global provider, `--as NAME` for one
// installed on its own, NAME upper-snake), or has a `no-record: <reason>` comment within the 4 lines before it (a job
// that only carves the bytes and never runs a native). A workflow that records an oracle with --as also runs a bare
// `record-provider.mjs --verify`. The literal relative require below is load-bearing for the population sweep.
const fs = require('node:fs');
const path = require('node:path');
const { defineGuard, guardTests } = require('../guard.cjs');
const { NAME_RE } = require('../../scripts/record-provider.mjs');
const { RECORDED_INSTRUMENTS } = require('../env-indirect.cjs');

const REPO = path.resolve(__dirname, '..', '..');
const INSTALL = /npm (?:i|install)\b(?=.*@anthropic-ai\/claude-code)(?=.*(?:\s-g\b|--prefix\b))/;

function listYml(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;   // AppleDouble `._x.yml` sidecars on a non-xattr volume are not workflows
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listYml(p));
    else if (/\.ya?ml$/.test(e.name)) out.push(p);
  }
  return out;
}

// PURE: files = [{ rel, text }]. `examined` counts the installs judged.
function scan(files, known = RECORDED_INSTRUMENTS) {
  const findings = [];
  let examined = 0;
  for (const { rel, text } of files) {
    const lines = text.split('\n');
    let recordsAs = false;
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/record-provider\.mjs --as (\S+)/g)) {
        recordsAs = true;
        const name = m[1].replace(/^["']|["']$/g, '');
        if (!NAME_RE.test(name)) findings.push(`${rel}:${i + 1}: --as ${name} is not an UPPER_SNAKE name`);
        else if (!known.includes(name)) {
          findings.push(`${rel}:${i + 1}: --as ${name} is not in test/env-indirect.cjs RECORDED_INSTRUMENTS, so its `
            + 'CLODE_*_RECORDED_* variables carry no verdict');
        }
      }
      if (/^\s*#/.test(line) || !INSTALL.test(line)) return;
      examined++;
      if (lines.slice(Math.max(0, i - 4), i).some((l) => /#\s*no-record:\s*\S/.test(l))) return;
      const after = lines.slice(i + 1, i + 9).join('\n');
      const prefix = /--prefix\b/.test(line);
      const ok = prefix ? /record-provider\.mjs --as \S+/.test(after) : /record-provider\.mjs(?!\s+--)/.test(after);
      if (!ok) {
        findings.push(`${rel}:${i + 1}: installs a native Claude Code and records nothing after it `
          + `(${prefix ? 'node scripts/record-provider.mjs --as NAME "$BIN"' : 'node scripts/record-provider.mjs'}), `
          + `so nothing can tell if a test rewrote it: ${line.trim().slice(0, 120)}`);
      }
    });
    if (recordsAs && !/record-provider\.mjs --verify\s*$/m.test(text)) {
      findings.push(`${rel}: records an instrument with --as but never runs \`node scripts/record-provider.mjs --verify\``);
    }
  }
  const jobFindings = scanJobs(files);
  return { findings: [...findings, ...jobFindings.findings], examined: examined + jobFindings.examined,
    note: `${files.length} workflow/action files, ${jobFindings.examined} recording job(s)` };
}

// PER JOB (2026-11-25): a record nothing holds the job to is only half the instrument. 13 jobs recorded the provider
// and never verified it, so a rewrite after the last stage-provider read went unseen. Every job that records (a
// `record-provider.mjs` line, or a `uses: ./.github/actions/<x>` whose action.yml records) runs a bare
// `node scripts/record-provider.mjs --verify` in a step with `if: ${{ !cancelled() }}` (a red step above must not skip
// it), after its last record, and no step after it runs node, npm or claude (it judges the whole job).
const RECORD = /record-provider\.mjs(?!\s+--verify)/;
const VERIFY = /record-provider\.mjs --verify\s*$/m;
const AFTER_VERIFY = /^\s*(?:run:.*|\S.*)?\b(?:node|npm|npx|claude)\b/m;
function jobsOf(text) {
  const L = text.split('\n');
  const at = L.findIndex((l) => /^jobs:\s*$/.test(l));
  if (at < 0) return [];
  const out = [];
  let cur = null;
  for (let k = at + 1; k < L.length; k++) {
    const l = L[k];
    if (/^\S/.test(l)) break;
    const m = /^  ([A-Za-z0-9_-]+):\s*$/.exec(l);
    if (m) { cur = { id: m[1], line: k + 1, lines: [] }; out.push(cur); continue; }
    if (cur) cur.lines.push(l);
  }
  return out;
}
function stepsOf(lines) {
  const out = [];
  let cur = null;
  for (const l of lines) {
    if (/^      - /.test(l)) { cur = [l]; out.push(cur); } else if (cur && !/^\s*#/.test(l)) cur.push(l);
  }
  return out.map((s) => s.join('\n'));
}
function scanJobs(files) {
  const actionRecords = new Set(files.filter(({ rel, text }) => /\.github\/actions\/[^/]+\/action\.ya?ml$/.test(rel) && RECORD.test(text))
    .map(({ rel }) => rel.split('/').slice(-2, -1)[0]));
  const findings = [];
  let examined = 0;
  for (const { rel, text } of files) {
    for (const job of jobsOf(text)) {
      const steps = stepsOf(job.lines);
      const records = steps.map((s, i) => {
        const uses = /uses:\s*\.\/\.github\/actions\/([\w-]+)/.exec(s);
        return RECORD.test(s) || (uses && actionRecords.has(uses[1])) ? i : -1;
      }).filter((i) => i >= 0);
      if (!records.length) continue;
      examined++;
      const where = `${rel} job ${job.id} (line ${job.line})`;
      const v = steps.findIndex((s) => VERIFY.test(s));
      if (v < 0) { findings.push(`${where}: records a native and never runs a bare \`node scripts/record-provider.mjs --verify\``); continue; }
      if (v < records[records.length - 1]) findings.push(`${where}: its --verify step comes before its last record`);
      if (!/if:\s*\$\{\{\s*!cancelled\(\)\s*\}\}/.test(steps[v])) findings.push(`${where}: its --verify step lacks \`if: \${{ !cancelled() }}\`, so a red step above skips it`);
      const later = steps.slice(v + 1).filter((s) => AFTER_VERIFY.test(s.split('\n').filter((l) => /^\s*(?:run:|  +\S)/.test(l) && !/^\s*(?:name|if|uses|with|path|name):/.test(l)).join('\n')));
      if (later.length) findings.push(`${where}: ${later.length} step(s) after its --verify still run node/npm/claude, unjudged`);
    }
  }
  return { findings, examined };
}

guardTests(defineGuard({
  name: 'record-provider',
  floor: 15,
  read() {
    return listYml(path.join(REPO, '.github')).map((p) => ({ rel: path.relative(REPO, p).split(path.sep).join('/'),
      text: fs.readFileSync(p, 'utf8') }));
  },
  scan,
  control() {
    // linux-x64-pty's TEXT ORACLE step as it was before the record, and the pin's install without its record line.
    const oracle = [
      '        run: |',
      '          OV=$(node scripts/oracle-native-version.cjs)',
      '          npm i --prefix "$RUNNER_TEMP/oracle" @anthropic-ai/claude-code-linux-x64@"$OV" 2>&1 | tail -2',
      '          ORACLE="$RUNNER_TEMP/oracle/node_modules/@anthropic-ai/claude-code-linux-x64/claude"',
      '          echo "CLODE_NATIVE_ORACLE=$ORACLE" >> "$GITHUB_ENV"',
    ].join('\n');
    const pin = '        run: |\n          npm i -g @anthropic-ai/claude-code@"$V" 2>&1 | tail -3\n          echo done\n';
    const filler = Array.from({ length: 15 }, (_, i) => ({ rel: `f${i}.yml`,
      text: `          npm i -g @anthropic-ai/claude-code@"$V" 2>&1 | tail -3\n          node scripts/record-provider.mjs\n` }));
    return [{ rel: 'oracle.yml', text: oracle }, { rel: 'pin.yml', text: pin }, ...filler];
  },
}));

const test = require('node:test');
const assert = require('node:assert');
test('record-provider census: what it passes over and what it names', () => {
  const ok = (text) => scan([{ rel: 'x.yml', text }]).findings;
  assert.deepStrictEqual(ok('# no-record: carves only\nnpm i -g @anthropic-ai/claude-code@next'), []);
  assert.deepStrictEqual(ok('npm i --prefix "$D" @anthropic-ai/claude-code-linux-x64@1\nnode scripts/record-provider.mjs --as RG_ORACLE "$N"\nnode scripts/record-provider.mjs --verify'), []);
  assert.strictEqual(ok('npm i --prefix "$D" @anthropic-ai/claude-code-linux-x64@1\nnode scripts/record-provider.mjs').length, 1, 'a --prefix install needs --as');
  assert.strictEqual(ok('npm i --prefix "$D" @anthropic-ai/claude-code-linux-x64@1\nnode scripts/record-provider.mjs --as RG_ORACLE "$N"').length, 1, '--as with no --verify');
  assert.strictEqual(ok('npm i --prefix "$D" @anthropic-ai/claude-code-linux-x64@1\nnode scripts/record-provider.mjs --as NEW_ONE "$N"\nnode scripts/record-provider.mjs --verify').length, 1, 'an --as NAME with no verdicts');
  assert.strictEqual(ok('npm i -g @anthropic-ai/claude-code@1\nnode scripts/record-provider.mjs --verify').length, 1, 'a verify is not a record');
  assert.deepStrictEqual(ok('npm ci --prefix deps/claude\nnpm pack "@anthropic-ai/claude-code-linux-x64@1"'), [], 'not an install of a native');
});

test('record-provider census, per job: every recording job verifies at its end, whatever happened above', () => {
  const job = (...steps) => `jobs:\n  j:\n    runs-on: x\n    steps:\n${steps.map((s) => `      - ${s}`).join('\n')}\n`;
  const rec = 'run: node scripts/record-provider.mjs';
  const ver = 'name: v\n        if: ${{ !cancelled() }}\n        run: node scripts/record-provider.mjs --verify';
  const f = (text, extra = []) => scanJobs([{ rel: '.github/workflows/w.yml', text }, ...extra]).findings;
  assert.deepStrictEqual(f(job(rec, 'run: node test/x.cjs', ver, 'uses: actions/upload-artifact@v4\n        with:\n          path: x')), []);
  assert.match(f(job(rec, 'run: node test/x.cjs')).join(), /never runs a bare/, 'the 13 jobs as they were');
  assert.match(f(job(rec, 'name: v\n        run: node scripts/record-provider.mjs --verify')).join(), /lacks/);
  assert.match(f(job(ver, rec)).join(), /before its last record/);
  assert.match(f(job(rec, ver, 'run: node test/late.cjs')).join(), /after its --verify/);
  const action = { rel: '.github/actions/leg/action.yml', text: 'runs:\n  steps:\n    - run: node scripts/record-provider.mjs\n' };
  assert.match(f(job('uses: ./.github/actions/leg'), [action]).join(), /never runs a bare/, 'a record inside a local composite action');
  assert.deepStrictEqual(f(job('uses: ./.github/actions/other'), [action]), [], 'an action that records nothing');
});
