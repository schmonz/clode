'use strict';
// fs.readdirSync under quaude answers as host node does: the same names in the same order, and node's error for a
// directory that is not there (ENOENT) or is a file (ENOTDIR), whatever call failed just before it.
//
// WHY. 2.1.330 asks, before every Edit, whether the file is under the dev-mods folder (<config>/dev-mods) or under a
// place a link in it leads to. It lists that folder with readdirSync and reads ENOENT or ENOTDIR as "nothing there";
// ANY other error means "could not be read", so every path counts as mod code and the Edit is refused: "Claude
// requested permissions to edit ... which is a sensitive file" (verbatim, CI 44980741750 windows-amd64-tests and
// windows-arm64-tests, with readlink, symlink, exclusive create and _O_NOINHERIT already fixed). A fresh config has
// no dev-mods folder. On Windows the engine's sync readdir was an opendir emulation over FindFirstFileA that failed
// WITHOUT setting errno (a Win32 call sets GetLastError, not the CRT's errno), so the error it threw carried whatever
// errno the last failing call left: the EINVAL of the link walk's readlink of a plain directory, which came just
// before. It also read names through the ANSI code page, so a name outside it came back mangled. It is libuv's
// uv_fs_scandir on every platform now (txiki-sync-readdir.patch), the call node's readdirSync makes, which also
// gives node's order (sorted by byte on POSIX, the file system's order on Windows).
//
// The stale-errno shape is driven directly: a readlink of a plain directory (EINVAL) right before each missing
// readdir. Judged on every host the suite runs on, and on the real Windows kernels (ci.yml windows-*-tests).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

// Created out of order, mixed case, digits, and names outside every ANSI code page.
const NAMES = ['zeta.txt', 'Alpha', 'beta', '10', '9', '_u', 'caf\u00e9.txt', '\u65e5\u672c', 'B-dir'];

const PROG = `
const fs = require('node:fs'), path = require('node:path');
const dir = fs.realpathSync(process.argv[2]);
const names = ${JSON.stringify(NAMES)};
for (const n of names) {
  if (n.endsWith('-dir') || n === 'Alpha') fs.mkdirSync(path.join(dir, n));
  else fs.writeFileSync(path.join(dir, n), n);
}
const out = {};
out.list = fs.readdirSync(dir);
out.types = fs.readdirSync(dir, { withFileTypes: true }).map((d) => d.name + (d.isDirectory() ? '/' : ''));
const err = (f) => { try { f(); return 'no throw'; } catch (e) { return e.code + ' ' + e.syscall + ' ' + path.basename(String(e.path)); } };
const staleEinval = () => err(() => fs.readlinkSync(path.join(dir, 'Alpha')));
out.einval = staleEinval();
out.missing = err(() => fs.readdirSync(path.join(dir, 'dev-mods')));
staleEinval();
out.missingDeep = err(() => fs.readdirSync(path.join(dir, 'no', 'such', 'dir')));
staleEinval();
out.file = err(() => fs.readdirSync(path.join(dir, 'zeta.txt')));
out.empty = fs.readdirSync(path.join(dir, 'B-dir'));
console.log(JSON.stringify(out));`;

test('fs.readdirSync answers as host node does: names and order, ENOENT and ENOTDIR even right after an EINVAL', (t) => {
  if (skipUnlessTjs(t)) return;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-readdir-'));
  try {
    const prog = path.join(base, 'p.cjs');
    fs.writeFileSync(prog, PROG);
    const nodeDir = path.join(base, 'node'), shimDir = path.join(base, 'shim');
    fs.mkdirSync(nodeDir); fs.mkdirSync(shimDir);
    const node = spawnSync(process.execPath, [prog, nodeDir], { encoding: 'utf8' });
    assert.strictEqual(node.status, 0, node.stderr);
    const want = JSON.parse(node.stdout.trim());
    assert.strictEqual(want.einval, 'EINVAL readlink Alpha', 'the host node oracle answers EINVAL for a plain directory');
    assert.strictEqual(want.missing, 'ENOENT scandir dev-mods', 'the host node oracle answers ENOENT for no directory');
    assert.deepStrictEqual([...want.list].sort(), [...NAMES].sort(), 'the host node oracle lists every name');
    const r = runLoader(prog, [shimDir]);
    assert.strictEqual(r.status, 0, String(r.stderr));
    assert.deepStrictEqual(JSON.parse(r.stdout.trim().split('\n').pop()), want);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
