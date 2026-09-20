'use strict';
// Uncaught exceptions from timer callbacks must route through
// process.emit('uncaughtException') — matching host node — so a registered
// handler runs and the PROCESS SURVIVES. Claude Code installs an
// uncaughtException handler (crash telemetry + recovery); without this routing,
// a throw inside a setTimeout callback (the AsyncAgent stall watchdog is one)
// bypasses that handler and HARD-CRASHES the process. Real daily-driver bug:
// a background subagent's stall-watchdog callback threw a "not a function" that
// native Claude Code logs-and-continues, but quaude died on. Diff-reducing vs
// naude (which runs on real node and already has this).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');
const { defineGuard, guardTests } = require('./guard.cjs');

// A setTimeout callback throws; a registered uncaughtException handler must catch
// it and the process must keep running long enough to hit the later timer. The
// observable answer must match host node exactly.
const PROG = `
const out = [];
process.on('uncaughtException', (e) => { out.push('caught:' + e.message); });
setTimeout(() => { throw new TypeError('boom is not a function'); }, 0);
setTimeout(() => { out.push('survived'); console.log(JSON.stringify(out)); process.exit(0); }, 80);
`;

test('timer-callback throw routes to uncaughtException + survives, vs host node', (t) => {
  if (skipUnlessTjs(t)) return;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-uncaught-'));
  const f = path.join(base, 'prog.cjs');
  fs.writeFileSync(f, PROG);
  const nodeOut = require('node:child_process')
    .execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim();
  // Sanity: host node must itself survive-and-report (guards against a bad fixture).
  assert.strictEqual(nodeOut, '["caught:boom is not a function","survived"]');
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, `shim did not survive (exit ${r.status}); stderr:\n${r.stderr}`);
  assert.strictEqual(r.stdout.trim(), nodeOut);
});

// With NO uncaughtException handler, a timer-callback throw must still terminate
// non-zero (node's default: print + exit 1) — the fix must not silently swallow.
const PROG_NOHANDLER = `
setTimeout(() => { throw new TypeError('unhandled boom'); }, 0);
setTimeout(() => { console.log('SHOULD-NOT-REACH'); process.exit(0); }, 80);
`;

test('timer-callback throw with no handler still exits non-zero', (t) => {
  if (skipUnlessTjs(t)) return;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-uncaught-nh-'));
  const f = path.join(base, 'prog.cjs');
  fs.writeFileSync(f, PROG_NOHANDLER);
  const r = runLoader(f);
  assert.notStrictEqual(r.status, 0, 'a throw with no handler must not exit 0');
  assert.ok(!/SHOULD-NOT-REACH/.test(r.stdout), 'must not continue past an unhandled throw');
});

// ---- A STACK IS NOT A MESSAGE ----------------------------------------------
//
// MEASURED, CI run 35530707866, `tjs-slow / leg (netbsd-mips64eb)`. The leg failed having
// printed a bare stack trace and nothing else — no `Error: Command failed: cmake`, no
// compiler output. Reproduced here against the v0.20260831.1 bootstrap engine, node beside
// tjs, same fixture:
//
//     node:  Error: Command failed: sh -c ...        <-- V8 puts the message IN the stack
//              at execFileSync (node:child_process:978:15)
//     tjs:     at execFileSync (<input>:609:47)      <-- QuickJS's stack is FRAMES ONLY
//
// So `console.error(e.stack)` — an idiom that is complete under node — throws the entire
// explanation away under QuickJS. libexec/node-shim/loader.cjs has carried a comment about
// exactly this since it was written and prints `${e}\n${e.stack}`; the four other places in
// this repo that print a caught error did not, including scripts/build-tjs.cjs's top-level
// rejection handler, which is the one that ate the cross leg's failure.
//
// ONE IDIOM THAT IS CORRECT ON BOTH: prepend the message only when the stack does not
// already start with it. `${e}\n${e.stack}` unconditionally would double the message line
// under node, and build-tjs runs under both.
const BOTH_ENGINES = `
(async () => { throw Object.assign(new Error('Command failed: cmake'), { status: 2 }); })()
  .catch((e) => {
    const st = e && e.stack ? String(e.stack) : '';
    const head = String(e);
    console.error(st ? (st.startsWith(head) ? st : head + '\\n' + st) : head);
    process.exitCode = 1;
  });
`;

test('the house idiom prints the MESSAGE under tjs, exactly once, like node', (t) => {
  if (skipUnlessTjs(t)) return;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-stackmsg-'));
  const f = path.join(base, 'prog.cjs');
  fs.writeFileSync(f, BOTH_ENGINES);
  const node = require('node:child_process')
    .spawnSync(process.execPath, [f], { encoding: 'utf8' });
  const r = runLoader(f);
  const count = (s) => (String(s).match(/Command failed: cmake/g) || []).length;
  assert.strictEqual(count(node.stderr), 1, 'the node reference must say it once');
  assert.strictEqual(count(r.stderr), 1,
    `under tjs the message must appear exactly once, not zero (lost) and not twice `
    + `(doubled). Got:\n${r.stderr}`);
  assert.match(r.stderr, /at .*\n?/, 'and the frames must still be there');
});

// ---- and the same mistake, nowhere else in the repo -------------------------
//
// DERIVED FROM THE DIRECTORY, not a list: every .cjs/.mjs under scripts/ and libexec/ can
// end up running under the shim (the whole point of the node-removal work), so every one
// of them owes the message. A declared list would go stale the first time a file is added.
function scanStackWithoutMessage({ files }) {
  const findings = [];
  let examined = 0;
  for (const { path: p, src } of files) {
    examined++;
    // `e.stack ? e.stack` — the SAME identifier on both sides, which is the idiom that
    // prints frames and drops the message. The correct form (`e.stack ? `${e}\n${e.stack}``
    // or the startsWith variant) does not match, because what follows the `?` is not a
    // bare `<id>.stack`.
    const re = /\b([A-Za-z_$][\w$]*)\.stack\s*\?\s*\1\.stack\b/g;
    let m;
    while ((m = re.exec(src))) {
      findings.push(`${p}:${src.slice(0, m.index).split('\n').length}: prints `
        + `${m[1]}.stack alone. Under QuickJS that is the call frames WITHOUT the message, `
        + 'so the one line that says what went wrong is dropped — measured in CI run '
        + '35530707866, where a cross leg failed printing nothing but a stack trace');
    }
  }
  return { findings, examined };
}

function readRepoJs() {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
      if (!/\.(cjs|mjs)$/.test(e.name)) continue;
      files.push({ path: path.relative(REPO_ROOT, p), src: fs.readFileSync(p, 'utf8') });
    }
  };
  walk(path.join(REPO_ROOT, 'scripts'));
  walk(path.join(REPO_ROOT, 'libexec'));
  return { files };
}

const REPO_ROOT = path.resolve(__dirname, '..');

const stackMessageGuard = defineGuard({
  name: 'quickjs-stack-carries-no-message',
  read: readRepoJs,
  scan: scanStackWithoutMessage,
  // 123 files today. The floor is deliberately a ROUND NUMBER well below that, unlike the
  // exact floors elsewhere in this repo: the set is derived from two directory walks, so
  // what this floor has to catch is the WALK breaking (a moved directory, a filter typo)
  // and not ordinary churn in how many scripts exist.
  floor: 100,
  control: () => ({ files: [{ path: 'scripts/made-up.cjs',
    src: 'try { work(); } catch (e) { console.error(e && e.stack ? e.stack : String(e)); }\n' }] }),
});
guardTests(stackMessageGuard);
