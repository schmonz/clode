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
