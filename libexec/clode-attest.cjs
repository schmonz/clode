'use strict';
// The attest surface BOTH build targets share.
//
// clode builds two products — quaude (a tjs engine plus an archive of hashed members) and
// naude (a Node SEA plus hashed assets). They are assembled by completely different
// machinery, but the question a user asks them is the same one: "is this artifact still
// exactly what clode built, and what is inside it?" Until now only quaude could answer,
// under a flag named after the product rather than the guarantee; naude answered nothing
// at all. One question deserves one name and one answer format, so:
//
//   * `--clode-attest` is the flag on BOTH products, named for the BUILDER (the thing that
//     made the guarantee), not for either product.
//   * ATTEST_VERIFIED is the ONE line a build gate greps. libexec/clode-fuse.cjs imports
//     this constant rather than spelling it again — a gate whose string can drift from the
//     product that prints it is a gate that silently stops gating, and this repo has paid
//     for that failure mode more than once.
//   * attestReport formats the whole report, so the two products cannot disagree about
//     column widths, ordering, or what the verdict means.
//
// WHAT DIFFERS, ON PURPOSE. Each product supplies its own `members` (quaude walks its
// archive index; naude hashes its SEA assets) and its own `notes` — the honest statement
// of what it did NOT check. `notes` can never make a failing report look clean; only
// members and bom entries decide the verdict.
//
// THIS IS THE CANONICAL COPY. esbuild inlines it into naude-entry.bundle.cjs and
// clode-main.bundle.cjs. libexec/quaude-bootstrap.mjs (compiled RAW to tjs bytecode, no
// runtime imports) carries a BYTE-IDENTICAL inline copy of the marked block below;
// test/update-guard-drift.test.cjs enforces that. Change the logic here and there, or the
// drift test fails.
// >>> clodeAttest (canonical; drift-tested against libexec/quaude-bootstrap.mjs) >>>
// The reserved argv namespace. A built target owns every `--clode-*` flag; an unknown one
// is an ERROR (it must never reach Claude Code, which would report it as its own). Every
// other argument belongs to the bundle, verbatim and in order.
const CLODE_FLAGS = ['--clode-attest'];
function carveClodeArgs(args, known = CLODE_FLAGS) {
  const clode = [], rest = [], unknown = [];
  for (const a of args) {
    if (typeof a === 'string' && a.startsWith('--clode-')) {
      (known.includes(a) ? clode : unknown).push(a);
    } else rest.push(a);
  }
  return { clode, rest, unknown };
}

// manifest.bom entries are "name@version"; a scoped package (@scope/name@version) has a
// leading '@' that is NOT the version separator, so split on the LAST '@'.
function depNameFromSpec(spec) {
  const i = spec.lastIndexOf('@');
  return i > 0 ? spec.slice(0, i) : spec;
}

// The verdict. ONE string per outcome, naming neither product — `clode build` greps the
// success line for whichever target it just produced.
const ATTEST_VERIFIED = 'clode-attest: all members verified';
const ATTEST_FAILED = 'clode-attest: VERIFICATION FAILED';

// members: [{ name, len, ok }]  — one per hashed unit the product actually re-hashed.
// bom:     [{ spec, marker, present }] — SET verification: a whole declared package can be
//          silently ABSENT without any present member failing, which per-member hashing
//          alone would never notice.
// notes:   plain strings, printed as `note: ...` — what this product did NOT verify.
function attestReport({ manifestText, members, bom, notes }) {
  const lines = String(manifestText).replace(/\n+$/, '').split('\n');
  let ok = true;
  for (const m of members) {
    if (!m.ok) ok = false;
    lines.push(`${m.ok ? 'ok  ' : 'FAIL'} ${m.name} (${m.len} bytes)`);
  }
  for (const b of bom || []) {
    if (!b.present) ok = false;
    lines.push(`${b.present ? 'ok  ' : 'FAIL'} bom: ${b.spec} -> ${b.marker}`);
  }
  for (const n of notes || []) lines.push(`note: ${n}`);
  lines.push(ok ? ATTEST_VERIFIED : ATTEST_FAILED);
  return { ok, lines, text: lines.join('\n') + '\n' };
}
// <<< clodeAttest <<<

module.exports = { CLODE_FLAGS, carveClodeArgs, depNameFromSpec, attestReport, ATTEST_VERIFIED, ATTEST_FAILED };
