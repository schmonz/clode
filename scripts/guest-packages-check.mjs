#!/usr/bin/env node
// Guest-package catalog checker (.github/workflows/upstream-drift.yml, job `guest-packages`).
//
// THE CLASS. An engine CI leg installs guest OS packages named in scripts/tjs-legs.mjs
// (`guest-packages`). A guest package manager can drop a name on any day with no change in
// this repo: FreeBSD 15.x quarterly dropped the `cmake` metapackage (now `cmake-core`) and
// ci run 45354661143's freebsd-amd64 leg died "No packages available to install matching
// 'cmake'" -- after a 15-minute VM boot. Nothing noticed earlier.
//
// WHAT THIS DOES. For every leg in every tier of the manifest that declares guest-packages,
// it works out the exact catalog the guest's package manager will read (OS version and
// arch from the leg, repo URL from the guest action's install step in
// .github/actions/guest/action.yml), fetches that catalog over HTTPS (no VM), and checks
// every name resolves the way THAT package manager resolves it:
//   pkg (FreeBSD, DragonFly)  package name, or origin (`devel/cmake-core`). pkg install does
//                             not resolve shared-lib `provides`, so neither do we.
//   pkgin (NetBSD)            PKGBASE (PKGNAME minus -version). PROVIDES= is shared libs.
//   pkg_add (OpenBSD)         stem (file name minus -version[-flavor]).
//   IPS pkg (OmniOS, OpenIndiana)  full FMRI name, or trailing path components
//                             (`cmake` matches `developer/build/cmake`), across every
//                             publisher repo the guest has (OmniOS: core + extra).
//
// NEVER A SILENT PASS. A leg whose catalog we cannot read is listed by name as UNCHECKED
// with the reason; a catalog that should be readable but fails to fetch is a FETCH-FAILED
// finding (a mirror outage fails the run: "we could not check" is not "all present").
// Exit: 0 = every checkable name resolved, 1 = a name is missing, 2 = a fetch/parse failed.
//
// Pure core (plan -> parse -> resolve -> findings) is exported and characterized by
// test/guest-packages-check.test.cjs with fixtures; only main() touches the network.
// xz catalogs (DragonFly) need a host `xz`; absent, that leg is UNCHECKED, not skipped.
import { gunzipSync, zstdDecompressSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { legsFor } from './tjs-legs.mjs';

// ---------------------------------------------------------------- planning (pure)

const major = (v) => String(v).split('.')[0];
const majorMinor = (v) => String(v).split('.').slice(0, 2).join('.');
const archOf = (map, leg) => map[leg['guest-arch'] ?? 'default'];

// plan(leg) -> { kind: 'check', style, label, urls: [[url, ...mirrors]] }
//            | { kind: 'unchecked', reason } | { kind: 'none', reason }
export function planLeg(leg) {
  const platform = leg['guest-platform'];
  const pkgs = String(leg['guest-packages'] ?? '').split(/\s+/).filter(Boolean);
  if (!pkgs.length) return { kind: 'none', reason: 'declares no guest-packages' };
  const v = String(leg['guest-version']);
  switch (platform) {
    case 'freebsd': {
      const arch = archOf({ default: 'amd64', amd64: 'amd64', arm64: 'aarch64' }, leg);
      if (!arch) return { kind: 'unchecked', reason: `freebsd: no ABI mapping for guest-arch ${leg['guest-arch']}` };
      const abi = `FreeBSD:${major(v)}:${arch}`;
      return { kind: 'check', style: 'pkg', label: abi,
        urls: [[`https://pkg.freebsd.org/${abi}/quarterly/packagesite.pkg`]] };
    }
    case 'dragonflybsd': {
      const abi = `dragonfly:${majorMinor(v)}:x86:64`;
      return { kind: 'check', style: 'pkg', label: abi,
        urls: [[`https://mirror-master.dragonflybsd.org/dports/${abi}/LATEST/packagesite.pkg`]] };
    }
    case 'netbsd': {
      const arch = archOf({ default: 'x86_64', arm64: 'aarch64' }, leg);
      if (!arch) return { kind: 'unchecked', reason: `netbsd: no pkgsrc arch for guest-arch ${leg['guest-arch']}` };
      const tail = `/pub/pkgsrc/packages/NetBSD/${arch}/${v}/All/pkg_summary.gz`;
      return { kind: 'check', style: 'pkgin', label: `NetBSD/${arch}/${v}`,
        urls: [[`https://cdn.netbsd.org${tail}`, `https://ftp.netbsd.org${tail}`]] };
    }
    case 'openbsd': {
      const arch = archOf({ default: 'amd64', amd64: 'amd64', arm64: 'aarch64' }, leg);
      if (!arch) return { kind: 'unchecked', reason: `openbsd: no arch mapping for guest-arch ${leg['guest-arch']}` };
      return { kind: 'check', style: 'openbsd', label: `OpenBSD/${v}/${arch}`,
        urls: [[`https://cdn.openbsd.org/pub/OpenBSD/${v}/packages/${arch}/index.txt`]] };
    }
    case 'omnios':
      // The guest has two publishers: omnios (core) and extra.omnios (ooce/*).
      return { kind: 'check', style: 'ips', label: `OmniOS ${v} core+extra`,
        urls: ['core', 'extra'].map((r) => [`https://pkg.omnios.org/${v}/${r}/catalog/1/catalog.base.C`]) };
    case 'openindiana':
      // guest-version names the vmactions IMAGE; its repo is the rolling hipster publisher.
      return { kind: 'check', style: 'ips', label: 'OpenIndiana hipster',
        urls: [['https://pkg.openindiana.org/hipster/catalog/1/catalog.base.C']] };
    case 'solaris':
      return { kind: 'unchecked', reason: 'pkg.oracle.com/solaris/release answers every anonymous TLS handshake with a '
        + 'handshake_failure alert (measured 2026-11-24, curl and node fetch); most likely a client-certificate requirement' };
    case 'haiku':
      return { kind: 'unchecked', reason: 'HaikuPorts catalog is a binary HPKR repo (compressed heap + attribute tree) '
        + 'and no HPKR reader exists in the repo; not adding one here' };
    case 'midnightbsd':
      return { kind: 'unchecked', reason: 'mport\'s index is not a pkg/pkgsrc-style text catalog and no reader for it '
        + 'exists in the repo' };
    default:
      return { kind: 'unchecked', reason: `no catalog adapter for guest-platform '${platform}'` };
  }
}

// Every distinct (leg, tier-resolved version, packages) across every tier.
export function targets(tiers = ['release', 'ci'], legSource = legsFor) {
  const seen = new Map();
  for (const tier of tiers) {
    for (const leg of legSource(tier)) {
      if (!leg['guest-platform'] || ['native', 'alpine'].includes(leg['guest-platform'])) continue;
      const key = [leg.leg, leg['guest-version'], leg['guest-packages']].join('|');
      if (seen.has(key)) seen.get(key).tiers.push(tier);
      else seen.set(key, { leg, tiers: [tier] });
    }
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------- parsing (pure)

// Minimal ustar reader: [{ name, data }] for regular files.
export function readTar(buf) {
  const out = [];
  for (let off = 0; off + 512 <= buf.length;) {
    const h = buf.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const name = h.subarray(0, 100).toString('latin1').replace(/\0.*$/, '');
    const size = parseInt(h.subarray(124, 136).toString('latin1').replace(/\0.*$/, '').trim() || '0', 8);
    const type = String.fromCharCode(h[156] || 48);
    off += 512;
    if (type === '0' || type === '\0') out.push({ name, data: buf.subarray(off, off + size) });
    off += Math.ceil(size / 512) * 512;
  }
  return out;
}

// Compression by magic number; xz needs the host tool.
export function decompress(buf, { xz = hostXz } = {}) {
  if (buf[0] === 0x28 && buf[1] === 0xb5 && buf[2] === 0x2f && buf[3] === 0xfd) return zstdDecompressSync(buf);
  if (buf[0] === 0x1f && buf[1] === 0x8b) return gunzipSync(buf);
  if (buf[0] === 0xfd && buf[1] === 0x37 && buf[2] === 0x7a && buf[3] === 0x58) return xz(buf);
  return buf;                                           // already plain
}
export class Unreadable extends Error {}                // -> UNCHECKED, not a failure
function hostXz(buf) {
  const r = spawnSync('xz', ['-dc'], { input: buf, maxBuffer: 1 << 30 });
  if (r.error || r.status !== 0) throw new Unreadable('catalog is xz-compressed and no working host `xz` was found');
  return r.stdout;
}

// pkg(8) packagesite.pkg (a tar of packagesite.yaml: one JSON object per line).
export function parsePkgsite(tarBuf) {
  const f = readTar(tarBuf).find((e) => e.name === 'packagesite.yaml');
  if (!f) throw new Error('packagesite.pkg has no packagesite.yaml member');
  const names = new Set(), origins = new Set();
  for (const line of f.data.toString('utf8').split('\n')) {
    if (!line.trim()) continue;
    const o = JSON.parse(line);
    if (o.name) names.add(o.name);
    if (o.origin) origins.add(o.origin);
  }
  return { names, origins };
}

// pkgsrc pkg_summary: blank-line separated KEY=VALUE records.
export function parsePkgSummary(text) {
  const names = new Set();
  for (const rec of text.split(/\n\n+/)) {
    const base = /^PKGBASE=(.+)$/m.exec(rec)?.[1];
    const full = /^PKGNAME=(.+)$/m.exec(rec)?.[1];
    if (base) names.add(base);
    else if (full) names.add(full.replace(/-[^-]*$/, ''));
  }
  return { names };
}

// OpenBSD index.txt: `ls -l` lines ending in <stem>-<version>[-flavor].tgz.
export function parseOpenbsdIndex(text) {
  const names = new Set();
  for (const line of text.split('\n')) {
    const m = /\s(\S+)\.tgz\s*$/.exec(line);
    if (!m) continue;
    names.add(m[1].replace(/-\d.*$/, ''));
  }
  return { names };
}

// IPS catalog.base.C: { _FEATURE, <publisher>: { <name>: [versions] }, _SIGNATURE }.
export function parseIpsCatalog(text) {
  const names = new Set();
  const j = JSON.parse(text);
  for (const [pub, pk] of Object.entries(j)) {
    if (pub.startsWith('_') || !pk || typeof pk !== 'object' || Array.isArray(pk)) continue;
    for (const n of Object.keys(pk)) names.add(n);
  }
  return { names };
}

export const PARSERS = {
  pkg: (buf, o) => parsePkgsite(decompress(buf, o)),
  pkgin: (buf, o) => parsePkgSummary(decompress(buf, o).toString('utf8')),
  openbsd: (buf, o) => parseOpenbsdIndex(decompress(buf, o).toString('utf8')),
  ips: (buf, o) => parseIpsCatalog(decompress(buf, o).toString('utf8')),
};

// ---------------------------------------------------------------- resolving (pure)

export function merge(catalogs) {
  const names = new Set(), origins = new Set();
  for (const c of catalogs) {
    for (const n of c.names) names.add(n);
    for (const o of c.origins ?? []) origins.add(o);
  }
  return { names, origins };
}

// How `name` resolves under `style`; returns the matching catalog name, or null.
export function resolve(style, cat, name) {
  if (style === 'ips') {
    if (cat.names.has(name)) return name;
    for (const n of cat.names) if (n.endsWith(`/${name}`)) return n;     // trailing components
    return null;
  }
  if (cat.names.has(name)) return name;
  if (style === 'pkg') for (const o of cat.origins) if (o === name) return o;
  return null;
}

// Near misses for a missing name: what a human would reach for (cmake -> cmake-core).
export function suggest(cat, name, limit = 5) {
  const out = [];
  for (const n of [...cat.names, ...(cat.origins ?? [])]) {
    if (n.startsWith(`${name}-`) || n.startsWith(`${name}_`) || n.endsWith(`/${name}`) || n.includes(`/${name}-`)) out.push(n);
  }
  return out.sort((a, b) => a.length - b.length || (a < b ? -1 : 1)).slice(0, limit);
}

// findings for one leg against its (merged) catalog.
export function checkPackages({ leg, tiers, style, label, catalog, packages }) {
  return packages.map((name) => {
    const via = resolve(style, catalog, name);
    return via
      ? { status: 'ok', leg, tiers, label, name, via }
      : { status: 'missing', leg, tiers, label, name, suggestions: suggest(catalog, name) };
  });
}

export const splitPackages = (leg) => String(leg['guest-packages'] ?? '').split(/\s+/).filter(Boolean);

// ---------------------------------------------------------------- network (impure)

// Rounds over the mirror list (a dead mirror costs one timeout per round, not all rounds).
async function fetchBuf(urls, { attempts = 2, timeoutMs = 45000 } = {}) {
  const errs = [];
  for (let i = 1; i <= attempts; i++) {
    for (const url of urls) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return { url, buf: Buffer.from(await r.arrayBuffer()) };
      } catch (e) {
        errs.push(`${url}: ${e.cause?.message ?? e.message}`);
      }
    }
    if (i < attempts) await new Promise((res) => setTimeout(res, 3000));
  }
  throw new Error(errs.join('; '));
}

export async function runAll({ log = console.log } = {}) {
  const cache = new Map();                              // url-group key -> parsed catalog | Error
  const findings = [], unchecked = [], none = [], failed = [];
  for (const { leg, tiers } of targets()) {
    const plan = planLeg(leg);
    if (plan.kind === 'none') { none.push({ leg: leg.leg, tiers, reason: plan.reason }); continue; }
    if (plan.kind === 'unchecked') { unchecked.push({ leg: leg.leg, tiers, reason: plan.reason }); continue; }
    const cats = [];
    let stop = null;
    for (const group of plan.urls) {
      const key = `${plan.style}|${group[0]}`;
      if (!cache.has(key)) {
        try {
          const { buf } = await fetchBuf(group);
          cache.set(key, PARSERS[plan.style](buf));
        } catch (e) { cache.set(key, e); }
      }
      const c = cache.get(key);
      if (c instanceof Error) { stop = c; break; }
      cats.push(c);
    }
    if (stop instanceof Unreadable) { unchecked.push({ leg: leg.leg, tiers, reason: stop.message }); continue; }
    if (stop) { failed.push({ leg: leg.leg, tiers, label: plan.label, error: stop.message }); continue; }
    findings.push(...checkPackages({ leg: leg.leg, tiers, style: plan.style, label: plan.label,
      catalog: merge(cats), packages: splitPackages(leg) }));
  }
  report({ findings, unchecked, none, failed }, log);
  const missing = findings.some((f) => f.status === 'missing');
  return { findings, unchecked, none, failed, code: failed.length ? 2 : missing ? 1 : 0 };
}

export function report({ findings, unchecked, none, failed }, log = console.log) {
  const by = new Map();
  for (const f of findings) {
    const k = `${f.leg} [${f.tiers.join('+')}] ${f.label}`;
    (by.get(k) ?? by.set(k, []).get(k)).push(f);
  }
  for (const [k, fs] of by) {
    const bad = fs.filter((f) => f.status === 'missing');
    log(`${bad.length ? 'MISSING' : 'ok     '} ${k}: ${fs.map((f) => f.name).join(' ')}`);
    for (const f of bad) {
      log(`    '${f.name}' is not installable here`
        + (f.suggestions.length ? `; the catalog has: ${f.suggestions.join(', ')}` : ' (and nothing similar)'));
    }
  }
  for (const f of failed) log(`FETCH-FAILED ${f.leg} [${f.tiers.join('+')}] ${f.label}: ${f.error}`);
  for (const u of unchecked) log(`UNCHECKED ${u.leg} [${u.tiers.join('+')}]: ${u.reason}`);
  for (const n of none) log(`(no packages) ${n.leg} [${n.tiers.join('+')}]: ${n.reason}`);
  const miss = findings.filter((f) => f.status === 'missing').length;
  log(`guest-packages: ${findings.length - miss} resolved, ${miss} missing, ${failed.length} fetch-failed, ${unchecked.length} UNCHECKED`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // No top-level await: test/build-gates/guest-packages-gates.test.cjs require()s this module.
  runAll().then(({ code }) => process.exit(code), (e) => { console.error(e); process.exit(2); });
}
