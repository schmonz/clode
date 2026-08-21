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
//   CLODE_TJS_REGEN   =0: SKIP regenerating src/bundles/c/** from src/js/**
//                     (default is to always regenerate — see the "bytecode
//                     regen" section below). Opt out only for a fast dev loop
//                     when src/js/** is provably untouched; never for a
//                     release or CI build, since it ships whatever bytecode
//                     happened to already be sitting in the checkout.
//   CLODE_TJS_LOCAL_ROOT  overrides the local-scratch base dir the vendor
//                     checkout and cmake build dir default under (see
//                     localScratchRoot() below) — otherwise TMPDIR, then the
//                     platform default. Avoids building over NFS.
//   CLODE_TJS_BUILD   overrides the cmake BUILD dir root directly (default:
//                     <local-scratch>/clode-tjs-build/<target-token>/build).
//                     Independent of CLODE_TJS_OUT, which is still where the
//                     FINAL built exe lands.
//
// Phases (CI splits them so a qemu-user guest only pays for the C build):
//   --source-only  stop after checkout + sha-verify + patches
//   --build-only   skip checkout/patches (tree must exist), cmake + smoke only
//   (default: both — the local flow, unchanged)
//
// Windows toolchain: the native build uses MSVC (cl.exe) by DEFAULT — the canonical
// compiler for the shipping windows-amd64 / windows-arm64 legs (scripts/tjs-legs.mjs
// msvc:true); mingw is retired. Prerequisites: Visual Studio 2022 Build Tools with
// the "Desktop development with C++" workload, which bundles cl.exe, the Windows SDK,
// cmake, AND ninja:
//   winget install --id Microsoft.VisualStudio.2022.BuildTools -e \
//     --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
// Then run from a "x64 Native Tools Command Prompt for VS 2022" (or after vcvars64.bat
// / vcvarsall.bat <arch>, so cl+cmake+ninja are on PATH):
//   node scripts/build-tjs.mjs --build-only        # -> build/tjs/tjs.exe, no env flag
// CLODE_TJS_WIN_MINGW=1 opts into the retired mingw-gcc path instead.
import { execFileSync } from 'node:child_process';
import os, { cpus } from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import { resetCheckoutToPristine } from './tjs-source-reset.mjs';

const require = createRequire(import.meta.url);
const { tjsDir: platformTjsDir, tjsVendorParentDir } = require('./platform-tag.cjs'); // tjsDir aliased: this file has its own `tjsDir` (the source build dir)
const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const sourceOnly = process.argv.includes('--source-only');
const buildOnly = process.argv.includes('--build-only');
if (sourceOnly && buildOnly) throw new Error('pick one of --source-only / --build-only');
// CLODE_TJS_DARWIN_POLL=1: build libuv's generic poll(2) event backend instead of
// kqueue (the 10.4-floor darwin legs — Darwin 8's kqueue drops events under the
// fused runtime's fd load; see fixupLibuvPollBackendOldDarwin). posix-poll.c
// replaces kqueue.c, which only the Apple/BSD cmake branches compile, so asking
// for it off-darwin is a build-config bug — fail here, before any phase, rather
// than emitting an engine whose backend silently did not change.
const darwinPoll = process.env.CLODE_TJS_DARWIN_POLL === '1';
if (darwinPoll) {
  const cf = process.env.CLODE_TJS_CROSS_FILE || '';
  const targetsDarwin = cf ? /darwin/.test(path.basename(cf)) : process.platform === 'darwin';
  if (!targetsDarwin) {
    throw new Error(`CLODE_TJS_DARWIN_POLL=1 is darwin-only (target: ${cf || process.platform})`);
  }
}
// ---- NFS avoidance: build intermediates default to LOCAL disk -------------
// This repo commonly lives on an NFS-mounted tree (a shared dev-box mount —
// ap-juicer:/export/code/trees on this box). Compiling and linking thousands
// of small object files over NFS is dramatically slower than local disk, and
// NFS mounts here carry AppleDouble ._* sidecars (resetCheckoutToPristine
// actively strips them from the vendor checkout on every build — the
// "Removing lib/tls/mbedtls/._mbedtls-x509.c" noise). CI already points
// CLODE_TJS_VENDOR/CLODE_TJS_OUT at the runner's own (local) scratch dir
// explicitly (.github/actions/build-leg/action.yml) — every default changed
// here therefore only affects local dev on a box like this one, never CI.
// CLODE_TJS_LOCAL_ROOT overrides the local-scratch base directory (e.g. to
// force a specific volume); otherwise TMPDIR (respected, not just os.tmpdir()
// — TMPDIR is the standard "fast local scratch" seam on macOS/BSD, usually
// /var/folders/... on the boot volume, never the NFS mount) or the platform
// default. Stable, not a fresh mktemp per run, so incremental rebuilds still
// hit the same object files/cmake cache.
function localScratchRoot() {
  return process.env.CLODE_TJS_LOCAL_ROOT || process.env.TMPDIR || os.tmpdir();
}
// Vendor source: reconstructed scratch (a pinned clone + patches/*.patch, not
// precious — see ensureCheckout below), and the SHARED single checkout every
// target build patches/resets/re-patches from (deliberately, not per-target —
// same comment as the buildDir one below). Moving its default off NFS is
// exactly what stops the AppleDouble stripping from being needed on THIS
// box's normal path (it stays as a belt-and-braces guard for anyone who still
// points CLODE_TJS_VENDOR at an NFS/SMB/exotic filesystem). A stale local
// checkout cannot silently diverge from the committed patches: ensureCheckout
// re-verifies the pinned HEAD sha and applyPatches unconditionally re-applies
// every patches/*.patch onto a freshly pristine tree on every single build —
// nothing about a persistent local path changes that contract. Computed by
// tjsVendorParentDir() (scripts/platform-tag.cjs), NOT inlined here, so
// test/tjs-darwin-poll-fixup.test.cjs and test/tls-cacert-pem.test.cjs — which
// read that SAME checkout directly — resolve the identical default instead of
// a hand-copy that silently stops matching (and silently starts skipping)
// the moment this default changes.
const vendor = tjsVendorParentDir(process.env);
const patches = path.join(repo, 'spike/quickjs/patches');
// Default output is platform-unique (build/tjs/<osToken>-<arch>) so a shared
// (NFS) tree can't have one platform's build clobber another's. CI overrides the
// whole path via CLODE_TJS_OUT (per-target), so this default is local-build only.
const outDir = process.env.CLODE_TJS_OUT || platformTjsDir(repo);
const wantStatic = process.env.CLODE_TJS_STATIC === '1';
// CLODE_TJS_WASM=off: drop WASM/WAMR support. Needed on arches where WAMR's
// posix_memmap.c references MAP_32BIT, a Linux mmap flag defined ONLY for
// x86/x86_64/aarch64 — s390x/ppc64le/riscv64 fail to compile (first found on
// the s390x BE-oracle leg 2026-07-09). That leg only runs --version +
// the node-shim suite (no bundle boot, no WebAssembly), so WASM-off is free
// there. A real fix (guard MAP_32BIT to 0 when undefined, upstream WAMR) is
// queued for the Q3 batch; patches/ is frozen this phase.
// Lean-POSIX targets — the BSDs, illumos, and other non-Linux/Darwin/Windows Unix —
// default WASM/mimalloc/FFI OFF so a NATIVE `node scripts/build-tjs.mjs` on such a
// host matches the SHIPPING recipe (scripts/tjs-legs.mjs: every T2 VM leg sets
// wasm/mimalloc/ffi off) with no flags to remember: they can't build WAMR (Linux
// mremap/MAP_32BIT), hit the mimalloc 3.2.7 compile regression, and ship no tjs:ffi.
// Explicit CLODE_TJS_* still wins (CI sets them; a proven platform can re-enable).
// CLODE_TJS_TARGET=cosmo — the Cosmopolitan APE leg (spike/quickjs/results/
// cosmo-fidelity-run.md): ONE fat (x86-64 + aarch64) Actually Portable
// Executable that runs native on Linux/macOS/Windows/BSD. It is NOT keyed off
// the host platform (cosmo cross-builds from any host); it is its own target
// token that forces the lean profile, provisions cosmocc, applies the two named
// cosmo patches, drives scripts/cosmo.toolchain.cmake, and builds tjs-cli.
const cosmoTarget = (process.env.CLODE_TJS_TARGET || '').toLowerCase() === 'cosmo';
const _leanPosix = !['linux', 'darwin', 'win32'].includes(process.platform);
const _tjsKnob = (env, onByDefault) => (process.env[env] || (onByDefault ? 'on' : 'off')).toLowerCase() !== 'off';
let wantWasm = _tjsKnob('CLODE_TJS_WASM', !_leanPosix);
// CLODE_TJS_MIMALLOC=off: system malloc instead of mimalloc. mimalloc 3.2.7
// does not compile on NetBSD at all (its __NetBSD__ branch references the
// renamed mi_option_eager_commit_delay enum member — upstream regression,
// committed finding in spike/quickjs/qemu/guest-m4.sh). VM legs start with
// it off and re-enable per-platform as they prove.
let wantMimalloc = _tjsKnob('CLODE_TJS_MIMALLOC', !_leanPosix);
// CLODE_TJS_FFI=off: drop tjs:ffi (needs system libffi headers in the guest;
// nothing shipped imports it — bun:ffi is a throw-on-use stub). The STATIC
// knob already implies this; VM legs set it independently of static.
let wantFfi = _tjsKnob('CLODE_TJS_FFI', !_leanPosix);
// cosmo FORCES the lean profile regardless of host or explicit knobs: WAMR
// (Linux mremap/MAP_32BIT), mimalloc, and tjs:ffi do not build under cosmocc —
// the verified recipe builds none of them (cosmo-fidelity-run.md §1.4).
if (cosmoTarget) { wantWasm = false; wantMimalloc = false; wantFfi = false; }
if (cosmoTarget) {
  console.error('build-tjs: cosmo target — forcing wasm/mimalloc/ffi OFF (the lean profile; none build under cosmocc)');
} else if (_leanPosix && !(process.env.CLODE_TJS_WASM || process.env.CLODE_TJS_MIMALLOC || process.env.CLODE_TJS_FFI)) {
  console.error(`build-tjs: ${process.platform} is a lean-POSIX target — defaulting wasm/mimalloc/ffi OFF ` +
    `to match scripts/tjs-legs.mjs (override any with CLODE_TJS_WASM/MIMALLOC/FFI=on)`);
}
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

// ---- cosmocc toolchain provisioning (CLODE_TJS_TARGET=cosmo) --------------
// The cosmo APE is built with cosmocc, a single self-contained toolchain zip.
// Provision it the SAME shape clode-node.cjs fetches the pinned Node: download →
// sha256-verify against the pin (fail loud) → extract → cache. The download uses
// clode-net's downloadFile/sha256Of (the no-curl seam); the extract routes
// through host-provision's KAT-verified `unzip` (libexec/host-provision.cjs).
// Cross-build-safe: only the cosmo target reaches here, and only in the build
// phase. Pin: cosmocc-4.0.2.zip (github.com/jart/cosmopolitan).
const COSMOCC_VERSION = '4.0.2';
const COSMOCC_SHA256 = '85b8c37a406d862e656ad4ec14be9f6ce474c1b436b9615e91a55208aced3f44';
const COSMOCC_URL = `https://cosmo.zip/pub/cosmocc/cosmocc-${COSMOCC_VERSION}.zip`;

// cosmocc ships its OWN ar/ranlib (host ranlib can't index cosmo's fat archives —
// see scripts/cosmo.toolchain.cmake). The zip may land them non-exec on some
// hosts/unzip; force +x on the tools the toolchain file invokes. Idempotent.
function ensureCosmoToolsExec(binDir) {
  for (const t of ['cosmoranlib', 'cosmoar', 'cosmocc', 'cosmoc++']) {
    const p = path.join(binDir, t);
    if (fs.existsSync(p)) { try { fs.chmodSync(p, 0o755); } catch { /* best effort */ } }
  }
}

// Return the cosmocc bin dir (what scripts/cosmo.toolchain.cmake reads as
// CLODE_COSMOCC). Honors an explicit CLODE_COSMOCC install; otherwise fetches +
// verifies + extracts into the clode cache (CLODE_CACHE or ~/.cache/clode).
async function provisionCosmocc() {
  const { downloadFile, sha256Of } = require(path.join(repo, 'libexec/clode-net.cjs'));
  const { provision } = require(path.join(repo, 'libexec/host-provision.cjs'));

  const explicit = process.env.CLODE_COSMOCC;
  if (explicit && fs.existsSync(path.join(explicit, 'cosmocc'))) {
    ensureCosmoToolsExec(explicit);
    console.log(`cosmo: using CLODE_COSMOCC=${explicit}`);
    return explicit;
  }

  const cacheRoot = process.env.CLODE_CACHE || path.join(os.homedir(), '.cache', 'clode');
  const dir = path.join(cacheRoot, 'cosmocc', COSMOCC_VERSION);
  const binDir = path.join(dir, 'bin');
  if (fs.existsSync(path.join(binDir, 'cosmocc'))) {
    ensureCosmoToolsExec(binDir);
    console.log(`cosmo: cosmocc ${COSMOCC_VERSION} already provisioned at ${binDir}`);
    return binDir;
  }

  const zip = path.join(cacheRoot, 'cosmocc', `cosmocc-${COSMOCC_VERSION}.zip`);
  fs.mkdirSync(path.dirname(zip), { recursive: true });
  if (!fs.existsSync(zip)) {
    console.log(`cosmo: downloading ${COSMOCC_URL} (441MB) ...`);
    const part = `${zip}.part`;
    await downloadFile(COSMOCC_URL, part);
    fs.renameSync(part, zip);
  }
  const got = sha256Of(zip);
  if (got !== COSMOCC_SHA256) {
    fs.rmSync(zip, { force: true });
    throw new Error(`cosmo: cosmocc-${COSMOCC_VERSION}.zip sha mismatch (expected ${COSMOCC_SHA256}, got ${got}) — refusing to use it`);
  }
  const { path: unzipBin } = provision('unzip');
  fs.mkdirSync(dir, { recursive: true });
  run(unzipBin, ['-o', '-q', zip, '-d', dir]);
  if (!fs.existsSync(path.join(binDir, 'cosmocc'))) {
    throw new Error(`cosmo: extraction of ${zip} did not produce ${binDir}/cosmocc`);
  }
  ensureCosmoToolsExec(binDir);
  console.log(`cosmo: cosmocc ${COSMOCC_VERSION} provisioned at ${binDir}`);
  return binDir;
}

// Apply the two NAMED cosmo patches. They are deliberately NOT prefixed
// txiki-/quickjs-ng-, so orderedPatches()'s auto-apply globs skip them: they are
// cosmo-only. Both are __COSMOPOLITAN__-guarded (behavior-neutral for other
// targets) but still edit CMakeLists/source, so they must never touch the
// default legs. libuv-cosmo.patch is based at deps/libuv (a submodule) — applied
// THERE; libwebsockets-cosmo.patch is based at deps/libwebsockets (a submodule,
// fixes lws sha-1.c's BYTE_ORDER macros so the WebSocket accept-hash check works
// under cosmo — see the patch header); libtjs-cosmo.patch is based at the txiki
// root (src/*).
function applyCosmoPatches(dir) {
  // The cosmo patches live in the repo-root patches/ dir (NOT spike/quickjs/
  // patches/, which holds the txiki-*/quickjs-ng-* engine patches).
  const cosmoPatches = path.join(repo, 'patches');
  run('git', ['-C', path.join(dir, 'deps/libuv'), 'apply', path.join(cosmoPatches, 'libuv-cosmo.patch')]);
  console.log('patch libuv-cosmo.patch: applied (deps/libuv)');
  run('git', ['-C', path.join(dir, 'deps/libwebsockets'), 'apply', path.join(cosmoPatches, 'libwebsockets-cosmo.patch')]);
  console.log('patch libwebsockets-cosmo.patch: applied (deps/libwebsockets)');
  run('git', ['-C', dir, 'apply', path.join(cosmoPatches, 'libtjs-cosmo.patch')]);
  console.log('patch libtjs-cosmo.patch: applied');
}

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
  // Return PRISTINE source: applyPatches mutates the tree in place with no
  // rollback, so a killed/failed prior build leaves it partially patched and
  // poisons the next build. Reset here so every build starts clean (reentrancy).
  resetCheckoutToPristine(dir, { run });
  return dir;
}

// THE application order. Every patch applies UNCONDITIONALLY — a plain
// `git apply` onto a pristine v26.6.0 clone, in this sequence, with no
// reverse-check or content-presence fallback (verified 2026-07-25: fresh
// clone, 12/12 clean). 10 of these are order-INDEPENDENT (they touch files no
// other patch touches, or non-overlapping regions); only sync-spawn and
// vm-context must follow sync-fs, since all three register into the shared
// src/vm.c / CMakeLists.txt / src/private.h (init call + source entry + decl).
// Every txiki-*.patch in patches/ MUST appear here; a new patch without a
// documented position fails loudly.
const TXIKI_PATCH_ORDER = [
  'txiki-default-stack-size.patch',
  'txiki-netbsd-portability.patch',
  'txiki-no-origin-header.patch',
  'txiki-spawn-inherit-fd.patch',   // carries the spawn-fail UAF fix too (the old separate uaf patch was fully subsumed and removed 2026-07-25)
  'txiki-stream-write-sync-number.patch',
  'txiki-sync-fs.patch',                      // shared vm.c/CMakeLists/private.h registration — before sync-spawn + vm-context
  'txiki-sync-spawn.patch',                   // registers after sync-fs
  'txiki-wurl-url.patch',
  'txiki-unhandledrejection-no-abort.patch',
  'txiki-vm-context.patch',                   // registers after sync-fs + sync-spawn: new mod_vm.c + shared-file wiring
  'txiki-node-constants.patch',               // expose THIS engine's own fs/signals/errno/dlopen/priority constants as globalThis.__tjs_constants (signals.c only; order-independent). GENERATED by scripts/gen-node-constants.mjs — regenerate, do not hand-edit. Supersedes the hand-written signal/errno tables.
  'txiki-readdir-dtype-fallback.patch',       // lstat-resolve UV_DIRENT_UNKNOWN in readDir (NFS/no-d_type filesystems), match node (mod_fs.c only; order-independent)
  'txiki-timer-unref.patch',                  // core.unrefTimer/refTimer (timers.c) + AbortSignal.timeout unrefs its internal timer (abort-controller.js), matching node's Timeout#unref — order-independent
  'txiki-fetch-abort-reason.patch',           // an aborted fetch rejects with the signal's OWN reason (TimeoutError, custom abort reasons) instead of flattening every one to AbortError (fetch.js only; order-independent)
  'txiki-fetch-url-input.patch',               // fetch() accepts a URL object (and a Request), not just a string — .href before .url; MCP-over-HTTP built a URL and died in "Invalid URL" (fetch.js; after fetch-abort-reason, same file)
  'txiki-timer-update-time.patch',            // uv_update_time() before arming, so a timer armed during initial sync execution is not EARLY by however long the script already ran (timers.c; disjoint hunk from timer-unref's, but keep it after)
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

// Apply every patch UNCONDITIONALLY: a plain `git apply` onto the (pristine, in
// TXIKI_PATCH_ORDER) tree. No reverse-check, no content-presence fallback — a
// patch that does not apply is a real error (a stale patch or a moved pin), and
// it fails loud. This assumes a FRESH checkout of the pin; do not point it at an
// already-patched tree (see BACKLOG "build-working-dir isolation": copy from
// pristine, never reset in place).
function applyPatches(dir, prefix) {
  for (const p of orderedPatches(prefix)) {
    run('git', ['-C', dir, 'apply', path.join(patches, p)]);
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

function fixupLibuvHaikuStdioPipe(dir) {
  // saghul's libuv fork creates child stdio as a SOCK_STREAM socketpair (with
  // SO_SNDBUF/SO_RCVBUF forced to 64KB). On Haiku that socketpair's write
  // flow-control is BROKEN: a BLOCKING write past the ~64KB buffer returns EPIPE
  // ("Broken pipe") instead of blocking, and the peer read gets nothing. So a
  // spawned child that writes > 64KB to its stdout before exiting deadlocks — its
  // write EPIPEs and drops the rest, the parent hangs reading nothing. This first
  // bit when the quaude ext-dep closure grew (9e968b4) and pushed --quaude-attest's
  // manifest print past 64KB (64,040 -> 85,696): every Haiku `clode build` then hung
  // in attest and clode's own timeout SIGKILLed it. Root-caused on a local Haiku box
  // (spike/quickjs/qemu/HAIKU-BOX.md): instrumented the child's fwrite (=65536,
  // ferror=1, errno=EPIPE); sh children and tjs-over-a-real-pipe both work; removing
  // just the setsockopt did NOT help — the socketpair itself is the fault. Every
  // platform uses this socketpair; only Haiku's blocks-vs-EPIPEs semantics is wrong
  // (OpenBSD/DragonFly share the fork/exec path and don't deadlock). libuv upstream
  // candidate.
  //
  // Fix: use a real pipe() for the common UNIDIRECTIONAL child stdio
  // (stdin/stdout/stderr); a single pipe cannot serve a bidirectional
  // (UV_READABLE_PIPE && UV_WRITABLE_PIPE) container, so keep the socketpair only
  // there. uv__make_pipe gives fds[0]=read / fds[1]=write, and the caller keeps
  // fds[0] (parent) while the child gets fds[1] — correct for a WRITABLE (stdout/
  // stderr) child; for a READABLE (stdin) child, swap so the child gets the read
  // end. Verified both directions on the box (85KB stdout, no deadlock; a stdin
  // child read all its input).
  const f = path.join(dir, 'deps/libuv/src/unix/process.c');
  const src = fs.readFileSync(f, 'utf8');
  if (src.includes('uv__make_pipe(fds, 0)')) {
    console.log('fixup libuv-haiku-stdio-pipe: already applied');
    return;
  }
  const anchor = '      ret = uv_socketpair(SOCK_STREAM, 0, fds, 0, 0);\n'
    + '\n'
    + '      if (ret == 0)\n'
    + '        for (i = 0; i < 2; i++) {\n'
    + '          setsockopt(fds[i], SOL_SOCKET, SO_RCVBUF, &size, sizeof(size));\n'
    + '          setsockopt(fds[i], SOL_SOCKET, SO_SNDBUF, &size, sizeof(size));\n'
    + '        }';
  if (!src.includes(anchor)) {
    throw new Error('fixup libuv-haiku-stdio-pipe: anchor not found (libuv changed under the pin — re-derive the fixup)');
  }
  const repl = '#if defined(__HAIKU__)\n'
    + '      /* Haiku SOCK_STREAM socketpair stdio deadlocks (write > 64KB EPIPEs\n'
    + '       * instead of blocking); use a real pipe() for unidirectional stdio,\n'
    + '       * keeping the socketpair only for a bidirectional container. */\n'
    + '      if ((container->flags & (UV_READABLE_PIPE | UV_WRITABLE_PIPE))\n'
    + '          != (UV_READABLE_PIPE | UV_WRITABLE_PIPE)) {\n'
    + '        ret = uv__make_pipe(fds, 0);  /* fds[0]=read, fds[1]=write; child gets fds[1] */\n'
    + '        if (ret == 0 && (container->flags & UV_READABLE_PIPE)) {\n'
    + '          int tmp = fds[0]; fds[0] = fds[1]; fds[1] = tmp;  /* stdin child needs the read end */\n'
    + '        }\n'
    + '        (void) size;\n'
    + '      } else {\n'
    + '        ret = uv_socketpair(SOCK_STREAM, 0, fds, 0, 0);\n'
    + '        if (ret == 0)\n'
    + '          for (i = 0; i < 2; i++) {\n'
    + '            setsockopt(fds[i], SOL_SOCKET, SO_RCVBUF, &size, sizeof(size));\n'
    + '            setsockopt(fds[i], SOL_SOCKET, SO_SNDBUF, &size, sizeof(size));\n'
    + '          }\n'
    + '      }\n'
    + '#else\n'
    + anchor + '\n'
    + '#endif';
  fs.writeFileSync(f, src.replace(anchor, repl));
  console.log('fixup libuv-haiku-stdio-pipe: applied');
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

function fixupLibuvTtyKqueueOldDarwin(dir) {
  // On pre-10.6 Darwin (Tiger, kernel major < 10) kqueue ACCEPTS a tty fd at
  // registration (no EINVAL — so libuv's uv__stream_try_select detection decides
  // kqueue is fine) but then mis-signals it readable at runtime, so libuv issues
  // a BLOCKING read() on the tty that never returns → the interactive TUI hangs
  // before drawing a single frame. Confirmed by ktrace on 10.4.11/PPC:
  //   kevent(...) → RET 1;  read(0, ...) → (blocked; only unblocked by SIGKILL)
  // `-p` (socket I/O) is unaffected — only the TTY is broken. Force the proven
  // select() path (a select(2) helper thread) for ttys on those kernels; select
  // polls ttys correctly on old Darwin. Gated on Darwin major < 10 at runtime, so
  // modern Darwin (arm64/x64, major ≥ 10) is a strict no-op. uv__stream_try_select
  // is __APPLE__-only, so the added uname() never runs on Linux. libuv upstream
  // candidate.
  const f = path.join(dir, 'deps/libuv/src/unix/stream.c');
  const src = fs.readFileSync(f, 'utf8');
  const marker = 'CLODE tty-kqueue fixup';
  if (src.includes(marker)) {
    console.log('fixup libuv-tty-kqueue-old-darwin: already applied');
    return;
  }
  const incAnchor = '#include <unistd.h>\n';
  const gateAnchor = '  if (ret == 0 || (events[0].flags & EV_ERROR) == 0 || events[0].data != EINVAL)\n    return 0;\n';
  if (!src.includes(incAnchor) || !src.includes(gateAnchor)) {
    throw new Error('fixup libuv-tty-kqueue-old-darwin: anchor not found (libuv changed under the pin — re-derive the fixup)');
  }
  const gateNew =
    '  if (ret == 0 || (events[0].flags & EV_ERROR) == 0 || events[0].data != EINVAL) {\n' +
    '    /* ' + marker + ': pre-10.6 Darwin (Tiger) mis-signals ttys via kqueue,\n' +
    '       hanging on a blocking read(); force the select() path for ttys there. */\n' +
    '    struct utsname clode_uts;\n' +
    '    if (!(isatty(*fd) && uname(&clode_uts) == 0 && atoi(clode_uts.release) < 10))\n' +
    '      return 0;\n' +
    '  }\n';
  const out = src
    .replace(incAnchor, incAnchor + '#include <sys/utsname.h> /* CLODE tty-kqueue fixup: uname() */\n')
    .replace(gateAnchor, gateNew);
  fs.writeFileSync(f, out);
  console.log('fixup libuv-tty-kqueue-old-darwin: applied');
}

function fixupLibuvPollBackendOldDarwin(dir) {
  // Darwin 8 (Tiger) kqueue DROPS event delivery under the fused runtime's fd/
  // filter load: ktrace of a hung ppc quaude shows connect() returning
  // EINPROGRESS, ~12 fds registered, then kevent(nchanges=0, ...) → 0 forever —
  // the socket's write-readiness never arrives. It is systemic, not socket-
  // specific: pipes (tool stdout), child exit, async/threadpool wakeups (DNS,
  // fs, workers), signals and vnode all funnel through uv__io_poll too. So the
  // fix is ONE thing — build libuv's generic poll(2) backend (posix-poll.c,
  // already shipped for AIX/QNX/Cygwin and for our own cosmo leg) instead of
  // kqueue.c — not a per-mechanism osx_select patch, which would leave every
  // other mechanism exposed.
  //
  // Dropping UV_HAVE_KQUEUE is the load-bearing edit, not cosmetics: process.c
  // gates on it (`#ifdef UV_HAVE_KQUEUE ... #else #define UV_USE_SIGCHLD`) and
  // otherwise watches child exit with EVFILT_PROC on loop->backend_fd, which is
  // -1 under posix-poll — every spawned tool would be reaped never. Without it,
  // child exit rides SIGCHLD → signal self-pipe → poll, and async.c falls back
  // to pipe wakeups.
  //
  // TTYs are untouched: stream.c's uv__stream_osx_select select()-thread path
  // (plus fixupLibuvTtyKqueueOldDarwin, which forces it for ttys on Darwin < 10)
  // already works on Tiger, and the loop only ever watches its socketpair.
  //
  // ACCEPTED LOSS: uv_fs_event → UV_ENOSYS (no-fsevents.c). posix-poll has no
  // fs-event implementation and there is no portable POSIX primitive. Nothing in
  // the product reaches it — node-shim's fs.watch/watchFile are EventEmitter
  // stubs that never call tjs.watch (modules/fs.cjs:718-742, characterized by
  // test/node-shim-fs-watch.test.cjs), no fs.watch call exists in libexec/ or
  // bin/clode, and the shipping cosmo leg already builds no-fsevents.c. Engine-
  // level tjs.watch() throws on these two legs; both are no-exec, so no CI job
  // executes it. That ENOSYS is a RUNTIME behavior, separate from a LINK-time
  // hazard fixed by edit (6) below: core.c unconditionally calls the internal
  // uv__fs_event() io-callback (never invoked in practice, since uv_fs_event_init
  // always fails first — but still referenced), and internal.h's UNREACHABLE()
  // stub for it only compiles in when __APPLE__ is undefined. Dropping kqueue.c
  // (the only real definition) without widening that guard leaves the symbol
  // undefined at link time on Apple.
  //
  // These edits are UNCONDITIONAL and inert: everything is guarded on
  // CLODE_DARWIN_POLL, which only the darwin-poll legs define (build-tjs passes
  // -DCLODE_DARWIN_POLL=ON from CLODE_TJS_DARWIN_POLL=1). Every shipping leg —
  // darwin-x64 (10.6 floor, proven on real Mavericks), darwin-arm64, and all
  // non-darwin legs — compiles byte-identically. libuv upstream candidate.
  //
  // The "already applied" gate keys on edit (7)'s marker (the LAST edit this
  // function makes — see that edit, below, for what it does and why), not
  // edit (1)'s — edit (1)'s target text (the CMakeLists.txt option block)
  // starts with the very anchor it matches on, so re-running edit (1) alone
  // against an already-patched tree would silently double-apply rather than
  // no-op. Gating on the last edit means a half-applied tree (crashed
  // between edits) is NEVER reported as "already applied": either every edit's
  // anchor is still pristine (full re-apply proceeds) or an earlier edit already
  // landed and its OWN anchor is gone, which throws loudly on retry — both
  // acceptable outcomes; silently reporting success on a half-patched tree is
  // the one outcome the fixup contract forbids.
  const internalHF = path.join(dir, 'deps/libuv/src/unix/internal.h');
  const pollCF = path.join(dir, 'deps/libuv/src/unix/posix-poll.c');
  const pollSelectMarker = 'static int uv__clode_poll_select(struct pollfd* fds, nfds_t nfds, int timeout)';
  if (fs.readFileSync(pollCF, 'utf8').includes(pollSelectMarker)) {
    console.log('fixup libuv-poll-backend-old-darwin: already applied');
    return;
  }
  // (1) The option + a GLOBAL compile definition. It must be global, not a
  // uv_defines entry: it changes uv_loop_t's layout via UV_PLATFORM_LOOP_FIELDS,
  // so libuv and txiki TUs must agree or the ABI silently mismatches. Placed
  // right after project() so every target here and in deps/libuv (added at
  // :252) inherits the directory property. Anchored on the POST-fixup project()
  // line (`fixupTjsCmakeCxxOnlyForAda`, which runs earlier in the list, already
  // rewrote it from upstream's "C CXX" down to "C") since fixups run in order
  // against the tree as previously modified, not against pristine upstream.
  const tjsCmakeF = path.join(dir, 'CMakeLists.txt');
  const tjsCmake = fs.readFileSync(tjsCmakeF, 'utf8');
  const projAnchor = 'project(tjs LANGUAGES C)\n';
  if (!tjsCmake.includes(projAnchor)) {
    throw new Error('fixup libuv-poll-backend-old-darwin: project() anchor not found (txiki changed under the pin — re-derive the fixup)');
  }
  const optionBlock = projAnchor
    + '\n# CLODE: old-Darwin (10.4 floor) builds libuv\'s generic poll(2) backend —\n'
    + '# Darwin 8 kqueue drops events under load. Global by necessity: it changes\n'
    + '# uv_loop_t\'s layout, so libuv and txiki TUs must agree.\n'
    + 'option(CLODE_DARWIN_POLL "Use libuv\'s generic poll(2) event backend instead of kqueue (old Darwin)" OFF)\n'
    + 'if(CLODE_DARWIN_POLL)\n'
    + '    add_compile_definitions(CLODE_DARWIN_POLL)\n'
    + 'endif()\n';
  fs.writeFileSync(tjsCmakeF, tjsCmake.replace(projAnchor, optionBlock));

  // (2) libuv's source lists: kqueue.c out, posix-poll.c + no-fsevents.c in.
  // The BSD-family branch is anchored with "MidnightBSD|" already threaded in —
  // `fixupLibuvMidnightbsd` runs earlier in the list and already widened this
  // exact MATCHES clause, so the tree this fixup sees is post-that-edit, not
  // pristine upstream.
  const uvCmakeF = path.join(dir, 'deps/libuv/CMakeLists.txt');
  const uvCmake = fs.readFileSync(uvCmakeF, 'utf8');
  const bsdOld = 'if(APPLE OR CMAKE_SYSTEM_NAME MATCHES "DragonFly|FreeBSD|MidnightBSD|NetBSD|OpenBSD")\n'
    + '  list(APPEND uv_sources src/unix/bsd-ifaddrs.c src/unix/kqueue.c)\n'
    + 'endif()\n';
  const bsdNew = 'if(APPLE OR CMAKE_SYSTEM_NAME MATCHES "DragonFly|FreeBSD|MidnightBSD|NetBSD|OpenBSD")\n'
    + '  list(APPEND uv_sources src/unix/bsd-ifaddrs.c)\n'
    + '  if(NOT CLODE_DARWIN_POLL)\n'
    + '    list(APPEND uv_sources src/unix/kqueue.c)\n'
    + '  endif()\n'
    + 'endif()\n';
  const appleOld = 'if(APPLE)\n'
    + '  list(APPEND uv_defines _DARWIN_UNLIMITED_SELECT=1 _DARWIN_USE_64_BIT_INODE=1)\n'
    + '  list(APPEND uv_sources\n'
    + '       src/unix/darwin-proctitle.c\n'
    + '       src/unix/darwin.c\n'
    + '       src/unix/fsevents.c)\n'
    + 'endif()\n';
  const appleNew = 'if(APPLE)\n'
    + '  list(APPEND uv_defines _DARWIN_UNLIMITED_SELECT=1 _DARWIN_USE_64_BIT_INODE=1)\n'
    + '  list(APPEND uv_sources\n'
    + '       src/unix/darwin-proctitle.c\n'
    + '       src/unix/darwin.c)\n'
    + '  if(CLODE_DARWIN_POLL)\n'
    + '    list(APPEND uv_sources src/unix/posix-poll.c src/unix/no-fsevents.c)\n'
    + '  else()\n'
    + '    list(APPEND uv_sources src/unix/fsevents.c)\n'
    + '  endif()\n'
    + 'endif()\n';
  if (!uvCmake.includes(bsdOld) || !uvCmake.includes(appleOld)) {
    throw new Error('fixup libuv-poll-backend-old-darwin: source-list anchor not found (libuv changed under the pin — re-derive the fixup)');
  }
  fs.writeFileSync(uvCmakeF,
    uvCmake.replace(bsdOld, bsdNew).replace(appleOld, appleNew));

  // (3) darwin.h: no UV_HAVE_KQUEUE, plus posix-poll's loop fields.
  const darwinHF = path.join(dir, 'deps/libuv/include/uv/darwin.h');
  const darwinH = fs.readFileSync(darwinHF, 'utf8');
  const kqOld = '#define UV_HAVE_KQUEUE 1\n';
  const kqNew = '#if !defined(CLODE_DARWIN_POLL)\n#define UV_HAVE_KQUEUE 1\n#endif\n';
  const fieldsOld = '  struct uv__queue cf_signals;                                                \\\n';
  const fieldsNew = fieldsOld + '  UV_CLODE_DARWIN_POLL_FIELDS\n';
  const fieldsDecl = '#if defined(CLODE_DARWIN_POLL)\n'
    + '/* posix-poll.c\'s loop state (uv/posix.h\'s fields); the cf_* fsevents fields\n'
    + '   above stay declared and unused. */\n'
    + '# include <poll.h>\n'
    + '# define UV_CLODE_DARWIN_POLL_FIELDS                                          \\\n'
    + '  struct pollfd* poll_fds;                                                    \\\n'
    + '  size_t poll_fds_used;                                                       \\\n'
    + '  size_t poll_fds_size;                                                       \\\n'
    + '  unsigned char poll_fds_iterating;\n'
    + '#else\n'
    + '# define UV_CLODE_DARWIN_POLL_FIELDS\n'
    + '#endif\n\n';
  const platAnchor = '#define UV_PLATFORM_LOOP_FIELDS                                               \\\n';
  if (!darwinH.includes(kqOld) || !darwinH.includes(fieldsOld) || !darwinH.includes(platAnchor)) {
    throw new Error('fixup libuv-poll-backend-old-darwin: darwin.h anchor not found (libuv changed under the pin — re-derive the fixup)');
  }
  fs.writeFileSync(darwinHF, darwinH
    .replace(platAnchor, fieldsDecl + platAnchor)
    .replace(fieldsOld, fieldsNew)
    .replace(kqOld, kqNew));

  // (4) darwin.c: posix-poll.c supplies both platform hooks; darwin.c's call
  // uv__kqueue_init / uv__fsevents_loop_delete, neither of which is compiled.
  const darwinCF = path.join(dir, 'deps/libuv/src/unix/darwin.c');
  const darwinC = fs.readFileSync(darwinCF, 'utf8');
  const hooksOld = 'int uv__platform_loop_init(uv_loop_t* loop) {\n'
    + '  loop->cf_state = NULL;\n'
    + '\n'
    + '  if (uv__kqueue_init(loop))\n'
    + '    return UV__ERR(errno);\n'
    + '\n'
    + '  return 0;\n'
    + '}\n'
    + '\n'
    + '\n'
    + 'void uv__platform_loop_delete(uv_loop_t* loop) {\n'
    + '  uv__fsevents_loop_delete(loop);\n'
    + '}\n';
  const hooksNew = '#if !defined(CLODE_DARWIN_POLL)\n' + hooksOld + '#endif\n';
  if (!darwinC.includes(hooksOld)) {
    throw new Error('fixup libuv-poll-backend-old-darwin: darwin.c platform-hook anchor not found (libuv changed under the pin — re-derive the fixup)');
  }
  fs.writeFileSync(darwinCF, darwinC.replace(hooksOld, hooksNew));

  // (5) internal.h: EVFILT_USER async wakeups kevent on loop->backend_fd, which
  // posix-poll leaves at -1. Already 0 under the 10.4 SDK (EVFILT_USER is 10.6+),
  // but a modern-SDK poll build (the arm64 validation engine) needs it forced.
  // (internalHF is declared above, by the already-applied gate.)
  const internalH = fs.readFileSync(internalHF, 'utf8');
  const evOld = '#if defined(EVFILT_USER) && defined(NOTE_TRIGGER)\n';
  const evNew = '#if defined(EVFILT_USER) && defined(NOTE_TRIGGER) && !defined(CLODE_DARWIN_POLL)\n';
  if (!internalH.includes(evOld)) {
    throw new Error('fixup libuv-poll-backend-old-darwin: internal.h EVFILT_USER anchor not found (libuv changed under the pin — re-derive the fixup)');
  }
  fs.writeFileSync(internalHF, internalH.replace(evOld, evNew));

  // (6) internal.h: widen the uv__fs_event() UNREACHABLE() shim's guard so it
  // also compiles in under CLODE_DARWIN_POLL. Without this, dropping kqueue.c
  // (edit 2) removes the ONLY definition of uv__fs_event in the tree, but
  // core.c's UV__FS_EVENT case (core.o is always linked) still calls it — the
  // ON build fails at LINK time (undefined symbol uv__fs_event), not merely at
  // runtime. no-fsevents.c supplies uv_fs_event_init/start/stop and
  // uv__fs_event_close (the public API, already ENOSYS'd — see the ACCEPTED
  // LOSS note above) but NOT this internal io-callback symbol. Read fresh:
  // edit (5) just wrote this file.
  const internalH2 = fs.readFileSync(internalHF, 'utf8');
  const fsEvOld = '#if !defined(__APPLE__) &&                                                    \\\n'
    + '    !defined(__DragonFly__) &&                                                \\\n'
    + '    !defined(__FreeBSD__) &&                                                  \\\n'
    + '    !defined(__NetBSD__) &&                                                   \\\n'
    + '    !defined(__OpenBSD__)\n'
    + '#define uv__fs_event(loop, w, events) UNREACHABLE()\n'
    + '#endif\n';
  const fsEvNew = '#if (!defined(__APPLE__) || defined(CLODE_DARWIN_POLL)) &&                    \\\n'
    + '    !defined(__DragonFly__) &&                                                \\\n'
    + '    !defined(__FreeBSD__) &&                                                  \\\n'
    + '    !defined(__NetBSD__) &&                                                   \\\n'
    + '    !defined(__OpenBSD__)\n'
    + '#define uv__fs_event(loop, w, events) UNREACHABLE()\n'
    + '#endif\n';
  if (!internalH2.includes(fsEvOld)) {
    throw new Error('fixup libuv-poll-backend-old-darwin: internal.h uv__fs_event anchor not found (libuv changed under the pin — re-derive the fixup)');
  }
  fs.writeFileSync(internalHF, internalH2.replace(fsEvOld, fsEvNew));

  // (7) posix-poll.c: swap poll(2) for select(2) inside uv__io_poll's wait
  // call. Edits (1)-(6) get libuv building posix-poll.c on Tiger at all, but
  // Apple's poll(2) is ITSELF documented broken from Mac OS X 10.3 through
  // 10.8 (fixed in 10.9, broken again in 10.12) — see
  // https://daniel.haxx.se/blog/2016/10/11/poll-on-mac-10-12-is-broken/,
  // which is why curl's configure probes for exactly this and falls back to
  // select(2). Tiger (10.4, our floor) sits inside that broken range: under
  // the fused runtime's real fd load (~31 fds — tool pipes, the TLS socket,
  // threadpool wakeups, the signal self-pipe), 28 timers were scheduled and
  // only 13 ever fired, with the process parked in poll() — no sockets in
  // flight, every threadpool worker idle, nothing pending. Sending SIGINT (a
  // signal the app handles, so it causes EINTR) released the loop and it made
  // progress; the very same engine fires timers millisecond-exact when
  // nothing else is registered. This is Apple's poll(2) losing wakeups under
  // load, not a libuv or clode bug, and select(2) is unimpaired across that
  // whole range — hence this edit, gated the same as (1)-(6).
  //
  // uv__clode_poll_select preserves poll()'s exact return contract (>0 =
  // number of pollfd entries with revents set, 0 = timed out, -1/errno on
  // error) so uv__io_poll's surrounding retry loop (its EINTR/abort() handling
  // right below the call this replaces) needs no other change. See the
  // function's own doc comment (written into posix-poll.c) for the EBADF and
  // FD_SETSIZE edge cases.
  const pollC = fs.readFileSync(pollCF, 'utf8');
  const pollIncludesOld = '#include <errno.h>\n#include <unistd.h>\n';
  const pollIncludesNew = pollIncludesOld
    + '\n#if defined(CLODE_DARWIN_POLL)\n'
    + '/* select(2) needs <sys/select.h> (fd_set/FD_SET/FD_ISSET/select) and\n'
    + '   <fcntl.h> (fcntl/F_GETFD, used only for the EBADF -> POLLNVAL\n'
    + '   translation in uv__clode_poll_select below); neither is pulled in by\n'
    + '   the includes above. */\n'
    + '# include <sys/select.h>\n'
    + '# include <fcntl.h>\n'
    + '#endif\n';
  const ioPollFnAnchor = 'void uv__io_poll(uv_loop_t* loop, int timeout) {\n';
  const pollCallOld = '    nfds = poll(loop->poll_fds, (nfds_t)loop->poll_fds_used, timeout);\n';
  const pollCallNew = '#if defined(CLODE_DARWIN_POLL)\n'
    + '    nfds = uv__clode_poll_select(loop->poll_fds, (nfds_t)loop->poll_fds_used, timeout);\n'
    + '#else\n'
    + '    nfds = poll(loop->poll_fds, (nfds_t)loop->poll_fds_used, timeout);\n'
    + '#endif\n';
  if (!pollC.includes(pollIncludesOld) || !pollC.includes(ioPollFnAnchor) || !pollC.includes(pollCallOld)) {
    throw new Error('fixup libuv-poll-backend-old-darwin: posix-poll.c anchor not found (libuv changed under the pin — re-derive the fixup)');
  }
  const pollSelectHelper = '#if defined(CLODE_DARWIN_POLL)\n'
    + '/* Apple\'s poll(2) is documented broken on Mac OS X 10.3 through 10.8\n'
    + ' * (fixed in 10.9, broken again in 10.12) -- see\n'
    + ' * https://daniel.haxx.se/blog/2016/10/11/poll-on-mac-10-12-is-broken/,\n'
    + ' * which is why curl\'s configure probes for exactly this and falls back\n'
    + ' * to select(2). Tiger (10.4, our floor) sits inside that broken range:\n'
    + ' * under the fused runtime\'s real fd load (~31 fds), 28 timers were\n'
    + ' * scheduled and only 13 ever fired, with the process parked in poll() --\n'
    + ' * no sockets in flight, every threadpool worker idle, nothing pending.\n'
    + ' * Sending SIGINT (a signal the app handles, so it causes EINTR) released\n'
    + ' * the loop and it made progress; the very same engine fires timers\n'
    + ' * millisecond-exact when nothing else is registered. This wraps select(2)\n'
    + ' * -- unimpaired across that whole range -- behind poll()\'s exact return\n'
    + ' * contract (>0 = number of pollfd entries with revents set, 0 = timed\n'
    + ' * out, -1/errno on error) so uv__io_poll below needs no other change.\n'
    + ' *\n'
    + ' * LATENT LIMITATION: omitting exceptfds (see the comment further down)\n'
    + ' * means a watcher requesting UV_PRIORITIZED (POLLPRI, out-of-band TCP\n'
    + ' * data) can never fire under this path -- select(2) has no equivalent\n'
    + ' * signal. Nothing in txiki requests UV_PRIORITIZED today, so this is\n'
    + ' * dormant, not a live bug; a future caller that adds it would need a\n'
    + ' * real fix here, not just a comment update.\n'
    + ' *\n'
    + ' * Two real poll(2) calls remain elsewhere in this CLODE_DARWIN_POLL\n'
    + ' * build even though uv__io_poll\'s wait now goes through select(2): the\n'
    + ' * FD_SETSIZE bailout a few lines down (falls back to poll() rather than\n'
    + ' * corrupting an fd_set it cannot represent) and uv__io_check_fd() below,\n'
    + ' * a single fd / 0-timeout probe outside the hot wait path that poll()\n'
    + ' * handles correctly regardless of the 10.3-10.8 breakage (that bug is in\n'
    + ' * poll()\'s WAIT behavior under concurrent load, not its per-call return\n'
    + ' * value on an isolated, non-blocking check).\n'
    + ' */\n'
    + 'static int uv__clode_poll_select(struct pollfd* fds, nfds_t nfds, int timeout) {\n'
    + '  fd_set readfds;\n'
    + '  fd_set writefds;\n'
    + '  struct timeval tv;\n'
    + '  struct timeval* tvp;\n'
    + '  nfds_t i;\n'
    + '  int fd;\n'
    + '  int maxfd;\n'
    + '  int rv;\n'
    + '  int bad;\n'
    + '  int count;\n'
    + '\n'
    + '  FD_ZERO(&readfds);\n'
    + '  FD_ZERO(&writefds);\n'
    + '  maxfd = -1;\n'
    + '\n'
    + '  for (i = 0; i < nfds; i++) {\n'
    + '    fds[i].revents = 0;\n'
    + '\n'
    + '    fd = fds[i].fd;\n'
    + '    if (fd < 0)\n'
    + '      continue;\n'
    + '\n'
    + '    /* select()\'s fd_set is a fixed-size bitmap indexed by fd number; an\n'
    + '     * fd >= FD_SETSIZE cannot be represented (FD_SET on it is undefined\n'
    + '     * behavior -- classically an out-of-bounds write on the bitmap). Our\n'
    + '     * loops run ~31 fds under the fused runtime\'s load (the measured\n'
    + '     * symptom this helper exists to fix), so this branch is unreachable\n'
    + '     * in practice; fall back to the real poll() for this one call rather\n'
    + '     * than corrupting memory or silently dropping the fd.\n'
    + '     */\n'
    + '    if (fd >= FD_SETSIZE)\n'
    + '      return poll(fds, nfds, timeout);\n'
    + '\n'
    + '    if (fds[i].events & POLLIN)\n'
    + '      FD_SET(fd, &readfds);\n'
    + '    if (fds[i].events & POLLOUT)\n'
    + '      FD_SET(fd, &writefds);\n'
    + '    if (fd > maxfd)\n'
    + '      maxfd = fd;\n'
    + '  }\n'
    + '\n'
    + '  if (timeout < 0) {\n'
    + '    tvp = NULL;\n'
    + '  } else {\n'
    + '    tv.tv_sec = timeout / 1000;\n'
    + '    tv.tv_usec = (timeout % 1000) * 1000;\n'
    + '    tvp = &tv;\n'
    + '  }\n'
    + '\n'
    + '  /* No exceptfds: select()\'s "exceptional condition" on a socket means\n'
    + '   * out-of-band (urgent) data has arrived, not an error -- mapping it to\n'
    + '   * POLLERR would make libuv treat ordinary OOB data as a connection\n'
    + '   * failure. A real socket error already surfaces as readable or\n'
    + '   * writable (the next recv()/send() returns it), so omitting exceptfds\n'
    + '   * loses nothing poll() would have reported here.\n'
    + '   */\n'
    + '  rv = select(maxfd + 1, &readfds, &writefds, NULL, tvp);\n'
    + '\n'
    + '  if (rv == -1) {\n'
    + '    /* Do not retry EINTR here: uv__io_poll\'s caller (below) explicitly\n'
    + '     * checks for EINTR -- our own SIGCHLD/wakeup self-pipe writes rely\n'
    + '     * on it to make progress -- and loops itself. Retrying inside this\n'
    + '     * helper would swallow that signal-driven wakeup.\n'
    + '     */\n'
    + '    if (errno == EINTR)\n'
    + '      return -1;\n'
    + '\n'
    + '    /* poll() reports a closed/invalid fd as POLLNVAL on that ONE entry\n'
    + '     * and still returns a normal count; select() instead fails the\n'
    + '     * WHOLE call with EBADF. uv__io_poll\'s caller abort()s on any -1\n'
    + '     * that is not EINTR, so translate: probe every fd with\n'
    + '     * fcntl(F_GETFD) and mark the bad ones POLLNVAL, matching poll()\'s\n'
    + '     * per-fd contract. Only report EBADF (poll() essentially never\n'
    + '     * does) if none actually turn out bad.\n'
    + '     */\n'
    + '    if (errno == EBADF) {\n'
    + '      bad = 0;\n'
    + '      for (i = 0; i < nfds; i++) {\n'
    + '        fd = fds[i].fd;\n'
    + '        if (fd < 0)\n'
    + '          continue;\n'
    + '        if (fcntl(fd, F_GETFD) == -1 && errno == EBADF) {\n'
    + '          fds[i].revents = POLLNVAL;\n'
    + '          bad++;\n'
    + '        }\n'
    + '      }\n'
    + '      if (bad > 0) {\n'
    + '        errno = 0;\n'
    + '        return bad;\n'
    + '      }\n'
    + '      errno = EBADF;\n'
    + '      return -1;\n'
    + '    }\n'
    + '\n'
    + '    return -1;\n'
    + '  }\n'
    + '\n'
    + '  if (rv == 0)\n'
    + '    return 0;\n'
    + '\n'
    + '  /* Translate the two fd_sets select() filled back into per-fd revents,\n'
    + '   * matching what poll() would have set. */\n'
    + '  count = 0;\n'
    + '  for (i = 0; i < nfds; i++) {\n'
    + '    fd = fds[i].fd;\n'
    + '    if (fd < 0)\n'
    + '      continue;\n'
    + '    if (FD_ISSET(fd, &readfds))\n'
    + '      fds[i].revents |= POLLIN;\n'
    + '    if (FD_ISSET(fd, &writefds))\n'
    + '      fds[i].revents |= POLLOUT;\n'
    + '    if (fds[i].revents != 0)\n'
    + '      count++;\n'
    + '  }\n'
    + '  return count;\n'
    + '}\n'
    + '#endif\n'
    + '\n';
  fs.writeFileSync(pollCF, pollC
    .replace(pollIncludesOld, pollIncludesNew)
    .replace(ioPollFnAnchor, pollSelectHelper + ioPollFnAnchor)
    .replace(pollCallOld, pollCallNew));

  console.log('fixup libuv-poll-backend-old-darwin: applied');
}

function fixupTjsHandleDump(dir) {
  // Diagnostic primitive: __tjs_dump_handles() returns a text list of every
  // live libuv handle (type, fd, active/ref/closing) via uv_walk. For
  // event-loop-idle hangs (main thread parked in kevent) it answers "which fd
  // is the loop waiting on" — the question external tools (sample/lsof) can't.
  // Injected into vm.c: bootstrap_core lives here and TJS_GetRuntime/TJS_GetLoop
  // + uv.h are already in scope, so no CMakeLists/private.h changes. Zero cost
  // unless called. libuv upstream candidate for a general handle-introspection.
  const marker = 'CLODE handle-dump';
  const f = path.join(dir, 'src/vm.c');
  const src = fs.readFileSync(f, 'utf8');
  if (src.includes(marker)) {
    console.log('fixup tjs-handle-dump: already applied');
    return;
  }
  const fnAnchor = 'static void tjs__bootstrap_core(JSContext *ctx, JSValue ns) {';
  const regAnchor = '    tjs__mod_spawn_sync_init(ctx, ns);\n';
  if (!src.includes(fnAnchor) || !src.includes(regAnchor)) {
    throw new Error('fixup tjs-handle-dump: anchor not found (txiki vm.c changed under the pin — re-derive)');
  }
  const cfns =
    '/* ' + marker + ': uv_walk-based live-handle listing for hang diagnosis. */\n' +
    'typedef struct { char *p; int off; int cap; } tjs__clode_hd;\n' +
    'static void tjs__clode_handle_walk_cb(uv_handle_t *h, void *arg) {\n' +
    '    tjs__clode_hd *d = (tjs__clode_hd *)arg;\n' +
    '    if (d->off >= d->cap - 160) return;\n' +
    '    uv_os_fd_t osfd; int fd = -1;\n' +
    '    if (uv_fileno(h, &osfd) == 0) fd = (int)(intptr_t)osfd;\n' +
    '    int n = snprintf(d->p + d->off, (size_t)(d->cap - d->off),\n' +
    '        "%s fd=%d active=%d ref=%d closing=%d\\n",\n' +
    '        uv_handle_type_name(h->type), fd,\n' +
    '        uv_is_active(h) ? 1 : 0, uv_has_ref(h) ? 1 : 0, uv_is_closing(h) ? 1 : 0);\n' +
    '    if (n > 0) d->off += n;\n' +
    '}\n' +
    'static JSValue tjs__clode_dump_handles(JSContext *ctx, JSValueConst this_val,\n' +
    '                                       int argc, JSValueConst *argv) {\n' +
    '    (void)this_val; (void)argc; (void)argv;\n' +
    '    uv_loop_t *loop = TJS_GetLoop(TJS_GetRuntime(ctx));\n' +
    '    char buf[8192]; buf[0] = 0;\n' +
    '    tjs__clode_hd d = { buf, 0, (int)sizeof(buf) };\n' +
    '    uv_walk(loop, tjs__clode_handle_walk_cb, &d);\n' +
    '    return JS_NewString(ctx, buf);\n' +
    '}\n';
  const regBlock =
    regAnchor +
    '    { /* ' + marker + ' */\n' +
    '        JSValue global = JS_GetGlobalObject(ctx);\n' +
    '        JS_DefinePropertyValueStr(ctx, global, "__tjs_dump_handles",\n' +
    '            JS_NewCFunction(ctx, tjs__clode_dump_handles, "__tjs_dump_handles", 0), JS_PROP_C_W_E);\n' +
    '        JS_FreeValue(ctx, global);\n' +
    '    }\n';
  const out = src
    .replace(fnAnchor, cfns + '\n' + fnAnchor)
    .replace(regAnchor, regBlock);
  fs.writeFileSync(f, out);
  console.log('fixup tjs-handle-dump: applied');
}

function fixupHttpclientAsyncDns(dir) {
  // Route every fetch's DNS through uv_getaddrinfo (libuv threadpool — async,
  // non-blocking, kqueue-free on every platform) instead of letting lws resolve
  // the hostname itself. lws's built-in async DNS reads /etc/resolv.conf, lacks
  // robust failover, and on Darwin its response path depends on kqueue
  // readability that is unreliable on old macOS (Tiger) — it parks the event
  // loop forever on a stale/dead nameserver (proven: Tiger login token-exchange
  // hangs, 2 UDP sockets, main thread idle in kevent). We resolve to an IP with
  // uv_getaddrinfo, then hand lws the IP (lws does no DNS). Reuses the patterns
  // already in-tree: lws-utils.c (IP -> cci.address) and mod_dns.c (async cb).
  // ws.c has the same lws-DNS pattern; left as a follow-up (not the login path),
  // so LWS_WITH_SYS_ASYNC_DNS stays enabled for it. Runs AFTER the txiki patches
  // (anchors on the post-no-origin-header connect fn). libuv/lws candidate.
  const marker = 'Async DNS: resolve uri->host via uv_getaddrinfo';
  const f = path.join(dir, 'src/httpclient.c');
  const src = fs.readFileSync(f, 'utf8');
  if (src.includes(marker)) {
    console.log('fixup httpclient-async-dns: already applied');
    return;
  }
  const anchor = `/* Parse URL and initiate an lws client connection.  Returns 0 on success. */
static int tjs_httpclient_connect(TJSHttpClient *h) {
    JSContext *ctx = h->ctx;

    lws_parse_uri_t *uri = lws_parse_uri_create(h->url_str);
    if (!uri) {
        return -1;
    }

    bool use_ssl = !strcmp(uri->scheme, "https");

    char full_path[TJS_PATH_MAX];
    snprintf(full_path, sizeof(full_path), "/%s", uri->path);

    struct lws_context *lws_ctx = tjs__lws_get_context(ctx);
    if (!lws_ctx) {
        lws_parse_uri_destroy(&uri);
        return -1;
    }

    struct lws_client_connect_info cci;
    memset(&cci, 0, sizeof(cci));

    cci.context = lws_ctx;
    cci.address = uri->host;
    cci.port = uri->port;
    cci.path = full_path;
    cci.host = uri->host;
    /* Do NOT set cci.origin for the generic HTTP client: libwebsockets turns it
     * into a real \`Origin:\` request header on EVERY fetch(), which is a
     * browser/CORS concept that has no place on a server-side HTTP request and
     * makes CORS-guarded APIs reject the call (e.g. api.anthropic.com -> 401
     * "CORS requests are not allowed for this Organization"). host node / other
     * server HTTP clients send no Origin. Leaving it NULL (already zeroed by the
     * memset above) suppresses the header. (WebSocket handshakes, which legitimately
     * use Origin, go through a different path and are unaffected.) */
    cci.origin = NULL;
    cci.ssl_connection = (use_ssl ? LCCSCF_USE_SSL : 0) | h->ssl_flags | LCCSCF_HTTP_NO_FOLLOW_REDIRECT;
    cci.method = h->method;
    cci.local_protocol_name = TJS_LWS_HTTP_PROTOCOL_NAME;
    cci.userdata = h;
    cci.pwsi = &h->wsi;
    cci.vhost = tjs__lws_select_vhost(ctx, uri->scheme, uri->host, uri->port);

    tjs__lws_conn_ref(ctx);

    struct lws *wsi = lws_client_connect_via_info(&cci);

    lws_parse_uri_destroy(&uri);

    if (!wsi) {
        tjs__lws_conn_unref(ctx);
        h->wsi = NULL;
        return -1;
    }

    lws_cancel_service(lws_ctx);

    if (h->timeout > 0) {
        lws_set_timer_usecs(wsi, (lws_usec_t) h->timeout * LWS_USEC_PER_SEC / 1000);
    }

    return 0;
}`;
  if (!src.includes(anchor)) {
    throw new Error('fixup httpclient-async-dns: anchor not found (txiki httpclient.c changed under the pin — re-derive)');
  }
  const replacement = `/* ${marker} (libuv threadpool — non-
 * blocking and kqueue-free on every platform), then connect lws to the resolved
 * IP.  We do NOT let lws resolve the hostname itself: its built-in async DNS
 * reads /etc/resolv.conf directly, lacks robust failover, and on Darwin its
 * response path depends on kqueue readability that is unreliable on old macOS
 * (Tiger) — it parks the event loop forever on a stale/dead nameserver.
 * Routing every fetch through the OS resolver via uv_getaddrinfo fixes this
 * uniformly.  Mirrors the proven patterns already in-tree: lws-utils.c (IP ->
 * cci.address, keep the name in cci.host for the Host header + SNI) and
 * mod_dns.c (the async uv_getaddrinfo callback form). */
typedef struct {
    uv_getaddrinfo_t req;
    TJSHttpClient *h;
    lws_parse_uri_t *uri; /* kept alive until the resolve callback runs */
    char full_path[TJS_PATH_MAX];
    bool use_ssl;
} TJSHttpConnectReq;

/* Deliver a pre-connection failure to JS.  Used when we fail before lws ever
 * produces a wsi (DNS error, or lws_client_connect_via_info() returns NULL), so
 * no lws callback will fire — this mirrors the CLIENT_CONNECTION_ERROR teardown.
 * Balances the tjs__lws_conn_ref() taken before the async resolve. */
static void tjs_httpclient_conn_fail(TJSHttpClient *h, const char *msg) {
    tjs__lws_conn_unref(h->ctx);
    h->wsi = NULL;

    if (!h->completed) {
        h->completed = true;
        JSValue args[2];
        args[0] = JS_NewString(h->ctx, "CONNECTION_ERROR");
        args[1] = JS_NewString(h->ctx, msg ? msg : "Connection error");
        maybe_invoke_callback(h, HC_CALLBACK_COMPLETE, 2, args);
    }

    /* Drop the prevent-GC self-reference; the finalizer frees the client. */
    if (!JS_IsUndefined(h->this_val)) {
        JSValue val = h->this_val;
        h->this_val = JS_UNDEFINED;
        JS_FreeValue(h->ctx, val);
    }
}

static void tjs_httpclient_resolve_cb(uv_getaddrinfo_t *req, int status, struct addrinfo *res) {
    TJSHttpConnectReq *cr = req->data;
    TJSHttpClient *h = cr->h;
    JSContext *ctx = h->ctx; /* the runtime context, valid independent of h */

    if (status != 0) {
        tjs_httpclient_conn_fail(h, uv_strerror(status));
        lws_parse_uri_destroy(&cr->uri);
        js_free(ctx, cr);
        return;
    }

    struct lws_context *lws_ctx = tjs__lws_get_context(ctx);
    if (!lws_ctx) {
        tjs_httpclient_conn_fail(h, "no lws context");
        uv_freeaddrinfo(res);
        lws_parse_uri_destroy(&cr->uri);
        js_free(ctx, cr);
        return;
    }

    /* Try each resolved address in turn. getaddrinfo returns IPv6 first for a
     * dual-stack host, but a v4-only box has no route to it and
     * lws_client_connect_via_info() returns NULL — so fall through to the next
     * address (the IPv4 one) instead of failing the whole fetch. This is the
     * resolver-order fallback every DNS client does; AI_ADDRCONFIG is not enough
     * (NetBSD counts loopback/link-local IPv6 as "configured" and returns AAAA). */
    struct lws *wsi = NULL;
    for (struct addrinfo *ai = res; ai && !wsi; ai = ai->ai_next) {
        char ip_str[INET6_ADDRSTRLEN];
        if (ai->ai_family == AF_INET6) {
            uv_inet_ntop(AF_INET6, &((struct sockaddr_in6 *) ai->ai_addr)->sin6_addr, ip_str, sizeof(ip_str));
        } else if (ai->ai_family == AF_INET) {
            uv_inet_ntop(AF_INET, &((struct sockaddr_in *) ai->ai_addr)->sin_addr, ip_str, sizeof(ip_str));
        } else {
            continue;
        }

        struct lws_client_connect_info cci;
        memset(&cci, 0, sizeof(cci));
        cci.context = lws_ctx;
        cci.address = ip_str;      /* resolved IP — lws does no DNS.  lws copies the
                                    * connect strings into the wsi, so a stack
                                    * ip_str is safe. */
        cci.port = cr->uri->port;
        cci.path = cr->full_path;
        cci.host = cr->uri->host;  /* Host header + SNI keep the hostname */
        /* Do NOT set cci.origin for the generic HTTP client: libwebsockets turns it
         * into a real \`Origin:\` request header on EVERY fetch(), which is a
         * browser/CORS concept that has no place on a server-side HTTP request and
         * makes CORS-guarded APIs reject the call (e.g. api.anthropic.com -> 401
         * "CORS requests are not allowed for this Organization"). host node / other
         * server HTTP clients send no Origin. Leaving it NULL (already zeroed by the
         * memset above) suppresses the header. (WebSocket handshakes, which legitimately
         * use Origin, go through a different path and are unaffected.) */
        cci.origin = NULL;
        cci.ssl_connection = (cr->use_ssl ? LCCSCF_USE_SSL : 0) | h->ssl_flags | LCCSCF_HTTP_NO_FOLLOW_REDIRECT;
        cci.method = h->method;
        cci.local_protocol_name = TJS_LWS_HTTP_PROTOCOL_NAME;
        cci.userdata = h;
        cci.pwsi = &h->wsi;
        cci.vhost = tjs__lws_select_vhost(ctx, cr->uri->scheme, cr->uri->host, cr->uri->port);

        wsi = lws_client_connect_via_info(&cci);
    }
    uv_freeaddrinfo(res);

    if (!wsi) {
        tjs_httpclient_conn_fail(h, "Connection failed");
    } else {
        lws_cancel_service(lws_ctx);
        if (h->timeout > 0) {
            lws_set_timer_usecs(wsi, (lws_usec_t) h->timeout * LWS_USEC_PER_SEC / 1000);
        }
    }

    lws_parse_uri_destroy(&cr->uri);
    js_free(ctx, cr);
}

/* Parse the URL and kick off an async DNS resolve; the callback connects lws.
 * Returns 0 if the resolve was started (the request is now in flight — any
 * failure arrives asynchronously via the completion callback), -1 on an
 * immediate setup failure (the JS caller throws synchronously on -1). */
static int tjs_httpclient_connect(TJSHttpClient *h) {
    JSContext *ctx = h->ctx;

    lws_parse_uri_t *uri = lws_parse_uri_create(h->url_str);
    if (!uri) {
        return -1;
    }

    if (!tjs__lws_get_context(ctx)) {
        lws_parse_uri_destroy(&uri);
        return -1;
    }

    TJSHttpConnectReq *cr = js_malloc(ctx, sizeof(*cr));
    if (!cr) {
        lws_parse_uri_destroy(&uri);
        return -1;
    }
    cr->h = h;
    cr->uri = uri;
    cr->use_ssl = !strcmp(uri->scheme, "https");
    snprintf(cr->full_path, sizeof(cr->full_path), "/%s", uri->path);
    cr->req.data = cr;

    struct addrinfo hints;
    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;

    /* Ref before the async resolve so the shared lws context stays alive across
     * it; tjs_httpclient_conn_fail() unrefs on any pre-connection failure, and
     * the CLOSED/CONNECTION_ERROR callback unrefs once connected. */
    tjs__lws_conn_ref(ctx);

    int r = uv_getaddrinfo(&TJS_GetRuntime(ctx)->loop, &cr->req, tjs_httpclient_resolve_cb, uri->host, NULL, &hints);
    if (r != 0) {
        tjs__lws_conn_unref(ctx);
        lws_parse_uri_destroy(&uri);
        js_free(ctx, cr);
        return -1;
    }

    return 0;
}`;
  fs.writeFileSync(f, src.replace(anchor, replacement));
  console.log('fixup httpclient-async-dns: applied');
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

function fixupQjsX87FpcwI386Darwin(dir) {
  // cutils.h gates x87 FP-precision control on `#if defined(__i386__) &&
  // !defined(_MSC_VER)` — inline asm (fnstcw/fldcw) that the OLDER osxcross-1.1
  // clang rejects ("invalid lvalue in asm output"). osxcross-1.1 is the darwin-x86
  // i386 cross toolchain (master osxcross refuses the 10.4 SDK the Tiger floor
  // needs). The x87 dance only matters when the compiler emits x87 FP — but EVERY
  // Intel Mac has SSE2, and the darwin-x86 toolchain compiles with -mfpmath=sse
  // (64-bit doubles via SSE, no x87), so the control is a no-op there. Exclude
  // __APPLE__ from the guard so Apple i386 takes the SAME empty macros that
  // x64/arm64/ppc already use (the surrounding code never touches the var outside
  // these macros — proven by those platforms compiling it empty today). quickjs-ng
  // upstream candidate.
  const f = path.join(dir, 'deps/quickjs/cutils.h');
  const src = fs.readFileSync(f, 'utf8');
  const anchor = '#if defined(__i386__) && !defined(_MSC_VER)';
  const patched = '#if defined(__i386__) && !defined(_MSC_VER) && !defined(__APPLE__)';
  if (src.includes(patched)) {
    console.log('fixup qjs-x87-fpcw-i386-darwin: already applied');
    return;
  }
  if (!src.includes(anchor) || !src.includes('JS_X87_FPCW_SAVE_AND_ADJUST')) {
    throw new Error('fixup qjs-x87-fpcw-i386-darwin: anchor not found (quickjs-ng changed under the pin — re-derive the fixup)');
  }
  fs.writeFileSync(f, src.replace(anchor, patched));
  console.log('fixup qjs-x87-fpcw-i386-darwin: applied');
}

function fixupQjsX87FpcwLabelStmt(dir) {
  // On real 32-bit x86 (NetBSD/i386 — which keeps the x87 macro, unlike Apple
  // i386 above where it's emptied), JS_X87_FPCW_SAVE_AND_ADJUST expands to a
  // DECLARATION (`unsigned short cw;`, the x87 control-word save). quickjs.c
  // invokes it as the very first thing after the `handle_float64:` label:
  //     handle_float64:
  //         JS_X87_FPCW_SAVE_AND_ADJUST(fpcw);
  // and C before C23 forbids a declaration as the statement a label introduces —
  // "a label can only be part of a statement and a declaration is not a
  // statement" — so netbsd-i386's gcc rejects it (reported at cutils.h in the
  // macro body; run 29654544915). `fpcw` is read again by JS_X87_FPCW_RESTORE a
  // few lines down in the SAME scope, so the macro cannot be wrapped in a block
  // (the var would fall out of scope). Insert a null statement after the label
  // instead. Universally safe: on every non-i386 target the macro is empty, so
  // this is just `handle_float64: ; switch (...)`. quickjs-ng upstream candidate.
  const f = path.join(dir, 'deps/quickjs/quickjs.c');
  const src = fs.readFileSync(f, 'utf8');
  const marker = '/* i386: a label needs a statement; the x87 macro is a declaration */';
  if (src.includes(marker)) {
    console.log('fixup qjs-x87-fpcw-label-stmt: already applied');
    return;
  }
  const anchor = '    handle_float64:\n        JS_X87_FPCW_SAVE_AND_ADJUST(fpcw);';
  const patched = `    handle_float64:\n        ; ${marker}\n        JS_X87_FPCW_SAVE_AND_ADJUST(fpcw);`;
  if (!src.includes(anchor)) {
    throw new Error('fixup qjs-x87-fpcw-label-stmt: anchor not found (quickjs-ng changed under the pin — re-derive the fixup)');
  }
  fs.writeFileSync(f, src.replace(anchor, patched));
  console.log('fixup qjs-x87-fpcw-label-stmt: applied');
}

function fixupLibuvRiscvCpuRelax(dir) {
  // libuv's uv__cpu_relax spin-loop hint hand-encodes the RISC-V PAUSE
  // (Zihintpause) as `.insn 0x0100000f`. The netbsd-10 riscv assembler predates
  // that `.insn <imm>` form and rejects it: "unrecognized opcode '0x0100000f'"
  // (netbsd-riscv64, run 29654544915). Emit the identical four bytes with
  // `.word`, a fundamental GAS directive every assembler accepts — the machine
  // code is byte-for-byte what upstream intended (a CPU that predates Zihintpause
  // decodes 0x0100000f as a plain FENCE, the correct fallback). The hint is a
  // pure spin-loop optimization; correctness never depended on it. This line is
  // inside `#elif defined(__riscv) && __riscv_xlen == 64`, so the edit is inert
  // on every non-riscv build. libuv upstream candidate.
  const f = path.join(dir, 'deps/libuv/src/unix/async.c');
  const src = fs.readFileSync(f, 'utf8');
  const anchor = '__asm__ volatile(".insn 0x0100000f" ::: "memory");';
  const patched = '__asm__ volatile(".word 0x0100000f" ::: "memory");';
  if (src.includes(patched)) {
    console.log('fixup libuv-riscv-cpu-relax: already applied');
    return;
  }
  if (!src.includes(anchor)) {
    throw new Error('fixup libuv-riscv-cpu-relax: anchor not found (libuv changed under the pin — re-derive the fixup)');
  }
  fs.writeFileSync(f, src.replace(anchor, patched));
  console.log('fixup libuv-riscv-cpu-relax: applied');
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
  // Attach the shim to the EXECUTABLE (tjs-cli), not the `tjs` static library
  // (libtjs_core.a). The shim resolves __atomic_*_8 refs that live in a
  // DIFFERENT archive (libqjs.a / quickjs). GNU ld resolves archives in a
  // single left-to-right pass, so a shim buried in libtjs_core.a does NOT
  // back-fill libqjs.a's later refs (netbsd-m68k link wall, run 29359104009);
  // as a direct object of tjs-cli its symbols are unconditionally present and
  // resolve every archive regardless of order (darwin-ppc's Mach-O ld already
  // tolerated the library form — a direct object works for it too). Appended at
  // end-of-file so both targets are defined when target_sources runs.
  const anchor = 'add_executable(tjs-cli';
  if (!src.includes(anchor)) {
    throw new Error('fixup atomic-shim: tjs-cli target not found (CMakeLists.txt changed under the pin — re-derive)');
  }
  const inject = '\noption(CLODE_ATOMIC_SHIM "Link a pthread __atomic_*_8 shim (32-bit targets lacking libatomic)" OFF)\n'
    + 'if(CLODE_ATOMIC_SHIM)\n    target_sources(tjs-cli PRIVATE src/tjs-atomic-shim.c)\nendif()\n';
  fs.writeFileSync(f, src + inject);
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
  fixupLibuvHaikuStdioPipe(tjsDir);
  fixupTjsCmakeCxxOnlyForAda(tjsDir);
  fixupLibuvHrtimeOldDarwin(tjsDir);
  fixupLibuvStrnlenOldDarwin(tjsDir);
  fixupLibuvClockGettimeOldDarwin(tjsDir);
  fixupLibuvFsTimesOldDarwin(tjsDir);
  fixupLibuvSpawnCloexecOldDarwin(tjsDir);
  fixupLibuvUdpSsmOldDarwin(tjsDir);
  fixupLibuvMsgXOldDarwin(tjsDir);
  fixupLibuvKqueueExceptOldDarwin(tjsDir);
  fixupLibuvTtyKqueueOldDarwin(tjsDir);
  fixupLibuvPollBackendOldDarwin(tjsDir);
  fixupTjsHandleDump(tjsDir);
  fixupHttpclientAsyncDns(tjsDir);
  fixupLwsScandirOldDarwin(tjsDir);
  fixupMbedtlsMsTimeOldDarwin(tjsDir);
  fixupQjsHrtimeOldDarwin(tjsDir);
  fixupQjsX87FpcwI386Darwin(tjsDir);
  fixupQjsX87FpcwLabelStmt(tjsDir);     // netbsd-i386: label + declaration
  fixupLibuvRiscvCpuRelax(tjsDir);      // netbsd-riscv64: .insn -> .word
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
  // cosmo patches apply LAST: they were generated against the fully-fixed-up
  // tree (their libuv udp.c context includes the SSM guard fixupLibuvUdpSsmOld-
  // Darwin adds), so they must go on top of every source fixup, not before them.
  if (cosmoTarget) applyCosmoPatches(tjsDir);
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
// cosmo: provision cosmocc and point the build at the cosmo cross toolchain +
// the rest of the lean profile. Done HERE (before crossFile is read below) so
// the toolchain file and CLODE_COSMOCC are in the environment cmake sees. The
// extra OFFs match the verified recipe (cosmo-fidelity-run.md §1.4): SQLITE/LTO
// and the CLI's mimalloc are dropped so nothing pulls a dep cosmocc can't build.
if (cosmoTarget) {
  const cosmoccBin = await provisionCosmocc();
  process.env.CLODE_COSMOCC = cosmoccBin;
  // cosmocc's cosmoar/cosmoranlib wrappers `exec` their per-arch backends
  // (x86_64-linux-cosmo-ranlib, ...) by BARE name — those live in the cosmocc
  // bin dir, so it MUST be on PATH when cmake drives the archive/index step or
  // the static libs get no symbol index and the tjs-cli link fails undefined.
  if (!(process.env.PATH || '').split(path.delimiter).includes(cosmoccBin)) {
    process.env.PATH = `${cosmoccBin}${path.delimiter}${process.env.PATH || ''}`;
  }
  if (!process.env.CLODE_TJS_CROSS_FILE) {
    process.env.CLODE_TJS_CROSS_FILE = path.join(repo, 'scripts/cosmo.toolchain.cmake');
  }
  cmakeArgs.push('-DBUILD_WITH_SQLITE=OFF', '-DBUILD_WITH_LTO=OFF',
    '-DLWS_WITH_SQLITE3=OFF', '-DQJS_BUILD_CLI_WITH_MIMALLOC=OFF');
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
// Native Windows compiler selection. MSVC cl.exe is the canonical compiler — the
// shipping windows-amd64 / windows-arm64 publisher legs build with it (scripts/
// tjs-legs.mjs msvc:true; the VS dev env is activated in build-leg so cl + the
// Windows SDK + ninja are on PATH) — so on a native win32 build it is the DEFAULT
// and needs NO env flag. mingw is retired, kept only as an explicit opt-in:
// CLODE_TJS_WIN_MINGW=1 selects the hosted gcc-posix toolchain instead. Both force
// Ninja because cmake's default Windows generator is multi-config Visual Studio,
// which puts the binary outside build/tjs/'s expected layout. A cross toolchain
// file (crossFile) owns compiler selection and excludes both. cl needs no
// -Wno-error demotion (txiki applies -Werror only on its Unix path); mingw gcc does
// (handled by the !winMsvc branch at :~1870).
const winMingw = process.env.CLODE_TJS_WIN_MINGW === '1';
if (winMingw && crossFile) {
  throw new Error('CLODE_TJS_WIN_MINGW and CLODE_TJS_CROSS_FILE are mutually exclusive (native-hosted vs cross)');
}
// CLODE_TJS_WIN_MSVC=1 is still accepted (now redundant on win32) for back-compat;
// still loud if it conflicts with an explicit mingw/cross request.
if (process.env.CLODE_TJS_WIN_MSVC === '1' && (crossFile || winMingw)) {
  throw new Error('CLODE_TJS_WIN_MSVC is exclusive with CLODE_TJS_WIN_MINGW / CLODE_TJS_CROSS_FILE');
}
const winMsvc = !winMingw && !crossFile
  && (process.platform === 'win32' || process.env.CLODE_TJS_WIN_MSVC === '1');
if (winMingw) {
  cmakeArgs.push('-G', 'Ninja', '-DCMAKE_C_COMPILER=gcc', '-DCMAKE_CXX_COMPILER=g++');
} else if (winMsvc) {
  cmakeArgs.push('-G', 'Ninja', '-DCMAKE_C_COMPILER=cl', '-DCMAKE_CXX_COMPILER=cl');
}
// 32-bit targets lacking libatomic (ppc/sparc): link the __atomic_*_8 shim.
if (process.env.CLODE_TJS_ATOMIC_SHIM === '1') {
  cmakeArgs.push('-DCLODE_ATOMIC_SHIM=ON');
}
// The old-Darwin poll(2) backend (see the guard at the top + the fixup). OFF by
// default: kqueue stays the backend for every 10.6+/modern darwin leg.
if (darwinPoll) {
  cmakeArgs.push('-DCLODE_DARWIN_POLL=ON');
}
// Build hermeticity: keep cmake's find_*() out of third-party package-manager
// prefixes. Root cause (verified twice on this dev Mac, 2026-07-31): its cmake
// is pkgsrc's (/opt/pkg/bin/cmake), and a pkgsrc-built cmake bakes ITS OWN
// prefix into CMAKE_SYSTEM_PREFIX_PATH ahead of /usr and the SDK:
//   /opt/homebrew;/opt/pkg;/usr/local;/usr;/;...;<SDK>/usr;/sw;/opt/local
// txiki's CMakeLists.txt does an UNPINNED find_library/find_path for libffi
// (BUILD_WITH_FFI is on by default), so both resolved into pkgsrc. Two
// failures came from that, both observed:
//   (a) the built engine dynamically linked /opt/pkg/lib/libffi.8.dylib
//       (`otool -L build/tjs/macos-26-arm64/tjs`) — an engine that cannot run
//       on any machine without pkgsrc installed at that exact path;
//   (b) -I/opt/pkg/include landed SECOND in the tjs target's include path,
//       ahead of every vendored path, so txiki's OWN sources compiled
//       against pkgsrc's uv.h instead of the vendored deps/libuv one. Two
//       different uv_loop_t layouts linked into one binary, and it SIGABRTed
//       before its first line of JS.
// CMAKE_IGNORE_PREFIX_PATH (cmake >= 3.23) strips these roots from EVERY
// find_*() call project-wide — the general fix (the next unpinned
// find_library() txiki adds is covered too), not a per-package workaround.
// NATIVE builds only: a cross toolchain file (CLODE_TJS_CROSS_FILE) already
// sets CMAKE_FIND_ROOT_PATH_MODE_* to ONLY and owns target config end-to-end
// (darwin-ppc, cosmo, ...) — stacking a host-side ignore-list on top would
// fight the toolchain file, not help it, and the cross legs cross-provision
// their own deps rather than reaching into a host package manager anyway.
//
// PKG_MANAGER_ROOTS is the ONE shared list for both halves of this
// protection — the cmake ignore-prefix-path push right below AND the
// post-build dependency-check denylist further down (checkHermeticDeps).
// These two used to be separate arrays (PKG_MANAGER_PREFIXES vs
// PKG_MANAGER_ROOTS) and drifted: PKG_MANAGER_PREFIXES omitted /usr/pkg,
// so on a NATIVE NetBSD build (netbsd-amd64, publish:true — NetBSD's own
// cmake platform module puts /usr/pkg in CMAKE_SYSTEM_PREFIX_PATH) cmake
// was free to link /usr/pkg/lib/libffi.so with nothing stopping it, and
// the build died on its LAST step with a message asserting
// CMAKE_IGNORE_PREFIX_PATH "should have kept cmake's find_*() from ever
// resolving into this prefix" — which was a lie for /usr/pkg specifically,
// since it was never in the ignore list to begin with. One array, used in
// both places, makes that drift structurally impossible.
//
// /usr/pkg is safe to add here: CMAKE_IGNORE_PREFIX_PATH only affects
// find_library/find_path/find_package-style searches, NOT find_program
// (which walks $PATH, unaffected by this variable) — so ignoring /usr/pkg
// as a find_*() PREFIX cannot break discovery of /usr/pkg/bin/{cmake,gmake,
// ninja,node} on NetBSD. Confirmed empirically against cmake 4.3.3 and by
// this repo's own post-fix CMakeCache.txt (task-10-report.md), which shows
// CMAKE_MAKE_PROGRAM=/opt/pkg/bin/gmake resolved via PATH search
// coexisting fine with CMAKE_IGNORE_PREFIX_PATH=/opt/pkg. Do not remove
// /usr/pkg from this list "to be safe" — that reintroduces the exact gap
// this comment documents.
const PKG_MANAGER_ROOTS = ['/opt/pkg', '/opt/homebrew', '/usr/local', '/opt/local', '/sw', '/usr/pkg'];
// CMAKE_IGNORE_PREFIX_PATH shipped in cmake 3.23. Extracted into a named
// function (not inlined into the `if` below) so the test suite can pull the
// EXACT comparison through the same brace-balanced extractFunction()
// machinery it already uses for parseOtoolDeps/parseLddDeps, rather than
// hand-copying the arithmetic — a hand copy tracks nothing: inverting `>=`
// to `<` here would leave a hand-copied test green.
function cmakeVersionSupportsIgnorePrefixPath(major, minor) {
  return major > 3 || (major === 3 && minor >= 23);
}
if (!crossFile) {
  const cmakeVerOut = runOut('cmake', ['--version']);
  const cmakeVerMatch = cmakeVerOut.match(/(\d+)\.(\d+)\.(\d+)/);
  const [cmMajor, cmMinor] = cmakeVerMatch
    ? [Number(cmakeVerMatch[1]), Number(cmakeVerMatch[2])] : [0, 0];
  if (cmakeVerMatch && cmakeVersionSupportsIgnorePrefixPath(cmMajor, cmMinor)) {
    cmakeArgs.push(`-DCMAKE_IGNORE_PREFIX_PATH=${PKG_MANAGER_ROOTS.join(';')}`);
  } else {
    // Loud, not silent: an old-cmake native leg builds WITHOUT this
    // protection. The post-build hermeticity check (below, after the smoke
    // test) is the backstop that still catches a package-manager dep landing
    // in the shipped binary — it just can't be prevented at configure time here.
    console.error(`build-tjs: cmake ${cmakeVerMatch ? cmakeVerMatch[0] : cmakeVerOut.trim()} predates ` +
      '3.23 — CMAKE_IGNORE_PREFIX_PATH is unavailable, so this configure is NOT protected ' +
      'against package-manager prefixes shadowing vendored deps (see the pkgsrc ' +
      'libffi/uv.h incident above). Relying on the post-build dependency check to fail loud instead.');
  }
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
// Build OUT OF the shared txiki source: `<tjsDir>/build` was nested inside the
// SHARED checkout (spike/quickjs/vendor/txiki.js), so every platform's build tromped
// the same path on a shared NFS tree. It was then moved inside `outDir`, which is
// already TARGET-unique (platformTjsDir=build/tjs/<osToken>-<arch>, or CLODE_TJS_OUT
// per cross target) — no contention even for two targets cross-built from one host.
// It now moves ONE MORE TIME, off of `outDir` (which defaults inside the repo tree —
// possibly NFS, see localScratchRoot() above) onto local scratch, for the same reason
// the vendor checkout did: compiling thousands of small object files over NFS is the
// dominant cost of a from-scratch build. targetToken() reconstructs the SAME
// per-target uniqueness outDir already provided (a stable hash of outDir's own
// resolved path — not a fresh mktemp, so incremental rebuilds of the SAME target still
// hit the same object files/cmake cache) without requiring the intermediates to live
// inside outDir at all. CLODE_TJS_BUILD overrides the local build root explicitly. The
// FINAL exe still gets copied into outDir at the end, unchanged — that path is what
// test/node-shim-helper.cjs's tjsPath() and CI both depend on. Only the one-time
// source PATCH stays a shared mutation (guarded by applyPatches' idempotence); the
// compile has never touched the source tree.
function targetToken(forOutDir) {
  const abs = path.resolve(forOutDir);
  const h = crypto.createHash('sha256').update(abs).digest('hex').slice(0, 12);
  return `${path.basename(abs)}-${h}`;
}
const buildRoot = process.env.CLODE_TJS_BUILD || path.join(localScratchRoot(), 'clode-tjs-build');
const buildDir = path.join(buildRoot, targetToken(outDir), 'build');
fs.mkdirSync(buildDir, { recursive: true });
run('cmake', ['-S', tjsDir, '-B', buildDir, ...cmakeArgs]);

// ---- bytecode regen: pure helpers -----------------------------------------
// Extracted as standalone pure functions (no fs/process access beyond their
// arguments) so test/tjs-bytecode-regen.test.cjs can pull them out of this
// file (the extractFunction pattern test/tjs-build-hermeticity.test.cjs
// already uses) and unit-test the staleness logic without needing a real
// cmake/tjsc build.
//
// The full list of {outC, name, prefix, inJs} pairs tjsc regenerates. A pure
// function of the stdlib directory listing, so a test can drive it with a
// fake list instead of a real checkout.
function bytecodeBundlePairs(stdlibFiles) {
  return [
    { outC: 'src/bundles/c/core/polyfills.c', name: 'tjs:internal/polyfills', prefix: 'tjs__', inJs: 'src/bundles/js/core/polyfills.js' },
    { outC: 'src/bundles/c/core/core.c', name: 'tjs:internal/bootstrap', prefix: 'tjs__', inJs: 'src/bundles/js/core/core.js' },
    { outC: 'src/bundles/c/core/run-main.c', name: 'tjs:internal/run-main', prefix: 'tjs__', inJs: 'src/bundles/js/core/run-main.js' },
    { outC: 'src/bundles/c/core/run-repl.c', name: 'tjs:internal/run-repl', prefix: 'tjs__', inJs: 'src/bundles/js/core/run-repl.js' },
    { outC: 'src/bundles/c/core/worker-bootstrap.c', name: 'tjs:internal/worker-bootstrap', prefix: 'tjs__', inJs: 'src/js/worker/worker-bootstrap.js' },
    { outC: 'src/bundles/c/internal/path.c', name: 'tjs:internal/path', prefix: 'tjs__internal_', inJs: 'src/js/internal/path.js' },
    ...stdlibFiles.map((f) => {
      const n = f.replace(/\.js$/, '');
      return { outC: `src/bundles/c/stdlib/${n}.c`, name: `tjs:${n}`, prefix: 'tjs__', inJs: `src/bundles/js/stdlib/${f}` };
    }),
  ];
}
// sha256 of the exact JS bundle bytes a .c bytecode array should have been
// compiled from, and the C-comment trailer that records it inside the
// generated .c file (invisible to the compiler; appended after tjsc's own
// output). bytecodeIsFresh() reads it back to answer "does this .c still
// match this .js?" without re-running tjsc — the tripwire (below) needs that
// to be cheap, since re-running tjsc needs a full cmake configure+build.
function bundleFingerprint(jsBytes) {
  return crypto.createHash('sha256').update(jsBytes).digest('hex');
}
function fingerprintTrailer(inJs, fp) {
  return `\n/* clode:bytecode-regen src=${inJs} sha256=${fp} */\n`;
}
const FINGERPRINT_RE = /clode:bytecode-regen src=(\S+) sha256=([0-9a-f]{64})/;
function bytecodeIsFresh(cText, jsBytes) {
  const m = cText.match(FINGERPRINT_RE);
  return !!m && m[2] === bundleFingerprint(jsBytes);
}

// ---- host-native tjsc: makes regen correct for CROSS builds too ----------
// tjsc's only dependency is the qjs library (CMakeLists.txt: add_executable
// (tjsc EXCLUDE_FROM_ALL src/qjsc.c); target_link_libraries(tjsc qjs)) — none
// of the network/tls/sqlite/mimalloc/ffi graph a full tjs-cli needs. Building
// it with the HOST's OWN native compiler (never a cross toolchain file)
// always yields a binary this process can exec, whatever target is actually
// being built. Its OUTPUT is valid for every target regardless of host vs.
// target arch: quickjs-ng-canonical-le-bytecode.patch made the serialized
// bytecode format canonically little-endian, and per spike/quickjs/
// bc-le-oracle.mjs (byte-identical serialization across hosts) plus the
// s390x/sparc-BE32/m68k-BE32 legs booting the shipped LE arrays unmodified,
// that canonical form is independent of the writing host's endianness AND
// word size — every multi-byte field is a fixed-width u16/u32/u64 scalar,
// never a raw pointer-sized dump. So ONE host build of tjsc regenerates
// correctly for every target, native or cross, and the old "must regenerate
// at the target's own endianness" requirement — the reason this was ever
// gated behind an opt-in flag — no longer applies. cosmo benefits too: it no
// longer matters that cosmocc itself cannot build tjsc (see the tjs-cli-only
// comment below) — this build never asks it to.
function buildHostTjsc(dir, hostBuildDir) {
  fs.mkdirSync(hostBuildDir, { recursive: true });
  console.log(`bytecode regen: target build is cross — configuring a host-native tjsc at ${hostBuildDir} (its output is valid for every target; canonical-LE)`);
  run('cmake', ['-S', dir, '-B', hostBuildDir, '-DCMAKE_BUILD_TYPE=Release', '-DTJS_USE_ADA=OFF',
    '-DBUILD_WITH_WASM=OFF', '-DBUILD_WITH_MIMALLOC=OFF', '-DBUILD_WITH_FFI=OFF',
    '-DBUILD_WITH_SQLITE=OFF', '-DBUILD_WITH_LTO=OFF',
    // Same -Wno-error demotions the non-Apple native path applies (:~2946) —
    // this is an independent host-native configure, so it needs its own copy
    // rather than inheriting cmakeArgs (which may carry cross-only settings).
    '-DCMAKE_C_FLAGS=-Wno-error=unused-variable -Wno-error=unknown-pragmas -Wno-error=sign-conversion']);
  run('cmake', ['--build', hostBuildDir, '--target', 'tjsc', '-j', jobs]);
  const tjsc = path.join(hostBuildDir, process.platform === 'win32' ? 'tjsc.exe' : 'tjsc');
  // Loud, not silent: if the HOST cannot build its own native tjsc, NO
  // target can be regenerated correctly — a real build failure, not a
  // condition to skip past quietly (a silent skip is the defect this whole
  // mechanism exists to fix).
  if (!fs.existsSync(tjsc)) throw new Error(`bytecode regen: host-native tjsc did not build at ${tjsc} — cannot regenerate bytecode for ANY target without it`);
  return tjsc;
}

// ---- bytecode regen: the DEFAULT, not opt-in (2026-08-06) -----------------
// cmake compiles src/bundles/c/** — quickjs bytecode arrays txiki git-tracks
// pre-compiled from ITS OWN src/js/**. esbuild's src/bundles/js/** (built
// above, from OUR patched src/js/**, endian-neutral text) never reached the
// binary unless tjsc re-ran on it. Behind a CLODE_TJS_REGEN=1 opt-in that no
// caller ever set, that meant NO build — including every shipped release, on
// every target — EVER picked up a src/js/** patch; discovered when a correct
// AbortSignal.timeout unref fix (patches/txiki-timer-unref.patch) built
// clean and changed nothing (test/node-shim-timer-unref.test.cjs). A build
// that silently drops a patch, with no failure signal, is the bug — so
// regeneration is now unconditional. CLODE_TJS_REGEN=0 is the explicit,
// LOUD opt-out for a fast dev loop when src/js/** is provably untouched; it
// must never be set for a release or CI build.
const regenOptOut = process.env.CLODE_TJS_REGEN === '0';
const stdlibFiles = fs.readdirSync(path.join(tjsDir, 'src/js/stdlib')).filter((f) => f.endsWith('.js'));
const bundlePairs = bytecodeBundlePairs(stdlibFiles);
if (regenOptOut) {
  console.error('build-tjs: CLODE_TJS_REGEN=0 — bytecode regen SKIPPED. The shipped src/bundles/c/** ' +
    'will NOT reflect any patch to src/js/** (this is the silent-drop defect, opted into on purpose ' +
    'here). Use only for a fast dev loop when src/js/** is provably untouched — never for a release ' +
    'or CI build.');
} else {
  // A cross build's own buildDir/tjsc would be a TARGET binary this host
  // cannot exec — build tjsc natively instead (buildHostTjsc). A native
  // build's buildDir/tjsc already runs here directly; no second build dir.
  let tjsc;
  if (crossFile) {
    tjsc = buildHostTjsc(tjsDir, path.join(buildRoot, targetToken(outDir), 'build-host-tjsc'));
  } else {
    run('cmake', ['--build', buildDir, '--target', 'tjsc', '-j', jobs]);
    tjsc = path.join(buildDir, 'tjsc');
    if (!fs.existsSync(tjsc)) throw new Error(`bytecode regen: tjsc did not build at ${tjsc}`);
  }
  // Exactly the txiki Makefile's tjsc rules (module mode -m, strip -s, module
  // name -n, C symbol prefix -p). core+stdlib come from the esbuilt bundles;
  // worker-bootstrap + internal/path are tjsc'd straight from src/js sources.
  for (const { outC, name, prefix, inJs } of bundlePairs) {
    const outAbs = path.join(tjsDir, outC);
    const inAbs = path.join(tjsDir, inJs);
    fs.mkdirSync(path.join(tjsDir, path.dirname(outC)), { recursive: true });
    run(tjsc, ['-m', '-s', '-o', outAbs, '-n', name, '-p', prefix, inAbs], { cwd: tjsDir });
    fs.appendFileSync(outAbs, fingerprintTrailer(inJs, bundleFingerprint(fs.readFileSync(inAbs))));
  }
  console.log(`bytecode regen: ${bundlePairs.length} bytecode arrays regenerated from the current (patched) src/js/**`);
}

// ---- bytecode regen: the tripwire (requirement 4) --------------------------
// Right before src/bundles/c/** is compiled into the engine, verify every
// array's fingerprint trailer still matches the JS bundle it claims to come
// from. This should be unreachable right after a successful regen above —
// it exists as defense-in-depth against a future refactor that reintroduces
// the silent-drop this whole mechanism was built to fix. It must never again
// be possible to ship a stale array quietly: if this ever fires, that is a
// real build-system bug, not a target quirk to route around.
if (!regenOptOut) {
  const stale = bundlePairs.filter(({ outC, inJs }) => {
    const cAbs = path.join(tjsDir, outC);
    const jsAbs = path.join(tjsDir, inJs);
    return !bytecodeIsFresh(fs.readFileSync(cAbs, 'utf8'), fs.readFileSync(jsAbs));
  });
  if (stale.length) {
    throw new Error(`bytecode regen: STALE — ${stale.length} array(s) do not match their esbuilt ` +
      `src/bundles/js/** source right after regeneration: ${stale.map((s) => s.outC).join(', ')}`);
  }
}

// cosmo builds ONLY the tjs-cli executable target (OUTPUT_NAME tjs): the default
// (all-targets) build drags in tjsc/qjs tools and demos that cosmocc can't build,
// and cosmo's engine IS the tjs-cli APE, not the `tjs` static lib (libtjs_core.a).
// (Unrelated to bytecode regen above, which never asks cosmocc to build tjsc.)
const buildArgs = ['--build', buildDir, '-j', jobs];
if (cosmoTarget) buildArgs.push('--target', 'tjs-cli');
run('cmake', buildArgs);

fs.mkdirSync(outDir, { recursive: true });
// A Windows (mingw) cross target emits build/tjs.exe; keep the .exe suffix on
// the output too (a Windows loader needs it, and clode reads its own exe by
// name). Every other target emits build/tjs.
const builtExe = fs.existsSync(path.join(buildDir, 'tjs.exe'));
const outName = builtExe ? 'tjs.exe' : 'tjs';
fs.copyFileSync(path.join(buildDir, builtExe ? 'tjs.exe' : 'tjs'), path.join(outDir, outName));
fs.chmodSync(path.join(outDir, outName), 0o755);

// ---- build hermeticity, part 2: verify the shipped binary, don't just hope
// the configure-time flag above worked. Inspect the built engine's dynamic
// deps and fail LOUDLY if any resolves inside a package-manager prefix — the
// regression guard for the pkgsrc libffi/uv.h incident (see the
// CMAKE_IGNORE_PREFIX_PATH comment above) that keeps it from coming back
// silently the next time someone adds an unpinned find_library() upstream,
// or builds on a host whose cmake is too old for the configure-time fix.
//
// DENYLIST, not an allowlist — deliberately. An earlier attempt at this check
// allowlisted system prefixes (['/lib/', '/usr/lib/']) and broke two legs that
// are actually fine:
//   * glibc's ldd prints `/lib64/ld-linux-x86-64.so.2` for the dynamic linker;
//     '/lib64/ld-linux-x86-64.so.2'.startsWith('/lib/') is FALSE (it's /lib64,
//     not /lib), so a perfectly good dependency got flagged — this would have
//     failed the native linux-x64-glibc leg on every build.
//   * FreeBSD/NetBSD/DragonFly's ldd prints the INSPECTED BINARY'S OWN PATH as
//     a header line first (e.g. "/usr/local/bin/tjs:"); a naive per-line
//     regex captured that header too and flagged it — this would have failed
//     freebsd-amd64, netbsd-amd64 and dragonflybsd-amd64, all publish:true
//     legs, any time the binary happened to sit under /usr/local.
// A denylist of the SPECIFIC roots we forbid cannot produce either false
// positive: it only fires when a dependency resolves inside a package-manager
// prefix, which is exactly (and only) the hazard CMAKE_IGNORE_PREFIX_PATH
// exists to prevent. Do not "simplify" this back into an allowlist.
//
// PKG_MANAGER_ROOTS itself is defined ONCE, above, alongside the
// CMAKE_IGNORE_PREFIX_PATH push — see the comment there for why this must
// stay a single shared constant rather than two lists that can drift.

// otool -L output: first line is the inspected binary's own path (`<path>:`);
// every following line is an indented "<dep path> (compatibility version ...)".
function parseOtoolDeps(output) {
  return output.split('\n').slice(1)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.match(/^(\S+)/)?.[1])
    .filter(Boolean);
}

// ldd output varies by libc, which is exactly why this is a denylist (see
// above): glibc emits bare "<dep path> (0x...)" or "<name> => <dep path>
// (0x...)" lines with no header; BSD ldd prefixes a "<binary path>:" header
// line. selfPath lets us drop that header even where it isn't syntactically
// distinguishable from a dependency line (a BSD binary living under
// /usr/local would otherwise look like a hit).
function parseLddDeps(output, selfPath) {
  const deps = [];
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim();
    if (!line || line === `${selfPath}:`) continue;
    // "name => /resolved/path (0x...)" or bare "/resolved/path (0x...)".
    // linux-vdso.so.1 has no resolved path (not a real file) and is dropped
    // by the startsWith('/') filter below, same as an unresolved "=> not found".
    const arrowMatch = line.match(/=>\s*(\S+)/);
    const resolved = arrowMatch ? arrowMatch[1] : line.match(/^(\S+)/)?.[1];
    if (resolved && resolved.startsWith('/')) deps.push(resolved);
  }
  return deps;
}

function checkHermeticDeps(enginePath) {
  if (crossFile) {
    console.log(`hermeticity check: SKIPPED (cross-built via ${crossFile} — the host's own otool/ldd cannot meaningfully inspect a foreign-arch/foreign-OS binary)`);
    return;
  }
  if (process.platform === 'win32') {
    console.log('hermeticity check: SKIPPED (Windows — no otool/ldd, and no package-manager-prefix hazard on this platform)');
    return;
  }
  // Static (musl) legs have no dynamic deps to inspect, by construction —
  // check this BEFORE touching otool/ldd at all. Gating on wantStatic first
  // (rather than letting a static binary fall into the otool/ldd try/catch
  // below) matters because the catch's message is "ldd unavailable or
  // failed to run: <error>", which for a static binary is misleadingly
  // read as a tooling problem instead of the expected, correct outcome.
  if (wantStatic) {
    console.log(`hermeticity check: OK — ${enginePath} is a static link (CLODE_TJS_STATIC=1) — no dynamic dependencies by construction`);
    return;
  }
  const tool = process.platform === 'darwin' ? 'otool' : 'ldd';
  const toolArgs = process.platform === 'darwin' ? ['-L', enginePath] : [enginePath];
  let out;
  try {
    out = runOut(tool, toolArgs);
  } catch (e) {
    console.log(`hermeticity check: SKIPPED (${tool} unavailable or failed to run: ${e.message})`);
    return;
  }
  const deps = process.platform === 'darwin' ? parseOtoolDeps(out) : parseLddDeps(out, enginePath);
  if (deps.length === 0) {
    // A successfully-run ldd/otool on a non-static binary that ALWAYS links
    // libc etc. must have at least one real dependency. Zero here means the
    // parser didn't recognize this platform's ldd output shape — e.g.
    // OpenBSD's ldd prints a "Start End Type Open Ref GrpRef Name" table,
    // not glibc/BSD's "name => path" or bare "/path" lines, so
    // parseLddDeps silently returns []. That is NOT the same as "verified
    // clean" — report it honestly as unparsed/unverified, not OK, so
    // openbsd-amd64/openbsd-arm64 (both publish:true) don't look checked
    // when they weren't.
    console.log(`hermeticity check: SKIPPED (${tool} ran but produced no parseable dependency lines for ${enginePath} — this platform's ${tool} output format is not recognized by parse${tool === 'otool' ? 'Otool' : 'Ldd'}Deps; NOT verified, not a pass)`);
    return;
  }
  for (const dep of deps) {
    const hitRoot = PKG_MANAGER_ROOTS.find((root) => dep === root || dep.startsWith(`${root}/`));
    if (hitRoot) {
      throw new Error(
        `hermeticity check FAILED: ${enginePath} dynamically depends on ${dep}, which ` +
        `resolves inside the package-manager prefix ${hitRoot}. A shipped engine must not ` +
        'depend on a third-party package manager (pkgsrc/Homebrew/MacPorts/Fink/...): a ' +
        'machine running it may not have that prefix at all, and when one DID, a mixed-in ' +
        'pkgsrc uv.h previously got compiled into this same binary alongside the vendored ' +
        'one and SIGABRTed before the first line of JS ran (2026-07-31 incident, see the ' +
        'CMAKE_IGNORE_PREFIX_PATH comment above). CMAKE_IGNORE_PREFIX_PATH should have kept ' +
        "cmake's find_*() from ever resolving into this prefix — if it linked anyway, either " +
        'this host\'s cmake predates 3.23 (see the loud warning above) or something ' +
        're-added a package-manager search path.');
    }
  }
  console.log(`hermeticity check: OK — ${enginePath} has ${deps.length} dynamic ${deps.length === 1 ? 'dependency' : 'dependencies'}, none from a package-manager prefix (${PKG_MANAGER_ROOTS.join(', ')})`);
}

// CLODE_TJS_SMOKE=off: skip the exec smoke — for cross-target engines the
// build host cannot execute the output (darwin-x86 i386: no runner and no
// arm64 dev box can exec it; the floor gate + the real-hardware oracle
// carry verification instead).
if ((process.env.CLODE_TJS_SMOKE || 'on').toLowerCase() !== 'off') {
  const engine = path.join(outDir, outName);
  const evalArgs = ['eval', 'console.log(typeof __tjs_fs_sync === "object" ? "tjs-shim-ok" : "MISSING-SYNC-FS")'];
  // A cosmo APE is a DOS/MBR 'MZ' fat binary; on macOS (and any host that won't
  // exec the raw MZ) it runs through its own shell prologue — `/bin/sh -c '"$@"'
  // sh <ape> <args>`, exactly the isApeFile route clode-fuse.cjs uses. On Linux/
  // BSD the APE execs directly, but the sh wrapper is a POSIX no-op there too.
  const smoke = cosmoTarget
    ? runOut('/bin/sh', ['-c', '"$@"', 'sh', engine, ...evalArgs])
    : runOut(engine, evalArgs);
  if (smoke !== 'tjs-shim-ok') throw new Error(`smoke failed: ${smoke}`);
  console.log(`built ${engine} (${smoke})`);
} else {
  console.log(`built ${path.join(outDir, outName)} (exec smoke SKIPPED: cross-target, CLODE_TJS_SMOKE=off)`);
}
checkHermeticDeps(path.join(outDir, outName));
