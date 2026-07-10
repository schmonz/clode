# Phase 3 · NetBSD/aarch64 scorecard — clode-under-tjs at HEAD (bundle 2.1.204), mock-only

**Status (2026-07-09): PASSING 7/7 after one root-caused retry.** The CURRENT
clode-under-tjs stack — bundle **2.1.204**, all nine committed patches
(phase-2 set + `txiki-spawn-fail-uaf`, `txiki-spawn-inherit-fd`,
`txiki-stream-write-sync-number`), current `bun-shim.cjs` + `node-shim` —
built and ran inside the **NetBSD 10.1/evbarm-aarch64 qemu guest** (HVF,
phase-2 M4 machinery) against **host-side mock Anthropic servers only** (no
credentials, no Keychain, no live API). Both the plain `-p 'say PONG'`
round-trip and the **agentic Bash tool round-trip** (tool_use → real command
execution → tool_result with the command's stdout inline → final turn)
completed with exit 0 and host-side wire-level verification.

**Run 1 surfaced one real portability wall** (Bash tool shell discovery
rejects a base NetBSD install — see "Walls"); the authorized retry with
pkgsrc bash closed it. Each guest run (boot → pkg_add → payload fetch → full
in-guest tjs build → 5 probes → halt) took **≈2–3 minutes** wall-clock,
driver exit 0 both times.

## Scorecard

| # | Probe | Result | Evidence (verbatim, run 2 unless noted) |
|---|---|---|---|
| 1 | in-guest tjs build (gcc12, `-Werror` stripped, mimalloc OFF, WASM OFF) | **PASS** (both runs) | `[100%] Built target tjs-cli` → `p3-build-exit=0`; 301 C + 1 CXX objects, zero errors |
| 2 | engine sanity: sync-spawn + sync-fs globals | **PASS** | `spawn_sync: function fs_sync: object` → `p3-engine-exit=0` |
| 3 | v-flag regexp downgrade path (bcf53eb): `string-width` under the loader | **PASS** | `string-width-abc=3 string-width-cjk=2` / `vflag OK` → `p3-vflag-exit=0` |
| 4 | asyncDispose FileHandle tail-reader (Uyn repro: `await using` + stat + positioned read) | **PASS** | `uyn size=16 bytesRead=6 got=ABCDEF` / `uyn OK` → `p3-uyn-exit=0` |
| 5 | mock PONG round-trip (bundle 2.1.204, port A) | **PASS** (both runs) | `PONG` → `p3-pong-exit=0`; host log: guest POST `/v1/messages?beta=true` carrying `say PONG` |
| 6 | agentic LOOP plumbing (tool_use dispatched → Bash tool invoked → tool_result POSTed → final turn) | **PASS** (both runs) | `TOOLDONE` → `p3-agentic-exit=0`; port-B log: 3 POSTs (side-call, main turn, follow-up with `tool_result`) |
| 7 | agentic Bash EXECUTION (tool_result carries the command's real stdout inline) | **FAIL run 1 → root-caused → PASS run 2** | run 2 tool_result: `content: "AGENTIC-MARKER-NB64"`, `is_error: False`, no `bash output unavailable`, no `Output too large` |

Host-side wire assertion (run 2, from the recorded port-B request log):

```
tool_result id: toolu_mock_bash_nb64 is_error: False
content: "AGENTIC-MARKER-NB64"
ASSERTIONS PASS: marker inline, no is_error, no degradation
```

## Walls hit, each root-caused

### 1. Bash tool shell discovery rejects a base NetBSD install (run 1) — REAL clode portability finding

Run 1's agentic probe printed `TOOLDONE` and exited 0 **but was a false pass**:
the recorded tool_result was

```
is_error: True
content: "No suitable shell found. Claude CLI requires a Posix shell
environment. Please ensure you have a valid shell installed and the SHELL
environment variable set."
```

Root cause, read from the extracted 2.1.204 bundle (`jsg()` near the error
string, offset ≈7,506,214 in `cli.cjs`): shell discovery only ever accepts a
path whose **name contains `bash` or `zsh`** —
`CLAUDE_CODE_SHELL`/`$SHELL` are filtered by
`e.includes("bash")||e.includes("zsh")` *before* any exec check, then
`which zsh`/`which bash` and the fixed dirs `/bin`, `/usr/bin`,
`/usr/local/bin`, `/opt/homebrew/bin` are searched. NetBSD base ships
`/bin/sh` (and ksh/csh) only, and the anita serial-console environment leaves
`SHELL` unset — so **the Bash tool cannot work on a minimal NetBSD host at
all**, and `SHELL=/bin/sh` cannot fix it even though the generated command
strings are plain-POSIX compatible in the trivial case. Portability datum
for clode: **minimal-BSD hosts need a bash/zsh story** (pkgsrc bash, or an
upstream-facing request to admit posix sh).

Fix (retry run): `bash-5.3.9.tgz` (no dependencies) added to the local pkg
mirror + driver `--pkgs`, and the agentic oracle runs with
`SHELL=/usr/pkg/bin/bash`. Run 2's tool_result carries the marker inline,
`is_error` false.

**Methodology note (why run 1 initially looked green):** the guest-side exit
code and a body-wide grep for the marker are both insufficient oracles — the
scripted mock answers TOOLDONE regardless, and the marker string appears in
the conversation history (the assistant's tool_use *input*) even when the
tool fails. The assertion must target the `tool_result` block's `content`
field and `is_error` specifically, exactly as `test/node-shim-agentic.test.cjs`
does host-side.

### 2. Vendor checkout was missing the quickjs-ng js_exepath patch (pre-run verification)

Pre-flight patch audit of `spike/quickjs/vendor/txiki.js` found 8/9 patches
present; `quickjs-ng-js_exepath-netbsd.patch` was absent from
`deps/quickjs/cutils.h` (it targets the quickjs-ng tree, which
`build-tjs.mjs` doesn't re-patch inside the txiki submodule). Applied with
GNU `patch -p1 --forward` from `deps/quickjs/` (both hunks clean) before
staging. `stage-p3.sh` now greps a distinctive line from **all nine** patches
(including `KERN_PROC_PATHNAME` in `deps/quickjs/cutils.h`) before tarring.

### 3. Host-only scratch dirs ballooned the txiki tarball (staging, host-side)

Since M4, the vendor checkout grew `build-asan/` (241MB, the spawn-fail-UAF
ASAN hunt), `website/` (279MB) and `node_modules/` (68MB) — none read by the
guest build. The first staging attempt was headed past 500MB compressed on
this NFS mount; `stage-p3.sh` excludes all three (final tarball 77MB, guest
fetch 26 MB/s ≈ 3s).

Walls that were pre-planned and never bit: AppleDouble/xattr tarball
poisoning (`--no-xattrs` discipline kept; hygiene greps 0), slirp IPv6-first
DNS (irrelevant — only 10.0.2.2 is dialed), C-stack headroom
(`ulimit -s 16384` applied), gcc12/mimalloc/-Werror/wasm walls (same
pre-closed workarounds as M4, all held).

## Re-run 2026-07-09 (~21:31–21:38 EDT): THE WURL FLIP — 7/7 again

Re-ran as the aarch64 oracle for making wurl the default URL parser
(`-DTJS_USE_ADA=OFF`, now passed by both `scripts/build-tjs.mjs` and
`guest-p3.sh`; `txiki-wurl-url.patch` in the tarball). Same machinery, same
mock-only discipline. Evidence appended to `vendor/aarch64-p3-console.log`
(the driver appends; the new run starts near line ~1470): guest cmake
configure shows `-DTJS_USE_ADA=OFF`, `libwurl.a` built at [5%], and all six
guest markers `p3-{build,engine,vflag,uyn,pong,agentic}-exit=0` +
`GUEST-DONE`; host-side seventh probe verified in the port-B request log
(`tool_result` content `AGENTIC-MARKER-NB64`, `is_error:false`). PONG and
TOOLDONE both rendered. Notably the C++20/gcc12 requirement is now only
build parity, not a hard need — ada is out of the default link.

## How to reproduce

```sh
# 0. one-time: verify/apply the 9 patches in spike/quickjs/vendor/txiki.js
#    (GNU patch -p1 --forward; the quickjs-ng one applies inside deps/quickjs)
# 1. payload (no Keychain, no credentials):
sh spike/quickjs/qemu/stage-p3.sh
# 2. mock servers (host, loopback; write p3-ports.env after binding):
#    port A: cannedSSE('PONG') for every /messages POST
#    port B: body.includes(TOOL_ID) ? cannedSSE('TOOLDONE')
#            : cannedToolUseSSE('Bash', {command:'echo AGENTIC-MARKER-NB64'}, TOOL_ID)
#    (reuse test/mock-anthropic-helper.cjs builders; log every request body
#    to JSONL; write PORT_A/PORT_B to spike/quickjs/vendor/dist/p3-ports.env)
# 3. file server + guest run:
python3 -m http.server 8080 --bind 127.0.0.1 --directory spike/quickjs &
spike/quickjs/vendor/venv/bin/python spike/quickjs/qemu/run-in-guest.py \
  evbarm-aarch64 /private/tmp/qemu-anita/anita-aarch64 \
  "$PWD/spike/quickjs/vendor/aarch64-p3-console.log" \
  --script guest-p3.sh --pkgs 'cmake gmake libffi gcc12 bash'
# 4. afterwards: assert the tool_result block (content == marker, is_error
#    falsy) in the port-B JSONL; kill both servers.
```

Run detached (`nohup … & disown`) per the RUNBOOK; boots are `snapshot=on`,
so every run redoes pkg_add + build from the pristine installed image.
`bash-5.3.9.tgz` must be present in `vendor/dist/pkgs/aarch64/` (no deps).

## Evidence (verbatim from `vendor/aarch64-p3-console.log`, run 2, 2026-07-09 ~04:05–04:08 EDT)

```
+ echo p3-build-exit=0
p3-build-exit=0
+ ./txiki.js/build/tjs eval 'const a=typeof __tjs_spawn_sync, b=typeof __tjs_fs_sync; ...'
spawn_sync: function fs_sync: object
p3-engine-exit=0
+ NODE_PATH=/root/p3work/node_modules /usr/bin/timeout 120 ./txiki.js/build/tjs run /root/p3work/node-shim/loader.cjs /root/p3work/probes.cjs sw
string-width-abc=3 string-width-cjk=2
vflag OK
p3-vflag-exit=0
+ NODE_PATH=/root/p3work/node_modules /usr/bin/timeout 120 ./txiki.js/build/tjs run /root/p3work/node-shim/loader.cjs /root/p3work/probes.cjs uyn
uyn size=16 bytesRead=6 got=ABCDEF
uyn OK
p3-uyn-exit=0
+ NODE_PATH=... TERM=vt100 ANTHROPIC_BASE_URL='http://10.0.2.2:49526' ANTHROPIC_API_KEY=sk-ant-mock /usr/bin/timeout 300 ./txiki.js/build/tjs run .../loader.cjs .../cli.cjs -p 'say PONG' </dev/null
PONG
p3-pong-exit=0
+ NODE_PATH=... TERM=vt100 SHELL=/usr/pkg/bin/bash ANTHROPIC_BASE_URL='http://10.0.2.2:49527' ANTHROPIC_API_KEY=sk-ant-mock /usr/bin/timeout 300 ./txiki.js/build/tjs run .../loader.cjs .../cli.cjs -p 'run the command' --allowedTools Bash </dev/null
TOOLDONE
p3-agentic-exit=0
=== GUEST-DONE ===
=== DRIVER-EXIT 0: sh /tmp/gb.sh ===
```

## Timing

| Run | Launched (EDT) | Guest halt | Driver exit | Wall-clock |
|---|---|---|---|---|
| 1 (shell-discovery FAIL on probe 7) | 03:58:08 | 04:00:18 | 04:00:2x, exit 0 | ≈2m10s |
| 2 (retry with pkgsrc bash) | 04:05:10 | 04:07:15 | 04:07:59, exit 0 | ≈2m50s |

Dramatically faster than M4's recorded ≈21 min on the same machinery. Not
re-investigated; contributing deltas: the txiki tarball slimmed to 77MB
(§Wall 3 — M4-era staging shipped whatever the checkout held), mock API
instead of three live TUI oracles, and host load at M4 time. The build is
genuinely full (fresh snapshot boot, 300+ objects compiled by gcc12 at
`-j2` under HVF).

## Divergences vs the darwin control (all deliberate, all recorded)

Same table as `phase2-m4-netbsd-aarch64.md` (gcc12, -Werror stripped,
mimalloc OFF, WASM OFF, `/bin/sh`-only base), plus:

| Axis | darwin | NetBSD guest (this run) |
|---|---|---|
| API endpoint | mock on 127.0.0.1 (host tests) | same mocks via slirp 10.0.2.2 |
| Auth | none needed (mock) | none needed (mock; NO credential file staged) |
| Bash tool shell | /bin/zsh (system) | **pkgsrc bash-5.3.9 + `SHELL=/usr/pkg/bin/bash`** (base NetBSD has no bash/zsh) |
| Source | 8 txiki patches | + quickjs-ng js_exepath in `deps/quickjs` (9 total, all verified pre-tar) |

## Residuals / follow-ups

- **Shell-discovery portability finding** (Wall 1) is a clode-level datum:
  document/handle the bash-or-zsh-by-name requirement for minimal-BSD hosts
  (pkgsrc bash dependency, or upstream request to accept posix sh).
- The false-pass hazard (guest exit code + body-wide marker grep) is now
  documented here and in `guest-p3.sh`; any future guest agentic oracle must
  assert the tool_result block host-side.
- The latent darwin fd-race oracle note from M4 still applies: re-run this
  recipe on bundle bumps or tjs/libuv re-pins.
- Host smoke control (same bundle, host tjs, same mocks, before the guest
  runs): PONG exit 0 and tool_result `content:"AGENTIC-MARKER-NB64"`,
  `is_error:False` — so probe 7's run-1 failure was guest-environment-specific
  from the outset.

## Pointers

- Console logs: `spike/quickjs/vendor/aarch64-p3-console.log` (run 2, passing)
  and `.run1` (shell-discovery failure) — uncommitted scratch.
- Mock request logs (wire evidence): `spike/quickjs/vendor/p3-mock-{a-pong,b-agentic}.requests.run{1,2}.jsonl`.
- Scripts: `spike/quickjs/qemu/{stage-p3.sh,guest-p3.sh,probes.cjs,run-in-guest.py}`;
  mock server script was session scratch (recipe in "How to reproduce").
- Prior rungs: `results/phase2-m4-netbsd-aarch64.md` (live-subscription M4),
  `results/gate3-netbsd-aarch64.md` (phase-1 bring-up), `qemu/RUNBOOK.md`.
