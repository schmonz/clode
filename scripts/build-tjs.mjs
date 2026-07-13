#!/usr/bin/env node
// Build the patched tjs binary clode's node-shim targets.
// Sources: pinned checkouts under spike/quickjs/vendor/ (cloned if absent,
// tags from spike/quickjs/PINS.md; a fresh clone is sha-verified against the
// PIN). Patches: spike/quickjs/patches/*.patch applied idempotently
// (git apply --check first). Output: build/tjs/tjs.
//
// Env knobs (all optional; defaults preserve the local flow exactly):
//   CLODE_TJS_VENDOR  checkout parent dir (CI uses a scratch dir so the tree is
//                     constructed from committed material alone: pinned clone +
//                     patches — vendor/ is uncommitted scratch locally)
//   CLODE_TJS_OUT     output dir for the tjs binary (default build/tjs)
//   CLODE_TJS_STATIC  =1: fully-static link (musl legs) — -static plus
//                     BUILD_WITH_FFI=OFF (libffi is the ONLY external dep and
//                     tjs:ffi's dlopen is useless in a static binary; nothing
//                     shipped imports it — bun:ffi is a throw-on-use stub)
//
// Phases (CI splits them so a qemu-user guest only pays for the C build):
//   --source-only  stop after checkout + sha-verify + patches
//   --build-only   skip checkout/patches (tree must exist), cmake + smoke only
//   (default: both — the local flow, unchanged)
import { execFileSync } from 'node:child_process';
import os, { cpus } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const sourceOnly = process.argv.includes('--source-only');
const buildOnly = process.argv.includes('--build-only');
if (sourceOnly && buildOnly) throw new Error('pick one of --source-only / --build-only');
const vendor = process.env.CLODE_TJS_VENDOR || path.join(repo, 'spike/quickjs/vendor');
const patches = path.join(repo, 'spike/quickjs/patches');
const outDir = process.env.CLODE_TJS_OUT || path.join(repo, 'build/tjs');
const wantStatic = process.env.CLODE_TJS_STATIC === '1';
// CLODE_TJS_WASM=off: drop WASM/WAMR support. Needed on arches where WAMR's
// posix_memmap.c references MAP_32BIT, a Linux mmap flag defined ONLY for
// x86/x86_64/aarch64 — s390x/ppc64le/riscv64 fail to compile (first found on
// the s390x BE-oracle leg 2026-07-09). That leg only runs --clode-version +
// the node-shim suite (no bundle boot, no WebAssembly), so WASM-off is free
// there. A real fix (guard MAP_32BIT to 0 when undefined, upstream WAMR) is
// queued for the Q3 batch; patches/ is frozen this phase.
const wantWasm = (process.env.CLODE_TJS_WASM || 'on').toLowerCase() !== 'off';
// CLODE_TJS_MIMALLOC=off: system malloc instead of mimalloc. mimalloc 3.2.7
// does not compile on NetBSD at all (its __NetBSD__ branch references the
// renamed mi_option_eager_commit_delay enum member — upstream regression,
// committed finding in spike/quickjs/qemu/guest-m4.sh). VM legs start with
// it off and re-enable per-platform as they prove.
const wantMimalloc = (process.env.CLODE_TJS_MIMALLOC || 'on').toLowerCase() !== 'off';
// CLODE_TJS_FFI=off: drop tjs:ffi (needs system libffi headers in the guest;
// nothing shipped imports it — bun:ffi is a throw-on-use stub). The STATIC
// knob already implies this; VM legs set it independently of static.
const wantFfi = (process.env.CLODE_TJS_FFI || 'on').toLowerCase() !== 'off';
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: 'inherit', ...opts });
const runOut = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', ...opts }).trim();

function pinFields(component) {
  const line = fs.readFileSync(path.join(repo, 'spike/quickjs/PINS.md'), 'utf8')
    .split('\n').find((l) => l.split(/\s+/)[0] === component);
  if (!line) throw new Error(`no PIN for ${component}`);
  return line.split(/\s+/);
}
const pin = (component) => pinFields(component)[1];
const pinSha = (component) => pinFields(component)[2];

function ensureCheckout(name, url) {
  const dir = path.join(vendor, name);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(vendor, { recursive: true });
    run('git', ['clone', '--recurse-submodules', '--depth', '1', '--branch', pin(name), url, dir]);
  }
  // The tag must still mean what PINS.md recorded (a moved tag or a stale
  // local checkout fails loudly — provenance gate for the from-pins CI flow).
  const head = runOut('git', ['-C', dir, 'rev-parse', 'HEAD']);
  if (head !== pinSha(name)) {
    throw new Error(`${name}: checkout HEAD ${head} != PINS.md sha ${pinSha(name)} (tag ${pin(name)})`);
  }
  return dir;
}

// Fallback idempotency proof for patches whose reverse-check fails because a
// LATER patch edited overlapping context (sync-fs vs sync-spawn — the PINS.md
// build caveat): every line the patch ADDS must be present verbatim in its
// target file. Weaker than reverse-apply but still loud on a missing patch.
function addedLinesPresent(dir, patchAbs) {
  const text = fs.readFileSync(patchAbs, 'utf8');
  let target = null;
  const wanted = new Map(); // file -> [added lines]
  for (const line of text.split('\n')) {
    const m = line.match(/^\+\+\+ b\/(.+)$/);
    if (m) { target = m[1]; continue; }
    if (target && line.startsWith('+') && !line.startsWith('++')) {
      const content = line.slice(1);
      if (content.trim() === '') continue;
      if (!wanted.has(target)) wanted.set(target, []);
      wanted.get(target).push(content);
    }
  }
  for (const [file, lines] of wanted) {
    const p = path.join(dir, file);
    if (!fs.existsSync(p)) return `${file}: missing`;
    const body = fs.readFileSync(p, 'utf8').split('\n');
    const have = new Set(body);
    for (const l of lines) if (!have.has(l)) return `${file}: missing line ${JSON.stringify(l)}`;
  }
  return null; // all added content present
}

// THE documented application order (from-pins flow, proven on a pristine
// v26.6.0 tree 2026-07-09). Not alphabetical: spawn-inherit-fd was diffed
// against a tree that already carried spawn-fail-uaf, so its mod_process.c
// hunks SUBSUME the uaf fix — inherit-fd must go first, after which uaf
// verifies as already-applied (content-presence fallback below). Every
// txiki-*.patch in patches/ MUST appear here; a new patch without a
// documented position fails loudly.
const TXIKI_PATCH_ORDER = [
  'txiki-default-stack-size.patch',
  'txiki-netbsd-portability.patch',
  'txiki-no-origin-header.patch',
  'txiki-spawn-inherit-fd.patch',   // before spawn-fail-uaf (subsumes it)
  'txiki-spawn-fail-uaf.patch',
  'txiki-stream-write-sync-number.patch',
  'txiki-sync-fs.patch',
  'txiki-sync-spawn.patch',
  'txiki-wurl-url.patch',
];

function orderedPatches(prefix) {
  const present = fs.readdirSync(patches).filter((f) => f.startsWith(prefix) && f.endsWith('.patch'));
  if (prefix === 'txiki-') {
    const undocumented = present.filter((f) => !TXIKI_PATCH_ORDER.includes(f));
    if (undocumented.length) throw new Error(`patches without a documented order: ${undocumented.join(', ')} (add to TXIKI_PATCH_ORDER)`);
    return TXIKI_PATCH_ORDER.filter((f) => present.includes(f));
  }
  return present;
}

function applyPatches(dir, prefix) {
  for (const p of orderedPatches(prefix)) {
    const abs = path.join(patches, p);
    try {
      execFileSync('git', ['-C', dir, 'apply', '--check', abs], { stdio: 'pipe' });
    } catch {
      try {
        execFileSync('git', ['-C', dir, 'apply', '--check', '--reverse', abs], { stdio: 'pipe' });
        console.log(`patch ${p}: already applied (reverse-check)`);
      } catch {
        const missing = addedLinesPresent(dir, abs);
        if (missing) throw new Error(`patch ${p}: neither applies nor verifies as applied (${missing})`);
        console.log(`patch ${p}: already applied (content-presence; overlapping-context caveat)`);
      }
      continue;
    }
    run('git', ['-C', dir, 'apply', abs]);
    console.log(`patch ${p}: applied`);
  }
}

// ---- source fixups: known upstream portability bugs, fixed at the exact
// line with content verification. Recipe-workaround tier (like -Wno-error
// and the WASM/mimalloc knobs) — patches/ is frozen this phase; each fixup
// is an upstream candidate queued for the Q3 batch. They run in the SOURCE
// phase so every leg builds the identical tree.
function fixupLwsDragonflySoPriority(dir) {
  // libwebsockets skips SO_PRIORITY (a Linux-only sockopt) on every BSD
  // EXCEPT DragonFly: the exclusion list in unix-sockets.c names FreeBSD/
  // NetBSD/OpenBSD/sun/Haiku/... but misses __DragonFly__, so the DragonFly
  // build dies on the undeclared constant (matrix dispatch #5, 2026-07-10;
  // lws upstream candidate — their own comment says "the BSDs don't have
  // SO_PRIORITY").
  // lws treats "the BSDs" specially in FOUR compiled guard sites but its
  // lists miss __DragonFly__ everywhere: unix-sockets.c has two NEGATIVE
  // exclusion lists (SOL_TCP NODELAY branch + the SO_PRIORITY block), two
  // POSITIVE lists (the tcp_proto declaration + the keepalive skip-tuning
  // block), and dir-notify.c gates its kqueue backend on a positive
  // single-line #elif. Fix EVERY __NetBSD__ guard line lacking a DragonFly
  // sibling — the first-occurrence version of this fixup patched one block
  // and left the rest broken (dispatch #6 lesson).
  const f = path.join(dir, 'deps/libwebsockets/lib/plat/unix/unix-sockets.c');
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  const isGuard = (l) => /^\s*!?defined\(__NetBSD__\) (&&|\|\|) \\$/.test(l);
  if (!lines.some(isGuard)) {
    throw new Error('fixup lws-dragonfly-guards: anchor not found (lws changed under the pin — re-derive the fixup)');
  }
  let applied = 0;
  const out = [];
  for (const l of lines) {
    if (isGuard(l) && !(out.length && out[out.length - 1].includes('__DragonFly__'))) {
      out.push(l.replace('__NetBSD__', '__DragonFly__'));
      applied++;
    }
    out.push(l);
  }
  if (applied) fs.writeFileSync(f, out.join('\n'));

  // dir-notify.c: kqueue #elif (DragonFly has kqueue like its siblings).
  const f2 = path.join(dir, 'deps/libwebsockets/lib/misc/dir-notify/dir-notify.c');
  const src2 = fs.readFileSync(f2, 'utf8');
  const kq = '#elif defined(__APPLE__) || defined(__FreeBSD__) || defined(__NetBSD__) || defined(__OpenBSD__)';
  if (src2.includes(kq)) {
    fs.writeFileSync(f2, src2.replace(kq, kq.replace('defined(__NetBSD__)', 'defined(__NetBSD__) || defined(__DragonFly__)')));
    applied++;
  } else if (!src2.includes('__DragonFly__')) {
    throw new Error('fixup lws-dragonfly-guards: dir-notify anchor not found (lws changed under the pin — re-derive the fixup)');
  }

  // libwebsockets.h: the BSD list that pulls in <sys/socket.h> +
  // <netinet/in.h> — without it every sockaddr_* in the lws headers is an
  // incomplete type on DragonFly (dispatch #8, 2026-07-10).
  const f3 = path.join(dir, 'deps/libwebsockets/include/libwebsockets.h');
  const src3 = fs.readFileSync(f3, 'utf8');
  const inc = '#if defined(__NetBSD__) || defined(__FreeBSD__) || defined(__QNX__) || defined(__OpenBSD__) || defined(__NuttX__)';
  if (src3.includes(inc)) {
    fs.writeFileSync(f3, src3.replace(inc, inc.replace('defined(__NetBSD__)', 'defined(__NetBSD__) || defined(__DragonFly__)')));
    applied++;
  } else if (!src3.includes('__DragonFly__')) {
    throw new Error('fixup lws-dragonfly-guards: libwebsockets.h anchor not found (lws changed under the pin — re-derive the fixup)');
  }

  if (applied) {
    console.log(`fixup lws-dragonfly-guards: applied (${applied} site(s))`);
  } else {
    console.log('fixup lws-dragonfly-guards: already applied');
  }
}

function fixupLwsIpv6PrefGuard(dir) {
  // lws's IPV6_PREFER_PUBLIC_ADDR block tests defined(IPV6_PREFER_SRC_PUBLIC)
  // but then CALLS setsockopt with IPV6_ADDR_PREFERENCES — illumos defines
  // the former and not the latter (it has IPV6_SRC_PREFERENCES instead), so
  // OmniOS dies on the mismatch (dispatch #6, 2026-07-10). Make the guard
  // test what the code uses; platform-neutral (a no-op wherever both macros
  // exist). lws upstream candidate.
  const f = path.join(dir, 'deps/libwebsockets/lib/plat/unix/unix-sockets.c');
  const src = fs.readFileSync(f, 'utf8');
  const bad = '#if defined(LWS_WITH_IPV6) && defined(IPV6_PREFER_SRC_PUBLIC)';
  const good = '#if defined(LWS_WITH_IPV6) && defined(IPV6_PREFER_SRC_PUBLIC) && defined(IPV6_ADDR_PREFERENCES)';
  if (src.includes(good)) {
    console.log('fixup lws-ipv6-pref-guard: already applied');
    return;
  }
  if (!src.includes(bad)) {
    throw new Error('fixup lws-ipv6-pref-guard: anchor not found (lws changed under the pin — re-derive the fixup)');
  }
  fs.writeFileSync(f, src.replace(bad, good));
  console.log('fixup lws-ipv6-pref-guard: applied');
}

function fixupQjsSunosB64(dir) {
  // Solaris system headers declare b64_encode/b64_decode with different
  // signatures; quickjs.c's file-local (static) codec of the same name is a
  // conflicting-types compile error there (dispatch #6, 2026-07-10). Rename
  // ours via macro under __sun — quickjs-ng upstream candidate.
  const f = path.join(dir, 'deps/quickjs/quickjs.c');
  const src = fs.readFileSync(f, 'utf8');
  if (src.includes('qjs__b64_encode')) {
    console.log('fixup qjs-sunos-b64: already applied');
    return;
  }
  const anchor = '#include "cutils.h"\n';
  if (!src.includes(anchor)) {
    throw new Error('fixup qjs-sunos-b64: anchor not found (quickjs changed under the pin — re-derive the fixup)');
  }
  const guard = '#if defined(__sun)\n/* Solaris headers declare b64_encode/b64_decode (other signatures);\n   rename quickjs\'s file-local codec to dodge the clash. */\n#define b64_encode qjs__b64_encode\n#define b64_decode qjs__b64_decode\n#endif\n';
  fs.writeFileSync(f, src.replace(anchor, guard + anchor));
  console.log('fixup qjs-sunos-b64: applied');
}

function fixupMemMallocHOpenbsd(dir) {
  // txiki's src/mem.c falls through to #include <malloc.h> on every platform
  // that is not mimalloc/Apple — OpenBSD removed malloc.h entirely and
  // DragonFly never ships one (dispatch #11 exposed DragonFly once its lws
  // walls fell; stdlib.h is malloc's home on both, and malloc_usable_size
  // does not exist there — the usable-size helper already returns 0 on the
  // #else branch). Matrix dispatches #5/#11, 2026-07-10; txiki upstream
  // candidate.
  const f = path.join(dir, 'src/mem.c');
  const src = fs.readFileSync(f, 'utf8');
  const good = '#elif !defined(__OpenBSD__) && !defined(__DragonFly__)\n#include <malloc.h>\n#endif';
  if (src.includes(good)) {
    console.log('fixup mem-malloc-h-openbsd: already applied');
    return;
  }
  // Upgrade path: an earlier run of this fixup wrote the OpenBSD-only guard.
  const v1 = '#elif !defined(__OpenBSD__)\n#include <malloc.h>\n#endif';
  const anchor = '#else\n#include <malloc.h>\n#endif';
  if (src.includes(v1)) {
    fs.writeFileSync(f, src.replace(v1, good));
  } else if (src.includes(anchor)) {
    fs.writeFileSync(f, src.replace(anchor, good));
  } else {
    throw new Error('fixup mem-malloc-h-openbsd: anchor not found (mem.c changed under the pin — re-derive the fixup)');
  }
  console.log('fixup mem-malloc-h-openbsd: applied');
}

function fixupLibuvBsdForkSpawn(dir) {
  // The pinned libuv (saghul's fork) uses posix_spawn on EVERY platform;
  // upstream libuv uses it only on macOS. Two BSDs object, each in its own
  // way (matrix dispatches #11/#12, 2026-07-10):
  //   OpenBSD — child-side failure: even `tjs.spawn(["/bin/sh","-c","echo
  //     ok"])` exits a bare 127 with no output.
  //   DragonFly — parent-side EINVAL from uv_spawn on the same probe; prime
  //     suspect is sigfillset()+posix_spawnattr_setsigdefault (the set
  //     includes SIGKILL/SIGSTOP, which a strict sigaction rejects).
  // Forcing posix_spawn_works=0 selects the fork/exec fallback — the
  // battle-tested path upstream libuv uses everywhere off-macOS. The deeper
  // whys are report candidates for the libuv fork.
  const f = path.join(dir, 'deps/libuv/src/unix/process.c');
  const src = fs.readFileSync(f, 'utf8');
  const guard = '#if defined(__OpenBSD__) || defined(__DragonFly__) || defined(__HAIKU__)\n  /* OpenBSD/DragonFly/Haiku: the posix_spawn route fails (child-side bare\n   * 127 / parent-side EINVAL x2); use the fork/exec fallback path. */\n  posix_spawn_works = 0;\n#elif !defined(__linux__)\n  posix_spawn_works = 1;';
  if (src.includes('defined(__OpenBSD__) || defined(__DragonFly__) || defined(__HAIKU__)')) {
    console.log('fixup libuv-bsd-fork-spawn: already applied');
    return;
  }
  // Upgrade path: an earlier run wrote the OpenBSD-only guard.
  const v1 = '#if defined(__OpenBSD__)\n  /* OpenBSD: posix_spawn route fails child-side (bare exit 127); use the\n   * fork/exec fallback path. */\n  posix_spawn_works = 0;\n#elif !defined(__linux__)\n  posix_spawn_works = 1;';
  const v2 = '#if defined(__OpenBSD__) || defined(__DragonFly__)\n  /* OpenBSD/DragonFly: the posix_spawn route fails (child-side bare 127 /\n   * parent-side EINVAL); use the fork/exec fallback path. */\n  posix_spawn_works = 0;\n#elif !defined(__linux__)\n  posix_spawn_works = 1;';
  const anchor = '#if !defined(__linux__)\n  posix_spawn_works = 1;';
  if (src.includes(v2)) {
    fs.writeFileSync(f, src.replace(v2, guard));
  } else if (src.includes(v1)) {
    fs.writeFileSync(f, src.replace(v1, guard));
  } else if (src.includes(anchor)) {
    fs.writeFileSync(f, src.replace(anchor, guard));
  } else {
    throw new Error('fixup libuv-bsd-fork-spawn: anchor not found (libuv changed under the pin — re-derive the fixup)');
  }
  console.log('fixup libuv-bsd-fork-spawn: applied');
}

function fixupLibuvSunosDefpath(dir) {
  // Vendored libuv's unix/process.c (execvpe emulation) uses _PATH_DEFPATH
  // and NAME_MAX bare. Solaris' paths.h (gcc fixincludes) lacks
  // _PATH_DEFPATH, and SunOS famously omits NAME_MAX from limits.h (it is
  // filesystem-dependent there). Guarded fallbacks — no-ops everywhere else
  // (musl's own execvp.c, which this code was copied from, carries the same
  // NAME_MAX fallback). Matrix dispatch #5, 2026-07-10; libuv upstream
  // report candidate.
  const f = path.join(dir, 'deps/libuv/src/unix/process.c');
  const src = fs.readFileSync(f, 'utf8');
  const guard = '#ifndef _PATH_DEFPATH\n# define _PATH_DEFPATH "/usr/bin:/bin"\n#endif\n#ifndef NAME_MAX\n# define NAME_MAX 255\n#endif\n';
  if (src.includes('#ifndef _PATH_DEFPATH')) {
    console.log('fixup libuv-sunos-defpath: already applied');
    return;
  }
  const anchor = '#include <paths.h>\n';
  if (!src.includes(anchor)) {
    throw new Error('fixup libuv-sunos-defpath: anchor not found (libuv changed under the pin — re-derive the fixup)');
  }
  fs.writeFileSync(f, src.replace(anchor, anchor + guard));
  console.log('fixup libuv-sunos-defpath: applied');
}

function fixupPosixSocketSunosMsghdr(dir) {
  // illumos' default headers expose the OLD SysV msghdr (no msg_control/
  // msg_controllen/msg_flags; iovec's iov_base is caddr_t) — txiki's
  // mod_posix-socket.c needs the XPG4v2 struct. The canonical SunOS recipe
  // is _XPG4_2 + __EXTENSIONS__, defined BEFORE any include; scoped to this
  // one TU under __sun (matrix omnios leg, dispatch #7 2026-07-10; txiki
  // upstream candidate). Solaris 11.4 compiled without it — watch that leg
  // for regression and scope to __illumos__ if it objects.
  const f = path.join(dir, 'src/mod_posix-socket.c');
  const src = fs.readFileSync(f, 'utf8');
  if (src.includes('_XPG4_2')) {
    console.log('fixup posix-socket-sunos-msghdr: already applied');
    return;
  }
  const anchor = '#include "private.h"\n';
  if (!src.startsWith(anchor)) {
    throw new Error('fixup posix-socket-sunos-msghdr: anchor not found (mod_posix-socket.c changed under the pin — re-derive the fixup)');
  }
  const guard = '#if defined(__sun)\n/* SunOS: select the XPG4v2 msghdr (msg_control/msg_flags) */\n#define _XPG4_2 1\n#define __EXTENSIONS__ 1\n#endif\n';
  fs.writeFileSync(f, guard + src);
  console.log('fixup posix-socket-sunos-msghdr: applied');
}

function fixupLibuvMidnightbsd(dir) {
  // libuv's CMake OS detection has no idea what "MidnightBSD" is, so it
  // builds WITHOUT the unix platform sources and every uv_* symbol is
  // undefined at link (v0.1.2 tag run, 2026-07-10). MidnightBSD is a
  // FreeBSD fork (its compiler defines __FreeBSD__ too) — teach every
  // FreeBSD-family branch the sibling name. libuv upstream candidate.
  const f = path.join(dir, 'deps/libuv/CMakeLists.txt');
  let src = fs.readFileSync(f, 'utf8');
  if (src.includes('MidnightBSD')) {
    console.log('fixup libuv-midnightbsd: already applied');
    return;
  }
  const subs = [
    ['MATCHES "DragonFly|FreeBSD")', 'MATCHES "DragonFly|FreeBSD|MidnightBSD")'],
    ['MATCHES "DragonFly|FreeBSD|NetBSD|OpenBSD")', 'MATCHES "DragonFly|FreeBSD|MidnightBSD|NetBSD|OpenBSD")'],
    ['MATCHES "FreeBSD")', 'MATCHES "FreeBSD|MidnightBSD")'],
    ['MATCHES "DragonFly|FreeBSD|Linux|NetBSD|OpenBSD")', 'MATCHES "DragonFly|FreeBSD|MidnightBSD|Linux|NetBSD|OpenBSD")'],
  ];
  let hits = 0;
  for (const [from, to] of subs) {
    while (src.includes(from)) { src = src.replace(from, to); hits++; }
  }
  if (!hits) {
    throw new Error('fixup libuv-midnightbsd: no FreeBSD-family branches found (libuv changed under the pin — re-derive the fixup)');
  }
  fs.writeFileSync(f, src);
  console.log(`fixup libuv-midnightbsd: applied (${hits} branch(es))`);
}

function fixupLwsHaikuMallocUsableSize(dir) {
  // Haiku's libroot EXPORTS malloc_usable_size (so lws's cmake feature
  // check passes and LWS_HAVE_MALLOC_USABLE_SIZE is set) but its malloc.h
  // does NOT declare it -> implicit-declaration under -Werror in
  // lws/core/alloc.c (v0.1.2 tag run, 2026-07-10). Declare it ourselves,
  // Haiku-only. lws/Haiku upstream candidate.
  const f = path.join(dir, 'deps/libwebsockets/lib/core/alloc.c');
  const src = fs.readFileSync(f, 'utf8');
  if (src.includes('__HAIKU__')) {
    console.log('fixup lws-haiku-malloc-usable-size: already applied');
    return;
  }
  const anchor = '#if defined(LWS_HAVE_MALLOC_USABLE_SIZE)\n\n#include <malloc.h>\n';
  if (!src.includes(anchor)) {
    throw new Error('fixup lws-haiku-malloc-usable-size: anchor not found (lws changed under the pin — re-derive the fixup)');
  }
  const decl = '#if defined(__HAIKU__)\n/* libroot exports it; the header does not declare it */\nextern size_t malloc_usable_size(void *ptr);\n#endif\n';
  fs.writeFileSync(f, src.replace(anchor, anchor + decl));
  console.log('fixup lws-haiku-malloc-usable-size: applied');
}

function fixupLwsHaikuDirent(dir) {
  // Haiku's dirent has NO d_type (like SunOS/QNX) and defines no DT_*
  // constants — lws's misc/dir.c already carries a stat-based fallback
  // behind #if defined(__sun) || defined(__QNX__); Haiku joins that list
  // at both guard sites (dry-run #15, 2026-07-10). lws upstream candidate.
  const f = path.join(dir, 'deps/libwebsockets/lib/misc/dir.c');
  const src = fs.readFileSync(f, 'utf8');
  if (src.includes('__HAIKU__')) {
    console.log('fixup lws-haiku-dirent: already applied');
    return;
  }
  const pos = '#if defined(__sun) || defined(__QNX__)';
  const neg = '#if !defined(__sun) && !defined(__QNX__)';
  if (!src.includes(pos) || !src.includes(neg)) {
    throw new Error('fixup lws-haiku-dirent: anchors not found (lws changed under the pin — re-derive the fixup)');
  }
  fs.writeFileSync(f, src
    .replace(pos, '#if defined(__sun) || defined(__QNX__) || defined(__HAIKU__)')
    .replace(neg, '#if !defined(__sun) && !defined(__QNX__) && !defined(__HAIKU__)'));
  console.log('fixup lws-haiku-dirent: applied');
}

function fixupLwsGetifaddrsPtrCast(dir) {
  // lws's getifaddrs FALLBACK (compiled only where the OS lacks the real
  // one — Haiku) walks ifc_buf with a char* cursor, but Haiku declares
  // ifc_buf with a different pointer type -> "comparison of distinct
  // pointer types" under -Werror (dry-run #16, 2026-07-10). Cast both
  // uses; a no-op where the types already match. lws upstream candidate.
  const f = path.join(dir, 'deps/libwebsockets/lib/misc/getifaddrs.c');
  const src = fs.readFileSync(f, 'utf8');
  const bad = 'for (p = ifconf.ifc_buf; p < ifconf.ifc_buf + ifconf.ifc_len; p += sz) {';
  const good = 'for (p = (char *)ifconf.ifc_buf; p < (char *)ifconf.ifc_buf + ifconf.ifc_len; p += sz) {';
  if (src.includes(good)) {
    console.log('fixup lws-getifaddrs-ptr-cast: already applied');
    return;
  }
  if (!src.includes(bad)) {
    throw new Error('fixup lws-getifaddrs-ptr-cast: anchor not found (lws changed under the pin — re-derive the fixup)');
  }
  fs.writeFileSync(f, src.replace(bad, good));
  console.log('fixup lws-getifaddrs-ptr-cast: applied');
}

function fixupPosixSocketSockRdm(dir) {
  // txiki's mod_posix-socket.c exposes SOCK_RDM unconditionally; Haiku
  // does not define it (dry-run #17, 2026-07-10). Guard it like the file
  // already guards SOL_PACKET/SOL_NETLINK. txiki upstream candidate.
  const f = path.join(dir, 'src/mod_posix-socket.c');
  const src = fs.readFileSync(f, 'utf8');
  const bad = '    JS_PROT_INT_DEF(SOCK_RDM),\n';
  const good = '#ifdef SOCK_RDM\n    JS_PROT_INT_DEF(SOCK_RDM),\n#endif\n';
  if (src.includes(good)) {
    console.log('fixup posix-socket-sock-rdm: already applied');
    return;
  }
  if (!src.includes(bad)) {
    throw new Error('fixup posix-socket-sock-rdm: anchor not found (mod_posix-socket.c changed under the pin — re-derive the fixup)');
  }
  fs.writeFileSync(f, src.replace(bad, good));
  console.log('fixup posix-socket-sock-rdm: applied');
}

function fixupTjsCmakeCxxOnlyForAda(dir) {
  // txiki declares CXX as a project language, but since the ada-ectomy
  // (TJS_USE_ADA=OFF selects the plain-C wurl) nothing C++ compiles — yet
  // cmake still sanity-links clang++, which fails against pre-libc++ SDKs
  // ("ld: library 'c++' not found", darwin floor-walk probe 2, run
  // 29165510612, 2026-07-11). Require CXX only when ada is selected.
  // txiki upstream candidate (also spares the base-gcc BSDs a g++ dep).
  const f = path.join(dir, 'CMakeLists.txt');
  const src = fs.readFileSync(f, 'utf8');
  const cOnly = 'project(tjs LANGUAGES C)';
  const adaLang = 'if(TJS_USE_ADA)\n    enable_language(CXX)\n';
  if (src.includes(cOnly) && src.includes(adaLang)) {
    console.log('fixup tjs-cmake-cxx-only-for-ada: already applied');
    return;
  }
  const projAnchor = 'project(tjs LANGUAGES C CXX)';
  const adaAnchor = 'if(TJS_USE_ADA)\n    add_subdirectory(deps/ada EXCLUDE_FROM_ALL)\n';
  if (!src.includes(projAnchor) || !src.includes(adaAnchor)) {
    throw new Error('fixup tjs-cmake-cxx-only-for-ada: anchor not found (CMakeLists.txt changed under the pin — re-derive the fixup)');
  }
  fs.writeFileSync(f, src
    .replace(projAnchor, cOnly)
    .replace(adaAnchor, 'if(TJS_USE_ADA)\n    enable_language(CXX)\n    add_subdirectory(deps/ada EXCLUDE_FROM_ALL)\n'));
  console.log('fixup tjs-cmake-cxx-only-for-ada: applied');
}

function fixupLibuvHrtimeOldDarwin(dir) {
  // libuv's uv__hrtime on macOS calls mach_continuous_time() bare — a
  // 10.12+ API, undeclared in older SDK headers (darwin floor walk,
  // 2026-07-11). Deployment floors below 10.12 fall back to
  // mach_absolute_time() (stops during sleep — upstream libuv's own
  // pre-1.45 behavior). __ENVIRONMENT_MAC_OS_X_VERSION_MIN_REQUIRED__ is
  // compiler-predefined from -mmacosx-version-min; no header needed.
  // No-op for every current leg (stock SDKs, modern floors); libuv
  // upstream candidate.
  const f = path.join(dir, 'deps/libuv/src/unix/darwin.c');
  const src = fs.readFileSync(f, 'utf8');
  const bad = '  return mach_continuous_time() * timebase.numer / timebase.denom;\n';
  const good = '#if defined(__ENVIRONMENT_MAC_OS_X_VERSION_MIN_REQUIRED__) && __ENVIRONMENT_MAC_OS_X_VERSION_MIN_REQUIRED__ < 101200\n'
    + '  /* mach_continuous_time() is 10.12+; older deployment floors use\n'
    + "   * mach_absolute_time() (libuv's own pre-1.45 behavior). */\n"
    + '  return mach_absolute_time() * timebase.numer / timebase.denom;\n'
    + '#else\n'
    + '  return mach_continuous_time() * timebase.numer / timebase.denom;\n'
    + '#endif\n';
  if (src.includes('__ENVIRONMENT_MAC_OS_X_VERSION_MIN_REQUIRED__ < 101200')) {
    console.log('fixup libuv-hrtime-old-darwin: already applied');
    return;
  }
  if (!src.includes(bad)) {
    throw new Error('fixup libuv-hrtime-old-darwin: anchor not found (libuv changed under the pin — re-derive the fixup)');
  }
  fs.writeFileSync(f, src.replace(bad, good));
  console.log('fixup libuv-hrtime-old-darwin: applied');
}

function fixupLibuvStrnlenOldDarwin(dir) {
  // strnlen() reached macOS libc/headers in 10.7; against the 10.6 SDK the
  // declaration is missing (implicit-decl is a hard error in modern clang)
  // and the libSystem stub lacks the symbol; process.c AND getaddrinfo.c
  // call it (darwin floor walk, 2026-07-11). Same shape as the sunos
  // strnlen accommodation libuv already carries in internal.h — and placed
  // right next to it, covering every unix TU. Guarded on BOTH axes: an old
  // SDK (MAX_ALLOWED — no declaration) or an old floor (MIN_REQUIRED —
  // no runtime symbol on the target box). No-op everywhere else; libuv
  // upstream candidate.
  const f = path.join(dir, 'deps/libuv/src/unix/internal.h');
  const src = fs.readFileSync(f, 'utf8');
  const anchor = '#if defined(__sun)\n'
    + '#if !defined(_POSIX_VERSION) || _POSIX_VERSION < 200809L\n'
    + 'size_t strnlen(const char* s, size_t maxlen);\n'
    + '#endif\n'
    + '#endif\n';
  const guard = '#if defined(__APPLE__)\n'
    + '# include <AvailabilityMacros.h>\n'
    + '# if MAC_OS_X_VERSION_MAX_ALLOWED < 1070 || MAC_OS_X_VERSION_MIN_REQUIRED < 1070\n'
    + '/* strnlen() reached macOS libc in 10.7; older SDKs/floors get a local\n'
    + ' * fallback (same accommodation as the __sun one above). */\n'
    + 'static inline size_t uv__strnlen_compat(const char* s, size_t maxlen) {\n'
    + '  size_t i;\n'
    + '  for (i = 0; i < maxlen; i++)\n'
    + '    if (s[i] == 0)\n'
    + '      return i;\n'
    + '  return maxlen;\n'
    + '}\n'
    + '#  define strnlen uv__strnlen_compat\n'
    + '# endif\n'
    + '#endif\n';
  if (src.includes('uv__strnlen_compat')) {
    console.log('fixup libuv-strnlen-old-darwin: already applied');
    return;
  }
  if (!src.includes(anchor)) {
    throw new Error('fixup libuv-strnlen-old-darwin: anchor not found (libuv changed under the pin — re-derive the fixup)');
  }
  fs.writeFileSync(f, src.replace(anchor, anchor + guard));
  console.log('fixup libuv-strnlen-old-darwin: applied');
}

function fixupLibuvClockGettimeOldDarwin(dir) {
  // clock_gettime()/CLOCK_MONOTONIC/CLOCK_REALTIME are macOS 10.12+; the
  // 10.6 SDK has neither declaration nor symbol (darwin floor walk,
  // 2026-07-11). uv_clock_gettime (core.c) is the one caller compiled on
  // darwin. Emulate: REALTIME via gettimeofday (µs precision), MONOTONIC
  // via Mach absolute time. Guarded on both axes like the strnlen compat;
  // no-op everywhere else; libuv upstream candidate.
  const f = path.join(dir, 'deps/libuv/src/unix/core.c');
  const src = fs.readFileSync(f, 'utf8');
  const anchor = '#include <time.h> /* clock_gettime */\n';
  const guard = '#if defined(__APPLE__)\n'
    + '# include <AvailabilityMacros.h>\n'
    + '# if MAC_OS_X_VERSION_MAX_ALLOWED < 101200 || MAC_OS_X_VERSION_MIN_REQUIRED < 101200\n'
    + '#  include <mach/mach_time.h>\n'
    + '#  include <sys/time.h>\n'
    + '#  ifndef CLOCK_REALTIME\n'
    + '#   define CLOCK_REALTIME 0\n'
    + '#  endif\n'
    + '#  ifndef CLOCK_MONOTONIC\n'
    + '#   define CLOCK_MONOTONIC 6\n'
    + '#  endif\n'
    + '/* clock_gettime() is macOS 10.12+; emulate for older SDKs/floors. */\n'
    + 'static int uv__clock_gettime_compat(int clk, struct timespec* ts) {\n'
    + '  if (clk == CLOCK_REALTIME) {\n'
    + '    struct timeval tv;\n'
    + '    if (gettimeofday(&tv, NULL))\n'
    + '      return -1;\n'
    + '    ts->tv_sec = tv.tv_sec;\n'
    + '    ts->tv_nsec = tv.tv_usec * 1000;\n'
    + '    return 0;\n'
    + '  } else {\n'
    + '    static mach_timebase_info_data_t tb;\n'
    + '    uint64_t t;\n'
    + '    if (tb.denom == 0)\n'
    + '      mach_timebase_info(&tb);\n'
    + '    t = mach_absolute_time() * tb.numer / tb.denom;\n'
    + '    ts->tv_sec = t / 1000000000ULL;\n'
    + '    ts->tv_nsec = t % 1000000000ULL;\n'
    + '    return 0;\n'
    + '  }\n'
    + '}\n'
    + '#  define clock_gettime uv__clock_gettime_compat\n'
    + '# endif\n'
    + '#endif\n';
  if (src.includes('uv__clock_gettime_compat')) {
    console.log('fixup libuv-clock-gettime-old-darwin: already applied');
    return;
  }
  if (!src.includes(anchor)) {
    throw new Error('fixup libuv-clock-gettime-old-darwin: anchor not found (libuv changed under the pin — re-derive the fixup)');
  }
  fs.writeFileSync(f, src.replace(anchor, anchor + guard));
  console.log('fixup libuv-clock-gettime-old-darwin: applied');
}

function fixupLibuvFsTimesOldDarwin(dir) {
  // The POSIX-2008 file-time APIs libuv's fs.c leans on are late-macOS:
  // utimensat/futimens/UTIME_NOW/UTIME_OMIT are 10.13+, AT_FDCWD/
  // AT_SYMLINK_NOFOLLOW are 10.10+, and pre-10.8 scandir() has the old
  // prototypes (non-const filter, void* comparator) — all hard errors
  // against the 10.6 SDK (darwin floor walk, 2026-07-11). Emulate the
  // timestamp calls on µs-precision utimes()/futimes()/lutimes() (10.5+),
  // resolving UTIME_NOW/UTIME_OMIT via gettimeofday/[lf]stat; cast the
  // scandir callbacks behind an SDK-age guard. No-op everywhere else;
  // libuv upstream candidate (upstream carried exactly these fallbacks in
  // its pre-1.30 era).
  const f = path.join(dir, 'deps/libuv/src/unix/fs.c');
  const src = fs.readFileSync(f, 'utf8');
  const anchor = '#include "internal.h"\n';
  const guard = '#if defined(__APPLE__)\n'
    + '# include <AvailabilityMacros.h>\n'
    + '# if MAC_OS_X_VERSION_MAX_ALLOWED < 101300 || MAC_OS_X_VERSION_MIN_REQUIRED < 101300\n'
    + '#  include <sys/time.h>\n'
    + '#  include <sys/stat.h>\n'
    + '#  include <string.h>\n'
    + '#  ifndef UTIME_NOW\n'
    + '#   define UTIME_NOW -1\n'
    + '#  endif\n'
    + '#  ifndef UTIME_OMIT\n'
    + '#   define UTIME_OMIT -2\n'
    + '#  endif\n'
    + '#  ifndef AT_FDCWD\n'
    + '#   define AT_FDCWD -2\n'
    + '#  endif\n'
    + '#  ifndef AT_SYMLINK_NOFOLLOW\n'
    + '#   define AT_SYMLINK_NOFOLLOW 0x0020\n'
    + '#  endif\n'
    + '/* utimensat()/futimens() are macOS 10.13+; emulate on the µs-precision\n'
    + ' * utimes() family (10.5+), resolving UTIME_NOW/UTIME_OMIT here. */\n'
    + 'static int uv__ts_to_tv_compat(const struct timespec* ts, struct timeval* tv,\n'
    + '                               const struct stat* cur, int is_mtime) {\n'
    + '  if (ts->tv_nsec == UTIME_NOW)\n'
    + '    return gettimeofday(tv, NULL);\n'
    + '  if (ts->tv_nsec == UTIME_OMIT) {\n'
    + '    tv->tv_sec = is_mtime ? cur->st_mtime : cur->st_atime;\n'
    + '    tv->tv_usec = 0;\n'
    + '    return 0;\n'
    + '  }\n'
    + '  tv->tv_sec = ts->tv_sec;\n'
    + '  tv->tv_usec = ts->tv_nsec / 1000;\n'
    + '  return 0;\n'
    + '}\n'
    + 'static int uv__utimensat_compat(int dirfd, const char* path,\n'
    + '                                const struct timespec ts[2], int flags) {\n'
    + '  struct stat cur;\n'
    + '  struct timeval tv[2];\n'
    + '  if (dirfd != AT_FDCWD) {\n'
    + '    errno = ENOSYS;\n'
    + '    return -1;\n'
    + '  }\n'
    + '  memset(&cur, 0, sizeof(cur));\n'
    + '  if (ts[0].tv_nsec == UTIME_OMIT || ts[1].tv_nsec == UTIME_OMIT) {\n'
    + '    int r = (flags & AT_SYMLINK_NOFOLLOW) ? lstat(path, &cur) : stat(path, &cur);\n'
    + '    if (r)\n'
    + '      return r;\n'
    + '  }\n'
    + '  if (uv__ts_to_tv_compat(&ts[0], &tv[0], &cur, 0) ||\n'
    + '      uv__ts_to_tv_compat(&ts[1], &tv[1], &cur, 1))\n'
    + '    return -1;\n'
    + '#if defined(MAC_OS_X_VERSION_MAX_ALLOWED) && MAC_OS_X_VERSION_MAX_ALLOWED < 1050\n'
    + '  /* No lutimes() before 10.5: honest ENOSYS for the nofollow form. */\n'
    + '  if (flags & AT_SYMLINK_NOFOLLOW) {\n'
    + '    errno = ENOSYS;\n'
    + '    return -1;\n'
    + '  }\n'
    + '  return utimes(path, tv);\n'
    + '#else\n'
    + '  return (flags & AT_SYMLINK_NOFOLLOW) ? lutimes(path, tv) : utimes(path, tv);\n'
    + '#endif\n'
    + '}\n'
    + 'static int uv__futimens_compat(int fd, const struct timespec ts[2]) {\n'
    + '  struct stat cur;\n'
    + '  struct timeval tv[2];\n'
    + '  memset(&cur, 0, sizeof(cur));\n'
    + '  if (ts[0].tv_nsec == UTIME_OMIT || ts[1].tv_nsec == UTIME_OMIT)\n'
    + '    if (fstat(fd, &cur))\n'
    + '      return -1;\n'
    + '  if (uv__ts_to_tv_compat(&ts[0], &tv[0], &cur, 0) ||\n'
    + '      uv__ts_to_tv_compat(&ts[1], &tv[1], &cur, 1))\n'
    + '    return -1;\n'
    + '  return futimes(fd, tv);\n'
    + '}\n'
    + '#  define utimensat uv__utimensat_compat\n'
    + '#  define futimens uv__futimens_compat\n'
    + '# endif\n'
    + '#endif\n';
  const scandirOld = '  n = scandir(req->path, &dents, uv__fs_scandir_filter, uv__fs_scandir_sort);\n';
  const scandirNew = '#if defined(__APPLE__) && defined(MAC_OS_X_VERSION_MAX_ALLOWED) && MAC_OS_X_VERSION_MAX_ALLOWED < 1080\n'
    + '  /* pre-10.8 scandir prototypes: non-const filter, void* comparator. */\n'
    + '  n = scandir(req->path, &dents,\n'
    + '              (int (*)(struct dirent*)) uv__fs_scandir_filter,\n'
    + '              (int (*)(const void*, const void*)) uv__fs_scandir_sort);\n'
    + '#else\n'
    + '  n = scandir(req->path, &dents, uv__fs_scandir_filter, uv__fs_scandir_sort);\n'
    + '#endif\n';
  if (src.includes('uv__utimensat_compat')) {
    console.log('fixup libuv-fs-times-old-darwin: already applied');
    return;
  }
  if (!src.includes(anchor) || !src.includes(scandirOld)) {
    throw new Error('fixup libuv-fs-times-old-darwin: anchor not found (libuv changed under the pin — re-derive the fixup)');
  }
  fs.writeFileSync(f, src.replace(anchor, anchor + guard).replace(scandirOld, scandirNew));
  console.log('fixup libuv-fs-times-old-darwin: applied');
}

function fixupLibuvSpawnCloexecOldDarwin(dir) {
  // libuv's posix_spawn path guards two 10.7+ Apple extensions with a bare
  // #ifdef __APPLE__: POSIX_SPAWN_CLOEXEC_DEFAULT and
  // posix_spawn_file_actions_addinherit_np — both undeclared in the 10.6
  // SDK (darwin floor walk, 2026-07-11). They arrived together and only
  // make sense together (addinherit_np un-cloexecs what CLOEXEC_DEFAULT
  // closed), so guard both on the macro's presence: compiled out against
  // a 10.6 SDK (adddup2 covers every fd; children may inherit stray
  // non-cloexec fds, the pre-10.7 status quo — libuv marks its own fds
  // cloexec at creation), byte-identical on every modern SDK. libuv
  // upstream candidate.
  const f = path.join(dir, 'deps/libuv/src/unix/process.c');
  const src = fs.readFileSync(f, 'utf8');
  const flagsOld = '#ifdef __APPLE__\n  flags |= POSIX_SPAWN_CLOEXEC_DEFAULT;\n#endif\n';
  const flagsNew = '#if defined(__APPLE__) && defined(POSIX_SPAWN_CLOEXEC_DEFAULT)\n  flags |= POSIX_SPAWN_CLOEXEC_DEFAULT;\n#endif\n';
  const inheritOld = '#ifdef __APPLE__\n    if (fd == use_fd)\n        err = posix_spawn_file_actions_addinherit_np(actions, fd);\n    else\n#endif\n';
  const inheritNew = '#if defined(__APPLE__) && defined(POSIX_SPAWN_CLOEXEC_DEFAULT)\n    if (fd == use_fd)\n        err = posix_spawn_file_actions_addinherit_np(actions, fd);\n    else\n#endif\n';
  if (src.includes(flagsNew) && src.includes(inheritNew)) {
    console.log('fixup libuv-spawn-cloexec-old-darwin: already applied');
    return;
  }
  if (!src.includes(flagsOld) || !src.includes(inheritOld)) {
    throw new Error('fixup libuv-spawn-cloexec-old-darwin: anchor not found (libuv changed under the pin — re-derive the fixup)');
  }
  fs.writeFileSync(f, src.replace(flagsOld, flagsNew).replace(inheritOld, inheritNew));
  console.log('fixup libuv-spawn-cloexec-old-darwin: applied');
}

function fixupMbedtlsMsTimeOldDarwin(dir) {
  // mbedtls' mbedtls_ms_time (platform_util.c) calls clock_gettime(
  // CLOCK_MONOTONIC) bare — macOS 10.12+, hard error against the 10.6 SDK
  // (darwin floor walk, 2026-07-11). Same emulation shape as the libuv
  // core.c compat: monotonic ms via Mach absolute time. mbedtls upstream
  // candidate.
  const f = path.join(dir, 'deps/mbedtls/library/platform_util.c');
  const src = fs.readFileSync(f, 'utf8');
  const anchor = '#include "mbedtls/platform_util.h"\n';
  const guard = '#if defined(__APPLE__)\n'
    + '# include <AvailabilityMacros.h>\n'
    + '# if MAC_OS_X_VERSION_MAX_ALLOWED < 101200 || MAC_OS_X_VERSION_MIN_REQUIRED < 101200\n'
    + '#  include <mach/mach_time.h>\n'
    + '#  include <time.h>\n'
    + '#  ifndef CLOCK_MONOTONIC\n'
    + '#   define CLOCK_MONOTONIC 6\n'
    + '#  endif\n'
    + '/* clock_gettime() is macOS 10.12+; emulate the one (monotonic) use in\n'
    + ' * this file via Mach absolute time for older SDKs/floors. */\n'
    + 'static int mbedtls_clock_gettime_compat(int clk, struct timespec* ts) {\n'
    + '  static mach_timebase_info_data_t tb;\n'
    + '  uint64_t t;\n'
    + '  (void) clk;\n'
    + '  if (tb.denom == 0)\n'
    + '    mach_timebase_info(&tb);\n'
    + '  t = mach_absolute_time() * tb.numer / tb.denom;\n'
    + '  ts->tv_sec = t / 1000000000ULL;\n'
    + '  ts->tv_nsec = t % 1000000000ULL;\n'
    + '  return 0;\n'
    + '}\n'
    + '#  define clock_gettime mbedtls_clock_gettime_compat\n'
    + '# endif\n'
    + '#endif\n';
  if (src.includes('mbedtls_clock_gettime_compat')) {
    console.log('fixup mbedtls-ms-time-old-darwin: already applied');
    return;
  }
  if (!src.includes(anchor)) {
    throw new Error('fixup mbedtls-ms-time-old-darwin: anchor not found (mbedtls changed under the pin — re-derive the fixup)');
  }
  fs.writeFileSync(f, src.replace(anchor, anchor + guard));
  console.log('fixup mbedtls-ms-time-old-darwin: applied');
}

function fixupLibuvUdpSsmOldDarwin(dir) {
  // libuv's source-specific-multicast support (struct ip_mreq_source,
  // IP_ADD_SOURCE_MEMBERSHIP, MCAST_JOIN_SOURCE_GROUP...) is guarded by a
  // platform exclusion list; macOS grew SSM in 10.7, so the 10.6 SDK needs
  // to join it (darwin floor walk, 2026-07-11). Feature-detect via the
  // IP_ADD_SOURCE_MEMBERSHIP macro (netinet/in.h arrives via uv.h before
  // both sites): old-darwin callers get the existing UV_ENOSYS branch,
  // every other platform is byte-identical. Nothing shipped uses SSM.
  // libuv upstream candidate. Applied to BOTH exclusion sites (helpers +
  // caller) via replaceAll-equivalent.
  const f = path.join(dir, 'deps/libuv/src/unix/udp.c');
  const src = fs.readFileSync(f, 'utf8');
  const old = '    !defined(QNX_IOPKT)\n';
  const neu = '    !defined(QNX_IOPKT) &&                                          \\\n'
    + '    (!defined(__APPLE__) || defined(IP_ADD_SOURCE_MEMBERSHIP))\n';
  if (src.includes('IP_ADD_SOURCE_MEMBERSHIP))')) {
    console.log('fixup libuv-udp-ssm-old-darwin: already applied');
    return;
  }
  const count = src.split(old).length - 1;
  if (count !== 2) {
    throw new Error(`fixup libuv-udp-ssm-old-darwin: expected 2 exclusion sites, found ${count} (libuv changed under the pin — re-derive the fixup)`);
  }
  fs.writeFileSync(f, src.split(old).join(neu));
  console.log('fixup libuv-udp-ssm-old-darwin: applied');
}

function fixupLibuvKqueueExceptOldDarwin(dir) {
  // libuv's POLLPRI/OOB kqueue plumbing picks EVFILT_EXCEPT+NOTE_OOB under
  // a bare #ifdef __APPLE__ (libuv/libuv#3947); the 10.6 SDK predates both
  // (darwin floor walk, 2026-07-11). Feature-detect the filter instead:
  // old darwin falls into the existing EV_OOBAND branch, which 10.6's
  // sys/event.h defines (as EV_FLAG1) — the exact path libuv used on macOS
  // before #3947. Both sites (registration + dispatch) swap identically.
  // libuv upstream candidate.
  const f = path.join(dir, 'deps/libuv/src/unix/kqueue.c');
  const src = fs.readFileSync(f, 'utf8');
  const newGuard = '#if defined(__APPLE__) && defined(EVFILT_EXCEPT)\n';
  // kqueue.c has other, unrelated #ifdef __APPLE__ sites — anchor each of
  // the two EVFILT ones on its own distinctive first comment line.
  const regOld = '#ifdef __APPLE__\n      /*\n       * Use EVFILT_EXCEPT+ NOTE_OOB';
  const regNew = newGuard + '      /*\n       * Use EVFILT_EXCEPT+ NOTE_OOB';
  const dispOld = '#ifdef __APPLE__\n      /* Match EVFILT_EXCEPT used above for macOS. */';
  const dispNew = newGuard + '      /* Match EVFILT_EXCEPT used above for macOS. */';
  if (src.includes(newGuard)) {
    console.log('fixup libuv-kqueue-except-old-darwin: already applied');
    return;
  }
  if (!src.includes(regOld) || !src.includes(dispOld)) {
    throw new Error('fixup libuv-kqueue-except-old-darwin: anchor not found (libuv changed under the pin — re-derive the fixup)');
  }
  fs.writeFileSync(f, src.replace(regOld, regNew).replace(dispOld, dispNew));
  console.log('fixup libuv-kqueue-except-old-darwin: applied');
}

function fixupLwsScandirOldDarwin(dir) {
  // lws' dir scanner passes a const-correct filter to scandir(); pre-10.8
  // macOS declares scandir with a non-const filter (and alphasort with
  // void* args), a hard error under modern clang's
  // -Wincompatible-function-pointer-types (darwin floor walk, 2026-07-11).
  // Same SDK-age cast guard as the libuv fs.c scandir compat. lws upstream
  // candidate.
  const f = path.join(dir, 'deps/libwebsockets/lib/misc/dir.c');
  const src = fs.readFileSync(f, 'utf8');
  const inclAnchor = '#include "private-lib-core.h"\n';
  const incl = '#if defined(__APPLE__)\n#include <AvailabilityMacros.h>\n#endif\n';
  const old = '\tn = scandir((char *)info->dirpath, &namelist, filter, alphasort);\n';
  const neu = '#if defined(__APPLE__) && defined(MAC_OS_X_VERSION_MAX_ALLOWED) && MAC_OS_X_VERSION_MAX_ALLOWED < 1080\n'
    + '\t/* pre-10.8 scandir prototypes: non-const filter, void* comparator. */\n'
    + '\tn = scandir((char *)info->dirpath, &namelist,\n'
    + '\t\t    (int (*)(struct dirent *))filter,\n'
    + '\t\t    (int (*)(const void *, const void *))alphasort);\n'
    + '#else\n'
    + '\tn = scandir((char *)info->dirpath, &namelist, filter, alphasort);\n'
    + '#endif\n';
  if (src.includes('(int (*)(struct dirent *))filter')) {
    console.log('fixup lws-scandir-old-darwin: already applied');
    return;
  }
  if (!src.includes(old) || !src.includes(inclAnchor)) {
    throw new Error('fixup lws-scandir-old-darwin: anchor not found (lws changed under the pin — re-derive the fixup)');
  }
  fs.writeFileSync(f, src.replace(inclAnchor, inclAnchor + incl).replace(old, neu));
  console.log('fixup lws-scandir-old-darwin: applied');
}

function fixupLibuvMsgXOldDarwin(dir) {
  // libuv's darwin batch-UDP path calls Apple's private recvmsg_x/
  // sendmsg_x syscalls (~10.10+), declared by its own darwin-syscalls.h
  // unconditionally — the 10.6 libSystem stub lacks the symbols, so the
  // final link dies (darwin floor walk, 2026-07-11). Feature-gate the
  // declarations (UV__DARWIN_HAS_MSG_X) and add that condition to the
  // three mmsg guard sites in udp.c; old floors take the existing
  // single-message fallbacks (UV_ENOSYS branch / plain sendmsg loop /
  // using_recvmmsg=0), every other platform byte-identical. libuv
  // upstream candidate.
  const h = path.join(dir, 'deps/libuv/src/unix/darwin-syscalls.h');
  let hs = fs.readFileSync(h, 'utf8');
  const declOld = 'ssize_t recvmsg_x(int s, const struct mmsghdr* msgp, u_int cnt, int flags);\n'
    + 'ssize_t sendmsg_x(int s, const struct mmsghdr* msgp, u_int cnt, int flags);\n';
  const declNew = '#include <AvailabilityMacros.h>\n'
    + '#if MAC_OS_X_VERSION_MAX_ALLOWED >= 101000 && MAC_OS_X_VERSION_MIN_REQUIRED >= 101000\n'
    + '#define UV__DARWIN_HAS_MSG_X 1\n'
    + 'ssize_t recvmsg_x(int s, const struct mmsghdr* msgp, u_int cnt, int flags);\n'
    + 'ssize_t sendmsg_x(int s, const struct mmsghdr* msgp, u_int cnt, int flags);\n'
    + '#endif\n';
  const f = path.join(dir, 'deps/libuv/src/unix/udp.c');
  let src = fs.readFileSync(f, 'utf8');
  const applePart = 'defined(__APPLE__)';
  const applePartNew = '(defined(__APPLE__) && defined(UV__DARWIN_HAS_MSG_X))';
  const site1Old = '#if defined(__linux__) || defined(__FreeBSD__) || defined(__APPLE__)\n  struct sockaddr_in6 peers[20];';
  const site2Old = 'int uv_udp_using_recvmmsg(const uv_udp_t* handle) {\n#if defined(__linux__) || defined(__FreeBSD__) || defined(__APPLE__)\n';
  const site3Old = '#if defined(__linux__) || defined(__FreeBSD__) || defined(__APPLE__) || \\\n  (defined(__sun__) && defined(MSG_WAITFORONE)) || defined(__QNX__)\n';
  if (hs.includes('UV__DARWIN_HAS_MSG_X')) {
    console.log('fixup libuv-msg-x-old-darwin: already applied');
    return;
  }
  if (!hs.includes(declOld) || !src.includes(site1Old) || !src.includes(site2Old) || !src.includes(site3Old)) {
    throw new Error('fixup libuv-msg-x-old-darwin: anchor not found (libuv changed under the pin — re-derive the fixup)');
  }
  fs.writeFileSync(h, hs.replace(declOld, declNew));
  src = src.replace(site1Old, site1Old.replace(applePart, applePartNew));
  src = src.replace(site2Old, site2Old.replace(applePart, applePartNew));
  src = src.replace(site3Old, site3Old.replace(applePart, applePartNew));
  fs.writeFileSync(f, src);
  console.log('fixup libuv-msg-x-old-darwin: applied');
}

// ---- Tiger-walk fixups (darwin floor 10.4, spec 2026-07-11-darwin-x86-
// tiger-walk): the pre-10.5 era. Same discipline as the 10.6 family —
// every guard keys on SDK age (MAC_OS_X_VERSION_MAX_ALLOWED) or floor
// (MIN_REQUIRED / __ENVIRONMENT_..._MIN_REQUIRED__), never platform names;
// modern builds compile byte-identical code. All upstream candidates.

function fixupLibuvUnsetenvOldDarwin(dir) {
  // Tiger's unsetenv() returns void — the POSIX int-returning form arrived
  // with 10.5's UNIX03 conformance. Comparing void to 0 is a hard error.
  const f = path.join(dir, 'deps/libuv/src/unix/core.c');
  const src = fs.readFileSync(f, 'utf8');
  const old = '  if (unsetenv(name) != 0)\n    return UV__ERR(errno);\n';
  const neu = '#if defined(__APPLE__) && defined(MAC_OS_X_VERSION_MAX_ALLOWED) && MAC_OS_X_VERSION_MAX_ALLOWED < 1050\n'
    + '  /* Tiger\'s unsetenv() returns void (the int form is 10.5+). */\n'
    + '  unsetenv(name);\n'
    + '#else\n'
    + '  if (unsetenv(name) != 0)\n    return UV__ERR(errno);\n'
    + '#endif\n';
  if (src.includes('unsetenv() returns void')) {
    console.log('fixup libuv-unsetenv-old-darwin: already applied');
    return;
  }
  if (!src.includes(old)) {
    throw new Error('fixup libuv-unsetenv-old-darwin: anchor not found (libuv changed under the pin — re-derive the fixup)');
  }
  fs.writeFileSync(f, src.replace(old, neu));
  console.log('fixup libuv-unsetenv-old-darwin: applied');
}

function fixupLibuvNprocsOldDarwin(dir) {
  // _SC_NPROCESSORS_ONLN reached sysconf in 10.5; Tiger asks sysctl
  // (CTL_HW/HW_AVAILCPU) instead — Core Duo Tigers are real, defaulting
  // to 1 would be wrong.
  const f = path.join(dir, 'deps/libuv/src/unix/core.c');
  const src = fs.readFileSync(f, 'utf8');
  const inclAnchor = '#include <time.h> /* clock_gettime */\n';
  const incl = '#if defined(__APPLE__)\n# include <sys/sysctl.h>\n#endif\n';
  const old = '  if (rc < 0)\n    rc = sysconf(_SC_NPROCESSORS_ONLN);\n';
  const neu = '#if defined(__APPLE__) && !defined(_SC_NPROCESSORS_ONLN)\n'
    + '  /* Tiger\'s sysconf lacks _SC_NPROCESSORS_ONLN (10.5+); ask sysctl. */\n'
    + '  if (rc < 0) {\n'
    + '    int nprocs_mib[2] = { CTL_HW, HW_AVAILCPU };\n'
    + '    int nprocs_sysctl;\n'
    + '    size_t nprocs_len = sizeof(nprocs_sysctl);\n'
    + '    if (sysctl(nprocs_mib, 2, &nprocs_sysctl, &nprocs_len, NULL, 0) == 0 &&\n'
    + '        nprocs_sysctl > 0)\n'
    + '      rc = nprocs_sysctl;\n'
    + '  }\n'
    + '#else\n'
    + '  if (rc < 0)\n    rc = sysconf(_SC_NPROCESSORS_ONLN);\n'
    + '#endif\n';
  if (src.includes('HW_AVAILCPU')) {
    console.log('fixup libuv-nprocs-old-darwin: already applied');
    return;
  }
  if (!src.includes(old) || !src.includes(inclAnchor)) {
    throw new Error('fixup libuv-nprocs-old-darwin: anchor not found (libuv changed under the pin — re-derive the fixup)');
  }
  fs.writeFileSync(f, src.replace(inclAnchor, inclAnchor + incl).replace(old, neu));
  console.log('fixup libuv-nprocs-old-darwin: applied');
}

function fixupLibuvBirthtimeOldDarwin(dir) {
  // Tiger's struct stat has no st_birthtimespec (10.5+); ctime is the
  // closest available truth for uv_stat_t's birthtim.
  const f = path.join(dir, 'deps/libuv/src/unix/fs.c');
  const src = fs.readFileSync(f, 'utf8');
  const old = '  dst->st_birthtim.tv_sec = src->st_birthtimespec.tv_sec;\n'
    + '  dst->st_birthtim.tv_nsec = src->st_birthtimespec.tv_nsec;\n';
  const neu = '#if defined(MAC_OS_X_VERSION_MAX_ALLOWED) && MAC_OS_X_VERSION_MAX_ALLOWED < 1050\n'
    + '  /* Tiger\'s struct stat has no birthtime; ctime is the closest truth. */\n'
    + '  dst->st_birthtim.tv_sec = src->st_ctimespec.tv_sec;\n'
    + '  dst->st_birthtim.tv_nsec = src->st_ctimespec.tv_nsec;\n'
    + '#else\n'
    + old
    + '#endif\n';
  if (src.includes('no birthtime; ctime')) {
    console.log('fixup libuv-birthtime-old-darwin: already applied');
    return;
  }
  if (!src.includes(old)) {
    throw new Error('fixup libuv-birthtime-old-darwin: anchor not found (libuv changed under the pin — re-derive the fixup)');
  }
  fs.writeFileSync(f, src.replace(old, neu));
  console.log('fixup libuv-birthtime-old-darwin: applied');
}

function fixupLibuvSendfileOldDarwin(dir) {
  // Darwin sendfile(2) arrived in 10.5. On Tiger, take the read/write
  // emulation path libuv already has (the EINVAL fallback below the call).
  const f = path.join(dir, 'deps/libuv/src/unix/fs.c');
  const src = fs.readFileSync(f, 'utf8');
  const old = '    len = req->bufsml[0].len;\n'
    + '    r = sendfile(in_fd, out_fd, req->off, &len, NULL, 0);\n';
  const neu = '#if defined(MAC_OS_X_VERSION_MAX_ALLOWED) && MAC_OS_X_VERSION_MAX_ALLOWED < 1050\n'
    + '    /* sendfile(2) is 10.5+; force the EINVAL branch into the\n'
    + '     * read/write emulation below. */\n'
    + '    len = 0;\n'
    + '    errno = EINVAL;\n'
    + '    r = -1;\n'
    + '#else\n'
    + old
    + '#endif\n';
  if (src.includes('sendfile(2) is 10.5+')) {
    console.log('fixup libuv-sendfile-old-darwin: already applied');
    return;
  }
  if (!src.includes(old)) {
    throw new Error('fixup libuv-sendfile-old-darwin: anchor not found (libuv changed under the pin — re-derive the fixup)');
  }
  fs.writeFileSync(f, src.replace(old, neu));
  console.log('fixup libuv-sendfile-old-darwin: applied');
}

function fixupLibuvThreadSetnameOldDarwin(dir) {
  // pthread_setname_np is 10.6+. Thread names are advisory — no-op below.
  const f = path.join(dir, 'deps/libuv/src/unix/thread.c');
  const src = fs.readFileSync(f, 'utf8');
  const old = '  int err = pthread_setname_np(namebuf);\n'
    + '  if (err)\n'
    + '    return UV__ERR(errno);\n'
    + '  return 0;\n';
  const neu = '#if defined(__ENVIRONMENT_MAC_OS_X_VERSION_MIN_REQUIRED__) && __ENVIRONMENT_MAC_OS_X_VERSION_MIN_REQUIRED__ < 1060\n'
    + '  /* pthread_setname_np is 10.6+; names are advisory — no-op below. */\n'
    + '  (void) namebuf;\n'
    + '  return 0;\n'
    + '#else\n'
    + old
    + '#endif\n';
  if (src.includes('names are advisory')) {
    console.log('fixup libuv-thread-setname-old-darwin: already applied');
    return;
  }
  if (!src.includes(old)) {
    throw new Error('fixup libuv-thread-setname-old-darwin: anchor not found (libuv changed under the pin — re-derive the fixup)');
  }
  fs.writeFileSync(f, src.replace(old, neu));
  console.log('fixup libuv-thread-setname-old-darwin: applied');
}

function fixupLibuvNoPosixSpawnOldDarwin(dir) {
  // Tiger has NO posix_spawn (it is 10.5+) — the spawn-model axis. libuv
  // already carries a complete fork/exec sibling selected at runtime; this
  // gates the entire posix_spawn machinery (types, helpers, the fast-path
  // attempt in the chooser) behind UV__HAVE_POSIX_SPAWN so pre-10.5
  // SDKs/floors compile the fork path alone. Four pure insertions/swaps;
  // byte-identical everywhere else. libuv upstream candidate — and the
  // same shape serves every no-spawn paleo-POSIX target (A/UX, IRIX).
  const f = path.join(dir, 'deps/libuv/src/unix/process.c');
  const src = fs.readFileSync(f, 'utf8');
  if (src.includes('UV__HAVE_POSIX_SPAWN')) {
    console.log('fixup libuv-no-posix-spawn-old-darwin: already applied');
    return;
  }
  const inclOld = '#include <spawn.h>\n';
  const inclNew = '#if defined(__APPLE__)\n'
    + '# include <AvailabilityMacros.h>\n'
    + '# if MAC_OS_X_VERSION_MAX_ALLOWED >= 1050 && MAC_OS_X_VERSION_MIN_REQUIRED >= 1050\n'
    + '#  define UV__HAVE_POSIX_SPAWN 1\n'
    + '# endif\n'
    + '#else\n'
    + '# define UV__HAVE_POSIX_SPAWN 1\n'
    + '#endif\n'
    + '#ifdef UV__HAVE_POSIX_SPAWN\n'
    + '#include <spawn.h>\n'
    + '#endif\n';
  const stateStart = 'static uv_once_t posix_spawn_init_once = UV_ONCE_INIT;\n';
  const stateEnd = '} posix_spawn_fncs;\n';
  const machineryStart = '#if defined(__APPLE__)\nstatic void uv__spawn_init_can_use_setsid(void) {\n';
  const forkFn = 'static int uv__spawn_and_init_child_fork(const uv_process_options_t* options,\n';
  const chooserStart = '  uv_once(&posix_spawn_init_once, uv__spawn_init_posix_spawn);\n';
  const chooserEnd = '  if (err != UV_ENOSYS)\n    return err;\n';
  for (const [name, a] of [['include', inclOld], ['state-start', stateStart], ['state-end', stateEnd],
    ['machinery-start', machineryStart], ['fork-fn', forkFn], ['chooser-start', chooserStart], ['chooser-end', chooserEnd]]) {
    if (!src.includes(a)) throw new Error(`fixup libuv-no-posix-spawn-old-darwin: anchor '${name}' not found (libuv changed under the pin — re-derive the fixup)`);
  }
  const out = src
    .replace(inclOld, inclNew)
    .replace(stateStart, '#ifdef UV__HAVE_POSIX_SPAWN\n' + stateStart)
    .replace(stateEnd, stateEnd + '#endif  /* UV__HAVE_POSIX_SPAWN */\n')
    .replace(machineryStart, '#ifdef UV__HAVE_POSIX_SPAWN\n' + machineryStart)
    .replace(forkFn, '#endif  /* UV__HAVE_POSIX_SPAWN */\n\n' + forkFn)
    .replace(chooserStart, '#ifdef UV__HAVE_POSIX_SPAWN\n' + chooserStart)
    .replace(chooserEnd, chooserEnd + '#endif  /* UV__HAVE_POSIX_SPAWN */\n');
  fs.writeFileSync(f, out);
  console.log('fixup libuv-no-posix-spawn-old-darwin: applied');
}

function fixupMbedtlsDarwinCSource(dir) {
  // mbedtls defines _POSIX_C_SOURCE to surface gmtime_r on glibc; Tiger's
  // time.h hides gmtime_r whenever _POSIX_C_SOURCE is defined AT ALL
  // (`!defined(_ANSI_SOURCE) && !defined(_POSIX_C_SOURCE)` — the
  // _DARWIN_C_SOURCE escape hatch only arrived with 10.5's UNIX03 work).
  // Apple headers expose gmtime_r by default, so simply do not request
  // strict POSIX there — the same shape as the __OpenBSD__ exclusion the
  // file already carries. mbedtls upstream candidate.
  const f = path.join(dir, 'deps/mbedtls/library/platform_util.c');
  const src = fs.readFileSync(f, 'utf8');
  const old = '#if !defined(_POSIX_C_SOURCE) && !defined(__OpenBSD__)\n';
  const neu = '#if !defined(_POSIX_C_SOURCE) && !defined(__OpenBSD__) && !defined(__APPLE__)\n';
  if (src.includes(neu)) {
    console.log('fixup mbedtls-darwin-c-source: already applied');
    return;
  }
  if (!src.includes(old)) {
    throw new Error('fixup mbedtls-darwin-c-source: anchor not found (mbedtls changed under the pin — re-derive the fixup)');
  }
  fs.writeFileSync(f, src.replace(old, neu));
  console.log('fixup mbedtls-darwin-c-source: applied');
}

function fixupLibuvThreadGetnameOldDarwin(dir) {
  // pthread_getname_np is 10.6+ (the getname sibling of the setname
  // fixup). Names are advisory: report an empty name below.
  const f = path.join(dir, 'deps/libuv/src/unix/thread.c');
  const src = fs.readFileSync(f, 'utf8');
  const old = '  char thread_name[UV_PTHREAD_MAX_NAMELEN_NP];\n'
    + '  if (pthread_getname_np(*tid, thread_name, sizeof(thread_name)) != 0)\n'
    + '    return UV__ERR(errno);\n';
  const neu = '  char thread_name[UV_PTHREAD_MAX_NAMELEN_NP];\n'
    + '#if defined(__ENVIRONMENT_MAC_OS_X_VERSION_MIN_REQUIRED__) && __ENVIRONMENT_MAC_OS_X_VERSION_MIN_REQUIRED__ < 1060\n'
    + '  /* pthread_getname_np is 10.6+; report an empty (advisory) name. */\n'
    + '  thread_name[0] = \'\\0\';\n'
    + '#else\n'
    + '  if (pthread_getname_np(*tid, thread_name, sizeof(thread_name)) != 0)\n'
    + '    return UV__ERR(errno);\n'
    + '#endif\n';
  if (src.includes('report an empty (advisory) name')) {
    console.log('fixup libuv-thread-getname-old-darwin: already applied');
    return;
  }
  if (!src.includes(old)) {
    throw new Error('fixup libuv-thread-getname-old-darwin: anchor not found (libuv changed under the pin — re-derive the fixup)');
  }
  fs.writeFileSync(f, src.replace(old, neu));
  console.log('fixup libuv-thread-getname-old-darwin: applied');
}

function fixupLibuvTtyPtyOldDarwin(dir) {
  // TIOCPTYGNAME (pty-master detection ioctl) is 10.5+; Tiger takes the
  // generic ptsname() fallback branch the function already carries (and
  // Tiger's stdlib.h declares ptsname — verified in the 10.4u SDK).
  const f = path.join(dir, 'deps/libuv/src/unix/tty.c');
  const src = fs.readFileSync(f, 'utf8');
  const old = '#elif defined(__APPLE__)\n  char dummy[256];\n\n  result = ioctl(fd, TIOCPTYGNAME, &dummy) != 0;\n';
  const neu = '#elif defined(__APPLE__) && defined(TIOCPTYGNAME)\n  char dummy[256];\n\n  result = ioctl(fd, TIOCPTYGNAME, &dummy) != 0;\n';
  if (src.includes('defined(__APPLE__) && defined(TIOCPTYGNAME)')) {
    console.log('fixup libuv-tty-pty-old-darwin: already applied');
    return;
  }
  if (!src.includes(old)) {
    throw new Error('fixup libuv-tty-pty-old-darwin: anchor not found (libuv changed under the pin — re-derive the fixup)');
  }
  fs.writeFileSync(f, src.replace(old, neu));
  console.log('fixup libuv-tty-pty-old-darwin: applied');
}

function fixupLwsDarwinCSource(dir) {
  // lws' core-net private header requests strict _POSIX_C_SOURCE; Tiger's
  // sys/dirent.h hides ALL the DT_* constants under
  // `#ifndef _POSIX_C_SOURCE` (pre-UNIX03 headers, no _DARWIN_C_SOURCE
  // escape), killing lws/misc/dir.c. Apple headers expose everything lws
  // needs by default — do not request strict POSIX there. Same shape as
  // the mbedtls fixup. lws upstream candidate.
  const f = path.join(dir, 'deps/libwebsockets/lib/core-net/private-lib-core-net.h');
  const src = fs.readFileSync(f, 'utf8');
  const old = '#if !defined(_POSIX_C_SOURCE)\n#define _POSIX_C_SOURCE 200112L\n#endif\n';
  const neu = '#if !defined(_POSIX_C_SOURCE) && !defined(__APPLE__)\n#define _POSIX_C_SOURCE 200112L\n#endif\n';
  if (src.includes(neu)) {
    console.log('fixup lws-darwin-c-source: already applied');
    return;
  }
  if (!src.includes(old)) {
    throw new Error('fixup lws-darwin-c-source: anchor not found (lws changed under the pin — re-derive the fixup)');
  }
  fs.writeFileSync(f, src.replace(old, neu));
  console.log('fixup lws-darwin-c-source: applied');
}

function fixupPosixSocketLibprocOldDarwin(dir) {
  // txiki's mod_posix-socket.c uses libproc (proc_pidfdinfo) for socket
  // info on Apple — libproc.h is 10.5+. Tiger takes the portable
  // getsockopt(SO_TYPE) branch every non-Apple platform already uses
  // (best-effort fields, like the file's own SO_DOMAIN guards). txiki
  // upstream candidate.
  const f = path.join(dir, 'src/mod_posix-socket.c');
  const src = fs.readFileSync(f, 'utf8');
  const inclOld = '#ifdef __APPLE__\n#include <libproc.h>\n#include <sys/proc_info.h>\n#endif\n';
  const inclNew = '#ifdef __APPLE__\n'
    + '#include <AvailabilityMacros.h>\n'
    + '#if MAC_OS_X_VERSION_MAX_ALLOWED >= 1050 && MAC_OS_X_VERSION_MIN_REQUIRED >= 1050\n'
    + '#define TJS__HAVE_LIBPROC 1\n'
    + '#include <libproc.h>\n#include <sys/proc_info.h>\n'
    + '#endif\n'
    + '#endif\n';
  const useOld = '#ifdef __APPLE__\n    struct socket_fdinfo sock_fd_info;';
  const useNew = '#ifdef TJS__HAVE_LIBPROC\n    struct socket_fdinfo sock_fd_info;';
  if (src.includes('TJS__HAVE_LIBPROC')) {
    console.log('fixup posix-socket-libproc-old-darwin: already applied');
    return;
  }
  if (!src.includes(inclOld) || !src.includes(useOld)) {
    throw new Error('fixup posix-socket-libproc-old-darwin: anchor not found (mod_posix-socket.c changed under the pin — re-derive the fixup)');
  }
  fs.writeFileSync(f, src.replace(inclOld, inclNew).replace(useOld, useNew));
  console.log('fixup posix-socket-libproc-old-darwin: applied');
}

function fixupLibuvCloseNocancelOldDarwin(dir) {
  // libuv's uv__close_nocancel references the close$NOCANCEL[$UNIX2003]
  // libSystem symbol variants — both 10.5 inventions (Tiger's libSystem
  // has neither, verified: zero NOCANCEL/UNIX2003 symbols in the 10.4u
  // stub). Tiger gets plain close(); the cancelable-close quirk the
  // variant dodges doesn't exist there, and nothing in tjs uses pthread
  // cancellation anyway. libuv upstream candidate.
  const f = path.join(dir, 'deps/libuv/src/unix/core.c');
  const src = fs.readFileSync(f, 'utf8');
  const old = '#if defined(__LP64__) || TARGET_OS_IPHONE\n'
    + '  extern int close$NOCANCEL(int);\n'
    + '  return close$NOCANCEL(fd);\n';
  const neu = '#if defined(MAC_OS_X_VERSION_MAX_ALLOWED) && MAC_OS_X_VERSION_MAX_ALLOWED < 1050\n'
    + '  /* The $NOCANCEL/$UNIX2003 variants are 10.5 inventions; Tiger has\n'
    + '   * only plain close() (and no cancelable-close quirk to dodge). */\n'
    + '  return close(fd);\n'
    + '#elif defined(__LP64__) || TARGET_OS_IPHONE\n'
    + '  extern int close$NOCANCEL(int);\n'
    + '  return close$NOCANCEL(fd);\n';
  if (src.includes('10.5 inventions; Tiger has')) {
    console.log('fixup libuv-close-nocancel-old-darwin: already applied');
    return;
  }
  if (!src.includes(old)) {
    throw new Error('fixup libuv-close-nocancel-old-darwin: anchor not found (libuv changed under the pin — re-derive the fixup)');
  }
  fs.writeFileSync(f, src.replace(old, neu));
  console.log('fixup libuv-close-nocancel-old-darwin: applied');
}

function fixupQjsHrtimeOldDarwin(dir) {
  // quickjs-ng's js__hrtime_ns (cutils.h) calls clock_gettime(
  // CLOCK_MONOTONIC) bare — macOS 10.12+, hard error against the 10.6 SDK
  // (darwin floor walk, 2026-07-11). Older floors branch to Mach absolute
  // time, same conversion libuv uses. quickjs-ng upstream candidate.
  const f = path.join(dir, 'deps/quickjs/cutils.h');
  const src = fs.readFileSync(f, 'utf8');
  const anchor = '#ifdef __DJGPP\n  struct timeval tv;\n';
  const guard = '#if defined(__APPLE__) && defined(__ENVIRONMENT_MAC_OS_X_VERSION_MIN_REQUIRED__) && __ENVIRONMENT_MAC_OS_X_VERSION_MIN_REQUIRED__ < 101200\n'
    + '  /* clock_gettime() is macOS 10.12+; older floors use Mach absolute\n'
    + '   * time (mach/mach_time.h is included below). */\n'
    + '  static mach_timebase_info_data_t tb;\n'
    + '  if (tb.denom == 0)\n'
    + '    mach_timebase_info(&tb);\n'
    + '  return mach_absolute_time() * tb.numer / tb.denom;\n'
    + '#elif defined(__DJGPP)\n  struct timeval tv;\n';
  const inclAnchor = '#include <sys/time.h>\n';
  const incl = '#if defined(__APPLE__)\n#include <mach/mach_time.h>\n#endif\n';
  if (src.includes('__ENVIRONMENT_MAC_OS_X_VERSION_MIN_REQUIRED__ < 101200')) {
    console.log('fixup qjs-hrtime-old-darwin: already applied');
    return;
  }
  if (!src.includes(anchor) || !src.includes(inclAnchor)) {
    throw new Error('fixup qjs-hrtime-old-darwin: anchor not found (quickjs-ng changed under the pin — re-derive the fixup)');
  }
  fs.writeFileSync(f, src.replace(inclAnchor, inclAnchor + incl).replace(anchor, guard));
  console.log('fixup qjs-hrtime-old-darwin: applied');
}

function fixupAtomicShim(dir) {
  // 32-bit targets without libatomic (darwin-ppc; sparc before it) need a
  // fallback for the 8-byte __atomic_* calls quickjs-ng's Atomics builtin
  // emits — the cross toolchain has none, so the final link fails with
  // ___atomic_*_8 undefined. Add our pthread-mutex shim as a tjs source,
  // guarded by the CLODE_ATOMIC_SHIM cmake option (build-tjs sets it from
  // CLODE_TJS_ATOMIC_SHIM=1); a no-op for every native/64-bit leg.
  const shimSrc = path.join(repo, 'spike/quickjs/atomic-shim.c');
  fs.copyFileSync(shimSrc, path.join(dir, 'src/tjs-atomic-shim.c'));
  const f = path.join(dir, 'CMakeLists.txt');
  const src = fs.readFileSync(f, 'utf8');
  if (src.includes('CLODE_ATOMIC_SHIM')) {
    console.log('fixup atomic-shim: already applied');
    return;
  }
  const anchor = 'add_executable(tjs-cli';
  const inject = 'option(CLODE_ATOMIC_SHIM "Link a pthread __atomic_*_8 shim (32-bit targets lacking libatomic)" OFF)\n'
    + 'if(CLODE_ATOMIC_SHIM)\n    target_sources(tjs PRIVATE src/tjs-atomic-shim.c)\nendif()\n\n';
  if (!src.includes(anchor)) {
    throw new Error('fixup atomic-shim: anchor not found (CMakeLists.txt changed under the pin — re-derive)');
  }
  fs.writeFileSync(f, src.replace(anchor, inject + anchor));
  console.log('fixup atomic-shim: applied');
}

function fixupTjsCmakeWinStack(dir) {
  // txiki bumps tjs-cli's stack to 8MB with the MSVC linker flag /STACK:,
  // guarded on plain WIN32 — but mingw's GNU ld rejects /STACK: (reads it as
  // a filename). Make the WIN32 branch MSVC-vs-GNU aware. Inside the WIN32
  // guard, so no effect on any non-Windows leg. txiki upstream candidate.
  const f = path.join(dir, 'CMakeLists.txt');
  const src = fs.readFileSync(f, 'utf8');
  if (src.includes('-Wl,--stack,8388608')) {
    console.log('fixup tjs-cmake-win-stack: already applied');
    return;
  }
  const old = 'if(WIN32)\n    target_link_options(tjs-cli PRIVATE "/STACK:8388608")\nendif()';
  const neu = 'if(WIN32)\n'
    + '    if(MSVC)\n'
    + '        target_link_options(tjs-cli PRIVATE "/STACK:8388608")\n'
    + '    else()\n'
    + '        target_link_options(tjs-cli PRIVATE -Wl,--stack,8388608)\n'
    + '    endif()\n'
    + 'endif()';
  if (!src.includes(old)) {
    throw new Error('fixup tjs-cmake-win-stack: anchor not found (CMakeLists changed under the pin — re-derive)');
  }
  fs.writeFileSync(f, src.replace(old, neu));
  console.log('fixup tjs-cmake-win-stack: applied');
}

function fixupLwsTxpacerPthreadWin(dir) {
  // lws core-net/txpacer.c uses raw pthread inside #if LWS_HAVE_PTHREAD_H but
  // never #include <pthread.h> — on POSIX a platform header supplies it; on
  // mingw (winpthreads, the -posix variant) it does not, so pthread_t is an
  // unknown type. winpthreads provides the symbols; just add the include.
  // __MINGW32__-guarded → zero effect on every other leg (preprocessor drops
  // it). lws upstream candidate.
  const f = path.join(dir, 'deps/libwebsockets/lib/core-net/txpacer.c');
  const src = fs.readFileSync(f, 'utf8');
  if (src.includes('winpthreads: lws win platform header')) {
    console.log('fixup lws-txpacer-pthread-win: already applied');
    return;
  }
  const anchor = '#include "private-lib-core.h"\n\n#if defined(LWS_HAVE_PTHREAD_H)\n';
  const inject = anchor + '#if defined(__MINGW32__)\n'
    + '#include <pthread.h>  /* winpthreads: lws win platform header omits it */\n'
    + '#endif\n';
  if (!src.includes(anchor)) {
    throw new Error('fixup lws-txpacer-pthread-win: anchor not found (lws changed under the pin — re-derive)');
  }
  fs.writeFileSync(f, src.replace(anchor, inject));
  console.log('fixup lws-txpacer-pthread-win: applied');
}

function fixupModFsSyncMsvc(dir) {
  // cl.exe (MSVC-native Windows leg, Phase A CI proving run 2026-07-13) has
  // neither <dirent.h> nor <unistd.h> — mingw ships both as Win32 wrappers,
  // MSVC ships neither. txiki-sync-fs.patch (our own added module) includes
  // both unconditionally. _MSC_VER-guarded so mingw and every POSIX/darwin
  // leg keep the byte-identical <dirent.h>/<unistd.h> path; only cl.exe gets
  // the shim. dirent: minimal opendir/readdir/closedir over
  // FindFirstFileA/FindNextFileA/FindClose, just enough for the readdir
  // loop below (js_fss_readdir already skips "." and ".." itself, so the
  // shim returns them like POSIX readdir does). unistd: MSVC's <io.h>
  // (already included below, unconditionally under _WIN32) declares
  // read/write/close/access/unlink/lseek etc. as deprecated aliases for the
  // _-prefixed names, and <direct.h> (also already included) covers
  // mkdir/rmdir/getcwd — nothing else from unistd.h is used in this file.
  // realpath is NOT remapped here: js_fss_realpath already branches
  // _WIN32-vs-POSIX at the call site (_fullpath vs realpath), so a
  // `#define realpath` would be dead code, not a fix. Sync-fs upstream
  // candidate (see the patch header).
  const f = path.join(dir, 'src/mod_fs_sync.c');
  const src = fs.readFileSync(f, 'utf8');
  if (src.includes('MSVC has neither <dirent.h>')) {
    console.log('fixup mod-fs-sync-msvc: already applied');
    return;
  }
  const anchor = '#include "private.h"\n'
    + '#include "utils.h"\n'
    + '#include <dirent.h>\n'
    + '#include <errno.h>\n'
    + '#include <fcntl.h>\n'
    + '#include <limits.h>\n'
    + '#include <stdlib.h>\n'
    + '#include <string.h>\n'
    + '#include <sys/stat.h>\n'
    + '#include <unistd.h>\n'
    + '\n'
    + '/* ---- mingw/Win32 CRT gaps (Windows tjs port Phase 1) ---- */\n'
    + '#if defined(_WIN32)\n'
    + '#include <io.h>\n'
    + '#include <direct.h>\n'
    + '#endif';
  if (!src.includes(anchor)) {
    throw new Error('fixup mod-fs-sync-msvc: anchor not found (mod_fs_sync.c changed under the pin — re-derive the fixup)');
  }
  const direntShim = '#if defined(_MSC_VER)\n'
    + '/* MSVC has neither <dirent.h> nor <unistd.h> (mingw ships both as Win32\n'
    + ' * wrappers over the same Win32 APIs). Minimal opendir/readdir/closedir\n'
    + ' * shim over FindFirstFileA/FindNextFileA/FindClose — just enough for the\n'
    + ' * readdir loop below, which already skips "." and ".." itself, so the\n'
    + ' * shim need not filter them either. */\n'
    + '#include <windows.h>\n'
    + '#include <stdio.h>\n'
    + '#include <stdlib.h>\n'
    + '/* POSIX types MSVC lacks (mingw has both via its POSIX headers, so these\n'
    + ' * are _MSC_VER-only and never redefine there). mode_t: chmod(p,(mode_t)m)\n'
    + ' * casts to it and MSVC\'s chmod takes an int pmode, so int is the exact\n'
    + ' * fit. ssize_t: the js_fss_read/js_fss_write _WIN32 branches declare it;\n'
    + ' * Windows spells it SSIZE_T in <BaseTsd.h> (pulled in by <windows.h>\n'
    + ' * above). */\n'
    + 'typedef int mode_t;\n'
    + 'typedef SSIZE_T ssize_t;\n'
    + 'typedef struct DIR {\n'
    + '    HANDLE handle;\n'
    + '    WIN32_FIND_DATAA data;\n'
    + '    int first;\n'
    + '} DIR;\n'
    + 'struct dirent {\n'
    + '    char d_name[MAX_PATH];\n'
    + '};\n'
    + 'static DIR *opendir(const char *path) {\n'
    + '    char pattern[MAX_PATH];\n'
    + '    snprintf(pattern, sizeof(pattern), "%s\\\\*", path);\n'
    + '    pattern[sizeof(pattern) - 1] = \'\\0\';\n'
    + '    DIR *d = (DIR *)malloc(sizeof(DIR));\n'
    + '    if (!d) return NULL;\n'
    + '    d->handle = FindFirstFileA(pattern, &d->data);\n'
    + '    if (d->handle == INVALID_HANDLE_VALUE) { free(d); return NULL; }\n'
    + '    d->first = 1;\n'
    + '    return d;\n'
    + '}\n'
    + 'static struct dirent *readdir(DIR *d) {\n'
    + '    static struct dirent de;\n'
    + '    if (!d->first && !FindNextFileA(d->handle, &d->data)) return NULL;\n'
    + '    d->first = 0;\n'
    + '    snprintf(de.d_name, sizeof(de.d_name), "%s", d->data.cFileName);\n'
    + '    de.d_name[sizeof(de.d_name) - 1] = \'\\0\';\n'
    + '    return &de;\n'
    + '}\n'
    + 'static int closedir(DIR *d) {\n'
    + '    if (!d) return -1;\n'
    + '    FindClose(d->handle);\n'
    + '    free(d);\n'
    + '    return 0;\n'
    + '}\n'
    + '#else\n'
    + '#include <dirent.h>\n'
    + '#endif';
  const inject = '#if defined(_MSC_VER)\n'
    + '#ifndef _CRT_NONSTDC_NO_WARNINGS\n'
    + '#define _CRT_NONSTDC_NO_WARNINGS\n'
    + '#endif\n'
    + '#ifndef _CRT_SECURE_NO_WARNINGS\n'
    + '#define _CRT_SECURE_NO_WARNINGS\n'
    + '#endif\n'
    + '#endif\n'
    + '#include "private.h"\n'
    + '#include "utils.h"\n'
    + direntShim + '\n'
    + '#include <errno.h>\n'
    + '#include <fcntl.h>\n'
    + '#include <limits.h>\n'
    + '#include <stdlib.h>\n'
    + '#include <string.h>\n'
    + '#include <sys/stat.h>\n'
    + '#if !defined(_MSC_VER)\n'
    + '#include <unistd.h>\n'
    + '#endif\n'
    + '\n'
    + '/* ---- mingw/Win32 CRT gaps (Windows tjs port Phase 1) ---- */\n'
    + '#if defined(_WIN32)\n'
    + '#include <io.h>\n'
    + '#include <direct.h>\n'
    + '#endif';
  // MSVC's <sys/stat.h> defines the _S_IF* bits but NOT the POSIX S_IS*
  // test macros. stat_to_js uses S_ISREG/S_ISDIR/S_ISLNK; the file already
  // supplies an S_ISLNK fallback via #ifndef — join S_ISREG/S_ISDIR to that
  // same #ifndef block (mingw/POSIX already define all three, so the guards
  // make these inert there — no _MSC_VER needed, mirroring the existing
  // S_ISLNK). Without them MSVC parses S_ISREG(m) as an implicit function
  // call and the LINK fails (LNK2019, run 2026-07-13). <sys/stat.h> is
  // already included above these guards.
  const statAnchor = '#ifndef S_ISLNK\n#define S_ISLNK(m) (0)\n#endif';
  const statInject = '#ifndef S_ISREG\n#define S_ISREG(m) (((m) & _S_IFMT) == _S_IFREG)\n#endif\n'
    + '#ifndef S_ISDIR\n#define S_ISDIR(m) (((m) & _S_IFMT) == _S_IFDIR)\n#endif\n'
    + statAnchor;
  if (!src.includes(statAnchor)) {
    throw new Error('fixup mod-fs-sync-msvc: S_ISLNK anchor not found (mod_fs_sync.c changed under the pin — re-derive the fixup)');
  }
  fs.writeFileSync(f, src.replace(anchor, inject).replace(statAnchor, statInject));
  console.log('fixup mod-fs-sync-msvc: applied');
}

let tjsDir;
if (buildOnly) {
  // The patched tree was constructed by a prior --source-only run (possibly on
  // a different host — CI builds inside a chroot the host prepared for).
  tjsDir = path.join(vendor, 'txiki.js');
  if (!fs.existsSync(path.join(tjsDir, 'CMakeLists.txt'))) {
    throw new Error(`--build-only: no txiki.js tree at ${tjsDir} (run --source-only first, or set CLODE_TJS_VENDOR)`);
  }
} else {
  tjsDir = ensureCheckout('txiki.js', 'https://github.com/saghul/txiki.js.git');
  applyPatches(tjsDir, 'txiki-');
  // quickjs-ng patches apply to the submodule checkout (paths are relative
  // to deps/quickjs, matching their a/quickjs.c form). Wired into the
  // mainline 2026-07-11 (canonical-LE plan Task 1) — previously these were
  // guest-campaign patches applied by hand (sparc/M4 scripts); cpool-align
  // is pure alignment padding and js_exepath-netbsd is NetBSD-only, so
  // mainlining them is behavior-neutral for every published leg.
  applyPatches(path.join(tjsDir, 'deps/quickjs'), 'quickjs-ng-');
  fixupLwsDragonflySoPriority(tjsDir);
  fixupLwsIpv6PrefGuard(tjsDir);
  fixupMemMallocHOpenbsd(tjsDir);
  fixupLibuvSunosDefpath(tjsDir);
  fixupQjsSunosB64(tjsDir);
  fixupPosixSocketSunosMsghdr(tjsDir);
  fixupLibuvBsdForkSpawn(tjsDir);
  fixupLibuvMidnightbsd(tjsDir);
  fixupLwsHaikuMallocUsableSize(tjsDir);
  fixupLwsHaikuDirent(tjsDir);
  fixupLwsGetifaddrsPtrCast(tjsDir);
  fixupPosixSocketSockRdm(tjsDir);
  fixupTjsCmakeCxxOnlyForAda(tjsDir);
  fixupLibuvHrtimeOldDarwin(tjsDir);
  fixupLibuvStrnlenOldDarwin(tjsDir);
  fixupLibuvClockGettimeOldDarwin(tjsDir);
  fixupLibuvFsTimesOldDarwin(tjsDir);
  fixupLibuvSpawnCloexecOldDarwin(tjsDir);
  fixupLibuvUdpSsmOldDarwin(tjsDir);
  fixupLibuvMsgXOldDarwin(tjsDir);
  fixupLibuvKqueueExceptOldDarwin(tjsDir);
  fixupLwsScandirOldDarwin(tjsDir);
  fixupMbedtlsMsTimeOldDarwin(tjsDir);
  fixupQjsHrtimeOldDarwin(tjsDir);
  fixupLibuvUnsetenvOldDarwin(tjsDir);
  fixupLibuvNprocsOldDarwin(tjsDir);
  fixupLibuvBirthtimeOldDarwin(tjsDir);
  fixupLibuvSendfileOldDarwin(tjsDir);
  fixupLibuvThreadSetnameOldDarwin(tjsDir);
  fixupLibuvNoPosixSpawnOldDarwin(tjsDir);
  fixupLibuvThreadGetnameOldDarwin(tjsDir);
  fixupLibuvTtyPtyOldDarwin(tjsDir);
  fixupMbedtlsDarwinCSource(tjsDir);
  fixupLwsDarwinCSource(tjsDir);
  fixupPosixSocketLibprocOldDarwin(tjsDir);
  fixupLibuvCloseNocancelOldDarwin(tjsDir);
  fixupAtomicShim(tjsDir);
  fixupTjsCmakeWinStack(tjsDir);
  fixupLwsTxpacerPthreadWin(tjsDir);
  fixupModFsSyncMsvc(tjsDir);
}

// ---- big-endian bundle regen, part 1: esbuild the plain-JS intermediates ----
// txiki git-tracks src/bundles/c/** as pre-compiled LITTLE-ENDIAN quickjs
// bytecode arrays (18 files) and gitignores the src/bundles/js/** intermediates
// they came from. On a BIG-ENDIAN target the host-order bytecode checksum fails
// at first boot ("SyntaxError: checksum error" -> vm.c TJS_NewRuntimeInternal
// assert -> SIGABRT) — the sparc S2 Wall #4, same wall on s390x. The fix is to
// regenerate the .c natively (= target endianness) from the JS bundles.
//
// The esbuild half is endian-NEUTRAL text, so it runs here in the source phase
// on the fast native host (even for a cross-emulated guest leg) — exactly the
// txiki Makefile's esbuild rules, pinned esbuild. The tjsc half (target-native
// bytecode) runs in the build phase, gated on the target being big-endian.
// Faithfully ports spike/quickjs/qemu/guest-sparc-s2.sh's regen stage.
const JS_BUNDLES = [
  { entry: 'src/js/polyfills/index.js', out: 'src/bundles/js/core/polyfills.js', extra: [] },
  { entry: 'src/js/core/index.js', out: 'src/bundles/js/core/core.js', extra: [] },
  { entry: 'src/js/run-main/index.js', out: 'src/bundles/js/core/run-main.js', extra: [] },
  { entry: 'src/js/run-repl/repl.js', out: 'src/bundles/js/core/run-repl.js', extra: ['--log-override:direct-eval=silent'] },
];
function esbuildBundles(dir) {
  const esbuild = ensureEsbuild(dir);
  const stdlib = fs.readdirSync(path.join(dir, 'src/js/stdlib')).filter((f) => f.endsWith('.js'));
  const common = ['--target=esnext', '--platform=neutral', '--format=esm', '--main-fields=main,module', '--minify', '--keep-names'];
  const one = (entry, out, extra) => {
    fs.mkdirSync(path.join(dir, path.dirname(out)), { recursive: true });
    run(esbuild, [path.join(dir, entry), '--bundle', `--outfile=${path.join(dir, out)}`,
      '--external:tjs:*', ...extra, ...common], { cwd: dir, shell: process.platform === 'win32' });
  };
  for (const b of JS_BUNDLES) one(b.entry, b.out, b.extra);
  for (const f of stdlib) {
    one(`src/js/stdlib/${f}`, `src/bundles/js/stdlib/${f}`, ['--external:tjs:*', '--external:buffer', '--external:crypto']);
  }
  console.log(`esbuilt ${JS_BUNDLES.length + stdlib.length} plain-JS bundles for the BE regen path`);
}
// esbuild @ the txiki pin, resolved from the checkout's own node_modules
// (installed on demand — no repo-root dep, no npx network guess).
function ensureEsbuild(dir) {
  const pin = 'esbuild@0.28.1';
  const bin = path.join(dir, 'node_modules', '.bin', process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild');
  if (!fs.existsSync(bin)) {
    console.log(`installing ${pin} into the txiki checkout for the JS bundle regen ...`);
    run('npm', ['install', '--no-save', '--no-audit', '--no-fund', pin], { cwd: dir, shell: process.platform === 'win32' });
  }
  return bin;
}
if (buildOnly) {
  // The source phase already esbuilt these, possibly on a DIFFERENT-OS host
  // (the T2 VM legs sync the tree into a BSD/Solaris guest). The checkout's
  // node_modules carries the host-platform esbuild binary, which such a guest
  // cannot exec — so the build phase never runs esbuild; it only verifies the
  // source phase delivered the bundles the BE-regen path may need.
  const stdlib = fs.readdirSync(path.join(tjsDir, 'src/js/stdlib')).filter((f) => f.endsWith('.js'));
  const expected = [
    ...JS_BUNDLES.map((b) => b.out),
    ...stdlib.map((f) => `src/bundles/js/stdlib/${f}`),
  ];
  const missing = expected.filter((p) => !fs.existsSync(path.join(tjsDir, p)));
  if (missing.length) {
    throw new Error(`--build-only: ${missing.length} js bundle(s) missing (run --source-only first): ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ' ...' : ''}`);
  }
  console.log(`js bundles verified present (${expected.length}, esbuilt by the source phase)`);
} else {
  esbuildBundles(tjsDir);
}

if (sourceOnly) {
  console.log(`source tree ready: ${tjsDir}`);
  process.exit(0);
}

// os.cpus() is EMPTY on Haiku's node (tag run 2026-07-10: cmake --build
// -j 0 → usage text) — floor at 1; node-on-Haiku report candidate.
const jobs = String(Math.max(1, cpus().length));
// -DTJS_USE_ADA=OFF: our recipe selects the plain-C wurl URL parser (the
// ada-ectomy). The upstream-facing patch keeps the option's default ON;
// only OUR build flips it. Kills the C++20 toolchain requirement and libc++.
const cmakeArgs = ['-DCMAKE_BUILD_TYPE=Release', '-DTJS_USE_ADA=OFF'];
if (wantStatic) {
  cmakeArgs.push('-DBUILD_WITH_FFI=OFF', '-DCMAKE_EXE_LINKER_FLAGS=-static');
}
if (!wantWasm) {
  cmakeArgs.push('-DBUILD_WITH_WASM=OFF');
}
if (!wantMimalloc) {
  cmakeArgs.push('-DBUILD_WITH_MIMALLOC=OFF');
}
if (!wantFfi) {
  cmakeArgs.push('-DBUILD_WITH_FFI=OFF');
}
// macOS floor (darwin-x64 floor walk, spec 2026-07-11): release legs pin a
// deployment target and an honest OLD SDK, so every post-floor API is a
// compile error in CI — not a runtime crash on real old hardware (the
// -mmacosx-version-min-against-modern-SDK shortcut weak-links 10.12+
// symbols and dies on the box; rejected). Arch is pinned explicitly
// whenever a floor is set: never trust the runner default once targets are
// pinned. ci-tier and local builds leave these unset (stock SDK, no floor).
// Cross-compile (the darwin-ppc walk, Phase C): CLODE_TJS_CROSS_FILE points
// at a CMake toolchain file (scripts/darwin-ppc.toolchain.cmake) that owns
// ALL target config — compiler triple, deployment floor, warning demotions.
// The macOS-native OSX_* flags below assume a real macOS host (xcodebuild)
// and are skipped when cross; so is the -DCMAKE_C_FLAGS demotion push, which
// would clobber the toolchain file's -mmacosx-version-min (the demotions
// live in the toolchain file's *_FLAGS_INIT instead).
const crossFile = process.env.CLODE_TJS_CROSS_FILE || '';
if (crossFile) {
  if (!fs.existsSync(crossFile)) throw new Error(`CLODE_TJS_CROSS_FILE: no file at ${crossFile}`);
  cmakeArgs.push(`-DCMAKE_TOOLCHAIN_FILE=${path.resolve(crossFile)}`);
}
// Native Windows build with a HOSTED mingw toolchain (the windows-x64
// leg): use the SAME gcc-posix compiler the cross build uses, but on the
// Windows runner itself so the output can be executed (exec=host). Ninja
// because the default Windows generator is Visual Studio (MSVC), and mingw gcc
// as the compiler. NO cross toolchain file — this is a native build, so
// CMAKE_SYSTEM_NAME stays the host's Windows. The -Wno-error demotions below
// (:~1599, gated on !darwin && !crossFile) and the build/tjs.exe detection
// (:~1644) already apply. Mutually exclusive with a cross file.
const winMingw = process.env.CLODE_TJS_WIN_MINGW === '1';
if (winMingw && crossFile) {
  throw new Error('CLODE_TJS_WIN_MINGW and CLODE_TJS_CROSS_FILE are mutually exclusive (native-hosted vs cross)');
}
if (winMingw) {
  cmakeArgs.push('-G', 'Ninja', '-DCMAKE_C_COMPILER=gcc', '-DCMAKE_CXX_COMPILER=g++');
}
// Native Windows build with MSVC cl.exe (the windows-x64-msvc proving leg,
// then the windows-x64 publisher after Phase B). Ninja + cl (the VS dev
// environment is activated in build-leg so cl + the Windows SDK + ninja are on
// PATH). Mutually exclusive with the mingw and cross paths. cl needs no
// -Wno-error demotion (txiki applies -Werror only on its Unix path).
const winMsvc = process.env.CLODE_TJS_WIN_MSVC === '1';
if (winMsvc && (crossFile || winMingw)) {
  throw new Error('CLODE_TJS_WIN_MSVC is exclusive with CLODE_TJS_WIN_MINGW / CLODE_TJS_CROSS_FILE');
}
if (winMsvc) {
  cmakeArgs.push('-G', 'Ninja', '-DCMAKE_C_COMPILER=cl', '-DCMAKE_CXX_COMPILER=cl');
}
// 32-bit targets lacking libatomic (ppc/sparc): link the __atomic_*_8 shim.
if (process.env.CLODE_TJS_ATOMIC_SHIM === '1') {
  cmakeArgs.push('-DCLODE_ATOMIC_SHIM=ON');
}
const macosMin = process.env.CLODE_TJS_MACOS_MIN || '';
const macosSdk = process.env.CLODE_TJS_MACOS_SDK || '';
if (macosMin && !crossFile) {
  cmakeArgs.push(`-DCMAKE_OSX_DEPLOYMENT_TARGET=${macosMin}`);
  const macosArch = process.env.CLODE_TJS_MACOS_ARCH
    || (process.arch === 'arm64' ? 'arm64' : 'x86_64');
  cmakeArgs.push(`-DCMAKE_OSX_ARCHITECTURES=${macosArch}`);
}
if (macosSdk && !crossFile) {
  if (!fs.existsSync(path.join(macosSdk, 'usr/include'))) {
    throw new Error(`CLODE_TJS_MACOS_SDK: no SDK at ${macosSdk} (usr/include missing)`);
  }
  cmakeArgs.push(`-DCMAKE_OSX_SYSROOT=${macosSdk}`);
}
if (process.platform !== 'darwin' && !crossFile && !winMsvc) {
  // txiki-sync-spawn.patch declares posix_spawnattr_t attr used only inside
  // the #ifdef POSIX_SPAWN_CLOEXEC_DEFAULT (Apple) block; txiki compiles
  // -Werror on Unix, so -Wunused-variable kills every non-Apple POSIX leg
  // (Linux glibc + musl found by the first matrix dispatch 2026-07-10; the
  // T2 BSD/Solaris legs share the mechanism — the macro is Apple-only).
  // unknown-pragmas: txiki's text-coding.c/mod_ffi.c use clang/MSVC
  // `#pragma region`, which gcc warns about — fatal under -Werror on the
  // gcc BSDs (committed finding, spike/quickjs/qemu/guest-m4.sh).
  // -Wno-error= demotes JUST these warnings (gcc: beats a blanket -Werror
  // regardless of flag order). Real fix = patch v2 scoping the decl into the
  // ifdef + upstreaming the pragma cleanup — queued for the Q3 batch;
  // patches/ is frozen this phase.
  // sign-conversion: lws's dir-notify kqueue code trips it under DragonFly's
  // older base gcc (dispatch #9) — a warning-behavior delta, not a bug class
  // we own; demoted like the others (still visible as a warning).
  cmakeArgs.push('-DCMAKE_C_FLAGS=-Wno-error=unused-variable -Wno-error=unknown-pragmas -Wno-error=sign-conversion');
}
run('cmake', ['-S', tjsDir, '-B', path.join(tjsDir, 'build'), ...cmakeArgs]);

// ---- bundle regen: RETIRED as a BE requirement (canonical-LE, 2026-07-11) ----
// quickjs-ng-canonical-le-bytecode.patch makes the serialized format
// little-endian everywhere: BE readers swap on load, so the shipped LE
// bytecode arrays boot on every endianness and the old
// regen-on-BE-target rule (sparc wall #4; formerly keyed on
// os.endianness()) is gone. CLODE_TJS_REGEN=1 keeps the machinery as a
// validation lever — a regenerated bundle must behave identically to the
// shipped one on the same host, which is exactly the check the sparc
// campaign used on its darwin control.
const forceRegen = process.env.CLODE_TJS_REGEN === '1';
if (forceRegen) {
  console.log(`BE bundle regen: target endianness=${os.endianness()} force=${forceRegen} -> regenerating quickjs bytecode arrays natively`);
  const tjsc = path.join(tjsDir, 'build', 'tjsc');
  run('cmake', ['--build', path.join(tjsDir, 'build'), '--target', 'tjsc', '-j', jobs]);
  if (!fs.existsSync(tjsc)) throw new Error(`BE regen: tjsc did not build at ${tjsc}`);
  // Exactly the txiki Makefile's tjsc rules (module mode -m, strip -s, module
  // name -n, C symbol prefix -p). core+stdlib come from the esbuilt bundles;
  // worker-bootstrap + internal/path are tjsc'd straight from src/js sources.
  const regen = (outC, name, prefix, inJs) => {
    fs.mkdirSync(path.join(tjsDir, path.dirname(outC)), { recursive: true });
    run(tjsc, ['-m', '-s', '-o', path.join(tjsDir, outC), '-n', name, '-p', prefix, path.join(tjsDir, inJs)], { cwd: tjsDir });
  };
  regen('src/bundles/c/core/polyfills.c', 'tjs:internal/polyfills', 'tjs__', 'src/bundles/js/core/polyfills.js');
  regen('src/bundles/c/core/core.c', 'tjs:internal/bootstrap', 'tjs__', 'src/bundles/js/core/core.js');
  regen('src/bundles/c/core/run-main.c', 'tjs:internal/run-main', 'tjs__', 'src/bundles/js/core/run-main.js');
  regen('src/bundles/c/core/run-repl.c', 'tjs:internal/run-repl', 'tjs__', 'src/bundles/js/core/run-repl.js');
  regen('src/bundles/c/core/worker-bootstrap.c', 'tjs:internal/worker-bootstrap', 'tjs__', 'src/js/worker/worker-bootstrap.js');
  regen('src/bundles/c/internal/path.c', 'tjs:internal/path', 'tjs__internal_', 'src/js/internal/path.js');
  for (const f of fs.readdirSync(path.join(tjsDir, 'src/js/stdlib')).filter((x) => x.endsWith('.js'))) {
    const n = f.replace(/\.js$/, '');
    regen(`src/bundles/c/stdlib/${n}.c`, `tjs:${n}`, 'tjs__', `src/bundles/js/stdlib/${f}`);
  }
  console.log('BE bundle regen: 18 bytecode arrays regenerated at target endianness');
}

run('cmake', ['--build', path.join(tjsDir, 'build'), '-j', jobs]);

fs.mkdirSync(outDir, { recursive: true });
// A Windows (mingw) cross target emits build/tjs.exe; keep the .exe suffix on
// the output too (a Windows loader needs it, and clode reads its own exe by
// name). Every other target emits build/tjs.
const builtExe = fs.existsSync(path.join(tjsDir, 'build/tjs.exe'));
const outName = builtExe ? 'tjs.exe' : 'tjs';
fs.copyFileSync(path.join(tjsDir, builtExe ? 'build/tjs.exe' : 'build/tjs'), path.join(outDir, outName));
fs.chmodSync(path.join(outDir, outName), 0o755);

// CLODE_TJS_SMOKE=off: skip the exec smoke — for cross-target engines the
// build host cannot execute the output (darwin-x86 i386: no runner and no
// arm64 dev box can exec it; the floor gate + the real-hardware oracle
// carry verification instead).
if ((process.env.CLODE_TJS_SMOKE || 'on').toLowerCase() !== 'off') {
  const smoke = runOut(path.join(outDir, outName),
    ['eval', 'console.log(typeof __tjs_fs_sync === "object" ? "tjs-shim-ok" : "MISSING-SYNC-FS")']);
  if (smoke !== 'tjs-shim-ok') throw new Error(`smoke failed: ${smoke}`);
  console.log(`built ${path.join(outDir, outName)} (${smoke})`);
} else {
  console.log(`built ${path.join(outDir, outName)} (exec smoke SKIPPED: cross-target, CLODE_TJS_SMOKE=off)`);
}
