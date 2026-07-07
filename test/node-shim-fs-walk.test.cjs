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
