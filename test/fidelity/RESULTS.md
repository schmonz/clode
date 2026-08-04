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
| 2026-08-04 | darwin-arm64 | H3 | quaude | 2.1.218 | pass | agentic --continue restores session context, 20.3s (test/fidelity/agentic-tools.test.cjs) |
| 2026-08-04 | darwin-arm64 | H7 | quaude | 2.1.218 | pass | Workflow ran to completion, 15.9s (test/fidelity/agentic-workflow-complete.test.cjs) |
| 2026-08-04 | darwin-arm64 | B4 | quaude | 2.1.218 | fail | Write + Grep tool round-trips both SIGKILLed at their 120s timeout, empty stderr (test/fidelity/agentic-tools.test.cjs). ARTIFACT: build/tjs/tjs here is dated 2026-07-24 (11 days / 34 shim+engine commits behind HEAD, incl. hang fixes a06b5ea/865e98f/0d22c6a) AND the test env is non-hermetic (no HOME isolation) — product-vs-harness undetermined, needs a clean fresh-build re-run |
| 2026-08-04 | darwin-arm64 | H1 | quaude | 2.1.218 | fail | multi-turn 2-tool loop SIGKILLed at 120s, empty stderr (test/fidelity/agentic-tools.test.cjs). Same stale-engine + non-hermetic-$HOME artifact as the B4 row above |
| 2026-08-04 | darwin-arm64 | H4 | quaude | 2.1.218 | fail | PreToolUse-hook-denies-update turn SIGKILLed at 120s, empty stderr (test/fidelity/agentic-tools.test.cjs). Same stale-engine + non-hermetic-$HOME artifact |
| 2026-08-04 | darwin-arm64 | H6 | quaude | 2.1.218 | fail | naude (real node, same contaminated env) exited 0; quaude did not (105s to its 90s-budget kill) (test/fidelity/agentic-subagent-diff.test.cjs). Engine-specific signal under identical env contamination — not fully explained by the env alone; genuinely undetermined product-vs-harness, warrants a clean re-run before calling it a regression |
| 2026-08-04 | darwin-arm64 | F2 | quaude | 2.1.218 | fail | Bash round-trip SIGKILLed at 120s (empty stderr); Edit round-trip SIGKILLed at 120s WITH captured --debug-to-stderr evidence of non-hermetic startup: real ~/.claude.json lock contention with this very live authoring session, plus a live git clone of github.com/obra/superpowers.git mid-test (test/node-shim-agentic.test.cjs). HARNESS ARTIFACT: the test's env spread (`{...process.env}`) does not isolate HOME, so it ran against a real, actively-mutating operator profile, not a clean fixture |
