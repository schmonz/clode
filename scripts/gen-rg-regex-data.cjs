#!/usr/bin/env node
'use strict';
// Generate the GENERATED region of libexec/rg-regex.cjs: the character data of rg's regex
// dialect, READ FROM NATIVE'S EMBEDDED rg, never hand-written (memory shim-constants-are-a-class).
//
//   node scripts/gen-rg-regex-data.cjs --native BIN            # regenerate
//   node scripts/gen-rg-regex-data.cjs --native BIN --check    # exit 1 if regeneration would change the file
//   node scripts/gen-rg-regex-data.cjs --native BIN --emit     # print the regenerated file, write nothing
// staleness(current, regenerated) is the --check verdict, exported for its guard
// (test/build-gates/rg-regex-gates.test.cjs, rg-regex-data-fresh).
//
// BIN is a native Claude Code (the pinned provider); its embedded rg is reached as upstream
// reaches it (argv0 `rg`, scripts/lib/rg-probe.cjs runNativeRg). What is measured, per Unicode
// scalar value (every one but U+000A, which no rg line holds, and the surrogates, which no UTF-8
// text holds), one per line of a scratch file, searched with `-a -n`:
//   word digit space       `^\w$` `^\d$` `^\s$` (Rust regex's Unicode Perl classes)
//   posix.<name>           `^[[:name:]]$` for rg's fourteen POSIX classes
//   fold                   for every scalar with a case mapping (by this host's own tables,
//                          which are a newer Unicode than any rg's), `(?i)\x{H}` over those
//                          scalars: the scalars it matches are its simple-case-folding class.
//                          Every class must be symmetric (each member matches exactly the
//                          class), and `(?i)` over ALL the candidates may reach no scalar
//                          outside them, or the generator refuses.
// Exit status: 0 written / fresh, 1 --check found the region stale, 2 a refusal.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { nativeRgVersion } = require('./lib/rg-probe.cjs');

const REPO = path.resolve(__dirname, '..');
const TARGET = path.join(REPO, 'libexec', 'rg-regex.cjs');
const BEGIN = '// BEGIN GENERATED rg-regex-data';
const END = '// END GENERATED rg-regex-data';
const POSIX = ['alnum', 'alpha', 'ascii', 'blank', 'cntrl', 'digit', 'graph', 'lower', 'print', 'punct', 'space', 'upper', 'word', 'xdigit'];

function refuse(msg) { process.stderr.write(`gen-rg-regex-data: ${msg}\n`); process.exit(2); }

// native's rg over FILE with PATTERN: the line numbers (1-based) it matched.
function rgLines(bin, cwd, pattern, file) {
  return new Promise((resolve, reject) => {
    const c = spawn(bin, ['--no-config', '-a', '-n', '--no-filename', '-e', pattern, '--', file],
      { cwd, argv0: 'rg', env: { HOME: cwd, PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [], err = [];
    c.stdout.on('data', (d) => out.push(d));
    c.stderr.on('data', (d) => err.push(d));
    c.on('error', reject);
    c.on('close', (status) => {
      if (status !== 0 && status !== 1) { reject(new Error(`native rg ${JSON.stringify(pattern)} exit ${status}: ${Buffer.concat(err)}`)); return; }
      const buf = Buffer.concat(out);
      const lines = [];
      // each record is DIGITS ':' content '\n'; the content is one scalar (never a newline)
      let i = 0;
      while (i < buf.length) {
        let n = 0, j = i;
        while (buf[j] >= 0x30 && buf[j] <= 0x39) { n = n * 10 + (buf[j] - 0x30); j++; }
        if (j === i || buf[j] !== 0x3a) { reject(new Error(`native rg ${JSON.stringify(pattern)}: unreadable -n output at byte ${i}`)); return; }
        lines.push(n);
        const nl = buf.indexOf(0x0a, j);
        i = nl === -1 ? buf.length : nl + 1;
      }
      resolve(lines);
    });
  });
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) { const k = next++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// Sorted scalars -> [lo, hi, lo, hi, ...].
function toRanges(cps) {
  const r = [];
  for (const c of cps) {
    if (r.length && r[r.length - 1] === c - 1) r[r.length - 1] = c;
    else r.push(c, c);
  }
  return r;
}
// Each number as the base-36 delta from the one before it.
const encodeRanges = (r) => r.map((v, i) => (v - (i ? r[i - 1] : 0)).toString(36)).join(',');
// Classes: sorted by first member; the first as a delta from the previous class's first, the
// rest as deltas from their class's first.
function encodeFold(classes) {
  let prev = 0;
  return classes.map((c) => { const s = [(c[0] - prev).toString(36), ...c.slice(1).map((x) => (x - c[0]).toString(36))].join('.'); prev = c[0]; return s; }).join(',');
}

async function generate(bin) {
  const rg = nativeRgVersion(bin);
  if (!rg) refuse(`${bin} did not answer as rg (argv0 rg, --version)`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen-rg-regex-'));
  try {
    // every scalar but U+000A, one per line; line n holds ALL[n - 1]
    const ALL = [];
    for (let c = 0; c < 0x110000; c++) if (c !== 0x0a && (c < 0xd800 || c > 0xdfff)) ALL.push(c);
    fs.writeFileSync(path.join(dir, 'all.txt'), ALL.map((c) => String.fromCodePoint(c)).join('\n') + '\n');
    const classOf = async (pat) => toRanges((await rgLines(bin, dir, pat, 'all.txt')).map((n) => ALL[n - 1]));
    const word = await classOf('^\\w$'), digit = await classOf('^\\d$'), space = await classOf('^\\s$');
    const posix = {};
    for (const name of POSIX) posix[name] = await classOf(`^[[:${name}:]]$`);

    // case-fold candidates: every scalar this host maps to another case, and what it maps to
    const cand = new Set();
    for (const c of ALL) {
      const s = String.fromCodePoint(c);
      for (const t of [s.toLowerCase(), s.toUpperCase()]) {
        if (t !== s) {
          cand.add(c);
          if ([...t].length === 1) cand.add(t.codePointAt(0));
        }
      }
    }
    const CAND = [...cand].sort((a, b) => a - b);
    fs.writeFileSync(path.join(dir, 'cand.txt'), CAND.map((c) => String.fromCodePoint(c)).join('\n') + '\n');
    const hex = (c) => c.toString(16).toUpperCase();
    const sets = await pool(CAND, 16, async (c) => (await rgLines(bin, dir, `(?i)\\x{${hex(c)}}`, 'cand.txt')).map((n) => CAND[n - 1]));
    const setOf = new Map(CAND.map((c, i) => [c, sets[i]]));
    const classes = [];
    const seen = new Set();
    for (const c of CAND) {
      const s = setOf.get(c);
      if (!s.includes(c)) refuse(`(?i)\\x{${hex(c)}} does not match U+${hex(c)} itself`);
      for (const m of s) {
        if (setOf.get(m).join() !== s.join()) refuse(`case folding is not symmetric: U+${hex(c)} -> ${s.map(hex)}, U+${hex(m)} -> ${setOf.get(m).map(hex)}`);
      }
      if (s.length > 1 && !seen.has(s[0])) { classes.push(s); seen.add(s[0]); }
    }
    // closure check: (?i) over every candidate reaches nothing outside them
    const big = `(?i)^[${CAND.map((c) => `\\x{${hex(c)}}`).join('')}]$`;
    const reached = (await rgLines(bin, dir, big, 'all.txt')).map((n) => ALL[n - 1]).filter((c) => !cand.has(c));
    if (reached.length) refuse(`(?i) over the candidates reaches scalars outside them: ${reached.slice(0, 20).map(hex)}`);

    const data = {
      header: { rg: rg.split('\n')[0], generator: 'scripts/gen-rg-regex-data.cjs' },
      word: encodeRanges(word), digit: encodeRanges(digit), space: encodeRanges(space),
      posix: Object.fromEntries(POSIX.map((n) => [n, encodeRanges(posix[n])])),
      fold: encodeFold(classes),
    };
    return { data, counts: { word: word.length / 2, digit: digit.length / 2, space: space.length / 2, fold: classes.length, candidates: CAND.length } };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

function region(data) {
  return `${BEGIN}\n// rg's regex character data, measured from native's embedded rg (${data.header.rg}) by\n`
    + `// scripts/gen-rg-regex-data.cjs. Do not edit; regenerate.\nconst RG_REGEX_DATA = ${JSON.stringify(data)};\n${END}`;
}

// The --check verdict: what in libexec/rg-regex.cjs's generated region differs from native's
// regeneration, by name ([] when nothing does).
function staleness(current, regenerated) {
  if (current === regenerated) return [];
  const dataOf = (src) => { const m = /const RG_REGEX_DATA = (\{.*\});\n/.exec(src); try { return m ? JSON.parse(m[1]) : null; } catch { return null; } };
  const a = dataOf(current), b = dataOf(regenerated);
  if (!a || !b) return ['libexec/rg-regex.cjs: the generated RG_REGEX_DATA region is missing or unreadable'];
  const flat = (d) => ({ rg: d.header && d.header.rg, word: d.word, digit: d.digit, space: d.space, fold: d.fold,
    ...Object.fromEntries(Object.entries(d.posix || {}).map(([k, v]) => [`posix.${k}`, v])) });
  const fa = flat(a), fb = flat(b);
  const moved = [...new Set([...Object.keys(fa), ...Object.keys(fb)])].filter((k) => fa[k] !== fb[k]);
  return [`libexec/rg-regex.cjs's generated region differs from native's rg: ${moved.length ? moved.join(', ') : 'outside the data (header or layout)'}`];
}

async function main() {
  const argv = process.argv.slice(2);
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--native') o.native = argv[++i];
    else if (argv[i] === '--check') o.check = true;
    else if (argv[i] === '--emit') o.emit = true;
  }
  if (!o.native) refuse('usage: gen-rg-regex-data.cjs --native BIN [--check | --emit]');
  const { data, counts } = await generate(o.native);
  const src = fs.readFileSync(TARGET, 'utf8');
  const a = src.indexOf(BEGIN), b = src.indexOf(END);
  if (a === -1 || b === -1 || b < a) refuse(`${TARGET} has no ${BEGIN} ... ${END} region`);
  const next = src.slice(0, a) + region(data) + src.slice(b + END.length);
  if (o.emit) { process.stdout.write(next); return; }
  process.stdout.write(`gen-rg-regex-data: ${data.header.rg}: ${JSON.stringify(counts)}\n`);
  if (o.check) {
    const stale = staleness(src, next);
    if (stale.length) { process.stdout.write(`gen-rg-regex-data: STALE: ${stale.join('; ')}\n`); process.exit(1); }
    process.stdout.write('gen-rg-regex-data: fresh\n');
    return;
  }
  if (next !== src) fs.writeFileSync(TARGET, next);
  process.stdout.write(next !== src ? 'gen-rg-regex-data: written\n' : 'gen-rg-regex-data: unchanged\n');
}

if (require.main === module) main().catch((e) => refuse(e.stack || e.message));
module.exports = { toRanges, encodeRanges, encodeFold, staleness };
