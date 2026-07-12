/* 8-byte __atomic_* shim for 32-bit targets whose toolchain lacks libatomic
 * (the darwin-ppc walk; proven first in the sparc campaign — see
 * guest-sparc-*.sh). 32-bit ppc/sparc emit calls to __atomic_*_8 for the
 * 64-bit atomics quickjs-ng's Atomics builtin uses, and the cross toolchain
 * has no libatomic to resolve them. A pthread-mutex fallback is correct
 * (retro targets are effectively single-threaded for our workload) and
 * only the _8 variants are actually referenced — the compiler inlines the
 * natively-supported 1/2/4-byte atomics, so those defs here stay unused and
 * cannot clash. Linked into the tjs target only when CLODE_ATOMIC_SHIM=ON. */
#include <pthread.h>
#include <stdint.h>
#include <stddef.h>

static pthread_mutex_t tjs__atomic_lock = PTHREAD_MUTEX_INITIALIZER;

#define TJS_ATOMIC_OPS(n, t) \
t __atomic_load_##n(const volatile void *p, int mo){ t v; pthread_mutex_lock(&tjs__atomic_lock); v = *(const volatile t*)p; pthread_mutex_unlock(&tjs__atomic_lock); return v; } \
void __atomic_store_##n(volatile void *p, t v, int mo){ pthread_mutex_lock(&tjs__atomic_lock); *(volatile t*)p = v; pthread_mutex_unlock(&tjs__atomic_lock); } \
t __atomic_exchange_##n(volatile void *p, t v, int mo){ t o; pthread_mutex_lock(&tjs__atomic_lock); o = *(volatile t*)p; *(volatile t*)p = v; pthread_mutex_unlock(&tjs__atomic_lock); return o; } \
_Bool __atomic_compare_exchange_##n(volatile void *p, void *e, t d, _Bool w, int s, int f){ _Bool r; pthread_mutex_lock(&tjs__atomic_lock); t o = *(volatile t*)p; if (o == *(t*)e) { *(volatile t*)p = d; r = 1; } else { *(t*)e = o; r = 0; } pthread_mutex_unlock(&tjs__atomic_lock); return r; } \
t __atomic_fetch_add_##n(volatile void *p, t v, int mo){ pthread_mutex_lock(&tjs__atomic_lock); t o = *(volatile t*)p; *(volatile t*)p = o + v; pthread_mutex_unlock(&tjs__atomic_lock); return o; } \
t __atomic_fetch_sub_##n(volatile void *p, t v, int mo){ pthread_mutex_lock(&tjs__atomic_lock); t o = *(volatile t*)p; *(volatile t*)p = o - v; pthread_mutex_unlock(&tjs__atomic_lock); return o; } \
t __atomic_fetch_and_##n(volatile void *p, t v, int mo){ pthread_mutex_lock(&tjs__atomic_lock); t o = *(volatile t*)p; *(volatile t*)p = o & v; pthread_mutex_unlock(&tjs__atomic_lock); return o; } \
t __atomic_fetch_or_##n(volatile void *p, t v, int mo){ pthread_mutex_lock(&tjs__atomic_lock); t o = *(volatile t*)p; *(volatile t*)p = o | v; pthread_mutex_unlock(&tjs__atomic_lock); return o; } \
t __atomic_fetch_xor_##n(volatile void *p, t v, int mo){ pthread_mutex_lock(&tjs__atomic_lock); t o = *(volatile t*)p; *(volatile t*)p = o ^ v; pthread_mutex_unlock(&tjs__atomic_lock); return o; }

/* Only the 8-byte variants are actually undefined on 32-bit ppc/sparc, but
 * defining all four sizes is harmless (the compiler inlines 1/2/4 and never
 * calls these). __atomic_is_lock_free is intentionally NOT defined — it is a
 * compiler builtin (redefining it warns) and nothing references it. */
TJS_ATOMIC_OPS(1, uint8_t)
TJS_ATOMIC_OPS(2, uint16_t)
TJS_ATOMIC_OPS(4, uint32_t)
TJS_ATOMIC_OPS(8, uint64_t)
