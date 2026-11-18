# Changelog

## Unreleased

The command line names what it acts on. Five spellings are **gone** — each is now a usage
error with the help under it, not a silent translation:

| was | now |
| --- | --- |
| `clode build --naude` | `clode build naude` |
| `clode build --self` | `clode bootstrap` (from a source checkout: `node scripts/stage0.mjs bootstrap`) |
| `clode fetch` | `clode fetch claude` |
| `clode fetch <channel\|version>` | `clode fetch claude <channel\|version>` |
| `clode watch` | `clode read-anthropic-tea-leaves` |

- `clode build` and `clode fetch` each take a positional saying WHAT: a **product** to build
  (`quaude`, the default, or `naude`) or an **ingredient** to fetch (`claude` or `node`).
  `clode fetch` has no default — say which ingredient.
- `--target` means one thing everywhere now: the artifact is for another machine. It no
  longer changes meaning depending on which other flag is present.
- `clode fetch node` replaces `clode fetch --naude`.
- Fix Bash commands stopping after their first `grep`, `find` or `rg`, on every platform
  (0.20260831.1 has it too): `grep -q x f && echo found; echo done` printed neither line
- Fix a false "known applet skew" warning when a skewed `grep` feeds `head`
- Fix Bash-tool `grep` and `find` running without Claude Code's own flags, on every platform
  and in every release so far: `grep` searched `.gitignore`d files and skipped hidden ones,
  and `find` lost its regex type
- (divergence) On a host whose `bfs` lacks Oniguruma (pkgsrc builds it without), `find`
  runs without Claude Code's `-regextype findutils-default`, which that `bfs` cannot read.
  A `find` using `-regex`, `-iregex` or `-regextype` refuses, with the fix, rather than
  silently reading its regex in another dialect. Every other `find` works, with the same
  results and order
- (NetBSD, and other platforms upstream does not build) Fix Write and Edit failing
- Fix `clode build` from a source checkout refusing the dependencies it had just
  installed: the dependency store is now installed from the lockfile with `npm ci`. The
  first build after upgrading reinstalls an existing store once; offline, that build
  needs npm's cache, where before it ran no npm at all
- (`quaude` only) Fix subagents (the Agent tool) never finishing when built from Claude
  Code 2.1.278 or newer: the tool answered `too many captures`, and every turn logged the
  same error and skipped Claude Code's scan of the model's text
- (`quaude` only) Faster replies on slow machines: the engine reuses a compiled regular
  expression when it is rebuilt with the same flags, instead of compiling it again
  (REGEXP-REUSE-SAME-FLAGS). Claude Code scans every reply's text with large patterns,
  one of them 1.5 million characters, and each scan compiled them again: on an emulated
  PowerPC G4 a reply now takes about 23 s less (40 s to 17 s), and 0.4 s less on
  `macos-arm64`

- Fix the Grep and Glob tools, broken in every mode in every release since Claude Code
  2.1.185: files_with_matches and count said "No files found", content mode and Glob said
  "ripgrep not found on PATH. Install it", a search outside the working directory said to
  install ripgrep, and a ripgrep on your PATH answered instead of Claude Code's. Every call
  the tools make is now answered as native Claude Code's own embedded ripgrep answers it, in
  every output mode: byte for byte on macOS arm64 and NetBSD arm64, and on Linux x64 with a
  glibc engine. The published Linux build (static musl) is checked by CI from this release
  on, and words a few error messages as musl does (`Symbolic link loop` where native says
  `Too many levels of symbolic links`). Windows is not yet measured
- The Grep and Glob tools never run a ripgrep from your PATH and never ask the model to
  install one. They search with your `ugrep` (5.0.0 or newer), on purpose: quaude decides
  each match the way ripgrep does, and a pattern it cannot decide that way is refused by
  name rather than answered differently
- `rg` typed into the Bash tool runs quaude's own tested ripgrep emulation, as native runs
  its embedded one, unless you installed a ripgrep yourself, which then runs, as in native.
  `rg --version` answers native's ripgrep version (/doctor no longer reports rg broken)
- `clode build` no longer runs your Claude Code hooks or writes into your home
  (`~/.claude.json`, `~/.claude/backups`, `~/.tjs`) while it checks the product it built
- (`quaude` only) Fix `CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR`, `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`
  and the other `*_FILE_DESCRIPTOR` credentials being refused on Linux ("not a pipe or socket")
- (`quaude` only) Fix file-identity checks that every file passed: files reported no device
  or inode, so Claude Code's checks that a file is still the one you approved, or that a git
  worktree is the one it claims, could not tell two files apart
- Fix `clode build naude` from a source checkout silently building from a stale prebuilt
  entry bundle; it now refuses and names `node scripts/build-clode-main.mjs`
- (`quaude` only, known gap) Sandboxed Bash is REFUSED, not run, until quaude supports
  Claude Code's sandbox: with `sandbox.enabled`, wherever native would sandbox, every Bash
  call is refused (`Sandbox is required but failed to initialize: quaude does not support
  the sandbox yet: net.createServer`). Before this, the first call was refused and every
  later one ran UNSANDBOXED. Native runs these commands sandboxed. Where native would not
  sandbox, quaude does as native does: it warns and runs them unsandboxed. That is
  every quaude built from Claude Code's Linux build (on Linux, and on NetBSD, Haiku and the other
  platforms built from it) where bubblewrap or socat is not on PATH, WSL1, and Windows unless
  its sandbox is switched on (`CLAUDE_CODE_NANKEEN_KESTREL`, or the server-side switch Claude
  Code has cached). Still open:
  when the sandbox is enabled, your `--settings` file is one Claude Code rejects (it skips it
  whole), and a managed-settings file or profile on the machine shuts out the settings quaude
  passes as managed, sandboxed Bash calls after the first run unsandboxed
- (`quaude` only) Your own `sandbox.failIfUnavailable: false` is overridden: with the sandbox
  enabled, quaude refuses sandboxed Bash calls even when you said to run them unsandboxed if
  the sandbox cannot start, because under quaude it never can yet
- (`quaude` and `naude`) Fix your own `--settings` (a file or inline JSON) being ignored:
  none of its permissions, hooks, environment or sandbox settings applied. It now reaches
  Claude Code unchanged, as it does natively; beside it, the update guard is a session
  plugin (`clode-update-guard`) and the sandbox requirement a parent-managed setting.
  Where managed policy may be present (always on Windows and under WSL), quaude's settings
  are also merged into yours. On a machine whose managed policy sets
  `disableSideloadFlags`, quaude given your `--settings` refuses to start, where native starts

## 0.20260831.1

Tested with Claude Code 2.1.251, including an interactive turn on `macos-arm64`.

- Teach `clode build` to recognize and unpack embedded assets that are compressed in .251 and up, relying on `zstd` or similar
- Fix `clode build --naude` on .243 and up
- (`naude` only) Fix `not a function` when editing an existing file
- Add `--clode-attest` to both `quaude` and `naude`, replacing `quaude`'s former product-named
  flag: each verifies every part of itself it can and prints the same verdict line, including
  which platform's `claude` was the source
- Include chart, diagram, and syntax-highlighting files that were mistakenly being omitted
- Fix finding host tools on Windows
- Fix incomplete engine on NetBSD/sparc
- Implement `util.getSystemErrorName`

## 0.20260827.1

Tested with Claude Code 2.1.247.

- Adjust code extraction for 2.1.243 and newer
- Fix startup when built from 2.1.238 or newer, or when cross-built
- Implement `node:http` and `node:https`
- Honor `HTTP_PROXY` and `HTTPS_PROXY`
- Fix all three MCP transports, each of which had been broken in its own way
- Fix portably assigning error codes and file-open flags
- Fix timer bug causing conversation hang after the first credentialed turn
- Fix stream writes dropping data when nothing was listening yet
- Fix `not a function` when editing an existing file
- Fix `SessionStart hook error` caused by missing execute bit on plugin hooks
- Fix `/heapdump`
- Map remaining `rg` calls to `bfs` or `ugrep` as previously intended
- Fix path handling, deep equality, and value formatting
- Reliably patch QuickJS-NG as previously intended
- Intercept `update` as previously intended

## 0.20260801.2

The engine templates are now one file. A release carries a single `templates-<pin>` blob plus its manifest instead of 38 separate engine downloads, and `clode build --target X` fetches only its own slice of it — about 2.4MB with an HTTP range request, rather than the whole 122MB.

Download that one blob yourself, point `CLODE_TEMPLATES_BLOB` at it, and `clode` cross-builds a `quaude` for any platform without touching the network. You bring `claude`, you bring the blob, and nothing is fetched behind your back.

Fixes to the release machinery: the asset gate now matches the Windows `.exe` names introduced last release, and `SHA256SUMS` covers the templates blob.

## 0.20260801.1

Add an [Actually Portable Executable](https://github.com/jart/cosmopolitan/blob/master/ape/specification.md) built with [Cosmopolitan Libc](https://github.com/jart/cosmopolitan) to run natively on Linux, macOS, Windows, NetBSD, FreeBSD, and OpenBSD on 64-bit Intel or ARM.

`clode` can now cross-build `naude` just as it does for `quaude`.

`quaude` is still not working on Mac OS X 10.4 Tiger, but it's closer.

## 0.20260727.1

Ready to be your daily driver! This release was primarily developed with `quaude` on NetBSD/aarch64.

With `clode` on your fastest machine, build `quaude`s for your whole collection:

```sh
for i in darwin-arm64 darwin-ppc netbsd-sparc linux-s390x windows-x64; do
  clode build --target $i --out quaude-$i
done
```

New platforms added: `netbsd-i386`, `netbsd-riscv64`, `netbsd-mips64eb`. For the complete list:

```sh
clode build --list-targets
```

More cross-platform behavioral fidelity with what upstream could have intended:

- Match `os.constants.signals` and `bun:ffi` to the target, instead of using macOS values unconditionally.
- Extend file-descriptor-leak fix from macOS to other platforms.
- Implement `node:vm`, fixing `/workflow`.
- Convert async DNS resolution from libwebsockets to libuv so that it's portable to older systems, such as Mac OS X 10.4 Tiger.
- Route internal `rg` calls through `ugrep` instead (Rust is insufficiently portable).
- Prevent possible session hang when a subprocess's child outlives it.
- List directories on filesystems without `d_type`, such as NFS.
- On macOS without an active GUI session, fall back to saving credentials without Keychain.

And a deliberate divergence with upstream behavior:

- Turn mouse/focus tracking off by default, to avoid overloading old machines

## 0.20260723.1

Add and run a battery of tests for behavioral fidelity with `claude`, then fix what turned up:

- Reading and writing files as streams
- Truncating files
- Copying trees

All together, `/remote-control` silently failed before and works now. Probably other things work too.

Still not ready for daily driving, but probably much closer. I'm excited to try.

## 0.20260722.1

Turns out the JavaScript we carve out of an upstream Claude binary is platform-specific after all. `clode fetch` now downloads the closest match for your platform.

Turns out pure-JS sha256 on a large file (such as an upstream Claude binary) is way too slow for comfort. `clode fetch` now calls out to your system's sha256 tool.

Fix Claude Edit and Write operations on existing files.

Fix building `quaude` on Intel Macs (at least on Mavericks; maybe newer macOS was fine).

Still not ready for daily driving, but closer.

## 0.20260718.1

Switch to date-based versioning.

Add `clode build --naude` to build `naude`, a Node-based app (instead
of `quaude`, the QuickJS-based one). Only available for platforms
where Node is available, of course.

Handle the `claude update` use cases.

Fix a bunch of fidelity bugs.

Add a bunch more NetBSD targets (alpha, earmv7hf, hppa, macppc, pmax, sh3el, sgimips, sparc64).

Build Windows natively with MSVC, for both x64 and arm64.

Not ready for daily driving, but getting closer.
