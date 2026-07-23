# Three-Engine Daily-Drive Fidelity Recipe

A prescriptive, human-run checklist that surfaces where **naude** (clode's Node
SEA build) and **quaude** (clode's tjs build) diverge from upstream **Claude**
Code in daily-drive behavior, grounded in our real failure history plus the
failures we suspect are next — structured so every row converts into an
automated regression test. It is not a precision record-and-replay
differential engine; it is "here is what bit us, here is what we suspect bites
next," runnable in one sitting, that also audits which past fixes actually
have a guarding test. See
`docs/superpowers/specs/2026-07-18-three-engine-fidelity-recipe-design.md`
for the full design. Category **J** (Remote Control / WebSocket) was added
from the 2026-07-23 remote-control fidelity work, after the original spec.

## Legend

- **→** guards a real fix (regression) — must eventually cite a live test.
- **?** probes a suspected or OPEN gap — not yet confirmed to diverge.
- `[axes]` — the cross-cutting axes this row varies on: `platform`,
  `applets` (rg/bfs/ugrep), both (comma-separated), or `-` (none / runs once).

## Localization rule

For any diverging row, run it on all three engines (Claude / naude / quaude)
and localize by where the divergence appears:

- diverges at **quaude but not naude** ⇒ the tjs **engine / node-shim**.
- diverges at **naude too** ⇒ our **SEA / build / shim-shared-with-naude**.
- **all three agree** ⇒ fidelity holds for that row.

## Row shape

Each row: `| id | action | expected | axes | test |`

- `id` — stable, category letter + number (e.g. `A1`, `C2`).
- `action` — the exact thing to do, marked `→` or `?` per the legend above.
- `expected` — the unambiguous upstream (Claude) behavior.
- `axes` — comma-set from `{platform, applets}`, or `-`.
- `test` — the guarding automated test path, or `NEW` (a conversion task for
  a later pass to fill in).

---

## A. Config & credential persistence

| id | action | expected | axes | test |
|---|---|---|---|---|
| A1 | → theme + config survive relaunch (0-byte `~/.claude.json` from the fd-form `fs.writeFileSync` bug) | config persists across relaunch | platform | test/node-shim-fs.test.cjs |
| A2 | ? credentials survive relaunch — the config-write fix likely repairs the file-based credential store (same atomic writer), UNVERIFIED; the macOS-keychain path is separate | credentials persist across relaunch | platform | NEW |
| A3 | ? per-project trust state persists (the `projects["<cwd>"]` map) | trust state persists | - | NEW |
| A4 | ? settings written mid-session (e.g. model switch) persist | mid-session setting change persists | - | NEW |

## B. Tool calls end-to-end

| id | action | expected | axes | test |
|---|---|---|---|---|
| B1 | → Bash tool runs a command and returns output (persistent-shell write-ack; tool rss baseline; numeric-fd inherit) | command output returned correctly | platform | test/node-shim-child-process.test.cjs |
| B2 | ? each tool exercised once and compared: Read, Write, Edit, Grep, Glob, Bash, WebFetch (and TodoWrite / Task where relevant) | each tool's output matches upstream | applets on Grep/Glob | NEW |
| B3 | ? a tool that writes then a tool that reads back (round-trip integrity) | write-then-read round-trips correctly | - | NEW |

## C. File I/O across sizes

| id | action | expected | axes | test |
|---|---|---|---|---|
| C1 | → write a small file (the 0-byte config class) | small file written correctly, non-zero | platform | test/node-shim-fs.test.cjs |
| C2 | → produce a large (>64 KB) tool output / write a large file (Haiku pipe deadlock class) | large output/write completes, no deadlock | platform | test/node-shim-large-output.test.cjs |
| C3 | ? read a large file (large Read output through the shim) | large file read correctly | platform | NEW |
| C4 | ? binary / non-UTF-8 content (Buffer vs Uint8Array read class) | binary content round-trips correctly | platform | NEW |

## D. Process control (quit / signals / TTY)

| id | action | expected | axes | test |
|---|---|---|---|---|
| D1 | → `/quit` exits cleanly (O_NONBLOCK sync-open wedge) | clean exit, no wedge | platform | test/node-shim-fs-nonblock.test.cjs |
| D2 | → Ctrl-Z suspends and `fg` resumes (SIGTSTP delivery) | suspend/resume works | platform | test/node-shim-ctrlz-pty.test.cjs |
| D3 | → a killed child is reported as killed, not exit 0 | killed child reported as killed | platform | test/node-shim-child-process.test.cjs |
| D4 | → `process.env` mutations reach child processes | env mutations visible to children | platform | test/node-shim-env.test.cjs |
| D5 | ? Ctrl-C interrupts a running turn/tool without corrupting the TUI | interrupt works, TUI stays coherent | platform | NEW |
| D6 | ? SIGWINCH resize reflows the TUI | TUI reflows on resize | platform | NEW |

## E. Subprocess / spawn

| id | action | expected | axes | test |
|---|---|---|---|---|
| E1 | → spawn a child that fails to launch (no UAF/SIGSEGV) | clean failure, no crash | platform | test/node-shim-child-process.test.cjs |
| E2 | ? no fd leak into sync children (CLOEXEC) | no fd leak | platform | test/node-shim-cloexec.test.cjs |
| E3 | ? a long-running / backgrounded Bash command; pipes between commands | backgrounding and pipes work | platform | NEW |
| E4 | ? `detached` semantics (dropped `opts.detached` — latent; the login opener) | detached semantics honored | - | NEW |

## F. TUI / render fidelity

| id | action | expected | axes | test |
|---|---|---|---|---|
| F1 | → the welcome box + prompt paint (the `v`-flag `\p{}` regexp bug) | welcome box + prompt paint correctly | - | test/node-shim-vflag-regex.test.cjs |
| F2 | → a full human turn stays coherent (Intl polyfill; setEncoding; child.stdin) | turn renders coherently | - | test/node-shim-agentic.test.cjs |
| F3 | ? OPEN: stale frames — a finished `/login`/`/doctor` lingers; repaint does not erase prior lines | repaint erases prior lines | - | NEW |
| F4 | ? OPEN: trust-prompt freeze under iTerm2 — keystrokes reach the read pump but the input handler does not advance the prompt | trust prompt advances on keystroke | platform: iTerm2 | NEW |
| F5 | ? wide / emoji / combining chars; bracketed paste; scrollback | renders correctly | - | NEW |

## G. Network / fetch / auth

| id | action | expected | axes | test |
|---|---|---|---|---|
| G1 | → `clode fetch` shows real progress (0-byte streaming bug) | real progress shown | - | test/clode-net.test.cjs |
| G2 | ? provider fetch + a real streaming model response render incrementally | incremental render | - | NEW |
| G3 | ? login opens a browser / prints the URL, and auth then persists (the disproven-lead login item — re-test now that config persists) | login flow completes and persists | platform | NEW |
| G4 | ? Vertex/Bedrock auth path (the once-missing `node-fetch`) | auth path works | - | NEW |

## H. Session / multi-turn / commands / hooks / MCP

| id | action | expected | axes | test |
|---|---|---|---|---|
| H1 | ? a 3-4 turn conversation stays coherent (context, tool results, edits) | conversation stays coherent | - | NEW |
| H2 | ? slash commands parse and run (`/model`, `/doctor`, `/clear`, `/resume`) | slash commands run correctly | - | NEW |
| H3 | ? `--continue` / `--resume` restore a prior session | session restores | - | NEW |
| H4 | ? a PreToolUse hook fires (dogfood: the `claude update` guard denies) | hook fires and denies | - | NEW |
| H5 | ? an MCP server connects and a tool from it is callable | MCP tool callable | - | NEW |
| H6 | ? a subagent / Task runs to completion | subagent completes | - | NEW |

## I. Update flows

| id | action | expected | axes | test |
|---|---|---|---|---|
| I1 | → self-update (rebuild callback) succeeds on all three | self-update succeeds | - | test/quaude-naude-selfupdate.test.cjs |
| I2 | → the `claude update` guard denies a model-issued update on all three | update denied | - | test/quaude-naude-updateguard.test.cjs |

## J. Remote Control / WebSocket

| id | action | expected | axes | test |
|---|---|---|---|---|
| J1 | → /remote-control connects the bridge over the engine's native WebSocket (headers + echo) | bridge connects | - | test/websocket-oracle.test.cjs |
| J2 | → readline.createInterface line-reads the bridge command channel ('line' events + async-iter) | lines delivered | - | test/node-shim-readline.test.cjs |
| J3 | → Buffer base64url decodes Remote Control work secrets | base64url round-trips | - | test/buffer-base64url.test.cjs |
| J4 | → update-guard injects --settings only for the default/model command, so subcommands (remote-control) run | subcommand parses, not "Unknown argument: --settings" | - | test/guard-gating.test.cjs |
| J5 | → SUBCOMMANDS stays honest against the bundle's registered commands | gate matches bundle | - | test/guard-subcommands-gate.test.cjs |
| J6 | ? interactive /remote-control connects and shows "is active" in the TUI | bridge active with session URL | platform | NEW |
| J7 | ? CLI remote-control spawns a session (Capacity 0/32 -> 1/32) | session spawns | - | NEW |
