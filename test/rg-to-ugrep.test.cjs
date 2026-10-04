'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { rgToUgrep, RgTranslateError } = require('../libexec/bun-shim.cjs');
const { OK, THROWS } = require('./rg-cases.cjs');

for (const c of OK) {
  test(`rgToUgrep: ${JSON.stringify(c.in)}`, () => {
    assert.deepStrictEqual(rgToUgrep(c.in), c.out);
  });
}
for (const c of THROWS) {
  test(`rgToUgrep rejects ${c.flag}`, () => {
    assert.throws(() => rgToUgrep(c.in), (e) =>
      e instanceof RgTranslateError && e.flag === c.flag && e.code === 'CLODE_RG_UNTRANSLATABLE');
  });
}

const { rgShadowBody } = require('../libexec/bun-shim.cjs');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Source the shell rg function with a stub ugrep that prints its argv NUL-joined,
// so we can compare the shell twin's translation to rgToUgrep byte-for-byte.
function shellTranslate(argv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-twin-'));
  const ugrep = path.join(dir, 'ugrep');
  fs.writeFileSync(ugrep, '#!/bin/sh\nprintf \'%s\\0\' "$@"\n', { mode: 0o755 });
  const snap = path.join(dir, 'snap.sh');
  fs.writeFileSync(snap, rgShadowBody() + '\n');
  const q = argv.map((a) => "'" + a.replace(/'/g, "'\\''") + "'").join(' ');
  const r = cp.spawnSync('bash', ['-c', `. "${snap}"; rg ${q}`],
    { encoding: 'utf8', env: { ...process.env, CLODE_UGREP: ugrep } });
  return { status: r.status, argv: r.stdout ? r.stdout.split('\0').slice(0, -1) : [], stderr: r.stderr };
}

const HAS_BASH = (() => { try { return cp.spawnSync('bash', ['-c', 'exit 0']).status === 0; } catch { return false; } })();

for (const c of OK) {
  test(`twin parity: ${JSON.stringify(c.in)}`, { skip: HAS_BASH ? false : 'needs bash' }, () => {
    const sh = shellTranslate(c.in);
    assert.strictEqual(sh.status, 0, sh.stderr);
    assert.deepStrictEqual(sh.argv, rgToUgrep(c.in), 'shell twin must match rgToUgrep');
  });
}
for (const c of THROWS) {
  test(`twin rejects ${c.flag}`, { skip: HAS_BASH ? false : 'needs bash' }, () => {
    const sh = shellTranslate(c.in);
    assert.notStrictEqual(sh.status, 0);
    assert.match(sh.stderr, /rg→ugrep shim doesn't translate/);
  });
}

// ---------------------------------------------------------------------------
// BOTH spawn routes must agree, because the bundle uses both.
//
// Bun.spawn has routed rg->ugrep since the routing spec, but node's
// child_process did not: rg arrives there as the FILE argument, and the wrapper
// only rewrote the args ARRAY. So one binary had two spawn routes disagreeing
// about the same command — `Bun.spawn(['rg',...])` translated while
// `spawn('rg',[...])` failed ENOENT. The bundle's startup rg calls take the
// child_process route, which is why they were the ones that broke.
//
// The fix lives in bun-shim precisely because bun-shim is baked into BOTH quaude
// and naude. node-shim is quaude-only, so fixing it there would have made quaude
// translate while naude did not — inventing a divergence rather than closing one.
//
// Run BOTH routes in one child process, so the shim is loaded once and each route
// really launches a process; the parent then compares what the two children were
// handed. `runRoutes` returns { cp, bun, cpErr } exactly as the probe printed it.
function runRoutes(dir, rgArgs, env) {
  const probe = path.join(dir, 'probe.cjs');
  fs.writeFileSync(probe, `
    const shim = require(${JSON.stringify(path.join(__dirname, '..', 'libexec/bun-shim.cjs'))});
    const cp = require('node:child_process');
    const RG = ${JSON.stringify(rgArgs)};
    // Route A: node child_process, the route the bundle's startup rg calls take.
    const viaCp = cp.spawnSync('rg', RG, { encoding: 'utf8' });
    // Route B: the Bun.spawn approximation.
    const viaBun = shim.spawnSync(['rg', ...RG]);
    const bunOut = (viaBun.stdout || Buffer.alloc(0)).toString('utf8');
    const lines = (s) => s.replace(/\\r/g, '').trim().split('\\n').filter(Boolean);
    console.log(JSON.stringify({
      cp: lines(viaCp.stdout || ''),
      bun: lines(bunOut),
      cpErr: viaCp.error ? String(viaCp.error.code || viaCp.error.message) : null,
    }));
  `);
  const r = cp.execFileSync(process.execPath, [probe], { encoding: 'utf8', env });
  return JSON.parse(r.trim());
}

// THE LISTING, on every OS. `rg --files` was the claim's carrier while it went through the old translation
// (a print-my-argv script stood in for bfs, so the claim ran on Windows too). Since grep-native Task 10
// quaude's rg lists itself, through rg's walk (libexec/rg-walk.cjs), with no applet at all, so the claim is
// that both routes ANSWER it identically, on every OS, with nothing to stand in for. The answer is pinned
// to native's where rg's path spelling is measured (POSIX: `/` joins; Windows' `\` joins are unmeasured,
// BACKLOG, so there only the two routes are compared).
test('both spawn routes answer rg --files identically (child_process and Bun.spawn)', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rg-routes-')));
  const tree = path.join(dir, 'tree');
  fs.mkdirSync(path.join(tree, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(tree, '.orphaned_at'), '');
  fs.writeFileSync(path.join(tree, 'sub', '.orphaned_at'), '');
  fs.writeFileSync(path.join(tree, 'other.txt'), 'x\n');
  fs.utimesSync(path.join(tree, 'sub', '.orphaned_at'), 1700000060, 1700000060);   // the newer: listed last
  fs.utimesSync(path.join(tree, '.orphaned_at'), 1700000000, 1700000000);

  const got = runRoutes(dir, ['--files', '--no-ignore', '--hidden', '--glob', '.orphaned_at', '--sort=modified', tree],
    { ...process.env, CLODE_BFS: '', CLODE_UGREP: '' });

  assert.strictEqual(got.cpErr, null,
    'child_process spawn of rg must not fail — before the fix this was ENOENT');
  assert.ok(got.cp.length > 0, `child_process route produced nothing: ${JSON.stringify(got)}`);
  assert.deepStrictEqual(got.cp, got.bun, 'the two spawn routes must answer the SAME');
  // native 2.1.283's embedded rg over this tree: both empty marker files, oldest first, nothing else
  if (process.platform !== 'win32') assert.deepStrictEqual(got.cp, [`${tree}/.orphaned_at`, `${tree}/sub/.orphaned_at`]);
  fs.rmSync(dir, { recursive: true, force: true });
});

// The same claim for a SEARCH, the call the original ENOENT was found in. A search is no longer
// translated: quaude's rg answers it itself over ugrep (libexec/rg-native.cjs, grep-native Task 6),
// so the claim is that both routes ANSWER it, identically and as rg does. ugrep is the stand-in
// test/rg-fake-ugrep.cjs (a shebang script), which Windows cannot execute: libuv never hands an
// extensionless path to CreateProcess (libuv tries only `<name>.com` and `<name>.exe` for a path with no
// extension). So this row skips there, and ONLY there, on that one named ground; the ROUTE-IDENTITY claim
// itself is still asserted on Windows by the row above.
test('both spawn routes answer an rg SEARCH identically, as rg does', {
  skip: process.platform === 'win32'
    ? 'needs an executable shebang ugrep stand-in; libuv only execs .com/.exe'
    : false,
}, () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rg-routes-search-')));
  const ugrep = require('./rg-fake-ugrep.cjs').writeFakeUgrep(dir);
  const src = path.join(dir, 'src');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'x.txt'), 'one\ntwo needle\n');

  const got = runRoutes(dir, ['-n', 'needle', src], { ...process.env, CLODE_UGREP: ugrep });

  assert.strictEqual(got.cpErr, null,
    'child_process spawn of rg must not fail — before the fix this was ENOENT');
  assert.ok(got.cp.length > 0, `child_process route produced nothing: ${JSON.stringify(got)}`);
  assert.deepStrictEqual(got.cp, got.bun, 'the two spawn routes must answer the SAME');
  // native 2.1.283's embedded rg, for `rg -n needle <dir>` over that one file
  assert.deepStrictEqual(got.cp, [`${src}/x.txt:2:two needle`]);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// A host rg must never be used, even when one is installed.
//
// Falling through to whatever rg the host has looks helpful and is not: it makes
// quaude's behaviour depend on what is installed, so the same binary searches with
// ugrep on one machine and ripgrep on another — different ignore rules, different
// output, measured by nothing. It also contradicts why we translate at all: ugrep
// and bfs reach every target quaude supports and rg cannot, so rg is exactly the
// thing we cannot build on.
//
// The shell path already refuses (127, "clode: rg needs 'ugrep'"). This pins the
// spawn path to the same answer.
test('a host rg is never called, even when present, if the applet is missing', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'rg-hostrg-')));
  fs.writeFileSync(path.join(dir, 'rg'), '#!/bin/sh\necho REAL-RG-CALLED\n');
  fs.chmodSync(path.join(dir, 'rg'), 0o755);

  const probe = path.join(dir, 'p.cjs');
  fs.writeFileSync(probe, `
    require(${JSON.stringify(path.join(__dirname, '..', 'libexec/bun-shim.cjs'))});
    const cp = require('node:child_process');
    const one = (args) => { const r = cp.spawnSync('rg', args, { encoding: 'utf8' });
      return { status: r.status, out: r.stdout, err: r.stderr }; };
    console.log(JSON.stringify({ search: one(['-n', 'x', '.']), files: one(['--files', ${JSON.stringify(path.join('<DIR>', 'tree'))}.replace('<DIR>', __dirname)]) }));
  `);
  fs.mkdirSync(path.join(dir, 'tree'));
  fs.writeFileSync(path.join(dir, 'tree', 'f.txt'), 'x\n');
  const r = require('node:child_process').spawnSync(process.execPath, [probe], {
    encoding: 'utf8',
    // A real rg on PATH, and deliberately no ugrep/bfs.
    env: { ...process.env, PATH: dir, CLODE_UGREP: '', CLODE_BFS: '' },
  });
  const got = JSON.parse(r.stdout.trim());
  for (const [what, a] of Object.entries(got)) {
    assert.doesNotMatch(a.out + a.err, /REAL-RG-CALLED/, `a present host rg must NOT be used for the ${what} call`);
  }
  // The search: a refusal, rc 2, nothing printed, the missing applet named (rg-native.cjs rgRefusal).
  assert.strictEqual(got.search.status, 2, `search: ${JSON.stringify(got.search)}`);
  assert.strictEqual(got.search.out, '');
  const refused = require('../libexec/rg-native.cjs').parseRgRefusal(got.search.err);
  assert.ok(refused && refused.flag === null && /^quaude answers rg with ugrep/.test(refused.reason), got.search.err);
  // The listing needs no applet (grep-native Task 10: rg's walk is quaude's own), so it is ANSWERED, as
  // native answers it, and still never by the host rg.
  assert.deepStrictEqual([got.files.status, got.files.out], [0, `${path.join(dir, 'tree')}/f.txt\n`], JSON.stringify(got.files));
  // The operator's trace has to say so too, and name the remedy — silence here would read
  // as "rg is missing" when rg is in fact right there and deliberately declined.
  assert.match(r.stderr, /not falling back to a host rg/);
  assert.match(r.stderr, /rg needs 'ugrep'/);
  fs.rmSync(dir, { recursive: true, force: true });
});
