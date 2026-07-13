# NetBSD/sparc CI images (rolling `ci-images` pre-release)

Two zstd-compressed qemu disk images back the `netbsd-sparc` matrix leg's
own-qemu backend:

- **`wd0-baked-10.1-gmake-cmake.img.zst`** (304 MiB) — NetBSD 10.1/sparc
  (qemu `sun4m` SS-20) with `gmake` 4.4.1 and `cmake` 3.28.6 already built and
  installed. Used **only** for the cache-miss engine bake, where having the
  toolchain preinstalled avoids re-building it under TCG emulation.
- **`wd0-pristine-10.1.img.zst`** (191 MiB) — the clean NetBSD 10.1/sparc
  anita install, no toolchain. Used for the per-run TCG runtime smoke.

Both are published as assets on the rolling `ci-images` GitHub pre-release
(not tied to a product version — it's a durable home for large, derived CI
inputs). The `netbsd-sparc` leg's own-qemu backend fetches the needed asset
at run time and verifies it by sha256 against the pins committed in
`spike/quickjs/qemu/sparc-images.sha256`. Provenance lives in this commit,
not in the release itself.

The images themselves are **not committed to git** — they're large and fully
rebuildable from official media plus the bake scripts.

## Provenance / how to rebuild

Both images are derived from official NetBSD 10.1/sparc install media via
`spike/quickjs/qemu/guest-sparc-bake*.sh`. The baked image additionally runs
the gmake/cmake build step baked into that script. Full rebuild from scratch
is TCG-emulated sparc, so budget roughly **9 hours** end to end.

Each compresses from an 8.0 GiB raw disk down to its published size via
`zstd`. To restore a fetched asset back to a bootable raw image:

```
zstd -d <file>.zst -o wd0.img
```

Baked 2026-07-09; current pins are in `spike/quickjs/qemu/sparc-images.sha256`.
