# Minimal CMake platform module for Cosmopolitan (Actually Portable Executable).
# Cosmopolitan presents a POSIX-like userland at runtime on every host OS, so we
# model it on a generic Unix platform: static-friendly, dlopen in libc, ELF-ish
# object handling (cosmocc drives the actual fat linking). Kept intentionally
# small — cosmocc owns compiler/linker specifics; CMake only needs enough to not
# assume Windows or bare-metal.

set(UNIX 1)

# dlopen/dlsym live in libc — no separate -ldl (mirrors NetBSD/OpenBSD).
set(CMAKE_DL_LIBS "")

set(CMAKE_SHARED_LIBRARY_C_FLAGS "-fPIC")
set(CMAKE_SHARED_LIBRARY_CREATE_C_FLAGS "-shared")
set(CMAKE_SHARED_LIBRARY_RUNTIME_C_FLAG "-Wl,-rpath,")
set(CMAKE_SHARED_LIBRARY_RUNTIME_C_FLAG_SEP ":")

set(CMAKE_SHARED_LIBRARY_PREFIX "lib")
set(CMAKE_SHARED_LIBRARY_SUFFIX ".so")
set(CMAKE_STATIC_LIBRARY_PREFIX "lib")
set(CMAKE_STATIC_LIBRARY_SUFFIX ".a")
set(CMAKE_EXECUTABLE_SUFFIX "")

# Provide the standard Unix path/link conventions.
include(Platform/UnixPaths OPTIONAL)
