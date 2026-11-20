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

const LABEL_RE = /\b((?:macos|ubuntu|windows)-(?:latest|\d[\d.]*)(?:-(?:arm64|arm|intel|large|xlarge))?)\b/g;

// Labels USED in a file's text, skipping comment lines (# for YAML, // for JS): prose
// about a retired image (this file's own reason for existing) is not a use of it.
function labelsIn(text) {
  const out = new Set();
  for (const line of String(text).split('\n')) {
    if (/^\s*(#|\/\/)/.test(line)) continue;
    for (const m of line.matchAll(LABEL_RE)) out.add(m[1]);
  }
  return [...out];
}

// The runner-images README's table: which labels are offered, and which rows carry the
// "deprecated" badge. A row is `| <name + badges> | <arch> | <labels in backticks> | ... |`.
function parseRunnerReadme(md) {
  const offered = new Set();
  const deprecated = new Set();
  for (const line of String(md).split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 5) continue;
    const labels = [...(cells[3] || '').matchAll(/`([a-z0-9.-]+)`/g)].map((m) => m[1]);
    if (!labels.length) continue;
    const isDeprecated = /deprecated/i.test(cells[1] || '');
    for (const l of labels) (isDeprecated ? deprecated : offered).add(l);
  }
  // A label listed in both a live and a deprecated row (e.g. a family's x64 and arm64
  // rows) is offered — but NOT safely: report it as deprecated too.
  return { offered: [...offered, ...deprecated], deprecated: [...deprecated] };
}

module.exports = { ALLOWED, RETIRED, labelsIn, parseRunnerReadme };
