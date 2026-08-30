'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { runNaude } = require('../libexec/naude-entry.cjs');

// Task 5 (naude notify-only parity): naude must expose the SAME
// globalThis.__clodeCheckUpdate global the quaude PRELUDE installs (extract-
// claude-js.cjs), and must no longer wire up a CLODE_SELF/--clode-internal-update
// spawn-back-to-the-builder callback — a naude cannot rebuild itself, and the
// notify-only autoupdater patch (Task 3) never spawns anything.
test('naude exposes __clodeCheckUpdate and does not spawn a builder on update', () => {
  const src = require('node:fs').readFileSync(require.resolve('../libexec/naude-entry.cjs'), 'utf8');
  assert.match(src, /__clodeCheckUpdate/);
  assert.doesNotMatch(src, /--clode-internal-update/);
});

// Task 5 review fix (round 1): the source-text test above proves naude-entry
// CAN provide __clodeCheckUpdate; it does NOT prove the baked cli.cjs's own
// PRELUDE can actually resolve `require(__dirname + '/target-update-check.cjs')`
// at runtime — that resolution succeeds only because the first pass's
// materializeAssets call requests 'target-update-check.cjs' alongside
// cli.cjs/bun-shim.cjs, so it lands on disk in the SAME workDir cli.cjs's
// __dirname points at. Nothing else in the suite pins that literal in the
// `names` array (naude-build.test.cjs covers the SEA-asset/build-time layer;
// naude-sea.test.cjs's materializeAssets test uses its own hardcoded names) —
// a silent removal here would still pass all other tests and only the
// environment-gated naude-smoke test would ever catch it.
test('first pass materializes target-update-check.cjs alongside cli.cjs (the notify-only autoupdater dependency)', () => {
  let names = null;
  runNaude({
    argv: [], execPath: '/naude', env: {}, cacheDir: os.tmpdir(), workDir: '/work',
    sea: fakeSea(),
    materializeDeps: () => '/deps',
    materializeAssets: (opts) => { names = opts.names; return opts.destDir; },
    spawn: () => ({ on() {} }),
    procOn: () => {}, procOff: () => {}, exit: () => {},
    onExit: (cb) => cb(0, null),
  });
  assert.ok(Array.isArray(names) && names.includes('target-update-check.cjs'),
    `materializeAssets must be called with 'target-update-check.cjs' in its names array, or cli.cjs's own ` +
    `PRELUDE require(__dirname + '/target-update-check.cjs') 404s the moment the notify-only autoupdater fires. ` +
    `Got: ${JSON.stringify(names)}`);
});

function fakeSea() {
  const assets = { 'cli.cjs': 'CLI', 'bun-shim.cjs': 'SHIM', 'deps.tar': '', 'deps.sig': 'sig0' };
  return { isSea: () => true, getRawAsset: (n) => { const b = Buffer.from(assets[n] || ''); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); } };
}

// The default `sea` MUST be the node:sea module — the thing whose getRawAsset the
// materializers call. Passing naude-sea.cjs (the HELPERS module) here type-checks
// and unit-passes, then dies in the real SEA with "sea.getRawAsset is not a
// function" on the very first boot. Every other test in this file injects both a
// fake sea AND stubbed materializers, so nothing else exercises this seam: assert
// on the DEFAULT, with only the materializers stubbed, or the bug hides again.
test('first pass defaults `sea` to the node:sea module, not the helpers module', () => {
  const seen = {};
  runNaude({
    argv: [], execPath: '/naude', env: {}, cacheDir: os.tmpdir(), workDir: '/work',
    // NOTE: no `sea` override — the default is what is under test.
    materializeDeps: ({ sea }) => { seen.deps = sea; return '/deps'; },
    materializeAssets: ({ sea, destDir }) => { seen.assets = sea; return destDir; },
    spawn: () => ({ on() {} }),
    procOn: () => {}, procOff: () => {}, exit: () => {},
    onExit: (cb) => cb(0, null),
  });
  for (const [who, sea] of Object.entries(seen)) {
    assert.strictEqual(typeof sea?.getRawAsset, 'function',
      `materialize${who === 'deps' ? 'Deps' : 'Assets'} was handed an object with no getRawAsset — it cannot read a single embedded asset`);
    assert.strictEqual(typeof sea?.isSea, 'function', 'the sea seam must be the node:sea module');
  }
  assert.ok(!('materializeDeps' in (seen.deps || {})),
    'the helpers module leaked in as `sea` — that is the shape of the boot-killing bug');
});

// A fake child that records the signals it is asked to kill with (mirrors the
// clode-run.test.cjs fakeChild, adapted to naude's spawn seam shape which returns
// a plain object rather than an EventEmitter — naude drives exit via the onExit seam).
function fakeChild() {
  return { killed: [], kill(sig) { this.killed.push(sig); return true; }, on() {} };
}

// Run the first pass with sensible defaults, letting the caller override seams and
// capture what happened. Returns { call, child, exited, handlers, registered, removed }.
function firstPass(overrides = {}) {
  const captured = { call: null, exited: 'unset', handlers: {}, registered: [], removed: [] };
  const child = overrides.child || fakeChild();
  runNaude(Object.assign({
    argv: ['--version'], execPath: '/naude',
    sea: fakeSea(), env: {}, cacheDir: os.tmpdir(),
    materializeDeps: () => '/deps',
    materializeAssets: ({ destDir }) => destDir,
    workDir: '/work',
    spawn: (cmd, args, opts) => { captured.call = { cmd, args, opts }; return child; },
    procOn: (s, cb) => { captured.handlers[s] = cb; captured.registered.push(s); },
    procOff: (s) => { captured.removed.push(s); },
    exit: (c) => { captured.exited = c; },
  }, overrides));
  captured.child = child;
  return captured;
}

test('first pass (isSea, no sentinel) re-invokes execPath in run-as-node with cli.cjs + NODE_PATH', () => {
  let call = null; let exited = null;
  runNaude({
    argv: ['--version'], execPath: '/naude',
    sea: fakeSea(), env: {}, cacheDir: require('os').tmpdir(),
    materializeDeps: () => '/deps',
    materializeAssets: ({ destDir }) => destDir,
    workDir: '/work',
    spawn: (cmd, args, opts) => { call = { cmd, args, opts }; return { on(){}, }; },
    procOn: () => {}, procOff: () => {}, exit: (c) => { exited = c; },
    onExit: (cb) => cb(0, null),
  });
  assert.strictEqual(call.cmd, '/naude');
  // path.join/-delimiter, not POSIX literals: runNaude builds these with
  // path.join, so on Windows they come back '\work\cli.cjs' and
  // '\deps\node_modules'. Literals here asserted a POSIX-only shape and failed
  // every windows-latest run. (The test at :160 below already had this right.)
  assert.strictEqual(call.opts.env.NAUDE_RUN_AS_NODE, path.join('/work', 'cli.cjs'));
  assert.ok(call.opts.env.NODE_PATH.includes(path.join('/deps', 'node_modules')),
    `NODE_PATH lacks the materialized deps dir: ${call.opts.env.NODE_PATH}`);
  // execPath is truthy here, so guard injection (see the dedicated tests below)
  // now always appends --settings <file> after the user's own args — assert
  // the user arg survives untouched at the front rather than an exact array
  // match, and clean up the ephemeral file this run wrote.
  assert.strictEqual(call.args[0], '--version');
  const settingsIdx = call.args.indexOf('--settings');
  if (settingsIdx !== -1) fs.rmSync(call.args[settingsIdx + 1], { force: true });
  assert.strictEqual(exited, 0);
});

test('second pass (sentinel set) runs the target cli.cjs as main', () => {
  let required = null;
  const env = { NAUDE_RUN_AS_NODE: '/work/cli.cjs' };
  runNaude({
    argv: ['--version'], execPath: '/naude',
    env,
    requireMain: (p, argv) => { required = { p, argv }; },
  });
  assert.strictEqual(required.p, '/work/cli.cjs');
  assert.deepStrictEqual(required.argv, ['/naude', '/work/cli.cjs', '--version']);
  // Minor: the sentinel is stripped before the target runs, so the baked cli.cjs
  // never sees NAUDE_RUN_AS_NODE (and never mistakes itself for a first pass).
  assert.ok(!('NAUDE_RUN_AS_NODE' in env), 'sentinel deleted from the target env');
});

// --- first pass: exit-status mapping (ports of clode-run's exit semantics) ----
test('first pass: a signal death maps to 128+signum (SIGTERM -> 143)', () => {
  const { exited } = firstPass({ onExit: (cb) => cb(null, 'SIGTERM') });
  assert.strictEqual(exited, 128 + os.constants.signals.SIGTERM);
  assert.strictEqual(exited, 143);
});

test('first pass: a null exit code maps to 1', () => {
  const { exited } = firstPass({ onExit: (cb) => cb(null, null) });
  assert.strictEqual(exited, 1);
});

test('first pass: a non-zero exit code passes through', () => {
  const { exited } = firstPass({ onExit: (cb) => cb(7, null) });
  assert.strictEqual(exited, 7);
});

// --- first pass: signal model (tty vs directed) -------------------------------
test('first pass: ignores tty signals (SIGINT/SIGQUIT), forwards directed (SIGTERM/SIGHUP)', () => {
  const cap = firstPass({ onExit: () => {} });
  for (const s of ['SIGINT', 'SIGQUIT', 'SIGTERM', 'SIGHUP']) {
    assert.strictEqual(typeof cap.handlers[s], 'function', `handler registered for ${s}`);
  }
  // tty signals reach the child directly via the shared foreground group; forwarding
  // would double-deliver, so these handlers are NO-OPs.
  cap.handlers.SIGINT();
  cap.handlers.SIGQUIT();
  assert.deepStrictEqual(cap.child.killed, [], 'tty signals must not be forwarded');
  // directed signals reach only our pid, so they ARE forwarded to the child.
  cap.handlers.SIGTERM();
  cap.handlers.SIGHUP();
  assert.deepStrictEqual(cap.child.killed, ['SIGTERM', 'SIGHUP']);
});

test('first pass: every registered signal handler is torn down when the child exits', () => {
  const cap = firstPass({ onExit: (cb) => cb(0, null) });
  assert.deepStrictEqual([...cap.removed].sort(), [...cap.registered].sort(),
    'every registered signal handler is removed on exit');
});

// --- first pass: NAUDE_CACHE env plumbs the deps-materialization cache dir -----
test('first pass: NAUDE_CACHE env sets the cacheDir passed to materializeDeps', () => {
  let seenCacheDir = null;
  runNaude({
    // execPath: '' — this test isn't about guard injection, and injection
    // would try to write its ephemeral settings file under the (nonexistent)
    // '/custom' cacheDir asserted below, which is unrelated ENOENT noise.
    argv: ['--version'], execPath: '',
    sea: fakeSea(), env: { NAUDE_CACHE: '/custom' },
    materializeDeps: ({ cacheDir }) => { seenCacheDir = cacheDir; return '/deps'; },
    materializeAssets: ({ destDir }) => destDir,
    spawn: () => ({ on() {} }),
    procOn: () => {}, procOff: () => {}, exit: () => {},
    onExit: (cb) => cb(0, null),
  });
  assert.strictEqual(seenCacheDir, '/custom');
});

// --- first pass: NODE_PATH prepend preserves a prior value --------------------
test('first pass: NODE_PATH prepends the deps node_modules, preserving a prior value', () => {
  const { call } = firstPass({ env: { NODE_PATH: '/pre' }, onExit: () => {} });
  assert.strictEqual(
    call.opts.env.NODE_PATH,
    path.join('/deps', 'node_modules') + path.delimiter + '/pre');
});

// --- first pass: the target-env contract lands in the child's env ------------
test('first pass shapes the child env with the target contract', () => {
  let call = null;
  runNaude({
    argv: [], execPath: '/naude', env: { PATH: '/usr/bin' }, cacheDir: os.tmpdir(), workDir: '/work',
    sea: fakeSea(),
    materializeDeps: () => '/deps',
    materializeAssets: ({ destDir }) => destDir,
    spawn: (cmd, args, o) => { call = o; return { on() {} }; },
    procOn: () => {}, procOff: () => {}, exit: () => {},
    onExit: (cb) => cb(0, null),
  });
  // The contract the runner used to apply at launch; naude applies it to itself.
  assert.strictEqual(call.env.DISABLE_INSTALLATION_CHECKS, '1');
  assert.strictEqual(call.env.NODE_USE_ENV_PROXY, '1');
  // NODE_PATH stays naude's own business (materialized deps), not target-env's.
  // path.join, not a POSIX literal — see the note at the first-pass test above.
  assert.ok(call.env.NODE_PATH.includes(path.join('/deps', 'node_modules')),
    `NODE_PATH lacks the materialized deps dir: ${call.env.NODE_PATH}`);
  // Task 5: naude never sets CLODE_SELF at all any more (bakedBuilder/the
  // `builder` seam were removed) — the notify-only autoupdater (Task 3) never
  // spawns a builder, so there is nothing left for it to point at.
  assert.strictEqual(call.env.CLODE_SELF, undefined, 'naude must never set CLODE_SELF (Task 5: retired)');
});

// Task 5 (auto-update notify-only): a naude cannot rebuild itself, and the
// notify-only autoupdater patch never spawns a builder, so CLODE_SELF is
// GONE — not merely unset-by-default. Both a stray `builder` opt override and
// a real SEA `builder` asset (either of which used to seed CLODE_SELF) must
// have zero effect now; this guards against the wiring quietly coming back.
test('first pass never sets CLODE_SELF, even with a stray `builder` override or a real SEA `builder` asset', () => {
  let call = null;
  runNaude({
    argv: [], execPath: '/naude', env: {}, cacheDir: os.tmpdir(), workDir: '/work',
    sea: fakeSea(),
    builder: '/usr/local/bin/clode',            // a stray override — must be ignored
    materializeDeps: () => '/deps',
    materializeAssets: ({ destDir }) => destDir,
    spawn: (cmd, args, o) => { call = o; return { on() {} }; },
    procOn: () => {}, procOff: () => {}, exit: () => {},
    onExit: (cb) => cb(0, null),
  });
  assert.strictEqual(call.env.CLODE_SELF, undefined,
    'a stray `builder` override must not resurrect CLODE_SELF');

  let call2 = null;
  const sea = Object.assign(fakeSea(), {
    getAsset: (name) => (name === 'builder' ? '/usr/local/bin/clode' : (() => { throw new Error(`no such asset: ${name}`); })()),
  });
  runNaude({
    argv: [], execPath: '/naude', env: {}, cacheDir: os.tmpdir(), workDir: '/work',
    sea,
    materializeDeps: () => '/deps',
    materializeAssets: ({ destDir }) => destDir,
    spawn: (cmd, args, o) => { call2 = o; return { on() {} }; },
    procOn: () => {}, procOff: () => {}, exit: () => {},
    onExit: (cb) => cb(0, null),
  });
  assert.strictEqual(call2.env.CLODE_SELF, undefined,
    'a real SEA `builder` asset must not resurrect CLODE_SELF');
});

test('first pass never declares CLODE_TARGET_KIND / CLODE_TARGET (rebuild machinery retired)', () => {
  // These once told the rebuild callback what kind of target to rebuild and
  // where. Auto-update is notify-only now (a version check, no rebuild), so the
  // target no longer needs to declare its own identity to the env.
  let call = null;
  runNaude({
    argv: [], execPath: '/naude', env: {}, cacheDir: os.tmpdir(), workDir: '/work',
    sea: fakeSea(),
    materializeDeps: () => '/deps',
    materializeAssets: ({ destDir }) => destDir,
    spawn: (cmd, args, o) => { call = o; return { on() {} }; },
    procOn: () => {}, procOff: () => {}, exit: () => {},
    onExit: (cb) => cb(0, null),
  });
  assert.ok(!('CLODE_TARGET_KIND' in call.env), 'CLODE_TARGET_KIND is retired');
  assert.ok(!('CLODE_TARGET' in call.env), 'CLODE_TARGET is retired');
});

// --- guard dispatch: `--clode-update-guard` short-circuits everything else ----
// A fake stdin that synchronously drives the standard flowing-mode `.on('data',
// ...)` / `.on('end', ...)` pair naude-entry uses to read stdin — matches how a
// real process.stdin behaves closely enough for this seam (data emitted before
// end), without needing a real stream.
function fakeStdin(jsonStr) {
  return {
    on(event, cb) {
      if (event === 'data') cb(Buffer.from(jsonStr));
      if (event === 'end') cb();
      return this;
    },
  };
}

function fakeStdout() {
  const chunks = [];
  return { chunks, write(s) { chunks.push(s); } };
}

test('guard dispatch: --clode-update-guard reads stdin, emits the deny verdict, exits 0, never spawns', () => {
  const stdout = fakeStdout();
  let exited = 'unset';
  let spawnCalled = false;
  runNaude({
    argv: ['--clode-update-guard'],
    stdin: fakeStdin(JSON.stringify({ tool_input: { command: 'claude update' } })),
    stdout,
    exit: (c) => { exited = c; },
    spawn: () => { spawnCalled = true; return { on() {} }; },
  });
  assert.strictEqual(exited, 0);
  assert.strictEqual(spawnCalled, false, 'the bundle must never be spawned for the guard-dispatch invocation');
  assert.strictEqual(stdout.chunks.length, 1);
  const verdict = JSON.parse(stdout.chunks[0]);
  assert.strictEqual(verdict.hookSpecificOutput.permissionDecision, 'deny');
});

test('guard dispatch: allowed command -> no stdout write, exit 0, no spawn', () => {
  const stdout = fakeStdout();
  let exited = 'unset';
  let spawnCalled = false;
  runNaude({
    argv: ['--clode-update-guard'],
    stdin: fakeStdin(JSON.stringify({ tool_input: { command: 'ls -la' } })),
    stdout,
    exit: (c) => { exited = c; },
    spawn: () => { spawnCalled = true; return { on() {} }; },
  });
  assert.strictEqual(exited, 0);
  assert.strictEqual(spawnCalled, false);
  assert.strictEqual(stdout.chunks.length, 0, 'an allowed command emits nothing (bare exit 0 = allow)');
});

test('guard dispatch: unparseable stdin fails OPEN (no crash, no stdout, exit 0)', () => {
  const stdout = fakeStdout();
  let exited = 'unset';
  runNaude({
    argv: ['--clode-update-guard'],
    stdin: fakeStdin('not json'),
    stdout,
    exit: (c) => { exited = c; },
    spawn: () => { throw new Error('must not spawn'); },
  });
  assert.strictEqual(exited, 0);
  assert.strictEqual(stdout.chunks.length, 0);
});

// --- guard injection: execPath (the naude's OWN path) wires --settings into --
// --- the child argv. This is the real production data flow: shapeTargetEnv ----
// puts execPath into the CHILD's env.CLODE_TARGET during boot (see the
// `CLODE_TARGET=<the naude exe>` test above) — nothing ever sets it on the RAW
// incoming env before the process starts. So the gate MUST read execPath, not
// env.CLODE_TARGET, or the hook is permanently inert in real boots (it only
// ever passed before because unit tests injected env.CLODE_TARGET by hand).
test('first pass: execPath present (env.CLODE_TARGET NOT set) -> child argv gets --settings <file>, file wires the PreToolUse guard hook from execPath', () => {
  // NOTE: no onExit override here — the default (registers on the fake child's
  // inert `on('exit', ...)`) never fires, so the settings file survives long
  // enough to inspect. (A firing onExit would run cleanup() and unlink it —
  // see the dedicated cleanup test below.) env stays {} — no CLODE_TARGET
  // anywhere — proving injection fires from execPath alone.
  const cap = firstPass({ execPath: '/opt/naude', env: {} });
  const idx = cap.call.args.indexOf('--settings');
  assert.ok(idx !== -1, '--settings must be appended to the child argv');
  const file = cap.call.args[idx + 1];
  assert.ok(file, '--settings must be followed by a path');
  const written = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(
    written.hooks.PreToolUse[0].hooks[0].command,
    '"/opt/naude" --clode-update-guard');
  assert.strictEqual(written.hooks.PreToolUse[0].matcher, 'Bash');
  fs.rmSync(file, { force: true });
});

test('first pass: execPath falsy (no own binary to call back into) -> no --settings added to the child argv', () => {
  const cap = firstPass({ execPath: '', onExit: (cb) => cb(0, null) });
  assert.strictEqual(cap.call.args.indexOf('--settings'), -1);
});

test('first pass: the guard settings file is best-effort removed when the child exits', () => {
  let writtenFile = null;
  const cap = firstPass({
    onExit: (cb) => cb(0, null),
  });
  const idx = cap.call.args.indexOf('--settings');
  writtenFile = cap.call.args[idx + 1];
  assert.strictEqual(fs.existsSync(writtenFile), false, 'the ephemeral settings file must be removed on exit');
});


// --- `--clode-attest`: the SAME flag, and the SAME verdict line, quaude prints -
// naude used to have NO attest of any kind: "is this artifact intact?" was a
// question only one of the two products could answer, in a spelling that named
// that product. These tests pin naude's half — that it answers the canonical
// flag, hashes what it claims to hash, and never boots the bundle while doing
// it (an attest that spawns Claude Code is not an attest, it's a launch).
const crypto = require('node:crypto');
const { ATTEST_VERIFIED, ATTEST_FAILED } = require('../libexec/clode-attest.cjs');

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

// A fake SEA carrying the same asset set a real naude bakes, with a manifest
// whose member shas actually match — so a test that tampers with one asset is
// the ONLY reason a FAIL can appear.
function attestableSea(tamper = {}) {
  const payload = {
    'deps.tar': Buffer.from('TARBALL'),
    'deps.sig': Buffer.from('sig0'),
    'bun-shim.cjs': Buffer.from('SHIM'),
    'cli.cjs': Buffer.from('CLI'),
    'target-update-check.cjs': Buffer.from('TUC'),
  };
  const members = {};
  for (const [n, b] of Object.entries(payload)) members[n] = { len: b.length, sha256: sha256(b) };
  const manifest = Buffer.from(JSON.stringify({
    clode: '1', role: 'naude', entry: 'cli.cjs',
    bundleVersion: 'claude-abc', providerPlatform: 'darwin', clodeVersion: '0.0.0-test',
    members,
  }, null, 2) + '\n');
  const assets = { ...payload, 'manifest.json': manifest, 'manifest.sig': Buffer.from(sha256(manifest)) };
  for (const [n, v] of Object.entries(tamper)) assets[n] = Buffer.from(v);
  return {
    isSea: () => true,
    getRawAsset: (n) => {
      const b = assets[n];
      if (!b) throw new Error(`no such asset: ${n}`);
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    },
  };
}

function runAttest(argv, sea) {
  const stdout = fakeStdout();
  const stderr = fakeStdout();
  let exited = 'unset';
  runNaude({
    argv, execPath: '/naude', env: {}, cacheDir: os.tmpdir(), workDir: '/work',
    sea,
    stdout, stderr,
    materializeDeps: () => { throw new Error('attest must not materialize deps'); },
    materializeAssets: () => { throw new Error('attest must not materialize assets'); },
    spawn: () => { throw new Error('attest must never spawn the bundle'); },
    procOn: () => {}, procOff: () => {}, exit: (c) => { exited = c; },
  });
  return { exited, out: stdout.chunks.join(''), err: stderr.chunks.join('') };
}

test('--clode-attest: prints the manifest, one line per member, then the SHARED verdict; exit 0', () => {
  const r = runAttest(['--clode-attest'], attestableSea());
  assert.strictEqual(r.exited, 0, r.err);
  const lines = r.out.split('\n').filter(Boolean);
  assert.strictEqual(lines[lines.length - 1], ATTEST_VERIFIED,
    'the verdict line must be byte-identical to the one quaude prints — one gate greps both');
  for (const n of ['deps.tar', 'deps.sig', 'bun-shim.cjs', 'cli.cjs', 'target-update-check.cjs', 'manifest.json']) {
    assert.ok(lines.some((l) => new RegExp(`^ok {3}${n.replace(/\./g, '\\.')} \\(\\d+ bytes\\)$`).test(l)),
      `no verification line for ${n} in:\n${r.out}`);
  }
  // The manifest itself is printed verbatim first, so the same three facts quaude
  // reports are answerable about a naude.
  const m = JSON.parse(r.out.slice(0, r.out.indexOf('\nok   ')));
  assert.strictEqual(m.providerPlatform, 'darwin');
  assert.strictEqual(m.bundleVersion, 'claude-abc');
  assert.strictEqual(m.clodeVersion, '0.0.0-test');
});

test('--clode-attest: a tampered asset FAILS loudly and exits 1', () => {
  const r = runAttest(['--clode-attest'], attestableSea({ 'cli.cjs': 'EVIL' }));
  assert.strictEqual(r.exited, 1, 'a tampered naude must not exit 0');
  assert.ok(r.out.includes('FAIL cli.cjs'), r.out);
  assert.ok(r.out.trim().endsWith(ATTEST_FAILED), r.out);
});

// The manifest is what the ok-lines are checked AGAINST, so it needs its own root of
// trust or "verified" means "verified against whatever the attacker wrote". manifest.sig
// plays exactly the role quaude's archive index plays.
test('--clode-attest: a tampered manifest FAILS (it is checked against manifest.sig)', () => {
  const r = runAttest(['--clode-attest'], attestableSea({ 'manifest.json': '{"members":{}}' }));
  assert.strictEqual(r.exited, 1);
  assert.ok(r.out.includes('FAIL manifest.json'), r.out);
});

// The retired spelling gets no special handling at all: it is an ordinary argument, so it
// flows through to Claude Code (which rejects it) rather than quietly attesting.
test('--quaude-attest is not a naude flag: it is passed through, and nothing attests', () => {
  const cap = firstPass({ argv: ['--quaude-attest'], onExit: (cb) => cb(0, null) });
  assert.ok(cap.call, 'the child must still be spawned — the flag is not ours to handle');
  assert.ok(cap.call.args.includes('--quaude-attest'));
});

test('an unknown reserved flag is refused by naude, never handed to Claude Code', () => {
  const r = runAttest(['--clode-frobnicate', '-p', 'x'], attestableSea());
  assert.strictEqual(r.exited, 64);
  assert.match(r.err, /--clode-frobnicate/);
});

test('a bare run carves nothing: ordinary args reach the child untouched', () => {
  const cap = firstPass({ argv: ['-p', 'say PONG', '--allowedTools', 'Bash'], onExit: (cb) => cb(0, null) });
  assert.deepStrictEqual(cap.call.args.filter((a) => a !== '--settings' && !/clode-guard-/.test(a)),
    ['-p', 'say PONG', '--allowedTools', 'Bash']);
});
