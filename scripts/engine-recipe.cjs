#!/usr/bin/env node
// engine-recipe — ONE identity for "which engine sources was this tjs built from".
//
// THE BLINDNESS THIS CLOSES. A published engine template is not made by a
// separate pipeline: it is the un-blobulated half of the release artifact, produced
// by the same job, in the same run, at the same commit (.github/workflows/
// release.yml downloads `tjs-*` from the CURRENT run; .github/actions/build-leg
// uploads exactly the file it passed as CLODE_TJS). So the template is only ever
// as fresh as the release that carried it — and NOTHING in the reuse path could
// see that:
//
//   * The engine fetch URL is keyed on VERSION (libexec/clode-build.cjs,
//     releaseBaseUrl), and VERSION only moves at a release cut. A clode built
//     from HEAD therefore downloads the newest TAG's engines while carrying
//     HEAD's node-shim.
//   * The only gate on reuse (libexec/clode-templates.cjs, obtainEngine)
//     compares manifestPin against thisPin — both derived from
//     spike/quickjs/PINS.md, which records the UPSTREAM txiki tag+sha. That has
//     not moved since 2026-07-06, while the 23 patches in spike/quickjs/patches/
//     move constantly. The check passes VACUOUSLY on a stale engine.
//   * The node-constants ABI marker (scripts/gen-node-constants.mjs, `const ABI`)
//     is hand-maintained and covers one table, not the engine. The uid/gid fix
//     (906af8b) shipped inside txiki-sync-fs.patch with no bump.
//
// So: hash the engine's SOURCES, and let anything that cares compare hashes.
//
// WHY THIS FILE SET, VERBATIM. It is not invented here. It is the set the tjs
// build cache is ALREADY keyed on (.github/actions/build-leg/action.yml, the
// "Restore the built tjs" step). That set is load-bearing and battle-tested —
// its own comment records that a version-blind key once restored a 7.9-built tjs
// into an openbsd@7.6 probe and CI "silently smoked the WRONG binary". A second,
// independently-authored list of "what an engine is made of" is precisely the
// two-hand-maintained-lists disease this repo keeps paying for
// (test/release-gate-globs.test.cjs is the standing monument to it). So the
// action now CALLS this script for its key, and this list is the only copy.
//
// DEV/CI TOOLING ONLY. Nothing on the `clode build` path imports this: quaude
// must keep building on a host with no node at all. Its output is consumed by
// CI (the cache key) and by scripts/templates-drift.mjs.
//
// COMMONJS, AND IT HAS TO STAY THAT WAY. This was ESM until 2026-09-21, and that
// one fact made a node-free developer build impossible. The build graph
// (scripts/build-graph.cjs) DERIVES `engine.source`s inputs and count, and
// `engine.compile`s inputs, from this file; the developer entry point runs that
// graph under tjs through libexec/node-shim/loader.cjs, which is a CommonJS host.
// `import.meta` outside Module goal is an EARLY PARSE ERROR, so an ESM recipe
// could not even load far enough to say what was wrong -- what escaped was the
// bare engine message "import.meta only valid in module code", a true statement
// about a parser and a useless one about a build. So: no `import`, no `export`,
// no `import.meta`, no top-level await, and nothing required from here may have
// them either. That is not a style rule, it is the one thing standing between
// this repo and `./build.sh` on a machine with no node.
//
// IT IS A GATE, NOT A COMMENT. test/build-graph.test.cjs plans the WHOLE graph
// under tjs and compares it to the plan under node, count for count. Reintroduce
// ESM here (or anywhere this reaches) and that goes red with the step named.
// scripts/stage0.mjs is the cautionary sibling: 7 `import.meta` and 4 dynamic
// `import()`, and it is why the shim cannot host the rest of the toolchain yet.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

// The engine-source file set. Keep IDENTICAL to what the tjs cache key covers —
// test/engine-recipe.test.cjs pins both ends. Globs are POSIX, root-relative,
// and `*` matches within one path segment only (all we have ever needed, and all
// GitHub's hashFiles patterns here use).
const FILES = [
  'spike/quickjs/PINS.md',
  'spike/quickjs/patches/*.patch',
  // The cosmo leg's patches are engine sources too, and they were NOT in the
  // historical cache-key list -- an omission that cost 13 commits of red. When
  // f8546da regenerated the constants patch it renamed the very identifiers
  // patches/libtjs-cosmo.patch used as context, so the cosmo patch stopped
  // applying; the recipe hash did not move, so nothing said the engine sources
  // had changed. Widening the set is safe (it can only invalidate more), and
  // narrowing is what test/engine-recipe.test.cjs exists to catch.
  'patches/*.patch',
  'scripts/build-tjs.cjs',
  // build-tjs.cjs is not a monolith: it requires SIX modules directly, and
  // those modules ARE the engine orchestration now, not helpers beside it.
  // scripts/tjs-source-reset.cjs decides what "pristine" means BEFORE a
  // single patch applies. scripts/engine-api-floor.cjs generates the sanity
  // check that would have caught the moduleMeta bug (see ci-guest-bake.sh
  // below) anywhere it now runs, not just in the one place it was first
  // hand-written. scripts/build-depscan.cjs and scripts/depscan-verdict.cjs
  // together are the hermeticity gate the build refuses to skip. Only the
  // pre-split entry point was ever named here, which is the same
  // one-recipe-two-lists disease this file exists to end — just with the
  // second list living inside build-tjs.cjs's own require graph instead of a
  // separate cache-key comment. Left uncovered, an edit to any of the four
  // changes what the engine is built from, or what it is verified against,
  // while moving no recipe hash — so the cache would restore an engine built,
  // or "verified" as sound, by a different recipe than the one now in the
  // tree.
  'scripts/tjs-source-reset.cjs',
  'scripts/engine-api-floor.cjs',
  'scripts/build-depscan.cjs',
  'scripts/depscan-verdict.cjs',
  // ADDED 2026-09-19 (review). The first pass at this list said "the four modules
  // build-tjs.cjs requires directly" when there were SIX, so the list was wrong by its
  // own stated rule on the day it was written. scripts/ccache-launcher.cjs decides what
  // COMPILER INVOCATION the engine is built with (it was added one commit earlier on the
  // same branch); scripts/platform-tag.cjs decides where the vendor checkout, the build
  // dir and the output live. Neither moved a recipe hash. test/engine-recipe.test.cjs now
  // DERIVES this sublist from build-tjs.cjs's own require graph instead of trusting a
  // third hand-count -- a new require goes red there the moment it is added.
  'scripts/ccache-launcher.cjs',
  'scripts/platform-tag.cjs',
  // ADDED 2026-09-19. scripts/ar-determinism.cjs decides whether cmake gets deterministic
  // ARCHIVE rules (`ar qcD` / `ranlib -D`) or rides ZERO_AR_DATE instead -- i.e. whether two
  // builds of identical objects produce the same .a files and therefore the same linked
  // engine. Edit it and what the engine is assembled from changes; it is engine source by
  // exactly the argument ccache-launcher.cjs is. The derived check in
  // test/engine-recipe.test.cjs named it the moment build-tjs.cjs required it, which is the
  // ratchet doing its job rather than a third hand-count catching up.
  'scripts/ar-determinism.cjs',
  // ADDED 2026-09-20. scripts/bundle-inputs-gate.cjs decides whether the source phase is
  // ALLOWED TO RUN AT ALL: it derives what the JS bundle step needs (the pinned esbuild,
  // and txiki's own dependency tree, which esbuild bundles INTO the engine) and refuses a
  // checkout that lacks it. Widen its derivation and a tree that used to build is refused;
  // narrow it and a tree that cannot bundle gets through -- either way what the engine is
  // built from changes. Same argument as ar-determinism.cjs above, and the derived check in
  // test/engine-recipe.test.cjs named it the same way: the moment build-tjs.cjs required
  // it, without anyone remembering to.
  'scripts/bundle-inputs-gate.cjs',
  // ADDED 2026-09-20. scripts/provision-bundle-inputs.sh is what PUTS the JS bundle step's
  // inputs on disk when npm is not available: the pinned esbuild binary and txiki's own
  // bundled dependency tree, both of which esbuild links INTO the engine. It is the
  // sibling half of bundle-inputs-gate.cjs above — that file decides whether the source
  // phase may run, this one decides what it runs AGAINST — so it is engine source by the
  // identical argument. Change which tarball it fetches, or how it verifies one, and what
  // the engine is built from changes while every .c file stays put.
  //
  // THE ONE ENTRY THE DERIVED CHECK CANNOT NAME. test/engine-recipe.test.cjs derives the
  // orchestration sublist from build-tjs.cjs's own require graph, which is how the last
  // three additions were found without a hand-count. A shell script is not required, it is
  // SPAWNED, so that ratchet is structurally blind to it and this entry is a deliberate
  // hand-add. Recorded here rather than silently, because "the derivation found it" is the
  // property that makes the rest of this list trustworthy and this line does not have it.
  'scripts/provision-bundle-inputs.sh',
  // ADDED 2026-09-20. scripts/file-prefix-map.cjs decides whether the absolute path a
  // build ran from is REWRITTEN OUT of the objects (-ffile-prefix-map, or the older
  // -fdebug-prefix-map/-fmacro-prefix-map pair, or nothing on a compiler that takes
  // neither). Those are compile flags: edit this file and every object the engine is
  // assembled from changes byte-for-byte. Exactly the argument that put
  // ccache-launcher.cjs and ar-determinism.cjs here, and the derived check in
  // test/engine-recipe.test.cjs named it the moment build-tjs.cjs required it.
  'scripts/file-prefix-map.cjs',
  // The netbsd-sparc in-guest ENGINE bake recipe. It is engine source for that
  // leg in the most literal sense — it IS the compile — yet an edit to it moved
  // nothing, so the tjs cache happily restored an engine built by a DIFFERENT
  // recipe. That blindness is how the bake went a whole leg-lifetime compiling
  // the upstream pin's committed bytecode with no regen (the moduleMeta bug,
  // 2026-08-29). Widening costs a matrix-wide rebuild whenever this rarely-touched
  // file changes; being wrong here costs a stale engine nobody can see.
  'spike/quickjs/qemu/ci-guest-bake.sh',
  'scripts/*.toolchain.cmake',
  'spike/quickjs/atomic-shim.c',
  'ci/osxcross-darwin/Dockerfile',
];

function repoRoot() {
  return path.resolve(__dirname, '..');
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// A "source" is anything that can list a directory and read a file by
// root-relative POSIX path. Two implementations, and they answer two DIFFERENT
// questions: the working tree (what is on disk right now), and a git rev (what a
// published manifest's tag contained — evaluated WITHOUT checking anything out, so
// no worktree mutation, no stash, safe to run mid-edit).
//
// THE WORKING TREE LISTS ITSELF. This used to be `git ls-files`, and the recipe
// was therefore defined as "the TRACKED engine sources". That was one word of
// precision bought at a price nobody had measured: the build graph
// (scripts/build-graph.cjs) DERIVES engine.compile's declared inputs from this
// expansion, and scripts/build-runner.cjs checks declared inputs BEFORE the step
// runs — so every machine that compiles the engine had to be able to run `git`,
// against a repository git was willing to talk about. Three classes of machine in
// this repo's own matrix cannot:
//
//   * midnightbsd-amd64's VM guest ships NO git, deliberately and with a written
//     reason (scripts/tjs-legs.mjs: the 4.0.4 mport tree's git dep chain is
//     broken). No package fixes that leg.
//   * the cross-container legs run stock `debian:trixie` with a cross-apt list
//     that installs a compiler, not a git; darwin-ppc's baked image installs
//     nothing at all.
//   * EVERY docker leg runs as root over a bind mount owned by uid 1001, which is
//     git's "detected dubious ownership" refusal — present git, no answer.
//
// Each of those would have been refused before compiling a tree that was handed
// to it complete, because it could not enumerate a SOURCE RECIPE the compile step
// never reads. A red that says "your inputs are missing" when they are all there
// is not feedback, it is noise — and `--needs assume` exists precisely for those
// machines. So the listing is a readdir, everywhere, with no `if (git)` branch to
// leave two answers in the tree.
//
// WHAT TRACKED-ONLY WAS ACTUALLY BUYING, and how it is still bought. Its own
// comment named one hazard: this mount sprays AppleDouble `._*` sidecars next to
// every file ([[git-gc-fails-appledouble]]), and a plain readdir picks them up, so
// the same commit hashed differently on this mac than on a Linux runner. That is a
// one-line exclusion (`._`), the same one scripts/build-graph.cjs's libexec walk
// already makes for the same reason. Everything else the glob patterns already
// filter: FILES names individual files plus `*.patch` / `*.toolchain.cmake` in
// three directories, and nothing in this build writes into any of them. The set a
// CI workspace contains — which is what GitHub's hashFiles saw, and hashFiles is
// itself a filesystem glob, not a git query — is the set this returns.
//
// AND THE DIFFERENCE IS GATED, NOT ASSERTED. test/engine-recipe.test.cjs runs both
// listings on any box that has git and reddens on any path one names and the other
// does not, so "the git-free answer is the git answer" is measured on every test
// run rather than believed. An untracked `*.patch` sitting in the tree is a real
// finding there: it moves YOUR recipe hash and it will not move CI's.
function worktreeSource(root = repoRoot()) {
  const abs = (rel) => path.join(root, ...rel.split('/'));
  return {
    label: 'working tree',
    list(dir) {
      let ents;
      try { ents = fs.readdirSync(abs(dir), { withFileTypes: true }); }
      catch (e) {
        // Empty, not loud, and ONLY here: `expand` already turns "this pattern
        // matched nothing" into a fatal error naming the pattern and the source,
        // which is the message a missing engine-source directory should produce.
        // Throwing our own would replace it with a worse one (an ENOENT for a path
        // the caller never named) at the one call site that can say more.
        if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return [];
        throw e;
      }
      return ents.filter((e) => !e.isDirectory() && !e.name.startsWith('._')).map((e) => e.name);
    },
    has(rel) {
      if (path.posix.basename(rel).startsWith('._')) return false;
      try { return fs.statSync(abs(rel)).isFile(); } catch { return false; }
    },
    read(rel) {
      try { return fs.readFileSync(abs(rel)); }
      catch (e) {
        throw new Error(`engine-recipe: engine source '${rel}' is missing from the working tree (${e.code}) — `
          + 'restore it (git checkout -- ' + rel + ') before computing a recipe');
      }
    },
  };
}

// The same listing, asked of `git ls-files` instead of the filesystem. NOT USED BY
// THE RECIPE, and that is the whole point of it being here: it is the control half
// of the gate in test/engine-recipe.test.cjs that proves worktreeSource() still
// answers what git answers. It lives beside its twin rather than in the test so
// that the two listings are read together, and it REFUSES rather than falling back
// (a git-free box gets `null` from gitLsFiles below and the gate skips with a
// reason) — a silent empty answer would make the comparison vacuous, which is the
// one way a gate like this fails without saying so.
function trackedSource(root = repoRoot()) {
  const listed = gitLsFiles(root);
  if (!listed) return null;
  const set = new Set(listed);
  return {
    label: 'git ls-files',
    list(dir) {
      return listed.filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
        .map((p) => p.slice(dir.length + 1));
    },
    has(rel) { return set.has(rel); },
    read(rel) { return fs.readFileSync(path.join(root, ...rel.split('/'))); },
  };
}

// Every path git tracks under `root`, or null where git cannot say — no git on
// PATH, not a repository, or the dubious-ownership refusal. null is a legitimate
// answer HERE (and only here) because the one caller is a comparison that has
// nothing to compare against without it; nothing on the build path asks.
function gitLsFiles(root = repoRoot()) {
  try {
    return execFileSync('git', ['-C', root, 'ls-files', '-z'],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

function gitSource(rev, root = repoRoot()) {
  const git = (args, opts = {}) =>
    execFileSync('git', ['-C', root, ...args], { maxBuffer: 256 * 1024 * 1024, ...opts });
  return {
    label: `git ${rev}`,
    list(dir) {
      let out;
      // --full-tree: paths (and the pathspec) are root-relative regardless of cwd.
      try { out = git(['ls-tree', '--full-tree', rev, '--', `${dir}/`], { encoding: 'utf8' }); }
      catch { return []; }
      return out.split('\n').filter(Boolean).map((line) => {
        const [meta, p] = line.split('\t');
        return meta.split(' ')[1] === 'blob' ? p.slice(dir.length + 1) : null;
      }).filter((n) => n && !n.includes('/'));
    },
    has(rel) {
      try { git(['cat-file', '-e', `${rev}:${rel}`], { stdio: 'ignore' }); return true; }
      catch { return false; }
    },
    read(rel) { return git(['show', `${rev}:${rel}`]); },
  };
}

function globToRe(basename) {
  return new RegExp('^' + basename.replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === '*' ? '[^/]*' : '\\' + c)) + '$');
}

// Expand FILES against a source. A pattern that matches NOTHING is fatal, not
// empty: silently hashing fewer files is exactly the blindness this exists to
// remove — a typo'd glob would make every tree look identical.
function expand(src, patterns = FILES) {
  const out = new Set();
  for (const pat of patterns) {
    let matched = [];
    if (pat.includes('*')) {
      const dir = path.posix.dirname(pat);
      const re = globToRe(path.posix.basename(pat));
      matched = src.list(dir).filter((n) => re.test(n)).map((n) => `${dir}/${n}`);
    } else if (src.has(pat)) {
      matched = [pat];
    }
    if (!matched.length) {
      throw new Error(`engine-recipe: pattern '${pat}' matched no files in ${src.label} — `
        + 'the engine-source set is wrong, or this tree is not a clode checkout');
    }
    for (const m of matched) out.add(m);
  }
  // Byte-sort: the hash must not depend on readdir order or on ls-tree's.
  return [...out].sort();
}

// { hash, files: [{ path, sha }] }. Content-addressed only — no mtimes, no
// sizes, no cwd, no path separators from the host. The path is folded into the
// digest alongside its content so that ADDING or REMOVING a file moves the hash
// even when the remaining bytes are unchanged.
function recipeDetail(src = worktreeSource(), patterns = FILES) {
  const files = expand(src, patterns).map((p) => ({ path: p, sha: sha256(src.read(p)) }));
  const hash = sha256(files.map((f) => `${f.path} ${f.sha}\n`).join(''));
  return { hash, files };
}

function recipe(src = worktreeSource(), patterns = FILES) {
  return recipeDetail(src, patterns).hash;
}

const short = (h) => h.slice(0, 12);

function main(argv) {
  let rev = null; let mode = 'hash'; let want = 'full';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--rev') rev = argv[++i];
    else if (a === '--short') want = 'short';
    else if (a === '--files') mode = 'files';
    else if (a === '--json') mode = 'json';
    else { process.stderr.write(`usage: engine-recipe.cjs [--rev REV] [--short] [--files|--json]\n`); process.exit(2); }
  }
  const src = rev ? gitSource(rev) : worktreeSource();
  const d = recipeDetail(src);
  if (mode === 'files') process.stdout.write(d.files.map((f) => `${f.sha}  ${f.path}`).join('\n') + '\n');
  else if (mode === 'json') process.stdout.write(JSON.stringify({ ...d, rev: rev || null }, null, 2) + '\n');
  else process.stdout.write((want === 'short' ? short(d.hash) : d.hash) + '\n');
}

module.exports = { FILES, repoRoot, worktreeSource, trackedSource, gitLsFiles, gitSource, expand,
  recipeDetail, recipe, short };

if (require.main === module) main(process.argv.slice(2));
