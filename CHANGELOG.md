# Changelog

## 0.20260830.1

Tested with Claude Code 2.1.251.

Claude Code 2.1.251 compresses the files it embeds. `clode` now unpacks them, which means it can build from current Claude Code again — every target was broken by this, on every platform. Unpacking happens while building, so the binary you get needs nothing new at runtime; `clode build` itself now needs `zstd` (or `unzstd`/`zstdcat`, or `CLODE_ZSTD` pointing at one). Not every system ships one, and `clode` names each candidate it tried if it cannot find any.

- Fix building from Claude Code 2.1.251 and newer
- Include the chart, diagram, and syntax-highlighting files that were missing from every build ever made — they are read only when something renders, so nothing noticed
- Fix `clode build --naude`, which could not build from 2.1.243 or newer
- Fix `not a function` when editing an existing file, in the Node SEA build
- Fix finding host tools on Windows, where every lookup silently answered "no"
- Fix building on NetBSD/sparc, which shipped an engine missing part of itself
- Fix building on Haiku, which had no unpacker installed
- Implement `util.getSystemErrorName`
- Record which platform's Claude Code a binary was built from, and print it in `--quaude-attest`
- Refuse to build a target that would be missing embedded files, instead of discovering it on the first turn

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
