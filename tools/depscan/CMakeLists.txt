# depscan — built from source during the engine build, and thrown away.
# There is deliberately no install(), no export() and no package config: this
# tool must never reach a release artifact, so there is no shipped copy that
# could skew against the tree that uses it.
cmake_minimum_required(VERSION 3.13)
project(depscan C)

set(CMAKE_C_STANDARD 99)
set(CMAKE_C_STANDARD_REQUIRED ON)

add_executable(depscan depscan.c)

# Multi-config generators (Visual Studio) otherwise bury the binary in a
# per-config subdirectory, which buildDepscan() would have to guess at.
# Pin every config's output to the build root so the path is predictable.
foreach(cfg "" _DEBUG _RELEASE _RELWITHDEBINFO _MINSIZEREL)
  set_target_properties(depscan PROPERTIES RUNTIME_OUTPUT_DIRECTORY${cfg} "${CMAKE_BINARY_DIR}")
endforeach()
