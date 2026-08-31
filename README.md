# clode: Claude Code, everywhere

When your OS isn't popular or your computer isn't recent, how do you run Claude Code?

[Download clode](https://github.com/schmonz/clode/releases/latest/) to your fastest machine, then build `quaude`s for your whole collection:

```sh
mv clode-* clode && chmod +x clode
./clode build --list-targets
for i in macos-arm64 windows-amd64 macos-ppc netbsd-sparc linux-s390x; do
  ./clode --verbose build --target $i --out quaude-$i
done
```

`quaude-macos-arm64` and `quaude-windows-amd64` might not be that interesting. Claude Code already ships for those platforms. But `quaude-macos-ppc`, `quaude-netbsd-sparc`, `quaude-linux-s390x`?

Have fun.

## What? How?!?

This repo contains no Anthropic code, only a tool that, by request:

1. Fetches upstream `claude` (nearest match for your target OS and arch)
2. Extracts its embedded JavaScript
3. Rebases Bun-specific calls onto Node equivalents
4. Backs Node API with (mostly) [txiki.js](https://txikijs.org)
5. Compiles to [QuickJS-NG](https://quickjs-ng.github.io/quickjs/) bytecode
6. Writes `quaude`

(If your host is Node-compatible and you want that runtime instead,
`clode build --naude` writes `naude`, replacing steps 4 and 5 with an embedded Node interpreter.)

## Runtime dependencies

For day-to-day `quaude` tool use:

- `bash`
- `bfs` >= 3.x (built with Oniguruma)
- `ugrep` >= 7.5.0

For `clode fetch` to verify and extract `claude`:

- `sha256` (or `sha256sum`, `shasum`, `gsha256sum`, `cksum`, `openssl`, or `digest`)
- `tar`
- `gzip`
- `unzip`

For `clode build` to extract embedded assets that are compressed in `claude` 2.1.251 and up:

- `zstd` (or `unzstd` or `zstdcat`)

## Updating `quaude`

Run `clode fetch` and `clode build` again.

## Updating `clode`

Manually [download latest clode](https://github.com/schmonz/clode/releases/latest/).

## Beware

Some features are at least temporarily missing: computer-use,
image/sharp, audio capture, runtime TypeScript, MSAL, and perhaps
other `Bun.*` stubs.

`clode` is a hilarious hack that will inevitably stop working. It
attempts to be reasonably robust against many failure modes, but
can't possibly defend against all of them. Run `quaude` on your
weird computer while you still can.
