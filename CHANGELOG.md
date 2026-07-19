# Changelog

## 0.20260719.1

`clode fetch` now downloads the upstream build that matches your
platform (it was always grabbing the Linux x64 one), and verifies it
with your system's own sha256 tool instead of a slow pure-JS one — no
more apparent hang.

Fix editing and overwriting existing files in `quaude` (they were
failing outright).

Fix building `quaude` on Intel Macs.

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
