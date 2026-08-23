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
// Defined only on Windows in uv.h; node still exposes it (as 0) everywhere.
const GUARDED_WITH_ZERO = new Set(['UV_FS_O_FILEMAP']);

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
// entries in node's src/node_constants.cc (v24.19.0: DefineErrnoConstants,
// DefineSignalConstants, DefineFsConstants, DefineDLOpenConstants,
// DefinePriorityConstants). That list is a UNION across platforms — node emits it
// under #ifdef exactly as we do — so it is the only correct input. With
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
// The staleness check below will tell you when that is due.
const NODE_CONSTANTS = {
  fs: [
    'UV_FS_SYMLINK_DIR', 'UV_FS_SYMLINK_JUNCTION', 'O_RDONLY', 'O_WRONLY', 'O_RDWR',
    'UV_DIRENT_UNKNOWN', 'UV_DIRENT_FILE', 'UV_DIRENT_DIR', 'UV_DIRENT_LINK',
    'UV_DIRENT_FIFO', 'UV_DIRENT_SOCKET', 'UV_DIRENT_CHAR', 'UV_DIRENT_BLOCK',
    'S_IFMT', 'S_IFREG', 'S_IFDIR', 'S_IFCHR', 'S_IFBLK', 'S_IFIFO', 'S_IFLNK',
    'S_IFSOCK', 'O_CREAT', 'O_EXCL', 'UV_FS_O_FILEMAP', 'O_NOCTTY', 'O_TRUNC',
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
  console.error(`host node ${process.version} exposes ${stale.length} name(s) missing from`);
  console.error('NODE_CONSTANTS in this file — node grew a constant. Re-transcribe the');
  console.error('NODE_DEFINE_CONSTANT lists from node\'s src/node_constants.cc, then rerun:');
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
     * refuses an engine that predates it rather than fusing a quaude that is subtly
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
            JS_SetPropertyStr(ctx, o_, arr[i_].name, JS_NewInt64(ctx, arr[i_].val));  \\
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
    + `#define CLODE_CONSTANTS_ABI ${ABI}\n`
    + `#define CLODE_ABI_MARKER "clode-constants-abi:${ABI}"\n`;
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
