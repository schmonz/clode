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
- `python` >= 3 for the extractor (hey, maybe we should do that in JavaScript!)

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

- `bats`
- `pytest`
- `pyte`

Once you have those:

```sh
npm test               # offline suite (default; no network or login needed)
npm run test:online    # also run the network/model tests (needs a logged-in ~/.claude)
```
