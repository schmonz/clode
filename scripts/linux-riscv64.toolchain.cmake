# CMake cross-toolchain for linux-riscv64 (64-bit little-endian, glibc).
# Consumed via CLODE_TJS_CROSS_FILE; run inside a Debian image providing
# gcc-riscv64-linux-gnu + g++-riscv64-linux-gnu (the leg's cross-apt) and the
# riscv64 sysroot they carry. build-tjs.mjs uses CMake's default (Make)
# generator for cross builds, so the demotes live in *_FLAGS_INIT (the
# host-side -DCMAKE_C_FLAGS demote is skipped when a cross file is set).
set(CMAKE_SYSTEM_NAME Linux)
set(CMAKE_SYSTEM_PROCESSOR riscv64)
set(_triple riscv64-linux-gnu)
set(CMAKE_C_COMPILER ${_triple}-gcc)
set(CMAKE_CXX_COMPILER ${_triple}-g++)
set(CMAKE_AR ${_triple}-ar CACHE FILEPATH "ar")
set(CMAKE_RANLIB ${_triple}-ranlib CACHE FILEPATH "ranlib")
set(CMAKE_STRIP ${_triple}-strip CACHE FILEPATH "strip")
set(_demote "-Wno-error=unused-variable -Wno-error=unknown-pragmas -Wno-error=sign-conversion")
set(CMAKE_C_FLAGS_INIT "${_demote}")
set(CMAKE_CXX_FLAGS_INIT "${_demote}")
# RISC-V's LR/SC only covers 32/64-bit, so quickjs's sub-word atomics
# (__atomic_*_1 / _2 on 8/16-bit types) become libatomic calls. Link libatomic
# STATICALLY (-l:libatomic.a, shipped in the Debian cross toolchain) at the end
# of the link line (STANDARD_LIBRARIES, after the objects → ld resolves the
# pending refs): the tiny archive is baked in, so the shipped builder carries NO
# libatomic.so.1 runtime dependency (a user's riscv64 box needs only glibc).
# Distinct from the __atomic_*_8 pthread SHIM (atomic-shim, for libatomic-less
# BSD/darwin targets) — here a real static libatomic exists, so use it.
set(CMAKE_C_STANDARD_LIBRARIES "-l:libatomic.a")
set(CMAKE_CXX_STANDARD_LIBRARIES "-l:libatomic.a")
set(CMAKE_FIND_ROOT_PATH /usr/${_triple})
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
