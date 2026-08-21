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
test('both spawn routes translate rg identically (child_process and Bun.spawn)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-routes-'));
  // A stand-in ugrep that just reports the argv it was handed.
  const ugrep = path.join(dir, 'ugrep');
  fs.writeFileSync(ugrep, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
  fs.chmodSync(ugrep, 0o755);

  const probe = path.join(dir, 'probe.cjs');
  fs.writeFileSync(probe, `
    const shim = require(${JSON.stringify(path.join(__dirname, '..', 'libexec/bun-shim.cjs'))});
    const cp = require('node:child_process');
    // Route A: node child_process, the route the bundle's startup rg calls take.
    const viaCp = cp.spawnSync('rg', ['-n', 'needle', 'src'], { encoding: 'utf8' });
    // Route B: the Bun.spawn approximation.
    const viaBun = shim.spawnSync(['rg', '-n', 'needle', 'src']);
    const bunOut = (viaBun.stdout || Buffer.alloc(0)).toString('utf8');
    console.log(JSON.stringify({
      cp: (viaCp.stdout || '').trim().split('\\n').filter(Boolean),
      bun: bunOut.trim().split('\\n').filter(Boolean),
      cpErr: viaCp.error ? String(viaCp.error.code || viaCp.error.message) : null,
    }));
  `);
  const r = require('node:child_process').execFileSync(process.execPath, [probe],
    { encoding: 'utf8', env: { ...process.env, CLODE_UGREP: ugrep } });
  const got = JSON.parse(r.trim());

  assert.strictEqual(got.cpErr, null,
    'child_process spawn of rg must not fail — before the fix this was ENOENT');
  assert.ok(got.cp.length > 0, `child_process route produced no argv: ${JSON.stringify(got)}`);
  assert.deepStrictEqual(got.cp, got.bun,
    'the two spawn routes must hand ugrep the SAME argv');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// `rg --files` — a LISTING, not a search.
//
// INTENTIONAL DIVERGENCE (user, 2026-08-21): we do not look for ripgrep and do
// not want it. rg is Rust and cannot exist everywhere quaude does (NetBSD/sparc,
// Tiger PPC, Haiku); ugrep and bfs are as portable as quaude, so we rely on them
// on purpose. "Install rg" is not the remedy here.
//
// Neither substitute is faithful alone, so the translation dispatches to whichever
// is EXACT for the flags given — measured, not assumed:
//                  .gitignore   hidden     empty files   binary
//   ugrep -l ''    honors       skips      DROPS         keeps (no -I)
//   bfs -type f    none         lists all  keeps         keeps
const { rgFilesToListing } = require('../libexec/bun-shim.cjs');

test('rg --files: --no-ignore routes to bfs (which has no ignore logic — that IS the ask)', () => {
  const out = rgFilesToListing(['--files', '--hidden', '--no-ignore', '--max-depth', '4',
    '--glob', '.orphaned_at', '/tmp/x']);
  assert.ok(out, 'no applet resolved');
  assert.match(out[0], /bfs$/);
  assert.deepStrictEqual(out.slice(1), ['/tmp/x', '-maxdepth', '4', '-type', 'f', '-name', '.orphaned_at']);
});

test('rg --files: without --hidden, bfs must exclude dotfiles (rg skips them by default)', () => {
  const out = rgFilesToListing(['--files', '--no-ignore', '/tmp/x']);
  assert.ok(out[0].endsWith('bfs'));
  assert.ok(out.join(' ').includes("! -path */.*"), `dotfiles not excluded: ${out.join(' ')}`);
});

test('rg --files: ignore-respecting form routes to ugrep --ignore-files', () => {
  const out = rgFilesToListing(['--files', '--hidden', '/repo']);
  assert.ok(out[0].endsWith('ugrep'));
  assert.ok(out.includes('--ignore-files'), 'must honor .gitignore');
  assert.ok(out.includes('-l') && out.includes('--hidden'));
  // The empty pattern must be present as its own argv element, before the paths:
  // it is what makes every (non-empty) file "match" and therefore list.
  assert.strictEqual(out[out.length - 2], '');
  assert.strictEqual(out[out.length - 1], '/repo');
});

test('rg --files: an untranslatable flag is refused, not silently mistranslated', () => {
  assert.throws(() => rgFilesToListing(['--files', '--sort', 'path', '/repo']), RgTranslateError);
});

// Behaviour, not just argv shape: the bfs branch must find an EMPTY marker file.
// This is the concrete reason the dispatch exists — the bundle's startup call
// looks for `.orphaned_at`, marker files are usually zero-length, and ugrep's -l
// lists files with a MATCH, so an empty file would silently never appear.
test('rg --files: the bfs branch finds a zero-length marker file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-files-'));
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, '.orphaned_at'), '');       // empty, on purpose
  fs.writeFileSync(path.join(dir, 'sub', 'other.txt'), 'x\n');
  const argv = rgFilesToListing(['--files', '--hidden', '--no-ignore', '--max-depth', '4',
    '--glob', '.orphaned_at', dir]);
  const r = require('node:child_process').spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), path.join(dir, '.orphaned_at'));
  fs.rmSync(dir, { recursive: true, force: true });
});
