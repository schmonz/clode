'use strict';
// THE INPUTS A LOCAL CELL RUN PROVES (USER RULING 2026-11-21, every-tool ruling E11): what a quaude built from this tree
// is made of, hashed cheaply, so committed VM evidence can be held to the tree it ran on. Two hashes:
//   engine  scripts/engine-recipe.cjs's recipe, the ONE identity of the engine's sources (the tjs cache key's set);
//   quaude  every file under libexec/ (the builder and everything it puts in a quaude: bun-shim, node-shim, the rg and
//           unicode replacements, the bootstrap) plus scripts/stage0.mjs (the build's entry) and UPSTREAM_PIN (the
//           provider it carves).
//   drivers the claimed driver files and their LOCAL require closure (every relative require literal, followed file to
//           file: test/tool-driver.cjs, the mock helper, scripts/lib/tool-result.cjs, ...), derived from the source,
//           never hand-listed. A tightened assertion or a harness edit is a check the evidence never ran, so it asks
//           for a re-run; it also means the evidence is bound to the drivers' CONTENT, not to their line numbers.
// Content-addressed only (path + sha256 per file, byte-sorted), so it is the same on every host: the tree checks out
// LF everywhere (.gitattributes). The evidence writer (scripts/netbsd-arm64-evidence.mjs) records all three at the commit it
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

// The local closure of `files` (repo-relative POSIX): each file, and every file it names by a path the source spells
// out in literals, followed until nothing new appears:
//   - a relative require literal (`require('../tool-driver.cjs')`), resolved as node does (exact, then .js/.cjs/.mjs/
//     .json, then index.*);
//   - a path built from __dirname and string literals only, directly or through a binding made that way
//     (`const ROOT = path.resolve(__dirname, '..')`, then `path.join(ROOT, 'test', 'x.cjs')`): a require through it, a
//     script a driver spawns, a fixture it reads. Only a path naming a FILE counts (a directory is a search root, not
//     an input).
// NOT followed (EVIDENCE_UNHASHED, said in BACKLOG): a path with any non-literal part (a variable, a template, a value
// from the environment), and anything under node_modules.
const REL_REQUIRE = /\brequire\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*\)/g;
const LIT = String.raw`(?:'[^'\\\n]*'|"[^"\\\n]*")`;
const BASE_BINDING = new RegExp(String.raw`\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*path\.(?:resolve|join)\(\s*__dirname\s*((?:,\s*${LIT}\s*)*)\)`, 'g');
const PATH_CALL = (bases) => new RegExp(String.raw`\bpath\.(?:resolve|join)\(\s*(${bases.join('|')})\s*((?:,\s*${LIT}\s*)+)\)`, 'g');
const lits = (argText) => [...argText.matchAll(new RegExp(LIT, 'g'))].map((m) => m[0].slice(1, -1));
const EVIDENCE_UNHASHED = 'a path built with any non-literal part (a variable, a template, an environment value), and node_modules';
function requireClosure(root, files) {
  const seen = new Set();
  const todo = [...files];
  const abs = (rel) => path.join(root, ...rel.split('/'));
  const isFile = (rel) => { try { return fs.statSync(abs(rel)).isFile(); } catch { return false; } };
  const resolve = (fromRel, spec) => {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
    for (const c of [base, ...['.js', '.cjs', '.mjs', '.json'].map((e) => base + e), ...['index.js', 'index.cjs'].map((i) => `${base}/${i}`)]) {
      if (isFile(c)) return c;
    }
    return null;
  };
  const add = (r) => { if (r && !r.startsWith('../') && !r.split('/').includes('node_modules') && !seen.has(r)) todo.push(r); };
  while (todo.length) {
    const f = todo.pop();
    if (seen.has(f)) continue;
    seen.add(f);
    if (!/\.(c|m)?js$/.test(f)) continue;
    const text = fs.readFileSync(abs(f), 'utf8');
    for (const m of text.matchAll(REL_REQUIRE)) add(resolve(f, m[2]));
    const dir = path.posix.dirname(f);
    const bases = new Map([['__dirname', dir]]);
    for (const m of text.matchAll(BASE_BINDING)) bases.set(m[1], path.posix.normalize(path.posix.join(dir, ...lits(m[2]))));
    const names = [...bases.keys()].map((k) => k.replace(/\$/g, '\\$'));
    for (const m of text.matchAll(PATH_CALL(names))) {
      const rel = path.posix.normalize(path.posix.join(bases.get(m[1]), ...lits(m[2])));
      if (isFile(rel)) add(rel);
    }
  }
  return [...seen].sort();
}

// -> { engine, quaude, drivers }: hex sha256s of the tree at `root` (the repository by default); `drivers` covers the
// require closure of `driverFiles` (a local run's claimed files).
function evidenceInputs(root = REPO, driverFiles = []) {
  const { recipe, worktreeSource } = require(path.join(REPO, 'scripts', 'engine-recipe.cjs'));
  return { engine: recipe(worktreeSource(root)), quaude: treeHash(root, QUAUDE_INPUTS),
    drivers: treeHash(root, requireClosure(root, driverFiles)) };
}

module.exports = { evidenceInputs, treeHash, requireClosure, QUAUDE_INPUTS, EVIDENCE_UNHASHED };
