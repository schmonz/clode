# clode: run Claude Code under Node

Claude Code used to `npm install` anywhere you had Node. Now it's
a binary-only distribution targeting only the most popular recent
operating systems and hardware platforms. Even older x86 (pre-AVX2)
no longer suffices.

Clode fixes this. Anywhere you have Node, run the latest Claude Code.

## Beware

Clode is a hilarious hack that will inevitably stop working. It attempts
to be reasonably robust against many failure modes, but can't possibly
defend against all of them.

If you've been wishing you could run Claude Code directly on your weird
machine, use Clode while you still can.

## Usage

Run `clode` anywhere you'd run `claude`.

On first run, it'll install its `npm` dependencies into a user-owned dir, fetch and postprocess the latest upstream, then launch it.

Updating is much the same as you're used to, modulo the postprocessing. After
each `clode update`, a warn-only *signals* digest flags anything in the new
release's notes or bundle that bears on clode's ability to keep running the JS
under Node — e.g. a bundled-Bun-runtime bump, a raised Node floor, or new
"requires the native binary" gating. It never blocks the update; in a source
checkout it also writes a reviewable `signals/<ver>.json` snapshot. Override the
notes source with `CLODE_CHANGELOG_URL` (air-gapped/testing).

clode also watches for *concerning* upgrades on its own: about once a day a launch
fires a background, changelog-only check, and if a newer Claude Code carries
signals that bear on running under Node it prints a one-line notice next time you
start. Run `clode --clode-watch` to check on demand, or set `CLODE_NO_WATCH=1` to
turn the automatic check off.

You'll have to live without:

- image/sharp
- audio capture
- computer-use
- SQLite-backed bits
- MSAL
- runtime TypeScript
- anything else from `Bun.*` that's stubbed or missing

## Installation

### Dependencies

- `node` >= 24 and `npm`
- `ugrep` >= 7.5.0, `bfs` >= 3.x (built with Oniguruma), and `rg` for fast searches

The launcher itself is a Node program (`#!/usr/bin/env node`), so it needs `node`
on `PATH` to start. An ES5-safe prologue prints a friendly "node too old" message
on an outdated node; a truly missing node yields `env: node: not found`.

Once you have those:

```sh
npm pack
sudo npm install -g ./clode-*.tgz
```

To remove:

```sh
sudo npm uninstall -g clode
rm -rf "${XDG_CACHE_HOME:-$HOME/.cache}/clode"
rm -rf "${XDG_DATA_HOME:-$HOME/.local/share}/clode"
```

## Development

### Test dependencies

- `node` >= 24 and `npm` (same as running clode)
- `bats`
- on Linux (and anywhere `node-pty` has no prebuilt binary): a C/C++ toolchain
  to compile it — `python3`, `make`, and a C++ compiler (`g++`/`clang++`). These
  are the standard `node-gyp` build deps.

The PTY/TUI tests drive clode under a pseudo-terminal via `node-pty` +
`@xterm/headless`. Those are declared in a separate `test/package.json` and
install into `test/node_modules`; `npm test` installs them automatically on first
run (or run `npm install --prefix test` yourself). These tests are **not
optional** — the suite fails loudly rather than skipping if the harness can't
load.

> **First install compiles `node-pty` and can take a few minutes.** `node-pty`
> ships prebuilt binaries only for macOS and Windows; on **Linux** there is no
> prebuild, so `npm install` compiles it from source with `node-gyp` (hence the
> toolchain above). The very first build also downloads the Node C++ headers for
> your Node version, so it may sit "quiet" for a while — it is not hung. Later
> installs reuse the cached headers and finish in seconds.
>
> If you install with a package manager that blocks dependency build scripts by
> default (e.g. **pnpm** or **bun**), the compile is skipped and `node-pty` loads
> with "no prebuilt binary"; approve its build script first (pnpm:
> `pnpm approve-builds`, or add it to `onlyBuiltDependencies`; bun:
> `trustedDependencies`). Plain `npm` runs the build script without prompting.

> **A bare `npm install` at the repo root is tolerated, but unnecessary.** The
> "fail-loud" tests (which assert clode dies with a clear message when a runtime dep
> like `ws`/`yaml`/`semver` is absent) are now isolated from the repo's own
> `node_modules` — they run their shim children from a temp copy outside the repo
> tree — so a populated root `node_modules` no longer makes them pass vacuously. You
> still don't need one: runtime deps install into a user-owned dir at runtime, and
> test-harness deps live under `test/`.

Run the whole suite:

```sh
npm test               # offline suite (default; no network or login needed)
npm run test:online    # also run the network/model tests (needs a logged-in ~/.claude)
```

Run a subset directly (install the harness first — only `npm test` auto-installs it):

```sh
npm install --prefix test     # once, for the PTY/TUI tests
node --test test/*.test.cjs   # JS unit, module, and differential tests
bats test/                    # launcher + integration tests
```
