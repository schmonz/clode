# CMake cross-toolchain for darwin-x86 (i386-apple-darwin8, floor 10.4 / Tiger).
# Consumed via CLODE_TJS_CROSS_FILE by scripts/build-tjs.mjs, run INSIDE the
# pinned osxcross image. i386@10.4 needs the LEGACY osxcross-1.1 toolchain
# (osxcross master refuses SDK <= 10.5) + the phracker MacOSX10.4u SDK (fat
# ppc/i386/ppc64/x86_64). 10.4u ships its own crt1.o, so — unlike the 10.6 x64
# leg — no Csu graft is needed. The clang wrapper self-locates the SDK sysroot.
# Replaces the native macos-15-intel i386 build (off the deprecating Intel runner).
set(CMAKE_SYSTEM_NAME Darwin)
set(CMAKE_SYSTEM_PROCESSOR i386)
# Darwin 8 == Mac OS X 10.4 (Tiger).
set(CMAKE_SYSTEM_VERSION 8)

set(_triple i386-apple-darwin8)
set(CMAKE_C_COMPILER ${_triple}-clang)
set(CMAKE_CXX_COMPILER ${_triple}-clang++)
set(CMAKE_AR ${_triple}-ar CACHE FILEPATH "ar")
set(CMAKE_RANLIB ${_triple}-ranlib CACHE FILEPATH "ranlib")
set(CMAKE_INSTALL_NAME_TOOL ${_triple}-install_name_tool CACHE FILEPATH "install_name_tool")

# The floor lives here (a Linux-hosted cross build can't use CMAKE_OSX_*). The
# -Wno-error demotions mirror the darwin-ppc / darwin-x64 files (txiki compiles
# -Werror); unknown -Wno-error=<w> options are ignored by clang, so carrying
# undef-prefix here is harmless on the older osxcross-1.1 clang.
# -msse2 -mfpmath=sse: 32-bit i386 defaults to x87 FP, but every Intel Mac has
# SSE2 — use it for 64-bit-double JS math (the fixupQjsX87FpcwI386Darwin build-tjs
# fixup disables quickjs's x87 precision control on Apple i386, so SSE FP is what
# keeps rounding correct).
set(_floor "-mmacosx-version-min=10.4 -msse2 -mfpmath=sse")
set(_demote "-Wno-error=unused-variable -Wno-error=unknown-pragmas -Wno-error=sign-conversion -Wno-error=undef-prefix")
set(CMAKE_C_FLAGS_INIT "${_floor} ${_demote}")
set(CMAKE_CXX_FLAGS_INIT "${_floor} ${_demote}")
# -lgcc: 32-bit i386 needs the 64-bit-int-division builtins (__divdi3 etc.) from
# libgcc; the osxcross image symlinks the SDK's i386 libgcc.a onto the default
# sysroot lib path so this resolves. (x64 is 64-bit native — no such need.)
set(CMAKE_EXE_LINKER_FLAGS_INIT "-mmacosx-version-min=10.4 -lgcc")

# Keep CMake's Darwin module from probing the Linux host for Apple SDKs/tools.
set(CMAKE_OSX_SYSROOT "" CACHE STRING "" FORCE)
set(CMAKE_OSX_DEPLOYMENT_TARGET "" CACHE STRING "" FORCE)
set(CMAKE_OSX_ARCHITECTURES "" CACHE STRING "" FORCE)

# Cross-compile find rules: host for programs, target for libs/headers.
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)
