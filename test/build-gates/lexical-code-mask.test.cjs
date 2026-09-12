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
// VERDICT (recorded 2026-09-12, `/opt/pkg/bin/node --test test/build-gates/lexical-code-mask.test.cjs`,
// BEFORE the fix below): FAILED. `mask[idx]` was 0, not 1 — the defect was LIVE in the
// real merger, not merely theoretical. Traced: the SECOND `/` of the char class `[/*]`
// opened the phantom comment, reached because the FIRST `/` — preceded by `)` from
// `fn()` — fails `regexAllowed()` and is read as division, so the regex-body scan that
// would otherwise have consumed `[/*]` whole is never attempted.
//
// FIXED (phase 5b, task 1, fix round 1): `lexicalCodeMask`'s `/*` branch now backs off
// to ordinary punctuation when no real closing `*/` exists before EOF, the same
// EOF-backoff `test/windows-path-ratchet.test.cjs`'s `stripComments()` applies at its own
// `/*` branch (including that fix's documented residual — a REAL, unrelated `*/` later
// in the same source can still pair with this one instead of reaching EOF). This is now
// a REGRESSION TEST, not a todo: it goes red again if the EOF-backoff is ever removed or
// narrowed. See BACKLOG.md for the corpus-invariance proof (masks over all 1,839 pinned
// module sources are byte-identical before/after) and the merger-test re-run.
test('a regex body containing /* does not open a phantom comment', () => {
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

// PURE. The general, MASK-GROUNDED phantom-comment-RISK detector — general in the sense
// that it needs no foreknowledge of "realName"; it works on any source, and on either the
// fixed or unfixed lexicalCodeMask (both are proven byte-identical over the real corpus —
// see BACKLOG.md). For every `/` that lexicalCodeMask's own output shows was read as
// ORDINARY CODE (mask[i] === 1 — i.e. NOT consumed as a string-open, template-open,
// comment-open, or a successfully-recognized regex-open, all of which leave that byte 0),
// this checks whether the text between it and the next real closing `/`, newline, or EOF
// — scanned via scanRegexBody above — contains a raw `/*`. That is precisely the shape
// that makes lexicalCodeMask's own unconditional `c===47 && next===42` branch (checked
// BEFORE the regex branch in dispatch order) fire on an interior byte it should never
// have reached as a comment opener. Post-fix, a flagged site is not necessarily still a
// LIVE defect (the EOF case backs off correctly) — it names the residual risk the fix
// does not close (a later, unrelated real `*/` in the same source), same as
// windows-path-ratchet's own ambiguity guard.
//
// Checking `mask[i] === 1` at the CANDIDATE's own opening `/` — not at the inner `/*`
// itself — is deliberate and was verified against the repro above: the inner `/*`'s own
// mask byte is 0 (the phantom-comment branch never sets mask for the bytes it consumes),
// so filtering on THAT position would silently exclude the very case this exists to
// catch. The outer `/` (here, `fn()`'s trailing `/`) is where the misjudgment happens —
// its mask is 1 because `regexAllowed(')')` is false, so it falls through to ordinary
// punctuation — and that is the byte this detector keys off.
//
// FALSE-POSITIVE residual, same shape as windows-path-ratchet's own admitted one:
// scanRegexBody is a candidate scan, not a proof — a genuine division followed later on
// the same line by an unrelated string containing `/` can make `closed` true over text
// that isn't really a regex body. Measured across the real corpus (task-1-report.md,
// fix-round-1 addendum): zero occurrences, so no ALLOWED-list has been needed yet; if one
// ever is, follow ambiguityGuard's shape.
//
// FALSE-NEGATIVE check (reviewer, fix round 1): does requiring `closed` — a real
// subsequent unescaped `/` before the next newline — miss real risk sites? It would: the
// underlying mechanism (lexicalCodeMask's `/*` branch fires unconditionally on ANY raw
// `/*` the main dispatch loop reaches undiverted) needs no subsequent `/` at all — it is
// not actually "is this a well-formed regex literal", only "does the misjudged slash's
// line contain a raw /* ". `closed` was inherited from mirroring the ORIGINAL repro's
// shape (`fn() /[/*]/.test(x)`, which happens to have a real closing `/`) rather than
// derived from the mechanism. FIXED here to match test/windows-path-ratchet.test.cjs's
// own `onAmbiguousSlash` hook, which never gates on `closed` for exactly this reason: use
// whatever `scanRegexBody` reaches (a real closing `/`, or the newline/EOF) either way.
function findPhantomCommentSites(src, mask) {
  const n = src.length;
  const findings = [];
  for (let i = 0; i < n - 1; i++) {
    if (src.charCodeAt(i) !== 47) continue; // '/'
    if (src.charCodeAt(i + 1) === 47) continue; // '//' line comment: not ambiguous
    if (mask[i] !== 1) continue; // already consumed elsewhere — see note above
    const { end, closed } = scanRegexBody(src, i + 1);
    const body = closed ? src.slice(i + 1, end - 1) : src.slice(i + 1, end);
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
        + `code is followed by a raw "/*" before the next real closing "/", newline, or EOF `
        + `— ${JSON.stringify(site.snippet)}. This is the residual the EOF-backoff fix does `
        + `NOT close: if a real, unrelated "*/" exists later in this source, the phantom `
        + `comment can still pair with it instead of backing off, masking real code as `
        + `non-code and letting a colliding name there be renamed with no error.`);
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
