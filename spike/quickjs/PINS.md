quickjs-ng v0.15.1 fd0a0210b7be00957751871e7e01b8291268fc29 2026-07-05
# QuickJS-ng Compiler version 0.15.1
txiki.js v26.6.0 1a230d31183f062fae7a6c4fd2cff466cecc1787 2026-07-06
# txiki.js build: git clone --recurse-submodules --depth 1 --branch v26.6.0; then
#   cmake -S . -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j$(getconf _NPROCESSORS_ONLN)
# caveat: on AppleDouble-writing mounts, delete `._*` sidecars first (find . -name '._*' -delete)
#   or wamr's source globs pick up `._foo.c` files and the build fails.
anita 2.18 gson.org-tarball 2026-07-06
# anita: PyPI "anita" is an unrelated proof-assistant; install http://www.gson.org/netbsd/anita/download/anita-2.18.tar.gz
netbsd 10.1 cdn 2026-07-06
# netbsd: https://cdn.netbsd.org/pub/NetBSD/NetBSD-10.1/amd64/ ; guest PKG_PATH redirects to .../NetBSD/x86_64/10.0_2026Q1/All
netbsd-evbarm-aarch64 10.1 cdn 2026-07-06
# evbarm-aarch64: pre-installed image binary/gzimg/arm64.img.gz + netbsd-GENERIC64 kernel, HVF accel;
#   guest PKG_PATH .../NetBSD/aarch64/10.1/All redirects to .../aarch64/10.0_2026Q1/All
simde v0.8.2 wamr-fetchcontent 2026-07-06
# simde: header-only, wamr simde.cmake FetchContent git-clones it at configure time;
#   guests get it pre-seeded via vendor/dist/simde-v0.8.2.tar.gz + FETCHCONTENT_SOURCE_DIR_SIMDE
