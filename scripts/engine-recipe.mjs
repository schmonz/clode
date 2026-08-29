#!/usr/bin/env node
// engine-recipe — ONE identity for "which engine sources was this tjs built from".
//
// THE BLINDNESS THIS CLOSES. A published engine template is not made by a
// separate pipeline: it is the un-fused half of the release artifact, produced
// by the same job, in the same run, at the same commit (.github/workflows/
// release.yml downloads `tjs-*` from the CURRENT run; .github/actions/build-leg
// uploads exactly the file it passed as CLODE_TJS). So the template is only ever
// as fresh as the release that carried it — and NOTHING in the reuse path could
// see that:
//
//   * The engine fetch URL is keyed on VERSION (libexec/clode-fuse.cjs,
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
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The engine-source file set. Keep IDENTICAL to what the tjs cache key covers —
// test/engine-recipe.test.cjs pins both ends. Globs are POSIX, root-relative,
// and `*` matches within one path segment only (all we have ever needed, and all
// GitHub's hashFiles patterns here use).
export const FILES = [
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
  'scripts/build-tjs.mjs',
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

export function repoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// A "source" is anything that can list a directory and read a file by
// root-relative POSIX path. Two implementations: the working tree, and a git
// rev (so a published manifest's tag can be evaluated WITHOUT checking anything
// out — no worktree mutation, no stash, safe to run mid-edit).
// The working tree, restricted to git-TRACKED paths, with content read from
// disk (so an uncommitted edit to a patch DOES move the recipe — that is the
// point). Tracked-only is not fastidiousness: this mount sprays AppleDouble
// `._*` sidecars next to every file ([[git-gc-fails-appledouble]]), and a plain
// readdir picks them up, so the same commit hashed differently on this mac than
// on a Linux runner. Tracked-only is also exactly what a CI workspace contains,
// which is what GitHub's hashFiles saw.
export function worktreeSource(root = repoRoot()) {
  const abs = (rel) => path.join(root, ...rel.split('/'));
  const git = (args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const tracked = (pathspec) => {
    let out;
    try { out = git(['ls-files', '-z', '--', pathspec]); }
    catch (e) {
      // Loud, not empty: "git could not tell us" is not "nothing is tracked".
      throw new Error(`engine-recipe: cannot list tracked files under ${root} (${e.message.trim()}) — `
        + 'the recipe is defined over committed engine sources and needs a git checkout');
    }
    return out.split('\0').filter(Boolean);
  };
  return {
    label: 'working tree',
    list(dir) {
      return tracked(`${dir}/`).filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/'))
        .map((p) => p.slice(dir.length + 1));
    },
    has(rel) { return tracked(rel).includes(rel) && fs.existsSync(abs(rel)); },
    read(rel) {
      try { return fs.readFileSync(abs(rel)); }
      catch (e) {
        throw new Error(`engine-recipe: tracked engine source '${rel}' is missing from the working tree (${e.code}) — `
          + 'restore it (git checkout -- ' + rel + ') before computing a recipe');
      }
    },
  };
}

export function gitSource(rev, root = repoRoot()) {
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
export function expand(src, patterns = FILES) {
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
export function recipeDetail(src = worktreeSource(), patterns = FILES) {
  const files = expand(src, patterns).map((p) => ({ path: p, sha: sha256(src.read(p)) }));
  const hash = sha256(files.map((f) => `${f.path} ${f.sha}\n`).join(''));
  return { hash, files };
}

export function recipe(src = worktreeSource(), patterns = FILES) {
  return recipeDetail(src, patterns).hash;
}

export const short = (h) => h.slice(0, 12);

function main(argv) {
  let rev = null; let mode = 'hash'; let want = 'full';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--rev') rev = argv[++i];
    else if (a === '--short') want = 'short';
    else if (a === '--files') mode = 'files';
    else if (a === '--json') mode = 'json';
    else { process.stderr.write(`usage: engine-recipe.mjs [--rev REV] [--short] [--files|--json]\n`); process.exit(2); }
  }
  const src = rev ? gitSource(rev) : worktreeSource();
  const d = recipeDetail(src);
  if (mode === 'files') process.stdout.write(d.files.map((f) => `${f.sha}  ${f.path}`).join('\n') + '\n');
  else if (mode === 'json') process.stdout.write(JSON.stringify({ ...d, rev: rev || null }, null, 2) + '\n');
  else process.stdout.write((want === 'short' ? short(d.hash) : d.hash) + '\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
