/* cosmo compat shim: Cosmopolitan ships <syslog.h> but not the <sys/syslog.h>
 * alias that libwebsockets (and other POSIX code) include. Forward to the real
 * header. Placed on the cosmo toolchain's -isystem path (scripts/cosmo-compat). */
#include <syslog.h>
