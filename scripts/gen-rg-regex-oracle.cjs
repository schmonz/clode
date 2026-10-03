#!/usr/bin/env node
'use strict';
// Generate test/fixtures/rg-regex-oracle.json: the PROPERTY test's oracle for libexec/rg-regex.cjs.
//
//   node scripts/gen-rg-regex-oracle.cjs --native BIN            # regenerate
//   node scripts/gen-rg-regex-oracle.cjs --native BIN --check    # exit 1 if native now answers otherwise
//   node scripts/gen-rg-regex-oracle.cjs --native BIN --emit     # print the regenerated fixture, write nothing
// staleness(current, regenerated) is the --check verdict, exported for its guard
// (test/build-gates/rg-regex-gates.test.cjs, rg-regex-oracle-fresh).
//
// Patterns are drawn (seeded, so the fixture is reproducible) from the grammar quaude's rg answers:
// literals (ASCII, Latin-1, CJK, the case-folding specials), `.`, Perl classes, POSIX classes,
// brackets (negated, ranged, non-ASCII), every assertion, alternation, every repetition (greedy,
// lazy, counted, nested, over empty-matching subs), groups, and the i/U flags (inline, scoped, and
// as -i). The corpus mixes ASCII, Latin-1, combining marks, CJK, emoji, case-folding specials,
// invalid UTF-8 (lone continuation bytes, truncated sequences, a surrogate encoding) and \r.
// For each pattern native's embedded rg (`--json`, the pattern after -e, -i when drawn) answers
// over the corpus; the fixture stores the pattern and a hash of native's matches per line (or rg's
// rejection), so it stays small. test/rg-regex.test.cjs recomputes ours against those hashes, and
// with this --check proves the fixture still is native's.
// Exit status: 0 written / fresh, 1 --check found it stale, 2 a refusal.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { runNativeRg, nativeRgVersion } = require('./lib/rg-probe.cjs');

const REPO = path.resolve(__dirname, '..');
const TARGET = path.join(REPO, 'test', 'fixtures', 'rg-regex-oracle.json');
const SEED = 20261003, CASES = 300, LINES = 40;

function refuse(msg) { process.stderr.write(`gen-rg-regex-oracle: ${msg}\n`); process.exit(2); }

// The digest test/rg-regex.test.cjs compares: matches per selected line, absolute byte offsets.
function digest(lines) {
  return crypto.createHash('sha256').update(JSON.stringify(lines)).digest('hex').slice(0, 20);
}

function draw() {
  let seed = SEED;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const pick = (a) => a[rnd(a.length)];
  const cp = (...c) => String.fromCodePoint(...c);
  const PIECES = ['a', 'b', 'ab', 'k', 'K', 's', 'S', '_', '1', '9', ' ', '  ', '.', '-', 'x', 'needle', 'foo', 'bar', '\t', '\r',
    cp(0xe9), cp(0x65, 0x301), cp(0x4e2d), cp(0x4e2d, 0x6587), cp(0x1f600), cp(0x212a), cp(0x17f), cp(0xdf), cp(0x3c3), cp(0x3c2),
    cp(0x661), cp(0xa0), cp(0x200d), [0xff], [0x80], [0xe4, 0xb8], [0xc3], [0xed, 0xa0, 0x80], [0xf0, 0x9f]];
  const parts = [];
  for (let i = 0; i < LINES; i++) {
    const k = rnd(7);
    for (let j = 0; j < k; j++) parts.push(Buffer.from(pick(PIECES)));
    parts.push(Buffer.from('\n'));
  }
  const corpus = Buffer.concat(parts);
  const ATOMS = ['a', 'b', 'k', 's', 'x', '_', '1', ' ', '\\.', '-', '.', '\\w', '\\W', '\\d', '\\D', '\\s', '\\S', '[ab]', '[^a]', '[a-z]',
    '[^ ]', '[[:alpha:]]', '[[:^space:]]', '[[:upper:]]', '[_[:digit:]]', '\\b', '\\B', '\\<', '\\>', '\\b{end}', '\\b{start}',
    '\\b{end-half}', '\\b{start-half}', '^', '$', cp(0xe9), cp(0x4e2d), 'K', 'S', '[^\\w ]', '[\\x{e0}-\\x{ff}]', '[\\x{4e00}-\\x{9fff}]+',
    '[^[:ascii:]]', '[k-s]', '[^k-s]', '[[:^alpha:]x]', '\\x{1f600}', '[^\\d\\s]', '\\S+', 'a{0,3}', '(?:ab){2,}', '.{2}', '.*', '.+?',
    '[^a]*', '\\w*', '(?:a|ab|abc)', '(?:abc|ab|a)', '(?:x*)*', '(?:\\b|a)+', '(?:a?)+?', cp(0x3c3), cp(0xdf), '\\x{212a}', '\\u017f',
    'e', '\\t', '\\r', 'needle', '(?:)', ''];
  const pat = (d) => {
    const r = rnd(10);
    if (d > 3 || r < 4) return pick(ATOMS);
    if (r < 6) return pat(d + 1) + pat(d + 1);
    if (r < 7) return `(?:${pat(d + 1)}|${pat(d + 1)})`;
    if (r < 8) return `(${pat(d + 1)})${pick(['*', '+', '?', '*?', '+?', '??', '{1,2}', '{2}', '{0,2}?', '{1,}'])}`;
    if (r < 9) return `(?${pick(['i', '-i', 'U', 'i-U'])}:${pat(d + 1)})`;
    return `${pick(['(?i)', '(?U)', ''])}${pat(d + 1)}`;
  };
  const cases = [];
  for (let i = 0; i < CASES; i++) cases.push({ pattern: pat(0), ignoreCase: rnd(5) === 0 });
  return { corpus, cases };
}

function nativeAnswers(bin, corpus, cases) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-rg-regex-oracle-'));
  try {
    fs.writeFileSync(path.join(dir, 'corpus.txt'), corpus);
    const env = { HOME: dir, PATH: '/usr/bin:/bin' };
    return cases.map(({ pattern, ignoreCase }) => {
      const r = runNativeRg(bin, ['--json', ...(ignoreCase ? ['-i'] : []), '-e', pattern, '--', 'corpus.txt'], dir, { env });
      if (r.status === 2) return { rejected: true };
      if (r.status !== 0 && r.status !== 1) refuse(`native rg exited ${r.status} on ${JSON.stringify(pattern)}`);
      const lines = [];
      for (const l of r.stdout.toString('utf8').split('\n')) {
        if (!l) continue;
        const j = JSON.parse(l);
        if (j.type !== 'match') continue;
        const o = j.data.absolute_offset;
        lines.push([o, j.data.submatches.map((s) => [o + s.start, o + s.end])]);
      }
      return { lines };
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// The --check verdict: which of the fixture's cases (or fields) native now answers otherwise,
// by name ([] when none).
function staleness(current, regenerated) {
  if (current === regenerated) return [];
  let a, b;
  try { a = JSON.parse(current); b = JSON.parse(regenerated); } catch { return ['test/fixtures/rg-regex-oracle.json does not parse']; }
  const out = [];
  for (const k of ['rg', 'seed', 'corpus']) if (a[k] !== b[k]) out.push(`its ${k} differs`);
  const n = Math.max((a.cases || []).length, (b.cases || []).length);
  const moved = [];
  for (let i = 0; i < n; i++) if (JSON.stringify((a.cases || [])[i]) !== JSON.stringify((b.cases || [])[i])) moved.push(i);
  if (moved.length) out.push(`native answers ${moved.length} case(s) otherwise: ${moved.slice(0, 10).map((i) => JSON.stringify(((b.cases || [])[i] || (a.cases || [])[i])[0])).join(', ')}`);
  return [`test/fixtures/rg-regex-oracle.json differs from native's rg: ${out.length ? out.join('; ') : 'in layout only'}`];
}

function main() {
  const argv = process.argv.slice(2);
  let bin = null, check = false, emit = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--native') bin = argv[++i];
    else if (argv[i] === '--check') check = true;
    else if (argv[i] === '--emit') emit = true;
  }
  if (!bin) refuse('usage: gen-rg-regex-oracle.cjs --native BIN [--check | --emit]');
  const rg = nativeRgVersion(bin);
  if (!rg) refuse(`${bin} did not answer as rg (argv0 rg, --version)`);
  const { corpus, cases } = draw();
  const answers = nativeAnswers(bin, corpus, cases);
  const out = {
    about: 'test/rg-regex.test.cjs\'s property oracle: native rg\'s matches over `corpus` per pattern, as digests (scripts/gen-rg-regex-oracle.cjs)',
    rg: rg.split('\n')[0], seed: SEED, corpus: corpus.toString('base64'),
    cases: cases.map((c, i) => [c.pattern, c.ignoreCase ? 1 : 0, answers[i].rejected ? 'rejected' : digest(answers[i].lines)]),
  };
  const text = `${JSON.stringify(out, null, 0).replace(/\],\[/g, '],\n[')}\n`;
  if (emit) { process.stdout.write(text); return; }
  if (check) {
    const cur = fs.existsSync(TARGET) ? fs.readFileSync(TARGET, 'utf8') : '';
    const stale = staleness(cur, text);
    if (stale.length) { process.stdout.write(`gen-rg-regex-oracle: STALE: ${stale.join('; ')}\n`); process.exit(1); }
    process.stdout.write(`gen-rg-regex-oracle: fresh (${cases.length} cases, ${rg.split('\n')[0]})\n`);
    return;
  }
  fs.writeFileSync(TARGET, text);
  process.stdout.write(`gen-rg-regex-oracle: wrote ${cases.length} cases (${answers.filter((a) => a.rejected).length} rejected by rg)\n`);
}

if (require.main === module) main();
module.exports = { digest, staleness };
