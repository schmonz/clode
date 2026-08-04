# Fidelity Results

Dated rows from `RECIPE.md`, driven on the rigs in `PLATFORMS.md`. A tier claim in
`scripts/tjs-legs.mjs` must be able to point at rows here. Append, never rewrite:
a superseded result stays, with a newer row beside it.

Verdicts: `pass` | `fail` | `open` (driven, divergence recorded, not yet fixed).

| date | run-target | row | engine | bundle | verdict | note |
| --- | --- | --- | --- | --- | --- | --- |
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
