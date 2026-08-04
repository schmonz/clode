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
// HERE, at the runner level, for every corpus that shells out.
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
function isolatedEnv(overrides = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-home-'));
  const deps = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-deps-'));
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-cache-'));
  const env = { ...process.env, HOME: home, CLODE_DEPS: deps, CLODE_CACHE: cache };
  delete env.CLAUDE_CODE_BRIDGE_SESSION_ID;
  Object.assign(env, overrides);
  // Positive isolation evidence #1: the child's HOME is provably not the
  // real HOME (not a structural given — assert it so a future refactor that
  // accidentally drops the override fails loudly here, not silently).
  const realHome = os.homedir();
  if (home === realHome) throw new Error('isolation failure: isolated HOME equals the real HOME');
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
// runGate()'s `runQuaude` is injectable for exactly this kind of
// observation; wrapping it changes nothing about what apicheck itself sees
// or returns.
async function runApicheck() {
  const bin = defaultProviderBin();
  const iso = isolatedEnv({ CLODE_SHIM_PROBE: '1' });
  if (bin) iso.env.CLODE_PROVIDER_BIN = bin;

  const apicheckMod = await import(path.join(REPO, 'scripts', 'apicheck.mjs'));
  const models = require(path.join(REPO, 'test', 'oracle-models.cjs'));

  const hits = [];
  const perItemStderr = [];
  const realRunQuaude = models.runQuaudeModel;
  function tappedRunQuaude(cli, args, opts) {
    const r = realRunQuaude(cli, args, opts);
    perItemStderr.push(r.stderr || '');
    hits.push(...extractHits(r.stderr));
    return r;
  }
  const logLines = [];
  const rc = apicheckMod.runGate({ env: iso.env, runQuaude: tappedRunQuaude, log: (s) => logLines.push(s) });
  const skipped = logLines.some((l) => l.startsWith('SKIP:'));

  return {
    id: 'apicheck',
    status: skipped ? 'skipped' : 'ran',
    reason: skipped ? 'no Bun-packaged CC provider resolved (CLODE_PROVIDER_BIN unset/missing)' : null,
    exitCode: rc,
    itemsRun: perItemStderr.length,
    hits,
    isolation: { home: iso.home, realHome: iso.realHome, homeDiffersFromReal: iso.home !== iso.realHome },
    note: skipped ? null
      : 'p-plain/p-arith items in apicheck\'s corpus make REAL network calls with REAL subscription auth (no ANTHROPIC_BASE_URL override in apicheck.mjs) — by design, per task brief (CLAUDE_CODE_BRIDGE_SESSION_ID stripped specifically so this exercises real auth, not the bridge). HOME/CLODE_DEPS/CLODE_CACHE are isolated; Keychain-backed credential lookup is NOT scoped by HOME and may still succeed against the operator\'s real account.',
  };
}

// ---- corpus: agentic / interactive (out-of-process) ----------------------
// Runs `node --require probe-run-preload.cjs --test <files>` as a child.
// The preload (a) forces CLODE_SHIM_PROBE=1 onto every grandchild env this
// process spawns, whether or not that env object started from
// process.env, and (b) relays each grandchild's stderr to this child's own
// stderr (prefixed [probe-relay]), which we capture below. Neither changes
// what the test file's own assertions observe.
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
  const summary = (r.stderr || '').match(/ℹ (tests|pass|fail|skipped) (\d+)/g) || [];

  // Positive isolation evidence #2: after the run, the ISOLATED home (not
  // the real one) is where state landed. Only meaningful for corpora whose
  // children actually inherit this process's HOME via `...process.env`
  // (agentic); the interactive corpus's render/resize tests build their OWN
  // nested sandbox via test/e2e.cjs's sandbox() + seedClaudeProfile() and
  // never touch this outer HOME at all (verified by reading that code, not
  // assumed) — recorded as `writesIntoIsolatedHome:null` there rather than
  // false, so it isn't misread as an isolation failure.
  const claudeJsonInIsoHome = fs.existsSync(path.join(iso.home, '.claude.json'));

  return {
    id, status: 'ran', files: files.map((f) => path.relative(REPO, f)),
    exitCode: r.status, timedOut: r.error && r.error.code === 'ETIMEDOUT',
    testSummary: summary.join(', ') || null,
    hits,
    isolation: {
      home: iso.home, realHome: iso.realHome, homeDiffersFromReal: iso.home !== iso.realHome,
      claudeJsonWrittenToIsolatedHome: claudeJsonInIsoHome,
    },
  };
}

function runAgentic() {
  const files = [
    ...globTestFiles(path.join(REPO, 'test', 'fidelity'), /^agentic-.*\.test\.cjs$/),
    path.join(REPO, 'test', 'node-shim-agentic.test.cjs'),
  ].filter(fs.existsSync);
  const r = runNodeTestCorpus('agentic', files, {});
  r.note = 'agentic-*.test.cjs and node-shim-agentic.test.cjs spread {...process.env} directly, so isolated HOME/CLODE_DEPS/CLODE_CACHE set on THIS process propagate straight through; claudeJsonWrittenToIsolatedHome is the positive isolation proof.';
  return r;
}

function runInteractive() {
  const files = globTestFiles(path.join(REPO, 'test', 'fidelity'), /^interactive-.*\.test\.cjs$/).filter(fs.existsSync);
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
  r.isolation.claudeJsonWrittenToIsolatedHome = null; // not applicable — see runNodeTestCorpus comment
  r.note = 'interactive-live-turn.test.cjs self-skips (CLODE_LIVE_ONLINE not set) because it structurally cannot be isolated (runs against the real HOME by design). interactive-render-diff/resize-diff build a fresh quaude via `clode build` from whatever native `claude` is on PATH — on THIS box that is a real installed provider, version may differ from the golden-measured bundle (' + BUNDLE + '); read armed hits from this corpus with that in mind. Both isolate via test/e2e.cjs sandbox()+seedClaudeProfile(), independent of this runner\'s outer HOME override.';
  return r;
}

// ---- assemble reachability.json ------------------------------------------
function goldenGapUniverse() {
  return [
    ...(GOLDEN.layer1_bun_props_missing || []),
    ...(GOLDEN.layer1_bun_modules_missing || []),
    ...(GOLDEN.layer2_node_apis_missing || []),
  ];
}

function assemble(corpusResults) {
  const armed = {};
  for (const c of corpusResults) {
    for (const hit of c.hits || []) {
      if (!armed[hit.key]) armed[hit.key] = [];
      if (!armed[hit.key].includes(c.id)) armed[hit.key].push(c.id);
    }
  }
  for (const k of Object.keys(armed)) armed[k].sort();

  const universe = goldenGapUniverse();
  const unarmed = universe.filter((gap) => !armed[gap] && !armed[`${gap} (in)`]);

  const layer1Names = new Set([...(GOLDEN.layer1_bun_props_missing || []), ...(GOLDEN.layer1_bun_modules_missing || [])]);

  return {
    bundle: BUNDLE,
    date: new Date().toISOString().slice(0, 10),
    generated_by: 'scripts/probe-run.mjs',
    golden_measured_on: GOLDEN._measured_on,
    probe_scope_limitation:
      'CLODE_SHIM_PROBE (libexec/node-shim/internal/probe.cjs) only wraps node:* builtins loaded through '
      + "loader.cjs's loadBuiltin() — libexec/bun-shim.cjs (the Bun.* global and bun: modules) is NOT "
      + 'instrumented. layer1_bun_props_missing/layer1_bun_modules_missing entries ('
      + [...layer1Names].join(', ')
      + ') can therefore NEVER be armed by ANY corpus under this mechanism, regardless of whether the bundle '
      + 'reaches them — this is a probe-design gap, not a corpus-coverage gap. Only layer2_node_apis_missing '
      + 'entries are structurally observable here.',
    corpora: corpusResults.map((c) => {
      const { hits, ...rest } = c;
      return { ...rest, hitCount: (hits || []).length };
    }),
    armed,
    unarmed,
    live_session: {
      automatable: false,
      reason: 'requires a real logged-in interactive session; cannot be scripted/isolated the way the other corpora are',
      human_command: `CLODE_SHIM_PROBE=1 <path-to-a-built-quaude> 2> /tmp/probe-live.log`,
      human_followup: [
        'Do a human turn: ask a question, run a Bash tool call, edit a file, use a slash command, then /quit.',
        "grep '^\\[probe\\]' /tmp/probe-live.log | sort -u",
        'Merge the resulting lines into this file\'s "armed" map under corpus id "live-session" (each unique',
        '"<ns>.<prop>" or "<ns>.<prop> (in)" line -> append "live-session" to its corpus array, creating the key',
        'if new), then move it out of "unarmed" if it was there. This is the only corpus that can reach the',
        'credentialed interactive path (RECIPE.md G6) end to end.',
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
    if (id === 'apicheck') r = await runApicheck();
    else if (id === 'agentic') r = runAgentic();
    else if (id === 'interactive') r = runInteractive();
    else { process.stderr.write(`unknown corpus '${id}', skipping\n`); continue; }
    process.stderr.write(`  status=${r.status} hits=${(r.hits || []).length}\n`);
    results.push(r);
  }
  const out = assemble(results);
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2) + '\n');
  process.stderr.write(`\nwrote ${path.relative(REPO, OUT_PATH)}\n`);
  process.stderr.write(`armed: ${Object.keys(out.armed).length}  unarmed: ${out.unarmed.length}\n`);
}

main().catch((e) => { console.error(e); process.exit(1); });
