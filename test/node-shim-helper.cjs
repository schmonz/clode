'use strict';
// Locates the patched tjs binary and runs entries through the node-shim
// loader. Tests SKIP when no binary is present (CLODE_TJS or build/tjs/tjs).
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { tjsBin } = require('../scripts/platform-tag.cjs');

const REPO = path.resolve(__dirname, '..');
const LOADER = path.join(REPO, 'libexec/node-shim/loader.cjs');

function tjsPath() {
  // Default is the platform-unique path (build/tjs/<osToken>-<arch>) — never the
  // bare build/tjs/tjs, whose shared location let a foreign-platform binary linger
  // and defeat this gate (a macOS Mach-O on a NetBSD tree → exec format error).
  const cand = process.env.CLODE_TJS || tjsBin(REPO);
  return fs.existsSync(cand) ? cand : null;
}

// A Cosmopolitan APE engine starts with the DOS 'MZ' magic and cannot be
// execve'd on non-Windows hosts — it must run via the ENOEXEC shell trampoline
// (`/bin/sh -c '"$@"' sh <ape> …`). Detect it so the agentic harness can drive a
// cosmo engine the same way e2e-pty.cjs's apeCmd() drives the interactive one.
//
// CAVEAT this detector does NOT resolve: 'MZ' is also the first two bytes of
// every plain Windows PE (a cosmo APE *is* a valid PE — that's the whole trick
// that lets it boot natively on Windows; a non-cosmo tjs.exe built by MSVC/MinGW
// is just an ordinary PE with the same two bytes). So `isApeFile` alone cannot
// tell "cosmo APE" from "plain Windows PE" — it can only tell "MZ-headed" from
// not. Distinguishing the two for real means walking the PE header to the cosmo
// shell-script prologue (`MZqFpD`) or checking for the appended zip trailer;
// not worth it here because `wantsTrampoline` below never needs that finer
// answer — see the comment there.
function isApeFile(bin) {
  try {
    const fd = fs.openSync(bin, 'r');
    const b = Buffer.alloc(2);
    fs.readSync(fd, b, 0, 2, 0);
    fs.closeSync(fd);
    return b[0] === 0x4d && b[1] === 0x5a; // 'MZ'
  } catch { return false; }
}

// Pure decision function, deliberately separated from tjsPath()/fs access so it
// can be unit-tested on every platform (see node-shim-helper.test.cjs) without
// needing a real Windows host or a real APE binary to fake out.
//
// WHY the trampoline exists at all (POSIX): a Cosmopolitan APE is an MZ-headed
// polyglot. The POSIX kernel's execve() looks at the MZ header, doesn't
// recognize it as ELF/Mach-O, and refuses with ENOEXEC — so on Linux/macOS/BSD
// the only way to run it is through `/bin/sh`, which has its own ENOEXEC
// fallback that recognizes the cosmo shell-script prologue and re-execs it
// correctly.
//
// WHY it must NOT be used on win32: on Windows, an MZ-headed file is not a
// foreign polyglot to route around — it *is* the native executable format.
// CreateProcess loads it directly as a PE, no trampoline needed, and Windows
// has no `/bin/sh` to spawn one through anyway. Naively gating only on
// `isApeFile()` (as the code did before this fix) treats "starts with MZ" as
// "needs the shell trampoline" — true on POSIX, but every ordinary tjs.exe
// (cosmo APE or plain PE, doesn't matter) is *also* MZ-headed on Windows. That
// misdetection is exactly what broke CI run 30675029624: `windows-x64-tests`
// and `windows-arm64-tests` failed both agentic Bash/Edit round-trip rows with
// `Error: spawn /bin/sh ENOENT`, because the harness tried to shell out to a
// path that doesn't exist on Windows. Gating on platform (not refining
// isApeFile's magic-number check) is the fix: it's a one-line, impossible-to-
// misread condition, and it's correct regardless of which detector produced
// `isApe` — even a hypothetical byte-perfect cosmo-vs-PE detector would still
// need this platform check, since a *genuine* cosmo APE run on Windows still
// wants direct PE execution, not the shell trampoline.
function wantsTrampoline(platform, isApe) {
  return platform !== 'win32' && isApe;
}

// Build the [command, argv] to spawn the engine, APE-aware. For a normal Mach-O/
// ELF binary (or any binary on win32) this is just [tjs, args]; for an APE on a
// POSIX host it wraps in the /bin/sh trampoline. Behavior-neutral for non-APE
// engines (the common case) and for every Windows binary (see wantsTrampoline).
function engineSpawn(args) {
  const tjs = tjsPath();
  if (!tjs) throw new Error('no tjs binary (gate with skipUnlessTjs first)');
  if (wantsTrampoline(process.platform, isApeFile(tjs))) {
    return ['/bin/sh', ['-c', '"$@"', 'sh', tjs, ...args]];
  }
  return [tjs, args];
}

function runLoader(entry, args = [], opts = {}) {
  const [cmd, argv] = engineSpawn(['run', LOADER, entry, ...args]);
  const r = spawnSync(cmd, argv, {
    encoding: 'utf8',
    env: { ...process.env, ...(opts.env || {}) },
    input: opts.input,
    timeout: opts.timeout || 30000,
    // Optional privilege drop (root-only; EPERM otherwise). Used by the
    // getuid ACCEPTANCE row, which is value-blind when the test runner is
    // itself uid 0 — see node-shim-getuid.test.cjs.
    ...(opts.uid !== undefined ? { uid: opts.uid } : {}),
    ...(opts.gid !== undefined ? { gid: opts.gid } : {}),
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', error: r.error };
}

// Locate a program on PATH, because an absolute path to a system utility is
// NOT portable across the hosts this oracle runs on — and a wrong one fails in
// two different ways, only one of them loud.
//
// The musl reference leg runs in node:24.18.1-alpine, where every "coreutil"
// is a busybox applet symlinked at ITS canonical directory: `false` and
// `printenv` are BB_DIR_BIN (/bin/false, /bin/printenv) and there is no
// /usr/bin/false or /usr/bin/printenv at all. macOS is the exact mirror image:
// /usr/bin/false and /usr/bin/printenv exist, /bin/false and /bin/printenv do
// not. (VERIFIED, not assumed: the file list of the exact CI image
// node:24.18.1-alpine linux/amd64, manifest digest sha256:9b6d6e32fdbed527…,
// contains bin/false, bin/printenv and usr/bin/env — and no usr/bin/false or
// usr/bin/printenv at all; its PATH includes /bin. Cross-checked against
// alpine-minirootfs 3.20/3.21/3.22 and against this Mac, where it is the
// reverse.) A hardcoded /usr/bin/false therefore ENOENTs on alpine —
// loudly, because cp.spawn's ENOENT is an unhandled 'error' event that kills
// the reference-node fixture. A hardcoded /usr/bin/printenv ENOENTs SILENTLY,
// because cp.spawnSync returns {status:null,stdout:null} instead of throwing,
// so BOTH sides of the differential produce the same empty result and the row
// passes while testing nothing. Resolve at test time instead of guessing.
function resolveBin(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    const p = path.join(d, name);
    try {
      const st = fs.statSync(p);
      if (st.isFile() && (st.mode & 0o111)) return p;
    } catch { /* not here; keep looking */ }
  }
  return null;
}

function skipUnlessTjs(t) {
  if (!tjsPath()) { t.skip('no tjs binary (CLODE_TJS or build/tjs/tjs); run scripts/build-tjs.mjs'); return true; }
  return false;
}

module.exports = { tjsPath, runLoader, resolveBin, skipUnlessTjs, isApeFile, wantsTrampoline, engineSpawn, REPO, LOADER };
