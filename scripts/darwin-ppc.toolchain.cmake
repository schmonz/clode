# CMake cross-toolchain for darwin-ppc (the ppc walk, Phase C).
# Consumed via CLODE_TJS_CROSS_FILE by scripts/build-tjs.mjs, run INSIDE the
# pinned VariantXYZ image (gcc 14.2 powerpc-apple-darwin8 + cctools-port ppc
# ld/as + baked MacOSX10.4u SDK). The cross-gcc self-locates its sysroot (the
# hello-world probe linked with just -mmacosx-version-min=10.4), so no
# explicit CMAKE_OSX_SYSROOT is needed — and setting one would fight CMake's
# Darwin module, which cannot run Apple's sw_vers/xcrun on a Linux host.
set(CMAKE_SYSTEM_NAME Darwin)
set(CMAKE_SYSTEM_PROCESSOR ppc)
# Darwin 8 == Mac OS X 10.4 (Tiger); tells CMake's platform module the target age.
set(CMAKE_SYSTEM_VERSION 8)

set(_triple powerpc-apple-darwin8)
set(CMAKE_C_COMPILER ${_triple}-gcc)
set(CMAKE_CXX_COMPILER ${_triple}-g++)
set(CMAKE_AR ${_triple}-ar CACHE FILEPATH "ar")
set(CMAKE_RANLIB ${_triple}-ranlib CACHE FILEPATH "ranlib")
# cctools-port ships no install_name_tool for ppc; static executables never
# invoke it. Point CMake at a harmless no-op so its Darwin module is satisfied.
set(CMAKE_INSTALL_NAME_TOOL /bin/true CACHE FILEPATH "unused (static exe)")

# The floor lives here (a Linux-hosted cross build can't use CMAKE_OSX_*,
# which assume xcodebuild). -static-libgcc: the target has no shared libgcc.
# The -Wno-error demotions match the non-darwin-host branch of build-tjs.mjs
# (txiki compiles -Werror; #pragma region etc. warn under gcc) — carried here
# rather than via -DCMAKE_C_FLAGS so the version-min survives.
set(_floor "-mmacosx-version-min=10.4")
set(_demote "-Wno-error=unused-variable -Wno-error=unknown-pragmas -Wno-error=sign-conversion")
set(CMAKE_C_FLAGS_INIT "${_floor} ${_demote}")
set(CMAKE_CXX_FLAGS_INIT "${_floor} ${_demote}")
set(CMAKE_EXE_LINKER_FLAGS_INIT "${_floor} -static-libgcc")

# Keep CMake's Darwin module from probing the Linux host for Apple SDKs/tools.
set(CMAKE_OSX_SYSROOT "" CACHE STRING "" FORCE)
set(CMAKE_OSX_DEPLOYMENT_TARGET "" CACHE STRING "" FORCE)
set(CMAKE_OSX_ARCHITECTURES "" CACHE STRING "" FORCE)

# Cross-compile find rules: host for programs, target for libs/headers.
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
