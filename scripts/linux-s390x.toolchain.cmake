# CMake cross-toolchain for linux-s390x (64-bit BIG-endian, glibc) — the
# canonical-LE-on-64-bit-BE witness. Consumed via CLODE_TJS_CROSS_FILE; run
# inside a Debian image providing gcc-s390x-linux-gnu + g++-s390x-linux-gnu
# (the leg's cross-apt) and the s390x sysroot. Identical shape to the riscv64
# file — only the triple/processor differ; canonical-LE means BE needs no
# special-casing beyond building from the pinned patched source.
set(CMAKE_SYSTEM_NAME Linux)
set(CMAKE_SYSTEM_PROCESSOR s390x)
set(_triple s390x-linux-gnu)
set(CMAKE_C_COMPILER ${_triple}-gcc)
set(CMAKE_CXX_COMPILER ${_triple}-g++)
set(CMAKE_AR ${_triple}-ar CACHE FILEPATH "ar")
set(CMAKE_RANLIB ${_triple}-ranlib CACHE FILEPATH "ranlib")
set(CMAKE_STRIP ${_triple}-strip CACHE FILEPATH "strip")
set(_demote "-Wno-error=unused-variable -Wno-error=unknown-pragmas -Wno-error=sign-conversion")
set(CMAKE_C_FLAGS_INIT "${_demote}")
set(CMAKE_CXX_FLAGS_INIT "${_demote}")
# Link libatomic STATICALLY at the end of the link line (after the objects):
# quickjs's sub-word atomics can require libatomic, and baking in the tiny
# archive keeps the shipped builder free of a libatomic.so.1 runtime dep. Same
# rationale as the riscv64 file; a no-op when s390x resolves them natively.
set(CMAKE_C_STANDARD_LIBRARIES "-l:libatomic.a")
set(CMAKE_CXX_STANDARD_LIBRARIES "-l:libatomic.a")
set(CMAKE_FIND_ROOT_PATH /usr/${_triple})
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
