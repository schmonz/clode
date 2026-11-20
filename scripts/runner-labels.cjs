'use strict';
// GitHub-hosted runner image labels: the ONE list of labels this repo may run on, and the
// labels GitHub has retired. Two readers:
//   - test/runner-labels.test.cjs (offline, every push): every label used in .github/ and
//     scripts/tjs-legs.mjs must be in ALLOWED and must not be in RETIRED. A retired image
//     becomes a named red finding in a quick test, not an instant "The configuration ...
//     is not supported" cancel in the middle of a release.
//   - scripts/check-guest-versions.mjs (weekly, live): ALLOWED is checked against the
//     runner-images README, and a label that README marks DEPRECATED is a finding. That
//     is the early warning: deprecation is announced months before the label stops
//     working, and the watcher used to treat "listed anywhere in the README" as "offered".
//
// WHY THIS EXISTS. Release dry run 44653527211: the darwin-arm64 slice pinned `macos-14`,
// which GitHub retired for arm64 on 2026-11-02 (actions/runner-images#15226). The weekly
// watcher was green on 2026-11-16 because the README still lists `macos-14` — for the
// x64 Azure DevOps extension, under a "deprecated" badge. The leg was cancelled instantly
// and darwin-universal then failed as "missing slice arm64".
//
// Moving a pin: add the new label here, then move the pin. Retiring one: move it from
// ALLOWED to RETIRED with the announcement.

const ALLOWED = Object.freeze([
  'macos-15', 'macos-26', 'macos-latest',
  'ubuntu-22.04', 'ubuntu-22.04-arm', 'ubuntu-24.04', 'ubuntu-24.04-arm',
  'ubuntu-26.04', 'ubuntu-26.04-arm', 'ubuntu-latest',
  'windows-2025', 'windows-11-arm', 'windows-latest',
]);

const RETIRED = Object.freeze({
  'macos-13': 'retired (no longer in the actions/runner-images table)',
  'macos-14': 'arm64 retired 2026-11-02 (actions/runner-images#15226); release dry run 44653527211 cancelled on it',
  'ubuntu-20.04': 'retired (no longer in the actions/runner-images table)',
  'windows-2019': 'retired (no longer in the actions/runner-images table)',
});

// FAIL CLOSED. Labels are read from the places a runner label can appear -- a YAML
// `runs-on:` or `os:` value, and a tjs-legs.mjs `os:` / `'ci-os':` string -- and EVERY
// value found there counts, whatever its shape (ubuntu-slim, windows-2025-vs2026,
// macos-15-xlarge, xcode-..., or a typo). ALLOWED decides; no label-shaped regex does.
// A `${{ ... }}` expression is skipped: what it resolves to (the leg manifest) is
// scanned itself.
const CONTEXTS = [
  /^\s*(?:-\s*)?runs-on:\s*(.+?)\s*$/,                    // YAML runs-on: <label> | [a, b]
  /^\s*(?:-\s*)?os:\s*([^\s#'"{[][^\s#]*)\s*(?:#.*)?$/,   // YAML matrix `os: <label>`
];
const JS_CONTEXTS = [/(?:^|[\s{,])os:\s*'([^']+)'/g, /'ci-os':\s*'([^']+)'/g];

// Labels USED in a file's text, skipping comment lines (# for YAML, // for JS): prose
// about a retired image (this file's own reason for existing) is not a use of it.
function labelsIn(text) {
  const out = new Set();
  for (const line of String(text).split('\n')) {
    if (/^\s*(#|\/\/)/.test(line)) continue;
    for (const re of CONTEXTS) {
      const m = re.exec(line);
      if (!m) continue;
      let v = m[1].replace(/\s+#.*$/, '').trim();
      if (v.includes('${{')) continue;
      v = v.replace(/^\[|\]$/g, '');
      for (const part of v.split(',')) {
        const l = part.trim().replace(/^['"]|['"]$/g, '');
        if (l) out.add(l);
      }
    }
    for (const re of JS_CONTEXTS) for (const m of line.matchAll(re)) out.add(m[1]);
  }
  return [...out];
}

// The runner-images README's table: which labels are offered, and which rows carry the
// "deprecated" badge. A row is `| <name + badges> | <arch> | <labels in backticks> | ... |`.
function parseRunnerReadme(md) {
  const offered = new Set();
  const deprecated = new Set();
  const problems = [];
  let labelCol = -1;
  for (const line of String(md).split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    // The header names the label column; find it rather than assume its position.
    const hdr = cells.findIndex((c) => /^YAML Label$/i.test(c));
    if (hdr >= 0) { labelCol = hdr; continue; }
    if (labelCol < 0) continue;
    const labels = [...(cells[labelCol] || '').matchAll(/`([a-z0-9.-]+)`/g)].map((m) => m[1]);
    if (!labels.length) continue;
    // The badge may sit in ANY cell of the row.
    const isDeprecated = cells.some((c) => /deprecated/i.test(c));
    for (const l of labels) (isDeprecated ? deprecated : offered).add(l);
  }
  if (labelCol < 0) problems.push('runner-images README: no table with a "YAML Label" column -- the format moved; nothing was read');
  else if (offered.size + deprecated.size === 0) problems.push('runner-images README: the label table is empty');
  // A label listed in both a live and a deprecated row is offered -- but NOT safely.
  return { offered: [...offered, ...deprecated], deprecated: [...deprecated], problems };
}

module.exports = { ALLOWED, RETIRED, labelsIn, parseRunnerReadme };
