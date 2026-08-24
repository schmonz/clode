# Changelog

## 0.20260824.1

Cross-building works again. Every `clode build --target X` since the last release
produced a `quaude` that refused to start — it reported the wrong owner for its own
temp directory and bailed before doing any work. The published engine templates were
built before the fix for that landed, so the fault shipped with them; this release
rebuilds and republishes all forty.

`clode` now checks that a downloaded template pack was built from the same engine
sources it was built from, and refuses the pack if not. Previously it compared only a
coarse version pin, which two different builds can share — so a mismatch like the one
above could not be detected at all, and you found out when the binary would not run.

Windows builds the engine again, after five separate breakages: the bytecode compiler
would not compile, its output embedded a build-machine path, and the constants table
hit three walls in a row. A Windows `quaude` now builds and answers a round trip.

Haiku is temporarily not published. Haiku moved its package repository to the current
release when R1/beta6 shipped, and the build image we use is still beta5, so the guest
can no longer install what it needs to build. Nothing about Haiku support has been
removed — the leg still builds — and it returns as soon as a beta6 image exists.

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
