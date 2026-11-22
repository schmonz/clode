'use strict';
// ci-step-chaining: once a ci.yml job has run its first GATE step, every later step says, in its own
// `if:`, that it runs whatever an earlier gate concluded: `!cancelled()` (the repo's convention, with
// `&& steps.<id>.outcome == 'success'` for a step that truly needs an earlier SETUP step), or
// `always()`/`failure()`. A step with no `if:` is GitHub's implicit `success()`: it is chained to every
// gate above it, so one red gate SKIPS every independent gate after it and a red job hides how much
// else is broken. And no step in a gated job may set `continue-on-error`, so the job still ends red
// when any gate failed — `!cancelled()` buys visibility, never green.
//
// Seen: linux-x64-pty's `fidelity/update-notify.pty` and the quaude build it needs were plain steps
// after the TUI/Ctrl-Z step, so a 2.1.330 Ctrl-Z failure would have left the notify surface unjudged;
// the windows jobs' node-shim oracles sat behind the sync-primitive battery, windows-amd64-tui's
// TTY characterization behind its render, native-builder-oracle's full-binary oracle behind the
// product build, node-shim-oracle-darwin's second-platform graph oracle behind the local-tools turns.
// And native-builder-oracle's "SHIPPED ARTIFACT BROKEN" banner had `if: steps.build.outcome ==
// 'failure' || ...` with no status function, which GitHub ANDs with success(): it could never run
// when the build or oracle failed, the only time it was for.
//
// FLOOR: 9 (the gated jobs ci.yml has today: tjs-fast-smoke, three windows, node-shim-oracle, native-builder-oracle,
// linux-x64-pty, node-shim-oracle-darwin, gates-ran-in-ci).
// CONTROL: a two-gate job whose second gate has no `if:`, and one that sets continue-on-error.
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert');
const { defineGuard, guardTests } = require('./guard.cjs');

const CI = path.resolve(__dirname, '..', '.github', 'workflows', 'ci.yml');

// A step is a GATE when it runs a judgement: a node test, the suite, a repo check script, the
// full-smoke action. Setup (checkout, installs, downloads, chmod) is not.
const GATE = /(?:^|\s)--test(?=\s|$)|\b(?:node|tjs(?:\.exe)?\s+run)\s+(?:\S+\/)?test\/[\w./-]+|\btest\/run\.mjs\b|\bscripts\/cell-profile-diff\.cjs\b|\.\/\.github\/actions\/full-smoke\b/m;
const RUNS_ANYWAY = /!\s*cancelled\(\)|\balways\(\)|\bfailure\(\)/;

const stripComments = (yaml) => yaml.replace(/(^|[ \t])#.*$/gm, '$1');

// { job: [{ name, text, if }] } — each job's steps, by the workflow's own indentation (jobs at 2,
// steps at 6), comments stripped so a step that only MENTIONS a test in a comment is not a gate.
function jobSteps(yaml) {
  const y = stripComments(yaml);
  const out = {};
  const heads = [...y.matchAll(/^ {2}([\w-]+):[ \t]*$/gm)];
  heads.forEach((h, k) => {
    const block = y.slice(h.index, k + 1 < heads.length ? heads[k + 1].index : y.length);
    const at = block.search(/^ {4}steps:[ \t]*$/m);
    if (at < 0) return;
    out[h[1]] = block.slice(at).split(/^ {6}- /m).slice(1).map((text) => ({
      name: ((/^name:\s*(.+)$/m.exec(text) || /^\s*uses:\s*(\S+)/m.exec(text) || [])[1] || '?').trim(),
      if: ((/^ {8}if:\s*(.+)$/m.exec(text) || [])[1] || '').trim(),
      text,
    }));
  });
  return out;
}

// Findings for one workflow's text, and how many gated jobs it examined.
function chainingFindings(yaml) {
  const findings = [];
  let examined = 0;
  for (const [job, steps] of Object.entries(jobSteps(yaml))) {
    const first = steps.findIndex((s) => GATE.test(s.text));
    if (first < 0) continue;
    examined++;
    for (const s of steps.slice(first + 1)) {
      if (!RUNS_ANYWAY.test(s.if)) {
        findings.push(`${job}: "${s.name}" runs after the gate "${steps[first].name}" with ${s.if ? `if: ${s.if}` : 'no if:'} — `
          + 'implicitly success(), so an earlier red gate skips it; give it `if: ${{ !cancelled() }}` '
          + '(plus `&& steps.<id>.outcome == \'success\'` for a setup step it needs)');
      }
    }
    for (const s of steps) {
      if (/^\s*continue-on-error:\s*(?!false\b)\S/m.test(s.text)) findings.push(`${job}: "${s.name}" sets continue-on-error, so its failure would not make the job red`);
    }
  }
  return { examined, findings };
}

guardTests(defineGuard({
  name: 'ci-step-chaining',
  floor: 9,
  read() { return { yaml: fs.readFileSync(CI, 'utf8') }; },
  scan({ yaml }) { return chainingFindings(yaml); },
  control() {
    const job = (name, extra) => `  ${name}:\n    runs-on: ubuntu-latest\n    steps:\n`
      + '      - uses: actions/checkout@v7.0.1\n'
      + '      - name: first gate\n        run: node --test test/a.test.cjs\n'
      + `      - name: second gate\n${extra}        run: node --test test/b.test.cjs\n`;
    return { yaml: 'jobs:\n' + ['j1', 'j2', 'j3', 'j4', 'j5'].map((n) => job(n, '        if: ${{ !cancelled() }}\n')).join('')
      + job('chained', '') + job('masked', '        if: ${{ !cancelled() }}\n        continue-on-error: true\n') };
  },
}));

test('the classifier: setup is not a gate, a comment is not a gate, and the convention passes', () => {
  const y = 'jobs:\n  a:\n    steps:\n'
    + '      - uses: actions/checkout@v7.0.1\n'
    + '      - name: install\n        run: npm ci --prefix deps/claude   # node --test would be a gate\n'
    + '      - name: gate\n        run: node test/run.mjs\n'
    + '      - name: setup after\n        id: s\n        if: ${{ !cancelled() }}\n        run: npm install --prefix test\n'
    + '      - name: needs setup\n        if: ${{ !cancelled() && steps.s.outcome == \'success\' }}\n        run: node --test test/x.test.cjs\n'
    + '      - name: report\n        if: failure()\n        run: echo red\n';
  assert.deepStrictEqual(chainingFindings(y), { examined: 1, findings: [] });
  const steps = jobSteps(y).a;
  assert.deepStrictEqual(steps.map((s) => s.name), ['actions/checkout@v7.0.1', 'install', 'gate', 'setup after', 'needs setup', 'report']);
  assert.strictEqual(GATE.test(steps[1].text), false, 'a test named only in a comment does not make a gate');
  const r = chainingFindings(y.replace("        if: ${{ !cancelled() && steps.s.outcome == 'success' }}\n", "        if: steps.s.outcome == 'success'\n"));
  assert.strictEqual(r.findings.length, 1);
  assert.match(r.findings[0], /"needs setup" runs after the gate "gate" with if: steps\.s\.outcome == 'success'/);
});
