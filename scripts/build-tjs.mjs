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

const repo = path.resolve(new URL('..', import.meta.url).pathname);
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
  // that is not mimalloc/Apple — OpenBSD removed malloc.h entirely (stdlib.h
  // is the home of malloc there, and malloc_usable_size does not exist; the
  // usable-size helper already returns 0 on the #else branch). Matrix
  // dispatch #5, 2026-07-10; txiki upstream candidate.
  const f = path.join(dir, 'src/mem.c');
  const src = fs.readFileSync(f, 'utf8');
  if (src.includes('__OpenBSD__')) {
    console.log('fixup mem-malloc-h-openbsd: already applied');
    return;
  }
  const anchor = '#else\n#include <malloc.h>\n#endif';
  if (!src.includes(anchor)) {
    throw new Error('fixup mem-malloc-h-openbsd: anchor not found (mem.c changed under the pin — re-derive the fixup)');
  }
  fs.writeFileSync(f, src.replace(anchor, '#elif !defined(__OpenBSD__)\n#include <malloc.h>\n#endif'));
  console.log('fixup mem-malloc-h-openbsd: applied');
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
  fixupLwsDragonflySoPriority(tjsDir);
  fixupLwsIpv6PrefGuard(tjsDir);
  fixupMemMallocHOpenbsd(tjsDir);
  fixupLibuvSunosDefpath(tjsDir);
  fixupQjsSunosB64(tjsDir);
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
      '--external:tjs:*', ...extra, ...common], { cwd: dir });
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
    run('npm', ['install', '--no-save', '--no-audit', '--no-fund', pin], { cwd: dir });
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

const jobs = String(cpus().length);
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
if (process.platform !== 'darwin') {
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
  cmakeArgs.push('-DCMAKE_C_FLAGS=-Wno-error=unused-variable -Wno-error=unknown-pragmas');
}
run('cmake', ['-S', tjsDir, '-B', path.join(tjsDir, 'build'), ...cmakeArgs]);

// ---- big-endian bundle regen, part 2: tjsc-regenerate the .c natively -------
// os.endianness() here reflects the TARGET: this script runs UNDER the tjs
// toolchain's node (host node for native legs; the emulated guest node under
// qemu-user for a cross leg), so 'BE' means the tjs we are about to build is
// big-endian and the shipped LE bytecode arrays would fail its boot checksum.
// CLODE_TJS_REGEN=1 forces it anywhere (used to validate the pipeline on an LE
// control — the sparc campaign proved regen on a darwin control first).
// LE targets skip this entirely: the published darwin/x64/arm-musl artifacts
// keep the upstream shipped .c, byte-for-byte the validated pinned config.
const beTarget = os.endianness() === 'BE';
const forceRegen = process.env.CLODE_TJS_REGEN === '1';
if (beTarget || forceRegen) {
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
fs.copyFileSync(path.join(tjsDir, 'build/tjs'), path.join(outDir, 'tjs'));
fs.chmodSync(path.join(outDir, 'tjs'), 0o755);

const smoke = runOut(path.join(outDir, 'tjs'),
  ['eval', 'console.log(typeof __tjs_fs_sync === "object" ? "tjs-shim-ok" : "MISSING-SYNC-FS")']);
if (smoke !== 'tjs-shim-ok') throw new Error(`smoke failed: ${smoke}`);
console.log(`built ${path.join(outDir, 'tjs')} (${smoke})`);
