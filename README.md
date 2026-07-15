# clode: Claude Code, everywhere

Claude Code ships a binary for a handful of popular platforms. What about everyone else?

This repo, that's what.

[Download `clode` for your system](https://github.com/schmonz/clode/releases/latest)
and run `clode build` to:

1. Fetch an upstream `claude`
2. Extract its embedded JavaScript
3. Rebase it onto Node-compatibility APIs, mostly from [txiki.js](https://txikijs.org)
4. Compile it as [QuickJS-NG](https://quickjs-ng.github.io/quickjs/) bytecode
5. Write a native binary

That native binary is `quaude`. Run it on your weird computers. Have fun.

(Features temporarily missing from `quaude`: computer-use, image/sharp,
audio capture, runtime TypeScript, MSAL, and perhaps other `Bun.*`
stubs.)

## Beware

clode is a hilarious hack that will inevitably stop working. It attempts
to be reasonably robust against many failure modes, but can't possibly
defend against all of them.

If you've been wishing you could run `claude` directly on your weird
machine, run `quaude` while you still can.
