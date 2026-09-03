'use strict';
// THE ORACLE PROPERTY, ASSERTED.
//
// Two products are assembled from one Claude Code:
//
//   quaude   CC (Bun-built) -> bun-shim -> node API -> node-shim -> txiki/quickjs
//   naude    CC (Bun-built) -> bun-shim -> REAL NODE
//
// bun-shim rides in BOTH. node-shim rides ONLY in quaude. That single asymmetry is
// the whole reason naude is an ORACLE: a divergence visible under quaude and not
// under naude is isolated, by construction, to the node-on-quickjs layer. Every
// naude-vs-quaude differential in this repo spends its credibility on it —
// test/oracle-binaries.test.cjs, test/node-shim-roundtrip-oracle.test.cjs, the whole
// of test/fidelity/.
//
// Until this file, NOTHING asserted it. It held by construction, and only that:
// scripts/build-naude.mjs's naudeSeaConfig (:211) names five SEA assets and no
// node-shim is among them, and stagedBunShim (:232) takes the bun-shim from the same
// staged dir libexec/quaude-fuse.js reads. Both are deliberate; both are commented as
// deliberate; neither was checked.
//
// WHAT BREAKS WITHOUT THIS FILE, precisely: nothing goes red. A naude that quietly
// gained a node-shim would still build, still boot, still answer --version, still run
// a full -p turn, and still be diffed against quaude by every oracle we own — and
// every one of those diffs would silently stop isolating anything. The tests keep
// running; they just stop measuring. That is the worst failure shape this project
// has, and the most recently expensive one (2026-08-25: sixteen tests had been
// skipping in CI forever because their gate probed a directory the code never used,
// and four separate checks turned out to be measuring nothing).
//
// ---------------------------------------------------------------------------------
// WHAT IS CHECKED, AND HOW MUCH EACH PART IS WORTH
//
// 1. THE SHIPPED BYTES (the strong one, `auditNaude`). A built naude is a Node SEA:
//    postject stores node's SEA blob verbatim in the binary (Mach-O segment / ELF
//    section / PE resource — raw either way, so one byte scan reads all three). We
//    find that blob, parse its ASSET TABLE, and judge the artifact that ships:
//      * no asset may be named for the node-shim  (structural — catches a whole tree
//        riding along even if its contents were minified past recognition);
//      * no asset's BYTES, nor the SEA main code, may carry a node-shim marker
//        (semantic — catches a node-shim esbuilt INTO the entry bundle, where no
//        asset name would ever appear);
//      * there must be a `bun-shim.cjs` asset, and its bytes must actually be the
//        bun-shim, not an empty file that merely has the name.
//
// 2. THE ASSEMBLY CONTRACT (cheap, always available). A source-level check that
//    build-naude.mjs never names the node-shim tree at all. This proves LESS than it
//    looks: it is a check on the recipe, not on the cake. It cannot see a node-shim
//    that arrives through --bundle, through --nmdir, or through the staged --cli.
//    It is here because it costs nothing and runs on every host, including the ones
//    that cannot build a naude. The POSITIVE half of the recipe (bun-shim IS in the
//    member list, and it is the same staged shim quaude reads) is already covered by
//    test/naude-build.test.cjs; this file deliberately does not duplicate it and
//    covers the NEGATIVE half, which nothing else did.
//
// 3. THE MARKERS THEMSELVES. Every marker used above is asserted to name exactly one
//    shim: present in its own source, absent from the other's. This is not
//    ceremony — writing this file, `__tjs_fs_sync` was the obvious node-shim marker
//    and it is WRONG: libexec/bun-shim.cjs:1142 tests for it to detect that it is
//    running under tjs, so it appears in every naude ever built. A gate whose markers
//    drift is a gate that reports on nothing, which is the exact disease this file
//    exists to treat.
//
// WHAT THIS DOES NOT COVER.
//   * It does not build a naude. Where none exists it SKIPS, naming every path it
//     probed and the command that produces one. The red proofs and the marker and
//     contract checks still run, so the SCANNER is proven on every `npm test` even
//     when the shipped-bytes data point is missing.
//   * Content detection is marker-based, so it is a sieve, not a proof. A single
//     node-shim module with none of the markers in it (say modules/path.cjs alone)
//     would slip past the content half — the asset-NAME half is what catches the
//     realistic case, a whole tree carried by name.
//   * It says nothing about whether the bun-shim in the naude is the SAME bun-shim
//     the quaude got. stagedBunShim makes that true by construction and
//     test/naude-build.test.cjs asserts the resolution rule; proving it on the two
//     artifacts would need both built from one stage, which is oracle-binaries' job.
//   * It reads node's SEA blob layout, which is a node internal with no compatibility
//     promise. If a node bump changes it, this gate FAILS rather than skips: we found
//     an artifact and could not read it, and saying "skipped" to that would be the
//     lie this file is about.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { seaBin, artifactDir } = require('../scripts/platform-tag.cjs');

const REPO = path.resolve(__dirname, '..');
const BUN_SHIM = path.join(REPO, 'libexec', 'bun-shim.cjs');
const NODE_SHIM_DIR = path.join(REPO, 'libexec', 'node-shim');

// ---- markers -------------------------------------------------------------------
//
// Chosen to be unfakeable by coincidence: each is a whole statement or a whole
// error-message template, not a word. The test 'markers name exactly one shim'
// below holds them to that, in both directions.
const MARKERS = {
  // ALL of these must appear for a blob of bytes to count as the bun-shim. The
  // PROVIDES declaration is the shim's single source of intercepted-module truth
  // (see libexec/bun-shim.cjs's own header) and the two re-exports are how the rest
  // of the build reads it — they have survived every rewrite the file has had.
  bunShim: [
    'const PROVIDES = {',
    'module.exports.__hostModules = PROVIDES.hostModules;',
    'module.exports.__bunBuiltins = PROVIDES.bunBuiltins;',
  ],
  // ANY of these appearing in a naude is a violation. The first three are unique
  // lines of libexec/node-shim/loader.cjs; the fourth is the prefix every wall and
  // every module error in the tree is spelled with (18 of the 82 files carry it),
  // which is what makes it a net rather than a tripwire on one file.
  //
  // NOT USED, on purpose: '__tjs_fs_sync' (bun-shim.cjs:1142 reads it to detect tjs)
  // and the bare word 'node-shim' (bun-shim.cjs mentions it six times in comments,
  // and a real naude built 2026-07-27 contains three of them). Both would fire on
  // every naude ever built. The colon-space form does not: measured 0 hits in that
  // same 153MB artifact.
  nodeShim: [
    'node-shim: ${ns}.${String(prop)} not implemented',
    'node-shim: this tjs lacks the sync-fs patch',
    // WAS 'globalThis.__quaudeRequire = graphRequire;' until 2026-08-26, when the
    // graph-assets wrapper rewrote that assignment into a ternary and this file's own
    // self-check caught it on the first run after being ported out of an agent worktree.
    // That is the marker discipline working: the gate refused to run against a string
    // that no longer names anything, instead of passing while checking nothing.
    "const graphRequire = makeRequire('/quaude');",
    'node-shim: ',
  ],
};

function walkFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, out);
    else out.push(p);
  }
  return out;
}

// ---- node's SEA blob -------------------------------------------------------------
//
// Layout, read off node's SeaSerializer::Write and then VERIFIED empirically against
// (a) four blobs generated by the pinned node with different flag combinations and
// (b) the 33,613,424-byte sea-prep.blob of a real naude, which parses to its exact
// final byte:
//
//   u32   magic 0x0143da20
//   u32   flags   (1 = disableExperimentalSEAWarning, 4 = code cache, 8 = assets)
//   u8    one byte, constant 0x01 on every blob observed, flags-independent
//   str   code path      \
//   str   main code       |  each: u64 little-endian length, then that many bytes
//   str   code cache      /  (present only when flags & 4)
//   u64   asset count        (present only when flags & 8)
//   str,str * count          key then value
//
// That u8 is undocumented and unexplained, which is exactly why its width is
// DISCOVERED here instead of hardcoded: HEADER_WIDTHS is tried in turn and the first
// one that yields a fully self-consistent parse wins. A node bump that adds or drops
// a header field costs this file nothing; one that changes the string encoding makes
// every width fail, and the artifact test then goes RED with 'no readable blob',
// which is the honest answer.
const MAGIC = Buffer.from([0x20, 0xda, 0x43, 0x01]);
// 9 and 10 are both OBSERVED, from different node majors — node 24 emits a 9-byte
// header, node 26 a 10-byte one (magic u32 + flags u32, then 1 or 2 bytes before the
// u64-prefixed code path). The rest are cheap insurance. Order does not matter for
// correctness: parseSeaBlob's printable-ASCII check on the code path rejects every
// wrong width, and it was verified that a node-26 blob read at width 9 yields a
// length of 33536, past the 8192 bound, so it cannot false-positive.
//
// This list existing at all is why the node-26 bump cost one line instead of a
// rewrite: the file says the layout is "DISCOVERED here instead of hardcoded", and
// the widths are tried in turn precisely so a node bump lands as a new entry.
const HEADER_WIDTHS = [9, 10, 8, 12, 16];
const F_CODE_CACHE = 4;
const F_ASSETS = 8;

const printableAscii = (b) => b.every((c) => c >= 0x20 && c <= 0x7e);

// Parse one candidate blob starting at `start`. Returns null — never throws, never
// half-answers — if anything is out of range or implausible, so the caller can scan
// every occurrence of a 4-byte magic in a 150MB binary and keep only the real one.
function parseSeaBlob(buf, start, hdr) {
  if (start + hdr + 8 > buf.length) return null;
  if (buf.readUInt32LE(start) !== MAGIC.readUInt32LE(0)) return null;
  const flags = buf.readUInt32LE(start + 4);
  let o = start + hdr;
  const str = (maxLen) => {
    if (o + 8 > buf.length) return null;
    const n = Number(buf.readBigUInt64LE(o));
    o += 8;
    if (!Number.isSafeInteger(n) || n < 0 || o + n > buf.length) return null;
    if (maxLen !== undefined && (n === 0 || n > maxLen)) return null;
    const s = o;
    o += n;
    return { off: s, len: n };
  };
  // The code path is a real filesystem path: bounded, non-empty, printable. This one
  // check is what rejects every wrong header width (width 8 reads the u8 as part of
  // the length and lands on a NUL) without needing to know what the u8 is.
  const cp = str(8192);
  if (!cp || !printableAscii(buf.subarray(cp.off, cp.off + cp.len))) return null;
  const code = str();
  if (!code) return null;
  if (flags & F_CODE_CACHE && !str()) return null;
  const assets = [];
  if (flags & F_ASSETS) {
    if (o + 8 > buf.length) return null;
    const count = Number(buf.readBigUInt64LE(o));
    o += 8;
    if (!Number.isSafeInteger(count) || count < 1 || count > 4096) return null;
    for (let i = 0; i < count; i++) {
      const k = str(1024);
      if (!k || !printableAscii(buf.subarray(k.off, k.off + k.len))) return null;
      const v = str();
      if (!v) return null;
      assets.push({ key: buf.toString('utf8', k.off, k.off + k.len), off: v.off, len: v.len });
    }
  }
  return {
    start,
    hdr,
    flags,
    codePath: buf.toString('utf8', cp.off, cp.off + cp.len),
    code,
    assets,
    end: o,
  };
}

// Every distinct blob in `buf`. A naude has exactly one; anything else is reported
// rather than guessed at.
function findSeaBlobs(buf) {
  const out = [];
  for (let at = buf.indexOf(MAGIC); at >= 0; at = buf.indexOf(MAGIC, at + 1)) {
    for (const hdr of HEADER_WIDTHS) {
      const blob = parseSeaBlob(buf, at, hdr);
      if (blob) { out.push(blob); break; }
    }
  }
  return out;
}

// ---- the gate --------------------------------------------------------------------
//
// PURE: bytes in, list-of-problems out. Exported so the red proofs below drive the
// same function the artifact test does — a gate proven on a fixture but reached by a
// different code path on the real thing is two gates, one of them unproven.
function auditNaude(buf, { label = 'naude' } = {}) {
  const problems = [];
  const blobs = findSeaBlobs(buf);
  if (blobs.length === 0) {
    problems.push(`${label}: no readable node:sea blob. Either this is not a Node SEA, or node's `
      + "SEA blob layout changed under us — see this file's layout comment. It is NOT safe to "
      + 'read this as "no node-shim found".');
    return { problems, blob: null };
  }
  if (blobs.length > 1) {
    problems.push(`${label}: ${blobs.length} parseable SEA blobs at offsets `
      + `${blobs.map((b) => b.start).join(', ')} — cannot say which one ships.`);
  }
  const blob = blobs[0];
  const keys = blob.assets.map((a) => a.key);

  // (a) structural: nothing named for the node-shim.
  for (const key of keys) {
    if (/node[-_]?shim/i.test(key)) {
      problems.push(`${label}: SEA asset '${key}' is a node-shim member. naude runs on REAL node; `
        + 'the node-shim belongs to quaude ALONE, and a naude that carries one is no longer an '
        + 'oracle for it.');
    }
  }

  // (b) positive: the bun-shim is really in there, by content and not just by name.
  const bunShim = blob.assets.find((a) => a.key === 'bun-shim.cjs');
  if (!bunShim) {
    problems.push(`${label}: no 'bun-shim.cjs' SEA asset. Assets are: ${keys.join(', ') || '(none)'}. `
      + 'Both products bake the bun-shim (scripts/build-naude.mjs naudeSeaConfig); without it in '
      + 'naude there is no shared layer left for a differential to hold constant.');
  } else {
    const body = buf.subarray(bunShim.off, bunShim.off + bunShim.len);
    const missing = MARKERS.bunShim.filter((m) => !body.includes(m));
    if (missing.length) {
      problems.push(`${label}: the 'bun-shim.cjs' asset (${bunShim.len} bytes) does not look like the `
        + `bun-shim — missing ${missing.map((m) => JSON.stringify(m)).join(', ')}. An asset with the `
        + 'right NAME and the wrong contents is the same false green as no asset at all.');
    }
  }

  // (c) semantic: no node-shim source anywhere in the payload, asset or entry bundle.
  const regions = [
    { what: 'the SEA main code (the esbuilt naude-entry bundle)', off: blob.code.off, len: blob.code.len },
    ...blob.assets.map((a) => ({ what: `SEA asset '${a.key}'`, off: a.off, len: a.len })),
  ];
  for (const r of regions) {
    const body = buf.subarray(r.off, r.off + r.len);
    for (const m of MARKERS.nodeShim) {
      if (body.includes(m)) {
        problems.push(`${label}: ${r.what} contains the node-shim marker ${JSON.stringify(m)}. `
          + 'That layer exists only under quaude; its presence here breaks the isolation every '
          + 'naude-vs-quaude differential depends on.');
      }
    }
  }
  return { problems, blob };
}

// ---- finding a built naude -------------------------------------------------------
//
// Probes the places a naude ACTUALLY lands, resolved through the same module the
// build resolves them with (scripts/platform-tag.cjs), never a hand-copied path
// shape. The 2026-08-25 lesson is exactly this: a gate that probes a directory the
// code never writes skips forever and looks fine doing it. Every probe is returned,
// found or not, so the skip message can name all of them.
function probeNaude(repo = REPO, env = process.env) {
  const probed = [];
  const add = (where, p) => probed.push({ where, path: p, exists: !!p && fs.existsSync(p) });

  add('CLODE_NAUDE_BIN', env.CLODE_NAUDE_BIN || null);
  // build-naude.mjs's own default --out (buildBinary: seaBin(REPO, 'naude')).
  add("build-naude.mjs's default --out", seaBin(repo, 'naude', { env }));
  // Any other artifact dir in this checkout: CLODE_ASSET_NAME renames the whole dir
  // per CI leg (see artifactDir), so the default above is one name among several.
  const buildDir = path.dirname(artifactDir(repo, { env }));
  let dirs = [];
  try { dirs = fs.readdirSync(buildDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); }
  catch { dirs = null; }
  if (dirs === null) {
    probed.push({ where: `every artifact dir under ${buildDir}`, path: null, exists: false, note: 'no build/ directory' });
  } else {
    const before = probed.length;
    for (const d of dirs.sort()) {
      for (const base of ['naude', 'naude.exe']) {
        const p = path.join(buildDir, d, base);
        if (fs.existsSync(p)) add(`artifact dir build/${d}`, p);
      }
    }
    // Say the sweep HAPPENED even when it found nothing. "The probe is not in the
    // list" and "the probe found nothing" have to look different, or a future reader
    // debugging a permanent skip cannot tell which one they are looking at — which is
    // the whole shape of the 2026-08-25 sixteen-skipped-tests bug.
    if (probed.length === before) {
      probed.push({
        where: `every artifact dir under ${buildDir}`,
        path: null,
        exists: false,
        note: `swept ${dirs.length} dir(s), none contained naude/naude.exe`,
      });
    }
  }
  const hit = probed.find((p) => p.exists);
  return { bin: hit ? hit.path : null, probed };
}

function skipMessage({ probed }) {
  const lines = probed.map((p) => `    - ${p.where}: ${p.path || `(${p.note || 'unset'})`}`
    + (p.path ? (p.exists ? ' [FOUND]' : ' [absent]') : ''));
  return 'no built naude to inspect — the SHIPPED-BYTES half of this gate did not run.\n'
    + '  Probed, in order:\n' + lines.join('\n') + '\n'
    + '  To run it, build one (isolated from the shared store, per this repo\'s convention):\n'
    + '    CLODE_DEPS=$(mktemp -d) CLODE_CACHE=$(mktemp -d) \\\n'
    + '      node bin/clode build --naude --out /tmp/naude\n'
    + '    CLODE_NAUDE_BIN=/tmp/naude node --test test/naude-shim-boundary.test.cjs\n'
    + '  (needs Node >= 24 and a Bun-packaged Claude Code provider.)\n'
    + '  Everything else in this file — the marker checks, the assembly contract, and the\n'
    + '  five red proofs against real node-generated SEA blobs — DID run.';
}

// ---- fixtures for the red proofs -------------------------------------------------
//
// A REAL blob, made by the pinned node's own `--experimental-sea-config`, wrapped in
// filler so the scan step is exercised too. Real and not hand-encoded on purpose: a
// fixture written by this file's own understanding of the format would prove the
// parser agrees with itself and nothing more. This way a node bump that changes the
// layout turns these red immediately, on every host, instead of waiting for someone
// to have a naude lying around.
function seaFixture(assets) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'naude-boundary-'));
  const main = path.join(dir, 'main.js');
  fs.writeFileSync(main, 'console.log("fixture");\n');
  const assetPaths = {};
  Object.entries(assets).forEach(([key, body], i) => {
    const f = path.join(dir, `asset-${i}`);
    fs.writeFileSync(f, body);
    assetPaths[key] = f;
  });
  const cfg = {
    main,
    output: path.join(dir, 'sea-prep.blob'),
    disableExperimentalSEAWarning: true,
    assets: assetPaths,
  };
  const cfgPath = path.join(dir, 'sea-config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  execFileSync(process.execPath, ['--experimental-sea-config', cfgPath], { stdio: 'pipe' });
  const blob = fs.readFileSync(cfg.output);
  fs.rmSync(dir, { recursive: true, force: true });
  // Filler stands in for the embedded node a real naude wraps the blob in. 0x00/0xff
  // never spells the magic, so the scan has to find the blob the honest way.
  const filler = Buffer.alloc(4096, 0xff);
  return Buffer.concat([filler, blob, filler]);
}

const realBunShim = () => fs.readFileSync(BUN_SHIM);
const realNodeShimLoader = () => fs.readFileSync(path.join(NODE_SHIM_DIR, 'loader.cjs'));

// ==================================================================================
// 1. the markers
// ==================================================================================

test('markers name exactly one shim — neither set can fire on the other', () => {
  const bunSrc = fs.readFileSync(BUN_SHIM, 'utf8');
  const shimFiles = walkFiles(NODE_SHIM_DIR).map((f) => [f, fs.readFileSync(f, 'utf8')]);
  const problems = [];

  for (const m of MARKERS.bunShim) {
    if (!bunSrc.includes(m)) problems.push(`bun-shim marker ${JSON.stringify(m)} is no longer in libexec/bun-shim.cjs`);
    const bleed = shimFiles.filter(([, s]) => s.includes(m)).map(([f]) => path.relative(REPO, f));
    if (bleed.length) problems.push(`bun-shim marker ${JSON.stringify(m)} also appears in the node-shim: ${bleed.join(', ')}`);
  }
  for (const m of MARKERS.nodeShim) {
    const home = shimFiles.filter(([, s]) => s.includes(m)).map(([f]) => path.relative(REPO, f));
    if (!home.length) problems.push(`node-shim marker ${JSON.stringify(m)} is no longer anywhere under libexec/node-shim/`);
    if (bunSrc.includes(m)) {
      problems.push(`node-shim marker ${JSON.stringify(m)} ALSO appears in libexec/bun-shim.cjs — it would `
        + 'fire on every naude ever built. This is not hypothetical: __tjs_fs_sync is exactly this bug.');
    }
  }
  assert.deepStrictEqual(problems, [],
    `\n\n${problems.join('\n')}\n\nA marker that has drifted makes this whole gate report on nothing. `
    + 'Fix the marker, do not delete the check.\n');
});

// ==================================================================================
// 2. the assembly contract (source level — cheap, runs everywhere)
// ==================================================================================

// The NEGATIVE half only. naude-build.test.cjs already asserts the positive (bun-shim
// is in naudeSeaConfig's assets, and stagedBunShim resolves it to the same staged dir
// quaude-fuse.js reads); duplicating it here would just give the same fact two votes.
test('build-naude.mjs never names the node-shim tree', () => {
  const src = fs.readFileSync(path.join(REPO, 'scripts', 'build-naude.mjs'), 'utf8');
  const hits = src.split('\n')
    .map((line, i) => [i + 1, line])
    .filter(([, line]) => /node-shim/.test(line));
  assert.deepStrictEqual(hits, [],
    `\n\nscripts/build-naude.mjs names the node-shim at ${hits.map(([n]) => n).join(', ')}:\n`
    + hits.map(([n, l]) => `  ${n}: ${l.trim()}`).join('\n')
    + '\n\nnaude runs on REAL node. If a node-shim is genuinely needed there, the naude-vs-quaude\n'
    + 'differential stops isolating the node-on-quickjs layer and every oracle built on it needs\n'
    + 'rewriting — say so out loud before relaxing this.\n');
});

test('the shipped naude asset list, as build-naude declares it, has no node-shim member', async () => {
  const { naudeSeaConfig } = await import('../scripts/build-naude.mjs');
  const cfg = naudeSeaConfig({
    mainBundle: '/b/entry.js', cliCjs: '/stage/cli.cjs', bunShim: '/stage/bun-shim.cjs',
    tar: '/o/deps.tar', sig: '/o/deps.sig', out: '/o', targetUpdateCheck: '/lx/target-update-check.cjs',
  });
  const offenders = Object.entries(cfg.assets).filter(([k, v]) => /node[-_]?shim/i.test(k) || /node[-_]?shim/i.test(String(v)));
  assert.deepStrictEqual(offenders, [],
    `naude declares node-shim assets: ${JSON.stringify(offenders)}`);
});

// ==================================================================================
// 3. the red proofs — the gate, driven red, on real SEA blobs
// ==================================================================================

test('GREEN control: a shim-boundary-correct SEA passes', () => {
  const buf = seaFixture({
    'deps.tar': 'not-really-a-tar',
    'bun-shim.cjs': realBunShim(),
    'cli.cjs': '// baked Claude Code\n',
    'target-update-check.cjs': '// notify-only\n',
  });
  const { problems, blob } = auditNaude(buf, { label: 'fixture' });
  assert.deepStrictEqual(problems, [], `the control fixture must pass, else every red below is meaningless:\n${problems.join('\n')}`);
  // and the parse really read the artifact, rather than passing by finding nothing
  assert.deepStrictEqual(blob.assets.map((a) => a.key).sort(),
    ['bun-shim.cjs', 'cli.cjs', 'deps.tar', 'target-update-check.cjs']);
});

test('RED: a naude carrying a node-shim asset fails, and the message says which asset', () => {
  const buf = seaFixture({
    'bun-shim.cjs': realBunShim(),
    'cli.cjs': '// baked Claude Code\n',
    'node-shim/loader.cjs': realNodeShimLoader(),
  });
  const { problems } = auditNaude(buf, { label: 'fixture' });
  assert.ok(problems.length >= 2, `expected the name AND content detectors to fire; got:\n${problems.join('\n')}`);
  assert.ok(problems.some((p) => /asset 'node-shim\/loader\.cjs' is a node-shim member/.test(p)),
    `no by-name detection:\n${problems.join('\n')}`);
  assert.ok(problems.some((p) => /contains the node-shim marker/.test(p)),
    `no by-content detection:\n${problems.join('\n')}`);
  assert.ok(problems.every((p) => /oracle|isolation/.test(p)),
    `every problem must say what it costs us:\n${problems.join('\n')}`);
});

test('RED: a node-shim smuggled in under an innocent asset name still fails', () => {
  // The case the asset-NAME check cannot see, and the reason the content check exists:
  // a node-shim that arrives with no telltale name at all.
  const buf = seaFixture({
    'bun-shim.cjs': realBunShim(),
    'cli.cjs': Buffer.concat([Buffer.from('// baked Claude Code\n'), realNodeShimLoader()]),
  });
  const { problems } = auditNaude(buf, { label: 'fixture' });
  assert.ok(problems.some((p) => /SEA asset 'cli\.cjs' contains the node-shim marker/.test(p)),
    `expected the content detector to catch a renamed node-shim; got:\n${problems.join('\n')}`);
});

test('RED: a naude with no bun-shim asset fails, and the message lists what it did carry', () => {
  const buf = seaFixture({ 'cli.cjs': '// baked Claude Code\n', 'deps.sig': 'sig\n' });
  const { problems } = auditNaude(buf, { label: 'fixture' });
  assert.strictEqual(problems.length, 1, problems.join('\n'));
  assert.match(problems[0], /no 'bun-shim\.cjs' SEA asset/);
  assert.match(problems[0], /Assets are: cli\.cjs, deps\.sig|Assets are: deps\.sig, cli\.cjs/);
});

test('RED: a bun-shim.cjs asset that is not the bun-shim fails — the name is not the check', () => {
  const buf = seaFixture({ 'bun-shim.cjs': '// TODO: put the shim here\n', 'cli.cjs': '// cc\n' });
  const { problems } = auditNaude(buf, { label: 'fixture' });
  assert.strictEqual(problems.length, 1, problems.join('\n'));
  assert.match(problems[0], /does not look like the bun-shim/);
  assert.match(problems[0], /const PROVIDES/);
});

test('RED: bytes with no readable SEA blob fail LOUDLY rather than reading as "clean"', () => {
  const { problems } = auditNaude(Buffer.alloc(65536, 0xff), { label: 'fixture' });
  assert.strictEqual(problems.length, 1, problems.join('\n'));
  assert.match(problems[0], /no readable node:sea blob/);
  assert.match(problems[0], /NOT safe to read this as "no node-shim found"/);
});

// ==================================================================================
// 4. the shipped bytes
// ==================================================================================

test('a built naude contains the bun-shim and NO node-shim', (t) => {
  const found = probeNaude();
  if (!found.bin) { t.skip(skipMessage(found)); return; }
  const buf = fs.readFileSync(found.bin);
  const { problems, blob } = auditNaude(buf, { label: found.bin });
  assert.deepStrictEqual(problems, [],
    `\n\n${problems.join('\n\n')}\n\nThis is the invariant naude's whole value as an oracle rests on.\n`);
  // Not a formality: a "pass" reached without ever reading an asset table would be the
  // false green this file exists to prevent. Say out loud what was inspected.
  assert.ok(blob.assets.length >= 3,
    `only ${blob.assets.length} SEA assets in ${found.bin} — that is not a naude`);
  assert.ok(blob.assets.some((a) => a.key === 'cli.cjs'),
    `${found.bin} has no baked cli.cjs asset — a naude bakes Claude Code in; this is something else`);
});

module.exports = { MARKERS, parseSeaBlob, findSeaBlobs, auditNaude, probeNaude, seaFixture };
