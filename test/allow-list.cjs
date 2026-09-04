'use strict';
// allow-list — turns an allow-list ENTRY (a record naming what it exempts, why it is
// exempt, and how to PROVE the exemption is real) into the plain string patterns
// tree.walk/hermetic-guard.snapshot already consume via their `ignore` arrays. Both of
// those keep their existing string interface unchanged — this module is the ONLY place
// that understands the record shape.
//
// This exists because of a real defect (phase 5, Task 5's brief): run.mjs's GUARD_WATCH
// gained an ignore for REAL_STORE/build-trace.jsonl in phase 2's Task 3 — BEFORE the
// writer it exempts existed. From the moment that writer landed, every leak into that
// file was pre-authorised, because a plain string list can only ever be REPORTED on,
// never independently checked. A record can be checked: does it say why it exists
// (`because`), and can it prove the thing it exempts is actually real right now
// (`provenBy`)? An entry that fails either check is a FINDING — and, critically, is
// DROPPED from `patterns`, not merely listed alongside a pattern that still applies.
// Reporting-but-still-applying is exactly the silent-guard shape this module exists to
// make impossible: an exemption nobody can see failing is an exemption that always
// wins.
//
// Pure node stdlib; no fs of its own — `fsm` is threaded through to each entry's
// `provenBy(fsm)` so a caller can inject a fake for its own tests without this module
// needing to know what any given proof actually inspects.
const realFs = require('node:fs');

function resolveAllowList(entries, { fsm = realFs } = {}) {
  const patterns = [];
  const findings = [];
  for (const entry of entries) {
    if (typeof entry === 'string') {
      throw new TypeError(
        `allow-list entries must be records ({ pattern, because, provenBy }), not a plain `
        + `string — a bare string can be reported on but never proven, which is the exact `
        + `defect this module exists to close. Got: ${JSON.stringify(entry)}`,
      );
    }
    const { pattern, because, provenBy } = entry || {};
    if (!because || typeof because !== 'string' || !because.trim()) {
      findings.push(`${pattern}: no \`because\` — every allow-list entry must say why it exists`);
      continue;
    }
    if (typeof provenBy !== 'function') {
      findings.push(`${pattern}: no \`provenBy\` — every allow-list entry must PROVE its `
        + `exemption is real right now, not just assert it`);
      continue;
    }
    let proven;
    try {
      proven = provenBy(fsm);
    } catch (e) {
      findings.push(`${pattern}: provenBy threw — ${e && e.message}`);
      continue;
    }
    if (!proven) {
      findings.push(`${pattern}: exemption not reachable — the thing it exempts does not exist `
        + `(provenBy returned false)`);
      continue;
    }
    patterns.push(pattern);
  }
  return { patterns, findings };
}

// sourceContainsWrite — a small, reusable, DELIBERATELY LIMITED heuristic a `provenBy`
// can build on when its claim is "this repo's own source contains no write targeting a
// specific path shape" (e.g. run.mjs's `claude` GUARD_WATCH entry: "clode never writes
// ~/.local/bin/claude"). It greps SOURCE TEXT — no AST, no dataflow — for a file that
// contains BOTH a known write-syscall name (from `writeFns`) AND every literal in
// `pathLiterals` as an EXACT, BYTE-FOR-BYTE substring — quote characters included, e.g.
// callers pass `"'.local'"` (single quotes AS PART OF the literal), so the check is
// text.includes("'.local'"), not text.includes(".local"). That means it WILL miss: the
// identical path spelled with double quotes (`".local"`) or built from a template
// literal (`` `${home}/.local` ``) — proven by execution, not merely asserted: neither
// form matches a `pathLiterals` entry written in single quotes — a leaf/segment built
// from a variable or constant instead of an inline string literal, a write reached only
// via a spawned external command (`cp`, `ln -s`) rather than an `fs.*` call, a literal
// split across a template expression, or a match whose write call and path literals
// live in different files. It exists to make an exemption FALSIFIABLE for the obvious,
// naive case — add a writer that spells the path out in a `fs.*` call USING THE SAME
// QUOTE STYLE the `pathLiterals` were written in, and this flips — not to prove the
// absence of every possible writer. A caller using this MUST say so in its own
// `because`/comment, not rely on this module's confidence.
function sourceContainsWrite(files, { writeFns, pathLiterals, fsm = realFs }) {
  const writeRe = new RegExp(`\\b(${writeFns.join('|')})\\s*\\(`);
  for (const file of files) {
    let text;
    try { text = fsm.readFileSync(file, 'utf8'); } catch { continue; }
    if (!writeRe.test(text)) continue;
    if (pathLiterals.every((lit) => text.includes(lit))) return { found: true, file };
  }
  return { found: false };
}

module.exports = { resolveAllowList, sourceContainsWrite };
