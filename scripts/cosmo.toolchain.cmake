# CMake cross-toolchain for Cosmopolitan (cosmocc) — builds an Actually Portable
# Executable: ONE binary that runs on Linux/macOS/Windows/BSD, x86-64 AND arm64.
#
# Consumes CLODE_COSMOCC = the cosmocc toolchain bin dir (contains cosmocc /
# cosmoc++ / cosmoar). CMAKE_SYSTEM_NAME=Cosmopolitan resolves through the
# bundled Platform/Cosmopolitan.cmake (added to CMAKE_MODULE_PATH below), so
# libuv/txiki's `if(CMAKE_SYSTEM_NAME STREQUAL "Cosmopolitan")` branches select
# the generic-POSIX + poll(2) event loop and the cosmo source set.
set(CMAKE_SYSTEM_NAME Cosmopolitan)
# The APE is fat (x86-64 + aarch64); name the host-native slice nominally.
set(CMAKE_SYSTEM_PROCESSOR x86_64)

# Find Platform/Cosmopolitan.cmake next to this toolchain file (scripts/cmake/).
list(PREPEND CMAKE_MODULE_PATH "${CMAKE_CURRENT_LIST_DIR}/cmake")

set(_cc $ENV{CLODE_COSMOCC})
if(NOT _cc)
  message(FATAL_ERROR "cosmo toolchain: CLODE_COSMOCC unset (path to the cosmocc bin dir)")
endif()

set(CMAKE_C_COMPILER   "${_cc}/cosmocc")
set(CMAKE_CXX_COMPILER "${_cc}/cosmoc++")
set(CMAKE_AR           "${_cc}/cosmoar" CACHE FILEPATH "ar")

# gnu17: cosmocc's GCC defaults to C23, which hard-errors implicit declarations
# that older C (libuv/quickjs) still relies on. _DEFAULT_SOURCE (not the strict
# _POSIX/_XOPEN caps) so Cosmopolitan's default-source declarations are visible.
set(CMAKE_C_FLAGS_INIT   "-std=gnu17 -D_DEFAULT_SOURCE")
set(CMAKE_CXX_FLAGS_INIT "-D_DEFAULT_SOURCE")

# cosmocc produces the fat APE itself; don't let CMake try to build shared libs.
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY BOTH)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE BOTH)
