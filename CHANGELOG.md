# Changelog

## 0.20260718.1

First release on date-based versioning (`0.YYYYMMDD.N`). This is a large release
— 137 commits since 0.1.3 — that reshapes what `clode` *is* and fixes several
daily-driver bugs that shipped in 0.1.3.

### Breaking changes

- **`clode` builds targets; it no longer runs Claude Code.** The runner is gone.
  `clode` now only assembles a standalone binary — a portable QuickJS/tjs
  **quaude** or a Node SEA **naude** — which *you* then run. If you were invoking
  Claude Code through `clode`, run the built binary instead.
- **Flag rename: the `--clode-` prefix is elided**, and **`watch` is now a
  subcommand triggered by `build`** rather than a standalone flag. Update any
  scripts that passed `--clode-*` options.

### New

- **`clode build --naude`** — build a **Node SEA** target alongside the tjs
  **quaude**. The shipped node-free builder fetches a pinned, sha-verified Node on
  demand (`clode fetch --naude`) and builds either target; with no host Node,
  there's no naude — plainly.
- **Self-updating targets.** A built quaude/naude updates *itself* by calling back
  into the `clode` that built it: it fetches newer Claude Code, rebuilds its own
  kind, and swaps in place (POSIX rename / Windows dance; never ships an unchanged
  binary over a failed fetch).
- **`claude update` guard.** A built target denies model-issued Claude Code
  updates/reinstalls (`claude update`, global npm installs, the curl installer) via
  a PreToolUse hook it injects into itself — so an agent can't sidestep the clode
  build path. Fails open (never breaks an unrelated command).
- **The engine default inverted: tjs is THE runtime**; `=node` is now the
  differential oracle, not the shipped path.

### Fixed (daily-driver)

- **Config now persists across launches.** 0.1.3 wrote a 0-byte `~/.claude.json`
  (the node-shim `fs.writeFileSync(fd, …)` fd-form was unsupported), so every
  quaude launch re-prompted the theme and re-login. Fixed.
- **`clode fetch` shows real progress** instead of sitting at 0 bytes: the ~240 MB
  provider download now streams to disk chunk-by-chunk with a live progress line
  (the old buffer-it-all path also OOM'd under tjs).
- A **SIGKILLed child is no longer reported as a successful exit**; **`process.env`
  mutations now propagate to child processes**; several tjs correctness fixes
  (Haiku >64 KB pipe write deadlock, Buffer vs Uint8Array reads, and more).

### Platforms

- **Expanded published NetBSD coverage.** Promoted six proven-green NetBSD cross
  builds to first-class published, release-gating artifacts:
  **sparc64, alpha, hppa, macppc, pmax, sgimips** (joining amd64, arm64, sparc,
  m68k), plus two new arches: **earmv7hf** (32-bit ARM) and **sh3el** (SuperH) —
  twelve NetBSD architectures in all. Every published platform is now locked by a
  golden-set test — it cannot silently drop from a future release.
- Windows is MSVC-native for both x64 and arm64; the Node-SEA builder is retired
  everywhere except where noted.

### Known issues

- **quaude TUI leaves stale frames** — finished output (e.g. a completed `/login`,
  a `/doctor` "queued" line) can linger; the repaint doesn't always erase prior
  lines. Non-fatal; part of the render-parity (M3) work.
- **Trust prompt can freeze under iTerm2** — keystrokes reach the read pump but the
  input handler may not advance the prompt (iTerm2-capability-reply-specific).
- **Credential persistence unverified** — the config-write fix likely also repairs
  the file-based credential store (same atomic writer), but this has not been
  confirmed end-to-end; the macOS-keychain path is separate. If login doesn't
  persist, the login URL is printed for manual re-auth.
