# Fidelity Results

Dated rows from `RECIPE.md`, driven on the rigs in `PLATFORMS.md`. A tier claim in
`scripts/tjs-legs.mjs` must be able to point at rows here. Append, never rewrite:
a superseded result stays, with a newer row beside it.

Verdicts: `pass` | `fail` | `open` (driven, divergence recorded, not yet fixed).

| date | run-target | row | engine | bundle | verdict | note |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-07-31 | darwin-ppc | G-live | quaude | 2.1.218 | open | mock: -p exit 0, "Paris", first byte 337ms. REAL api stalls before any API request when ~/.claude/.credentials.json exists (RECIPE G6) |
| 2026-07-31 | darwin-ppc | B1 | quaude | 2.1.218 | pass | Bash outcome=ok on Tiger VM |
| 2026-07-31 | darwin-ppc | C1 | quaude | 2.1.218 | pass | Write wrote NEEDLE-TIGER-WRITE to disk |
| 2026-07-30 | cosmo-macos-aarch64 | B4 | quaude | 2.1.218 | pass | full agentic suite at parity with native tjs: mcp-ws, tools 5/5, workflow, subagent-diff |
| 2026-07-29 | cosmo-macos-aarch64 | F6 | quaude | 2.1.218 | pass | PTY differential 2/2 after the libuv tty reopen-skip fix |
| 2026-07-29 | cosmo-macos-aarch64 | D6 | quaude | 2.1.218 | pass | resize reflow 2/2 |
| 2026-07-29 | cosmo-macos-aarch64 | G-live | quaude | 2.1.218 | pass | real creds, streamed "Paris" in the interactive TUI, 2/2 |
