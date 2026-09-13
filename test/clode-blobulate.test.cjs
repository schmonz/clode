'use strict';
// The BLOBULATE STEP, on its own. `clode build` is the orchestrator (resolve the
// provider, walk the dep closure, gate it, sign the engine copy, smoke the result);
// blobulating is the one step in the middle that ATTACHES a payload to an engine
// image, and it has two mechanisms — a canonical-LE trailer appended by the tjs
// worker (quaude/--self), and postject injecting a SEA blob (naude). This file
// tests that step directly: it used to be reachable only by driving a whole build.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defineGuard, guardTests } = require('./guard.cjs');

test('clode-blobulate exposes the step', () => {
  const blob = require('../libexec/clode-blobulate.cjs');
  assert.strictEqual(typeof blob.blobulate, 'function');
  assert.strictEqual(typeof blob.materializeBlobPayload, 'function');
});

// The orchestrator must CONSUME the extracted step, and must not keep a second copy
// of it — the whole point of the extraction is one source of truth for the
// attachment. Registered through defineGuard rather than asserted inline: this reads
// an artifact it did not create and derives a finding from the bytes, which is a
// guard, and a guard that cannot be shown to fail is just a green test (guard.cjs's
// contract, and the population sweep in test/guards-population.test.cjs enforces it).
//
// Exact-substring checks, not `assert.match(src, /require\(...\)/)`: a quote-bearing
// `require(` REGEX in a file that also names cli.cjs is the escape-blind shape
// test/guards-population.cjs's unsafeCliRunnerQuoteScans() hunts for (a grep of the
// staged bundle's escaped graph runner), and a substring is the more precise
// assertion here anyway — there is nothing to pattern-match, only one exact call.
const DELEGATES = "require('./clode-blobulate.cjs')";
function scanDelegation({ src }) {
  const findings = [];
  let examined = 0;
  examined++;
  if (!src.includes(DELEGATES)) {
    findings.push(`clode-build.cjs does not contain ${DELEGATES} — the orchestrator must `
      + 'consume the extracted step, not re-implement it');
  }
  examined++;
  if (src.includes('function materializeBlobPayload')) {
    findings.push('clode-build.cjs still defines materializeBlobPayload — the payload '
      + 'materializer moved, and a copy left behind is two sources of truth');
  }
  return { findings, examined };
}
const delegationGuard = defineGuard({
  name: 'clode-build-delegates-blobulate',
  read: () => ({ src: fs.readFileSync(require.resolve('../libexec/clode-build.cjs'), 'utf8') }),
  scan: scanDelegation,
  // The EXACT count of checks in the fixed table above (both directions), so losing
  // one of them reports BROKEN rather than passing on half the claim.
  floor: 2,
  // Both directions at once: no delegation AND a leftover copy.
  control: () => ({ src: 'function materializeBlobPayload(vfs, mat) { /* a second copy */ }\n' }),
});
guardTests(delegationGuard);

// A spawn seam that records what it was asked to exec. The step NEVER spawns
// anything itself — every mechanism goes through the injected `spawnRun`, which is
// what lets these tests pin the worker/assembler argv without a tjs engine, a
// pinned node, or a provider anywhere on disk.
function recorder(result = { status: 0, stdout: '', stderr: '' }) {
  const calls = [];
  const spawnRun = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return Promise.resolve(result); };
  return { calls, spawnRun };
}

test('blobulate(trailer): runs the worker UNDER the engine, with the member argv in order', async () => {
  const { blobulate } = require('../libexec/clode-blobulate.cjs');
  const { calls, spawnRun } = recorder({ status: 0, stdout: 'compiled 3 modules\n', stderr: '' });
  const r = await blobulate({
    mechanism: 'trailer',
    spawnRun,
    engine: '/engines/tjs',
    libexec: path.join('/repo', 'libexec'),
    signedBase: path.join('/work', 'template-signed'),
    stageDir: path.join('/work', 'stage'),
    nmDir: path.join('/deps', 'node_modules'),
    extrasPath: path.join('/work', 'extras.json'),
    out: path.join('/out', 'quaude'),
    env: { CLODE_MARKER: '1' },
    timeout: 4242,
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(calls.length, 1);
  // The engine RUNS the worker: bytecode writer == runtime, BC_VERSION lockstep.
  assert.strictEqual(calls[0].cmd, '/engines/tjs');
  assert.deepStrictEqual(calls[0].args, [
    'run', path.join('/repo', 'libexec', 'quaude-blobulate.js'),
    path.join('/work', 'template-signed'),
    path.join('/work', 'stage'),
    path.join('/repo', 'libexec', 'node-shim'),
    path.join('/deps', 'node_modules'),
    path.join('/repo', 'libexec', 'quaude-bootstrap.mjs'),
    path.join('/work', 'extras.json'),
    path.join('/out', 'quaude'),
  ], 'the worker argv is positional — an order change silently mis-assigns members');
  assert.strictEqual(calls[0].opts.timeout, 4242, 'the caller owns the timeout budget');
  assert.deepStrictEqual(calls[0].opts.env, { CLODE_MARKER: '1' });
  assert.strictEqual(r.passthrough.trimEnd(), 'compiled 3 modules',
    'the worker\'s own narration must reach the human-facing log untouched');
});

test('blobulate(trailer): --self appends the PRISTINE base engine as a 9th positional', async () => {
  const { blobulate } = require('../libexec/clode-blobulate.cjs');
  const { calls, spawnRun } = recorder();
  await blobulate({
    mechanism: 'trailer',
    spawnRun,
    engine: '/engines/host-tjs',
    libexec: '/repo/libexec',
    signedBase: '/work/template-signed',
    stageDir: '/work/stage',
    nmDir: '/deps/node_modules',
    extrasPath: '/work/extras.json',
    out: '/out/clode-native',
    // The TARGET-platform base, never the host engine running this worker: a
    // cross-blobulated builder must ship a template it can exec on the target.
    embedTemplate: '/engines/target-tjs',
    env: {},
    timeout: 1,
  });
  assert.strictEqual(calls[0].args[calls[0].args.length - 1], '/engines/target-tjs');
  assert.strictEqual(calls[0].args.length, 10, 'exactly one extra positional for the embedded base');
});

test('blobulate(trailer): protocol lines are ingested, everything else is passed through', async () => {
  const { blobulate } = require('../libexec/clode-blobulate.cjs');
  const R = require('../libexec/build-report.cjs');
  const protocol = R.serialize(R.plan([{ name: 'compile', total: 7 }]));
  const { spawnRun } = recorder({ status: 0, stdout: `narration one\n${protocol}\nnarration two\n`, stderr: '' });
  const ingested = [];
  const r = await blobulate({
    mechanism: 'trailer',
    spawnRun,
    engine: '/e',
    libexec: '/lx',
    signedBase: '/w/b',
    stageDir: '/w/s',
    nmDir: '/nm',
    extrasPath: '/w/x.json',
    out: '/o/q',
    env: {},
    timeout: 1,
    // The real caller hands this the Composer's ingest, which returns false for a
    // line that is not one of its sentinels — that return is what separates the
    // protocol from the narration, so a stub that always returns true would eat
    // the log and a stub that always returns false would dump raw JSON into it.
    ingest: (line) => { ingested.push(line); return R.parse(line) !== null; },
  });
  assert.deepStrictEqual(ingested, ['narration one', protocol, 'narration two', '']);
  assert.strictEqual(r.passthrough.trimEnd(), 'narration one\nnarration two',
    'a build log must never show raw @clode-step JSON');
});

test('blobulate(trailer): declares, starts and finishes the step named after itself', async () => {
  const { blobulate } = require('../libexec/clode-blobulate.cjs');
  const R = require('../libexec/build-report.cjs');
  const { Composer } = require('../libexec/build-compose.cjs');
  const composer = new Composer();
  const report = new R.Reporter({ emit: (line) => composer.ingest('builder', line) });
  const { spawnRun } = recorder();
  await blobulate({
    mechanism: 'trailer',
    spawnRun,
    engine: '/e',
    libexec: '/lx',
    signedBase: '/w/b',
    stageDir: '/w/s',
    nmDir: '/nm',
    extrasPath: '/w/x.json',
    out: '/o/q',
    env: {},
    timeout: 1,
    report,
  });
  const step = composer.steps().find((s) => s.name === 'blobulate');
  assert.ok(step, 'the step protocol must carry a `blobulate` step');
  assert.strictEqual(step.component, 'builder');
  assert.strictEqual(step.state, 'finished');
  // A declared-but-never-finished step is exactly what Composer.mismatches()
  // exists to catch, and a build fails on a mismatch — so half-reporting here
  // would fail every build rather than one test.
  assert.deepStrictEqual(composer.mismatches(), []);
});

test('blobulate(trailer): a worker that produced NO output is diagnosed as an exec failure', async () => {
  const { blobulate } = require('../libexec/clode-blobulate.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-blobulate-diag-'));
  try {
    const engine = path.join(dir, 'tjs');
    fs.writeFileSync(engine, 'not really an engine');
    const base = {
      mechanism: 'trailer',
      spawnRun: () => Promise.resolve({ status: 127, stdout: '', stderr: '' }),
      libexec: '/lx',
      signedBase: '/w/b',
      stageDir: '/w/s',
      nmDir: '/nm',
      extrasPath: '/w/x.json',
      out: '/o/q',
      env: {},
      timeout: 1,
    };
    const present = await blobulate({ ...base, engine });
    assert.strictEqual(present.ok, false);
    assert.match(present.diagnosis, /no worker output — exec failure\?/);
    assert.match(present.diagnosis, new RegExp(`size=${fs.statSync(engine).size}`),
      'a bare status with no output must say what we tried to exec, and how big it was');
    // The same diagnosis must survive the engine being gone — reading its size is
    // best-effort narration, never a second failure on top of the first.
    const gone = await blobulate({ ...base, engine: path.join(dir, 'vanished') });
    assert.match(gone.diagnosis, /MISSING/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('blobulate(trailer): a worker that DID talk is not misreported as an exec failure', async () => {
  const { blobulate } = require('../libexec/clode-blobulate.cjs');
  const R = require('../libexec/build-report.cjs');
  // Output that is ENTIRELY protocol: the worker ran, so the exec-failure
  // diagnosis must stay silent even though the passthrough log is empty.
  const only = R.serialize(R.plan([{ name: 'compile', total: 1 }]));
  const r = await blobulate({
    mechanism: 'trailer',
    spawnRun: () => Promise.resolve({ status: 3, stdout: only, stderr: '' }),
    engine: '/engines/tjs',
    libexec: '/lx',
    signedBase: '/w/b',
    stageDir: '/w/s',
    nmDir: '/nm',
    extrasPath: '/w/x.json',
    out: '/o/q',
    env: {},
    timeout: 1,
    ingest: (line) => R.parse(line) !== null,
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.diagnosis, '');
  assert.strictEqual(r.passthrough.trim(), '');
});

test('blobulate(postject): runs the assembler under the blob-gen node with both node roles', async () => {
  const { blobulate } = require('../libexec/clode-blobulate.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-blobulate-naude-'));
  try {
    const extras = path.join(dir, 'extras.json');
    fs.writeFileSync(extras, '{}');
    const { calls, spawnRun } = recorder({ status: 0, stdout: 'naude ok\n', stderr: '' });
    const r = await blobulate({
      mechanism: 'postject',
      spawnRun,
      assembleRoot: '/root',
      blobgenNode: '/pinned/host/node',
      embedNode: '/pinned/target/node',
      targetOs: 'darwin',
      cli: '/stage/cli.cjs',
      bundle: '/build/bundle/naude-entry.bundle.cjs',
      nmDir: '/deps/node_modules',
      extrasPath: extras,
      signerBin: '/tools/rcodesign',
      out: '/out/naude',
      env: {},
      timeout: 99,
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].cmd, '/pinned/host/node', 'blob-gen runs on THIS host');
    const a = calls[0].args;
    assert.strictEqual(a[0], path.join('/root', 'scripts', 'build-naude.mjs'));
    const flag = (f) => a[a.indexOf(f) + 1];
    assert.strictEqual(flag('--cli'), '/stage/cli.cjs');
    assert.strictEqual(flag('--blobgen-node'), '/pinned/host/node');
    assert.strictEqual(flag('--embed-node'), '/pinned/target/node');
    assert.strictEqual(flag('--target-os'), 'darwin');
    assert.strictEqual(flag('--bundle'), '/build/bundle/naude-entry.bundle.cjs');
    assert.strictEqual(flag('--nmdir'), '/deps/node_modules');
    assert.strictEqual(flag('--postject'), path.join('/root', 'deps', 'clode', 'node_modules', 'postject'));
    assert.strictEqual(flag('--extras'), extras);
    assert.strictEqual(flag('--darwin-signer'), '/tools/rcodesign');
    assert.strictEqual(flag('--out'), '/out/naude');
    assert.ok(!a.includes('--node'), 'the split roles are always named explicitly, never the --node alias');
    // The extras file is the step's own temp input; it is cleaned up whatever the
    // assembler's exit status was.
    assert.ok(!fs.existsSync(extras), 'the extras temp file must not be left behind');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('blobulate(postject): no signer and no --out means neither flag appears', async () => {
  const { blobulate } = require('../libexec/clode-blobulate.cjs');
  const { calls, spawnRun } = recorder();
  await blobulate({
    mechanism: 'postject',
    spawnRun,
    assembleRoot: '/root',
    blobgenNode: '/n',
    embedNode: '/n',
    targetOs: 'linux',
    cli: '/c',
    bundle: '/b',
    nmDir: '/nm',
    extrasPath: path.join(os.tmpdir(), 'clode-blobulate-absent-extras.json'),
    env: {},
    timeout: 1,
  });
  assert.ok(!calls[0].args.includes('--darwin-signer'));
  assert.ok(!calls[0].args.includes('--out'), 'build-naude.mjs owns the default output path');
});

test('blobulate: an unknown mechanism is refused, not silently ignored', async () => {
  const { blobulate } = require('../libexec/clode-blobulate.cjs');
  await assert.rejects(() => blobulate({ mechanism: 'sellotape' }), /unknown blobulate mechanism 'sellotape'/);
  await assert.rejects(() => blobulate({}), /unknown blobulate mechanism 'undefined'/);
});

test('materializeBlobPayload: each member name lands at its documented on-disk home', () => {
  const { materializeBlobPayload } = require('../libexec/clode-blobulate.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-blobulate-mat-'));
  try {
    const files = new Map();
    const put = (name) => files.set(name, Buffer.from(name));
    put('node-shim/loader.cjs');
    put('libexec/quaude-blobulate.js');
    put('node_modules/yaml/package.json');
    put('target-env.cjs');
    put('deps/claude/package-lock.json');
    put('scripts/build-naude.mjs');
    put('naude-entry.bundle.cjs');
    // Not a payload member any target materializes: the embedded engine is written
    // by the caller (verified against the manifest sha first), never through here.
    put('template/tjs');
    materializeBlobPayload({ files }, dir);
    const at = (rel) => {
      const p = path.join(dir, rel);
      return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
    };
    // node-shim/ and the bare target-env.cjs both land BESIDE each other under
    // libexec/, which is what the shim loader's '../../target-env.cjs' relative
    // require needs; everything else keeps its archive path verbatim.
    assert.strictEqual(at(path.join('libexec', 'node-shim', 'loader.cjs')), 'node-shim/loader.cjs');
    assert.strictEqual(at(path.join('libexec', 'target-env.cjs')), 'target-env.cjs');
    assert.strictEqual(at(path.join('libexec', 'quaude-blobulate.js')), 'libexec/quaude-blobulate.js');
    assert.strictEqual(at(path.join('node_modules', 'yaml', 'package.json')), 'node_modules/yaml/package.json');
    assert.strictEqual(at(path.join('deps', 'claude', 'package-lock.json')), 'deps/claude/package-lock.json');
    assert.strictEqual(at(path.join('scripts', 'build-naude.mjs')), 'scripts/build-naude.mjs');
    assert.strictEqual(at('naude-entry.bundle.cjs'), 'naude-entry.bundle.cjs');
    assert.strictEqual(at(path.join('template', 'tjs')), null, 'an unmapped member is skipped, not guessed at');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
