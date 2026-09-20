'use strict';
// scripts/bootstrap-engine.sh — the OFFLINE half of its gate.
//
// WHAT THE RESOLVER IS FOR. `scripts/build-tjs.cjs` is about to stop being run by
// node, which means the machine that builds an engine needs an engine already. On a
// tjs-cache MISS a leg has none. The mechanism to fix that already ships: release.yml's
// `templates-pack` job publishes ONE blob of gzip'd bare tjs engines plus a manifest
// giving {offset,length,sha256} per target, covering every leg — because the set of
// machines that build an engine IS the set of legs. The resolver range-fetches one
// slice out of that blob and hands back a path.
//
// THE RULE THAT MUST NOT EROTE: the resolver may NOT live inside build-tjs.cjs. That
// is the program being bootstrapped; a bootstrap that imports its own target is not a
// bootstrap. Pinned below.
//
// THE TRAP THIS FILE EXISTS TO AVOID. The obvious acceptance check for "is this
// downloaded engine good enough for HEAD?" is `manifest.tjsPin == our pin`. It is
// VACUOUS: scripts/templates-drift.mjs:15-20 records that the txiki pin has not moved
// since 2026-07-06 while the patch stack moves weekly, so that comparison passes on a
// three-week-old engine that is missing every fix since. Acceptance here is
// scripts/engine-api-floor.cjs's real probe reporting `tjs-shim-ok` instead, and the
// token is read FROM that module rather than spelled twice (pinned below).
//
// AND THE SECOND ONE. The base case — a brand-new alpine arch or VM guest OS with no
// published slice — must be DERIVED from the pinned manifest ("is <target> in the
// pack?"), never declared. This repo has been bitten three times by a hand-maintained
// list going stale; engine-recipe.mjs's FILES is derived for exactly that reason. The
// fallback-set test below pins the derived set against the manifest so a hand-added
// `bootstrap: node` flag, reached for to dodge a real failure, goes red.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { defineGuard, guardTests } = require('./guard.cjs');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const REPO = path.join(__dirname, '..');
const SH = path.join(REPO, 'scripts', 'bootstrap-engine.sh');
const MANIFEST = path.join(REPO, 'scripts', 'bootstrap-engine.manifest.json');
const { OK_TOKEN } = require('../scripts/engine-api-floor.cjs');
const canon = require('../scripts/canonical-name.cjs');
const { clodeCacheDir } = require('../libexec/clode-paths.cjs');

// Every run gets a HERMETIC environment: no ambient CLODE_TJS (run.mjs sets one for the
// whole suite), no ambient cache, no ambient release base. A resolver test that
// accidentally inherits the box's real engine proves nothing about resolution ORDER.
function sh(args, env = {}, shell = '/bin/sh') {
  const base = { ...process.env };
  for (const k of ['CLODE_TJS', 'CLODE_TJS_OUT', 'CLODE_CACHE', 'CLODE_STATE_ROOT',
    'CLODE_RELEASE_BASE', 'CLODE_SHA256', 'CLODE_BOOTSTRAP_TARGET',
    'CLODE_BOOTSTRAP_MANIFEST']) delete base[k];
  // Step 2 asks scripts/platform-tag.cjs where a LOCALLY BUILT engine would be, and on
  // this box one really is there (run.mjs resolved the suite's CLODE_TJS from it). A
  // resolution-order test that inherits it proves nothing, so every run gets its own
  // empty build scratch — the same override CI uses — unless the case sets one.
  base.CLODE_BUILD_SCRATCH = mkdtemp();
  const r = spawnSync(shell, [SH, ...args], { env: { ...base, ...env }, encoding: 'utf8' });
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

const mkdtemp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'clode-bootstrap-'));
// A stand-in for an executable engine. Resolution ORDER is about which PATH wins, so
// these never need to be a real tjs — the tests that need a real one say so.
function fakeExe(p, body = '#!/bin/sh\nexit 0\n') {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  fs.chmodSync(p, 0o755);
  return p;
}

const manifest = () => JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const hostTarget = () => `${canon.canonOs(process.platform === 'win32' ? 'windows' : process.platform)}-${canon.canonArch(process.arch)}`;

// ---------------------------------------------------------------------------
// The structural rules.
// ---------------------------------------------------------------------------

// These four rules are what make the resolver the thing it claims to be, and all four
// are read off an artifact this file did not write — so they are a GUARD, with a control
// that proves each one can actually fire (test/guard.cjs). A structural rule nobody has
// watched fail is a rule that might already be blind.
const BASHISMS = [
  [/^\s*\[\[/m, '[[ ]] test'], [/^\s*local\s/m, '`local`'], [/^\s*declare\s/m, '`declare`'],
  [/^\s*function\s+[A-Za-z_]/m, '`function` keyword'],
  [/\$\{[A-Za-z_][A-Za-z0-9_]*\[/, 'array subscript'], [/\[\s[^\]\n]*\s==\s/, '`==` inside a test(1)'],
];

const SHAPE_GUARD = defineGuard({
  name: 'bootstrap-resolver-shape',
  floor: 8,
  read: () => ({
    sh: fs.readFileSync(SH, 'utf8'),
    executable: (fs.statSync(SH).mode & 0o111) !== 0,
    buildTjs: fs.readFileSync(path.join(REPO, 'scripts', 'build-tjs.cjs'), 'utf8'),
    okToken: OK_TOKEN,
  }),
  scan: (i) => {
    const f = [];
    let examined = 0;
    const rule = (ok, finding) => { examined += 1; if (!ok) f.push(finding); };
    rule(/^#!\/bin\/sh$/.test(i.sh.split('\n')[0]),
      'the resolver is not #!/bin/sh — it runs in alpine and in minimal VM guests where '
      + 'bash may be absent');
    rule(i.executable, 'the resolver is not executable');
    // dash/ash are the real floor, and /bin/sh behaviours vary; bash-only syntax here is
    // a failure that only shows up on the guest that has no bash. ONE rule with six
    // spellings — counting each spelling would inflate `examined` with variants of the
    // same question, which is the opposite of what an examined count is for.
    const bashisms = BASHISMS.filter(([re]) => re.test(i.sh)).map(([, what]) => what);
    rule(bashisms.length === 0,
      `bash-only syntax (${bashisms.join(', ')}) in a file that must run under dash/ash`);
    rule(!/bootstrap-engine\.sh/.test(i.buildTjs),
      'scripts/build-tjs.cjs names the resolver. It is the program being bootstrapped: a '
      + 'bootstrap that its own target invokes cannot run on the cache miss it exists for. '
      + 'The resolver belongs in the CALLER.');
    rule(/`?build-tjs\.cjs`? must never call this/.test(i.sh),
      "the rule is not written where the next reader is: in the resolver's own header");
    rule(i.sh.includes(i.okToken),
      `the resolver must accept on ${i.okToken}, the token scripts/engine-api-floor.cjs emits`);
    rule(i.sh.includes('engine-api-floor'),
      'the resolver must GENERATE its check from scripts/engine-api-floor.cjs — a second '
      + 'hand-written copy of the binding list is the exact disease that module ended');
    rule(!/tjsPin/.test(i.sh),
      'a tjsPin comparison passes VACUOUSLY (the pin has not moved since 2026-07-06 while '
      + 'the patch stack moves weekly) — it is a gate that cannot fail, not acceptance');
    return { findings: f, examined };
  },
  // Every rule violated at once, so a scan that has gone blind on ANY of them shows up
  // as a shortfall rather than a pass.
  control: () => ({
    sh: '#!/bin/bash\nif [[ -n "$x" ]]; then :; fi\n# compares tjsPin and calls it a day\n',
    executable: false,
    buildTjs: "require('child_process').execFileSync('scripts/bootstrap-engine.sh');\n",
    okToken: OK_TOKEN,
  }),
});

guardTests(SHAPE_GUARD);

// ---------------------------------------------------------------------------
// Resolution order. Each step is proven to WIN over the one below it.
// ---------------------------------------------------------------------------

test('1. CLODE_TJS wins over everything below it', () => {
  const d = mkdtemp();
  const want = fakeExe(path.join(d, 'env-tjs'));
  const r = sh(['--plan'], { CLODE_TJS: want, CLODE_TJS_OUT: fakeExe(path.join(d, 'out-tjs')), CLODE_CACHE: d });
  assert.strictEqual(r.status, 0, r.err);
  assert.strictEqual(r.out, `env ${want}`);
});

test('1b. CLODE_TJS that is not executable is REFUSED, not silently skipped', () => {
  const d = mkdtemp();
  const p = path.join(d, 'not-exec');
  fs.writeFileSync(p, 'x');
  const r = sh(['--plan'], { CLODE_TJS: p });
  assert.strictEqual(r.status, 1, `expected a refusal, got ${r.status}: ${r.out}`);
  assert.match(r.err, /CLODE_TJS/);
  assert.match(r.err, new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'the refusal must name the path that was set, or the operator cannot see their typo');
});

test('2. a locally built engine (CLODE_TJS_OUT) comes next', () => {
  const d = mkdtemp();
  const want = fakeExe(path.join(d, 'out-tjs'));
  const r = sh(['--plan'], { CLODE_TJS_OUT: want, CLODE_CACHE: d });
  assert.strictEqual(r.status, 0, r.err);
  assert.strictEqual(r.out, `local ${want}`);
});

test('3. the bootstrap cache comes next, at the path clode-paths.cjs owns', () => {
  const d = mkdtemp();
  const cacheRoot = path.join(d, 'cache');
  const tag = manifest().bootstrapTag;
  const target = hostTarget();
  const want = fakeExe(path.join(cacheRoot, 'bootstrap', tag, target, 'tjs'));
  const r = sh(['--plan'], { CLODE_CACHE: cacheRoot });
  assert.strictEqual(r.status, 0, r.err);
  assert.strictEqual(r.out, `cache ${want}`);
});

test('the cache root is clode-paths.cjs\'s, not a fourth spelling of XDG', () => {
  const d = mkdtemp();
  for (const env of [
    { CLODE_CACHE: path.join(d, 'explicit') },
    { CLODE_STATE_ROOT: path.join(d, 'state') },
    { XDG_CACHE_HOME: path.join(d, 'xdg') },
    { HOME: path.join(d, 'home'), XDG_CACHE_HOME: '' },
  ]) {
    const r = sh(['--print-cache'], env);
    assert.strictEqual(r.status, 0, r.err);
    const expected = clodeCacheDir({ ...env });
    assert.strictEqual(r.out, expected,
      `sh and libexec/clode-paths.cjs disagree about the cache root for ${JSON.stringify(env)}`);
  }
});

test('4. with nothing local, it plans a range-fetch of the pinned slice', () => {
  const d = mkdtemp();
  const m = manifest();
  const r = sh(['--plan'], { CLODE_CACHE: d });
  assert.strictEqual(r.status, 0, r.err);
  assert.strictEqual(r.out, `fetch ${hostTarget()} ${m.bootstrapTag}`);
});

test('the host target is the ONE canonical vocabulary, not a private uname table', () => {
  const r = sh(['--print-target'], {});
  assert.strictEqual(r.status, 0, r.err);
  assert.strictEqual(r.out, hostTarget(),
    'the resolver derives <os>-<arch> from uname; it must land on exactly the spelling '
    + 'scripts/canonical-name.cjs produces, or it will ask the pack for a target that '
    + 'does not exist');
  // And an explicit target overrides, because CI knows its leg better than uname does.
  assert.strictEqual(sh(['--print-target'], { CLODE_BOOTSTRAP_TARGET: 'haiku-amd64' }).out, 'haiku-amd64');
});

test('a FOREIGN target never resolves to this host\'s own engine', () => {
  // Found by running the thing: `--plan` for linux-amd64 on this Mac answered with the
  // Mac's own scratch engine. Steps 1 and 2 both name a HOST-NATIVE binary, and the
  // design's call site #7 is exactly the case that breaks on -- the ubuntu runner fetches
  // a NetBSD or Haiku guest's slice INTO the workspace for the guest to use. Handing that
  // fetch the runner's own x86-64 ELF would rsync a binary into a guest that cannot run
  // it, and the failure would land inside the VM, far from here.
  const d = mkdtemp();
  const hostish = fakeExe(path.join(d, 'host-tjs'));
  const foreign = 'haiku-amd64';
  assert.notStrictEqual(foreign, hostTarget(), 'fixture invalid: pick a target this box is not');
  const r = sh(['--plan'], {
    CLODE_TJS: hostish, CLODE_TJS_OUT: hostish, CLODE_CACHE: d, CLODE_BOOTSTRAP_TARGET: foreign,
  });
  assert.strictEqual(r.status, 0, r.err);
  assert.strictEqual(r.out, `fetch ${foreign} ${manifest().bootstrapTag}`,
    'an engine for THIS host is not an engine for the target that was asked for');
  assert.match(r.err, /haiku-amd64/,
    'and it must say out loud that it is ignoring the host engines, naming the target — a '
    + 'silently ignored CLODE_TJS is how a build ends up testing a binary nobody chose');
});

// ---------------------------------------------------------------------------
// The base case, DERIVED.
// ---------------------------------------------------------------------------

test('a target absent from the pinned pack falls back, loudly, and says it is EXPECTED', () => {
  const d = mkdtemp();
  const m = manifest();
  const absent = 'linux-brandnewarch';
  assert.ok(!(absent in m.targets), 'fixture invalid: that target is in the pack');
  const r = sh(['--plan'], { CLODE_CACHE: d, CLODE_BOOTSTRAP_TARGET: absent });
  assert.strictEqual(r.status, 3,
    'fallback is its own exit status, distinct from a refusal (1) — the caller has to be '
    + 'able to tell "build it under node this once" from "something is wrong"');
  assert.strictEqual(r.out, `fallback ${absent} ${m.bootstrapTag}`);
  assert.match(r.err, /FIRST engine under node/,
    'the loud line must say this leg is building its first engine under node');
  assert.match(r.err, /self-host|next release/,
    'and that it self-hosts from the next release — otherwise whoever hits it reads a '
    + 'normal, expected base case as a broken build');
  assert.ok(r.err.includes(absent) && r.err.includes(m.bootstrapTag),
    'and it must name the target and the pinned tag it looked in');
});

test('the fallback set is EXACTLY the leg targets absent from the pinned pack', async () => {
  const { legsFor } = await import('../scripts/tjs-legs.mjs');
  const m = manifest();
  const pack = new Set(Object.keys(m.targets));
  const legTargets = [...new Set(legsFor('release').map((l) => canon.targetName(l.leg)))].sort();
  // DERIVED, not declared: this is the whole point. Whatever the manifest lacks is what
  // falls back — nothing else may, and nothing that it has may.
  const expectedFallback = legTargets.filter((t) => !pack.has(t));
  const d = mkdtemp();
  const observed = [];
  for (const t of legTargets) {
    const r = sh(['--plan'], { CLODE_CACHE: d, CLODE_BOOTSTRAP_TARGET: t });
    assert.ok([0, 3].includes(r.status), `${t}: unexpected status ${r.status}: ${r.err}`);
    if (r.status === 3) observed.push(t);
    else assert.strictEqual(r.out, `fetch ${t} ${m.bootstrapTag}`, `${t}: ${r.out}`);
  }
  assert.deepStrictEqual(observed, expectedFallback,
    'the set of targets the resolver falls back for must equal the set the pinned pack '
    + 'lacks. If these differ, someone has hand-added (or hand-removed) a fallback — which '
    + 'is how a real failure gets dodged and a permanent carve-out gets born.');
  assert.ok(legTargets.length >= 40,
    `examined only ${legTargets.length} leg targets — the derivation is blind, not clean`);
});

// ---------------------------------------------------------------------------
// The fetch path, against a local base. No network.
// ---------------------------------------------------------------------------

// A fake pack: one gzip member per target, at the offsets a fake manifest records.
// The resolver reads the COMMITTED manifest, so the local base here is pointed at by
// CLODE_RELEASE_BASE and the manifest is overridden with a fixture of the same shape.
function localPack(dir, members) {
  const parts = [];
  const targets = {};
  let offset = 0;
  for (const [name, bytes] of Object.entries(members)) {
    const gz = zlib.gzipSync(Buffer.from(bytes));
    parts.push(gz);
    targets[name] = {
      tag: name,
      engine: `tjs-${name}-fixture`,
      sha256: crypto.createHash('sha256').update(Buffer.from(bytes)).digest('hex'),
      verified: 'smoke',
      offset,
      length: gz.length,
    };
    offset += gz.length;
  }
  const blob = 'templates-fixture';
  fs.mkdirSync(path.join(dir, 'vFIXTURE'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'vFIXTURE', blob), Buffer.concat(parts));
  const mf = path.join(dir, 'fixture-manifest.json');
  fs.writeFileSync(mf, JSON.stringify({ schema: 2, bootstrapTag: 'vFIXTURE', tjsPin: 'fixture', blob, targets }, null, 2));
  return { manifest: mf, base: dir };
}

// An "engine" that answers the two calls the acceptance probe makes: generate the check
// (which it does by deferring to the real node, because the point under test here is the
// sh plumbing, not the loader), then run it.
const FAKE_ENGINE = (token, rc = 0) => `#!/bin/sh
# A stand-in tjs. It answers the two calls the acceptance probe makes:
#   tjs run <loader.cjs> <engine-api-floor.cjs> --emit-check   -> the check's TEXT
#   tjs run <the check>                                        -> its verdict
[ "$1" = run ] || exit 2
case "$2" in
  *loader.cjs) echo "// generated floor check" ;;
  *) printf '%s\\n' ${JSON.stringify(token)}; exit ${rc} ;;
esac
exit 0
`;

test('a fetched slice is gunzipped, sha-verified, cached and accepted', () => {
  const d = mkdtemp();
  const body = FAKE_ENGINE(OK_TOKEN);
  const { manifest: mf, base } = localPack(path.join(d, 'base'), { [hostTarget()]: body });
  const cache = path.join(d, 'cache');
  const r = sh([], {
    CLODE_CACHE: cache,
    CLODE_RELEASE_BASE: base,
    CLODE_BOOTSTRAP_MANIFEST: mf,
  });
  assert.strictEqual(r.status, 0, `${r.err}\n${r.out}`);
  const cached = path.join(cache, 'bootstrap', 'vFIXTURE', hostTarget(), 'tjs');
  assert.strictEqual(r.out, cached, 'the resolver prints the cached path and nothing else');
  assert.ok(fs.existsSync(cached), 'the verified slice must be cached for the next run');
  assert.ok((fs.statSync(cached).mode & 0o111) !== 0, 'and chmod +x, or the next step exits 126');
  assert.strictEqual(fs.readFileSync(cached, 'utf8'), body, 'the cached bytes are the inflated engine');
});

test("a FOREIGN target's slice is fetched and verified, but acceptance is DEFERRED, loudly", () => {
  // The design's call site #7: the ubuntu runner fetches a guest's slice into the
  // workspace and the guest runs it. The floor probe cannot run here — these bytes are
  // for another machine — so it must not silently not-run either. It says so, and the
  // machine that will run the engine resolves through this same script, where the probe
  // DOES fire because the target is its own.
  const d = mkdtemp();
  const foreign = 'haiku-amd64';
  assert.notStrictEqual(foreign, hostTarget());
  const marker = path.join(d, 'it-ran');
  const body = `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 0\n`;
  const { manifest: mf, base } = localPack(path.join(d, 'base'), { [foreign]: body });
  const cache = path.join(d, 'cache');
  const r = sh([], {
    CLODE_CACHE: cache, CLODE_RELEASE_BASE: base,
    CLODE_BOOTSTRAP_TARGET: foreign, CLODE_BOOTSTRAP_MANIFEST: mf,
  });
  assert.strictEqual(r.status, 0, `${r.err}\n${r.out}`);
  assert.strictEqual(r.out, path.join(cache, 'bootstrap', 'vFIXTURE', foreign, 'tjs'));
  assert.ok(!fs.existsSync(marker),
    'the resolver EXECUTED a binary built for another machine — on a real cross fetch that '
    + 'is an exec format error at best and the wrong architecture running at worst');
  assert.match(r.err, /floor/i);
  assert.ok(r.err.includes(foreign) && r.err.includes(hostTarget()),
    'the deferral must name both machines, or a reader cannot tell which one owes the check');
});

test('a sha256 mismatch is REFUSED, naming the target and both digests', () => {
  const d = mkdtemp();
  const { manifest: mf, base } = localPack(path.join(d, 'base'), { [hostTarget()]: FAKE_ENGINE(OK_TOKEN) });
  // Corrupt the manifest's expectation, which is the same failure as corrupt bytes.
  const m = JSON.parse(fs.readFileSync(mf, 'utf8'));
  const bad = 'f'.repeat(64);
  m.targets[hostTarget()].sha256 = bad;
  fs.writeFileSync(mf, JSON.stringify(m, null, 2));
  const cache = path.join(d, 'cache');
  const r = sh([], {
    CLODE_CACHE: cache,
    CLODE_RELEASE_BASE: base,
    CLODE_BOOTSTRAP_MANIFEST: mf,
  });
  assert.strictEqual(r.status, 1, `expected a refusal, got ${r.status}`);
  assert.match(r.err, /sha256/i);
  assert.ok(r.err.includes(bad), 'the refusal must print the digest it EXPECTED');
  assert.match(r.err, /[0-9a-f]{64}/, 'and the one it GOT');
  assert.ok(!fs.existsSync(path.join(cache, 'bootstrap', 'vFIXTURE', hostTarget(), 'tjs')),
    'bytes that failed verification must never reach the cache — that is how a bad engine '
    + 'becomes a sticky bad engine');
});

test('an engine that fails the floor probe is REFUSED, naming the remedies', () => {
  const d = mkdtemp();
  const body = FAKE_ENGINE('MISSING-ENGINE-API: tjs.engine.moduleMeta (function)', 1);
  const { manifest: mf, base } = localPack(path.join(d, 'base'), { [hostTarget()]: body });
  const r = sh([], {
    CLODE_CACHE: path.join(d, 'cache'),
    CLODE_RELEASE_BASE: base,
    CLODE_BOOTSTRAP_MANIFEST: mf,
  });
  assert.strictEqual(r.status, 1, `expected a refusal, got ${r.status}: ${r.out}`);
  assert.match(r.err, /moduleMeta/, 'the refusal must name what the engine is missing');
  assert.match(r.err, /cut a release/i, 'and the first remedy');
  assert.match(r.err, /CLODE_TJS/, 'and the second');
});

test('the sha256 tool is KAT-tested, so a lying hasher is refused rather than trusted', () => {
  const d = mkdtemp();
  const liar = fakeExe(path.join(d, 'liar'), `#!/bin/sh\necho ${'0'.repeat(64)}  "$1"\n`);
  const { manifest: mf, base } = localPack(path.join(d, 'base'), { [hostTarget()]: FAKE_ENGINE(OK_TOKEN) });
  const r = sh([], {
    CLODE_CACHE: path.join(d, 'cache'),
    CLODE_RELEASE_BASE: base,
    CLODE_BOOTSTRAP_MANIFEST: mf,
    CLODE_SHA256: liar,
  });
  assert.strictEqual(r.status, 1, `a hasher that fails its own known-answer test must be refused, got ${r.status}`);
  assert.match(r.err, /known-answer|KAT/i);
  assert.ok(r.err.includes(liar), 'and the refusal must name the tool that failed');
});

// ---------------------------------------------------------------------------
// dash, when this box has one. The scar: shell discovery needs a shell BY NAME,
// and /bin/sh behaviours vary. A resolver that only ever ran under this Mac's sh
// would be untested for alpine's ash and for a minimal guest.
// ---------------------------------------------------------------------------

test('it behaves identically under dash', (t) => {
  let dash;
  try { dash = execFileSync('sh', ['-c', 'command -v dash'], { encoding: 'utf8' }).trim(); }
  catch { dash = ''; }
  if (!dash) return t.skip('no dash on this box (the POSIX floor is still asserted by the syntax check above)');
  const d = mkdtemp();
  const want = fakeExe(path.join(d, 'out-tjs'));
  const r = sh(['--plan'], { CLODE_TJS_OUT: want, CLODE_CACHE: d }, dash);
  assert.strictEqual(r.status, 0, r.err);
  assert.strictEqual(r.out, `local ${want}`);
  const f = sh(['--plan'], { CLODE_CACHE: d, CLODE_BOOTSTRAP_TARGET: 'linux-brandnewarch' }, dash);
  assert.strictEqual(f.status, 3, f.err);
});

// ---------------------------------------------------------------------------
// The pin itself.
// ---------------------------------------------------------------------------

test('the pinned manifest is a real schema-2 pack manifest, with a tag to fetch from', () => {
  const m = manifest();
  assert.strictEqual(m.schema, 2, 'schema 2 is what carries {offset,length} — schema 1 has no blob to range-fetch');
  assert.match(m.bootstrapTag, /^v\d/, 'the manifest must record the release tag its blob is published under');
  assert.ok(typeof m.blob === 'string' && m.blob.length > 0);
  assert.ok(Object.keys(m.targets).length >= 40, 'a pack that covers fewer targets than there are legs is a gap');
  for (const [name, t] of Object.entries(m.targets)) {
    assert.match(t.sha256, /^[0-9a-f]{64}$/, `${name}: no sha256 to verify against`);
    assert.ok(Number.isInteger(t.offset) && Number.isInteger(t.length) && t.length > 0, `${name}: unusable slice`);
  }
});
// ---------------------------------------------------------------------------
// The resolver's own knobs must be VISIBLE to the gate that classifies knobs.
// test/env-inventory.cjs could not see `${CLODE_X}` at all until this landed, so a
// shell file under scripts/ could read the environment with nothing to notice — the
// same "population drifted with nothing to notice" this repo already paid for once, in
// a different syntax. If SH_READ is ever reverted, this goes red instead of the
// resolver going quietly unclassified.
// ---------------------------------------------------------------------------

test('every CLODE_* knob the resolver reads is seen by the env inventory', () => {
  const { indexEnvReads } = require('./env-inventory.cjs');
  const { VERDICTS } = require('./env-verdicts.cjs');
  const idx = indexEnvReads();
  const src = fs.readFileSync(SH, 'utf8');
  const read = [...new Set([...src.matchAll(/\$\{?(CLODE_[A-Z0-9_]+)/g)].map((m) => m[1]))].sort();
  assert.ok(read.length >= 8, `expected the resolver to read several knobs, saw ${read.length}`);
  const recorded = new Set(VERDICTS.map((v) => v.name));
  for (const name of read) {
    assert.ok(idx.get(name)?.prod.includes('scripts/bootstrap-engine.sh'),
      `${name}: the env inventory does not see scripts/bootstrap-engine.sh reading it — a `
      + 'shipped file whose knobs no gate can see is exactly the gate-that-cannot-fail '
      + 'class this repo keeps finding');
    assert.ok(recorded.has(name), `${name}: read by the resolver with no recorded verdict`);
  }
});
