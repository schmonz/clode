#!/usr/bin/env node
'use strict';
// clode-signals — JS port of libexec/clode-signals (Python oracle). Surface
// Anthropic's direction-of-travel signals on update. Byte-identical to the
// Python original in stdout (digest + --json), the snapshot file, and exit code.
const fs = require('node:fs');
const path = require('node:path');
const { pyJson } = require('./clode-jsutil.cjs');

// --- bundle phrase scan -------------------------------------------------------
const BUNDLE_PHRASES = [
  ['requires the native binary', 'high'],
  ['install.sh instead of npm', 'high'],
  ['not supported under npm', 'high'],
  ['typeof Bun', 'info'],
];

// --- changelog keyword scan ---------------------------------------------------
const CHANGELOG_HIGH = [
  /\bbun\b.{0,30}\b(runtime|version|upgrade|requir)/i,
  /\b(requir|need)\w*\b.{0,30}\bnative\b/i,
  /\b(requir|need)\w*\b.{0,30}\bnode\b/i,
  /\bnative binary\b/i,
  /install\.sh/i,
  /\bno longer\b.{0,30}\b(npm|node|support)/i,
  /\bdrop\w*\b.{0,20}\bnpm\b/i,
  /\bdeprecat\w*\b.{0,40}\b(npm|node|install|runtime)\b/i,
];
const CHANGELOG_MED = [
  /\bbun\b/i,
  /\bnode(\.js)?\b.{0,30}\b(version|requir|minimum|>=|v?\d)/i,
  /\bruntime\b/i,
];

const VER_RE = /^##\s+(\d+\.\d+\.\d+)\s*$/;

const verKey = (v) => v.split('.').map((x) => parseInt(x, 10));

// Tuple compare like Python's (a,b,c) < (d,e,f). verKey always yields length-3
// tuples here (gated by VER_RE), so a fixed 3-wide compare is exact.
function cmpKey(a, b) {
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] - b[i]; }
  return 0;
}

function parseChangelog(text) {
  // Return [[version, [lines]]] in file order (newest first, as published).
  const sections = []; let cur = null, buf = [];
  for (const line of text.split('\n')) {
    const m = line.trim().match(VER_RE);
    if (m) {
      if (cur !== null) sections.push([cur, buf]);
      cur = m[1]; buf = [];
    } else if (cur !== null) {
      buf.push(line);
    }
  }
  if (cur !== null) sections.push([cur, buf]);
  return sections;
}

function scanChangelog(text, version, prev) {
  // Flag lines in the (prev, version] release-note range. If prev is null or
  // not found, scan only `version`'s own section.
  const vk = verKey(version);
  const pk = prev ? verKey(prev) : null;
  const flags = [];
  for (const [ver, lines] of parseChangelog(text)) {
    const k = verKey(ver);
    // VER_RE guarantees three numeric components; no ValueError equivalent.
    const inRange = pk === null
      ? cmpKey(k, vk) === 0
      : (cmpKey(pk, k) < 0 && cmpKey(k, vk) <= 0);
    if (!inRange) continue;
    for (const ln of lines) {
      const s = ln.trim();
      if (!s || s === '-') continue;
      const tier = CHANGELOG_HIGH.some((r) => r.test(s)) ? 'high'
        : CHANGELOG_MED.some((r) => r.test(s)) ? 'med' : null;
      if (tier) flags.push({ version: ver, tier, line: s.replace(/^[-\s]+/, '').trim() });
    }
  }
  return flags;
}

function scanBundle(p) {
  // Count concern phrases in the bundle/binary bytes. latin1 preserves a 1:1
  // byte<->char mapping so indexOf over the decoded string counts raw bytes.
  const counts = {};
  if (!p || !fs.existsSync(p)) return counts;
  const data = fs.readFileSync(p, 'latin1');
  for (const [phrase] of BUNDLE_PHRASES) {
    let n = 0, i = 0;
    while ((i = data.indexOf(phrase, i)) !== -1) { n++; i += phrase.length; }
    counts[phrase] = n;
  }
  return counts;
}

function loadPrevSnapshot(dir, prev) {
  if (!(dir && prev)) return null;
  const p = path.join(dir, prev + '.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function buildSnapshot(version, bundleCounts, changelogFlags) {
  return { version, bundle_phrases: bundleCounts, changelog_flags: changelogFlags };
}

function phraseDeltas(cur, prevSnap) {
  // New phrases or changed counts vs the previous snapshot.
  const prev = (prevSnap || {}).bundle_phrases || {};
  const out = [];
  for (const [phrase, n] of Object.entries(cur)) {
    const has = Object.prototype.hasOwnProperty.call(prev, phrase);
    const was = has ? prev[phrase] : undefined;
    if (!has && n) out.push([phrase, null, n]);
    else if (has && n !== was) out.push([phrase, was, n]);
  }
  return out;
}

function render(snapshot, prevSnap, prevVer, rangeFlags) {
  const L = [];
  const ver = snapshot.version;
  const hi = rangeFlags.filter((f) => f.tier === 'high');
  const md = rangeFlags.filter((f) => f.tier === 'med');
  const deltas = phraseDeltas(snapshot.bundle_phrases, prevSnap);
  const rangeDesc = !prevVer ? ver : `${prevVer}..${ver}`;

  L.push(`clode signals for ${ver}${!prevVer ? '' : `  (release notes ${rangeDesc})`}:`);

  if (hi.length) {
    L.push('  release notes (HIGH — bears on running under Node):');
    for (const f of hi) L.push(`    ⚠ ${f.version}: ${f.line}`);
  }
  if (deltas.length) {
    L.push(`  bundle markers changed vs ${prevVer || '—'}:`);
    const highPhrases = new Set(
      BUNDLE_PHRASES.filter(([, t]) => t === 'high').map(([p]) => p));
    for (const [phrase, was, now] of deltas) {
      const chg = was === null ? `new, x${now}` : `x${was} → x${now}`;
      const mark = highPhrases.has(phrase) ? ' ⚠' : '';
      L.push(`    ${phrase} (${chg})${mark}`);
    }
  }
  if (md.length && (hi.length || deltas.length || prevSnap === null)) {
    L.push('  release notes (runtime/packaging churn, fyi):');
    for (const f of md.slice(0, 8)) L.push(`    · ${f.version}: ${f.line}`);
  }

  if (!hi.length && !deltas.length && !md.length) {
    L.push('  no new native-binary / runtime / npm signals.');
  }
  return L.join('\n');
}

function parseArgs(argv) {
  // Mirror the argparse surface: --version (required), --prev, --bundle,
  // --changelog-file, --snapshot-dir, --json (store_true).
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--json') a.json = true;
    else if (t.startsWith('--')) a[t.slice(2)] = argv[++i];
  }
  if (!a.version) {
    process.stderr.write('clode-signals: --version is required\n');
    process.exit(2);
  }
  return a;
}

function main(argv) {
  const a = parseArgs(argv);

  const bundleCounts = scanBundle(a.bundle);
  // Snapshot stores THIS version's own notes (reproducible regardless of which
  // prev you updated from). The printed digest scans the (prev, version] range.
  let ownFlags = [], rangeFlags = [];
  const cl = a['changelog-file'];
  if (cl && fs.existsSync(cl)) {
    const text = fs.readFileSync(cl, 'utf8');
    ownFlags = scanChangelog(text, a.version, null);
    rangeFlags = a.prev ? scanChangelog(text, a.version, a.prev) : ownFlags;
  }

  const snapshot = buildSnapshot(a.version, bundleCounts, ownFlags);
  const prevSnap = loadPrevSnapshot(a['snapshot-dir'], a.prev);

  if (a['snapshot-dir']) {
    try {
      fs.mkdirSync(a['snapshot-dir'], { recursive: true });
      fs.writeFileSync(
        path.join(a['snapshot-dir'], a.version + '.json'),
        pyJson(snapshot, { sortKeys: true }) + '\n');
    } catch { /* warn-only: a read-only install just gets the printed digest */ }
  }

  if (a.json) process.stdout.write(pyJson(snapshot, { sortKeys: true }) + '\n');
  else process.stdout.write(render(snapshot, prevSnap, a.prev, rangeFlags) + '\n');
  return 0; // always: warn-only, never block an update
}

process.exit(main(process.argv.slice(2)));
