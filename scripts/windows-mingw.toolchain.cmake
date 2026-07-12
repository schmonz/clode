# CMake cross-toolchain for the Windows tjs build survey (Phase 0).
# Consumed via CLODE_TJS_CROSS_FILE by scripts/build-tjs.mjs; mingw-w64 is
# apt-installed on the ubuntu runner (gcc-mingw-w64-x86-64). GCC-family, so
# the same -Wno-error demotions the non-darwin host branch uses carry here
# (via *_FLAGS_INIT, so -DCMAKE_C_FLAGS can't clobber the version-min-less
# flags). No atomic shim — x86-64 has native 8-byte atomics.
set(CMAKE_SYSTEM_NAME Windows)
set(CMAKE_SYSTEM_PROCESSOR x86_64)

set(_triple x86_64-w64-mingw32)
# The POSIX threading variant (winpthreads-backed) — lws/txpacer and other
# deps use raw pthread, which the WIN32 threading variant lacks. apt installs
# both; the default alternative is win32, so name the -posix binaries here.
set(CMAKE_C_COMPILER ${_triple}-gcc-posix)
set(CMAKE_CXX_COMPILER ${_triple}-g++-posix)
set(CMAKE_RC_COMPILER ${_triple}-windres)
set(CMAKE_AR ${_triple}-ar CACHE FILEPATH "ar")
set(CMAKE_RANLIB ${_triple}-ranlib CACHE FILEPATH "ranlib")

set(_demote "-Wno-error=unused-variable -Wno-error=unknown-pragmas -Wno-error=sign-conversion")
set(CMAKE_C_FLAGS_INIT "${_demote}")
set(CMAKE_CXX_FLAGS_INIT "${_demote}")

set(CMAKE_FIND_ROOT_PATH /usr/${_triple})
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
