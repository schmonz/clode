# clode — run the latest Claude Code under Node

Run the latest Claude Code on any platform where Node runs.

## Use it

Install `clode` (see [Install](#install) below), then run it the same way you
would run `claude`:

```sh
clode                       # interactive TUI
clode -p 'hello'            # non-interactive
clode --version
```

All args pass straight through (`--settings`, `--mcp-config`, etc.).

To update Claude Code, run `claude update` inside the TUI (or from `claude`
directly) as you normally would. clode picks up the new version automatically
on next launch — no extra steps needed.

Our command is always **`clode`**. We never install, name, or replace anything
called `claude`.

## Why

Claude Code used to run anywhere Node runs. It now ships as a
[Bun](https://bun.sh) `--compile` standalone binary that targets only a few
popular modern platforms: the Bun runtime requires AVX2 on x86 and is not
available for non-x86 architectures or for systems such as NetBSD/pkgsrc.

clode carves the plain-text JS application bundle out of that binary and runs
it under the host's Node, with a small `Bun` global shim. Because the extracted
bundle is architecture- and OS-independent JS, the same approach works on
no-AVX2 x86, non-x86 arches, and non-macOS platforms.

> On a box where the **native** binary runs fine (modern arm64/x86 macOS or
> Linux), keep using `claude` — native is faster and full-featured. clode is for
> the machines where native can't run.

## Install

### From a package

clode is packaged for system package managers (AUR, Debian, pkgsrc). The
package installs the clode toolset and depends on a provider package that
supplies the upstream `claude` binary. clode extracts the bundle on first run,
caches it under `~/.cache/clode`, and re-extracts automatically when the
provider updates the binary.

### From source

```sh
make install PREFIX=/usr/local              # honors DESTDIR, BINDIR, LIBEXECDIR, MANDIR
make install PREFIX=/usr CLAUDE_BIN=/usr/bin/claude   # bake a provider path
make dist                                   # clode-<version>.tar.gz (source only)
```

The launcher finds its helper files under `LIBEXECDIR/clode` and the upstream
binary by precedence (`CLODE_CLAUDE_BIN`, a baked provider path,
`~/.local/bin/claude`, `claude` on `PATH`).

## How it works

**Extractor (`libexec/extract-claude-js`)** — finds the `@bun-cjs` entry module
inside the binary's `__BUN` segment by module name, strips Bun's CJS wrapper,
rewrites `import.meta`, injects a clode *search-applet version skew* section into
the `/doctor` screen (anchored on a stable string, fail-loud if it drifts), and
prepends a prelude that installs the `Bun` global shim. Output is plain CommonJS.

**Shim (`libexec/bun-shim.cjs`)** — a `Bun` global for Node: text/hash/spawn/which/semver
and friends, a `Module._load` hook resolving `bun:ffi` and external npm modules
the bundle `require()`s (e.g. `ws`), and a `node:fs` `readSync({length})` compat
shim. Because the extracted bundle is plain JS, Node is the host today — and
other modern JS runtimes are a possible future host.

**Launcher (`bin/clode`)** — resolves the version the updater linked at
`~/.local/bin/claude`, extracts and caches `<version>/cli.cjs` on first use,
then runs it under Node in a clean environment. A new provider version
auto-extracts on next launch. It also sets `DISABLE_INSTALLATION_CHECKS=1`
(override to `0` to re-enable) to suppress false-positive "installed via npm"
notices that don't apply to a non-native install.

## Keeping up with updates

Updates are transparent (extract-on-first-use, cached per version). But each
new version may use more of the Bun API. After an update, check for surface
drift with the inspector:

```sh
libexec/inspect-claude-bundle ~/.local/share/claude/versions/<ver> \
        --shim libexec/bun-shim.cjs --coverage
```

This reports every `Bun.*` member, `bun:` module, and external `require()` the
bundle uses, classified **implemented / stubbed / missing**, and flags anything
**UNACCOUNTED FOR** — including *MISSING external modules*, the class most likely
to **silently hang the interactive TUI** (a missing `require()` rejects in a
render-gating promise). Use `--strict` to exit nonzero on anything unaccounted
for.

`--strict` also tracks two integration anchors a Claude update could move: the
`USE_BUILTIN_RIPGREP` lever, and the `/doctor` footer string that `extract-claude-js`
patches its *search-applet version skew* section onto. If either drifts, extraction
warns loudly and skips that hook rather than failing silently — the skew check still
warns on stderr regardless — and `--strict` trips so CI catches it on the next update.

The launcher's own version check (not a hardcoded number here) is the
authoritative guard for Node compatibility.

## Limitations

- **Disabled native features** — image/sharp, audio capture, computer-use,
  SQLite-backed bits, MSAL: these are Bun-ABI native `.node` addons embedded in
  the binary and can't load under Node. They degrade gracefully.
- **WebSocket / YAML need an npm dep** — WebSocket features (Remote Control,
  MCP-over-WebSocket) and YAML frontmatter work once `ws` / `yaml` are installed;
  without them clode fails loud with an install hint rather than silently. See
  Requirements.
- **Runtime TypeScript** — `Bun.Transpiler`/`esbuild` are not provided, so
  TS-authored hooks/MCP/plugins won't transpile. JS ones work.
- Various rarely-used `Bun.*` members are stubbed or missing (see the coverage
  report).

### Old macOS: slow TLS startup

Claude Code trusts the macOS **system** certificate store by default. On legacy
macOS (the pre-`trustd` `ocspd`/CSSM trust stack) evaluating that store does
blocking per-certificate OCSP fetches and can stall startup for tens of seconds.
clode detects that stack (no `/usr/libexec/trustd`) and defaults
`CLAUDE_CODE_CERT_STORE=bundled` there, using Node's bundled Mozilla roots — fast,
and enough for `api.anthropic.com`. Override with `CLAUDE_CODE_CERT_STORE=system`
to force the system store, or add a private/corporate root with
`NODE_EXTRA_CA_CERTS=/path/to/root.pem` to keep the fast bundled path.

## Requirements

- **A recent Node** — the launcher checks the version and gives a clear error if
  it is too old. Node's minimum rises over time as Claude Code adopts newer JS;
  the launcher is always the authoritative source.
- **Python 3** — used for extraction only.
- **Search applets — `ugrep`, `bfs`, optionally `rg`** (only for Claude Code's
  Bash `grep`/`find`/`rg` commands). Upstream ships its own builds of these and
  invokes them through a multiplexer; clode reroutes that to the host applets of
  the same name (see *How it works*). They must be **recent enough to accept the
  flags Claude's bundled build uses** — an older host applet can reject a flag and
  make `grep`/`find` fail. Known floors:
    - **ugrep ≥ 7.5.0** — the bundled version; newer is fine.
    - **bfs 3.x** — needs the `findutils-default` regextype Claude's `find` shadow
      passes; bfs 1.5.x rejects it.
    - **rg** — any reasonably recent ripgrep (also used by the internal Grep tool
      via `USE_BUILTIN_RIPGREP=0`).

  These floors are guidance, **not the source of truth**: clode capability-probes
  each host applet at snapshot-refresh and warns loudly on stderr — and in Claude
  Code's `/doctor` screen, under *"search-applet version skew"* — if yours rejects
  the bundled flags. Override the resolved binary with `CLODE_UGREP`, `CLODE_BFS`,
  `CLODE_RG`. Compare host vs. embedded versions any time with
  `libexec/inspect-claude-bundle ~/.local/share/claude/versions/<ver>`.
- **`ws` (npm) — for WebSocket features only** (Remote Control / `/remote`,
  MCP-over-WebSocket). Claude Code is built for Bun's header-bearing WebSocket;
  Node's global one silently drops the auth header, so clode backs WebSockets with
  the npm [`ws`](https://www.npmjs.com/package/ws) package via a thin adapter.
  Install it with the **same Node as clode**:

  ```sh
  npm install -g ws
  ```

  clode adds the node prefix's global `node_modules` to `NODE_PATH` so a global
  install is found (or set `NODE_PATH` to any `node_modules` that has `ws`). It is
  an explicit, **fail-loud** dependency: if a WebSocket feature is used without
  `ws` installed, clode raises a clear "install `ws`" error rather than silently
  failing to connect. Everything else works without it.
- **`yaml` (npm) — for YAML frontmatter only** (skills, slash commands, agents,
  and memory files carry YAML frontmatter). Claude Code uses Bun's built-in
  `Bun.YAML`; clode backs it with the npm
  [`yaml`](https://www.npmjs.com/package/yaml) package. Install it with the **same
  Node as clode**:

  ```sh
  npm install -g yaml
  ```

  Resolved the same way as `ws` (global `node_modules` on `NODE_PATH`), and also an
  explicit, **fail-loud** dependency — but at point of use, not startup: without
  `yaml`, the first YAML operation prints a clear "install `yaml`" message and the
  affected feature degrades (that skill/command is skipped) instead of failing
  silently. Everything else works without it.

Override the host tools per machine: `CLODE_NODE`, `CLODE_PYTHON`, and
`CLODE_PATH` (the clean-env PATH; defaults to the node + python dirs plus common
tool locations).

## Tests

    make test          # offline suite (default; no network or login needed)
    make test-online   # also run the network/model tests (needs a logged-in ~/.claude)

`make test` runs the pytest, node:test, and bats suites via `test/run-all.sh`
(its single underlying runner), **offline by default**. The online tests (live
model round-trips, a logged-in `~/.claude`) are opt-in. The runner sets the
offline gate itself from the flag — you never export an env var. If your Node
isn't found, set `CLODE_NODE`. For environments without `make`:
`sh test/run-all.sh [--online]`.

## Developing

Test dependencies:

- **`bats`** — runs the shell suite (launcher, install, resolution, caching).
- **`pytest`** (Python) — runs the extractor and inspector suites.
- **a host Node** — runs the `node:test` suites (shim behavior, text formatting).
- **`pyte`** (Python) — a terminal emulator used by the pty/TUI screen tests
  (`pip install pyte`, or your platform's package). The TUI tests **skip cleanly**
  where `pyte` isn't installed rather than failing.

The suite is POSIX-portable: it relies on no GNU-only tools — not `mktemp -d`
(bare), `env -u`, or `timeout` — so it runs on \*BSD, macOS, and pkgsrc as well as
Linux. If your Node or Python isn't on the default path, set `CLODE_NODE` /
`CLODE_PYTHON`.

Running `clode` itself needs none of these — only a recent Node and Python 3.

## Uninstall

```sh
make uninstall PREFIX=/usr/local            # remove installed files
rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}/clode"   # drop the extraction cache
```

The upstream native binary and its `~/.local/bin/claude` pointer are never
modified by this project.
