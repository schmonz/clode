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
