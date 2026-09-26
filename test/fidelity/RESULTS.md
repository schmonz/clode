# Fidelity Results

Dated rows from `RECIPE.md`, driven on the rigs in `PLATFORMS.md`. A tier claim in
`scripts/tjs-legs.mjs` must be able to point at rows here.

Verdicts: `pass` | `fail` | `open` (driven, divergence recorded, not yet fixed).

## What earns a row

A row records ONE dated run of ONE `RECIPE.md` row against ONE run-target, with a
citation a reader can follow. The bar below is deliberately mechanical: this
ledger exists to stop the same evidence being treated two different ways on two
different platforms, so the rule has to be written down and applied to every
run-target at once, not decided per row.

**Earns a row**

1. **A driven run of the recipe row on the run-target's own platform** — whoever
   or whatever drove it. A human on a box, a spike script in a qemu guest, and a
   CI job inside a VM are the same KIND of evidence; what matters is that the
   code executed on that run-target's OS+arch. Cite the source (commit, spike
   write-up, or workflow run id) in the note.
2. **`clode build`'s own build-pipeline smoke — for row G7, and only G7.**
   `smokeTarget()` in `libexec/clode-build.cjs` starts an in-process canned
   Messages mock, runs the freshly fused quaude as `<bin> -p 'say PONG'` with
   `NODE_PATH` stripped, and requires **exit 0** *and* `PONG` in stdout *and* a
   POST that actually landed on `.../messages`. Compare RECIPE G7: "one agentic
   `-p` turn completes end to end and returns a non-empty answer — mock-anthropic
   is acceptable evidence for this floor claim", expected "`-p` turn exits 0 with
   a non-empty response". That is the same action, the same expectation, the
   same explicitly-blessed mock — run against the real shipped artifact rather
   than a loose engine. It is not a weaker cousin of G7; it *is* G7. (The
   POST-landed assertion is strictly stronger than the recipe asks for: a hung or
   silently-offline client cannot pass it.) `--clode-attest` runs beside it and
   proves the fused members verify; that is payload integrity, not a recipe row.

   The qualifier that does all the work: **the fused quaude must EXECUTE on the
   run-target's own platform.** A guest-VM leg fuses and smokes inside a guest of
   the target OS+arch (earns it); a `no-exec` leg cross-builds something the
   builder host cannot run (earns nothing); a `smoke: version` leg only asks the
   binary its version (earns nothing); a `.com` smoked on the Linux runner earns
   the row for `cosmo-linux-x86-64` and for no other cosmo host.

**Does not earn a row**

- A green build, a green cross-build, or a passing arch gate. "It compiled" is
  not "it ran". Every tier-0 publisher has that already.
- A `--version` / `--help` smoke, on any platform.
- A row driven on a *sibling* run-target (another arch of the same OS, another
  host of the same `.com`). Inheritance is what this ledger exists to prevent.
- Anything from a run recorded under `## Attempted, not evidence` below.
- Reasoning, however sound, about what a platform "should" do.

**Provenance of the CI rows.** The build legs install the provider with an
unpinned `npm i -g @anthropic-ai/claude-code` and fuse against whatever that
resolved to that day, so those rows record `unpinned` rather than inventing a
version; the leg's log names it, and the row names the workflow run so it can be
looked up. `how: ci` in the manifest points at the CI rig in `PLATFORMS.md`.

**Append, never rewrite — and the LATEST row wins.** A superseded result stays;
the newer row goes beside it, never over it. `floorCoverage()` in
`scripts/tjs-legs.mjs` resolves each (run-target, recipe row) pair to the row
with the newest date (file order breaks a tie) and counts it green only on
`pass`. So a recorded regression genuinely takes coverage away: appending a
`fail` for a row that once passed drops the run-target's coverage, which is the
entire reason for writing failures down. Rows in any section AFTER this table
are invisible to that parser by construction.

**A `how: ci` row is a claim about the PRESENT, and decays.** This is the one
asymmetry in the ledger, and it is worth stating plainly because it has already
produced a false record. Every hand-driven row is a *fact about the past* — "on
2026-08-09 a human drove D1 on real Windows and it passed" — and stays true
forever no matter what happens later; append-only latest-wins is built for
exactly that shape. A `how: ci` row is not that. Its claim is that the smoke
"fuses and runs a quaude ... **on every build**" — present tense, a recurring
process. When the leg stops passing, the historical run it cites is still real,
but the claim it is being used to make has silently become false, and an
append-only ledger has no way to notice. haiku-x64 kept a green G7 row through
14 consecutive red builds exactly this way.

So a CI row carries an obligation the hand-driven ones do not: **it must cite
the workflow run that produced it** (`run <id>`), so the claim is checkable
against the leg's real current state rather than taken on trust. Two mechanisms
enforce this, and they catch different things:

- `test/fidelity/fidelity-notes.test.cjs` — offline, deterministic, part of
  `npm test`. Every `fidelity` note in `scripts/tjs-legs.mjs` must state exactly
  the coverage `floorCoverage()` derives from this file. A hand-written sentence
  can no longer drift from the ledger it summarizes. (This is what caught
  netbsd-arm64 still claiming "2/6" after it had been re-driven to 6/6.)
- `test/fidelity/ci-claim-check.mjs` — needs the network and `gh`, so it is NOT
  in `npm test`. It asks GitHub for each CI-claiming leg's *current* conclusion
  on main and fails on any leg that is red while this file still records a
  passing CI row for it. That is the only check that can catch haiku's class,
  because the fact it needs — "is this leg passing right now?" — is simply not
  in the repo.

Note what is deliberately NOT done: no calendar-based expiry. A timer measures
elapsed days and claims to measure leg health, which is the wrong instrument in
both directions — it would expire `linux-x64-musl` (green all along) while
happily blessing a leg that went red the day after someone re-dated it. It
would also make `npm test` fail on unrelated changes for no reason, which this
repo has ruled against (`scripts/fidelity-ledger.mjs`: staleness is surfaced,
never gated).

| date | run-target | row | engine | bundle | verdict | note |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-08-09 | netbsd-arm64 | B4 | quaude | 2.1.218 | pass | floor-probe over ssh: Write+Read+Edit+Grep+Bash chained in ONE agentic loop; file reads B4-EDITED on disk, grep hit and bash output both returned to the model — driven on NetBSD 11.0_RC2 (ABOVE the leg floor of 10.1, not at it) against the pre-existing ~/quaude dated 2026-07-24, provenance not re-verified |
| 2026-08-09 | linux-arm64-glibc | B4 | quaude | 2.1.218 | pass | floor-probe over ssh: Write+Read+Edit+Grep+Bash chained in ONE agentic loop; file reads B4-EDITED on disk, grep hit and bash output both returned to the model |
| 2026-08-09 | linux-arm64-glibc | D1 | quaude | 2.1.218 | pass | interactive pty over ssh -tt to the Ubuntu 24 VM: TUI booted, turn answered TUIPONG against the canned mock, /quit exited CLEANLY code 0 in 1351ms |
| 2026-08-09 | linux-arm64-glibc | A1 | quaude | 2.1.218 | pass | floor-probe over ssh to the Ubuntu 24 VM. Engine built ON that VM from current sources; the PUBLISHED template could not be used (predates 906af8b, so stat() omits uid/gid and the tmpdir guard refuses to start) |
| 2026-08-09 | linux-arm64-glibc | C1 | quaude | 2.1.218 | pass | floor-probe over ssh: Write tool wrote FLOOR-WRITE-OK, 15 bytes non-zero on disk |
| 2026-08-09 | linux-arm64-glibc | B1 | quaude | 2.1.218 | pass | floor-probe over ssh: Bash tool_result carried FLOOR-BASH-OK back to the model |
| 2026-08-09 | linux-arm64-glibc | G7 | quaude | 2.1.218 | pass | floor-probe over ssh: -p exit 0, PONG, POST landed on /messages |
| 2026-08-09 | windows-amd64 | D1 | quaude | 2.1.218 | pass | interactive pty over ssh -tt to REAL Windows (Git Bash; profile isolated via USERPROFILE, not just HOME): TUI booted, turn answered TUIPONG against the canned mock, /quit exited CLEANLY code 0 in 2398ms |
| 2026-08-09 | darwin-arm64 | D1 | quaude | 2.1.218 | pass | interactive pty (node-pty, canned mock): TUI booted, live turn answered TUIPONG, then /quit exited CLEANLY code 0 in 1411ms — no wedge |
| 2026-08-09 | netbsd-arm64 | D1 | quaude | 2.1.218 | pass | interactive pty over ssh -tt (guest has no node; mock served from the host): TUI booted, turn answered TUIPONG, /quit exited CLEANLY code 0 in 3490ms — driven on NetBSD 11.0_RC2 (ABOVE the leg floor of 10.1, not at it) against the pre-existing ~/quaude dated 2026-07-24, provenance not re-verified |
| 2026-08-09 | windows-amd64 | A1 | quaude | 2.1.218 | pass | floor-probe over ssh to real Windows (Git Bash shell, quaude cross-fused here from the cached PE32+ engine, mock served over tailnet): config non-zero, parses, onboarding + project trust survive a second launch |
| 2026-08-09 | windows-amd64 | C1 | quaude | 2.1.218 | pass | floor-probe over ssh: Write tool wrote FLOOR-WRITE-OK, 15 bytes non-zero on disk (file_path in NATIVE C:\ form via cygpath) |
| 2026-08-09 | windows-amd64 | B1 | quaude | 2.1.218 | pass | floor-probe over ssh: Bash tool_result carried FLOOR-BASH-OK back to the model |
| 2026-08-09 | windows-amd64 | G7 | quaude | 2.1.218 | pass | floor-probe over ssh: -p exit 0, PONG, POST landed on /messages |
| 2026-08-09 | netbsd-arm64 | A1 | quaude | 2.1.218 | pass | floor-probe over ssh (guest has no node; mock served from the host at 10.0.2.2): config non-zero, parses, onboarding + project trust survive a second launch — driven on NetBSD 11.0_RC2 (ABOVE the leg floor of 10.1, not at it) against the pre-existing ~/quaude dated 2026-07-24, provenance not re-verified |
| 2026-08-09 | netbsd-arm64 | C1 | quaude | 2.1.218 | pass | floor-probe over ssh: Write tool wrote FLOOR-WRITE-OK, 15 bytes non-zero on disk — driven on NetBSD 11.0_RC2 (ABOVE the leg floor of 10.1, not at it) against the pre-existing ~/quaude dated 2026-07-24, provenance not re-verified |
| 2026-08-09 | netbsd-arm64 | B1 | quaude | 2.1.218 | pass | floor-probe over ssh: Bash tool_result carried FLOOR-BASH-OK back to the model — driven on NetBSD 11.0_RC2 (ABOVE the leg floor of 10.1, not at it) against the pre-existing ~/quaude dated 2026-07-24, provenance not re-verified |
| 2026-08-09 | netbsd-arm64 | G7 | quaude | 2.1.218 | pass | floor-probe over ssh: -p exit 0, PONG, POST landed on /messages — driven on NetBSD 11.0_RC2 (ABOVE the leg floor of 10.1, not at it) against the pre-existing ~/quaude dated 2026-07-24, provenance not re-verified |
| 2026-08-09 | darwin-arm64 | A1 | quaude | 2.1.218 | pass | floor-probe: config non-zero, parses, onboarding + project trust survive a second launch (scripts/floor-probe.mjs, fresh `clode build` after the 2026-08-06 shim fixes) |
| 2026-08-09 | darwin-arm64 | C1 | quaude | 2.1.218 | pass | floor-probe: Write tool wrote FLOOR-WRITE-OK, 15 bytes non-zero on disk |
| 2026-08-09 | darwin-arm64 | B1 | quaude | 2.1.218 | pass | floor-probe: Bash tool_result carried FLOOR-BASH-OK back to the model |
| 2026-08-09 | darwin-arm64 | G7 | quaude | 2.1.218 | pass | floor-probe: -p exit 0, PONG, POST landed on /messages |
| 2026-07-31 | darwin-ppc | G7 | quaude | 2.1.218 | pass | mock-anthropic: -p exit 0, "Paris", first byte 337ms |
| 2026-07-31 | darwin-ppc | G6 | quaude | 2.1.218 | open | REAL api.anthropic.com stalls before any API request when ~/.claude/.credentials.json exists |
| 2026-07-31 | darwin-ppc | B1 | quaude | 2.1.218 | pass | Bash outcome=ok on Tiger VM |
| 2026-07-31 | darwin-ppc | C1 | quaude | 2.1.218 | pass | Write wrote NEEDLE-TIGER-WRITE to disk |
| 2026-07-30 | cosmo-macos-aarch64 | B4 | quaude | 2.1.218 | pass | full agentic suite at parity with native tjs: mcp-ws, tools 5/5, workflow, subagent-diff |
| 2026-07-29 | cosmo-macos-aarch64 | F6 | quaude | 2.1.218 | pass | PTY differential 2/2 after the libuv tty reopen-skip fix |
| 2026-07-29 | cosmo-macos-aarch64 | D6 | quaude | 2.1.218 | pass | resize reflow 2/2 |
| 2026-08-24 | darwin-arm64 | G2 | quaude | 2.1.241 | pass | REAL CREDENTIALS, real tokens: test/fidelity/interactive-live-turn.test.cjs with CLODE_LIVE_RENDER=1 CLODE_LIVE_ONLINE=1, against UPSTREAM 2.1.241 (staged on PATH so nativeClaude() picks it; the operator install is 2.1.227). Built a quaude from it, drove BOTH under a pty, typed a prompt whose answer is not in the prompt text ("6 times 7"), and quaude rendered the streamed 42 like native did — no "Not logged in", no shim-error marker. 2/2, 98s; the native row did not skip, so the native-vs-quaude version check held. Also driven at 2.1.227 the same day, same result. First G2 on a mainstream platform — the only prior one was cosmo, 2026-07-29, bundle 2.1.218 |
| 2026-07-29 | cosmo-macos-aarch64 | G2 | quaude | 2.1.218 | pass | real creds, streamed "Paris" in the interactive TUI, 2/2 |
| 2026-07-09 | netbsd-sparc | G7 | quaude | 2.1.204 | pass | mock PONG -p round-trip: real POST /v1/messages on host mock wire log + literal PONG on 32-bit BE sun4m guest console, 66s e2e under TCG (commit 75bbf1c, backfilled 2026-08-04) |
| 2026-07-09 | netbsd-arm64 | G7 | quaude | 2.1.204 | pass | mock PONG -p round-trip, port A (spike/quickjs/results/phase3-netbsd-aarch64-scorecard.md probe 5, evbarm-aarch64 qemu+HVF guest; commit b625bdb/1b6881c, backfilled 2026-08-04) |
| 2026-07-09 | netbsd-arm64 | B1 | quaude | 2.1.204 | pass | agentic Bash tool round-trip: tool_use dispatched, tool_result content carries real stdout inline, is_error false (run 2, after fixing shell-discovery wall — base NetBSD ships no bash/zsh; pkgsrc bash added). Same scorecard, probes 6-7, backfilled 2026-08-04 |
| 2026-07-11 | darwin-x64 | G7 | quaude | 2.1.179 | pass | on-box fuse on real Mavericks 10.9.5 (Darwin 13.4.0, x86_64): builder fetches provider over mbedtls TLS, fuses a 29MB quaude, PONG (-p 'say PONG' vs mock, POST verified) + attest green, quaude answers --version (commit 57fb352, backfilled 2026-08-04) |
| 2026-07-29 | darwin-arm64 | B1 | quaude | 2.1.218 | pass | Bash tool round-trip, tool_result carries stdout inline (spike/quickjs/results/cosmo-fidelity-run.md sec.3 scenario 3, native-tjs CONTROL build/tjs/macos-26-arm64/tjs; backfilled 2026-08-04) |
| 2026-07-29 | darwin-arm64 | C1 | quaude | 2.1.218 | pass | Write round-trip creates file on disk (same source, scenario 1; backfilled 2026-08-04) |
| 2026-07-29 | darwin-arm64 | G7 | quaude | 2.1.218 | pass | -p mock-anthropic Bash turn reaches a final response (same source, scenario 3; backfilled 2026-08-04) |
| 2026-07-29 | darwin-arm64 | H1 | quaude | 2.1.218 | pass | 2-tool Bash loop, both tool_results coherent+ordered (same source, scenario 4; backfilled 2026-08-04) |
| 2026-07-29 | darwin-arm64 | H3 | quaude | 2.1.218 | pass | --continue restores prior session context (same source, scenario 6; backfilled 2026-08-04) |
| 2026-07-29 | darwin-arm64 | H4 | quaude | 2.1.218 | pass | PreToolUse hook fires + denies claude update (same source, scenario 5; backfilled 2026-08-04) |
| 2026-07-29 | darwin-arm64 | H7 | quaude | 2.1.218 | pass | Workflow runs to completed (same source, scenario 7; backfilled 2026-08-04) |
| 2026-07-30 | darwin-arm64 | B4 | quaude | 2.1.218 | pass | full agentic suite at parity with native tjs, incl. Edit/FileHandle.chmod (BACKLOG.md "FULL AGENTIC FIDELITY SUITE GREEN ON COSMO (2026-07-30)" parity note: Write/Grep/Bash/Edit all pass on native tjs too; backfilled 2026-08-04) |
| 2026-07-30 | darwin-arm64 | H6 | quaude | 2.1.218 | pass | subagent (Task) dispatch identical node-vs-quaude, at parity with cosmo (BACKLOG.md 2026-07-30 "agentic-subagent-diff 1/1"; backfilled 2026-08-04) |
| 2026-07-29 | cosmo-macos-aarch64 | C1 | quaude | 2.1.218 | pass | Write round-trip creates file on disk (spike/quickjs/results/cosmo-fidelity-run.md sec.3 scenario 1, cosmo SUBJECT arm — 7/7, identical to the native CONTROL that backs the darwin-arm64 rows above; backfilled 2026-08-04) |
| 2026-07-29 | cosmo-macos-aarch64 | B1 | quaude | 2.1.218 | pass | Bash stdout INLINE in tool_result (same source, scenario 3, SUBJECT arm; backfilled 2026-08-04) |
| 2026-07-29 | cosmo-macos-aarch64 | G7 | quaude | 2.1.218 | pass | -p mock-anthropic Bash turn reaches a final response (same source, scenario 3, SUBJECT arm). The same document's "actual shipped artifact" check drove the FUSED quaude.com via /bin/sh to a final turn with inline tool_result — the shipped-binary form of the same claim (backfilled 2026-08-04) |
| 2026-07-29 | cosmo-macos-aarch64 | H1 | quaude | 2.1.218 | pass | 2-tool Bash loop, both tool_results coherent+ordered (same source, scenario 4, SUBJECT arm; backfilled 2026-08-04) |
| 2026-07-29 | cosmo-macos-aarch64 | H3 | quaude | 2.1.218 | pass | --continue restores prior session context (same source, scenario 6, SUBJECT arm; backfilled 2026-08-04) |
| 2026-07-29 | cosmo-macos-aarch64 | H4 | quaude | 2.1.218 | pass | PreToolUse hook fires + denies claude update (same source, scenario 5, SUBJECT arm; backfilled 2026-08-04) |
| 2026-07-29 | cosmo-macos-aarch64 | H7 | quaude | 2.1.218 | pass | Workflow runs to completed (same source, scenario 7, SUBJECT arm; backfilled 2026-08-04) |
| 2026-08-02 | netbsd-amd64 | G7 | quaude | unpinned | pass | build-pipeline PONG smoke ("What earns a row" #2): quaude fused and run INSIDE the NetBSD 10.1/amd64 guest, mock -p round-trip + attest green (release-tier CI run 30730368429, commit 4881ca8) |
| 2026-08-02 | freebsd-amd64 | G7 | quaude | unpinned | pass | build-pipeline PONG smoke, in-guest on FreeBSD 14.0/amd64 (release-tier CI run 30730368429) |
| 2026-08-02 | freebsd-arm64 | G7 | quaude | unpinned | pass | build-pipeline PONG smoke, in-guest on FreeBSD 14.4/arm64 under TCG (release-tier CI run 30730368429) |
| 2026-08-02 | openbsd-amd64 | G7 | quaude | unpinned | pass | build-pipeline PONG smoke, in-guest on OpenBSD 7.9/amd64 (release-tier CI run 30730368429) |
| 2026-08-02 | openbsd-arm64 | G7 | quaude | unpinned | pass | build-pipeline PONG smoke, in-guest on OpenBSD 7.9/arm64 under TCG (release-tier CI run 30730368429) |
| 2026-08-02 | dragonflybsd-amd64 | G7 | quaude | unpinned | pass | build-pipeline PONG smoke, in-guest on DragonFly 6.4.2 (release-tier CI run 30730368429) |
| 2026-08-02 | midnightbsd-amd64 | G7 | quaude | unpinned | pass | build-pipeline PONG smoke, in-guest on MidnightBSD 4.0.4 (release-tier CI run 30730368429) |
| 2026-08-02 | omnios-amd64 | G7 | quaude | unpinned | pass | build-pipeline PONG smoke, in-guest on OmniOS r151056 (release-tier CI run 30730368429) |
| 2026-08-02 | openindiana-amd64 | G7 | quaude | unpinned | pass | build-pipeline PONG smoke, in-guest on OpenIndiana 202510 (release-tier CI run 30730368429) |
| 2026-08-02 | solaris-amd64 | G7 | quaude | unpinned | pass | build-pipeline PONG smoke, in-guest on Solaris 11.4 (release-tier CI run 30730368429) |
| 2026-08-02 | haiku-x64 | G7 | quaude | unpinned | pass | build-pipeline PONG smoke, in-guest on Haiku r1beta5 — the >64KB uv_write deadlock class does not block a -p turn (release-tier CI run 30730368429) |
| 2026-08-02 | windows-amd64 | G7 | quaude | unpinned | pass | build-pipeline PONG smoke, fused and run natively on the windows-latest runner (release-tier CI run 30730368429) |
| 2026-08-02 | windows-arm64 | G7 | quaude | unpinned | pass | build-pipeline PONG smoke, fused and run natively on the windows-11-arm runner (release-tier CI run 30730368429) |
| 2026-08-02 | linux-x64-musl | G7 | quaude | unpinned | pass | build-pipeline PONG smoke: the static-musl x86_64 artifact fused and run on the ubuntu-latest runner (same kernel+arch as its target; static, so the host libc is not in play) (release-tier CI run 30730368429) |
| 2026-08-02 | linux-arm64-musl | G7 | quaude | unpinned | pass | build-pipeline PONG smoke, static-musl aarch64 artifact run on the ubuntu-24.04-arm runner (release-tier CI run 30730368429) |
| 2026-08-02 | linux-x86-musl | G7 | quaude | unpinned | pass | build-pipeline PONG smoke, static-musl 32-bit x86 artifact executed natively by the x86_64 runner kernel (release-tier CI run 30730368429) |
| 2026-08-02 | cosmo-linux-x86-64 | G7 | quaude | unpinned | pass | build-pipeline PONG smoke: the fat APE fused and run ON the ubuntu-latest build host — the ONE cosmo host the .com is actually executed on in CI; the other seven cosmo run-targets get nothing from this row (release-tier CI run 30730368429) |
| 2026-08-02 | netbsd-arm64 | G7 | quaude | unpinned | pass | build-pipeline PONG smoke, in-guest on NetBSD 10.1/arm64 under TCG — a fresh, independently-dated confirmation of the 2026-07-09 spike row above (release-tier CI run 30730368429) |
| 2026-08-02 | netbsd-sparc | G7 | quaude | unpinned | pass | build-pipeline PONG smoke via the own-qemu backend: the cross-fused sparc builder fuses a quaude and PONGs on the 32-bit BE sun4m guest — confirms the 2026-07-09 row above (release-tier CI run 30730368429) |
| 2026-08-02 | darwin-arm64 | G7 | quaude | unpinned | pass | build-pipeline PONG smoke, fused and run natively on the macos-14 (floor) runner — confirms the 2026-07-29 scenario-3 row above (release-tier CI run 30730368429) |
| 2026-08-09 | netbsd-arm64 | G7 | quaude | 2.1.218 | fail | FRESHLY cross-fused quaude (cached netbsd-11-arm64 engine, which PREDATES 906af8b and omits uid/gid from FSS.stat): the bundle's tmpdir-ownership guard reads uid 0 for /tmp/claude-1000 (owned by 1000) and refuses to start. Today's earlier passes on this run-target came from a 2026-07-24 binary and only succeeded because that directory did not exist yet |
| 2026-08-09 | netbsd-arm64 | B1 | quaude | 2.1.218 | fail | FRESHLY cross-fused quaude (cached netbsd-11-arm64 engine, which PREDATES 906af8b and omits uid/gid from FSS.stat): the bundle's tmpdir-ownership guard reads uid 0 for /tmp/claude-1000 (owned by 1000) and refuses to start. Today's earlier passes on this run-target came from a 2026-07-24 binary and only succeeded because that directory did not exist yet |
| 2026-08-09 | netbsd-arm64 | C1 | quaude | 2.1.218 | fail | FRESHLY cross-fused quaude (cached netbsd-11-arm64 engine, which PREDATES 906af8b and omits uid/gid from FSS.stat): the bundle's tmpdir-ownership guard reads uid 0 for /tmp/claude-1000 (owned by 1000) and refuses to start. Today's earlier passes on this run-target came from a 2026-07-24 binary and only succeeded because that directory did not exist yet |
| 2026-08-09 | netbsd-arm64 | A1 | quaude | 2.1.218 | fail | FRESHLY cross-fused quaude (cached netbsd-11-arm64 engine, which PREDATES 906af8b and omits uid/gid from FSS.stat): the bundle's tmpdir-ownership guard reads uid 0 for /tmp/claude-1000 (owned by 1000) and refuses to start. Today's earlier passes on this run-target came from a 2026-07-24 binary and only succeeded because that directory did not exist yet |
| 2026-08-09 | netbsd-arm64 | B4 | quaude | 2.1.218 | fail | FRESHLY cross-fused quaude (cached netbsd-11-arm64 engine, which PREDATES 906af8b and omits uid/gid from FSS.stat): the bundle's tmpdir-ownership guard reads uid 0 for /tmp/claude-1000 (owned by 1000) and refuses to start. Today's earlier passes on this run-target came from a 2026-07-24 binary and only succeeded because that directory did not exist yet |
| 2026-08-09 | windows-amd64 | G7 | quaude | 2.1.218 | pass | REDRIVEN under real isolation (USERPROFILE/HOMEDRIVE/HOMEPATH, not just HOME) with both harness guards armed (sandbox-sentinel + pre-armed tmpdir guard), mock reached over the tailnet. SUPERSEDES this run-target's earlier 2026-08-09 rows, which ran against the operator's REAL profile and were not trustworthy: -p exit 0, PONG, POST landed |
| 2026-08-09 | windows-amd64 | B1 | quaude | 2.1.218 | pass | REDRIVEN under real isolation (USERPROFILE/HOMEDRIVE/HOMEPATH, not just HOME) with both harness guards armed (sandbox-sentinel + pre-armed tmpdir guard), mock reached over the tailnet. SUPERSEDES this run-target's earlier 2026-08-09 rows, which ran against the operator's REAL profile and were not trustworthy: Bash tool_result carried FLOOR-BASH-OK |
| 2026-08-09 | windows-amd64 | C1 | quaude | 2.1.218 | pass | REDRIVEN under real isolation (USERPROFILE/HOMEDRIVE/HOMEPATH, not just HOME) with both harness guards armed (sandbox-sentinel + pre-armed tmpdir guard), mock reached over the tailnet. SUPERSEDES this run-target's earlier 2026-08-09 rows, which ran against the operator's REAL profile and were not trustworthy: Write wrote 15 bytes, content exact |
| 2026-08-09 | windows-amd64 | A1 | quaude | 2.1.218 | pass | REDRIVEN under real isolation (USERPROFILE/HOMEDRIVE/HOMEPATH, not just HOME) with both harness guards armed (sandbox-sentinel + pre-armed tmpdir guard), mock reached over the tailnet. SUPERSEDES this run-target's earlier 2026-08-09 rows, which ran against the operator's REAL profile and were not trustworthy: config non-zero, parses, onboarding + project trust survive a relaunch |
| 2026-08-09 | windows-amd64 | B4 | quaude | 2.1.218 | pass | REDRIVEN under real isolation (USERPROFILE/HOMEDRIVE/HOMEPATH, not just HOME) with both harness guards armed (sandbox-sentinel + pre-armed tmpdir guard), mock reached over the tailnet. SUPERSEDES this run-target's earlier 2026-08-09 rows, which ran against the operator's REAL profile and were not trustworthy: Write+Read+Edit+Grep+Bash chained in one agentic loop, file reads B4-EDITED on disk |
| 2026-08-21 | netbsd-arm64 | G7 | quaude | 2.1.218 | pass | floor-probe over ssh, driven against a quaude built from an engine compiled ON that guest from CURRENT sources (67 patches, incl. 906af8b's uid/gid) — SUPERSEDES the 2026-08-09 failing rows, which used a cached pre-906af8b engine whose FSS.stat omitted uid/gid and tripped the tmpdir-ownership guard: -p exit 0, PONG, POST landed |
| 2026-08-21 | netbsd-arm64 | B1 | quaude | 2.1.218 | pass | floor-probe over ssh, driven against a quaude built from an engine compiled ON that guest from CURRENT sources (67 patches, incl. 906af8b's uid/gid) — SUPERSEDES the 2026-08-09 failing rows, which used a cached pre-906af8b engine whose FSS.stat omitted uid/gid and tripped the tmpdir-ownership guard: Bash tool_result carried FLOOR-BASH-OK |
| 2026-08-21 | netbsd-arm64 | C1 | quaude | 2.1.218 | pass | floor-probe over ssh, driven against a quaude built from an engine compiled ON that guest from CURRENT sources (67 patches, incl. 906af8b's uid/gid) — SUPERSEDES the 2026-08-09 failing rows, which used a cached pre-906af8b engine whose FSS.stat omitted uid/gid and tripped the tmpdir-ownership guard: Write wrote 15 bytes, content exact |
| 2026-08-21 | netbsd-arm64 | A1 | quaude | 2.1.218 | pass | floor-probe over ssh, driven against a quaude built from an engine compiled ON that guest from CURRENT sources (67 patches, incl. 906af8b's uid/gid) — SUPERSEDES the 2026-08-09 failing rows, which used a cached pre-906af8b engine whose FSS.stat omitted uid/gid and tripped the tmpdir-ownership guard: config non-zero, parses, onboarding + project trust survive a relaunch |
| 2026-08-21 | netbsd-arm64 | B4 | quaude | 2.1.218 | pass | floor-probe over ssh, driven against a quaude built from an engine compiled ON that guest from CURRENT sources (67 patches, incl. 906af8b's uid/gid) — SUPERSEDES the 2026-08-09 failing rows, which used a cached pre-906af8b engine whose FSS.stat omitted uid/gid and tripped the tmpdir-ownership guard: Write+Read+Edit+Grep+Bash chained in one agentic loop, file reads B4-EDITED on disk |
| 2026-08-21 | netbsd-arm64 | D1 | quaude | 2.1.218 | pass | tui-probe over ssh -tt (scripts/tui-probe.mjs), driven against a quaude built from an engine compiled ON that guest from CURRENT sources (67 patches, incl. 906af8b's uid/gid) — SUPERSEDES the 2026-08-09 failing rows, which used a cached pre-906af8b engine whose FSS.stat omitted uid/gid and tripped the tmpdir-ownership guard: TUI booted, turn answered TUIPONG, /quit exited CLEANLY code 0 in 1096ms |
| 2026-08-24 | haiku-x64 | G7 | quaude | unpinned | fail | WITHDRAWAL of the 2026-08-02 row above. The build-pipeline smoke that earns G7 under "What earns a row" #2 has not reached a PONG on any build since ~2026-08-02: the leg dies in guest package install, BEFORE any build/fuse/smoke, on 14+ consecutive identical `ci` runs (30730368429 was the last green; 32606247462, 32622574608, 32664058079 are three of the reds). `Refreshing repository "HaikuPorts" failed *** Failed to download package c_ares: Resource not found`. Cause is upstream and verified by direct HTTP probe, not inferred: Haiku deleted the r1beta5 HaikuPorts repo — https://eu.hpkg.haiku-os.org/haikuports/ lists only ["master"], the r1beta5 `repo` index serves a 2-byte `[]` (matching the log's "repochecksum-1 [2 bytes]") vs ~540KB for beta6/master, and the c_ares .hpkg 404s. NOTE the verdict: `fail` here means THE PIPELINE THAT EARNS THE ROW FAILS, not that a PONG ran and came back wrong — no turn executed at all. Recorded as `fail` because that is the verdict floorCoverage() understands, and revoking the claim is the honest outcome |
| 2026-09-22 | darwin-arm64 | G7 | quaude | 2.1.278 | pass | CANDIDATE bundle, NOT the pin. floor-probe against a quaude built on this box from the 2.1.278 provider with the fixes below (Bun.unsafe, crypto.randomInt): -p exit 0, PONG, POST landed. Read this block together with the 2.1.251 block underneath it, which is the bundle clode actually ships today and which therefore decides this run-target's derived coverage |
| 2026-09-22 | darwin-arm64 | B1 | quaude | 2.1.278 | pass | CANDIDATE bundle. floor-probe: Bash tool_result carried FLOOR-BASH-OK |
| 2026-09-22 | darwin-arm64 | C1 | quaude | 2.1.278 | pass | CANDIDATE bundle. floor-probe: Write wrote 15 bytes, content exact |
| 2026-09-22 | darwin-arm64 | A1 | quaude | 2.1.278 | pass | CANDIDATE bundle. floor-probe: config non-zero, parses, onboarding + project trust survive a relaunch |
| 2026-09-22 | darwin-arm64 | B4 | quaude | 2.1.278 | pass | CANDIDATE bundle. floor-probe: Write+Read+Edit+Grep+Bash chained in one agentic loop, file reads B4-EDITED on disk |
| 2026-09-22 | darwin-arm64 | D1 | quaude | 2.1.278 | fail | CANDIDATE bundle, and THE FINDING OF THIS DRIVE: the interactive TUI PAINTS NOTHING. tui-probe (node-pty, canned mock): the process enters the alternate screen, sets its title, runs the turn (two POSTs landed on /messages), and /quit exits code 0 — but emits ZERO printable cells, 518 bytes of pure control sequences. NATIVE 2.1.278 under the IDENTICAL harness paints normally and passes, so by the RECIPE's localization rule this is ours (engine / node-shim), not upstream. This state is AFTER two shim fixes that this drive found and landed; before them the same binary died at `Bun.unsafe.setJITPolicy` ("An internal error ended the session") and then hung with the render root never constructed. The remaining divergence is NOT the X1 tty knobs (CLODE_TTY_MOUSE=1 CLODE_TTY_FOCUS=1: same result) and NOT the fullscreen lever (CLAUDE_CODE_NO_FLICKER=1: same result). Next suspect, from the guest's debug log: 2.1.278 added a terminal-capability handshake (XTVERSION `CSI > 0 q`, kitty-keyboard `CSI ? u`, DA1 `CSI c`) whose no-reply fallback native survives and quaude does not |
| 2026-09-22 | netbsd-arm64 | G7 | quaude | 2.1.278 | pass | CANDIDATE bundle, NOT the pin. floor-probe over ssh to the live NetBSD 11.0_RC2 evbarm guest, against a quaude cross-blobulated here onto an engine compiled ON that guest from current sources TODAY: -p exit 0, PONG, POST landed |
| 2026-09-22 | netbsd-arm64 | B1 | quaude | 2.1.278 | pass | CANDIDATE bundle. floor-probe over ssh: Bash tool_result carried FLOOR-BASH-OK |
| 2026-09-22 | netbsd-arm64 | C1 | quaude | 2.1.278 | pass | CANDIDATE bundle. floor-probe over ssh: Write wrote 15 bytes, content exact |
| 2026-09-22 | netbsd-arm64 | A1 | quaude | 2.1.278 | pass | CANDIDATE bundle. floor-probe over ssh: config non-zero, parses, onboarding + project trust survive a relaunch |
| 2026-09-22 | netbsd-arm64 | B4 | quaude | 2.1.278 | pass | CANDIDATE bundle. floor-probe over ssh: Write+Read+Edit+Grep+Bash chained in one agentic loop, file reads B4-EDITED on disk |
| 2026-09-22 | netbsd-arm64 | D1 | quaude | 2.1.278 | fail | CANDIDATE bundle, and WORSE HERE THAN ON DARWIN: tui-probe over ssh -tt never reaches the alternate screen at all. The process sets the title, issues the three capability queries, gets no reply ("XTVERSION: no reply (terminal ignored query)"), shuts the LSP manager down, flushes telemetry and EXITS inside the boot window — no turn, no paint, 227 bytes of control sequences. Same binary passes all five headless floor rows on this guest, so this is interactive-only |
| 2026-09-22 | darwin-arm64 | G7 | quaude | 2.1.251 | pass | THE PINNED BUNDLE, re-driven today so the ledger's derived coverage describes the artifact clode actually ships. Fresh quaude built on this box from the 2.1.251 provider with today's shim. floor-probe: -p exit 0, PONG, POST landed |
| 2026-09-22 | darwin-arm64 | B1 | quaude | 2.1.251 | pass | PINNED BUNDLE, re-driven today. floor-probe: Bash tool_result carried FLOOR-BASH-OK |
| 2026-09-22 | darwin-arm64 | C1 | quaude | 2.1.251 | pass | PINNED BUNDLE, re-driven today. floor-probe: Write wrote 15 bytes, content exact |
| 2026-09-22 | darwin-arm64 | A1 | quaude | 2.1.251 | pass | PINNED BUNDLE, re-driven today. floor-probe: config non-zero, parses, onboarding + project trust survive a relaunch |
| 2026-09-22 | darwin-arm64 | B4 | quaude | 2.1.251 | pass | PINNED BUNDLE, re-driven today. floor-probe: Write+Read+Edit+Grep+Bash chained in one agentic loop, file reads B4-EDITED on disk |
| 2026-09-22 | darwin-arm64 | D1 | quaude | 2.1.251 | pass | PINNED BUNDLE, re-driven today. tui-probe (node-pty, canned mock): TUI booted, turn answered TUIPONG, /quit exited CLEANLY code 0 in 1424ms. This is the CONTROL that makes the 2.1.278 row above a finding about upstream's new bundle rather than about this box |
| 2026-09-22 | netbsd-arm64 | G7 | quaude | 2.1.251 | pass | PINNED BUNDLE, re-driven today on the live NetBSD 11.0_RC2 evbarm guest. The engine was rebuilt ON that guest from current sources first (the 2026-08-21 engine still on the box is now REFUSED by `clode build`: it predates the constants ABI). floor-probe over ssh: -p exit 0, PONG, POST landed |
| 2026-09-22 | netbsd-arm64 | B1 | quaude | 2.1.251 | pass | PINNED BUNDLE, re-driven today, engine rebuilt on the guest. floor-probe over ssh: Bash tool_result carried FLOOR-BASH-OK |
| 2026-09-22 | netbsd-arm64 | C1 | quaude | 2.1.251 | pass | PINNED BUNDLE, re-driven today, engine rebuilt on the guest. floor-probe over ssh: Write wrote 15 bytes, content exact |
| 2026-09-22 | netbsd-arm64 | A1 | quaude | 2.1.251 | pass | PINNED BUNDLE, re-driven today, engine rebuilt on the guest. floor-probe over ssh: config non-zero, parses, onboarding + project trust survive a relaunch |
| 2026-09-22 | netbsd-arm64 | B4 | quaude | 2.1.251 | pass | PINNED BUNDLE, re-driven today, engine rebuilt on the guest. floor-probe over ssh: Write+Read+Edit+Grep+Bash chained in one agentic loop, file reads B4-EDITED on disk |
| 2026-09-22 | netbsd-arm64 | D1 | quaude | 2.1.251 | pass | PINNED BUNDLE, re-driven today, engine rebuilt on the guest. tui-probe over ssh -tt: TUI booted, turn answered TUIPONG, /quit exited CLEANLY code 0 in 1079ms |
| 2026-09-22 | netbsd-arm64 | F4 | quaude | 2.1.251 | pass | FIRST F4-CLASS ROW ON A NON-DARWIN RUN-TARGET, and the first evidence that the tier-2 blocker recorded as "trust-prompt freeze under iTerm2" does not reproduce here. Driven over ssh -tt with the project trust DELIBERATELY withheld from the seeded profile, so the real dialog appeared: "Quick safety check ... Is this a project you created or one you trust?" with "No, exit" preselected. A real Down arrow moved the selection to "Yes, I trust this folder" and a real Enter confirmed it; the dialog was replaced by the welcome box and the prompt, and the process did NOT exit. Keystrokes reach the read pump AND the input handler advances the prompt — which is exactly what F4 says must happen. NOTE what this row is not: it is not a run of F4 as literally written (that row is scoped `platform: iTerm2`, and there is no iTerm2 on NetBSD), it is the same ASSERTION driven on this run-target's own platform with real keystrokes |
| 2026-09-22 | darwin-arm64 | D1 | quaude | 2.1.278 | fail | CANDIDATE bundle, SECOND DRIVE, and the row above is now superseded on cause. The "no printable cells" symptom is FIXED — three defects, all landed today: `Bun.sliceAnsi` (NEW in .278; the ONLY Bun member the bundle gained since the pin) was missing, so every Ink layout pass that truncated a string threw a nameless quickjs TypeError which upstream caught and logged as "frame dropped"; npm slice-ansi, which now backs it, needs `Intl.Segmenter`'s `segments.containing()`, which our polyfill had never implemented; and once layout worked the engine took SIGSEGV in tjs__execute_jobs' unhandled-rejection drain (a use-after-free six lines of JavaScript can reach). With all three fixed the layout faults are GONE from the debug log and the renderer reaches its first frame — where it hits a FOURTH, LARGER wall and stops: `Error: This build of @anthropic-ai/bun-internal has no Bun.ant.CellSegmenter; src/ink needs bun-internal >= the version pinned in package.json` (at vs -> Mf -> cOe -> onRender). 2.1.278 moved Ink's screen model onto a NATIVE cell segmenter in Anthropic's private Bun namespace — segment()/paint()/setCell() over Int32Array cell+run buffers plus grapheme/sgrKey/uri intern pools — constructed unconditionally by the screen painter, with no fallback path. The XTVERSION-handshake lead recorded above is a RED HERRING: native writes the same three queries, gets the same no-reply, and paints anyway |
| 2026-09-22 | netbsd-arm64 | D1 | quaude | 2.1.278 | fail | CANDIDATE bundle, SECOND DRIVE, and ONE CAUSE ON BOTH LEGS — the degree difference recorded above was masking, not a second bug. With the same three fixes the guest now REACHES the alternate screen (boot=true where it previously never got there), the "ink layout pass threw" lines are gone from the guest's own debug log, and the process shuts down at exactly the same point in the same order as darwin (LSP manager down, telemetry flushed, exit inside the boot window). The binary is cross-blobulated here onto the published netbsd-arm64 engine template, which does NOT carry today's engine patch — so on this leg the fatal error is still SILENT, which is precisely what that patch fixes. Driven with tui-probe over `ssh -tt -p 2230` against the canned mock on 10.0.2.2 |
| 2026-09-22 | darwin-arm64 | D1 | quaude | 2.1.251 | pass | PINNED BUNDLE, RE-DRIVEN AFTER TODAY'S THREE FIXES — this is the control that says the fix did not trade one bundle for the other. Fresh quaude, fresh patched engine, same harness: tui-probe (node-pty, canned mock) TUI booted, turn answered TUIPONG, /quit exited CLEANLY code 0 in 1321ms |
| 2026-09-22 | netbsd-arm64 | D1 | quaude | 2.1.251 | pass | PINNED BUNDLE, RE-DRIVEN AFTER TODAY'S THREE FIXES, cross-blobulated here onto the published netbsd-arm64 engine template and driven on the live NetBSD 11.0_RC2 evbarm guest over ssh -tt: TUI booted, turn answered TUIPONG, /quit exited CLEANLY code 0 in 1078ms. The shim half of the fix (Bun.sliceAnsi + Intl.Segmenter.containing) is therefore proven non-regressive on BOTH legs |
| 2026-09-24 | darwin-arm64 | D1 | quaude | 2.1.278 | pass | CANDIDATE bundle, THIRD DRIVE, and the fourth wall recorded above is DOWN: bun-shim now provides `Bun.ant.CellSegmenter` (phases 1-2 of 6: pools, packing, segment/paint/setCell, SGR runs). Fresh quaude built on this box from the 2.1.278 provider. tui-probe (node-pty, canned mock): TUI booted, turn answered TUIPONG, /quit exited CLEANLY code 0 in 1606ms. Separately, test/frame-oracle.cjs against native 2.1.278 at 80x20: 0 differing cell-classes in the initial frame (709 at baseline); the one cell that sometimes differs flips on native-vs-native too. NOT a claim about wide glyphs, emoji or hyperlinks: phase 3/4 are not done and a frame containing them WILL differ (see BACKLOG.md) |
| 2026-09-24 | darwin-arm64 | D1 | quaude | 2.1.251 | pass | PINNED BUNDLE, the control for the row above: fresh quaude from the 2.1.251 provider with the same shim (Bun.ant now EXISTS with one member). tui-probe (node-pty, canned mock): TUI booted, turn answered TUIPONG, /quit exited CLEANLY code 0 in 1314ms |
| 2026-09-25 | darwin-arm64 | D1 | quaude | 2.1.278 | pass | CANDIDATE bundle, FOURTH DRIVE, after CellSegmenter phase 3 (quaude clusters, sizes and slices text as native Bun does; BACKLOG.md). Fresh quaude built on this box from the 2.1.278 provider and the final task-8 tree. tui-probe (node-pty, canned mock): TUI booted, turn answered TUIPONG, /quit exited CLEANLY code 0 in 1577ms |
| 2026-09-25 | darwin-arm64 | D1 | quaude | 2.1.251 | pass | PINNED BUNDLE, the control for the row above: fresh quaude from the 2.1.251 provider, same tree. tui-probe (node-pty, canned mock): TUI booted, turn answered TUIPONG, /quit exited CLEANLY code 0 in 1346ms |
| 2026-09-25 | darwin-arm64 | F5 | quaude | 2.1.278 | open | PARTIAL DRIVE, recorded open rather than pass: the wide / emoji / combining part PASSES, bracketed paste and scrollback were not driven. test/fidelity/interactive-frame-diff.test.cjs guard tui-prompt-wide-glyphs: U+4E2D U+6587, U+1F44D U+1F3FD, the U+1F1FA U+1F1F8 flag, e U+0301 and U+2764 U+FE0F typed into the prompt, frame compared cell for cell (glyph, width, SGR, OSC-8) with native 2.1.278 at 100x40: OK, 336 cells examined, 0 differences, on the fresh quaude of the D1 row above. Native vs native: identical. RED on the pre-phase-3 quaude (b278/q278ip): 14 differing cell-classes on the prompt row (glyph 10, width 2, sgr 2) |
| 2026-09-25 | darwin-arm64 | F5 | quaude | 2.1.251 | open | PARTIAL DRIVE, as the row above (wide / emoji / combining only), against native 2.1.251: tui-prompt-wide-glyphs OK, 336 cells, 0 differences, on the fresh 2.1.251 quaude. RED on the pre-phase-3 2.1.251 quaude: 8 differing cell-classes (glyph 6, sgr 2; the skin-toned emoji took 4 columns) |
| 2026-09-25 | darwin-arm64 | F6 | quaude | 2.1.278 | pass | test/fidelity/interactive-frame-diff.test.cjs guard tui-initial-frame-cells (the CELL-level form of F6: glyph, width, SGR, OSC-8) against native 2.1.278 at 100x40: OK, 353 cells examined, 0 differences, on the fresh quaude of the D1 row above |
| 2026-09-25 | darwin-arm64 | F6 | quaude | 2.1.251 | pass | tui-initial-frame-cells against native 2.1.251: OK, 353 cells, 0 differences, on the fresh 2.1.251 quaude |
| 2026-09-25 | linux-x64-musl | F5 | quaude | 2.1.251 | open | PARTIAL DRIVE, as the darwin rows above (wide / emoji / combining only): tui-prompt-wide-glyphs OK against native 2.1.251 linux-x64, 0 differences. Driven in a node:24.21.0-bookworm container on an x86_64 Linux docker daemon (ultimate-hat), mirroring CI's linux-x64-pty job step for step BEFORE the task-8 push: the quaude is the static-musl tjs from CI run 36084579962 plus the pinned provider, built inside the container by test/quaude-build's own path; run twice, on the tree before and after the lazy-Intl commit, both green |
| 2026-09-25 | linux-x64-musl | F6 | quaude | 2.1.251 | pass | Same container runs as the row above: tui-initial-frame-cells (cell level) OK and interactive-render-diff 2/2 against native 2.1.251 linux-x64, 0 differences |
| 2026-09-25 | darwin-arm64 | D1 | quaude | 2.1.278 | pass | CANDIDATE bundle, FIFTH DRIVE, after CellSegmenter phase 4 (OSC-8 links interned as native interns them; BACKLOG.md). Fresh quaude built on this box from the 2.1.278 provider and the final phase-4 tree (a187dac's libexec). tui-probe (node-pty, canned mock): TUI booted, turn answered TUIPONG, /quit exited CLEANLY code 0 in 1762ms |
| 2026-09-25 | darwin-arm64 | D1 | quaude | 2.1.251 | pass | PINNED BUNDLE, the control for the row above: fresh quaude from the 2.1.251 provider, same tree. tui-probe (node-pty, canned mock): TUI booted, turn answered TUIPONG, /quit exited CLEANLY code 0 in 1488ms |
| 2026-09-25 | darwin-arm64 | F2 | quaude | 2.1.278 | pass | A typed human turn, cell for cell: test/fidelity/interactive-frame-diff.test.cjs guard tui-reply-hyperlinks (CellSegmenter phase 4). `hi` typed, the canned mock answers with a markdown link and a bare URL, both sides under FORCE_HYPERLINK=1 and showTurnDuration off; frame compared (glyph, width, SGR, OSC-8) with native 2.1.278 at 100x40: OK, 398 cells examined, 0 differences, the reference painting both links, on the fresh quaude of the D1 row above. Native vs native: identical. RED on the pre-phase-4 quaude (phase3/fw/q278final, shim members hashing to 1d98cc1's): 64 differing cell-classes on the reply row (link 32, sgr 32) |
| 2026-09-25 | darwin-arm64 | F2 | quaude | 2.1.251 | pass | tui-reply-hyperlinks, as the row above, against native 2.1.251: OK, 398 cells, 0 differences, on the fresh 2.1.251 quaude |
| 2026-09-25 | darwin-arm64 | F5 | quaude | 2.1.278 | open | PARTIAL DRIVE (wide / emoji / combining only, as before), re-driven after phase 4 with the frame oracle now capturing asynchronously (its mock can answer): tui-prompt-wide-glyphs OK, 336 cells, 0 differences, on the fresh quaude of the D1 row above; native vs native identical |
| 2026-09-25 | darwin-arm64 | F5 | quaude | 2.1.251 | open | PARTIAL DRIVE, as the row above, against native 2.1.251: tui-prompt-wide-glyphs OK, 336 cells, 0 differences, on the fresh 2.1.251 quaude |
| 2026-09-25 | darwin-arm64 | F6 | quaude | 2.1.278 | pass | tui-initial-frame-cells re-driven after phase 4 under the asynchronous capture: OK, 353 cells, 0 differences, on the fresh quaude of the D1 row above; native vs native identical |
| 2026-09-25 | darwin-arm64 | F6 | quaude | 2.1.251 | pass | tui-initial-frame-cells against native 2.1.251: OK, 353 cells, 0 differences, on the fresh 2.1.251 quaude |
| 2026-09-25 | darwin-arm64 | D6 | quaude | 2.1.278 | pass | SIGWINCH resize, MULTI-FRAME (CellSegmenter phase 5): test/fidelity/interactive-session-diff.test.cjs session `resize` -- a turn, then 100x40 -> 60x30 -> 120x40 -> 100x40, a frame per step once output settles, compared cell for cell (glyph, width, SGR, OSC-8) with native 2.1.278: OK, 6 frames, 2675 painted cells, every frame settled on both sides, on fresh quaudes of the phase-5 tree (tasks 4-5). Native vs native identical (session-determinism, 3 runs). RED: a quaude whose tty never turns SIGWINCH into 'resize' differs at step "back 100x40" (94 cell-classes, the reply laid out at a stale width) |
| 2026-09-25 | darwin-arm64 | D6 | quaude | 2.1.251 | pass | PINNED BUNDLE: session `resize`, as the row above, against native 2.1.251: OK, 6 frames, 2675 cells, every frame settled |
| 2026-09-25 | darwin-arm64 | F5 | quaude | 2.1.278 | open | PARTIAL DRIVE, MULTI-FRAME (wide / emoji / combining and scrolling; bracketed paste NOT driven): interactive-session-diff sessions `type-edit` (wide CJK, an emoji + skin tone, base + combining marks typed, erased with backspace and retyped in the prompt; 6 frames, 2035 cells) and `scroll` (a 121-line reply at 320 columns paged up and down and wheeled, CLODE_TTY_MOUSE=1 on both sides per RECIPE X1; 8 frames, 15341 cells) against native 2.1.278: OK, every frame settled. Native vs native identical. RED: a quaude whose segment() never asks to grow differs in scroll at step "boot" (256 cell-classes) |
| 2026-09-25 | darwin-arm64 | F5 | quaude | 2.1.251 | open | PARTIAL DRIVE, as the row above, against native 2.1.251: type-edit OK (6 frames, 2035 cells), scroll OK (8 frames, 15329 cells) |
| 2026-09-25 | darwin-arm64 | F3 | quaude | 2.1.278 | open | PARTIAL DRIVE of "repaint erases prior lines" on a surface that still exists: interactive-session-diff session `slash-menu` (the slash menu opened and closed, the prompt cleared; 7 frames, 2968 cells) against native 2.1.278: OK, the closed menu's rows repainted exactly as native repaints them, every frame settled. F3's own surfaces were not driven: `/login` needs a logged-in profile, and the `/doctor` report no longer exists (the F3 section below) |
| 2026-09-25 | darwin-arm64 | F3 | quaude | 2.1.251 | open | PARTIAL DRIVE, as the row above, against native 2.1.251: slash-menu OK (7 frames, 2968 cells) |
| 2026-09-26 | darwin-arm64 | D1 | quaude | 2.1.278 | pass | CANDIDATE bundle, SIXTH DRIVE, after CellSegmenter phase 5 (paint()/setCell() and their damage exactly native's; the screen across frames native's; BACKLOG.md). Fresh quaude built on this box from the 2.1.278 provider and the final phase-5 tree (b927256's libexec; its embedded bun-shim.cjs and unicode-text.cjs byte-identical to the tree's). tui-probe (node-pty, canned mock): TUI booted, turn answered TUIPONG, /quit exited CLEANLY code 0 in 1636ms |
| 2026-09-26 | darwin-arm64 | D1 | quaude | 2.1.251 | pass | PINNED BUNDLE, the control for the row above: fresh quaude from the 2.1.251 provider, same tree. tui-probe (node-pty, canned mock): TUI booted, turn answered TUIPONG, /quit exited CLEANLY code 0 in 1312ms |
| 2026-09-26 | linux-x64-musl | D6 | quaude | 2.1.251 | pass | SIGWINCH resize, MULTI-FRAME, as the darwin rows above: interactive-session-diff session `resize` against native 2.1.251 linux-x64: OK, 6 frames, 2429 painted cells, every frame settled; native vs native identical first (session-determinism, all four sessions, 22163 cells). Driven in a node:24.21.0-bookworm container on an x86_64 Linux docker daemon (ultimate-hat) mirroring CI's linux-x64-pty job step for step BEFORE the task-7 push: the static-musl tjs from CI run 36172348016, the pinned provider minimised as CI minimises it, the quaude built inside the container by the gate's own builtQuaude path; all 13 steps green |
| 2026-09-26 | linux-x64-musl | F5 | quaude | 2.1.251 | open | PARTIAL DRIVE, as the darwin rows above (wide / emoji / combining and scrolling; bracketed paste NOT driven), same container run as the D6 row: type-edit OK (6 frames, 1789 cells), scroll OK (8 frames, 15264 cells), against native 2.1.251 linux-x64 (41 cells a frame fewer than darwin: the banner's shorter cwd) |
| 2026-09-26 | linux-x64-musl | F3 | quaude | 2.1.251 | open | PARTIAL DRIVE, as the darwin rows above (the slash menu, not F3's own surfaces), same container run as the D6 row: slash-menu OK (7 frames, 2681 cells) against native 2.1.251 linux-x64 |


## Attempted, not evidence

This section exists so a future reader knows a darwin-arm64 drive was
attempted and why its results were discarded, rather than re-running it and
re-discovering the same contamination.

On 2026-08-04 the agentic fidelity suite (`test/fidelity/agentic-tools.test.cjs`,
`test/fidelity/agentic-subagent-diff.test.cjs`,
`test/fidelity/agentic-workflow-complete.test.cjs`,
`test/node-shim-agentic.test.cjs`) was run against darwin-arm64, bundle
2.1.218, quaude. The run produced 10 tests: 2 pass (H3 `--continue`, H7
Workflow-completion), 7 fail (B4 Write/Grep, H1 multi-turn, H4 PreToolUse
hook, H6 subagent/Task dispatch, F2 Bash/Edit round-trip), 1 skip (no
`CLODE_DARWIN_PROVIDER_BIN`).

**The run was contaminated two ways and is not usable as evidence in either
direction:**

- **Stale engine.** `build/tjs/tjs` is dated 2026-07-24 — 40 commits behind
  HEAD on `libexec/node-shim` + `scripts/build-tjs.cjs` at the time of the
  run, including hang-class fixes (`a06b5ea` fs.watchFile poll hang,
  `865e98f` orphaned-grandchild-stdio-reader hang, `0d22c6a` uncaught
  timer/rejection routing).
- **Non-hermetic `$HOME`.** The tests' env construction spreads
  `{...process.env}` with no HOME override, so the staged child processes ran
  against THIS session's real, actively-mutating operator profile rather than
  a clean fixture. Captured `--debug-to-stderr` output from the Edit
  round-trip test shows real `~/.claude.json` lock contention
  (`Failed to save config with lock: Error: Lock file is already being
  held`, twice) and a live network git-clone of
  `github.com/obra/superpowers.git` mid-test, triggered by the bundle's
  plugin-autoupdate feature reading my real installed-plugins config.
  `~/.claude.json`'s mtime (02:30 that day) confirms the run really did write
  to the live profile, not a copy.

No tier claim may cite this run, for the passes or the failures. Fixing the
harness (isolate `$HOME`, rebuild a fresh engine before driving) is phase-3
work; until then, a clean darwin-arm64 floor drive has simply never been
done.

What that run recorded, written down so nobody re-discovers it — **NOT
evidence**, in either direction. These rows are below the `##` heading, so
`floorCoverage()` cannot see them; note that the B4 `fail` postdates the B4
`pass` in the table above, so a section-blind parser plus latest-wins would let
a disqualified run silently revoke coverage the ledger legitimately holds. That
is exactly what the section-aware parse prevents.

| date | run-target | row | engine | bundle | verdict | note |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-08-04 | darwin-arm64 | B4 | quaude | 2.1.218 | fail | CONTAMINATED — stale engine + live $HOME (Write/Grep) |
| 2026-08-04 | darwin-arm64 | H1 | quaude | 2.1.218 | fail | CONTAMINATED — multi-turn |
| 2026-08-04 | darwin-arm64 | H4 | quaude | 2.1.218 | fail | CONTAMINATED — PreToolUse hook |
| 2026-08-04 | darwin-arm64 | H6 | quaude | 2.1.218 | fail | CONTAMINATED — subagent/Task dispatch |
| 2026-08-04 | darwin-arm64 | F2 | quaude | 2.1.218 | fail | CONTAMINATED — Bash/Edit round-trip (real ~/.claude.json lock contention in the captured stderr) |
| 2026-08-04 | darwin-arm64 | H3 | quaude | 2.1.218 | pass | CONTAMINATED — --continue; a pass from a contaminated run is not evidence either |
| 2026-08-04 | darwin-arm64 | H7 | quaude | 2.1.218 | pass | CONTAMINATED — Workflow completion; same |

## F3 is unrunnable as written — its repro no longer exists upstream (2026-09-22)

An F3 drive was attempted on netbsd-arm64 and darwin-arm64 and produced **no row**,
deliberately. Written down so the next person does not spend the same hour.

RECIPE F3 is "a finished `/login`/`/doctor` lingers; repaint does not erase prior
lines", and the committed worked example that guards it
(`test/fidelity/stale-frames.pty.test.cjs`) anchors on `/doctor` opening a full-screen
report whose footer reads **"Enter to close"**. In bundle 2.1.251 that report is gone:
`/doctor` is now a **model-dispatched skill** ("Health-check the user's Claude Code setup
and fix issues …"), so typing it and pressing Enter sends a normal turn to the model. No
full-screen frame is opened, therefore nothing can linger, therefore the assertion is
vacuous.

MEASURED, not inferred, and localized the right way round: the same probe was run
against the NATIVE 2.1.251 provider binary under the same pty, and native behaves
IDENTICALLY — `/doctor` goes to the model in both. So this is upstream changing what
`/doctor` is, not a quaude slash-dispatch divergence (H2 covers that and passes).

Two consequences, neither of them "F3 passes":

- The probe's first cut reported **PASS** here, from an `opened=true` that matched the
  word "doctor" in the completion menu. A row that cannot fail is worth less than no
  row; it was thrown away rather than recorded.
- `test/fidelity/stale-frames.pty.test.cjs` asserts `assert.match(OPEN_SCREEN, /Enter to
  close/)` BEFORE it checks the erase, so against a current bundle it should FAIL rather
  than silently pass — but it is gated behind `CLODE_LIVE_RENDER=1` on darwin and is not
  in the default suite, so nobody has seen it. Re-anchoring F3 on a full-screen surface
  that still exists (the `/doctor`-shaped one is gone) is the work; until then F3 blocks
  tier 2 on a symptom nothing can reproduce.
