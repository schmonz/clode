'use strict';
// Every GitHub-hosted runner label this repo runs on is ALLOWED and none is RETIRED
// (scripts/runner-labels.cjs). Release dry run 44653527211: the darwin-arm64 slice was
// pinned to `macos-14`, retired for arm64 on 2026-11-02, and GitHub cancelled the leg
// instantly ("The configuration 'macos-14-arm64-us-default' is not supported") halfway
// through a release. This makes that a named red row on every push instead.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { defineGuard, guardTests } = require('./guard.cjs');
const { ALLOWED, RETIRED, labelsIn, parseRunnerReadme } = require('../scripts/runner-labels.cjs');

const REPO = path.resolve(__dirname, '..');

function sources() {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.ya?ml$/.test(e.name)) files.push(p);
    }
  };
  walk(path.join(REPO, '.github'));
  files.push(path.join(REPO, 'scripts/tjs-legs.mjs'));
  return files.map((f) => ({ file: path.relative(REPO, f), text: fs.readFileSync(f, 'utf8') }));
}

function scanRunnerLabels({ files, allowed, retired }) {
  const findings = [];
  let examined = 0;
  for (const { file, text } of files) {
    for (const l of labelsIn(text)) {
      examined++;
      if (retired[l]) findings.push(`${file}: runner label ${l} is RETIRED — ${retired[l]}`);
      else if (!allowed.includes(l)) findings.push(`${file}: runner label ${l} is not in scripts/runner-labels.cjs ALLOWED (add it there first)`);
    }
  }
  return { findings, examined };
}

const runnerLabelGuard = defineGuard({
  name: 'runner-labels-allowed-not-retired',
  read: () => ({ files: sources(), allowed: ALLOWED, retired: RETIRED }),
  scan: scanRunnerLabels,
  // ~a dozen distinct labels across the workflows and the leg manifest (2026-11-19).
  floor: 8,
  control: () => ({
    files: [{ file: 'scripts/tjs-legs.mjs', text: "  { leg: 'darwin-arm64', os: 'macos-14', 'ci-os': 'macos-26' },\n" }],
    allowed: ALLOWED, retired: RETIRED,
  }),
});
guardTests(runnerLabelGuard);

test('labelsIn: comment lines are prose, not uses', () => {
  assert.deepStrictEqual(labelsIn('# runs-on: macos-14 was retired\n// os: \'macos-13\'\n    runs-on: macos-26\n'), ['macos-26']);
  assert.deepStrictEqual(labelsIn("{ leg: 'x', os: 'ubuntu-22.04-arm', 'ci-os': 'ubuntu-26.04-arm' }").sort(), ['ubuntu-22.04-arm', 'ubuntu-26.04-arm']);
  assert.deepStrictEqual(labelsIn('          - os: windows-latest   # windows-amd64\n'), ['windows-latest']);
  assert.deepStrictEqual(labelsIn('    runs-on: ${{ matrix.os }}\n'), [], 'an expression is resolved from the manifest, not here');
  assert.deepStrictEqual(labelsIn('    runs-on: [self-hosted, macos-15]\n').sort(), ['macos-15', 'self-hosted']);
});

// FAIL CLOSED: the shape of a value never exempts it — ALLOWED decides.
for (const [label, text] of [
  ['ubuntu-slim', '    runs-on: ubuntu-slim\n'],
  ['windows-2025-vs2026', "  { leg: 'windows-amd64', os: 'windows-2025-vs2026' },\n"],
  ['macos-15-xlarge', '          - os: macos-15-xlarge\n'],
  ['xcode-16', '    runs-on: xcode-16\n'],
]) {
  test(`an unlisted label is a finding, whatever its shape: ${label}`, () => {
    const r = scanRunnerLabels({ files: [{ file: 'x.yml', text }], allowed: ALLOWED, retired: RETIRED });
    assert.deepStrictEqual(r.findings, [`x.yml: runner label ${label} is not in scripts/runner-labels.cjs ALLOWED (add it there first)`]);
  });
}

test('the real tree: every label read is one the repo is known to use', () => {
  const used = new Set(sources().flatMap((f) => labelsIn(f.text)));
  for (const l of ['ubuntu-latest', 'macos-26', 'macos-15', 'windows-11-arm', 'ubuntu-22.04']) assert.ok(used.has(l), `${l} not read — a context moved`);
});

test('ALLOWED and RETIRED are disjoint', () => {
  for (const l of ALLOWED) assert.ok(!RETIRED[l], `${l} is both allowed and retired`);
});

const HEADER = '| Image | Architecture | YAML Label | Included Software |\n| --- | --- | --- | --- |\n';

// The weekly watcher's parser. The README row that fooled it on 2026-11-16: `macos-14`
// still LISTED, under a deprecated badge (x64 Azure DevOps extension only).
test('parseRunnerReadme: a deprecated row is reported as deprecated, a live row as offered', () => {
  const md = HEADER + [
    '| macOS 15 Arm64<br>![Endpoint Badge](x) | arm64 | `macos-15`, or `macos-15-xlarge` | [macOS-15-arm64] |',
    '| macOS 14 [![deprecated](https://img.shields.io/badge/deprecated-E5534B)](https://github.com/actions/runner-images/issues/15226)<br>![Endpoint Badge](x) | x64 | `macos-14` | [macOS-14] |',
    '> All macOS 14 images retired from GitHub Actions on November 2, 2026. `macos-13` mentioned in prose.',
  ].join('\n');
  const r = parseRunnerReadme(md);
  assert.deepStrictEqual(r.deprecated, ['macos-14']);
  assert.ok(r.offered.includes('macos-15') && r.offered.includes('macos-15-xlarge'));
  assert.ok(!r.offered.includes('macos-13'), 'prose outside the table is not an offering');
  assert.deepStrictEqual(r.problems, []);
});

test('parseRunnerReadme: the deprecated badge counts in ANY cell of the row', () => {
  const r = parseRunnerReadme(HEADER + '| Ubuntu 22.04 | x64 | `ubuntu-22.04` | [ubuntu-22.04] ![deprecated](b) |\n');
  assert.deepStrictEqual(r.deprecated, ['ubuntu-22.04']);
});

test('parseRunnerReadme: a table with no recognisable header is a finding, not an empty pass', () => {
  const r = parseRunnerReadme('| Name | Arch | Labels | Docs |\n| a | x64 | `ubuntu-24.04` | d |\n');
  assert.strictEqual(r.offered.length, 0);
  assert.match(r.problems[0], /no table with a "YAML Label" column/);
  assert.match(parseRunnerReadme(HEADER).problems[0], /label table is empty/);
});
