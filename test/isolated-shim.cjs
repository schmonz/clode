'use strict';
// Run fail-loud shim children with module resolution ISOLATED from the repo's own
// node_modules: copy the (self-contained) bun-shim.cjs into a temp dir OUTSIDE the
// repo and require it from there, with cwd in that temp dir. Then `require("ws")`
// (in the shim AND in the body) walks up a clean chain and can't reach
// <repo>/node_modules — so a stray root `npm install` can't make the deps
// spuriously resolvable and defeat the fail-loud assertions. NODE_PATH is still
// honored (appended after the clean walk) for the "fake dep" cases.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

let _dir = null;
function isoDir() {
  if (_dir && fs.existsSync(_dir)) return _dir;
  _dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-shimiso-'));
  fs.copyFileSync(path.resolve(__dirname, '../libexec/bun-shim.cjs'), path.join(_dir, 'bun-shim.cjs'));
  return _dir;
}
// Run `node -e '<prelude requiring the isolated shim as Bun>; <body>'`. env overrides
// (e.g. NODE_PATH for fake-dep cases) merge over a base with NODE_PATH cleared.
function runShimChild(body, env = {}) {
  const dir = isoDir();
  const shim = path.join(dir, 'bun-shim.cjs');
  return spawnSync(process.execPath,
    ['-e', `const Bun=require(${JSON.stringify(shim)});\n${body}`],
    { encoding: 'utf8', cwd: dir, env: { ...process.env, NODE_PATH: '', ...env } });
}
module.exports = { isoDir, runShimChild, shimPath: () => path.join(isoDir(), 'bun-shim.cjs') };
