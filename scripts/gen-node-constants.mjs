// Generate spike/quickjs/patches/txiki-node-constants.patch.
//
// WHY THIS IS GENERATED, not written. The shim used to carry hand-written tables:
// SIGNALS_DARWIN, an errno table, and `const O = _isDarwin ? {...} : {...}` for
// fs.constants. Every one of them is a guess about a platform the author was not
// on, and the guesses had already rotted — measured 2026-08-21 against real node
// on the NetBSD guest, 8 of 11 fs O_* values were WRONG on every BSD leg, because
// the "else" branch of that ternary hands out Linux values. Nothing detected it,
// because a wrong constant does not throw; it just makes open() do the wrong thing.
//
// So: the ENGINE reports the constants, read from its OWN headers through #ifdef,
// exactly as node's node_constants.cc does. That is exact on every target we can
// compile for, including targets nobody has tabulated, and it cannot drift from
// the platform because it IS the platform. The shim reads what the engine reports
// and never guesses.
//
// Values never come from here — only names. And the names are STATIC (node's own
// cross-platform list, see NODE_CONSTANTS below); they are deliberately NOT read
// from the node running this script, because that node's keys are already filtered
// down to ITS platform, and baking one host's absences into the patch is how every
// other target silently loses constants.
//
// Run with the txiki vendor tree present (a build creates it); it diffs against
// that tree so the hunk header is real rather than hand-counted.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { tjsVendorParentDir } = require('./platform-tag.cjs');

// Bump when the shim starts REQUIRING something new from the engine.
const ABI = 1;

// GUARD EVERYTHING THE OS DEFINES; leave unguarded ONLY what libuv defines.
//
// This was an allow-list (O_*, S_I*, *_OK, RTLD_*), which silently left all 31
// signal names and all 79 errno names UNGUARDED — 177 entries behind just 45
// #ifdefs. Every one of them exists on darwin, so it compiled here and broke
// every other leg:
//     src/signals.c:373:26: error: 'SIGINFO' undeclared
// SIGINFO is BSD/darwin-only. That is exactly the failure the #ifdef design
// exists to prevent, so the default is inverted: guard unless the name is known
// to come from libuv. A new OS constant in node's list is then correct by
// default on every target, and the only way to get it wrong is to add it to the
// libuv list by mistake.
//
// libuv names MUST stay unguarded: #ifdef cannot see an enum (UV_DIRENT_* are
// enum constants), so guarding them would silently drop the keys. If one is
// genuinely absent the build fails loudly in C instead.
const isGuardedOsMacro = (k) =>
  !(/^UV_/.test(k) || Object.prototype.hasOwnProperty.call(UV_EXPR, k));

// libuv values. UV_DIRENT_* are an ENUM in uv.h, so #ifdef would silently drop
// them — the exact failure mode this file exists to end. Emit unguarded: libuv is
// always present here, and a genuinely missing name becomes a compile error, which
// is the loud outcome we want.
const UV_EXPR = {
  COPYFILE_EXCL: 'UV_FS_COPYFILE_EXCL',
  COPYFILE_FICLONE: 'UV_FS_COPYFILE_FICLONE',
  COPYFILE_FICLONE_FORCE: 'UV_FS_COPYFILE_FICLONE_FORCE',
  PRIORITY_LOW: 'UV_PRIORITY_LOW',
  PRIORITY_BELOW_NORMAL: 'UV_PRIORITY_BELOW_NORMAL',
  PRIORITY_NORMAL: 'UV_PRIORITY_NORMAL',
  PRIORITY_ABOVE_NORMAL: 'UV_PRIORITY_ABOVE_NORMAL',
  PRIORITY_HIGH: 'UV_PRIORITY_HIGH',
  PRIORITY_HIGHEST: 'UV_PRIORITY_HIGHEST',
};
// The five Windows-only open flags. node exposes all of them on every platform,
// UNGUARDED (node_constants.cc, DefineFsConstants), because its bundled libuv
// defines them everywhere: uv/win.h maps them to the _O_* bits, uv/unix.h defines
// them as 0. We emit them #ifdef'd with a 0 FALLBACK instead of either extreme —
// unguarded would hard-fail the compile on a leg whose libuv (or cosmo compat
// header) predates the unix zero-defines, and a plain #ifdef would let the key
// vanish where node has it, which is the silent gap this file exists to end. 0 is
// node's own answer off Windows, so the fallback is not a guess.
const GUARDED_WITH_ZERO = new Set([
  'UV_FS_O_FILEMAP', 'UV_FS_O_TEMPORARY', 'UV_FS_O_SHORT_LIVED',
  'UV_FS_O_SEQUENTIAL', 'UV_FS_O_RANDOM',
]);

function emitEntry(key) {
  const expr = UV_EXPR[key] || key;
  if (GUARDED_WITH_ZERO.has(key)) {
    return `#ifdef ${expr}\n        CLODE_K(${key}, ${expr}),\n#else\n        CLODE_K(${key}, 0),\n#endif`;
  }
  if (isGuardedOsMacro(key)) {
    return `#ifdef ${expr}\n        CLODE_K(${key}, ${expr}),\n#endif`;
  }
  return `        CLODE_K(${key}, ${expr}),`;
}

function group(name, keys) {
  return [
    `    CLODE_KV_TABLE clode_${name}[] = {`,
    ...keys.map(emitEntry),
    // A terminator, so a table whose every entry is #ifdef'd out is still a legal
    // initializer. On MSVC the entire dlopen group vanishes -- RTLD_* come from
    // <dlfcn.h>, which is #ifndef _WIN32 -- and `clode_dlopen_kv[] = { }` is
    // C7757, "an array of unknown size cannot be initialized by an empty
    // initializer". Emitted for EVERY group rather than only the ones that can
    // empty out today, because which groups those are is a per-target fact and
    // hard-coding this target's answer is how it comes back on the next one.
    // CLODE_GROUP skips it, so it never becomes a key.
    '        { NULL, 0 },   /* terminator: keeps an all-guarded-out table legal */',
    '    };',
  ].join('\n');
}

// THE NAME LISTS ARE STATIC ON PURPOSE. DO NOT RE-DERIVE THEM FROM THE RUNNING HOST.
//
// These were `Object.keys(os.constants.signals)` etc., read from whatever node was
// running the generator. That is wrong in a way darwin cannot show you: the host's
// keys are already the #ifdef-filtered result for the HOST, so generating on darwin
// bakes darwin's absences into the patch and every other target inherits them.
// Measured 2026-08-22, same node 24 major, three hosts:
//
//     signals   darwin 31 | linux-glibc 33 | linux-musl 34
//     fs        darwin 55 | linux         55   (but NOT the same 55)
//     dlopen    darwin  4 | linux-glibc  5 | linux-musl  4
//
// Generating on darwin lost SIGPOLL/SIGPWR/SIGSTKFLT (real on Linux), O_NOATIME and
// O_DIRECT (real on Linux), and RTLD_DEEPBIND (real on glibc). None of that throws:
// quaude on Linux would just be silently missing constants node has — the exact
// class of drift this whole file exists to end, reintroduced by the fix for it.
// Generating on Linux would lose darwin's SIGINFO and O_SYMLINK instead. There is no
// host that is a safe place to derive from.
//
// So the list is node's OWN static list, transcribed from the NODE_DEFINE_CONSTANT
// entries in node's src/node_constants.cc (DefineErrnoConstants,
// DefineWindowsErrorConstants, DefineSignalConstants, DefineFsConstants,
// DefineDLOpenConstants, DefinePriorityConstants). That list is a UNION across
// platforms — node emits it under #ifdef exactly as we do — so it is the only
// correct input. With
// guard-by-default above, a name absent on a target compiles out and the key is
// simply not reported, which is precisely what node does there. Extra names are
// therefore free; missing names are unfixable at runtime. Union in, #ifdef out.
//
// Two entries are worth knowing about: SIGBREAK is Windows-only and SIGUNUSED is
// musl-only in practice (glibc dropped it) — both are in node's list, both compile
// out where absent, and both are keys node really does expose where present. The
// hand-written patch this generator replaced (txiki-signals-expose.patch) carried 34
// signals and its comment asserted node "deliberately OMITS SIGUNUSED"; the musl
// measurement above disproves that. Hand-maintained platform knowledge rots.
//
// UNION AS OF WHOM (2026-09-21). "Node's cross-platform union" is what this list is
// SUPPOSED to be; what it actually was is the union of the platforms somebody
// transcribed. The paragraph above named five Define* functions until today (it
// names six now). node has SIX that feed these five namespaces: DefineWindowsErrorConstants pours 58 Winsock
// names into the SAME err_constants object DefineErrnoConstants fills, so node's
// os.constants.errno is 79 keys on POSIX and 137 on Windows. All 58 were absent
// here, and nothing could see it: this box, every Linux leg, every BSD leg and the
// node-shim-oracle job are all POSIX, where node does not report them either, so the
// list looked complete from every host anyone ever ran it on. The --check row added
// in 3b1bc37 found it on its FIRST windows-latest run. Nothing "grew"; Windows had
// always had them, and we had never asked a Windows host.
//
// That is the standing hazard of a transcribed union, and the lesson is narrower than
// "transcribe harder": a gap in a union is invisible from every host that does not
// have it, so completeness has to be checked against node's SOURCE (all of the
// Define* functions that write into a namespace, not the ones named in a comment),
// never against a host. Re-verified 2026-09-21 against v24.21.0's node_constants.cc,
// function by function: fs 61/61, signals 37/37, errno 79+58/137, dlopen 5/5,
// priority 6/6 — same names, same order, no extras. errno was the only incomplete one.
//
// GUARDING THE WSA* NAMES: plain #ifdef, which is this file's default for anything
// not from libuv, and it is node's own guard for these, one #ifdef per name. The
// three choices are not interchangeable on the 40 non-Windows legs:
//
//   * plain #ifdef (chosen)  -> the macro is absent, the entry compiles out, the key
//     is not reported. Exactly what node does there: node guards each of the 58 too,
//     so POSIX node has no WSAEINTR either. Key sets match, which is the whole design.
//   * GUARDED_WITH_ZERO      -> 58 keys node does NOT have, all worth 0. Wrong twice:
//     it invents a superset on those 40, and 0 is not a plausible errno, so any
//     value->name lookup gains 58 aliases for 0. The UV_FS_O_* four are in that set
//     for the opposite reason — node emits THOSE unguarded, reports them on every
//     platform, and 0 is node's own documented answer off Windows.
//   * unguarded              -> `'WSAEINTR' undeclared` and a hard compile failure on
//     every one of them. That is the SIGINFO break that made guard-by-default the rule.
//
// Where the VALUES come from on Windows is the F_OK/R_OK/W_OK/X_OK situation again and
// is handled the same way: WSAE* live in <winsock2.h>, which this block does not
// include and neither does node's. Both reach them through libuv — src/signals.c
// includes private.h, private.h includes <uv.h>, and uv/win.h line 33 includes
// <winsock2.h> (node: node_internals.h -> uv.h). Relying on a header we do not name
// is only acceptable with a tripwire, so there is one in `includes` below.
//
// KNOWN REMAINING GAP, measured 2026-08-22, deliberately NOT fixed here. A name in
// the union is only reported if the target's headers make it VISIBLE, and on glibc
// two of them hide behind a feature-test macro. Probed on gcc:13 with the four flag
// combinations the tjs target could plausibly use:
//
//     -std=gnu11                 O_DIRECT NO   O_NOATIME NO   RTLD_DEEPBIND yes
//     -std=c11                   O_DIRECT NO   O_NOATIME NO   RTLD_DEEPBIND yes
//     -std=gnu11 -D_GNU_SOURCE   O_DIRECT yes  O_NOATIME yes  RTLD_DEEPBIND yes
//     -std=c11   -D_GNU_SOURCE   O_DIRECT yes  O_NOATIME yes  RTLD_DEEPBIND yes
//
// txiki.js compiles deps/libuv and deps/quickjs with _GNU_SOURCE but does NOT set it
// on the `tjs` target, so src/signals.c gets the plain view and glibc legs will
// report 55 fs keys without O_DIRECT/O_NOATIME where node reports 57. That is still
// strictly better than before (the darwin-derived list did not contain those names
// at ALL, on any platform), so it is a smaller gap, not a new one. Closing it means
// `#define _GNU_SOURCE` ahead of signals.c's FIRST include — a feature-test macro is
// inert if set after the first system header, so it cannot go in the block this
// generator splices in mid-file. That is a change to how a vendor translation unit
// is compiled on every leg, it cannot be verified from darwin, and it does not
// belong in the same commit as an unbreak-the-build fix.
//
// TO UPDATE (when node grows a constant): re-read those five functions in node's
// src/node_constants.cc for the node version we track and transcribe the additions.
// The staleness check below will tell you when that is due — run it directly with
// `node scripts/gen-node-constants.mjs --check` (no vendor tree needed), which is
// what test/node-shim-constants.test.cjs runs on every leg.
//
// UPDATED 2026-09-20 for node 24.21.0. Diffing node's src/node_constants.cc across
// v24.20.0..v24.21.0, the only constant change in the whole file is four new lines in
// DefineFsConstants — UV_FS_O_TEMPORARY, UV_FS_O_SHORT_LIVED, UV_FS_O_SEQUENTIAL and
// UV_FS_O_RANDOM, joining the UV_FS_O_FILEMAP that was already there, under the comment
// "Windows-only open flags honored by libuv. They are 0 on other platforms." They are
// transcribed below in node's order. Not academic off Windows: an undefined
// UV_FS_O_TEMPORARY OR'd into an open-flag mask is NaN, and a NaN mask is the quiet
// misclassification the gap inventory exists to catch.
const NODE_CONSTANTS = {
  fs: [
    'UV_FS_SYMLINK_DIR', 'UV_FS_SYMLINK_JUNCTION', 'O_RDONLY', 'O_WRONLY', 'O_RDWR',
    'UV_DIRENT_UNKNOWN', 'UV_DIRENT_FILE', 'UV_DIRENT_DIR', 'UV_DIRENT_LINK',
    'UV_DIRENT_FIFO', 'UV_DIRENT_SOCKET', 'UV_DIRENT_CHAR', 'UV_DIRENT_BLOCK',
    'S_IFMT', 'S_IFREG', 'S_IFDIR', 'S_IFCHR', 'S_IFBLK', 'S_IFIFO', 'S_IFLNK',
    'S_IFSOCK', 'O_CREAT', 'O_EXCL', 'UV_FS_O_FILEMAP', 'UV_FS_O_TEMPORARY',
    'UV_FS_O_SHORT_LIVED', 'UV_FS_O_SEQUENTIAL', 'UV_FS_O_RANDOM', 'O_NOCTTY', 'O_TRUNC',
    'O_APPEND', 'O_DIRECTORY', 'O_NOATIME', 'O_NOFOLLOW', 'O_SYNC', 'O_DSYNC',
    'O_SYMLINK', 'O_DIRECT', 'O_NONBLOCK', 'S_IRWXU', 'S_IRUSR', 'S_IWUSR',
    'S_IXUSR', 'S_IRWXG', 'S_IRGRP', 'S_IWGRP', 'S_IXGRP', 'S_IRWXO', 'S_IROTH',
    'S_IWOTH', 'S_IXOTH', 'F_OK', 'R_OK', 'W_OK', 'X_OK', 'UV_FS_COPYFILE_EXCL',
    'COPYFILE_EXCL', 'UV_FS_COPYFILE_FICLONE', 'COPYFILE_FICLONE',
    'UV_FS_COPYFILE_FICLONE_FORCE', 'COPYFILE_FICLONE_FORCE',
  ],
  signals: [
    'SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGTRAP', 'SIGABRT', 'SIGIOT',
    'SIGBUS', 'SIGFPE', 'SIGKILL', 'SIGUSR1', 'SIGSEGV', 'SIGUSR2', 'SIGPIPE',
    'SIGALRM', 'SIGTERM', 'SIGCHLD', 'SIGSTKFLT', 'SIGCONT', 'SIGSTOP', 'SIGTSTP',
    'SIGBREAK', 'SIGTTIN', 'SIGTTOU', 'SIGURG', 'SIGXCPU', 'SIGXFSZ', 'SIGVTALRM',
    'SIGPROF', 'SIGWINCH', 'SIGIO', 'SIGPOLL', 'SIGLOST', 'SIGPWR', 'SIGINFO',
    'SIGSYS', 'SIGUNUSED',
  ],
  errno: [
    'E2BIG', 'EACCES', 'EADDRINUSE', 'EADDRNOTAVAIL', 'EAFNOSUPPORT', 'EAGAIN',
    'EALREADY', 'EBADF', 'EBADMSG', 'EBUSY', 'ECANCELED', 'ECHILD', 'ECONNABORTED',
    'ECONNREFUSED', 'ECONNRESET', 'EDEADLK', 'EDESTADDRREQ', 'EDOM', 'EDQUOT',
    'EEXIST', 'EFAULT', 'EFBIG', 'EHOSTUNREACH', 'EIDRM', 'EILSEQ', 'EINPROGRESS',
    'EINTR', 'EINVAL', 'EIO', 'EISCONN', 'EISDIR', 'ELOOP', 'EMFILE', 'EMLINK',
    'EMSGSIZE', 'EMULTIHOP', 'ENAMETOOLONG', 'ENETDOWN', 'ENETRESET', 'ENETUNREACH',
    'ENFILE', 'ENOBUFS', 'ENODATA', 'ENODEV', 'ENOENT', 'ENOEXEC', 'ENOLCK',
    'ENOLINK', 'ENOMEM', 'ENOMSG', 'ENOPROTOOPT', 'ENOSPC', 'ENOSR', 'ENOSTR',
    'ENOSYS', 'ENOTCONN', 'ENOTDIR', 'ENOTEMPTY', 'ENOTSOCK', 'ENOTSUP', 'ENOTTY',
    'ENXIO', 'EOPNOTSUPP', 'EOVERFLOW', 'EPERM', 'EPIPE', 'EPROTO',
    'EPROTONOSUPPORT', 'EPROTOTYPE', 'ERANGE', 'EROFS', 'ESPIPE', 'ESRCH', 'ESTALE',
    'ETIME', 'ETIMEDOUT', 'ETXTBSY', 'EWOULDBLOCK', 'EXDEV',
    // DefineWindowsErrorConstants writes into the SAME object as
    // DefineErrnoConstants (node_constants.cc CreatePerContextProperties calls
    // both with err_constants), so node's os.constants.errno is these 79 POSIX
    // names PLUS these 58 Winsock ones — 137 on Windows. Transcribed in node's
    // order. See the UNION AS OF WHOM note above.
    'WSAEINTR', 'WSAEBADF', 'WSAEACCES', 'WSAEFAULT', 'WSAEINVAL', 'WSAEMFILE',
    'WSAEWOULDBLOCK', 'WSAEINPROGRESS', 'WSAEALREADY', 'WSAENOTSOCK',
    'WSAEDESTADDRREQ', 'WSAEMSGSIZE', 'WSAEPROTOTYPE', 'WSAENOPROTOOPT',
    'WSAEPROTONOSUPPORT', 'WSAESOCKTNOSUPPORT', 'WSAEOPNOTSUPP', 'WSAEPFNOSUPPORT',
    'WSAEAFNOSUPPORT', 'WSAEADDRINUSE', 'WSAEADDRNOTAVAIL', 'WSAENETDOWN',
    'WSAENETUNREACH', 'WSAENETRESET', 'WSAECONNABORTED', 'WSAECONNRESET',
    'WSAENOBUFS', 'WSAEISCONN', 'WSAENOTCONN', 'WSAESHUTDOWN', 'WSAETOOMANYREFS',
    'WSAETIMEDOUT', 'WSAECONNREFUSED', 'WSAELOOP', 'WSAENAMETOOLONG',
    'WSAEHOSTDOWN', 'WSAEHOSTUNREACH', 'WSAENOTEMPTY', 'WSAEPROCLIM', 'WSAEUSERS',
    'WSAEDQUOT', 'WSAESTALE', 'WSAEREMOTE', 'WSASYSNOTREADY', 'WSAVERNOTSUPPORTED',
    'WSANOTINITIALISED', 'WSAEDISCON', 'WSAENOMORE', 'WSAECANCELLED',
    'WSAEINVALIDPROCTABLE', 'WSAEINVALIDPROVIDER', 'WSAEPROVIDERFAILEDINIT',
    'WSASYSCALLFAILURE', 'WSASERVICE_NOT_FOUND', 'WSATYPE_NOT_FOUND',
    'WSA_E_NO_MORE', 'WSA_E_CANCELLED', 'WSAEREFUSED',
  ],
  dlopen: ['RTLD_LAZY', 'RTLD_NOW', 'RTLD_GLOBAL', 'RTLD_LOCAL', 'RTLD_DEEPBIND'],
  priority: [
    'PRIORITY_LOW', 'PRIORITY_BELOW_NORMAL', 'PRIORITY_NORMAL',
    'PRIORITY_ABOVE_NORMAL', 'PRIORITY_HIGH', 'PRIORITY_HIGHEST',
  ],
};

// STALENESS RATCHET. The static list can only rot in one direction that hurts: node
// grows a name and we never hear about it. The host cannot tell us what the union
// is, but it CAN tell us about any name it has that we lack — and that is exactly
// the "node grew a constant" signal. The reverse (we have names the host lacks) is
// the design working, so it is never an error. Fail loudly rather than write a patch
// that is quietly behind node.
const hostKeys = {
  fs: Object.keys(fs.constants),
  signals: Object.keys(os.constants.signals),
  errno: Object.keys(os.constants.errno),
  dlopen: Object.keys(os.constants.dlopen),
  priority: Object.keys(os.constants.priority),
};
const stale = [];
for (const [g, names] of Object.entries(NODE_CONSTANTS)) {
  const have = new Set(names);
  for (const k of hostKeys[g]) if (!have.has(k)) stale.push(`${g}.${k}`);
}
if (stale.length) {
  console.error(`host node ${process.version} on ${process.platform}-${process.arch} exposes `
    + `${stale.length} name(s) missing from NODE_CONSTANTS in this file.`);
  console.error('');
  // The original wording said only "node grew a constant". That is one of the two
  // causes and it was the wrong one the very next time this fired: 58 WSA* errno
  // names turned up on windows-latest with NO version change at all, and the message
  // sent the reader looking for a node bump that had not happened. Both causes get
  // named now, with the host's platform printed above so the second is checkable at a
  // glance.
  console.error('TWO CAUSES, and the names below usually tell you which:');
  console.error('  1. node GREW a constant — a version bump added it (e.g. 24.21.0 added');
  console.error('     four UV_FS_O_* fs names). Expect it right after a toolchain bump, and');
  console.error('     expect every leg to report it, not just this one.');
  console.error('  2. nothing grew — THIS HOST IS A PLATFORM NOBODY TRANSCRIBED FROM. The');
  console.error('     list is a union assembled by hand, so a name real only on a platform');
  console.error('     no one has run this on is invisible everywhere else. Expect it on one');
  console.error('     OS only, with no version change. Do not go looking for a bump.');
  console.error('');
  console.error('Either way the fix is the same: re-transcribe from node\'s');
  console.error('src/node_constants.cc at the version in .tool-versions, taking EVERY');
  console.error('Define*Constants function that writes into the namespace — errno is fed by');
  console.error('DefineErrnoConstants AND DefineWindowsErrorConstants, and missing the second');
  console.error('one is exactly how cause 2 happened. Keep node\'s order. Then rerun.');
  console.error('');
  console.error('Missing:');
  for (const s of stale) console.error(`    ${s}`);
  process.exit(1);
}

const fsKeys = NODE_CONSTANTS.fs;
const signalKeys = NODE_CONSTANTS.signals;
const errnoKeys = NODE_CONSTANTS.errno;
const dlopenKeys = NODE_CONSTANTS.dlopen;
const priorityKeys = NODE_CONSTANTS.priority;

const body = `
    /* CLODE (generated by scripts/gen-node-constants.mjs — do not hand-edit).
     *
     * Report this engine's OWN constants, read from its own headers, as
     * globalThis.__tjs_constants. The node-shim consumes these and never guesses.
     *
     * This replaces three hand-written tables that were each a guess about a
     * platform the author was not on: a darwin-shaped signal table, a darwin-shaped
     * errno table, and \`_isDarwin ? {...} : {...}\` for fs.constants. The last one
     * was measurably wrong — on NetBSD, 8 of 11 O_* values were Linux's, and
     * nothing noticed, because a wrong constant does not throw.
     *
     * Names come from node's own list (node_constants.cc); values come from
     * #ifdef against the headers THIS engine compiled with, so a target nobody has
     * tabulated is still exact. A name libuv defines as an enum is emitted
     * unguarded — #ifdef cannot see an enum and would drop it silently, which is
     * the failure this design exists to end; if it is truly absent the build fails
     * loudly instead.
     *
     * __tjs_abi is the handshake: the shim requires a minimum, and clode's build
     * refuses an engine that predates it rather than blobulating a quaude that is subtly
     * wrong at runtime.
     */
    typedef struct { const char *name; int64_t val; } clode_kv;
#define CLODE_K(n, v) { #n, (int64_t)(v) }
/* Storage class for the tables below. Cosmopolitan libc resolves SIG*, E*, O_*
 * and RTLD_* at RUNTIME -- one APE binary runs on Linux, macOS, Windows and the
 * BSDs, where the numbers differ -- so those initializers are not constant
 * expressions and a 'static const' table cannot be emitted into .rodata.
 * Dropping const lets cosmocc runtime-initialize it. This USED to live in
 * patches/libtjs-cosmo.patch as a hand-written hunk whose context was the text
 * THIS generator emits; regenerating broke it (f8546da renamed clode_sig_list
 * to clode_sig_kv and the cosmo leg went red for 13 commits, unnoticed because
 * no CI ran in between). Generated code owns its own storage class now, so all
 * five tables are covered and there is no context to rot. */
#ifdef __COSMOPOLITAN__
#define CLODE_KV_TABLE static clode_kv
#else
#define CLODE_KV_TABLE static const clode_kv
#endif
${group('fs_kv', fsKeys)}
${group('sig_kv', signalKeys)}
${group('errno_kv', errnoKeys)}
${group('dlopen_kv', dlopenKeys)}
${group('priority_kv', priorityKeys)}
#undef CLODE_K
#undef CLODE_KV_TABLE
    JSValue clode_c = JS_NewObject(ctx);
    JS_SetPropertyStr(ctx, clode_c, "abi", JS_NewInt32(ctx, CLODE_CONSTANTS_ABI));
    /* A DISTINCTIVE literal, so clode's build can verify an engine it cannot run
     * (a cross-target template) by looking for it in the binary. Sniffing was
     * rejected before for good reason — probing for "uid"/"gid" gave false
     * confidence because libc contains those strings anyway — but this token
     * cannot appear by accident, and setting it as a property guarantees the
     * literal survives into the binary instead of being optimized away. */
    JS_SetPropertyStr(ctx, clode_c, "marker", JS_NewString(ctx, CLODE_ABI_MARKER));
#define CLODE_GROUP(field, arr)                                                       \\
    do {                                                                              \\
        JSValue o_ = JS_NewObject(ctx);                                               \\
        for (size_t i_ = 0; i_ < countof(arr); i_++)                                  \\
            if (arr[i_].name)   /* skip the terminator */                                     \\
                JS_SetPropertyStr(ctx, o_, arr[i_].name, JS_NewInt64(ctx, arr[i_].val));      \\
        JS_SetPropertyStr(ctx, clode_c, field, o_);                                   \\
    } while (0)
    CLODE_GROUP("fs", clode_fs_kv);
    CLODE_GROUP("signals", clode_sig_kv);
    CLODE_GROUP("errno", clode_errno_kv);
    CLODE_GROUP("dlopen", clode_dlopen_kv);
    CLODE_GROUP("priority", clode_priority_kv);
#undef CLODE_GROUP
    JS_SetPropertyStr(ctx, clode_c, "UV_UDP_REUSEADDR", JS_NewInt32(ctx, UV_UDP_REUSEADDR));
    JSValue clode_g = JS_GetGlobalObject(ctx);
    JS_DefinePropertyValueStr(ctx, clode_g, "__tjs_constants", clode_c, JS_PROP_C_W_E);
    JS_FreeValue(ctx, clode_g);
`;

// THE INCLUDE SET IS NODE'S OWN, GUARD FOR GUARD (src/node_constants.cc,
// v24.19.0). Names come from node's list and values come from the headers; the
// headers must therefore be the ones node reads, with node's conditions, or the
// #ifdef-guarded table quietly reports fewer keys than node on some platform —
// which is the failure this whole file exists to end. Three guards carry weight:
//
//  * <unistd.h> is `#if !defined(_MSC_VER)` in node (node_constants.cc:30-32).
//    MSVC ships no such header, which is what broke the windows-arm64 leg:
//    signals.c(173): fatal error C1083: Cannot open include file: 'unistd.h'.
//    _MSC_VER, not _WIN32, because mingw DOES ship it — node draws the line in
//    exactly that place and so do we.
//
//    Guarding it costs nothing, MEASURED not assumed. Compiling our five name
//    lists with and without <unistd.h> (darwin 26 clang, and gcc 13.3 on
//    Ubuntu 24.04/glibc 2.39) changes exactly four keys: F_OK, R_OK, W_OK,
//    X_OK. Everything else has another home — O_* in <fcntl.h>, S_I* in
//    <sys/stat.h>, E* in <errno.h>, SIG* in <signal.h>, RTLD_* in <dlfcn.h>.
//    And those four are NOT lost on Windows: libuv defines them there
//    (deps/libuv/include/uv/win.h, `#ifndef F_OK #define F_OK 0` ... 4/2/1),
//    and this block is spliced far BELOW signals.c's `#include "private.h"`,
//    which includes <uv.h> — note that upstream private.h already guards its
//    own <unistd.h> with `#ifndef _WIN32` and does not guard <uv.h>. node
//    reaches them by the same route: node_constants.cc includes
//    node_internals.h, which includes uv.h, and then guards each with #ifdef.
//    Same header, same values, same mechanism.
//
//  * <io.h> and the two S_I* fallbacks are node_constants.cc:51-59 verbatim.
//    MSVC's <sys/stat.h> spells the owner bits _S_IREAD/_S_IWRITE and has no
//    S_IRUSR/S_IWUSR at all, so node hands itself those two names and reports
//    them on Windows. Without this our Windows engine would report a fs table
//    two keys short of node's, silently, on the one platform nobody here can
//    eyeball. This is NOT a hand-written platform table: it is #ifndef-guarded
//    (inert on mingw, and on any MSVC that grows them) and it defines exactly
//    the two names node defines — node invents no other owner/group/other bit
//    on Windows, and neither may we.
//
//  * <dlfcn.h> stays `#ifndef _WIN32` (node spells the same thing
//    `#if defined(__POSIX__)`); no Windows toolchain has it.
//
// The tripwire is what keeps the first bullet from rotting. On MSVC we are
// deliberately relying on a header that does not mention *_OK in its name, so
// if libuv ever drops that block the honest outcome is a build that fails and
// says why — not four keys quietly missing from quaude's fs.constants on
// Windows only, discovered by an fs.accessSync that starts answering wrong.
// Scoped to _MSC_VER because that is the only configuration where we skip the
// header POSIX guarantees them in.
const includes = '#include <errno.h>\n#include <fcntl.h>\n#include <signal.h>\n'
  + '#include <sys/stat.h>\n'
  + '#if !defined(_MSC_VER)\n#include <unistd.h>\n#endif\n'
  + '#ifndef _WIN32\n#include <dlfcn.h>\n#endif\n'
  + '#if defined(_WIN32)\n#include <io.h>  /* _S_IREAD _S_IWRITE */\n'
  + '#ifndef S_IRUSR\n#define S_IRUSR _S_IREAD\n#endif\n'
  + '#ifndef S_IWUSR\n#define S_IWUSR _S_IWRITE\n#endif\n#endif\n'
  + '#if defined(_MSC_VER) && (!defined(F_OK) || !defined(R_OK) '
  + '|| !defined(W_OK) || !defined(X_OK))\n'
  + '#error "clode: MSVC lacks <unistd.h>, so F_OK/R_OK/W_OK/X_OK must come from '
  + 'libuv (uv/win.h, via private.h -> uv.h). They did not. node reports all four '
  + 'on Windows (node_constants.cc guards each with #ifdef, having pulled uv.h in '
  + 'through node_internals.h), so this engine must too -- failing loudly beats '
  + 'shipping a Windows fs.constants four keys short of node\'s."\n#endif\n'
  + '#if defined(_WIN32) && !defined(WSAEINTR)\n'
  + '#error "clode: the 58 WSA* errno names must come from <winsock2.h>, pulled in by '
  + 'libuv (uv/win.h, via private.h -> uv.h). WSAEINTR is not defined, so every one of '
  + 'them just compiled out and this engine would report a Windows os.constants.errno of '
  + '79 keys where node reports 137 -- silently, because a missing constant does not '
  + 'throw. That gap already shipped once (it was invisible until a --check ran on a '
  + 'Windows host), so it fails the build instead of coming back. _WIN32 and not '
  + '_MSC_VER: mingw has no winsock2 of its own either."\n#endif\n'
  + `#define CLODE_CONSTANTS_ABI ${ABI}\n`
  + `#define CLODE_ABI_MARKER "clode-constants-abi:${ABI}"\n`;

// --- staleness/freshness gate (`--check`) -------------------------------------
//
// Two ways this generator's output can quietly fall behind, both of which have
// HAPPENED, and neither of which anything ran in CI:
//
//   1. node grows a constant. The ratchet above sees it, but only if somebody runs
//      the generator — and you only run the generator when you already know. node
//      24.21.0 added four fs names (see NODE_CONSTANTS), and the first thing that
//      noticed was two tjs ORACLE legs failing with a bare `fs.missing: [...]`,
//      which does not tell you the fix is "re-transcribe node_constants.cc".
//   2. the generator changes and the COMMITTED PATCH does not. 97a3fe6 renamed a
//      word inside the emitted comment and never regenerated; the patch sat one
//      wording behind its generator until this check was written. Same shape as the
//      src/js/** patches that were silently dropped because regeneration was opt-in
//      (0c72693) — generated output that nothing compares to its generator.
//
// Regenerating needs the txiki vendor tree, so it cannot run in the suite. But the
// TEXT this file splices in is computed above from nothing but this file, so the
// freshness question is answerable from the committed patch alone, on any host, in
// milliseconds. `--check` answers both and writes nothing; test/node-shim-constants
// runs it on every leg.
const PATCH = path.join(import.meta.dirname, '..', 'spike/quickjs/patches/txiki-node-constants.patch');

// The lines this generator would ADD, in order: the include block is spliced in
// ahead of the anchor line (which stays put, as diff context), the body after it.
function wantedAddedLines() {
  return [...includes.split('\n').slice(0, -1), '', ...body.split('\n').slice(0, -1)];
}

// The lines the committed patch actually adds. Everything after the `+++` header
// is a hunk line; a '+' one is an addition, and its content is the rest.
function patchAddedLines() {
  const lines = fs.readFileSync(PATCH, 'utf8').split('\n');
  const head = lines.findIndex((l) => l.startsWith('+++ '));
  if (head < 0) throw new Error(`${PATCH} has no +++ header — not a diff`);
  return lines.slice(head + 1).filter((l) => l.startsWith('+')).map((l) => l.slice(1));
}

if (process.argv.includes('--check')) {
  const want = wantedAddedLines();
  const got = patchAddedLines();
  const at = want.findIndex((l, i) => got[i] !== l);
  if (at >= 0 || got.length !== want.length) {
    const i = at >= 0 ? at : Math.min(want.length, got.length);
    console.error(`${PATCH} is not what scripts/gen-node-constants.mjs emits.`);
    console.error(`  added lines: patch ${got.length}, generator ${want.length}`);
    console.error(`  first difference at added line ${i + 1}:`);
    console.error(`    patch:     ${JSON.stringify(got[i])}`);
    console.error(`    generator: ${JSON.stringify(want[i])}`);
    console.error('Regenerate with the vendor tree present: node scripts/gen-node-constants.mjs');
    process.exit(1);
  }
  console.log(`node-constants OK: host ${process.version} adds no name we lack, and the `
    + `committed patch matches this generator (${got.length} added lines).`);
  process.exit(0);
}

// --- splice into the vendor tree and diff -------------------------------------
const vendorRoot = path.join(tjsVendorParentDir(process.env), 'txiki.js');
const target = path.join(vendorRoot, 'src', 'signals.c');
if (!fs.existsSync(target)) {
  console.error(`no vendor tree at ${target} — run a build first (it creates one)`);
  process.exit(1);
}
const git = (...a) => execFileSync('git', ['-C', vendorRoot, ...a], { encoding: 'utf8' });

// Start from pristine so the diff is ONLY this patch, then re-apply the earlier
// patches this one must sit after. Staging the baseline is the documented recipe;
// leaving it staged is the documented hazard, so reset at the end no matter what.
git('checkout', '--', 'src/signals.c');
git('add', 'src/signals.c');
try {
  const src = fs.readFileSync(target, 'utf8');
  const anchor = 'void tjs__mod_signals_init(JSContext *ctx, JSValue ns) {';
  if (!src.includes(anchor)) throw new Error('anchor not found in signals.c');
  let out = src.replace(anchor, includes + '\n' + anchor);
  // Insert at the END of the init function's opening — right after the anchor line.
  out = out.replace(anchor + '\n', anchor + '\n' + body);
  fs.writeFileSync(target, out);
  const diff = git('diff', '--src-prefix=a/', '--dst-prefix=b/', 'src/signals.c');
  if (!diff.trim()) throw new Error('empty diff');
  const dest = path.join(import.meta.dirname, '..', 'spike/quickjs/patches/txiki-node-constants.patch');
  fs.writeFileSync(dest, diff);
  console.log(`wrote ${dest} (${diff.split('\n').length} lines)`);
  console.log(`groups: fs=${fsKeys.length} signals=${signalKeys.length} errno=${errnoKeys.length} `
    + `dlopen=${dlopenKeys.length} priority=${priorityKeys.length}`);
} finally {
  git('reset', '-q');
  git('checkout', '--', 'src/signals.c');
}
