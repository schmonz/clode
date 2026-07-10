# clode: Claude Code, everywhere

Claude Code ships as a binary-only distribution for a handful of popular
platforms. clode re-bases it onto a small C runtime — txiki.js/QuickJS —
and takes it everywhere else: macOS, musl-static Linux across eight
architectures (x64 to s390x to loongarch64), NetBSD, FreeBSD, OpenBSD,
DragonFly, OmniOS, Solaris — with more (Haiku, MidnightBSD, OpenIndiana,
the BSDs on arm64) in the pipeline.

Two pieces:

- **clode** — the builder: one self-contained native binary per platform,
  needing no Node, no npm, nothing else on disk. The only thing we publish.
- **quaude** — the product it makes: the current Claude Code bundle,
  compiled to QuickJS bytecode and fused with a node-compatibility runtime
  into one native executable. Derived work: you fuse it locally, and it is
  never distributed.

## Usage

Grab `clode-<version>-<platform>` from Releases, then:

```sh
./clode-0.1.2-netbsd-amd64 build   # fetch + extract + fuse -> ./quaude
./quaude                           # run it like `claude`
```

Every fuse self-verifies before reporting success: an offline canned
Messages round-trip plus `--quaude-attest` manifest verification. `clode
build` extracts from a Claude Code provider bundle — it finds an
npm-installed one, or point `CLODE_CLAUDE_BIN` at it.

The classic mode still works: with Node >= 24 on `PATH`, `clode` launches
the extracted bundle directly under your host Node, anywhere you'd run
`claude`. `clode update` keeps it current, and a daily changelog watch
warns when an upstream change threatens the hack (`clode --clode-watch` on
demand; `CLODE_NO_WATCH=1` off).

Either way you'll live without: image/sharp, audio capture, computer-use,
SQLite-backed bits, MSAL, runtime TypeScript, and anything else from
`Bun.*` that's stubbed or missing.

## Beware

clode is a hilarious hack that will inevitably stop working. It attempts
to be reasonably robust against many failure modes, but can't possibly
defend against all of them.

If you've been wishing you could run Claude Code directly on your weird
machine, use clode while you still can.

## Installation

From Releases: download, `chmod +x`, done. `SHA256SUMS` covers the native
builders; every binary carries a SLSA provenance attestation
(`gh attestation verify <file> --repo <owner/repo>`).

For the classic Node-launcher mode instead:

- `node` >= 24 and `npm` (>= 20 suffices for `clode build` alone)
- `ugrep` >= 7.5.0, `bfs` >= 3.x (built with Oniguruma), and `rg` for fast
  searches

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

```sh
npm test               # offline suite (default; no network or login needed)
npm run test:online    # also the network/model tests (needs a logged-in ~/.claude)
```

The PTY/TUI tests drive clode under a pseudo-terminal; the harness
self-installs into `test/.harness/<platform-tag>/` on first run. On Linux
that first run compiles `node-pty` from source (needs `python3`, `make`, a
C++ compiler) and can sit quiet for a few minutes — it is not hung.

Building the pieces from source:

- `node scripts/build-tjs.mjs` — the pinned, patched txiki.js runtime
  (`build/tjs/tjs`). Pins in `spike/quickjs/PINS.md`; portability fixups
  apply themselves with content verification.
- `clode build --self` — fuse the native builder itself (embeds the
  esbuilt launcher from `node scripts/build-sea.mjs --bundle-only` and the
  pristine tjs template, so the result needs nothing on disk).
- `node scripts/build-sea.mjs` — the transitional single-file
  [Node SEA](https://nodejs.org/api/single-executable-applications.html)
  (the `-node`-tagged release assets; Windows's only path today). Run it
  with an official, non-stripped Node >= 24 — the SEA embeds whichever
  `node` runs the script, and a stripped or non-system-lib node produces a
  broken or non-portable binary.
