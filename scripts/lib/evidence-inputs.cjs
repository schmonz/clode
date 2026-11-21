'use strict';
// THE INPUTS A LOCAL CELL RUN PROVES (USER RULING 2026-11-21, every-tool ruling E11): what a quaude built from this tree
// is made of, hashed cheaply, so committed VM evidence can be held to the tree it ran on. Two hashes:
//   engine  scripts/engine-recipe.cjs's recipe, the ONE identity of the engine's sources (the tjs cache key's set);
//   quaude  every file under libexec/ (the builder and everything it puts in a quaude: bun-shim, node-shim, the rg and
//           unicode replacements, the bootstrap) plus scripts/stage0.mjs (the build's entry) and UPSTREAM_PIN (the
//           provider it carves).
// Content-addressed only (path + sha256 per file, byte-sorted), so it is the same on every host: the tree checks out
// LF everywhere (.gitattributes). The evidence writer (scripts/netbsd-arm64-evidence.mjs) records both at the commit it
// ran; test/build-gates/tool-coverage-gates.test.cjs compares them with the tree it judges, and a difference turns its
// verdict red, naming the re-run command. Wider than strictly needed on purpose: an edit that cannot change a cell
// still asks for a re-run, while a narrower set could let one that does slip past.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO = path.resolve(__dirname, '..', '..');
const QUAUDE_INPUTS = ['libexec', 'scripts/stage0.mjs', 'UPSTREAM_PIN'];
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');

function walk(root, rel, out) {
  const abs = path.join(root, ...rel.split('/'));
  const st = fs.statSync(abs);
  if (st.isFile()) { out.push(rel); return; }
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    if (e.name.startsWith('._') || e.name === 'node_modules') continue;   // AppleDouble litter, installed deps
    if (e.isDirectory() || e.isFile()) walk(root, `${rel}/${e.name}`, out);
  }
}

function treeHash(root, entries) {
  const files = [];
  for (const e of entries) walk(root, e, files);
  files.sort();
  return sha256(files.map((f) => `${f} ${sha256(fs.readFileSync(path.join(root, ...f.split('/'))))}\n`).join(''));
}

// -> { engine, quaude }: hex sha256s of the tree at `root` (the repository by default).
function evidenceInputs(root = REPO) {
  const { recipe, worktreeSource } = require(path.join(REPO, 'scripts', 'engine-recipe.cjs'));
  return { engine: recipe(worktreeSource(root)), quaude: treeHash(root, QUAUDE_INPUTS) };
}

module.exports = { evidenceInputs, treeHash, QUAUDE_INPUTS };
