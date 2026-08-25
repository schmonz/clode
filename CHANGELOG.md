# Changelog

## 0.20260825.1

Build from Claude Code 2.1.243 and newer, which changed how the CLI is packaged. Earlier `clode` releases stop with "bundle format may have changed" and cannot build a target at all. This affects everyone: 2.1.245 is the current `latest`.

Upstream now ships the CLI as about 1,400 separate modules instead of one file. `clode` compiles and packages the whole set rather than carving a single file out of the binary, and the engine learned what those modules expect of it — `import.meta.require`, and an `import.meta` on every module a built target loads from its own archive. Upstream's code is compiled exactly as shipped; `clode` does not rewrite it.

`clode` now watches Claude Code's `next` channel rather than `latest`, so a packaging change like this one is visible before it reaches everybody.

Fix regression: `quaude` binaries cross-built with `clode build --target` would not start up.

Actually intercept update attempts, which we had believed we already did. A `quaude` could try to install Claude Code over itself — both on its own, and when you ran `quaude update`, which said it would not and then did.

Temporarily stop releasing for Haiku until its builder image can be updated.

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
