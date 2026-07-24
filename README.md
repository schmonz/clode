# clode: Claude Code, everywhere

When your OS isn't popular or your computer isn't recent, how do you run Claude Code?

[Download `clode`](https://github.com/schmonz/clode/releases/latest/) for your potato, then do this once:

```sh
mv clode-* clode && chmod +x clode
./clode fetch && ./clode build
```

Do this as many times as necessary until you believe it:

```sh
./quaude
```

Have fun.

## What? How'd that work?!?

This repo contains no Anthropic code, only a tool that does these things by request:

1. Fetch upstream `claude` (nearest match for your OS and arch)
2. Extract its embedded JavaScript
3. Rebase Bun-specific calls onto Node equivalents
4. Back Node API with (mostly) [txiki.js](https://txikijs.org)
5. Compile to [QuickJS-NG](https://quickjs-ng.github.io/quickjs/) bytecode
6. Write native `quaude`

(If your computer's Node-compatible and you want that runtime instead,
`clode build --naude` writes `naude`, replacing steps 4 and 5 with an embedded Node interpreter.)

## Runtime dependencies

- `bash` for basic tool use
- `bfs` >= 3.x (built with Oniguruma)
- `ugrep` >= 7.5.0

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
