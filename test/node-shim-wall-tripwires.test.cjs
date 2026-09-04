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
//
// MIGRATED 2026-09-04 (phase 5, task 3), because the paragraphs above stopped
// describing the artifact. Re-measured against the pinned staged carve at
// ~/.cache/clode/2.1.251/graph.json: `require("<builtin>")` — raw OR escaped
// inside cli.cjs's 49MB graph-runner string — has ZERO hits, anywhere. Upstream
// went code-split ESM at 2.1.243 and stopped emitting CJS builtin requires
// entirely; `import … from "<builtin>"` has 270 hits across graph.json's 1,839
// module sources. Both WALLS patterns were therefore green by construction, and
// this file's own "mechanism self-check" passed anyway, because it modeled the
// OLD syntax in a hand-written fixture — a control describing an encoding the
// artifact no longer has, passing for the wrong reason. That is the exact
// weak-control failure this phase's design predicted, found in the wild.
//
// Fixed by: (1) reading graph.json's `sources` map directly — real strings, no
// escape level to track — instead of grepping cli.cjs, the graph RUNNER, where
// module text rides as an escaped JSON string inside a JS string (the
// escape-blind class that has already killed three other gates in this repo,
// per BACKLOG.md); (2) widening each WALLS[].pattern to match BOTH the legacy
// require(...) chain and the ESM named-import form; (3) wiring the result
// through test/guard.cjs's defineGuard/guardTests so this gate carries a real
// positive control instead of a fixture that can silently drift from the
// artifact's actual encoding again, unnoticed, the way this one just did.
//
// MEASURED, re-running the corrected gate against the SAME pin: it is NOT
// clean. examined 1839, 16 findings — net.connect/createConnection reached via
// ESM `import{connect as <alias>}from"net"` in 11 distinct module chunks (one
// is first-party: a Unix-domain-socket client, `pe({path:e})`, logged as
// "[uds-client] Sent to ..."), and fs.watch reached the same way in another 5
// chunks. A literal "matches ANY import from net/fs regardless of which name"
// pattern — the shape this task's own brief sketched as an example — is even
// noisier: 22 and 100 hits respectively, most with nothing to do with
// connect/watch at all (isIP, createServer, readFile, ...). The pattern below
// instead filters the
// ESM half by the SAME specific method names the CJS half already does — the
// direct generalisation of this file's existing narrow, low-noise design, not a
// weakening of it. Even narrowed, the finding stands. This is the same category
// as the http.request/https.request RETIREMENT below — a wall the pinned bundle
// already reaches — except unlike that story this file does not resolve it here
// (implement the API, or prove non-reachability); it is reported as a live
// VIOLATION, on purpose, because silencing the pattern until it goes quiet again
// is the exact "gate that cannot fail" this phase exists to close off. Full
// commands + output: task-3-report.md.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { defineGuard, guardTests } = require('./guard.cjs');
const { clodeCacheDir } = require('../libexec/clode-paths.cjs');
const { pinnedVersion } = require('./provider-resolve.cjs');

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
//
// ESM HALF (added 2026-09-04): every WALLS[].pattern is now an alternation of
// the legacy CJS chain (`require("net").connect(`, no intermediate alias) and
// the ESM named-import shape upstream actually emits since 2.1.243
// (`import{connect as <alias>}from"net"`). The two halves are NOT equally
// narrow, and that asymmetry is a known, accepted gap rather than an oversight:
// CJS lets a one-off call skip an intermediate variable entirely, so "no alias"
// is a real signal that separates a fresh inline call from the giant
// pre-existing SDK bundles that always destructure first. ESM syntax has no
// analogue — every `import{x}from"m"` binds a local name, and Bun's bundler
// renames that binding for EVERY import it emits (`isIP as b`, `connect as pe`,
// ...) whether or not the original source aliased it, so "was this written
// with `as`" carries no information once bundled. There is no narrow-equivalent
// ESM shape to fall back to. The ESM half therefore matches on IMPORTED NAME
// alone (does this module import `connect`/`createConnection` from "net", by
// name, at all) — narrower than "any import from the module" (which the CJS
// half's `.request(`/`.connect(` filtering never allowed either), but broader
// than the CJS half's "and calls it with no alias in between". Accept the
// resulting noise increase as the honest cost of upstream's move to ESM, not as
// something to regex away — see the MEASURED note above for what it actually
// found.
const WALLS = [
  {
    api: 'net.connect / net.createConnection',
    pattern: /require\(\s*["'](?:node:)?net["']\s*\)\s*\.(?:connect|createConnection)\s*\(|import\s*\{[^}]*\b(?:connect|createConnection)\b[^}]*\}\s*from\s*["'](?:node:)?net["']/,
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
    pattern: /require\(\s*["'](?:node:)?fs["']\s*\)\s*\.watch\s*\(|import\s*\{[^}]*\bwatch\b[^}]*\}\s*from\s*["'](?:node:)?fs["']/,
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

// Test-only override, same convention the old CLODE_SHIM_WALL_BUNDLE var used:
// point the gate straight at a graph.json instead of resolving the pinned
// staged carve under ~/.cache/clode. The normal/CI path never sets this.
function resolveGraphPath(env = process.env) {
  if (env.CLODE_SHIM_WALL_GRAPH) return env.CLODE_SHIM_WALL_GRAPH;
  const pin = pinnedVersion();
  if (!pin) return null;
  return path.join(clodeCacheDir(env), pin, 'graph.json');
}

// read()'s real half: graph.json's `sources` map for the pinned upstream carve.
// Reads graph.json, NOT cli.cjs (the 49MB graph RUNNER) — see the MIGRATED note
// above for why that distinction is load-bearing, not cosmetic.
//
// Never returns an empty sources map to mean "not found" — that would scan zero
// modules and read exactly like a clean 1,839-module scan, the ambiguity
// test/guard.cjs exists to make impossible. An absent precondition is always a
// named skip.
function readGraphJson(env = process.env) {
  const graphPath = resolveGraphPath(env);
  if (!graphPath) {
    return { skip: 'UPSTREAM_PIN does not name a pinned version — cannot locate a staged carve' };
  }
  if (!fs.existsSync(graphPath)) {
    return { skip: `no staged carve at ${graphPath} — build or extract the pinned provider `
      + '(see libexec/clode-extract.cjs) to exercise this gate' };
  }
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
  } catch (e) {
    return { skip: `${graphPath} could not be parsed as JSON: ${e.message}` };
  }
  const sources = doc && doc.sources;
  if (!sources || typeof sources !== 'object') {
    return { skip: `${graphPath} has no \`sources\` map — not a code-split graph doc `
      + '(a pre-2.1.243 provider carves to cli.cjs directly and has no graph at all)' };
  }
  return { sources };
}

// PURE. Input is the module-source MAP from graph.json's `sources`, not the 49MB
// cli.cjs graph runner (see the MIGRATED note above for why that distinction
// matters — reading the runner is the escape-blind class, spec 3.7 item 8).
function scanWalls({ sources, walls }) {
  const findings = [];
  let examined = 0;
  for (const [module, body] of Object.entries(sources)) {
    if (typeof body !== 'string') continue;
    examined++;
    for (const wall of walls) {
      if (wall.pattern.test(body)) findings.push(`${wall.api} reached in ${module}`);
    }
  }
  return { findings, examined };
}

const guard = defineGuard({
  name: 'node-shim-wall-tripwires',
  floor: 100,   // 1839 modules today; 100 is a floor against an empty/moved sources map,
                // not a target. Under it, the scan read something that is not the graph.
  read: () => {
    const g = readGraphJson();          // returns { skip } when no provider is staged
    return g.skip ? g : { sources: g.sources, walls: WALLS };
  },
  scan: scanWalls,
  // The control is built from the encoding the REAL artifact uses today. If upstream
  // changes encoding again, this control keeps passing while the gate goes blind — so
  // step 1 of any pin bump is to re-measure the shapes, not to re-run this file.
  control: () => ({
    walls: WALLS,
    sources: { 'synthetic/control.js': 'import{connect as q}from"net";q({})' },
  }),
});
guardTests(guard);

// Mechanism self-checks — always run, need no staged carve: prove the pattern
// actually fires on the ESM shape upstream emits today, still fires on the
// legacy CJS shape (so a pin regression back to CJS would still be caught), and
// stays quiet on the pre-existing aliased CJS shape this file has always
// deliberately ignored (the false-positive class the header explains rejecting).
test('the wall patterns match the ESM shape upstream ACTUALLY emits', () => {
  // Upstream emits `import{connect as x}from"net"` / `import*as n from"node:net"`,
  // never `require("net").connect(`. A pattern that only matches the require form
  // is green by construction, which is what this file was from 2.1.243 until
  // 2026-09-04.
  const esm = 'import{connect as q}from"net";function go(o){return q(o)}';
  const wall = WALLS.find((w) => w.api.startsWith('net.'));
  assert.ok(wall.pattern.test(esm),
    'the net wall must match the ESM import form — the only form upstream emits today');
});

test('the wall patterns still match the legacy require form', () => {
  const cjs = 'function boot(o){var s=require("net").connect(o);return s}';
  const wall = WALLS.find((w) => w.api.startsWith('net.'));
  assert.ok(wall.pattern.test(cjs), 'both encodings must be pinned, not one');
});

test('the fs.watch wall pattern matches the ESM shape upstream ACTUALLY emits', () => {
  const esm = 'import{watch as w}from"fs";function go(p){return w(p,()=>{})}';
  const wall = WALLS.find((w) => w.api === 'fs.watch');
  assert.ok(wall.pattern.test(esm),
    'the fs.watch wall must match the ESM import form too, not only net\'s');
});

test('the fs.watch wall pattern still matches the legacy require form', () => {
  const cjs = 'function boot(p){return require("fs").watch(p,()=>{})}';
  const wall = WALLS.find((w) => w.api === 'fs.watch');
  assert.ok(wall.pattern.test(cjs), 'both encodings must be pinned for fs.watch too');
});

test('shim wall tripwire mechanism: does not fire on the pre-existing aliased CJS shape', () => {
  // The exact CJS shape found in the real 2.1.218-era bundle: require() result
  // assigned to a variable first, THEN .request()/.connect() called on the alias
  // elsewhere. This has no ESM `import{...}from` syntax in it, so it must not trip
  // the ESM half either.
  const fixture = 'var zCh=require("net"),Jfu=require("tls");'
    + 'function go(n){return n.secure?Jfu.connect(n):zCh.connect(n)}'
    + 'var w=require("fs");function go2(p){return w.watch(p)}';
  for (const wall of WALLS) {
    assert.ok(!wall.pattern.test(fixture),
      `${wall.api} pattern must not match the pre-existing aliased-call shape`);
  }
});

module.exports = { WALLS, scanWalls, readGraphJson, resolveGraphPath };
