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
//
// FIX ROUND 1 (2026-09-04), from a coordinator ruling on two things verified after the
// note above was written:
//
// (1) FALSE POSITIVE — the scan was counting OUR OWN emitted code. One of the 16
// findings was in `/$bunfs/root/__clode-scc-1.js`. Those modules are not upstream's:
// libexec/scc-merge.cjs:1119 names each merge group `/$bunfs/root/__clode-scc-` +
// groupIndex + `.js`, and graph.json's `sources` carries three of them
// (`__clode-scc-0/1/2.js`) — MERGED COPIES of real upstream modules the merger folded
// together to remove a residual cyclic require. Counting them is principle 3 of
// BACKLOG.md's "Nothing gates the gates" entry: "a scanner must not count our own
// emitted code." Fixed by deriving the exclusion prefix from libexec/scc-merge.cjs's own
// `mergedName` template at read() time (see `deriveOwnModulePrefix()` below) rather than
// hand-typing the literal string — a hard-coded `__clode-scc-` in this file would be the
// same declared-not-derived defect one layer over. Re-measuring after exclusion: the net
// wall's count moved 11 -> 10 (one of the eleven WAS an scc-merge artifact); fs.watch's
// 5 hits were all real modules and stayed 5.
//
// (2) THE REAL FINDING, and it belongs here, not just in a task report: the ESM
// migration above restored evidence-gathering, but the ORIGINAL narrow-pattern strategy
// this file was built on — "alarm on a DIRECT call with no intermediate alias, because
// that shape is a fresh one-off and the giant pre-existing SDK bundles always alias
// first" — has no ESM expression to fall back to AT ALL, not merely a harder-to-find
// one. Every ESM `import{x}from"m"` binds a local name by construction, and Bun's
// bundler renames that binding for every import it emits regardless of whether the
// original source aliased it. So post-2.1.243, "matches the wall's specific API name,
// imported by name" is the NARROWEST expressible signal, and it is exactly the
// "alias-aware scan matching ANY such call" this file's own header already predicted
// would be "RED ON DAY ONE" — measured here at 10 (net) + 5 (fs.watch) = 15 modules,
// none newly inlined, all pre-existing. Judging that population against a fixed
// zero-tolerance threshold makes this file the same untrusted, ignorable ratchet the
// header's `fs.watchFile` story warns about. So this is now a RATCHET, not a threshold:
// each wall carries a recorded `baseline` (the count the last human actually looked at),
// and `findings` is non-empty only when the CURRENT count differs from that baseline, in
// EITHER direction — a rise is a new reach, a fall means one vanished and the baseline
// needs a deliberate re-cut, and both need a human, but neither needs one on every run
// just because the population is nonzero. Full measurement, the control proving the
// ratchet actually fires, and confirmation this reports OK on the real pinned carve:
// task-3-report.md.
//
// FIX ROUND 2 (2026-09-04), from a coordinator-directed review of round 1's commit —
// two findings, one fixed here, one deliberately NOT fixed here:
//
// (1) FIXED — the ESM half was blind to NAMESPACE imports. `import*as ng from"net"` then
// `ng.connect(...)` elsewhere in the module matched neither wall: the named-import half
// requires the API name to appear literally inside `{...}`, which a namespace import
// never has. Verified against the real pinned carve: 11 namespace imports of net/fs
// exist today (`import*as ng from"net"` once, `import*as <x> from"fs"` ten times, across
// three chunks), and NONE of the eleven is currently called with `.connect(`/`.watch(` —
// which is why neither baseline moved. But that "not called today" is exactly why this
// was a live blind spot and not a moot one: the day a bundler emits namespace form for a
// call that IS reached, the old pattern would report zero findings AND an unchanged
// `examined` — a real reach landing completely invisibly, the same green-by-construction
// failure this task exists to close, one encoding down. Each wall's pattern now also
// matches `import*as <name>from"<module>"` followed later in the same module by
// `<name>.<api>(`, via a capture + backreference (`\1`) rather than two separate passes,
// so the "followed later" half only ever means "later in this specific match's own
// namespace binding," not any name anywhere. The same edit also covers the mixed
// `import net,{connect}from"net"` form (default + named in one statement) — 0
// occurrences today, so it moves nothing, but the named-import half no longer requires
// `{` to be the very first token after `import`.
//
// (2) DOCUMENTED, NOT FIXED — the ratchet in FIX ROUND 1 is a COUNT ratchet, and a count
// cannot see a same-pin SWAP. If one reach vanishes while a different one appears in the
// same scan, the count is unchanged (10 -> 10, or 5 -> 5), `findings` stays empty, and
// the per-module list — the thing this file's own ROSE/FELL language implies is a safety
// net — never prints, because it only prints on a count mismatch. This is real and
// proven by construction (swap module A's reach for module B's in a synthetic corpus:
// same count, zero findings), not a hypothetical. It is NOT fixed in this round. The
// obvious fix — a content-fingerprint SET per wall (not just a count) so a swap changes
// the set even when the count is stable — was considered and deliberately rejected FOR
// THIS PHASE: a fingerprint is carve-sensitive. Bun constant-folds `process.platform` /
// `process.arch` at carve time (measured for the signals scanner, commit 47d2e60 — two
// carves of the SAME upstream version are different bytes depending on which
// platform/arch carved them), and whether the wall-bearing regions of THIS file's
// sources differ between, say, a darwin-carved and a linux-carved 2.1.251 is unmeasured.
// A fingerprint ratchet that is green on the box that recorded the baseline and red in
// CI purely because CI carved on a different platform would be worse than the count
// ratchet it replaced — a new false-positive class in exchange for closing a real but
// narrower gap. Phase 4 owns keying the provider store by platform+arch; a fingerprint
// ratchet here only becomes meaningful once that exists, so this is filed as future
// work gated on that, not re-litigated as an omission in this file.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { defineGuard, guardTests } = require('./guard.cjs');
const { clodeCacheDir } = require('../libexec/clode-paths.cjs');
const { pinnedVersion } = require('./provider-resolve.cjs');

const REPO = path.resolve(__dirname, '..');

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
//
// NAMESPACE + MIXED FORMS (added FIX ROUND 2, 2026-09-04): a third alternative covers
// `import*as <name>from"<module>"` followed later in the SAME module by
// `<name>.<api>(` — captured via a backreference (`\1`), not a second pass, so it only
// ever matches a namespace binding calling its own captured name, not any name anywhere
// in the file. This closed a real blind spot: the named-import half above requires the
// API name to appear literally inside `{...}`, which a namespace import never has, so
// `import*as ng from"net";ng.connect(...)` matched neither wall before this round —
// verified against the real pinned carve (11 namespace imports of net/fs exist, all
// currently un-called with the relevant method — see the FIX ROUND 2 header note for
// why "un-called today" does not make this moot). The named-import half was widened at
// the same time to allow an optional leading default specifier (`import net,{connect}
// from"net"`) — 0 occurrences today, included for the same reason described in the FIX
// ROUND 2 note: fix it while in the same regex, not after it is found reached.
const WALLS = [
  {
    api: 'net.connect / net.createConnection',
    pattern: /require\(\s*["'](?:node:)?net["']\s*\)\s*\.(?:connect|createConnection)\s*\(|import\s*(?:[\w$]+\s*,\s*)?\{[^}]*\b(?:connect|createConnection)\b[^}]*\}\s*from\s*["'](?:node:)?net["']|import\s*\*\s*as\s+([\w$]+)\s*from\s*["'](?:node:)?net["'][\s\S]*?\b\1\.(?:connect|createConnection)\s*\(/,
    // MEASURED 2026-09-04 against ~/.cache/clode/2.1.251/graph.json, EXCLUDING clode's
    // own scc-merge output (see deriveOwnModulePrefix() below) — 10 modules import
    // `connect`/`createConnection` from "net" by name via ESM (11 before exclusion; one
    // was an scc-merge artifact). RE-MEASURED after FIX ROUND 2 added namespace-form
    // matching: still 10 — none of the 11 real namespace imports of "net"/"fs" is
    // currently called with `.connect(`/`.createConnection(`/`.watch(`, so widening the
    // pattern to see that shape did not change what it currently finds; it only closes
    // the gap for the day one of them IS called that way. Re-measure this on every pin
    // bump: task-3-report.md.
    baseline: 10,
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
    pattern: /require\(\s*["'](?:node:)?fs["']\s*\)\s*\.watch\s*\(|import\s*(?:[\w$]+\s*,\s*)?\{[^}]*\bwatch\b[^}]*\}\s*from\s*["'](?:node:)?fs["']|import\s*\*\s*as\s+([\w$]+)\s*from\s*["'](?:node:)?fs["'][\s\S]*?\b\1\.watch\s*\(/,
    // MEASURED 2026-09-04, same run as net's: 5 modules import `watch` from "fs" by name
    // via ESM; none were scc-merge artifacts, so exclusion did not change this count.
    // RE-MEASURED after FIX ROUND 2's namespace-form widening: still 5, for the same
    // reason as net's — real namespace imports of "fs" exist but none is currently
    // called with `.watch(`.
    baseline: 5,
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

// Our own emitted merge output must never count as "upstream now calls this" — principle
// 3 of BACKLOG.md's "Nothing gates the gates" entry. libexec/scc-merge.cjs:1119 names
// each merged group '/$bunfs/root/__clode-scc-' + groupIndex + '.js'; graph.json's
// `sources` carries these as MERGED COPIES of real upstream modules (folded together to
// remove a residual cyclic require), so counting them both misattributes clode's own
// output to upstream AND double-counts whatever real reach the merge happened to fold
// in. Parsed from the real source rather than hand-typed here — a literal
// '__clode-scc-' in this file would be the same declared-not-derived defect the merge
// naming itself is meant to avoid — so a rename of the merge scheme breaks this LOUDLY
// (the regex stops matching, this throws) instead of silently going stale and starting
// to count our own modules again.
function deriveOwnModulePrefix() {
  const src = fs.readFileSync(path.join(REPO, 'libexec', 'scc-merge.cjs'), 'utf8');
  const m = src.match(/var mergedName = (['"])((?:(?!\1).)*)\1\s*\+\s*groupIndex/);
  if (!m) {
    throw new Error('could not locate the scc-merge mergedName template in '
      + 'libexec/scc-merge.cjs — it moved or changed shape; this guard can no longer '
      + 'tell clode\'s own emitted modules from upstream\'s');
  }
  return m[2];
}

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

// PURE. sources: the module-source MAP from graph.json's `sources`, not the 49MB cli.cjs
// graph runner (see the MIGRATED note above for why that distinction matters — reading
// the runner is the escape-blind class, spec 3.7 item 8). walls: WALLS-shaped entries,
// each carrying a `baseline`. ownModulePrefix: modules under this prefix are clode's own
// scc-merge output (see deriveOwnModulePrefix above) and are excluded from wall matching
// entirely — they still count toward `examined` (the scan did look at them), they just
// cannot produce a finding.
//
// RATCHET, not a threshold — see the FIX ROUND 1 header note for why. A finding fires
// only when a wall's CURRENT match count differs from its recorded `baseline`, in EITHER
// direction: a rise means a new reach appeared, a fall means one vanished (the baseline
// itself needs a deliberate re-cut, not a silent shrink). The full list of matching
// modules rides in the finding text so whoever sees it can diff against the baseline.
function scanWalls({ sources, walls, ownModulePrefix }) {
  const findings = [];
  let examined = 0;
  const hits = new Map(walls.map((w) => [w.api, []]));
  for (const [module, body] of Object.entries(sources)) {
    if (typeof body !== 'string') continue;
    examined++;                                    // looked at it, own-emitted or not
    if (ownModulePrefix && module.startsWith(ownModulePrefix)) continue;
    for (const wall of walls) {
      if (wall.pattern.test(body)) hits.get(wall.api).push(module);
    }
  }
  for (const wall of walls) {
    const modules = hits.get(wall.api);
    if (modules.length !== wall.baseline) {
      const dir = modules.length > wall.baseline ? 'ROSE' : 'FELL';
      findings.push(`${wall.api}: reach count ${dir} from baseline ${wall.baseline} to `
        + `${modules.length}:\n` + modules.map((m) => `      ${m}`).join('\n'));
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
    return g.skip ? g : { sources: g.sources, walls: WALLS, ownModulePrefix: deriveOwnModulePrefix() };
  },
  scan: scanWalls,
  // A synthetic corpus with its OWN zero baseline (not the real WALLS' recorded counts,
  // which describe a completely different corpus and would make this control's pass/fail
  // depend on what pin happens to be checked out). One extra reach in a fresh corpus
  // pushes its count from 0 to 1, past baseline, which is exactly what the ratchet must
  // catch — a positive control describing the SAME kind of violation the real gate is
  // built to notice, not a coincidental mismatch. If upstream changes encoding again,
  // this control keeps passing while the gate goes blind — so step 1 of any pin bump is
  // to re-measure the shapes, not to re-run this file.
  control: () => ({
    walls: WALLS.map((w) => ({ ...w, baseline: 0 })),
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

test('the wall patterns match the NAMESPACE import shape upstream ALSO emits', () => {
  // FIX ROUND 2 (2026-09-04): `import*as ng from"net"` then `ng.connect(...)` elsewhere
  // in the same module matched NEITHER wall until this round — verified against the real
  // pinned carve: 11 such namespace imports exist today (none currently called with
  // .connect/.watch, which is why the baselines below did not move), but a pattern that
  // cannot see this shape at all would report zero findings AND an unchanged `examined`
  // the day a bundler picks namespace form for a reached call — the exact
  // green-by-construction failure this task exists to close, one encoding down.
  const netEsm = 'import*as ng from"net";function go(o){return ng.connect(o)}';
  const netWall = WALLS.find((w) => w.api.startsWith('net.'));
  assert.ok(netWall.pattern.test(netEsm),
    'the net wall must match import*as X from"net" followed by X.connect(');

  const fsEsm = 'import*as f from"fs";function go(p){return f.watch(p,()=>{})}';
  const fsWall = WALLS.find((w) => w.api === 'fs.watch');
  assert.ok(fsWall.pattern.test(fsEsm),
    'the fs.watch wall must match import*as X from"fs" followed by X.watch(');
});

test('the net wall pattern also matches the mixed default+named import form', () => {
  // `import net,{connect}from"net"` — 0 occurrences in the pinned 2.1.251 carve
  // (verified), so this does not move any baseline, but the widened named-import half
  // must not require the braces to be the very first token after `import`.
  const esm = 'import net,{connect as q}from"net";function go(o){return q(o)}';
  const wall = WALLS.find((w) => w.api.startsWith('net.'));
  assert.ok(wall.pattern.test(esm),
    'the net wall must match the mixed default+named import form too');
});

test('regression: our own scc-merge output is excluded, not counted as an upstream reach', () => {
  // A module under the derived own-module prefix that WOULD match the net wall must not
  // be counted, even though its content is wall-shaped — it is clode's own merged
  // output, not upstream's code (BACKLOG.md "Nothing gates the gates" principle 3).
  const walls = [{ ...WALLS.find((w) => w.api.startsWith('net.')), baseline: 0 }];
  const sources = { '/$bunfs/root/__clode-scc-0.js': 'import{connect as q}from"net";q({})' };
  const withExclusion = scanWalls({ sources, walls, ownModulePrefix: '/$bunfs/root/__clode-scc-' });
  assert.deepStrictEqual(withExclusion.findings, [],
    'a module under the own-emitted prefix must not produce a finding');
  assert.strictEqual(withExclusion.examined, 1, 'it is still examined, just not counted toward a wall');

  // Same source, no exclusion prefix supplied: the same content DOES count. Proves the
  // exclusion above is doing something, not a no-op that happens to pass either way.
  const withoutExclusion = scanWalls({ sources, walls });
  assert.strictEqual(withoutExclusion.findings.length, 1,
    'without the own-module exclusion the same source must be counted');
});

test('regression: a count that RISES past its baseline is reported', () => {
  const walls = [{ ...WALLS.find((w) => w.api.startsWith('net.')), baseline: 1 }];
  const sources = {
    'a.js': 'import{connect as x}from"net";x({})',
    'b.js': 'import{connect as y}from"net";y({})',
  };
  const r = scanWalls({ sources, walls });
  assert.strictEqual(r.findings.length, 1);
  assert.match(r.findings[0], /ROSE from baseline 1 to 2/);
  assert.match(r.findings[0], /a\.js/);
  assert.match(r.findings[0], /b\.js/);
});

test('regression: a count that FALLS below its baseline is reported', () => {
  const walls = [{ ...WALLS.find((w) => w.api.startsWith('net.')), baseline: 2 }];
  const sources = { 'a.js': 'import{connect as x}from"net";x({})' };
  const r = scanWalls({ sources, walls });
  assert.strictEqual(r.findings.length, 1);
  assert.match(r.findings[0], /FELL from baseline 2 to 1/);
});

test('regression: a count matching its baseline produces no finding', () => {
  const walls = [{ ...WALLS.find((w) => w.api.startsWith('net.')), baseline: 1 }];
  const sources = { 'a.js': 'import{connect as x}from"net";x({})' };
  const r = scanWalls({ sources, walls });
  assert.deepStrictEqual(r.findings, []);
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

module.exports = { WALLS, scanWalls, readGraphJson, resolveGraphPath, deriveOwnModulePrefix };
