# CMake cross-toolchain for netbsd-m68k (32-bit BIG-endian, NetBSD userland).
# Consumes a NetBSD build.sh cross-toolchain: the caller (the netbsd-crossbuild
# composite / the docker-loop probe) sets CLODE_NETBSD_TOOLDIR (the `build.sh
# -m m68k tools` output, containing bin/m68k--netbsdelf-*) and
# CLODE_NETBSD_DESTDIR (the `build.sh distribution` sysroot: /usr/include +
# /usr/lib). Consumed via CLODE_TJS_CROSS_FILE like the Debian cross files.
#
# CMAKE_SYSTEM_NAME NetBSD (with a toolchain file → CMAKE_CROSSCOMPILING): loads
# CMake's Platform/NetBSD module so target platform facts are correct — notably
# CMAKE_DL_LIBS is empty (NetBSD's dlopen lives in libc, no separate libdl),
# whereas Generic applied Linux-like defaults and appended `-ldl`, which does not
# exist on NetBSD (`ld: cannot find -ldl`, run 29358769733). The feature probes
# are try_compile (link against the sysroot), which work cross; nothing here
# try_runs a target binary. Canonical-LE carries the shipped LE bytecode onto
# this BE target; the __atomic_*_8 pthread shim (CLODE_TJS_ATOMIC_SHIM=1 on the
# leg) covers m68k's missing 8-byte libatomic, exactly like sparc/ppc.
set(CMAKE_SYSTEM_NAME NetBSD)
set(CMAKE_SYSTEM_PROCESSOR m68k)
set(_tooldir $ENV{CLODE_NETBSD_TOOLDIR})
set(_sysroot $ENV{CLODE_NETBSD_DESTDIR})
if(NOT _tooldir)
  message(FATAL_ERROR "netbsd-m68k toolchain: CLODE_NETBSD_TOOLDIR is unset (run build.sh -m m68k tools first)")
endif()
if(NOT _sysroot)
  message(FATAL_ERROR "netbsd-m68k toolchain: CLODE_NETBSD_DESTDIR is unset (run build.sh -m m68k distribution first)")
endif()
set(_triple m68k--netbsdelf)
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
