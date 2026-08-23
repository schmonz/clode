#!/usr/bin/env node
// templates-drift — THE QUESTION: were the engine templates users actually
// download built from the engine sources in this tree?
//
// WHY IT CAN BE "NO" WITHOUT ANYTHING LOOKING WRONG. An engine template is the
// un-fused half of a release artifact: same job, same run, same commit
// (release.yml collects `tjs-*` from the CURRENT run; build-leg uploads exactly
// the engine it fused against). It is therefore pinned to the last RELEASE, and
// two independent mechanisms make that invisible:
//
//   * `clode build --target X` fetches the pack from a URL keyed on VERSION
//     (libexec/clode-fuse.cjs releaseBaseUrl), and VERSION only moves at a
//     release cut. Build clode from HEAD and it downloads the newest TAG's
//     engines while carrying HEAD's node-shim.
//   * The one gate on reuse (libexec/clode-templates.cjs obtainEngine) compares
//     manifest.tjsPin against this clode's pin. BOTH come from
//     spike/quickjs/PINS.md, which records the UPSTREAM txiki tag+sha. It has
//     not moved since 2026-07-06 while the patches on top of it move weekly, so
//     the pin check passes VACUOUSLY on a three-week-old engine.
//
// The result is a fix that is committed, tested, green, and simply ABSENT from
// every cross-built quaude — discovered three weeks later on someone's Linux
// box. This job converts that into a dated red light on the day it starts being
// true.
//
// HOW THE PUBLISHED SIDE IS DERIVED, HONESTLY. Today's manifests carry no
// `recipe` field (a follow-up will emit one, and this reads it in preference the
// moment it appears). Until then the published recipe is computed AT THE TAG the
// manifest was released from — `git show <tag>:<path>` for each engine source,
// nothing checked out, the working tree untouched. That is sound because the
// engines in a release were built from that tag's tree by definition. If it
// cannot be computed, this FAILS and says why; it never shrugs and passes.
//
// DEV/CI TOOLING. Not on the `clode build` path (quaude must build with no node
// on the host at all).
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { recipeDetail, worktreeSource, gitSource, repoRoot, short } from './engine-recipe.mjs';

const ROOT = repoRoot();
const git = (args, opts = {}) =>
  execFileSync('git', ['-C', ROOT, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts }).trim();
const gitOk = (args) => { try { git(args, { stdio: ['ignore', 'pipe', 'ignore'] }); return true; } catch { return false; } };

class DriftError extends Error {}

// --- pure comparison, unit-tested offline ---------------------------------

// Per-file verdict between two recipe details. Named files, not "something
// changed": the whole complaint about the old pin check is that its answer was
// unactionable.
export function diffRecipes(published, current) {
  const a = new Map(published.files.map((f) => [f.path, f.sha]));
  const b = new Map(current.files.map((f) => [f.path, f.sha]));
  const changed = [];
  for (const p of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    if (!a.has(p)) changed.push({ path: p, status: 'added' });
    else if (!b.has(p)) changed.push({ path: p, status: 'removed' });
    else if (a.get(p) !== b.get(p)) changed.push({ path: p, status: 'modified' });
  }
  return changed;
}

// The whole report, as text. Takes data, returns a string — so a test can assert
// on the words that make it actionable without any network or git.
export function renderReport({ repo, tag, asset, publishedAt, pin, publishedHash, currentHash, head, changed, commits, derivedFrom }) {
  const L = [];
  const drifted = publishedHash !== currentHash;
  L.push(drifted ? 'ENGINE TEMPLATE DRIFT: the published engines are stale' : 'engine templates are in sync with this tree');
  L.push('');
  L.push(`  repo               ${repo}`);
  L.push(`  newest release     ${tag}${publishedAt ? `  (${publishedAt})` : ''}`);
  L.push(`  templates asset    ${asset}   tjsPin ${pin}`);
  L.push(`  published recipe   ${short(publishedHash)}   (${derivedFrom})`);
  L.push(`  this tree's recipe ${short(currentHash)}   (working tree${head ? `, HEAD ${head}` : ''})`);
  if (!drifted) return L.join('\n') + '\n';
  L.push('');
  L.push(`Engine sources that changed since ${tag} (${changed.length}):`);
  for (const c of changed) L.push(`  ${c.status.padEnd(8)} ${c.path}`);
  L.push('');
  L.push(commits.length
    ? `Commits responsible (${commits.length}), oldest last:`
    : 'No commits touch those files, which should be impossible — investigate before trusting this result.');
  for (const c of commits) L.push(`  ${c}`);
  L.push('');
  L.push('WHAT THIS MEANS: `clode build --target X` fetches its engine from the');
  L.push(`release URL keyed on VERSION, i.e. from ${tag}. Every engine fix above is`);
  L.push('therefore MISSING from every quaude cross-built by any clode, including one');
  L.push('built from this very commit. Nothing else in the system can notice: the');
  L.push('tjsPin gate compares an upstream txiki sha that these commits do not touch.');
  L.push('');
  L.push('REMEDY: cut a release (or re-run the templates pack) so the published');
  L.push('engines are rebuilt from these sources. The remedy is NOT to relax, skip,');
  L.push('or re-baseline this check — it is reporting a true fact about what users');
  L.push('would download right now.');
  return L.join('\n') + '\n';
}

// --- release lookup --------------------------------------------------------

export function repoSlug() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  try {
    const url = git(['remote', 'get-url', 'origin']);
    const m = url.match(/github\.com[:/]+([^/]+\/[^/.]+)/i);
    if (m) return m[1];
  } catch { /* fall through */ }
  throw new DriftError('cannot determine the GitHub repo (no GITHUB_REPOSITORY, no github origin remote) — pass --repo owner/name');
}

// gh first (it carries auth and rate limit headroom in CI), plain fetch as the
// fallback so this is runnable on a box without gh. Both failing is FATAL: "we
// could not ask" is not "nothing drifted".
async function api(pathname) {
  const errs = [];
  try { return JSON.parse(execFileSync('gh', ['api', pathname], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })); }
  catch (e) { errs.push(`gh api ${pathname}: ${String(e.message).split('\n')[0]}`); }
  try {
    const r = await fetch(`https://api.github.com/${pathname}`, { headers: { accept: 'application/vnd.github+json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } catch (e) { errs.push(`GET api.github.com/${pathname}: ${e.message}`); }
  throw new DriftError(`could not read the release from GitHub:\n  ${errs.join('\n  ')}`);
}

export async function fetchManifest(repo, tag) {
  const rel = await api(tag ? `repos/${repo}/releases/tags/${tag}` : `repos/${repo}/releases/latest`);
  const asset = (rel.assets || []).find((a) => /^templates-.*\.json$/.test(a.name));
  if (!asset) {
    throw new DriftError(`release ${rel.tag_name} publishes no templates-*.json asset — `
      + 'there is nothing for cross-builds to fetch, which is itself a defect worth fixing');
  }
  const r = await fetch(asset.browser_download_url);
  if (!r.ok) throw new DriftError(`GET ${asset.browser_download_url}: HTTP ${r.status}`);
  return { tag: rel.tag_name, publishedAt: rel.published_at, asset: asset.name, manifest: await r.json() };
}

// --- the check -------------------------------------------------------------

function publishedRecipe(tag, manifest) {
  // Preferred, once release.yml stamps it: the manifest states its own recipe.
  if (manifest && typeof manifest.recipe === 'string' && /^[0-9a-f]{64}$/.test(manifest.recipe)) {
    return { detail: null, hash: manifest.recipe, derivedFrom: 'manifest.recipe' };
  }
  if (!gitOk(['rev-parse', '-q', '--verify', `${tag}^{commit}`])) {
    if (!gitOk(['fetch', '--quiet', '--tags', 'origin'])
      || !gitOk(['rev-parse', '-q', '--verify', `${tag}^{commit}`])) {
      throw new DriftError(`the published manifest carries no recipe, so it must be derived from the tag it `
        + `was released at — but ${tag} is not in this checkout and could not be fetched.\n`
        + 'Check out with tags and full history (actions/checkout fetch-depth: 0).');
    }
  }
  let detail;
  try { detail = recipeDetail(gitSource(tag)); }
  catch (e) { throw new DriftError(`cannot compute the engine recipe at ${tag}: ${e.message}`); }
  return { detail, hash: detail.hash, derivedFrom: `computed from ${tag}` };
}

export async function check({ repo, tag, manifestFile } = {}) {
  const slug = repo || repoSlug();
  let found;
  if (manifestFile) {
    // --tag is needed only when the recipe must be DERIVED from the tag's tree.
    // A manifest that states its own recipe needs no tag at all, and demanding
    // one anyway made the stamped path unreachable on its own terms — the guard
    // predated the field it was written to anticipate.
    let m;
    try { m = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); }
    catch (e) { throw new DriftError(`cannot read the manifest ${manifestFile}: ${e.message}`); }
    const stamped = typeof m.recipe === 'string' && /^[0-9a-f]{64}$/.test(m.recipe);
    if (!tag && !stamped) {
      throw new DriftError('--manifest needs --tag: this manifest carries no recipe, so the published '
        + 'recipe must be derived from the tag it shipped at');
    }
    found = { tag, publishedAt: null, asset: manifestFile, manifest: m };
  } else {
    found = await fetchManifest(slug, tag);
  }
  const pub = publishedRecipe(found.tag, found.manifest);
  const cur = recipeDetail(worktreeSource());

  let changed = [];
  let commits = [];
  if (pub.hash !== cur.hash && pub.detail) {
    changed = diffRecipes(pub.detail, cur);
    const paths = [...new Set([...pub.detail.files, ...cur.files].map((f) => f.path))].sort();
    if (!gitOk(['merge-base', '--is-ancestor', `${found.tag}^{commit}`, 'HEAD'])) {
      throw new DriftError(`${found.tag} is not an ancestor of HEAD in this checkout (shallow clone?) — `
        + 'cannot name the commits responsible. Check out with fetch-depth: 0.');
    }
    commits = git(['log', '--oneline', '--no-decorate', `${found.tag}..HEAD`, '--', ...paths])
      .split('\n').filter(Boolean);
  }
  const report = renderReport({
    repo: slug,
    tag: found.tag,
    asset: found.asset,
    publishedAt: found.publishedAt,
    pin: found.manifest.tjsPin,
    publishedHash: pub.hash,
    currentHash: cur.hash,
    head: gitOk(['rev-parse', '--short', 'HEAD']) ? git(['rev-parse', '--short', 'HEAD']) : null,
    changed,
    commits,
    derivedFrom: pub.derivedFrom,
  });
  return { drifted: pub.hash !== cur.hash, report, publishedHash: pub.hash, currentHash: cur.hash, changed, commits };
}

async function main(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--repo' || k === '--tag' || k === '--manifest') a[k.slice(2)] = argv[++i];
    else { process.stderr.write('usage: templates-drift.mjs [--repo owner/name] [--tag vX] [--manifest FILE]\n'); process.exit(2); }
  }
  let res;
  try {
    res = await check({ repo: a.repo, tag: a.tag, manifestFile: a.manifest });
  } catch (e) {
    // Loud, and exit 2 so "could not check" is distinguishable from "drifted".
    process.stderr.write(`templates-drift: CANNOT ANSWER THE QUESTION\n  ${e.message}\n`
      + '  A check that cannot answer must not report success.\n');
    process.exit(2);
  }
  process.stdout.write(res.report);
  process.exit(res.drifted ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
