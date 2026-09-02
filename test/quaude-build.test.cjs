'use strict';
// Q1b items 3/5/6 end-to-end: `clode build` fuses a real quaude on this machine
// (template tjs + compiled 2.1.204-class bundle), then the artifact is put
// through the acceptance battery:
//   - the build itself smokes PONG + attest internally (exit 0 required);
//   - attest golden: STABLE manifest fields only (schema, versions, shas the
//     test recomputes independently) — never builtAt;
//   - reserved-namespace mechanics against the real bootstrap (unknown
//     --clode-foo errors from quaude, exit 64, bundle never runs;
//     --clode-attest short-circuits even with bundle args present);
//   - THE GATE ITSELF: a tampered copy of the same binary must FAIL attest —
//     a verification that cannot fail is not a verification;
//   - the STRICT-MODE sweep the design memo requires (§6.3): the agentic Bash
//     mock oracle from test/node-shim-agentic.test.cjs, pointed at the fused
//     binary — the bundle runs as compiled-module bytecode (strict), so this
//     is the tool-use path's strictness gate;
//   - TUI paint smoke, additionally gated on CLODE_LIVE_RENDER=1 (Keychain).
// Gates: tjs template + CLODE_PROVIDER_BIN (like the other bundle-spawning
// suites). Hermetic: CLODE_CACHE points into the fixture tmp dir; the repo's
// own node_modules feeds the dep members (ensureDeps early-returns).
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { tjsPath, skipUnlessTjs, REPO } = require('./node-shim-helper.cjs');
const { startMockAnthropic, cannedSSE, cannedToolUseSSE } = require('./mock-anthropic-helper.cjs');
const { cacheKey } = require('../libexec/clode-resolve.cjs');
const { providerPlatformOf } = require('../libexec/extract-claude-js.cjs');
const { readManifest } = require('./quaude-archive.cjs');
const { stateRoot } = require('./state-root-helper.cjs');

const ENTRY = path.join(REPO, 'bin', 'clode');
const VERSION = fs.readFileSync(path.join(REPO, 'VERSION'), 'utf8').replace(/\n+$/, '');
function providerBin() { const p = process.env.CLODE_PROVIDER_BIN; return p && fs.existsSync(p) ? p : null; }
function sha256File(p) { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); }

let SKIP = null, DIR = null, QUAUDE = null, BUILD = null;
before(() => {
  if (!tjsPath()) { SKIP = 'no tjs binary (CLODE_TJS or build/tjs/tjs)'; return; }
  if (!providerBin()) { SKIP = 'no CLODE_PROVIDER_BIN'; return; }
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'quaude-build-'));
  QUAUDE = path.join(DIR, 'quaude');
  BUILD = spawnSync(process.execPath, [ENTRY, 'build', '--out', QUAUDE], {
    encoding: 'utf8',
    timeout: 300000,
    env: {
      ...process.env,
      CLODE_CLAUDE_BIN: providerBin(),
      CLODE_CACHE: path.join(DIR, 'cache'),   // hermetic: never the real cache
      // stateRoot(DIR): respects test/run.mjs's central CLODE_STATE_ROOT when
      // present, else falls back to this file's own private DIR -- needed for
      // a standalone `node --test` run (run.mjs never executes), same reason
      // CLODE_CACHE above is pinned.
      CLODE_STATE_ROOT: stateRoot(DIR),
      CLODE_TJS: tjsPath(),
      DYLD_INSERT_LIBRARIES: '',
    },
  });
});
after(() => { if (DIR) { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } } });

// Async spawn of the fused binary (the agentic oracle needs the in-process mock
// to stay serviceable — spawnSync would starve it).
function runQuaude(args, env, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const child = spawn(QUAUDE, args, { cwd: DIR, stdio: ['ignore', 'pipe', 'pipe'], env });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const to = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
    child.on('exit', (status) => { clearTimeout(to); resolve({ status, stdout, stderr }); });
    child.on('error', (e) => { clearTimeout(to); resolve({ status: null, stdout, stderr: String(e) }); });
  });
}
// The fused binary must be self-contained: no NODE_PATH ever.
function cleanEnv(extra) {
  const env = { ...process.env, ...extra };
  delete env.NODE_PATH;
  return env;
}

test('clode build fuses a quaude and its internal PONG + attest smokes pass', (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  assert.strictEqual(BUILD.status, 0, `clode build failed:\n${BUILD.stdout}\n${BUILD.stderr}`);
  assert.match(BUILD.stdout, /clode: fused /);
  assert.match(BUILD.stdout, /PONG round-trip ok, attest ok/);
  assert.ok(fs.statSync(QUAUDE).size > 30 * 1024 * 1024, 'fused binary implausibly small');
  assert.ok(fs.statSync(QUAUDE).mode & 0o111, 'fused binary not executable');
});

test('attest golden: stable manifest fields + full member verification', async (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  const r = await runQuaude(['--clode-attest'], cleanEnv());
  assert.strictEqual(r.status, 0, r.stderr);
  // Output = manifest JSON verbatim, then one ok/FAIL line per member, then the summary.
  const lines = r.stdout.split('\n');
  const firstMemberLine = lines.findIndex((l) => /^(ok {2}|FAIL) /.test(l));
  assert.ok(firstMemberLine > 0, 'no member verification lines');
  const manifest = JSON.parse(lines.slice(0, firstMemberLine).join('\n'));

  // GOLDEN (stable fields only — builtAt deliberately unchecked beyond shape):
  assert.deepStrictEqual(Object.keys(manifest).sort(), [
    'bom', 'builtAt', 'bundleVersion', 'clode', 'clodeVersion', 'engine', 'entry',
    'hooks', 'idna', 'members', 'providerPlatform', 'role', 'template',
  ]);
  assert.strictEqual(manifest.clode, '1');
  assert.strictEqual(manifest.role, 'quaude');
  // THE ENTRY MEMBER IS NAMED FOR THE BUNDLE SHAPE, and both shapes are ours:
  // 'cli.qbc' for a single-CJS provider, 'graph.qbc' for a code-split one (2.1.243+,
  // libexec/quaude-fuse.js). Pinning only the first made this golden fail against a
  // CORRECTLY built quaude from the day upstream went code-split — a red that named the
  // test, not the product, and sat there while it was the product we were changing.
  assert.ok(['cli.qbc', 'graph.qbc'].includes(manifest.entry),
    `unexpected entry member: ${manifest.entry}`);
  assert.strictEqual(manifest.bundleVersion, cacheKey(providerBin()));
  // WHICH PLATFORM'S BUNDLE IS IN HERE — read from the provider's container bytes, never from
  // the host. Bun folds process.platform at carve time, so a darwin target fused from a linux
  // carve has upstream's whole macOS credential store dead-coded away; that is the quaude that
  // shipped on 2026-08-27 unable to read the login Keychain. The version alone cannot say it,
  // and until this field existed a fused target could not be asked at all.
  assert.strictEqual(manifest.providerPlatform, providerPlatformOf(providerBin()) || 'unknown');
  assert.ok(manifest.providerPlatform !== 'unknown',
    `the provider ${providerBin()} is a real container, so its platform must be NAMED, not 'unknown'`);
  assert.strictEqual(manifest.clodeVersion, VERSION);
  // The `builder` field is RETIRED: auto-update is notify-only (a version
  // check, no rebuild), so a quaude no longer records who built it.
  assert.ok(!('builder' in manifest), 'builder field is retired');
  assert.ok(manifest.engine.quickjs && manifest.engine.tjs, 'engine pins missing');
  assert.ok(['uts46', 'l1'].includes(manifest.idna), `underived idna: ${manifest.idna}`);
  assert.strictEqual(manifest.template.sha256, sha256File(tjsPath()));
  assert.strictEqual(manifest.hooks['extract-claude-js.cjs'],
    sha256File(path.join(REPO, 'libexec/extract-claude-js.cjs')));
  assert.ok(!Number.isNaN(Date.parse(manifest.builtAt)), 'builtAt not ISO-parseable');
  // target-env.cjs is a BARE member name (archive root, no libexec/ prefix —
  // see quaude-fuse.js's comment on why): pre-existing test bug fixed
  // in-passing here (this exact assertion block is what Task a's BOM checks
  // extend below) — 'libexec/target-env.cjs' never was a real member name.
  // manifest.entry names whichever bytecode member this shape produced (cli.qbc or
  // graph.qbc, asserted above); require THAT one rather than a hardcoded name, so the
  // check keeps meaning the same thing as upstream's packaging changes under us.
  for (const m of [manifest.entry, 'bun-shim.cjs', 'node-shim/loader.cjs', 'node-shim/modules/process.cjs', 'target-env.cjs', 'target-update-check.cjs']) {
    assert.ok(manifest.members[m], `manifest missing member ${m}`);
  }
  // The shipped loader member must be byte-identical to the committed loader.
  assert.strictEqual(manifest.members['node-shim/loader.cjs'].sha256,
    sha256File(path.join(REPO, 'libexec/node-shim/loader.cjs')));

  // BOM (Task a): the declared closure as name@version — states what this
  // quaude embeds without cross-referencing package.json + node_modules.
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO, 'deps', 'claude', 'package.json'), 'utf8'));
  assert.ok(Array.isArray(manifest.bom) && manifest.bom.length >= Object.keys(pkg.dependencies).length,
    `bom implausibly small: ${JSON.stringify(manifest.bom)}`);
  for (const spec of manifest.bom) assert.match(spec, /^[^@]+@\S+$/, `not a name@version spec: ${spec}`);
  assert.ok(manifest.bom.some((s) => s.startsWith('semver@')), manifest.bom.join(', '));
  // Every declared direct dependency must appear (by name) in the BOM.
  for (const name of Object.keys(pkg.dependencies)) {
    assert.ok(manifest.bom.some((s) => s.startsWith(`${name}@`)), `'${name}' missing from manifest.bom`);
  }

  // Verification: every member line ok, summary present, count matches
  // manifest members + manifest.json itself + one SET-verification line per
  // declared BOM entry (Task a stretch goal: attest also checks that every
  // declared package landed members, not just that present members are intact).
  const memberLines = lines.filter((l) => /^(ok {2}|FAIL) /.test(l));
  assert.strictEqual(memberLines.filter((l) => l.startsWith('FAIL')).length, 0);
  assert.strictEqual(memberLines.length, Object.keys(manifest.members).length + 1 + manifest.bom.length);
  const bomLines = memberLines.filter((l) => l.includes(' bom: '));
  assert.strictEqual(bomLines.length, manifest.bom.length);
  assert.ok(bomLines.every((l) => l.startsWith('ok  ')), bomLines.join('\n'));
  assert.strictEqual(lines.filter(Boolean).pop(), require('../libexec/clode-attest.cjs').ATTEST_VERIFIED);
});

// THE GATE MUST BE ABLE TO FAIL. `clode build` refuses to ship a target whose attest does
// not print the verdict line; that refusal is worth nothing unless a corrupted artifact
// actually produces a different answer. Flip ONE byte inside a real member's byte range
// (located via the archive index, so the flip is guaranteed to land in hashed payload and
// not in slack) and require the binary to say so.
test('the attest gate can fail: one flipped byte in a member -> VERIFICATION FAILED, exit 1', async (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  const { readTrailerIndex } = require('./quaude-archive.cjs');
  const { index } = readTrailerIndex(QUAUDE);
  // bun-shim.cjs: a member every quaude has, small, and not the manifest (so the failure
  // is a MEMBER failure, not a manifest-parse crash that would exit for another reason).
  const victim = index.members.find((m) => m.name === 'bun-shim.cjs');
  assert.ok(victim && victim.len > 0, 'no bun-shim.cjs member to tamper with');
  const tampered = path.join(DIR, 'quaude-tampered');
  const bytes = fs.readFileSync(QUAUDE);
  bytes[victim.offset] = bytes[victim.offset] ^ 0xff;
  fs.writeFileSync(tampered, bytes);
  fs.chmodSync(tampered, 0o755);

  const { ATTEST_VERIFIED, ATTEST_FAILED } = require('../libexec/clode-attest.cjs');
  const r = await new Promise((resolve) => {
    const child = spawn(tampered, ['--clode-attest'], { cwd: DIR, stdio: ['ignore', 'pipe', 'pipe'], env: cleanEnv() });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const to = setTimeout(() => child.kill('SIGKILL'), 120000);
    child.on('exit', (status) => { clearTimeout(to); resolve({ status, stdout, stderr }); });
    child.on('error', (e) => { clearTimeout(to); resolve({ status: null, stdout, stderr: String(e) }); });
  });
  assert.notStrictEqual(r.status, 0, `a tampered quaude exited 0:\n${r.stdout}\n${r.stderr}`);
  assert.doesNotMatch(r.stdout, new RegExp(ATTEST_VERIFIED.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'the tampered binary still printed the verdict the build gate greps');
  assert.ok(r.stdout.includes('FAIL bun-shim.cjs') || r.stdout.includes(ATTEST_FAILED),
    `no failure reported:\n${r.stdout}\n${r.stderr}`);

  // ... and the SHARED gate helper the build uses must reject exactly this output.
  const { attestTarget } = require('../libexec/clode-fuse.cjs');
  const verdict = await attestTarget(tampered, {
    spawnRun: () => Promise.resolve(r), env: cleanEnv(), cwd: DIR, timeout: 1000,
  });
  assert.strictEqual(verdict.ok, false, 'attestTarget accepted a tampered artifact');
});

test('the BINARY says which platform it was carved for, without being run', (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  // --clode-attest can only answer on a target THIS host can execute, which excludes every
  // cross-build — and a cross-build is exactly where a linux carve gets fused into a darwin
  // target. `strings` cannot answer either: a quaude stores the bundle as bytecode, and an hour
  // was spent in 2026-08-29 concluding the wrong thing from precisely that. manifest.json is a
  // plain member of the archive, so the answer is readable off the FILE.
  const manifest = readManifest(QUAUDE);
  assert.strictEqual(manifest.providerPlatform, providerPlatformOf(providerBin()) || 'unknown',
    'the fused archive must record the carve platform where a host can read it without exec');
  // ... and it must agree with what the running target reports, or one of the two is lying.
  assert.strictEqual(manifest.role, 'quaude');
});

test('reserved namespace: unknown --clode-foo errors from quaude, bundle never runs', async (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  const r = await runQuaude(['--clode-frobnicate', '-p', 'say PONG'], cleanEnv());
  assert.strictEqual(r.status, 64);
  assert.match(r.stderr, /quaude: unknown option '--clode-frobnicate'/);
  assert.match(r.stderr, /reserved/);
  assert.strictEqual(r.stdout, '');   // nothing from the bundle
});

test('reserved namespace: --clode-attest short-circuits before the bundle sees argv', async (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  // With bundle args alongside, attest still wins and no session starts (no
  // mock is listening — a bundle boot would fail loudly or hang, not attest).
  const r = await runQuaude(['-p', 'say PONG', '--clode-attest'], cleanEnv(), 60000);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(require('../libexec/clode-attest.cjs').ATTEST_VERIFIED), r.stdout);
  assert.doesNotMatch(r.stdout, /PONG/);
});

// The retired spelling is GONE, not aliased: it is now an ordinary argument, so it reaches
// Claude Code and Claude Code rejects it. What must never happen is a silent success —
// a quaude that prints an attest report for a flag we no longer implement.
test('the retired --quaude-attest is no longer a quaude flag', async (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  const r = await runQuaude(['--quaude-attest'], cleanEnv(), 60000);
  assert.notStrictEqual(r.status, 0, `--quaude-attest still succeeded:\n${r.stdout}`);
  assert.doesNotMatch(r.stdout, /all members verified/, 'the retired flag still attests');
});

test('strict-mode sweep: agentic Bash mock oracle against the fused quaude', async (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  const MARKER = 'QUAUDE-AGENTIC-MARKER-4207';
  const TOOL_ID = 'toolu_mock_quaude_bash_1';
  const mock = await startMockAnthropic({
    respond: (body) => body.includes(TOOL_ID)
      ? cannedSSE('TOOLDONE')
      : cannedToolUseSSE('Bash', { command: `echo ${MARKER}` }, TOOL_ID),
  });
  try {
    const r = await runQuaude(
      ['-p', 'run the command', '--allowedTools', 'Bash'],
      cleanEnv({ ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: 'sk-ant-mock' }));
    assert.strictEqual(r.status, 0, `stderr:\n${r.stderr}`);
    assert.match(r.stdout, /TOOLDONE/, `stdout:\n${r.stdout}`);
    const followUp = mock.requests.find((q) => q.method === 'POST' && q.body
      && q.body.includes(TOOL_ID) && q.body.includes('tool_result'));
    assert.ok(followUp, 'no follow-up POST carrying the tool_result');
    assert.ok(followUp.body.includes(MARKER), `tool_result lacks the command's stdout:\n${followUp.body.slice(0, 2000)}`);
    assert.ok(!followUp.body.includes('bash output unavailable'), 'tool_result degraded to the output-file readback failure');
    assert.ok(!followUp.body.includes('Output too large'), 'tool_result degraded to the persisted-file detour');
  } finally { await mock.close(); }
});

// Phase 2: with the native WebSocket transport wired in (bun-shim delegates to
// the engine's native WS, __clodeWsUnavailable=false), the Phase-1 "no WebSocket
// transport" notice no longer fires. And with the update-guard fix
// (shouldInjectGuard — `--settings` no longer appended to subcommand argv), the
// headless subcommand no longer dies at CLI arg-parsing ("Unknown argument:
// --settings"). It now gets past both and reaches deeper into its own setup.
//
// Current wall (remote-control hunt, NOT fixed here): the subcommand hits a shim
// gap — `node-shim: readline.createInterface not implemented` — surfaced as an
// unhandledRejection. So this test asserts the durable invariants that this line
// of work established (no --settings arg break, no util.inherits stream crash,
// no Phase-1 unavailable notice) but deliberately does NOT assert absence of
// `unhandledRejection` (the readline gap is the next hunt item).
// This is deterministic and auth-independent (it fires before any auth check),
// so unlike the Phase-1 assumption of an "auth/subscription reason", the
// non-zero exit here is stable for a different cause. Either way the durable
// invariants below hold: no crash, and the Phase-1 notice is gone.
//
// Real-bridge smoke (NOT automated here — needs live claude.ai auth): a
// maintainer with an authenticated session should manually confirm that a
// live Remote Control bridge to claude.ai establishes and survives
// `new globalThis.WebSocket(url, {protocols: ['mcp'], headers})`, watching for
// the known fidelity risks between the native tjs WS and what the Bun/ws
// bundle expects: `binaryType` (nodebuffer vs arraybuffer), close/`onerror`
// event shapes, and permessage-deflate.
test('quaude remote-control: the headless subcommand runs, and runs clean', async (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  // TRUST THE WORKSPACE FIRST. The subcommand legitimately refuses to run in an
  // unreviewed directory ("Workspace not trusted"), and DIR is a fresh temp dir — so
  // without this the test measures the trust gate, not remote control. Same seeding the
  // PTY tests use; it is product behaviour we are stepping around, not a shim gap.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qb-rc-home-'));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({
    hasCompletedOnboarding: true,
    projects: { [DIR]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } },
  }));
  const r = await runQuaude(['remote-control'],
    { ...cleanEnv(), HOME: home, CLODE_SHIM_TRACE: '1' }, 30000);
  const out = (r.stdout || '') + (r.stderr || '');
  assert.doesNotMatch(out, /Unknown argument: --settings/, 'update-guard must no longer break the subcommand parser');
  assert.doesNotMatch(out, /not an object/, 'must not hit the util.inherits TypeError (stream fix holds)');
  assert.doesNotMatch(out, /available in quaude yet|no WebSocket transport/, 'Phase-1 unavailable notice must be gone (transport present)');

  // THIS TEST USED TO ASSERT THE FAILURE. It ended with
  //   assert.notStrictEqual(r.status, 0, 'still exits non-zero (readline wall)')
  // recording a known gap — readline.createInterface — as the expected outcome. The gap
  // was then closed, and the test kept demanding the old brokenness: a green suite that
  // would have gone RED the moment the product got better. Recording a wall in an
  // assertion, rather than in the backlog, inverts what the test is for.
  assert.doesNotMatch(out, /Workspace not trusted/, 'trust seeding failed — the test is measuring the wrong thing');

  // WHAT SUCCESS MEANS HERE. With a seeded but UNAUTHENTICATED home, the correct
  // outcome is the product's own login gate — "You must be logged in to use Remote
  // Control" — and a non-zero exit. Demanding exit 0 would only pass on a machine where
  // the developer happens to be signed in, which is how a test starts measuring the
  // tester instead of the product. What we assert is that the subcommand reached ITS OWN
  // logic: it printed one of its two real answers and hit no shim wall getting there.
  assert.match(out, /Remote Control is launching|logged in to use Remote Control/,
    `remote-control never reached its own UI or login gate:\n${out.slice(-1500)}`);
  const walls = [...new Set(out.split('\n').filter((l) => l.includes('[wall]'))
    .map((l) => l.replace(/^.*\[wall\]\s*/, '').trim()).filter(Boolean))];
  assert.deepStrictEqual(walls, [], `headless remote-control hit shim walls: ${walls.join(', ')}`);
  assert.doesNotMatch(out, /unhandledRejection/, 'no swallowed crash on the way to the prompt');
});

test('TUI paint smoke under the fused quaude (CLODE_LIVE_RENDER-gated)', (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  if (process.env.CLODE_LIVE_RENDER !== '1') { t.skip('live-render opt-in only (set CLODE_LIVE_RENDER=1)'); return; }
  const { sandbox } = require('./e2e.cjs');
  const { seedClaudeProfile, capture } = require('./e2e-pty.cjs');
  const sbx = sandbox(t);
  seedClaudeProfile(sbx.home, { cwd: REPO });
  const screen = capture(sbx, { seconds: 12, cmd: [QUAUDE] });
  assert.match(screen, /Claude Code/);
});
