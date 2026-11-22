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
// CONTROL: a two-gate job whose second gate has no `if:`, one that sets continue-on-error at step level and
// one at job level, and MISATTRIBUTED (below): the shape native-builder-oracle had after its first fix.
//
// THE VERDICT RULE (review of 7f1571e). Once a gate runs under !cancelled(), it can run on missing inputs: in
// native-builder-oracle the full-binary oracle ran `if: ${{ !cancelled() }}` while the setup it consumes (engine
// download, npm ci, the provider install, chmod) had no ids. A failed download skipped the build, the oracle ran on
// nothing and failed, and the banner blaming build/oracle cried SHIPPED ARTIFACT BROKEN while the honest "could not
// verify" stayed silent. So: a failure() step that blames steps by outcome must require every setup step's success,
// every setup step carries an id for it to name, and each blamed step that runs anyway requires the same.
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert');
const { defineGuard, guardTests } = require('./guard.cjs');

const CI = path.resolve(__dirname, '..', '.github', 'workflows', 'ci.yml');

// A step is a GATE when it runs a judgement: a node test, the suite, a repo check script, the
// full-smoke action. Setup (checkout, installs, downloads, chmod) is not.
const GATE = /(?:^|\s)--test(?=\s|$)|\b(?:node|tjs(?:\.exe)?\s+run)\s+(?:\S+\/)?test\/[\w./-]+|\btest\/run\.mjs\b|\bscripts\/cell-profile-diff\.cjs\b|\.\/\.github\/actions\/full-smoke\b/m;
// SETUP: what a gate consumes and did not make itself — a download, an install, a chmod (any `run:` before the
// first gate). checkout/setup-node/cache are left out: when one fails, every implicit step after it is skipped,
// so the run: steps' outcomes already say so.
const SETUP = /^\s*run:|uses:\s*actions\/download-artifact@/m;
const requiresSuccess = (expr, id) => new RegExp(`\\bsteps\\.${id}\\.outcome\\s*==\\s*['"]success['"]`).test(expr);
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
      id: ((/^ {8}id:\s*([\w-]+)/m.exec(text) || /^id:\s*([\w-]+)/m.exec(text) || [])[1] || null),
      text,
    }));
    out[h[1]].head = block.slice(0, at);   // the job's own keys (if, runs-on, continue-on-error ...)
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
    if (/^ {4}continue-on-error:\s*(?!false\b)\S/m.test(steps.head || '')) findings.push(`${job}: the JOB sets continue-on-error, so a failed gate would not make the run red`);
    // A step's if: may only name ids its job has (a typo reads as '', never success).
    const ids = new Set(steps.map((s) => s.id).filter(Boolean));
    for (const s of steps) {
      for (const [, id] of s.if.matchAll(/\bsteps\.([\w-]+)\./g)) if (!ids.has(id)) findings.push(`${job}: "${s.name}" names steps.${id}, which no step of this job has as its id`);
    }
    // VERDICT STEPS. A step that runs on failure() and BLAMES particular steps (steps.X.outcome == 'failure')
    // claims the red is theirs. That claim holds only when the SETUP they consume succeeded: an oracle that runs
    // under !cancelled() on a missing engine or provider fails too, and blaming it calls a broken download a broken
    // product. So a verdict step requires every setup step's success (each therefore carries an id), and each
    // blamed step that runs anyway (!cancelled()/always()) requires the same, so it never runs on missing inputs.
    const setup = steps.slice(0, first).filter((s) => SETUP.test(s.text));
    for (const v of steps.slice(first + 1)) {
      if (!/\bfailure\(\)/.test(v.if)) continue;
      if (/!\s*\(/.test(v.if)) continue;   // the COMPLEMENT of a verdict ("could not verify") blames no one
      const blamed = [...v.if.matchAll(/\bsteps\.([\w-]+)\.outcome\s*==\s*['"]failure['"]/g)].map((m) => m[1]);
      if (!blamed.length) continue;
      for (const st of setup) {
        if (!st.id) { findings.push(`${job}: setup step "${st.name}" has no id, so the verdict "${v.name}" cannot require its success`); continue; }
        if (!requiresSuccess(v.if, st.id)) findings.push(`${job}: the verdict "${v.name}" blames ${blamed.join('/')} without requiring setup "${st.name}" (steps.${st.id}) to have succeeded`);
        for (const b of steps.filter((x) => blamed.includes(x.id) && /!\s*cancelled\(\)|\balways\(\)/.test(x.if))) {
          if (!requiresSuccess(b.if, st.id)) findings.push(`${job}: "${b.name}" runs anyway and is blamed by "${v.name}", but does not require setup "${st.name}" (steps.${st.id}) to have succeeded`);
        }
      }
    }
  }
  return { examined, findings };
}

// native-builder-oracle as review found it: setup with no ids, the oracle under a bare !cancelled(), the banner
// blaming build/oracle on failure() alone.
const MISATTRIBUTED = '  misattributed:\n    runs-on: ubuntu-latest\n    steps:\n'
  + '      - uses: actions/checkout@v7.0.1\n'
  + '      - uses: actions/download-artifact@v8.0.2\n        with:\n          name: tjs-linux-x64-musl\n'
  + '      - name: Install the runtime dep closure\n        run: npm ci --prefix deps/claude\n'
  + '      - name: Install the Claude provider\n        run: npm i -g @anthropic-ai/claude-code@"$V"\n'
  + '      - name: mark the engine executable\n        run: chmod +x tjs\n'
  + '      - name: the native builder BUILDS THE PRODUCT\n        id: build\n        run: node --test test/clode-native.test.cjs\n'
  + '      - name: full-binary oracle\n        id: oracle\n        if: ${{ !cancelled() }}\n        run: node --test test/oracle-binaries.test.cjs\n'
  + "      - name: SHIPPED ARTIFACT BROKEN\n        if: ${{ failure() && (steps.build.outcome == 'failure' || steps.oracle.outcome == 'failure') }}\n        run: echo broken\n"
  + "      - name: could not verify\n        if: ${{ failure() && !(steps.build.outcome == 'failure' || steps.oracle.outcome == 'failure') }}\n        run: echo unverified\n";

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
      + job('chained', '') + job('masked', '        if: ${{ !cancelled() }}\n        continue-on-error: true\n')
      + job('lax', '        if: ${{ !cancelled() }}\n').replace('    runs-on:', '    continue-on-error: true\n    runs-on:')
      + MISATTRIBUTED };
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

test('the verdict rule: the misattributing shape native-builder-oracle had fails, by name; with setup ids required it passes', () => {
  const bad = chainingFindings('jobs:\n' + MISATTRIBUTED);
  assert.strictEqual(bad.examined, 1);
  for (const re of [/setup step "actions\/download-artifact@v8\.0\.2" has no id/, /setup step "Install the runtime dep closure" has no id/,
    /setup step "Install the Claude provider" has no id/, /setup step "mark the engine executable" has no id/]) {
    assert.ok(bad.findings.some((f) => re.test(f)), `expected ${re} in:\n${bad.findings.join('\n')}`);
  }
  const SETUP_OK = "steps.engine.outcome == 'success' && steps.deps.outcome == 'success' && steps.provider.outcome == 'success' && steps.chmod.outcome == 'success'";
  const ided = MISATTRIBUTED
    .replace('      - uses: actions/download-artifact@v8.0.2\n', '      - uses: actions/download-artifact@v8.0.2\n        id: engine\n')
    .replace('        run: npm ci', '        id: deps\n        run: npm ci')
    .replace('        run: npm i -g', '        id: provider\n        run: npm i -g')
    .replace('        run: chmod', '        id: chmod\n        run: chmod');
  const half = chainingFindings('jobs:\n' + ided).findings;
  assert.ok(half.some((f) => /the verdict "SHIPPED ARTIFACT BROKEN" blames build\/oracle without requiring setup "Install the Claude provider"/.test(f)), half.join('\n'));
  assert.ok(half.some((f) => /"full-binary oracle" runs anyway and is blamed by "SHIPPED ARTIFACT BROKEN", but does not require setup/.test(f)), half.join('\n'));
  const good = ided
    .replace('        if: ${{ !cancelled() }}\n        run: node --test test/oracle', '        if: ${{ !cancelled() && ' + SETUP_OK + ' }}\n        run: node --test test/oracle')
    .replace('if: ${{ failure() && (steps.build', 'if: ${{ failure() && ' + SETUP_OK + ' && (steps.build');
  assert.deepStrictEqual(chainingFindings('jobs:\n' + good).findings, []);
  assert.match(chainingFindings('jobs:\n' + good.replace('steps.chmod.outcome', 'steps.chmd.outcome')).findings.join('\n'), /names steps\.chmd, which no step of this job has/);
});
