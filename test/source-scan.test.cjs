'use strict';
// source-scan.test.cjs — discoverFilesByExt is the shared file-discovery walker
// test/source-scan.cjs's own header describes ("every text-scanning sweep and build-gate
// guard in this repo needs, in ONE place"); test/guards-population.cjs's production-gate
// sweep and test/build-gates/live-checks-gates.test.cjs's scan both call it directly, and
// its own comment already claims it skips dotfiles "which on this NFS checkout also skips
// the stray macOS AppleDouble shadow files" — but nothing proved that against a REAL
// AppleDouble sidecar until now. This checkout lives on an NFS/SMB mount where macOS
// creates `._NAME` resource-fork sidecars next to files it touches (gitignored: `._*` in
// .gitignore, confirmed by `git check-ignore`); one of them next to a real test file broke
// a full-suite run (RC 2). This is the direct proof, against a real temp directory holding
// a `._x.test.cjs` whose first four bytes are the real AppleDouble magic number
// (0x00051607), that the shared walker never picks it up as a discovered file.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { discoverFilesByExt } = require('./source-scan.cjs');

// The real AppleDouble header magic (Apple Technote 1150): 0x00051607, followed by the
// version (0x00020000) and 16 filler bytes — a real sidecar's actual first 24 bytes, not
// just an arbitrary non-UTF8 blob standing in for one.
const APPLEDOUBLE_MAGIC = Buffer.from([
  0x00, 0x05, 0x16, 0x07,
  0x00, 0x02, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

function tempDirWithSidecar() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-scan-appledouble-'));
  fs.writeFileSync(path.join(dir, 'real.test.cjs'), "'use strict';\nrequire('node:test');\n");
  fs.writeFileSync(path.join(dir, '._real.test.cjs'), APPLEDOUBLE_MAGIC);
  return dir;
}

test('discoverFilesByExt: a real AppleDouble sidecar next to a matching file is never returned', () => {
  const dir = tempDirWithSidecar();
  try {
    const found = discoverFilesByExt(dir, ['.test.cjs']);
    assert.deepStrictEqual(found, [path.join(dir, 'real.test.cjs')]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('discoverFilesByExt: the same sidecar one level down a subdirectory is still skipped', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'source-scan-appledouble-nested-'));
  try {
    const sub = path.join(dir, 'build-gates');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'real.test.cjs'), "'use strict';\n");
    fs.writeFileSync(path.join(sub, '._real.test.cjs'), APPLEDOUBLE_MAGIC);
    const found = discoverFilesByExt(dir, ['.test.cjs']);
    assert.deepStrictEqual(found, [path.join(sub, 'real.test.cjs')]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The predicate in isolation, since several sites in this repo (test/run.mjs's
// discoverTests, test/guards-population.cjs's discoverTestFiles, test/forced-win32.cjs's
// discover, test/env-inventory.cjs's/test/env-indirect.cjs's walk) carry their own
// dotfile-skip line rather than calling discoverFilesByExt itself — each is the same
// one-line predicate (a name beginning with '.' — which is a superset of AppleDouble's
// narrower '._' prefix) applied to a readdirSync entry.
test('the dotfile-skip predicate every discoverer in this repo applies rejects a real sidecar name', () => {
  const dir = tempDirWithSidecar();
  try {
    const names = fs.readdirSync(dir);
    assert.ok(names.includes('._real.test.cjs'), 'fixture sanity: the sidecar is really there');
    const kept = names.filter((n) => !n.startsWith('.'));
    assert.deepStrictEqual(kept, ['real.test.cjs']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
