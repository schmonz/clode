'use strict';
// PHASE 5B, TASK 1. `lexicalCodeMask` (libexec/scc-merge.cjs) is the merger's own
// lexer: it decides which bytes of a module's source are a real, renameable binding
// vs. a string/template/regex/comment body that must be left alone. It had no seam a
// test could reach without corrupting the real merger — this file is that seam,
// through the additive export `lexicalCodeMask` (mirroring phase 5 task 11's export
// of `scannableTexts`, for the same reason: testable without changing what it does).
//
// The literal relative require below is load-bearing for Task 5's population sweep,
// which derives "which guard controls this production gate" by reading this exact
// string out of the guard's own source — see test/guards-population.cjs's
// isMigratedSource()/DESTRUCTURES_DEFINEGUARD for the same trick applied one layer up.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { lexicalCodeMask } = require('../../libexec/scc-merge.cjs');
const { defineGuard, guardTests } = require('../guard.cjs');
const { pinnedVersion } = require('../provider-resolve.cjs');

// ---- Step 2/3: the failing repro, transcribed verbatim from the task brief -----------
//
// The shape phase 5 proved fatal in the path-ratchet tokenizer, here in the MERGER.
// A regex literal misjudged as division, whose body contains `/` immediately followed
// by `*`, opens a phantom block comment that runs to the next real `*/` or EOF. In the
// merger the consequence is worse than a blind test: a region masked as non-code changes
// the RENAMING decisions and can emit a corrupt merged bundle.
// VERDICT (recorded 2026-09-12, `/opt/pkg/bin/node --test test/build-gates/lexical-code-mask.test.cjs`
// run BEFORE this test was wrapped in `todo`): FAILS. `mask[idx]` is 0, not 1 — the
// defect is LIVE in the real merger, not merely theoretical. Traced: the SECOND `/` of
// the char class `[/*]` opens the phantom comment, reached because the FIRST `/` —
// preceded by `)` from `fn()` — fails `regexAllowed()` and is read as division, so the
// regex-body scan that would otherwise have consumed `[/*]` whole is never attempted.
//
// Marked `todo`, not fixed, and not left plain-red: phase 5b's coordinating decision
// (recorded before this task started) is that the ENTIRE phase's sanctioned production
// diff is the single additive export above — no other change to libexec/scc-merge.cjs,
// including this one's fix, is authorized in this phase. See BACKLOG.md for the filed
// entry naming the site and the fix (the same EOF-backoff test/windows-path-ratchet's
// stripComments() applies at its own `/*` branch). The corpus measurement below (the
// `lexical-code-mask-phantom-comment` guard) is what actually stands watch in the
// meantime: zero of the 1,839 real pinned module sources trigger this shape today
// (task-1-report.md), so shipping stays safe without the fix; this todo exists so the
// live defect is not forgotten, not to declare it acceptable indefinitely.
test('a regex body containing /* does not open a phantom comment',
  { todo: 'lexicalCodeMask phantom-comment defect is LIVE but unfixed this phase — see '
    + 'BACKLOG.md ("lexicalCodeMask phantom-comment defect") and the guard below' }, () => {
  const src = 'fn() /[/*]/.test(x);\nvar realName = 1;\n';
  const mask = lexicalCodeMask(src);
  const idx = src.indexOf('realName');
  assert.strictEqual(mask[idx], 1,
    'the identifier after a misjudged regex must still be masked as CODE — if it is 0, '
    + 'the merger will not see it, and a colliding name there is renamed with no error');
});

// ---- Step 6: the guard, with a control built on the SAME repro -----------------------
//
// scanRegexBody: the same bracket/escape-aware "candidate regex body" primitive as
// test/windows-path-ratchet.test.cjs's scanRegexBody — a separate copy, not an import,
// for the same reason that file gives for not importing lexicalCodeMask: importing a
// sibling *.test.cjs would re-run its entire test file (including its own guardTests())
// as a side effect of merely requiring it, which test/guards-population.cjs's own
// "STATIC, NOT EXECUTED" fix-round note already flags as a cost this repo avoids.
// PURE: from just after an opening `/` at `start`, scans for the next unescaped `/`
// outside a `[...]` char class, stopping at a literal newline (a regex literal can
// never contain one) exactly the way a real JS lexer would.
function scanRegexBody(src, start) {
  const n = src.length;
  let j = start, inClass = false, closed = false;
  while (j < n) {
    const cj = src.charCodeAt(j);
    if (cj === 92) { j += 2; continue; } // backslash
    if (cj === 10) break; // newline
    if (cj === 91) { inClass = true; j++; continue; } // [
    if (cj === 93) { inClass = false; j++; continue; } // ]
    if (cj === 47 && !inClass) { closed = true; j++; break; } // /
    j++;
  }
  return { end: j, closed };
}

// PURE. The general, MASK-GROUNDED phantom-comment-site detector — general in the sense
// that it needs no foreknowledge of "realName"; it works on any source. For every `/`
// that lexicalCodeMask's own (real, unfixed) output shows was read as ORDINARY CODE
// (mask[i] === 1 — i.e. NOT consumed as a string-open, template-open, comment-open, or
// a successfully-recognized regex-open, all of which leave that byte 0), this checks
// whether the candidate regex body starting right after it — scanned the exact way a
// real regex literal would be, via scanRegexBody above — contains a raw `/*`. That is
// precisely the shape that makes lexicalCodeMask's own unconditional `c===47 &&
// next===42` branch (checked BEFORE the regex branch in dispatch order) fire on an
// interior byte it should never have reached as a comment opener.
//
// Checking `mask[i] === 1` at the CANDIDATE's own opening `/` — not at the inner `/*`
// itself — is deliberate and was verified against the repro above: the inner `/*`'s own
// mask byte is 0 (the phantom-comment branch never sets mask for the bytes it consumes),
// so filtering on THAT position would silently exclude the very case this exists to
// catch. The outer `/` (here, `fn()`'s trailing `/`) is where the misjudgment happens —
// its mask is 1 because `regexAllowed(')')` is false, so it falls through to ordinary
// punctuation — and that is the byte this detector keys off.
//
// A residual, same shape as windows-path-ratchet's own admitted one: scanRegexBody is a
// candidate scan, not a proof — a genuine division followed later on the same line by
// an unrelated string containing `/` can make it report a `closed` body that isn't
// really one. Measured across the real corpus (task-1-report.md): zero occurrences, so
// no ALLOWED-list has been needed yet; if one ever is, follow ambiguityGuard's shape.
function findPhantomCommentSites(src, mask) {
  const n = src.length;
  const findings = [];
  for (let i = 0; i < n - 1; i++) {
    if (src.charCodeAt(i) !== 47) continue; // '/'
    if (src.charCodeAt(i + 1) === 47) continue; // '//' line comment: not ambiguous
    if (mask[i] !== 1) continue; // already consumed elsewhere — see note above
    const { end, closed } = scanRegexBody(src, i + 1);
    if (!closed) continue;
    const body = src.slice(i + 1, end - 1);
    if (body.includes('/*')) {
      findings.push({ offset: i, snippet: src.slice(i, Math.min(end, i + 60)) });
    }
  }
  return findings;
}

// PURE. The shape defineGuard's `scan` requires: {findings, examined}.
function scanSources({ sources }) {
  const findings = [];
  let examined = 0;
  for (const { rel, src } of sources) {
    if (typeof src !== 'string' || src.length === 0) continue;
    examined++;
    const mask = lexicalCodeMask(src);
    for (const site of findPhantomCommentSites(src, mask)) {
      findings.push(`${rel}: offset ${site.offset}: a "/" lexicalCodeMask read as ordinary `
        + `code has a candidate regex body containing a raw "/*" — ${JSON.stringify(site.snippet)}. `
        + `This is the shape proven fatal above: the merger can mask real code as non-code and `
        + `rename a colliding name there with no error, emitting a corrupt bundle.`);
    }
  }
  return { findings, examined };
}

// read() — the only I/O in this guard: the real pinned carve's graph.json, never
// ~/.local/share/clode or anything this guard could write to (it never does — read-only).
function pinnedCarveDir() {
  const pin = pinnedVersion();
  return pin ? path.join(os.homedir(), '.cache', 'clode', pin) : null;
}

function readGraphSources() {
  const dir = pinnedCarveDir();
  if (!dir) {
    return { skip: 'UPSTREAM_PIN has no `claude-code <version>` line — cannot locate the '
      + 'pinned carve to scan' };
  }
  const graphPath = path.join(dir, 'graph.json');
  if (!fs.existsSync(graphPath)) {
    return { skip: `pinned carve not found at ${graphPath} — the local ~/.cache/clode store `
      + 'has not been populated on this box (build once, or run the extractor)' };
  }
  const g = JSON.parse(fs.readFileSync(graphPath, 'utf8'));
  const sources = Object.entries(g.sources || {}).map(([rel, src]) => ({ rel, src }));
  if (sources.length === 0) return { skip: `graph.json at ${graphPath} has no module sources` };
  return { sources };
}

// Measured 2026-09-12 against the pinned claude-code 2.1.251 carve (see task-1-report.md
// for the exact command): all 1,839 of graph.json's module sources are non-empty strings,
// so `examined` is 1,839 on a clean run. The floor is that exact count, per the brief —
// a drop means either the carve regenerated with fewer modules (in which case the pin
// moved and this floor should move with it) or something upstream of read() broke.
const guard = defineGuard({
  name: 'lexical-code-mask-phantom-comment',
  floor: 1839,
  read: readGraphSources,
  scan: scanSources,
  // The coordinator's exact repro: `)` closing `fn()` fails regexAllowed, so the regex
  // scan is skipped for the next `/`, and its candidate body `[/*]` contains a raw `/*`.
  control: () => ({
    sources: [{ rel: 'synthetic/control.cjs', src: 'fn() /[/*]/.test(x);\nvar realName = 1;\n' }],
  }),
});
guardTests(guard);

module.exports = { scanRegexBody, findPhantomCommentSites, scanSources, readGraphSources, guard };
