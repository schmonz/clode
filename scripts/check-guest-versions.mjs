#!/usr/bin/env node
// Weekly guest-catalog watcher (.github/workflows/guest-versions.yml).
// Division of labor with Renovate: Renovate's BUILT-IN datasources can't
// read these catalogs (cpa publishes OS images as release ASSETS of its
// *-builder repos; vmactions versions are conf filenames), but its
// customDatasources CAN — .github/renovate.json teaches it the EXPLICIT
// ci-guest-version pins (annotated in scripts/tjs-legs.mjs), and it opens
// bump PRs that automerge only on green CI. This watcher is the backstop
// for everything Renovate doesn't own: OSes whose ci pin is still implicit
// (base value, pre-floor-walk), release FLOORS that must still EXIST in
// their catalog (a pulled image breaks release day — Renovate never checks
// existence), and GH-hosted runner labels. It compares the manifest's pins
// (ci tier = newest end, per the 2026-07-11 user decision) against the live
// catalogs and exits nonzero on drift. Pure logic (cmpVersions/drift) is
// characterized by test/check-guest-versions.test.cjs; the network sweep
// runs in CI only.
import { legsFor } from './tjs-legs.mjs';

// Segment-wise natural compare over the formats the catalogs actually use:
// 10.1 / 7.10 / 6.4.2 / r151058 / r1beta5 / 202604-build / 11.4-gcc.
export function cmpVersions(a, b) {
  const seg = (s) => String(s).split(/[.-]/).flatMap((p) => p.match(/\d+|\D+/g) ?? []);
  const A = seg(a), B = seg(b);
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    const x = A[i] ?? '', y = B[i] ?? '';
    if (x === y) continue;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) - Number(y);
    return x < y ? -1 : 1;
  }
  return 0;
}

// null = pin is the catalog max; otherwise a human-readable drift line.
export function drift(leg, pinned, catalog) {
  if (!catalog.length) return `${leg}: catalog is EMPTY (source moved?)`;
  if (!catalog.includes(pinned)) return `${leg}: pinned ${pinned} not in catalog [${catalog.join(', ')}]`;
  const max = catalog.slice().sort(cmpVersions).at(-1);
  if (cmpVersions(max, pinned) > 0) return `${leg}: ${max} available (pinned ${pinned})`;
  return null;
}

const API = 'https://api.github.com';
async function gh(path) {
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'clode-guest-versions' };
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  const r = await fetch(`${API}${path}`, { headers });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}

// cpa: OS versions are the assets of the newest builder release, named
// <os>-<version>-<arch>.qcow2[.zst]. arch: x86-64 | arm64 (guest action maps
// x86_64 -> x86-64).
async function cpaCatalog(platform, arch) {
  const rels = await gh(`/repos/cross-platform-actions/${platform}-builder/releases?per_page=5`);
  const assets = rels[0]?.assets?.map((a) => a.name) ?? [];
  const want = arch === 'arm64' ? 'arm64' : 'x86-64';
  const re = new RegExp(`^${platform}-(.+)-${want}\\.qcow2`);
  return assets.map((n) => re.exec(n)?.[1]).filter(Boolean);
}

// vmactions: versions are <release>.conf files in the action repo.
async function vmactionsCatalog(platform) {
  const files = await gh(`/repos/vmactions/${platform}-vm/contents/conf`);
  return files.map((f) => f.name).filter((n) => n.endsWith('.conf') && n !== 'default.release.conf')
    .map((n) => n.replace(/\.conf$/, ''));
}

// GH-hosted runner labels from the runner-images README.
async function runnerLabels() {
  const readme = await gh('/repos/actions/runner-images/contents/README.md');
  const text = Buffer.from(readme.content, 'base64').toString('utf8');
  return [...new Set([...text.matchAll(/`((?:macos|ubuntu|windows)-[a-z0-9.-]+)`/g)].map((m) => m[1]))];
}

const VMACTIONS = new Set(['solaris', 'openindiana']);

async function main() {
  // ci pins are the NEWEST end — held to catalog max. Release pins are
  // FLOORS (oldest proven, older than max by design) — only required to
  // still EXIST in the catalog (a pulled image breaks release day).
  const ci = legsFor('ci');
  const release = legsFor('release');

  const problems = [];
  const catalogs = new Map();
  const catalogFor = async (l) => {
    const gp = l['guest-platform'];
    const key = `${gp}/${l['guest-arch'] ?? 'x86_64'}`;
    if (!catalogs.has(key)) {
      catalogs.set(key, VMACTIONS.has(gp) ? await vmactionsCatalog(gp) : await cpaCatalog(gp, l['guest-arch']));
    }
    return catalogs.get(key);
  };
  const isVmLeg = (l) => l['guest-platform'] && !['native', 'alpine'].includes(l['guest-platform']);  // alpine exempt: static output
  for (const l of ci.filter(isVmLeg)) {
    const d = drift(l.leg, l['guest-version'], await catalogFor(l));
    if (d) problems.push(`ci ${d}`);
  }
  for (const l of release.filter(isVmLeg)) {
    const cat = await catalogFor(l);
    if (!cat.includes(l['guest-version'])) {
      problems.push(`release ${l.leg}: floor ${l['guest-version']} not in catalog [${cat.join(', ')}]`);
    }
  }

  // Native runner labels, two checks: every pinned label (both tiers) must
  // still be offered — a retired label breaks that leg outright — and each
  // CI-tier native pin (the newest end) is flagged when a newer same-variant
  // generation label appears. Release natives are floors: old by design,
  // only the still-offered check applies.
  const labels = await runnerLabels();
  const gen = (s) => Number((s.match(/-(\d+)/) ?? [])[1] ?? NaN);
  const variant = (s) => s.replace(/^(macos|ubuntu)-[\d.]+/, '');
  const isPlain = (s) => !/latest|large|xlarge|slim|vs\d/.test(s);
  const native = (list) => list.filter((l) => (!l['guest-platform'] || l['guest-platform'] === 'native') && /^(macos|ubuntu)-\d/.test(l.os));
  for (const l of [...native(ci), ...native(release)]) {
    if (!labels.includes(l.os)) problems.push(`${l.leg}: runner label ${l.os} no longer offered`);
  }
  for (const l of native(ci)) {
    const family = l.os.match(/^(macos|ubuntu)/)[1];
    const newer = labels.filter((x) => x.startsWith(family) && variant(x) === variant(l.os) && isPlain(x) && gen(x) > gen(l.os));
    if (newer.length) problems.push(`${l.leg}: newer runner ${newer.sort(cmpVersions).at(-1)} exists (ci pinned ${l.os})`);
  }

  if (problems.length) {
    console.log('GUEST VERSION DRIFT:');
    for (const p of problems) console.log('  ' + p);
    process.exit(1);
  }
  console.log('all guest/runner pins are at their catalog max');
}

import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.stack); process.exit(2); });
}
