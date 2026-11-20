'use strict';
// fs file-walk characterization: the readdir(withFileTypes/recursive) + Dirent
// surface and the callback fs family (readdir/lstat/realpath) a JS directory
// walker uses must match host node's observable results for the same fixture
// tree. Surfaced by the -p wall-walk: when ripgrep is not used, the bundle's
// fallback walker touches exactly these APIs. SKIPs without tjs.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

// A small fixture tree: files + a nested dir, built fresh per run.
function fixtureTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-walk-'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'a');
  fs.writeFileSync(path.join(root, 'b.js'), 'b');
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub', 'c.txt'), 'c');
  return root;
}

function prog(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-walk-p-'));
  const f = path.join(dir, 'p.cjs');
  fs.writeFileSync(f, body);
  return f;
}

// Body reads ROOT (argv[2]) and prints a stable JSON snapshot of the walk APIs.
const BODY = `
  const fs = require('node:fs');
  const path = require('node:path');
  const root = process.argv[2];
  const sortName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  (async () => {
    const out = {};
    // readdirSync withFileTypes -> Dirent with working type predicates
    out.syncWft = fs.readdirSync(root, { withFileTypes: true }).sort(sortName)
      .map((d) => ({ name: d.name, dir: d.isDirectory(), file: d.isFile() }));
    // promises.readdir withFileTypes
    out.promWft = (await fs.promises.readdir(root, { withFileTypes: true })).sort(sortName)
      .map((d) => ({ name: d.name, dir: d.isDirectory() }));
    // recursive readdir (strings, relative) -> sorted
    out.recursive = fs.readdirSync(root, { recursive: true }).slice().sort();
    // callback readdir + lstat + realpath
    out.cbReaddir = await new Promise((res, rej) => fs.readdir(root, (e, r) => e ? rej(e) : res(r.slice().sort())));
    const st = await new Promise((res, rej) => fs.lstat(path.join(root, 'sub'), (e, s) => e ? rej(e) : res(s)));
    out.cbLstatDir = st.isDirectory();
    out.cbRealpath = (await new Promise((res, rej) => fs.realpath(root, (e, r) => e ? rej(e) : res(r)))).endsWith(path.basename(root));
    console.log(JSON.stringify(out));
  })();
`;

test('fs walk surface (readdir withFileTypes/recursive + cb family) matches node', (t) => {
  if (skipUnlessTjs(t)) return;
  const root = fixtureTree();
  const f = prog(BODY);
  const node = JSON.parse(
    require('node:child_process').execFileSync(process.execPath, [f, root], { encoding: 'utf8' }).trim());
  const r = runLoader(f, [root]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), node);
});

// THE NAME'S ENCODING (every-tool Task 4, 2026-11-20): readdir and readlink honour `encoding`, 'buffer' included,
// as node does. The shim ignored it and answered strings, and the carve's ExitWorktree, which vets each worktree
// registration name with `Buffer.from(n.toString('utf8')).equals(n)`, threw on them: `action: "remove"` kept the
// worktree where native removed it (test/fidelity/tools-local.test.cjs drives that turn).
const ENCODING_BODY = `
  const fs = require('node:fs');
  const path = require('node:path');
  const root = process.argv[2];
  const show = (v) => (Buffer.isBuffer(v) ? { buffer: v.toString('hex') } : v);
  const byName = (a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);
  (async () => {
    const out = {};
    for (const enc of ['buffer', 'hex', 'utf8', undefined]) {
      const key = String(enc);
      out[key] = {
        sync: fs.readdirSync(root, enc && { encoding: enc }).map(show).sort(byName),
        str: enc ? fs.readdirSync(root, enc).map(show).sort(byName) : null,
        prom: (await fs.promises.readdir(root, { encoding: enc })).map(show).sort(byName),
        wft: fs.readdirSync(root, { withFileTypes: true, encoding: enc }).map((d) => [show(d.name), d.isDirectory()]).sort(byName),
        link: show(fs.readlinkSync(path.join(root, 'ln'), enc && { encoding: enc })),
        plink: show(await fs.promises.readlink(path.join(root, 'ln'), { encoding: enc })),
      };
    }
    out.equals = Buffer.from('a.txt').equals(fs.readdirSync(root, 'buffer').find((b) => b.toString() === 'a.txt'));
    console.log(JSON.stringify(out));
  })();
`;

test('readdir and readlink answer in the caller\'s encoding (buffer, hex, utf8, default) as node does', (t) => {
  if (skipUnlessTjs(t)) return;
  const root = fixtureTree();
  fs.symlinkSync('sub/c.txt', path.join(root, 'ln'));
  const f = prog(ENCODING_BODY);
  const node = JSON.parse(
    require('node:child_process').execFileSync(process.execPath, [f, root], { encoding: 'utf8' }).trim());
  assert.deepStrictEqual(node.buffer.link, { buffer: Buffer.from('sub/c.txt').toString('hex') }); // the oracle's shape
  const r = runLoader(f, [root]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), node);
});
