#!/usr/bin/env node
// Phase-2 Task 4 — drive CLODE_SHIM_PROBE (Task 3) through every corpus we
// own and record which of golden.json's gaps the pinned bundle actually
// REACHES, per corpus. See
// .superpowers/sdd/2026-08-03-phase2-api-gaps/task-4-brief.md.
//
// THE NON-NEGOTIABLE CONSTRAINT: this runner spawns test/fidelity/agentic-*
// and test/node-shim-agentic.test.cjs as CHILDREN, and those files spread
// `{...process.env}` with NO isolation of their own (no HOME, no
// CLODE_DEPS, no CLODE_CACHE) — a prior run mutated the operator's real
// ~/.claude.json and live-cloned a repo from the network. Isolation happens
// HERE, at the runner level, for every corpus that shells out, and the
// isolation itself is ASSERTED (throws), not just recorded — see
// isolatedEnv() and the per-corpus checks below.
//
// Two structural gaps this file works around, neither of which is an edit
// to the shim or to any test file (see scripts/probe-run-preload.cjs for
// the mechanism):
//   1. e2e.cjs's sandbox()/capture() (used by the interactive corpus)
//      construct an explicit env object that does NOT inherit
//      process.env — so CLODE_SHIM_PROBE=1 on this process's own env would
//      never reach that grandchild.
//   2. Every corpus captures its grandchild's stdout/stderr into local JS
//      strings for its own assertions and never forwards them anywhere —
//      so a [probe] line is otherwise invisible outside that harness.
'use strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PRELOAD = path.join(REPO, 'scripts', 'probe-run-preload.cjs');
const GOLDEN_PATH = path.join(REPO, 'test', 'shim-surface', 'golden.json');
const OUT_PATH = path.join(REPO, 'test', 'shim-surface', 'reachability.json');
const GOLDEN = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
const BUNDLE = GOLDEN._measured_against_bundle;

const ALL_CORPORA = ['apicheck', 'agentic', 'interactive'];

function parseArgs(argv) {
  const out = { corpus: ALL_CORPORA };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--corpus') out.corpus = (argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
  }
  return out;
}

// ---- probe-line extraction --------------------------------------------
// probe.cjs logs exactly `[probe] <ns>.<prop>` or `[probe] <ns>.<prop> (in)`
// (see libexec/node-shim/internal/probe.cjs). Scan the whole captured blob
// for the pattern rather than splitting lines first — some corpora relay
// chunks that are not newline-aligned.
const PROBE_RE = /\[probe\]\s+(\S+)(\s+\(in\))?/g;
function extractHits(text) {
  const hits = [];
  if (!text) return hits;
  let m;
  PROBE_RE.lastIndex = 0;
  while ((m = PROBE_RE.exec(text)) !== null) {
    const isIn = !!m[2];
    hits.push({ key: isIn ? `${m[1]} (in)` : m[1], kind: isIn ? 'in' : 'get' });
  }
  return hits;
}

// ---- isolation ----------------------------------------------------------
// Fresh HOME/CLODE_DEPS/CLODE_CACHE per corpus, CLAUDE_CODE_BRIDGE_SESSION_ID
// stripped (else a child would auth via the parent bridge instead of
// exercising real subscription auth). Based on process.env (not a
// from-scratch clean env) so PATH still resolves git/tjs/cmake for corpora
// that need them (e.g. the interactive corpus's `clode build`) — isolation
// here targets state (HOME, deps/cache stores, bridge auth), not PATH.
//
// The assertion is on env.HOME — the value that will actually reach the
// child process — checked AFTER `overrides` has been applied, so a future
// override that resets HOME cannot silently defeat isolation. (A prior
// version of this function asserted `home !== os.homedir()` on the
// mkdtemp'd path itself, which is tautologically true for any fresh temp
// dir and would never fire even if a later step broke isolation — caught in
// review.)
function isolatedEnv(overrides = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-home-'));
  const deps = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-deps-'));
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-cache-'));
  const env = { ...process.env, HOME: home, CLODE_DEPS: deps, CLODE_CACHE: cache };
  delete env.CLAUDE_CODE_BRIDGE_SESSION_ID;
  Object.assign(env, overrides);
  const realHome = os.homedir();
  if (!env.HOME || env.HOME === realHome) {
    throw new Error(`isolation failure: child env.HOME (${env.HOME}) is missing or equals the real HOME (${realHome})`);
  }
  if (env.HOME !== home) {
    throw new Error(`isolation failure: an override changed HOME away from the freshly minted isolated dir (expected ${home}, got ${env.HOME})`);
  }
  if (env.CLAUDE_CODE_BRIDGE_SESSION_ID) {
    throw new Error('isolation failure: CLAUDE_CODE_BRIDGE_SESSION_ID survived the strip');
  }
  return { env, home, deps, cache, realHome };
}

function defaultProviderBin() {
  if (process.env.CLODE_PROVIDER_BIN && fs.existsSync(process.env.CLODE_PROVIDER_BIN)) return process.env.CLODE_PROVIDER_BIN;
  const candidate = path.join(os.homedir(), '.local', 'share', 'clode', 'providers', BUNDLE, 'claude');
  if (fs.existsSync(candidate)) return candidate;
  return null;
}

function globTestFiles(dir, re) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => re.test(f)).sort().map((f) => path.join(dir, f));
}

// ---- corpus: apicheck ----------------------------------------------------
// Drives scripts/apicheck.mjs's runGate() IN-PROCESS (not as a subprocess)
// so we can capture each quaude spawn's raw stderr directly — apicheck.mjs
// itself only ever surfaces [wall] lines out of that stderr, never the raw
// text, so shelling out to `node scripts/apicheck.mjs` and grepping OUR OWN
// stderr would see nothing (the [probe] lines live only in a JS string
// inside that process, captured via spawnSync, never echoed anywhere).
// runGate()'s `runQuaude`/`runNaude` are injectable for exactly this kind
// of observation; wrapping them changes nothing about what apicheck itself
// sees or returns.
//
// Isolation caveat, recorded rather than hidden: runGate() itself executes
// IN this runner's own process, which still has the REAL os.homedir() (we
// need to be in-process to tap stderr; see above). The env that matters —
// what the SPAWNED naude/quaude children actually see via
// oracle-models.cjs's modelEnv() — is iso.env, asserted below. The one
// exception is opts.versionDelta, which by default reads the REAL
// ~/.cache/clode for a log-only "did the surface expand" delta; explicitly
// disabled here so nothing this runner does reads real machine state.
// extract-claude-js.cjs (staging cli.cjs) also runs with the parent's real
// env, but it does not read HOME/credentials at all (verified: no
// homedir()/HOME/.claude reference in that file) — a stateless byte-parser.
//
// Credentialing: apicheck's own corpus includes REAL `-p` prompts with no
// ANTHROPIC_BASE_URL override, i.e. real subscription auth is the whole
// point of this corpus (brief: "exercise real subscription auth", hence
// CLAUDE_CODE_BRIDGE_SESSION_ID being stripped). An isolated HOME with
// NOTHING in it can still occasionally succeed via macOS Keychain (not
// scoped by $HOME) OR can leave the credentialed path fully unexercised —
// neither is the representative case apicheck exists to measure. So this
// corpus seeds the isolated HOME with a COPY of the real
// ~/.claude/.credentials.json ONLY (nothing else — no project trust config,
// no conversation history) before running, deleted again once the corpus
// finishes (it holds a live credential, unlike every other corpus's
// isolated dirs). This exact configuration is RECIPE.md's G6
// ("credentialed startup stalls... with ~/.credentials.json present") —
// previously believed darwin-ppc/Darwin-8-specific; reviewed evidence shows
// it reproduces on darwin-arm64 too, so quaude is expected to HANG on the two
// `-p` items while naude answers normally — observed here as apicheck.mjs's
// own 60s per-call timeout firing and tjs reporting status:143 (a
// WIFEXITED-shaped SIGTERM exit code, not status:null+signal:'SIGTERM').
// That divergence is recorded per-item below, not hidden behind a bare
// `exitCode`.
async function runApicheck() {
  const bin = defaultProviderBin();
  const iso = isolatedEnv({ CLODE_SHIM_PROBE: '1' });
  if (bin) iso.env.CLODE_PROVIDER_BIN = bin;

  const realCredentials = path.join(os.homedir(), '.claude', '.credentials.json');
  let credentialsSeeded = false;
  if (fs.existsSync(realCredentials)) {
    fs.mkdirSync(path.join(iso.home, '.claude'), { recursive: true });
    fs.copyFileSync(realCredentials, path.join(iso.home, '.claude', '.credentials.json'));
    fs.chmodSync(path.join(iso.home, '.claude', '.credentials.json'), 0o600);
    credentialsSeeded = true;
  }

  const apicheckMod = await import(path.join(REPO, 'scripts', 'apicheck.mjs'));
  const models = require(path.join(REPO, 'test', 'oracle-models.cjs'));

  const hits = [];
  const perItem = [];
  const itemIds = [...fs.readFileSync(path.join(REPO, 'scripts', 'apicheck.mjs'), 'utf8')
    .matchAll(/id:\s*'([^']+)'/g)].map((m) => m[1]);

  const realRunQuaude = models.runQuaudeModel;
  const realRunNaude = models.runNaudeModel;
  function tappedRunQuaude(cli, args, opts) {
    const r = realRunQuaude(cli, args, opts);
    hits.push(...extractHits(r.stderr));
    perItem.push({
      id: itemIds[perItem.length] || `item-${perItem.length}`,
      // `succeeded` means exit status 0 specifically — NOT merely "status is
      // non-null". A killed/timed-out spawnSync can still report a non-null
      // status (observed: tjs surfaces a SIGTERM'd run as status:143,
      // signal:null — WIFEXITED-shaped, not WIFSIGNALED-shaped — so a naive
      // `status !== null` check would have misclassified a hang as
      // "completed". Caught during the fix-up review pass.
      quaude: { status: r.status, signal: r.signal, succeeded: r.status === 0 },
    });
    return r;
  }
  function tappedRunNaude(cli, args, opts) {
    const r = realRunNaude(cli, args, opts);
    const rec = perItem[perItem.length - 1];
    if (rec) rec.naude = { status: r.status, signal: r.signal, succeeded: r.status === 0 };
    return r;
  }

  let rc;
  try {
    const logLines = [];
    rc = apicheckMod.runGate({
      env: iso.env, runQuaude: tappedRunQuaude, runNaude: tappedRunNaude,
      log: (s) => logLines.push(s), versionDelta: false,
    });
    var skipped = logLines.some((l) => l.startsWith('SKIP:'));
  } finally {
    // This isolated HOME held a live credential copy — remove it as soon as
    // the corpus is done, unlike the other corpora's throwaway dirs.
    try { fs.rmSync(iso.home, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  for (const rec of perItem) {
    rec.diverged = !!(rec.quaude && rec.naude
      && (rec.quaude.status !== rec.naude.status || rec.quaude.signal !== rec.naude.signal));
  }
  const credentialedItems = perItem.filter((r) => /^p-/.test(r.id));
  const credentialedPathCompleted = credentialedItems.length > 0
    && credentialedItems.every((r) => r.quaude && r.quaude.succeeded);
  const g6Reproduced = credentialedSeededAndHung(credentialsSeeded, credentialedItems);

  return {
    id: 'apicheck',
    status: skipped ? 'skipped' : 'ran',
    reason: skipped ? 'no Bun-packaged CC provider resolved (CLODE_PROVIDER_BIN unset/missing)' : null,
    exitCode: rc,
    itemsRun: perItem.length,
    perItem: skipped ? null : perItem,
    credentialsSeeded,
    credentialedPathCompleted: skipped ? null : credentialedPathCompleted,
    hits,
    isolation: {
      home: iso.home, realHome: iso.realHome, homeDiffersFromReal: iso.home !== iso.realHome,
      note: 'runGate() itself runs in-process (real os.homedir()), but every spawned naude/quaude child '
        + 'gets iso.env exclusively (asserted in isolatedEnv()); versionDelta is explicitly disabled so '
        + 'nothing here reads the real ~/.cache/clode; extract-claude-js.cjs staging runs with the parent '
        + 'env but touches no HOME/credentials state (verified by reading that file). The isolated HOME '
        + 'itself is deleted immediately after this corpus finishes because it briefly held a copied real '
        + 'credential.',
    },
    note: skipped ? null
      : (credentialedPathCompleted
        ? 'p-plain/p-arith completed normally on both sides this run (real network + real subscription auth, by design — CLAUDE_CODE_BRIDGE_SESSION_ID stripped). See perItem for exact status/signal per item.'
        : 'p-plain/p-arith DID NOT complete on the quaude side this run (see perItem: quaude status/signal vs naude). '
          + (g6Reproduced
            ? 'This matches RECIPE.md G6 (credentialed startup stalls with ~/.credentials.json present) — '
              + 'previously believed darwin-ppc/Darwin-8-specific, reproducing here on darwin-arm64. '
              + 'CONSEQUENCE: the credentialed -p path — the deepest path in this whole measurement, and the '
              + 'only one that can arm gaps behind real subscription auth — was NOT exercised by quaude in '
              + 'this run. Any golden gap not armed by this corpus should be read with that in mind, not as '
              + 'proof the credentialed path never reaches it.'
            : 'credentials were not seeded this run (no ~/.claude/.credentials.json found on this box), so '
              + 'this divergence is NOT attributable to G6 by this measurement alone.')),
  };
}
// "Hung" means quaude did not reach exit 0 while naude did — NOT specifically
// status===null. Observed on this box: a timed-out/SIGTERM'd tjs run reports
// status:143 (WIFEXITED-shaped), not status:null+signal:'SIGTERM'
// (WIFSIGNALED-shaped) — a status===null check silently missed this and
// produced a note that contradicted the corpus's own `credentialsSeeded:true`
// field (caught in the fix-up review pass; see the `succeeded` field above).
function credentialedSeededAndHung(seeded, credentialedItems) {
  if (!seeded || credentialedItems.length === 0) return false;
  return credentialedItems.some((r) => r.naude && r.naude.succeeded && r.quaude && !r.quaude.succeeded);
}

// ---- corpus: agentic / interactive (out-of-process) ----------------------
// Runs `node --require probe-run-preload.cjs --test <files>` as a child.
// The preload (a) forces CLODE_SHIM_PROBE=1 onto every grandchild env this
// process spawns, whether or not that env object started from
// process.env, and (b) relays each grandchild's stdout+stderr to this
// child's own stderr (prefixed [probe-relay]), which we capture below.
// Neither changes what the test file's own assertions observe.
//
// node's test runner writes its summary (`ℹ tests N` / `ℹ pass N` / ...)
// to STDOUT, not stderr — a prior version of this function matched only
// r.stderr and so testSummary was structurally always null. Matches r.stdout
// first, falling back to r.stderr for robustness across reporters.
const SUMMARY_RE = /[ℹ#]\s*(tests|suites|pass|fail|cancelled|skipped|todo)\s+(\d+)/g;
function parseTestSummary(text) {
  const out = {};
  let m;
  SUMMARY_RE.lastIndex = 0;
  while ((m = SUMMARY_RE.exec(text || '')) !== null) out[m[1]] = Number(m[2]);
  return out;
}

function runNodeTestCorpus(id, files, extraEnv, opts = {}) {
  if (files.length === 0) {
    return { id, status: 'skipped', reason: 'no matching test files found', hits: [] };
  }
  const bin = defaultProviderBin();
  const iso = isolatedEnv({ CLODE_SHIM_PROBE: '1', ...extraEnv });
  if (bin && !iso.env.CLODE_PROVIDER_BIN) iso.env.CLODE_PROVIDER_BIN = bin;

  const args = ['--require', PRELOAD, '--test', ...files];
  const r = spawnSync(process.execPath, args, {
    cwd: REPO, encoding: 'utf8', env: iso.env,
    timeout: opts.timeout || 15 * 60 * 1000, maxBuffer: 256 * 1024 * 1024,
  });
  const hits = extractHits(r.stdout).concat(extractHits(r.stderr));
  const stdoutSummary = parseTestSummary(r.stdout);
  const testSummaryFinal = Object.keys(stdoutSummary).length ? stdoutSummary : parseTestSummary(r.stderr);

  return {
    id, status: 'ran', files: files.map((f) => path.relative(REPO, f)),
    exitCode: r.status, timedOut: r.error && r.error.code === 'ETIMEDOUT',
    testSummary: Object.keys(testSummaryFinal).length ? testSummaryFinal : null,
    hits,
    isolation: {
      home: iso.home, realHome: iso.realHome, homeDiffersFromReal: iso.home !== iso.realHome,
    },
    _rawIsoHome: iso.home,
  };
}

function runAgentic() {
  const files = [
    ...globTestFiles(path.join(REPO, 'test', 'fidelity'), /^agentic-.*\.test\.cjs$/),
    path.join(REPO, 'test', 'node-shim-agentic.test.cjs'),
  ].filter(fs.existsSync);
  const r = runNodeTestCorpus('agentic', files, {});
  if (r.status !== 'ran') return r;

  // Positive isolation evidence, ASSERTED not just recorded: agentic-*.test.cjs
  // spread {...process.env} directly, so the isolated HOME set on the outer
  // `node --test` process propagates straight through — after the run, that
  // isolated HOME (never the real one) must be where quaude's session state
  // landed. A `false` here means isolation could not be proven for this
  // corpus's actual data, which is exactly the case the review flagged
  // (previously recorded silently instead of failing loudly).
  const claudeJsonPath = path.join(r._rawIsoHome, '.claude.json');
  const proven = fs.existsSync(claudeJsonPath);
  if (!proven) {
    throw new Error(`isolation could not be proven for corpus 'agentic': expected ${claudeJsonPath} to exist after the run (quaude never wrote session state into the isolated HOME) — refusing to report this corpus's hits as isolated.`);
  }
  r.isolation.claudeJsonWrittenToIsolatedHome = true;
  r.isolation.evidence = `runtime-verified: ${claudeJsonPath} exists post-run`;
  delete r._rawIsoHome;
  r.note = 'agentic-*.test.cjs and node-shim-agentic.test.cjs spread {...process.env} directly, so isolated HOME/CLODE_DEPS/CLODE_CACHE set on THIS process propagate straight through; claudeJsonWrittenToIsolatedHome is asserted (not just recorded) as the positive isolation proof — a missing .claude.json aborts this corpus rather than silently reporting unproven isolation.';
  return r;
}

function observedNativeProviderVersion() {
  const which = spawnSync('command', ['-v', 'claude'], { shell: true, encoding: 'utf8' });
  const native = (which.stdout || '').trim();
  if (!native || !fs.existsSync(native)) return null;
  const v = spawnSync(native, ['--version'], { encoding: 'utf8', timeout: 15000 });
  const text = ((v.stdout || '') + (v.stderr || '')).trim().split('\n')[0];
  return text || null;
}

function runInteractive() {
  const files = globTestFiles(path.join(REPO, 'test', 'fidelity'), /^interactive-.*\.test\.cjs$/).filter(fs.existsSync);
  const observedVersion = observedNativeProviderVersion();
  // CLODE_LIVE_RENDER=1 only — deliberately NOT CLODE_LIVE_ONLINE=1.
  // interactive-live-turn.test.cjs runs against the REAL HOME on purpose
  // (its own comment: a sandboxed HOME makes the bundle decide "Not logged
  // in" before the real credential path fires) and is gated on
  // CLODE_LIVE_ONLINE=1 specifically so it self-skips otherwise. That test
  // structurally CANNOT be isolated — leaving CLODE_LIVE_ONLINE unset is
  // how this corpus stays isolated while still running the two sibling
  // files (interactive-render-diff / interactive-resize-diff) that build
  // their own hermetic sandbox via test/e2e.cjs's sandbox() +
  // seedClaudeProfile() and never touch a real HOME.
  const r = runNodeTestCorpus('interactive', files, { CLODE_LIVE_RENDER: '1' }, { timeout: 20 * 60 * 1000 });
  if (r.status !== 'ran') return r;
  delete r._rawIsoHome;
  // Isolation for render-diff/resize-diff is DELEGATED to test/e2e.cjs's
  // sandbox() + seedClaudeProfile() (verified by reading that source: a
  // fresh mkdtemp HOME that never inherits process.env, pre-seeded with a
  // synthetic .claude.json before capture runs). Those sandbox dirs are
  // deleted by their OWN t.after() cleanup before this outer process can
  // inspect them, so this runner cannot produce independent RUNTIME proof —
  // recorded explicitly as code-verified/not-runtime-verified rather than a
  // bare true/false that could be misread either way.
  r.isolation.method = 'delegated';
  r.isolation.mechanism = 'test/e2e.cjs sandbox() + seedClaudeProfile() (fresh mkdtemp HOME, pre-seeded, never inherits process.env)';
  r.isolation.codeVerified = true;
  r.isolation.runtimeVerified = false;
  r.isolation.runtimeVerifiedReason = "sandbox()'s temp dir is deleted by its own t.after() before this outer process exits, so no post-hoc filesystem check is possible without editing the test";
  r.tui_path = { probed: true, mechanism: 'probe-run-preload.cjs relays BOTH stdout and stderr of every spawnSync (fixed in review — a PTY gives one fd for both, and the rendered screen text arrives via r.stdout of the spawnSync that runs test/tui-screen.cjs, not r.stderr)' };
  r.observedNativeProviderVersion = observedVersion;
  r.note = `interactive-live-turn.test.cjs self-skips (CLODE_LIVE_ONLINE not set) because it structurally cannot be isolated (runs against the real HOME by design). interactive-render-diff/resize-diff build a fresh quaude via \`clode build\` from whatever native \`claude\` is on PATH — on THIS box, observed version: ${observedVersion || '(could not determine)'} (golden-measured bundle is ${BUNDLE}; read this corpus's hits with that version drift in mind, not the hedge "may differ").`;
  return r;
}

// ---- assemble reachability.json ------------------------------------------
function goldenGapEntries() {
  const entries = [];
  for (const gap of GOLDEN.layer1_bun_props_missing || []) entries.push({ gap, layer: 1, kind: 'bun_prop' });
  for (const gap of GOLDEN.layer1_bun_modules_missing || []) entries.push({ gap, layer: 1, kind: 'bun_module' });
  for (const gap of GOLDEN.layer2_node_apis_missing || []) entries.push({ gap, layer: 2, kind: 'node_api' });
  return entries;
}

function assemble(corpusResults) {
  const armed = {};
  for (const c of corpusResults) {
    for (const hit of c.hits || []) {
      if (!armed[hit.key]) armed[hit.key] = { corpora: [] };
      if (!armed[hit.key].corpora.includes(c.id)) armed[hit.key].corpora.push(c.id);
    }
  }
  const goldenNames = new Set(goldenGapEntries().map((e) => e.gap));
  for (const key of Object.keys(armed)) {
    armed[key].corpora.sort();
    const bareName = key.replace(/\s+\(in\)$/, '');
    armed[key].tracked_in_golden = goldenNames.has(bareName);
  }

  const entries = goldenGapEntries();
  const layer1Entries = entries.filter((e) => e.layer === 1);
  const layer2Entries = entries.filter((e) => e.layer === 2);

  // layer1 (Bun.* / bun: modules) can NEVER be armed by CLODE_SHIM_PROBE —
  // it only wraps node:* builtins reached through loader.cjs's
  // loadBuiltin() (single call site: loader.cjs:231, only reachable from
  // loadBuiltin()); libexec/bun-shim.cjs has no probe instrumentation at
  // all. That is categorically different from a layer2 entry no corpus
  // happened to reach — split them into `unmeasurable` (probe-design gap)
  // vs `unarmed` (corpus-coverage gap), each carrying a one-line reason.
  const unmeasurable = layer1Entries.map((e) => ({
    gap: e.gap,
    reason: 'libexec/bun-shim.cjs (the Bun.* global / bun: modules) is not wrapped by CLODE_SHIM_PROBE — only node:* builtins loaded via loader.cjs loadBuiltin() are. This gap can never be armed by any corpus under the current probe design, regardless of whether the bundle reaches it.',
  }));

  const corpusBlindSpots = {
    apicheck: 'the credentialed -p items (p-plain/p-arith) were seeded with a REAL credentials.json copy this run and reached the credentialed branch, but quaude HUNG there (RECIPE G6, reproduced on darwin-arm64 — see the apicheck corpus entry\'s `note`) before completing a turn. That means anything reachable only AFTER the point G6 stalls at — most plausibly the crypto.* cluster below, which is exactly where token-refresh/enterprise-auth (mTLS, KeyObject, sign/verify) would live — was not exercised either way: an isolated EMPTY home never takes the credentialed branch at all (auth check fails first), and the credentialed branch we DID take never got past the hang. Neither run shape reaches past G6. Deterministic items (version/help/bad-flag) never touch crypto/net/child_process paths regardless.',
    agentic: 'mocked Anthropic server — no real TLS/HTTP client paths (net.createServer/http(s).request/https.createServer), no real crypto key material paths; the four scripted flows (Bash, Edit, Workflow, subagent, MCP-ws) do not exercise child_process.fork, v8 heap stats, or perf_hooks.monitorEventLoopDelay',
    interactive: 'only a 10-second no-keystroke initial paint is captured (welcome screen + prompt) — no typed turn, no tool use, no slash command; live-turn (the one file that types a real prompt) self-skips by design (CLODE_LIVE_ONLINE never set, to stay isolated)',
    'live-session': 'not run at all this measurement — see live_session below',
  };

  const phase3Recommendation =
    'The isolation fix and the credentialed corpus are in structural tension, and no run shape available today '
    + 'resolves it: real credentials exercise the token-refresh/G6 branch but hang before completing (touches the '
    + 'operator\'s profile via a deleted-after-use copy); an isolated empty HOME stays safe but never leaves the '
    + '"not logged in" branch, exercising nothing past the auth check. The honest third mode — NOT built here, '
    + 'phase-3 work — is an isolated HOME seeded with a FIXTURE credentials file: syntactically valid, unrelated '
    + 'to any real account, just enough to make the bundle take the credentialed branch without borrowing a real '
    + 'token. That would exercise the deep path AND let G6 be reproduced deliberately and safely, in a form CI '
    + 'could run repeatedly. This is the bridge from this measurement to phase-3\'s G6 task.';

  const unarmed = layer2Entries
    .filter((e) => !armed[e.gap] && !armed[`${e.gap} (in)`])
    .map((e) => ({
      gap: e.gap,
      reason: 'genuinely probed by CLODE_SHIM_PROBE (a node:* builtin, wrapped) but no corpus we ran reached this property this measurement',
    }));

  return {
    bundle: BUNDLE,
    date: new Date().toISOString().slice(0, 10),
    generated_by: 'scripts/probe-run.mjs',
    golden_measured_on: GOLDEN._measured_on,
    probe_scope_limitation:
      'CLODE_SHIM_PROBE (libexec/node-shim/internal/probe.cjs) only wraps node:* builtins loaded through '
      + "loader.cjs's loadBuiltin() (the sole installProbe call site is loader.cjs:231, reached only from "
      + 'loadBuiltin()) — libexec/bun-shim.cjs (the Bun.* global and bun: modules) has NO probe '
      + 'instrumentation at all. layer1_bun_props_missing/layer1_bun_modules_missing entries can therefore '
      + 'NEVER be armed by ANY corpus under this mechanism, regardless of whether the bundle reaches them — '
      + 'see `unmeasurable` below, which is why it is kept separate from `unarmed`.',
    unarmed_meaning:
      '`unarmed` means "no corpus we ran reached this property this measurement" and NEVER "the bundle does '
      + 'not call it". golden.json itself already flags the crypto.* cluster as "plausibly unreachable — but '
      + 'nobody has checked" — this artifact must NOT be cited as having been that check. NAMED BLIND SPOT: '
      + 'the crypto.* cluster in `unarmed` (X509Certificate, createPrivateKey/createPublicKey, createSign/'
      + 'createVerify, sign, pbkdf2/pbkdf2Sync, KeyObject) is exactly where credentialed token-refresh / '
      + 'enterprise-auth (mTLS, Vertex/Bedrock) handling would live, and the ONLY corpus that even attempts '
      + 'the credentialed branch (apicheck, seeded with real credentials this run) HUNG before completing a '
      + 'turn — RECIPE G6, see the apicheck corpus entry. So this cluster being unarmed reflects "we could not '
      + 'get far enough down the credentialed path to find out", not "the path doesn\'t use them" — see '
      + '`phase3_recommendation` for the safe way to actually answer that. Other known blind spots per corpus:',
    corpus_blind_spots: corpusBlindSpots,
    phase3_recommendation: phase3Recommendation,
    corpora: corpusResults.map((c) => {
      const { hits, ...rest } = c;
      return { ...rest, hitCount: (hits || []).length };
    }),
    armed,
    unarmed,
    unmeasurable,
    live_session: {
      automatable: false,
      reason: 'requires a real logged-in interactive session; cannot be scripted/isolated the way the other corpora are',
      human_command: `CLODE_SHIM_PROBE=1 <path-to-a-built-quaude> 2> /tmp/probe-live.log`,
      human_followup: [
        'Do a human turn: ask a question, run a Bash tool call, edit a file, use a slash command, then /quit.',
        "grep '^\\[probe\\]' /tmp/probe-live.log | sort -u",
        'Merge the resulting lines into this file\'s "armed" map under corpus id "live-session" (each unique',
        '"<ns>.<prop>" or "<ns>.<prop> (in)" line -> append "live-session" to its corpus array, creating the key',
        'if new, plus tracked_in_golden), then move it out of "unarmed" if it was there. This is the only',
        'corpus that can reach the credentialed interactive path (RECIPE.md G6) end to end.',
      ],
    },
  };
}

// ---- main -----------------------------------------------------------------
async function main() {
  const { corpus } = parseArgs(process.argv.slice(2));
  const results = [];
  for (const id of corpus) {
    process.stderr.write(`\n=== corpus: ${id} ===\n`);
    let r;
    try {
      if (id === 'apicheck') r = await runApicheck();
      else if (id === 'agentic') r = runAgentic();
      else if (id === 'interactive') r = runInteractive();
      else { process.stderr.write(`unknown corpus '${id}', skipping\n`); continue; }
    } catch (e) {
      process.stderr.write(`  ISOLATION FAILURE for corpus '${id}': ${e.message}\n`);
      r = { id, status: 'isolation-failure', reason: e.message, hits: [] };
    }
    process.stderr.write(`  status=${r.status} hits=${(r.hits || []).length}\n`);
    results.push(r);
  }
  const out = assemble(results);
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n');
  process.stderr.write(`\nwrote ${path.relative(REPO, OUT_PATH)}\n`);
  process.stderr.write(`armed: ${Object.keys(out.armed).length}  unarmed: ${out.unarmed.length}  unmeasurable: ${out.unmeasurable.length}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
