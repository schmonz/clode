# Generic CMake cross-toolchain for ANY NetBSD arch (the fleet). Consumes a
# NetBSD build.sh cross-toolchain: CLODE_NETBSD_TOOLDIR (the `build.sh -m
# <machine> tools` output, containing bin/<triple>-*) + CLODE_NETBSD_DESTDIR (the
# `build.sh distribution` sysroot). The cross triple + arch are DISCOVERED from
# the tooldir, so this one file serves every NetBSD MACHINE_ARCH — the fleet adds
# an arch by naming a port, not by writing a toolchain file.
#
# CMAKE_SYSTEM_NAME NetBSD (with a toolchain file → CMAKE_CROSSCOMPILING): loads
# Platform/NetBSD so target facts are correct (empty CMAKE_DL_LIBS — dlopen is in
# libc; Generic wrongly appends -ldl). Canonical-LE carries the shipped LE
# bytecode onto BE targets; the __atomic_*_8 pthread shim (CLODE_TJS_ATOMIC_SHIM=1
# on 32-bit-no-64bit-atomic legs) links into the tjs-cli EXECUTABLE. Proven first
# on netbsd-m68k (2026-07-14).
set(CMAKE_SYSTEM_NAME NetBSD)
set(_tooldir $ENV{CLODE_NETBSD_TOOLDIR})
set(_sysroot $ENV{CLODE_NETBSD_DESTDIR})
if(NOT _tooldir)
  message(FATAL_ERROR "netbsd toolchain: CLODE_NETBSD_TOOLDIR is unset (run build.sh -m <machine> tools first)")
endif()
if(NOT _sysroot)
  message(FATAL_ERROR "netbsd toolchain: CLODE_NETBSD_DESTDIR is unset (run build.sh -m <machine> distribution first)")
endif()
# Discover the cross triple from the tooldir: build.sh names its cross tools
# <MACHINE_GNU_PLATFORM>-<tool> (e.g. m68k--netbsdelf-gcc, sparc64--netbsd-gcc,
# vax--netbsdelf-gcc). The a.out→ELF suffix varies per arch, so glob instead of
# hardcoding.
file(GLOB _gccs "${_tooldir}/bin/*--netbsd*-gcc")
list(LENGTH _gccs _n)
if(NOT _n EQUAL 1)
  message(FATAL_ERROR "netbsd toolchain: expected exactly one *--netbsd*-gcc in ${_tooldir}/bin, found ${_n}: ${_gccs}")
endif()
list(GET _gccs 0 _gcc)
get_filename_component(_gccname "${_gcc}" NAME)
string(REGEX REPLACE "-gcc$" "" _triple "${_gccname}")   # e.g. m68k--netbsdelf
string(REGEX REPLACE "--.*" "" _proc "${_triple}")        # e.g. m68k
set(CMAKE_SYSTEM_PROCESSOR ${_proc})
set(CMAKE_C_COMPILER ${_tooldir}/bin/${_triple}-gcc)
set(CMAKE_CXX_COMPILER ${_tooldir}/bin/${_triple}-g++)
set(CMAKE_AR ${_tooldir}/bin/${_triple}-ar CACHE FILEPATH "ar")
set(CMAKE_RANLIB ${_tooldir}/bin/${_triple}-ranlib CACHE FILEPATH "ranlib")
set(CMAKE_STRIP ${_tooldir}/bin/${_triple}-strip CACHE FILEPATH "strip")
set(CMAKE_SYSROOT ${_sysroot})
set(_demote "-Wno-error=unused-variable -Wno-error=unknown-pragmas -Wno-error=sign-conversion")
set(CMAKE_C_FLAGS_INIT "--sysroot=${_sysroot} ${_demote}")
set(CMAKE_CXX_FLAGS_INIT "--sysroot=${_sysroot} ${_demote}")
set(CMAKE_EXE_LINKER_FLAGS_INIT "--sysroot=${_sysroot}")
set(CMAKE_FIND_ROOT_PATH ${_sysroot})
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
