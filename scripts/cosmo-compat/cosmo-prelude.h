/* Cosmopolitan compatibility prelude — force-included (-include) for the cosmo
 * build via scripts/cosmo.toolchain.cmake. Supplies the handful of POSIX/BSD
 * bits Cosmopolitan's libc omits that dependencies (libwebsockets) expect
 * unconditionally. Additive only: each item is genuinely absent on cosmo, so
 * defining it globally cannot shadow a real definition. */
#ifndef CLODE_COSMO_PRELUDE_H
#define CLODE_COSMO_PRELUDE_H

#include <sys/types.h>

/* cosmo omits the BSD <sys/types.h> alias u_int. */
typedef unsigned int u_int;

/* SO_PRIORITY is a Linux-only socket option; libwebsockets uses it
 * unconditionally. Cosmopolitan omits the constant. Define the Linux value so
 * the setsockopt() call compiles; on hosts without it the call is best-effort
 * and simply returns an error, which lws ignores. */
#ifndef SO_PRIORITY
#define SO_PRIORITY 12
#endif

/* cosmo's libc declares neither of these interface helpers; libuv's cosmo
 * platform file (src/unix/cosmo.c, via patches/libuv-cosmo.patch) defines the
 * symbols. Declare them so non-libuv consumers (lws) also compile. */
unsigned int if_nametoindex(const char* ifname);
char* if_indextoname(unsigned int ifindex, char* ifname);

#endif /* CLODE_COSMO_PRELUDE_H */
