#!/usr/bin/env node
'use strict';
// Run ours vs native over one corpus and print classified counts. The phase-3 progress
// meter: run it before a change and after.
//
//   node scripts/text-differential.cjs --native BIN --corpus codepoints|composed|probes|escapes|slices|links|wraps|emoji-test FILE|gbt FILE|bundle CLI [--out DIR]
//
// Bun.wrapAnsi is judged as test/fidelity/text-differential.test.cjs judges it: every corpus at
// BASIC_WRAPS (its text-diff-wrapansi run), and `wraps` (corpusWraps()) at FULL_WRAPS, every
// width 1-80 (its text-diff-wrapansi-cases run). Without it this meter read wrapAnsi as nothing
// at all, a "0" no one measured.
//
// Exit 0 when every compared consumer is identical, 1 when any differs, 2 on harness failure.
const fs = require('node:fs');
const path = require('node:path');
const C = require('./lib/text-corpus.cjs');
const { runNative, runOurs, compareTextResults, KEYS, BASIC_WRAPS, FULL_WRAPS } = require('./lib/text-probe.cjs');

function main(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--native') o.native = argv[++i];
    else if (argv[i] === '--corpus') { o.corpus = argv[++i]; if (['emoji-test', 'gbt', 'bundle'].includes(o.corpus)) o.file = argv[++i]; }
    else if (argv[i] === '--out') o.out = argv[++i];
    else { process.stderr.write(`text-differential: unknown argument ${argv[i]}\n`); return 2; }
  }
  if (!o.native || !o.corpus) { process.stderr.write('usage: text-differential.cjs --native BIN --corpus NAME [FILE] [--out DIR]\n'); return 2; }
  const strings = o.corpus === 'codepoints' ? C.corpusCodePoints()
    : o.corpus === 'composed' ? C.corpusComposed()
      : o.corpus === 'probes' ? C.corpusCellProbes()
      : o.corpus === 'escapes' ? C.corpusEscapes()
      : o.corpus === 'slices' ? C.corpusSliceProbes()
      : o.corpus === 'links' ? C.corpusLinks()
      : o.corpus === 'wraps' ? C.corpusWraps()
      : o.corpus === 'emoji-test' ? C.corpusEmojiTest(fs.readFileSync(o.file, 'utf8'))
        : o.corpus === 'gbt' ? C.corpusGraphemeBreakTest(fs.readFileSync(o.file, 'utf8'))
          : o.corpus === 'bundle' ? C.corpusBundleLiterals(fs.readFileSync(o.file, 'utf8'))
            : null;
  if (!strings) { process.stderr.write(`text-differential: unknown corpus ${o.corpus}\n`); return 2; }
  const wants = o.corpus === 'wraps' ? { wrapAnsi: FULL_WRAPS }
    : { segmenter: true, stringWidth: true, intl: true, sliceAnsi: true, wrapAnsi: BASIC_WRAPS };
  // A thrown error (a missing/refusing native binary, a tjs launch failure, an empty
  // corpus) is a HARNESS failure, distinct from "differences were found" (exit 1) — both
  // runNative and runOurs throw plain Errors, never exit the process themselves.
  let native, ours;
  try {
    native = runNative(o.native, strings, wants);
    ours = runOurs(strings, wants);
  } catch (e) {
    process.stderr.write(`text-differential: ${e && e.message ? e.message : e}\n`);
    return 2;
  }
  const d = compareTextResults(strings, native, ours);
  if (o.out) { fs.mkdirSync(o.out, { recursive: true }); fs.writeFileSync(path.join(o.out, `${o.corpus}.json`), JSON.stringify({ native, ours, d })); }
  // A consumer this run did not compare (not asked for, or native lacks it) is left out, never printed as 0.
  const counted = KEYS.filter((k) => d.counts[k] !== null).map((k) => `${k}=${d.counts[k]}`).join(' ');
  process.stdout.write(`${o.corpus}: examined ${d.examined} (${native.runtime} vs ${ours.runtime}) ${counted}\n`);
  for (const f of d.findings.slice(0, 20)) process.stdout.write(`  ${f}\n`);
  return Object.values(d.counts).some((v) => v) ? 1 : 0;
}

process.exit(main(process.argv.slice(2)));
