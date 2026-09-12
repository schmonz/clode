// WHAT A GREEN DRIFT RUN DOES NOT PROVE.
//
// The daily check asks two questions of the newest bundle: are clode's hook anchors
// still where we think, and can clode still REACH the CLI. Both were chosen well —
// the second exists because 2.1.243 reported "OK — all 5 anchors present" while
// `clode build` was dead at extraction (see upstream-drift-check.mjs's own note).
//
// Neither reaches the step that is broken TODAY. `clode build` on 2.1.257+ dies in
// the SCC merge, with QuickJS rejecting the merged file ("invalid property name"),
// and the merge needs an engine to run at all — so nothing in a plain drift run
// exercises it. UPSTREAM_PIN is held behind upstream for exactly that reason.
//
// Left unsaid, the green reads as "newest Claude Code is fine". That is how a
// capability gap becomes something we remember rather than something CI states, and
// memory is what fails. So every green carries this note, and test/carve-gap-note.test.cjs
// keeps it from being quietly dropped.
export function carveGapNote({ pin, checked } = {}) {
  const versions = pin && checked
    ? `UPSTREAM_PIN is ${pin}; this run inspected ${checked}`
    : pin
      ? `UPSTREAM_PIN is ${pin}`
      : 'UPSTREAM_PIN could not be read';
  return [
    '  what this green does NOT prove: that clode can BUILD from this bundle.',
    '  Anchors and CLI extraction are checked above; the SCC MERGE is not — it needs',
    '  an engine, and it is where 2.1.257 broke (QuickJS: "invalid property name").',
    `  ${versions}, deliberately behind for that reason — see UPSTREAM_PIN and BACKLOG.md.`,
  ].join('\n') + '\n';
}
