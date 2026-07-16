# clode: Claude Code, everywhere

Claude Code ships binaries for a handful of popular platforms. What about everyone else?

This repo, that's what.

[Download `clode` for your system](https://github.com/schmonz/clode/releases/latest),
then run `clode fetch` and `clode build` to:

1. Fetch upstream `claude` (Linux-x64, not that it matters)
2. Extract its embedded JavaScript
3. Rebase Bun-specific calls onto Node equivalents
4. Back Node API with (mostly) [txiki.js](https://txikijs.org)
5. Compile to [QuickJS-NG](https://quickjs-ng.github.io/quickjs/) bytecode
6. Write native `quaude`

`quaude` is `claude` under QuickJS. Run it on your weird computer. Have fun.

(If your computer's Node-compatible and you want that runtime instead,
`clode build --naude` writes `naude`, skipping steps 4 and 5.)

## Runtime dependencies

- `bash` for basic tool use
- `bfs` >= 3.x (built with Oniguruma)
- `ugrep` >= 7.5.0
- `rg`

## Updating

Run `clode fetch` and `clode build` again.

## Beware

Some features are at least temporarily missing: computer-use,
image/sharp, audio capture, runtime TypeScript, MSAL, and perhaps
other `Bun.*` stubs.

`clode` is a hilarious hack that will inevitably stop working. It
attempts to be reasonably robust against many failure modes, but
can't possibly defend against all of them. Run `quaude` on your
weird computer while you still can.
