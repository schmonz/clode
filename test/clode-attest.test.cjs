'use strict';
// ONE attest vocabulary for BOTH build targets.
//
// Before this, `--quaude-attest` existed on quaude only, and naude had no attest of any
// kind — so "did this artifact keep its integrity?" was a question you could only ask one
// of the two products, in a spelling that named the product rather than the builder. This
// suite pins the shared half: the reserved-argv carve (which flag spellings a target
// answers itself instead of handing to Claude Code) and the REPORT FORMATTER whose last
// line is the one string every build gate greps.
//
// Why the formatter is a pure function with its own tests: the verdict line is load-
// bearing (libexec/clode-fuse.cjs fails a build unless it matches), and this repo has
// twice shipped a gate that could not fail. A shared constant, asserted here and imported
// there, is the only version of that gate that cannot silently drift apart from the
// product that prints it.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const attest = require('../libexec/clode-attest.cjs');

// ---------------------------------------------------------------- the carve --

test('carve: --clode-attest is taken by the target, the rest passes through in order', () => {
  const r = attest.carveClodeArgs(['-p', 'say PONG', '--clode-attest', '--allowedTools', 'Bash']);
  assert.deepStrictEqual(r.clode, ['--clode-attest']);
  assert.deepStrictEqual(r.rest, ['-p', 'say PONG', '--allowedTools', 'Bash']);
  assert.deepStrictEqual(r.unknown, []);
});

test('carve: any position works, including first', () => {
  const r = attest.carveClodeArgs(['--clode-attest', '-p', 'x']);
  assert.deepStrictEqual(r.clode, ['--clode-attest']);
  assert.deepStrictEqual(r.rest, ['-p', 'x']);
});

test('carve: an unknown flag in the reserved namespace is reported, never passed to the bundle', () => {
  const r = attest.carveClodeArgs(['--clode-frobnicate', '-p', 'x', '--clode-attest']);
  assert.deepStrictEqual(r.unknown, ['--clode-frobnicate']);
  assert.deepStrictEqual(r.clode, ['--clode-attest']);
  assert.deepStrictEqual(r.rest, ['-p', 'x'],
    'an unknown reserved flag must NOT leak into the args Claude Code sees');
});

test('carve: only the exact --clode- prefix is reserved (values and near-misses are not)', () => {
  const r = attest.carveClodeArgs(['--clode', 'explain --clode-attest to me', '-clode-attest']);
  assert.deepStrictEqual(r.clode, []);
  assert.deepStrictEqual(r.unknown, []);
  assert.deepStrictEqual(r.rest, ['--clode', 'explain --clode-attest to me', '-clode-attest']);
});

// `--quaude-` is NOT a namespace any more. It was never documented and nobody knew it
// existed, so it leaves no transitional surface behind: the old spelling is just an
// argument, and Claude Code rejects it the way it rejects any other unknown flag.
test('carve: --quaude-* is no longer reserved and no longer special', () => {
  const r = attest.carveClodeArgs(['--quaude-attest', '--quaude-frobnicate', '-p', 'x']);
  assert.deepStrictEqual(r.clode, []);
  assert.deepStrictEqual(r.unknown, []);
  assert.deepStrictEqual(r.rest, ['--quaude-attest', '--quaude-frobnicate', '-p', 'x']);
});

test('carve: empty argv yields three empty buckets', () => {
  assert.deepStrictEqual(attest.carveClodeArgs([]), { clode: [], rest: [], unknown: [] });
});

test('CLODE_FLAGS is the single source of truth for the known set', () => {
  assert.deepStrictEqual(attest.CLODE_FLAGS, ['--clode-attest']);
  assert.ok(!('CLODE_FLAG_ALIASES' in attest),
    'no alias table: one name, no transitional surface');
  for (const f of attest.CLODE_FLAGS) {
    const r = attest.carveClodeArgs([f]);
    assert.deepStrictEqual(r.clode, [f], `${f} must carve as known`);
    assert.deepStrictEqual(r.unknown, []);
  }
});

// The BOM specs are "name@version", and a scoped package's own leading '@' is not the
// version separator.
test('depNameFromSpec splits on the LAST @, so scoped packages survive', () => {
  assert.strictEqual(attest.depNameFromSpec('undici@6.21.0'), 'undici');
  assert.strictEqual(attest.depNameFromSpec('@anthropic-ai/sdk@0.60.0'), '@anthropic-ai/sdk');
  assert.strictEqual(attest.depNameFromSpec('nakedname'), 'nakedname');
});

// ------------------------------------------------------------- the formatter --

const OK_MEMBERS = [{ name: 'cli.cjs', len: 10, ok: true }, { name: 'manifest.json', len: 4, ok: true }];

test('report: the verdict line is ONE string, shared by both products', () => {
  assert.strictEqual(attest.ATTEST_VERIFIED, 'clode-attest: all members verified');
  assert.strictEqual(attest.ATTEST_FAILED, 'clode-attest: VERIFICATION FAILED');
  assert.ok(!attest.ATTEST_VERIFIED.includes('quaude') && !attest.ATTEST_VERIFIED.includes('naude'),
    'the verdict a build gate greps must not name one of the two products');
});

test('report: manifest verbatim, one line per member, verdict last', () => {
  const r = attest.attestReport({ manifestText: '{\n  "role": "quaude"\n}\n', members: OK_MEMBERS });
  assert.strictEqual(r.ok, true);
  // 'ok' is padded to FAIL's width so the name column lines up in both outcomes.
  assert.deepStrictEqual(r.lines, [
    '{',
    '  "role": "quaude"',
    '}',
    'ok  cli.cjs (10 bytes)',
    'ok  manifest.json (4 bytes)',
    'clode-attest: all members verified',
  ]);
  assert.strictEqual(r.text, r.lines.join('\n') + '\n');
});

test('report: ONE failing member flips the verdict (and only that line says FAIL)', () => {
  const r = attest.attestReport({
    manifestText: '{}',
    members: [{ name: 'a', len: 1, ok: true }, { name: 'b', len: 2, ok: false }],
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.lines[r.lines.length - 1], attest.ATTEST_FAILED);
  assert.deepStrictEqual(r.lines.filter((l) => /^FAIL /.test(l)), ['FAIL b (2 bytes)']);
});

test('report: a missing BOM package fails the whole report, not just its own line', () => {
  const r = attest.attestReport({
    manifestText: '{}',
    members: OK_MEMBERS,
    bom: [{ spec: 'undici@6.21.0', marker: 'node_modules/undici/package.json', present: false }],
  });
  assert.strictEqual(r.ok, false);
  assert.ok(r.lines.includes('FAIL bom: undici@6.21.0 -> node_modules/undici/package.json'));
});

// Notes are how a product says what it did NOT check. They must never be able to make a
// failing report look clean.
test('report: notes are printed before the verdict and cannot change it', () => {
  const r = attest.attestReport({ manifestText: '{}', members: OK_MEMBERS, notes: ['something unchecked'] });
  assert.strictEqual(r.lines[r.lines.length - 2], 'note: something unchecked');
  assert.strictEqual(r.lines[r.lines.length - 1], attest.ATTEST_VERIFIED);
});

// ------------------------------------------------------- the gate that greps --

test('attestTarget: ok ONLY when the process exits 0 AND prints the verdict', async () => {
  const { attestTarget } = require('../libexec/clode-fuse.cjs');
  const run = (out, status = 0) => () => Promise.resolve({ status, stdout: out, stderr: '' });
  const args = { env: {}, cwd: '.', timeout: 1000 };

  const good = await attestTarget('/bin/x', { ...args, spawnRun: run(`x\n${attest.ATTEST_VERIFIED}\n`) });
  assert.strictEqual(good.ok, true);

  // Mutation 1: the product printed the FAILED verdict. Mutation 2: it printed the good
  // verdict but died. Mutation 3: it printed nothing at all (the shape of a target that
  // never implemented the flag). All three must be rejected, or the gate is decorative.
  for (const [why, r] of [
    ['failed verdict', await attestTarget('/bin/x', { ...args, spawnRun: run(`${attest.ATTEST_FAILED}\n`) })],
    ['nonzero exit', await attestTarget('/bin/x', { ...args, spawnRun: run(`${attest.ATTEST_VERIFIED}\n`, 1) })],
    ['silent', await attestTarget('/bin/x', { ...args, spawnRun: run('') })],
  ]) {
    assert.strictEqual(r.ok, false, `attestTarget accepted a ${why} run`);
  }
});

test('attestTarget asks for the CANONICAL flag spelling', async () => {
  const { attestTarget } = require('../libexec/clode-fuse.cjs');
  let seen = null;
  await attestTarget('/bin/x', {
    env: {}, cwd: '.', timeout: 1000,
    spawnRun: (bin, argv) => { seen = argv; return Promise.resolve({ status: 0, stdout: attest.ATTEST_VERIFIED, stderr: '' }); },
  });
  assert.deepStrictEqual(seen, ['--clode-attest']);
});

// ------------------------------------------------------------- no stragglers --

// The expensive recurring bug in this repo is a gate that stops gating because the string
// it greps moved. With `--quaude-attest` DELETED, a gate still grepping for it can never
// match — a hard check turned no-op while every build reports success. Nothing anywhere in
// the tree may still mention the retired flag or its old output prefix.
test('nothing in the tree still mentions --quaude-attest or the quaude-attest: prefix', () => {
  const REPO = path.resolve(__dirname, '..');
  const offenders = [];
  const SKIP_DIRS = new Set(['.git', 'node_modules', 'build', 'deps', '.harness', 'tjs-src', 'toolchain', '.matrix']);
  // The ONLY places the retired name may still appear, each for a stated reason. An
  // allowlist rather than a blanket test/ exemption: a gate that greps a dead string is
  // exactly the failure this sweep exists to catch, and gates live in test/ too.
  const ALLOWED = new Map([
    ['BACKLOG.md', 'history: records what the flag used to be called'],
    ['CHANGELOG.md', 'history: released notes are not rewritten'],
    ['test/clode-attest.test.cjs', 'this sweep names the retired string on purpose'],
    ['test/quaude-build.test.cjs', 'proves a real quaude no longer answers the retired flag'],
    ['test/naude-entry.test.cjs', 'proves a naude passes the retired flag through instead of attesting'],
  ]);
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      const rel = path.relative(REPO, p);
      if (ALLOWED.has(rel)) continue;
      let src;
      try { src = fs.readFileSync(p, 'utf8'); } catch { continue; }
      if (src.includes('\0')) continue; // binary
      for (const line of src.split('\n')) {
        if (/--quaude-attest|quaude-attest:/.test(line)) offenders.push(`${rel}: ${line.trim()}`);
      }
    }
  };
  walk(REPO);
  // The allowlist must not rot into a list of files that no longer exist (which would
  // quietly re-open a hole the day one of them is renamed).
  for (const rel of ALLOWED.keys()) {
    assert.ok(fs.existsSync(path.join(REPO, rel)), `allowlisted file is gone: ${rel}`);
  }
  assert.deepStrictEqual(offenders, [], `still naming the retired flag:\n${offenders.join('\n')}`);
});
