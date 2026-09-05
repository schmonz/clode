'use strict';
// THE AUTH GATE: assert the built artifact ATTEMPTS the platform credential store.
//
// WHY THIS EXISTS. A quaude built 2026-08-27 failed EVERY turn with a 401, because it
// never read the macOS Keychain at all -- zero `security` calls, silent fallback to a
// `~/.claude/.credentials.json` that had been dead for 20 days (BACKLOG.md, "Make it
// structurally hard to ship a release without working authentication"). `--version`,
// `--help`, and the mock-PONG smoke were all green on that binary, because none of them
// ever asks the credential store anything. The bug was not "the token was wrong"; it was
// "we never asked" -- and that is observable WITHOUT ever holding a secret.
//
// THE MECHANISM (named explicitly in that same BACKLOG entry): shadow `security` with a
// logging stub earlier on PATH, run a real artifact, and check the log for a
// `find-generic-password` call. Measured directly while building this file (darwin,
// provider 2.1.252, `-p` against an unroutable ANTHROPIC_BASE_URL so no real network or
// credential is ever touched): the artifact issues exactly two calls before it even
// notices the network is unreachable --
//   find-generic-password -a <user> -w -s "Claude Code-credentials"
//   find-generic-password -a <user> -w -s "Claude Code"
// -- so the store is consulted during argument/auth resolution, not during the network
// turn itself. That is what makes this check CHEAP: no mock server, no timeout budget
// for a live model, entirely offline.
//
// THE ENGINE UNDER TEST MUST BE quaude (tjs + libexec/node-shim), NOT naude (real node).
// FIX ROUND 1 (2026-09-04), from review: this file originally drove `runNaudeModel` --
// real Node executing cli.cjs directly, NODE_PATH pointed at deps/claude/node_modules,
// which never loads `libexec/node-shim/loader.cjs` at all. The shipped P0 lived entirely
// in the shim's OWN `child_process.cjs` (the keychain-emulation block, `_kcMode`/
// `_kcFakeChild`, deleted in `b901ec1`, plus an upstream availability-flag gate) --
// code reachable ONLY through the quaude engine. `scripts/build-naude.mjs` has zero
// `node-shim` references. A naude probe therefore could not have caught the original
// defect, and cannot catch a FUTURE shim-side regression that suppresses `security`
// spawns under tjs specifically -- a live risk, since that shim has its own history of
// `child_process` defects (exit-code mapping, uncaught-error routing, sync-write
// starvation -- see BACKLOG.md). The naude and quaude probes happened to agree (2
// find-generic-password calls each) ONLY because the emulation code is already deleted
// upstream of both paths today -- that coincidence is exactly the gap: nothing tied the
// guard's verdict to the engine that actually shipped broken. Do not "simplify" this
// back to `runNaudeModel` because it is easier to stage (no tjs binary needed) -- that
// silently restores the gap this fix closes. If quaude staging is unavailable on a host,
// the correct response is `{skip: '<reason>'}`, never a naude fallback.
//
// THE CONTROL PROBLEM, and why this file also shadows `git`. "The log is empty" is
// EQUALLY consistent with "the artifact never asked" and "my logging shim never fired".
// The same BACKLOG entry names the fix: "Wrapping git alongside security is what made the
// negative trustworthy today (6 git calls, 0 security)." This file reproduces exactly
// that shape -- the probe runs the artifact inside a real (scratch) git repo with `git`
// ALSO shadowed (logged, then passed through for real), so a genuine "0 security calls"
// reading is backed by "and yet N real git calls got through the same logging mechanism,
// so the mechanism was not the reason security stayed silent." scan()'s `examined` count
// IS the git-call count for exactly this reason: a guard whose own harness never fired
// must read as BROKEN (examined 0, below floor), not as a false OK.
//
// This is a NEW gate: no such artifact-level check existed anywhere in the suite before
// this file (measured -- grep for `find-generic-password` across test/*.cjs before this
// change hits only the stub mechanism's own self-tests: central-security-stub.test.cjs
// and node-shim-roundtrip-oracle.test.cjs's hermeticity comment; neither runs a real
// artifact and asserts the call happened). Wired through test/guard.cjs's
// defineGuard/guardTests (phase 5) so the check carries a mandatory positive control from
// day one, per this project's own rule that a negative assertion without one is not
// evidence ([[instruments-lie-check-them-first]]).
//
// SCOPE: darwin only, for now -- `security(1)` is the only store this file knows how to
// shadow. "Same trick generalises per platform as we learn each one's store" (same
// BACKLOG entry) is future work, not a gap being papered over; skip elsewhere says so.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { defineGuard, guardTests } = require('./guard.cjs');
const { runQuaudeModel, stageProviderCli, providerSkipReason } = require('./oracle-models.cjs');
const { tjsPath } = require('./node-shim-helper.cjs');

// PURE. inputs = { security: string[], git: string[] } -- each entry is the raw argv
// string logged for one shadowed invocation (see read() below for how these are
// produced). `examined` is deliberately the GIT count, not the security count: git is
// the positive-control channel here (see file header), so "examined" answers "how much
// evidence do we have that the logging mechanism itself worked", not "how many things
// did the artifact try". A real security attempt with a broken logging mechanism cannot
// happen (both are shadowed by the same PATH prepend, in the same child), so tying the
// floor to git's count is the correct proxy, not an arbitrary substitute.
function scanCredentialStoreAttempt({ security, git }) {
  const findings = [];
  const attempted = security.some((c) => /^find-generic-password\b/.test(c));
  if (!attempted) {
    findings.push('the artifact never attempted the platform credential store: 0 '
      + '`security find-generic-password` calls observed (security invocations seen: '
      + JSON.stringify(security) + ') -- this is the exact shape of the shipped P0 '
      + '("quaude never reads the Keychain", BACKLOG.md, 2026-08-28)');
  }
  return { findings, examined: git.length };
}

// `command -v git`, resolved BEFORE the stub dir is prepended to PATH, so the shadow
// script has a real binary to exec through.
function realGitPath() {
  const r = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

// Never let an ambient real credential land in the probed child's env, regardless of
// what the operator's shell happens to export -- belt-and-suspenders alongside the fresh
// HOME (which already has no ~/.claude/.credentials.json) and the unroutable base URL.
function safeEnv(overrides) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(ANTHROPIC|CLAUDE)_/i.test(k)) continue;
    env[k] = v;
  }
  return Object.assign(env, overrides);
}

// A directory holding two shadow scripts: `security` (fully intercepted -- the same
// "not found" / quiet-write shapes as test/run.mjs's central stub, so a spawned child
// behaves the same whether or not it happens to also inherit that central shadow) and
// `git` (logged, then a real passthrough exec -- must still work, since the artifact
// consults git for repo/context info on a real turn).
function makeShadowDir(logFile, gitBin) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-store-stub-'));
  const securityStub = '#!/bin/sh\n'
    + `echo "CALL: $@" >> "${logFile}"\n`
    + 'case "$1" in\n'
    + '  find-generic-password) echo "security: SecKeychainSearchCopyNext: The specified '
    + 'item could not be found in the keychain." 1>&2; exit 44 ;;\n'
    + '  -i) cat >/dev/null; exit 0 ;;\n'
    + '  add-generic-password) exit 0 ;;\n'
    + '  delete-generic-password) exit 0 ;;\n'
    + '  *) exit 1 ;;\n'
    + 'esac\n';
  fs.writeFileSync(path.join(dir, 'security'), securityStub);
  fs.chmodSync(path.join(dir, 'security'), 0o755);
  const gitStub = '#!/bin/sh\n'
    + `echo "GITCALL: $@" >> "${logFile}"\n`
    + `exec "${gitBin}" "$@"\n`;
  fs.writeFileSync(path.join(dir, 'git'), gitStub);
  fs.chmodSync(path.join(dir, 'git'), 0o755);
  return dir;
}

function parseLog(text) {
  const security = [];
  const git = [];
  for (const line of text.split('\n')) {
    if (line.startsWith('CALL: ')) security.push(line.slice('CALL: '.length));
    else if (line.startsWith('GITCALL: ')) git.push(line.slice('GITCALL: '.length));
  }
  return { security, git };
}

// The real I/O: stage a provider's cli.cjs (read-only against the resolved provider;
// writes only into a scratch/tmp stage root -- test/oracle-models.cjs's own hermeticity
// contract, shared with every other oracle test), run it under the QUAUDE engine (tjs +
// libexec/node-shim -- see the file header for why this is not optional) with `security`
// and `git` both shadowed, in a scratch git repo, against an UNROUTABLE base URL so the
// probe never touches a real network or a real credential and fails fast on its own.
function probeCredentialStoreAttempt() {
  if (process.platform !== 'darwin') {
    return { skip: 'security(1) is darwin-only; this guard has no other platform\'s '
      + 'credential-store call modeled yet (see file header)' };
  }
  const tjs = tjsPath();
  if (!tjs) {
    return { skip: 'no tjs binary (CLODE_TJS or build/tjs/tjs) -- the quaude engine this '
      + 'guard must exercise (see file header) is not buildable/resolvable here' };
  }
  const staged = stageProviderCli();
  const skip = providerSkipReason(staged, 'no resolvable Claude Code provider '
    + '(CLODE_PROVIDER_BIN / CLODE_CLAUDE_BIN / provider store)');
  if (skip) return { skip };

  const gitBin = realGitPath();
  if (!gitBin) return { skip: 'no git on PATH -- the positive-control probe needs a real git to shadow' };

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-store-probe-'));
  let stubDir;
  try {
    const home = path.join(scratch, 'home');
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
    const repoDir = path.join(scratch, 'repo');
    fs.mkdirSync(repoDir, { recursive: true });
    const logFile = path.join(scratch, 'calls.log');
    fs.writeFileSync(logFile, '');
    const init = spawnSync(gitBin, ['init', '-q'], { cwd: repoDir });
    if (init.status !== 0) return { skip: 'could not init a scratch git repo for the probe' };
    spawnSync(gitBin, ['-C', repoDir, 'config', 'user.email', 'clode-test@example.invalid']);
    spawnSync(gitBin, ['-C', repoDir, 'config', 'user.name', 'clode-test']);

    stubDir = makeShadowDir(logFile, gitBin);
    const env = safeEnv({
      HOME: home,
      PATH: [stubDir, process.env.PATH || ''].join(path.delimiter),
      // Unroutable: the probe fails fast on connection refused, never a real network or
      // credential -- and (measured) the credential-store lookup happens during
      // auth/argument resolution, BEFORE the artifact ever reaches the network.
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
    });

    const r = runQuaudeModel(staged.cli, ['-p', 'say PONG'], { cwd: repoDir, timeout: 60000, env, tjs });
    if (r.status === null) {
      return { skip: `the probe artifact timed out (signal ${r.signal}); cannot tell attempted from not` };
    }
    let logText = '';
    try { logText = fs.readFileSync(logFile, 'utf8'); } catch { /* nothing logged */ }
    return parseLog(logText);
  } finally {
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort cleanup */ }
    if (stubDir) { try { fs.rmSync(stubDir, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
}

const guard = defineGuard({
  name: 'credential-store-attempted',
  read: probeCredentialStoreAttempt,
  scan: scanCredentialStoreAttempt,
  // Models the DANGEROUS case this guard exists to catch: the harness genuinely worked
  // (three real git calls got through the shadow -- the positive control) but the
  // artifact issued NO `find-generic-password` call. This is the literal shape of the
  // shipped P0 ("6 git calls, 0 security"), not a hypothetical.
  control: () => ({
    security: [],
    git: ['status --short', 'remote get-url origin', 'log --oneline -n 5'],
  }),
});
guardTests(guard);

test('a real find-generic-password call satisfies the check', () => {
  const r = scanCredentialStoreAttempt({
    security: [
      'find-generic-password -a schmonz -w -s Claude Code-credentials',
      'find-generic-password -a schmonz -w -s Claude Code',
    ],
    git: ['status --short'],
  });
  assert.deepStrictEqual(r.findings, []);
  assert.strictEqual(r.examined, 1, 'examined must be the git (positive-control) count, not the security count');
});

test('regression: the shipped P0 shape (git calls present, zero security calls) is a VIOLATION', () => {
  const r = scanCredentialStoreAttempt({
    security: [],
    git: ['status --short', 'remote get-url origin', 'log --oneline -n 5', 'config user.name'],
  });
  assert.deepStrictEqual(r.findings, [
    'the artifact never attempted the platform credential store: 0 `security '
    + 'find-generic-password` calls observed (security invocations seen: []) -- this is '
    + 'the exact shape of the shipped P0 ("quaude never reads the Keychain", BACKLOG.md, '
    + '2026-08-28)',
  ]);
  assert.strictEqual(r.examined, 4);
});

test('a security call that is NOT find-generic-password does not satisfy the check', () => {
  // The doctor keychain-writability probe and the OAuth WRITE path both call `security`
  // with other subcommands (add-generic-password / delete-generic-password / -i); none
  // of those is the READ this guard is protecting, so they must not count as "attempted".
  const r = scanCredentialStoreAttempt({
    security: ['add-generic-password -U -a x -s y', 'delete-generic-password -a x -s y'],
    git: ['status --short'],
  });
  assert.strictEqual(r.findings.length, 1);
  assert.match(r.findings[0], /never attempted the platform credential store/);
});

test('mechanism self-check: 0 git calls means the harness itself never fired (BROKEN, not OK)', () => {
  // Even with a real security attempt present, examined must track git alone: a guard
  // whose own shadow never reached the child cannot tell "never called" from "never ran".
  const r = scanCredentialStoreAttempt({
    security: ['find-generic-password -a x -w -s y'],
    git: [],
  });
  assert.deepStrictEqual(r.findings, []);
  assert.strictEqual(r.examined, 0, 'examined must be 0 when the positive-control channel is empty, '
    + 'regardless of what security shows, so checkGate reports BROKEN rather than a false OK');
});
