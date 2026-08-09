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
   `smokeTarget()` in `libexec/clode-fuse.cjs` starts an in-process canned
   Messages mock, runs the freshly fused quaude as `<bin> -p 'say PONG'` with
   `NODE_PATH` stripped, and requires **exit 0** *and* `PONG` in stdout *and* a
   POST that actually landed on `.../messages`. Compare RECIPE G7: "one agentic
   `-p` turn completes end to end and returns a non-empty answer — mock-anthropic
   is acceptable evidence for this floor claim", expected "`-p` turn exits 0 with
   a non-empty response". That is the same action, the same expectation, the
   same explicitly-blessed mock — run against the real shipped artifact rather
   than a loose engine. It is not a weaker cousin of G7; it *is* G7. (The
   POST-landed assertion is strictly stronger than the recipe asks for: a hung or
   silently-offline client cannot pass it.) `--quaude-attest` runs beside it and
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

| date | run-target | row | engine | bundle | verdict | note |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-08-09 | darwin-arm64 | D1 | quaude | 2.1.218 | pass | interactive pty (node-pty, canned mock): TUI booted, live turn answered TUIPONG, then /quit exited CLEANLY code 0 in 1411ms — no wedge |
| 2026-08-09 | netbsd-arm64 | D1 | quaude | 2.1.218 | pass | interactive pty over ssh -tt (guest has no node; mock served from the host): TUI booted, turn answered TUIPONG, /quit exited CLEANLY code 0 in 3490ms |
| 2026-08-09 | windows-amd64 | A1 | quaude | 2.1.218 | pass | floor-probe over ssh to real Windows (Git Bash shell, quaude cross-fused here from the cached PE32+ engine, mock served over tailnet): config non-zero, parses, onboarding + project trust survive a second launch |
| 2026-08-09 | windows-amd64 | C1 | quaude | 2.1.218 | pass | floor-probe over ssh: Write tool wrote FLOOR-WRITE-OK, 15 bytes non-zero on disk (file_path in NATIVE C:\ form via cygpath) |
| 2026-08-09 | windows-amd64 | B1 | quaude | 2.1.218 | pass | floor-probe over ssh: Bash tool_result carried FLOOR-BASH-OK back to the model |
| 2026-08-09 | windows-amd64 | G7 | quaude | 2.1.218 | pass | floor-probe over ssh: -p exit 0, PONG, POST landed on /messages |
| 2026-08-09 | netbsd-arm64 | A1 | quaude | 2.1.218 | pass | floor-probe over ssh (guest has no node; mock served from the host at 10.0.2.2): config non-zero, parses, onboarding + project trust survive a second launch |
| 2026-08-09 | netbsd-arm64 | C1 | quaude | 2.1.218 | pass | floor-probe over ssh: Write tool wrote FLOOR-WRITE-OK, 15 bytes non-zero on disk |
| 2026-08-09 | netbsd-arm64 | B1 | quaude | 2.1.218 | pass | floor-probe over ssh: Bash tool_result carried FLOOR-BASH-OK back to the model |
| 2026-08-09 | netbsd-arm64 | G7 | quaude | 2.1.218 | pass | floor-probe over ssh: -p exit 0, PONG, POST landed on /messages |
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
  HEAD on `libexec/node-shim` + `scripts/build-tjs.mjs` at the time of the
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
