'use strict';
// EVIDENCE ratchet, not a SHAPE ratchet (contrast: golden lists, anchor-guarded
// fixups that throw on pin drift, `deriveTag == assetName` — see
// test/tjs-legs.test.cjs for the ci-tier "if we ship it, CI gates it" shape gate).
// Named node-shim-* (not the task's suggested shim-wall-tripwires.test.cjs) on
// purpose: CI's "node-shim oracle" step (.github/workflows/ci.yml, ~line 320)
// globs `test/node-shim-*.test.cjs` with a real CLODE_PROVIDER_BIN already
// exported — this name rides that glob for free, no workflow edit needed.
//
// The node-shim deliberately leaves some Node APIs unimplemented — "walls" —
// documented only in code comments + BACKLOG.md, and they stay LATENT (nothing
// on clode's tested paths reaches them) right up until upstream's bundle starts
// calling one. That is not hypothetical: `fs.watchFile` sat as a documented
// "future wall" for weeks, until the bundle's git-state cache started calling it
// and the stub's silent non-firing produced the darwin-ppc "hangs right after
// 'No git remote URL found'" incident — a full day to root-cause, because
// nothing failed loudly; it just never resolved a promise. `http.request` /
// `https.request` were declared to be in the exact same latent state — and then
// turned out NOT to be (see the RETIRED note on the WALLS table below), which is
// the sharpest available illustration of this file's own limits.
// A wall that stays silent until it bites is invisible to every
// existing ratchet in this repo, because none of them look at what upstream's
// CODE actually calls — they check shapes (pins, name parity, gate presence).
// This file is the missing EVIDENCE check: for each declared wall, grep the
// PINNED upstream bundle for a call shaped like the wall being reached, and
// fail the day it appears — turning a silent future incident into a dated,
// named alarm that shows up in `npm test` output today, not a day of gdb later.
//
// PATTERN CHOICE (read before adding a wall — this is the part that's easy to
// get wrong): a minifier binds `require("http")` etc. to a short alias and
// calls `<alias>.request(...)` elsewhere. An alias-aware scan matching ANY such
// call would be RED ON DAY ONE against the real bundle: this 21MB bundle already
// contains genuine `<alias>.request(`/`<alias>.connect(` call sites today, from
// vendored deps (aws-sdk credential providers, proxy-agent, grpc's http-proxy
// transport, form-data, `chokidar`-style file watchers for fs.watch) that are
// dead code on clode's supported (-p / interactive, no-proxy) paths — verified
// empirically against the real 2.1.218 bundle while building this file (11
// `.request(` alias hits, 24 `.connect(`/`.createConnection(` alias hits, 4
// `.watch(` alias hits; see task-15-report.md).
//
// CORRECTION (2026-08-01), recorded because the rationale above overstates its
// case for ONE wall: the 4 `.watch(` alias hits were re-examined and only ONE is
// the vendored `chokidar` this paragraph assumes. The other three are FIRST-PARTY
// Claude Code (`jobStateNameSync`, `useBgSessionPr`, and an unref'd watcher in a
// private-field class with an empty `catch {}`), all resolving through
// `<alias> = require("fs")`. "Vendored dead code" is therefore NOT why fs.watch
// stays quiet; the actual reason is REACHABILITY — those paths are believed off
// clode's -p / interactive routes — and that belief is UNVERIFIED. The narrow
// pattern below is still the right call for the reasons in the next paragraph
// (an alias-aware scan is red on day one and would be trusted by nobody), but it
// buys LESS safety for fs.watch than for http/https/net, and the gap is
// reachability analysis this file deliberately does not do. Tracked as
// test/fidelity/RECIPE.md row C7 rather than papered over here.
//
// Chasing which alias sites are
// actually REACHABLE would mean reimplementing a data-flow linter, and a ratchet
// that's already red before it ever caught anything is a ratchet nobody trusts —
// which is exactly how `fs.watchFile` sat silent for weeks in the first place.
//
// Instead this alarms on a NARROW, low-noise signal: a DIRECT
// `require("http").request(` (no intermediate alias) with no assignment in
// between. That is the shape a freshly-inlined or freshly-vendored one-off call
// site takes — plausible for a small new dependency or first-party snippet —
// and NOT the shape the giant pre-existing SDK bundles above use (they always
// destructure to a variable first). Verified against the real bundle: zero
// matches for every wall below (see task-15-report.md, VERIFY step 2); a
// synthetic fixture below proves the pattern actually fires when the shape
// appears.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const models = require('./oracle-models.cjs');

// Declared walls, as DATA — adding one later is a one-line addition here, not a
// new test. `pattern` matches source text; `why` is the shim module's own
// header/throw text (quoted verbatim so the failure message is self-explaining);
// `backlogRef` points at the dated BACKLOG.md entry when one exists, else the
// module comment that is the closest thing to one.
// RETIRED 2026-08-22 — http.request and https.request were the first two
// entries here. They are no longer walls: the client half is implemented over
// tjs.connect and characterized differentially against host node in
// test/node-shim-http-client.test.cjs. Removing them was not a judgement call —
// the wall they guarded was MEASURED to be reached (CLAUDE_CODE_USE_BEDROCK=1
// drives http.request at the EC2 instance metadata service and https.request at
// bedrock.<region>.amazonaws.com), i.e. this tripwire's whole premise ("still
// latent") had already expired for that backend. Note what that says about the
// pattern below: the reaches were through ALIASES, the shape this file
// deliberately does not match, so the tripwire never fired. It is a low-noise
// alarm for freshly-inlined call sites, not a reachability proof — the same
// caveat the CORRECTION above records for fs.watch.
const WALLS = [
  {
    api: 'net.connect / net.createConnection',
    pattern: /require\(\s*["'](?:node:)?net["']\s*\)\s*\.(?:connect|createConnection)\s*\(/,
    why: '"the actual socket surface (net.connect / createConnection / real '
      + 'Socket I/O / net.Server) is NOT implemented — the -p transport is '
      + 'txiki\'s native fetch, which never routes through node:net ... '
      + 'connect/createConnection throw a branded wall." Thrown message: '
      + '\'node-shim: net.connect/createConnection not implemented (fetch is the '
      + '-p transport)\'. (libexec/node-shim/modules/net.cjs)',
    backlogRef: 'no dedicated BACKLOG.md bullet yet — see '
      + 'libexec/node-shim/modules/net.cjs:8-13,150',
  },
  {
    api: 'fs.watch',
    pattern: /require\(\s*["'](?:node:)?fs["']\s*\)\s*\.watch\s*\(/,
    why: '"fs.watch (the inotify/FSEvents-style API): STILL a stub, unlike '
      + 'watchFile above ... this engine\'s uv_fs_event backend is ENOSYS on some '
      + 'legs, so there is no portable native primitive to poll-emulate cheaply." '
      + '(libexec/node-shim/modules/fs.cjs) — same silent-stub shape as the '
      + 'watchFile incident this file exists to prevent a repeat of. NOTE: unlike '
      + 'the other walls here, the pinned bundle DOES already call fs.watch via '
      + 'aliases (4 sites, 3 of them first-party — see the CORRECTION in this '
      + 'file\'s header). This narrow direct-shape pattern therefore does NOT '
      + 'certify fs.watch is unreached; it only catches a newly-inlined call. '
      + 'Reachability is tracked as RECIPE.md row C7',
    backlogRef: 'no dedicated BACKLOG.md bullet yet — see '
      + 'libexec/node-shim/modules/fs.cjs (fsMod.watch) and RECIPE.md C7',
  },
];

// Test-only override: point the gate at a specific file instead of staging a
// real provider. Used to verify the mechanism itself against a synthetic
// fixture (task-15-report.md, VERIFY step 2) without needing a Bun-packaged
// Claude Code provider on the box. The normal/CI path never sets this.
function resolveBundlePath(env = process.env) {
  if (env.CLODE_SHIM_WALL_BUNDLE) {
    const p = env.CLODE_SHIM_WALL_BUNDLE;
    return fs.existsSync(p) ? p : null;
  }
  try {
    // Honors CLODE_PROVIDER_BIN first (same as the API-surface gate), else
    // clode's own local provider resolution (test/oracle-models.cjs header) —
    // both are purely local/offline; no network fetch happens here.
    const staged = models.stageProviderCli({ env });
    return staged ? staged.cli : null;
  } catch {
    return null;
  }
}

// Resolved once at module scope: staging spawns a child process to carve a
// ~20MB bundle, and every wall below diffs the SAME snapshot — no reason to
// redo it per-wall.
const BUNDLE = resolveBundlePath();
const BUNDLE_SRC = BUNDLE ? fs.readFileSync(BUNDLE, 'utf8') : null;
const SKIP_REASON = 'no upstream bundle available locally — set CLODE_PROVIDER_BIN '
  + 'to a real claude binary (or run somewhere clode has already resolved a local '
  + 'provider) to exercise this gate; see test/oracle-models.cjs';

function fireMessage(wall) {
  return `shim wall tripwire FIRED — upstream's pinned bundle now calls ${wall.api}, `
    + `which the node-shim does not implement.\n`
    + `  why this is a wall: ${wall.why}\n`
    + `  see: ${wall.backlogRef}\n`
    + `  (bundle: ${BUNDLE})`;
}

for (const wall of WALLS) {
  test(`shim wall tripwire: pinned bundle does not yet call ${wall.api}`, (t) => {
    if (!BUNDLE_SRC) { t.skip(SKIP_REASON); return; }
    assert.ok(!wall.pattern.test(BUNDLE_SRC), fireMessage(wall));
  });
}

// Mechanism self-check — always runs, needs no bundle: proves the pattern
// actually fires on the shape it claims to catch, and stays quiet on the
// alias-bound shape that already exists throughout the real bundle (the false-
// positive class this file's header explains rejecting).
test('shim wall tripwire mechanism: fires on a direct require(...).connect( call', () => {
  const fixture = 'function boot(o){var s=require("net").connect(o);return s}';
  const wall = WALLS.find((w) => w.api === 'net.connect / net.createConnection');
  assert.ok(wall.pattern.test(fixture),
    'the net.connect wall pattern must match a direct require("net").connect( call');
});

test('shim wall tripwire mechanism: does not fire on the aliased shape already present today', () => {
  // The exact shape found in the real bundle: require() result assigned to a
  // variable first, THEN .request()/.connect() called on the alias elsewhere.
  const fixture = 'var zCh=require("net"),Jfu=require("tls");'
    + 'function go(n){return n.secure?Jfu.connect(n):zCh.connect(n)}'
    + 'var w=require("fs");function go2(p){return w.watch(p)}';
  for (const wall of WALLS) {
    assert.ok(!wall.pattern.test(fixture),
      `${wall.api} pattern must not match the pre-existing aliased-call shape`);
  }
});

module.exports = { WALLS, resolveBundlePath };
