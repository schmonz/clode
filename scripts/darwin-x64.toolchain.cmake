# CMake cross-toolchain for darwin-x64 (x86_64-apple-darwin10, floor 10.6).
# Consumed via CLODE_TJS_CROSS_FILE by scripts/build-tjs.mjs, run INSIDE the
# pinned osxcross image (clang + cctools-port + the phracker MacOSX10.6 SDK — the
# same tarball+SHA the build-leg action fetches). osxcross's clang wrapper
# self-locates the SDK sysroot (like darwin-ppc's gcc), so no explicit
# CMAKE_OSX_SYSROOT — and setting one would fight CMake's Darwin module, which
# cannot run Apple's sw_vers/xcrun on a Linux host. Companion to
# darwin-ppc.toolchain.cmake; this replaces the native macos-15-intel build so
# darwin-x64 no longer depends on a deprecating GitHub Intel runner.
set(CMAKE_SYSTEM_NAME Darwin)
set(CMAKE_SYSTEM_PROCESSOR x86_64)
# Darwin 10 == Mac OS X 10.6 (Snow Leopard); tells CMake's platform module the age.
set(CMAKE_SYSTEM_VERSION 10)

set(_triple x86_64-apple-darwin10)
set(CMAKE_C_COMPILER ${_triple}-clang)
set(CMAKE_CXX_COMPILER ${_triple}-clang++)
set(CMAKE_AR ${_triple}-ar CACHE FILEPATH "ar")
set(CMAKE_RANLIB ${_triple}-ranlib CACHE FILEPATH "ranlib")
set(CMAKE_INSTALL_NAME_TOOL ${_triple}-install_name_tool CACHE FILEPATH "install_name_tool")

# The floor lives here (a Linux-hosted cross build can't use CMAKE_OSX_*, which
# assume xcodebuild). The -Wno-error demotions: osxcross's vanilla LLVM clang is
# STRICTER than Apple's clang on the ancient 10.6 SDK — -Wundef-prefix=TARGET_OS_
# errors on TARGET_OS_TV / TARGET_OS_WATCH (macros the pre-tvOS/watchOS 10.6 SDK
# never defined; libuv's process.c references them). The other demotes mirror the
# darwin-ppc file / the non-darwin-host branch of build-tjs.mjs (txiki compiles
# -Werror). Carried here rather than via -DCMAKE_C_FLAGS so the version-min survives.
set(_floor "-mmacosx-version-min=10.6")
set(_demote "-Wno-error=unused-variable -Wno-error=unknown-pragmas -Wno-error=sign-conversion -Wno-error=undef-prefix")
set(CMAKE_C_FLAGS_INIT "${_floor} ${_demote}")
set(CMAKE_CXX_FLAGS_INIT "${_floor} ${_demote}")
set(CMAKE_EXE_LINKER_FLAGS_INIT "${_floor}")

# Keep CMake's Darwin module from probing the Linux host for Apple SDKs/tools.
set(CMAKE_OSX_SYSROOT "" CACHE STRING "" FORCE)
set(CMAKE_OSX_DEPLOYMENT_TARGET "" CACHE STRING "" FORCE)
set(CMAKE_OSX_ARCHITECTURES "" CACHE STRING "" FORCE)

# Cross-compile find rules: host for programs, target for libs/headers.
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)
