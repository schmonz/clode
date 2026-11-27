'use strict';
// PHASE 5B, TASK 3. `libexec/host-provision.cjs` is one KAT-verified resolver every
// artifact uses to find host tools (zstd, the one left: tar, gzip and unzip went when
// every archive moved in process, libexec/unpack.cjs), run them on a known input, and demand the EXACT expected output
// before trusting the winner. This file is the house-shape (defineGuard/guardTests, per
// test/build-gates/lexical-code-mask.test.cjs and dep-closure-gates.test.cjs) that
// controls provision()'s unknown-requirement throw-site, plus the guards that keep
// every hash and every base64/hex codec in shipped code native (no hand-written hash or codec in libexec).
// (A second guard here once controlled the sha256 requirement's KAT; sha256 left the
// registry when file hashes went native, and that guard went with it.)
//
// The literal relative require below is load-bearing for Task 5's population sweep,
// which derives "which guard controls this production gate" by reading this exact
// string out of the guard's own source.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// REGISTRY is deliberately NOT imported: this guard's whole point is that the verdict for
// every call site comes from calling the real provision(), never from re-checking
// Object.keys(REGISTRY) here (see scanKnownRequirementIds below). An unused import of it
// was an invitation to do exactly that.
const { provision } = require('../../libexec/host-provision.cjs');
const { defineGuard, guardTests, checkGate, BROKEN } = require('../guard.cjs');
const { throwsAsFindings } = require('../throws-as-findings.cjs');
const { stripLineComments, discoverFilesByExt } = require('../source-scan.cjs');

const REPO = path.resolve(__dirname, '..', '..');
const LIBEXEC = path.join(REPO, 'libexec');
const SCRIPTS = path.join(REPO, 'scripts');

// ==========================================================================
// GUARD 1 — provision()'s FIRST throw-site: `REGISTRY[id]` lookup miss ->
// `unknown requirement '${id}'`.
// ==========================================================================
//
// WHAT IT GUARDS. This is host-provision's very first validation, and it fires
// before any probing/spawning happens at all: pass an id with no REGISTRY entry
// and provision() refuses immediately. The concern this guard controls is NOT
// "does the throw fire" (trivially true for any bogus string) — it is the SILENT
// alternative: a future rename of a REGISTRY key, or a call-site typo, that a
// human reviewer skims past because nothing runs it at review time. Left alone,
// that mismatch surfaces for real only the first time a build actually needs
// that tool (e.g. a Windows-only leg needing `unzip`), far from the edit that
// broke it. This guard runs the REAL, exported `provision()` against every
// literal `provision('<id>', …)` call site in the shipped codebase, at test
// time, so the mismatch is caught at the edit instead.
//
// WHAT INPUT TRIPS IT (measured): calling `provision('controlled-unknown-tool', …)`
// — any id string absent from `Object.keys(REGISTRY)` — throws
// `host-provision: unknown requirement 'controlled-unknown-tool'`.
//
// HOW FAKES AVOID THE NETWORK AND THE REAL CACHE. `findTool` is injected to always
// return `null`, so `provision()` never even reaches `spawn()` for a real id (it
// records "not found" for every candidate and throws the SECOND throw-site's
// message instead — a different string, filtered out below by matching only
// `/unknown requirement/i`). `dataDir` is a FIXED path under os.tmpdir() that is
// never created: `provision()`'s cache read wraps ENOENT in a try/catch (see
// `readCache` in host-provision.cjs) and its cache WRITE only runs after a
// candidate's KAT passes — which never happens here, because `findTool` never
// hands back a candidate to verify. So nothing under this path is ever created,
// let alone written to; it is not `~/.local/share/clode` or any real cache.
const NEVER_WRITTEN_DATADIR = path.join(os.tmpdir(), 'clode-hp-guard-unknown-requirement-never-written');

// stripLineComments and discoverFilesByExt come from test/source-scan.cjs (they were
// duplicated verbatim across this file, target-update-gates.test.cjs and
// guards-population.cjs). Comment stripping is what keeps a prose mention of
// `provision('zstd')` — host-provision.cjs's doc comments have them —
// from reading as a real call site; source-scan.cjs states which direction each of its
// approximations fails in.

const CALL_SITE_RE = /provision\(\s*['"]([\w-]+)['"]/g;

// read() — the only I/O in this guard: the repo's own libexec/ and scripts/ source
// (never ~/.local/share/clode, never anything this guard could write to). Excludes
// host-provision.cjs itself (its own doc-comment names ids in prose, not a call).
function readRealCallSites() {
  const files = [
    ...discoverFilesByExt(LIBEXEC, ['.cjs', '.js']),
    ...discoverFilesByExt(SCRIPTS, ['.mjs', '.cjs', '.js']),
  ].filter((f) => path.basename(f) !== 'host-provision.cjs');
  const sites = [];
  for (const f of files) {
    const stripped = stripLineComments(fs.readFileSync(f, 'utf8'));
    CALL_SITE_RE.lastIndex = 0;
    let m;
    while ((m = CALL_SITE_RE.exec(stripped))) {
      sites.push({ file: path.relative(REPO, f), id: m[1] });
    }
  }
  return { sites };
}

// PURE from the caller's point of view. The verdict for EVERY site comes from
// actually calling the real, exported `provision()` — never from re-checking
// `Object.keys(REGISTRY).includes(id)` here, which would be exactly the
// duplicated-logic mistake task-2's first attempt made (a second copy of
// production's judgment that cannot notice production regressing).
function scanKnownRequirementIds({ sites }) {
  const findings = [];
  for (const { file, id } of sites) {
    const opts = {
      findTool: () => null,
      spawn: () => { throw new Error('scanKnownRequirementIds: must never spawn'); },
      fs,
      dataDir: NEVER_WRITTEN_DATADIR,
    };
    const { findings: f } = throwsAsFindings(provision, [id, opts], { examined: 1 });
    for (const msg of f) {
      if (/unknown requirement/i.test(msg)) {
        findings.push(`${file}: provision('${id}', …) — the REAL provision() reports '${id}' `
          + `as an unknown requirement: ${msg}`);
      }
    }
  }
  return { findings, examined: sites.length };
}

function unknownRequirementControlInputs() {
  return { sites: [{ file: 'synthetic/control.cjs', id: 'controlled-unknown-tool' }] };
}

// Measured 2026-11-27: `grep -rn "provision(" libexec scripts` with line comments
// stripped (the same stripLineComments() this guard uses) finds 1 real call site —
// libexec/bun-graph.cjs ('zstd'). (7 until tar, gzip and unzip left the registry when every
// archive moved in process, libexec/unpack.cjs; 9 before that, until the two 'sha256' sites
// went with native hashing.) The floor is that exact count — a drop means either the call
// site was removed (in which case this floor should move with it) or the scan broke.
const guard1 = defineGuard({
  name: 'host-provision-unknown-requirement',
  floor: 1,
  read: readRealCallSites,
  scan: scanKnownRequirementIds,
  control: unknownRequirementControlInputs,
});
guardTests(guard1);

test('floor fires: host-provision-unknown-requirement goes BROKEN below its floor', () => {
  const r = checkGate({
    name: 'floor-probe-1', floor: guard1.floor,
    read: () => ({ sites: [] }), // fewer than the real 1
    scan: scanKnownRequirementIds,
  });
  assert.strictEqual(r.verdict, BROKEN, r.message);
});

module.exports = {
  readRealCallSites, scanKnownRequirementIds, guard1,
};

// ==========================================================================
// GUARD — NO HAND-WRITTEN HASH IMPLEMENTATION IN SHIPPED CODE.
// ==========================================================================
//
// Every hash in libexec goes through ONE native implementation per runtime: txiki's tjs:hashing under tjs
// (libexec/node-shim/internal/hash.cjs behind node:crypto, and clode-net.cjs sha256Of), node:crypto under node.
// The node-shim once carried a pure-JS SHA-256. Under tjs it took 3.6s for the 5.4MB engine template, measured
// 2026-11-26, against 3ms under node, and it cost users minutes twice: the fetch verify ("hang writing to disk")
// and the build's own sha256File, which froze the native build's "Signing" phase for 6.3s. The fix after the first
// was a host digest tool, which Mac OS X Tiger does not have, so a Tiger first run could not verify its download.
//
// THE CLASS, not the instance. The guard before this one banned createHash calls outside a list of exceptions,
// which is a ban on the symptom: it allowed the implementation itself and every caller someone listed. This one
// bans the implementation: any libexec source carrying a hash's round constants (SHA-256's first K word, MD5's
// first T word, SHA-1's first K word) is a hash written by hand, whatever it is called. A real one cannot avoid
// them.
const HASH_ROUND_CONSTANTS = [
  { re: /0x428a2f98\b/i, what: "SHA-256's round constant K[0] (0x428a2f98)" },
  { re: /0xd76aa478\b/i, what: "MD5's round constant T[1] (0xd76aa478)" },
  { re: /0x5a827999\b/i, what: "SHA-1's round constant K0 (0x5a827999)" },
];

function readLibexecSources() {
  const files = discoverFilesByExt(LIBEXEC, ['.cjs', '.js', '.mjs']);
  return { sources: files.map((f) => ({ rel: path.relative(REPO, f).split(path.sep).join('/'), text: stripLineComments(fs.readFileSync(f, 'utf8')) })) };
}

function scanHandWrittenHash({ sources }) {
  const findings = [];
  for (const s of sources) {
    for (const k of HASH_ROUND_CONSTANTS) {
      if (k.re.test(s.text)) findings.push(`${s.rel}: carries ${k.what}, a hash written in JS; hash with node:crypto (tjs:hashing under tjs, libexec/node-shim/internal/hash.cjs) or clode-net.cjs sha256Of instead`);
    }
  }
  return { findings, examined: sources.length };
}

// Measured 2026-11-27: 96 .cjs/.js/.mjs files under libexec (node_modules excluded). The floor is well under that
// but far above a broken walk, which would find a handful or none.
guardTests(defineGuard({
  name: 'no-hand-written-hash',
  floor: 80,
  read: readLibexecSources,
  scan: scanHandWrittenHash,
  // the defect as it was: libexec/node-shim/internal/sha256.cjs's round-constant table
  control: () => ({ sources: [{ rel: 'libexec/node-shim/internal/sha256.cjs', text: 'const K = new Uint32Array([\n  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,\n]);' }] }),
}));

test('no-hand-written-hash: each round constant is recognised on its own', () => {
  for (const [hex, name] of [['0x428A2F98', 'SHA-256'], ['0xd76aa478', 'MD5'], ['0x5a827999', 'SHA-1']]) {
    const { findings } = scanHandWrittenHash({ sources: [{ rel: 'synthetic.cjs', text: `const k = ${hex};` }] });
    assert.strictEqual(findings.length, 1, `${name}: ${findings}`);
  }
});

// ==========================================================================
// GUARD — NO HAND-WRITTEN BASE64 OR HEX CODEC IN SHIPPED CODE.
// ==========================================================================
//
// The same class one encoding over. node-shim carried five codecs: feross's base64-js under the bundle's Buffer,
// internal/buffer-lite.cjs's own alphabet, a base64url translate-and-rewrap layer, and hex loops in crypto, x509,
// string_decoder and both quaude-side digests (docs/superpowers/findings/2026-11-27-latent-capabilities-audit.md,
// D4). Under tjs they decoded a 10MB attachment's base64 in ~3.3s; the engine's native Uint8Array base64/hex does
// it in ~8ms, and libexec/node-shim/internal/codec.cjs is now the one place node's lenient rules sit on top of it.
// A codec cannot be written without its digit table, so the table is the thing banned: base64's alphabet (either
// variant shares the 62-character prefix) or the sixteen hex digits as one string.
const CODEC_TABLES = [
  { re: /ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789/, what: "base64's alphabet" },
  { re: /0123456789abcdef|0123456789ABCDEF/, what: 'a hex digit table' },
];

function scanHandWrittenCodec({ sources }) {
  const findings = [];
  for (const s of sources) {
    for (const k of CODEC_TABLES) {
      if (k.re.test(s.text)) findings.push(`${s.rel}: carries ${k.what}, a codec written in JS; encode and decode through Buffer, or libexec/node-shim/internal/codec.cjs inside the shim (native Uint8Array toBase64/fromBase64/toHex/fromHex)`);
    }
  }
  return { findings, examined: sources.length };
}

guardTests(defineGuard({
  name: 'no-hand-written-base64',
  floor: 80,
  read: readLibexecSources,
  scan: scanHandWrittenCodec,
  // the defect as it was: internal/buffer-lite.cjs's own encoder table
  control: () => ({ sources: [{ rel: 'libexec/node-shim/internal/buffer-lite.cjs', text: "const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';" }] }),
}));

test('no-hand-written-base64: each table is recognised on its own', () => {
  for (const t of ["'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'", "'0123456789abcdef'", '"0123456789ABCDEF"']) {
    const { findings } = scanHandWrittenCodec({ sources: [{ rel: 'synthetic.cjs', text: `const T = ${t};` }] });
    assert.strictEqual(findings.length, 1, `${t}: ${findings}`);
  }
});
