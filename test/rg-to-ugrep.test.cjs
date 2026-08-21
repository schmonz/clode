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
  assert.ok(out.includes('-L') && out.includes('--hidden'));
  assert.strictEqual(out[out.length - 2], '$^');
  assert.strictEqual(out[out.length - 1], '/repo');
});

// THE INSTRUMENT for the -L trick. Listing via "files WITHOUT a match" depends on
// `$^` never matching — end-of-line immediately followed by start-of-line. That is
// engine BEHAVIOUR, not a guarantee: on a ugrep that matched it, -L would list
// NOTHING and every file-discovery call would silently return empty, which is
// worse than the zero-length omission this replaced. So drive the real host ugrep
// against a fixture with one of each kind of file and assert the exact set.
//
// If this fails on some platform's ugrep, the translation is wrong THERE and the
// fix is a different never-matching construct — not relaxing this assertion.
test('rg --files: ugrep branch lists empty/binary/ignored/hidden exactly', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-ugrep-sem-'));
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'empty.txt'), '');                 // MUST be listed
  fs.writeFileSync(path.join(dir, 'normal.txt'), 'hello\n');         // MUST be listed
  fs.writeFileSync(path.join(dir, 'sub', 'deep.txt'), 'y\n');        // MUST be listed
  fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from([0, 1, 65, 0]));  // MUST be listed
  fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored.txt\n');   // hidden -> omitted
  fs.writeFileSync(path.join(dir, 'ignored.txt'), 'z\n');            // gitignored -> omitted
  fs.writeFileSync(path.join(dir, 'sub', '.hidden'), 'x\n');         // hidden -> omitted

  const argv = rgFilesToListing(['--files', dir]);   // no --hidden: dotfiles excluded
  if (!argv || !argv[0].endsWith('ugrep')) { fs.rmSync(dir, { recursive: true, force: true }); return; }
  const r = require('node:child_process').spawnSync(argv[0], argv.slice(1), { encoding: 'utf8' });
  const got = r.stdout.split('\n').filter(Boolean)
    .map((f) => path.relative(dir, f)).sort();
  assert.deepStrictEqual(got, ['bin.dat', 'empty.txt', 'normal.txt', 'sub/deep.txt'],
    'ugrep listing semantics differ on this host — see the $^ note in bun-shim');
  fs.rmSync(dir, { recursive: true, force: true });
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-hostrg-'));
  fs.writeFileSync(path.join(dir, 'rg'), '#!/bin/sh\necho REAL-RG-CALLED\n');
  fs.chmodSync(path.join(dir, 'rg'), 0o755);

  const probe = path.join(dir, 'p.cjs');
  fs.writeFileSync(probe, `
    const s = require(${JSON.stringify(path.join(__dirname, '..', 'libexec/bun-shim.cjs'))});
    console.log(JSON.stringify({
      search: s._rewriteRgSpawn(['rg', '-n', 'x', '.']),
      files: s._rewriteRgSpawn(['rg', '--files', '/r']),
    }));
  `);
  const r = require('node:child_process').spawnSync(process.execPath, [probe], {
    encoding: 'utf8',
    // A real rg on PATH, and deliberately no ugrep/bfs.
    env: { ...process.env, PATH: dir, CLODE_UGREP: '', CLODE_BFS: '' },
  });
  const got = JSON.parse(r.stdout.trim());
  assert.strictEqual(got.search[0], 'clode-rg-unavailable',
    'a present host rg must NOT be used for searches');
  assert.strictEqual(got.files[0], 'clode-rg-unavailable',
    'a present host rg must NOT be used for --files');
  // The refusal has to say so, and name the remedy — silence here would read as
  // "rg is missing" when rg is in fact right there and deliberately declined.
  assert.match(r.stderr, /not falling back to a host rg/);
  assert.match(r.stderr, /rg needs 'ugrep'/);
  fs.rmSync(dir, { recursive: true, force: true });
});
