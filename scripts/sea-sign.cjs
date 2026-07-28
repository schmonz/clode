#!/usr/bin/env node
'use strict';
// Prepare a SEA binary's code signature around postject injection, so build-sea.mjs can call
// ONE command identically on every OS instead of branching on process.platform itself. All
// the per-OS signing specifics live here:
//
//   unsign (BEFORE injection) — strip any existing signature so postject can rewrite the file:
//     * darwin -> `codesign --remove-signature` (postject would otherwise corrupt the sig)
//     * win32  -> `signtool remove /s` (node.exe ships Authenticode-signed; best-effort —
//                 tolerate signtool's absence since we ship unsigned regardless)
//     * linux/other -> nothing (an ELF needs no signature to run)
//
//   sign (AFTER injection) — re-apply whatever the OS needs for the binary to run:
//     * darwin -> `codesign --sign -` (ad-hoc; a Mach-O SEA won't launch unsigned)
//     * win32/linux -> nothing (Windows dist is intentionally unsigned — no cert; ELF needs none)
//
// A darwin TARGET built on a non-darwin HOST (cross-build) has no `codesign` available.
// The spike (Task 1) proved `rcodesign sign <in> <out>` (ad-hoc, no key) produces a
// runnable, codesign-valid Mach-O, and that rcodesign has no `remove-signature`
// subcommand — its `sign` replaces the signature outright, so the "unsign before
// postject" step is a no-op off-Mac. Never ship an unsigned darwin Mach-O: with no
// signer provided, throw rather than silently skip signing.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

function defaultRun(cmd, args) { execFileSync(cmd, args, { stdio: 'inherit' }); }

// Sign for the TARGET os, not necessarily the host's — a cross-build's output
// binary is for another platform than the one running this script. `host`
// defaults to process.platform, matching every native (host==target) build.
// `signerBin` is the rcodesign path, required only when os==='darwin' and
// host!=='darwin'. `run` is injectable for tests; defaults to a real execFileSync.
function sign(phase, bin, os = process.platform, opts = {}) {
  const { host = process.platform, signerBin, run = defaultRun } = opts;
  if (os === 'darwin' && host !== 'darwin') {
    if (!signerBin) {
      throw new Error(`sea-sign: a darwin target built on ${host} needs rcodesign — none provided`);
    }
    if (phase === 'sign') {
      const tmp = bin + '.rcs';
      run(signerBin, ['sign', bin, tmp]);
      fs.renameSync(tmp, bin);
      fs.chmodSync(bin, 0o755);
    }
    // unsign is a no-op off-Mac: rcodesign has no remove-signature subcommand,
    // and `rcodesign sign` replaces the signature rather than requiring a
    // pre-stripped input.
    return;
  }
  if (phase === 'unsign') {
    if (os === 'darwin') run('codesign', ['--remove-signature', bin]);
    else if (os === 'win32') {
      try { run('signtool', ['remove', '/s', bin]); }
      catch { console.error('sea-sign: signtool unavailable — shipping unsigned'); }
    }
  } else { // sign
    if (os === 'darwin') run('codesign', ['--sign', '-', bin]); // ad-hoc; required or it won't run
  }
}

module.exports = { sign };

// Run as a CLI only when invoked directly (build-naude.mjs's seaSign shells
// out to this file as a subprocess); importing it (a future unit test, or
// anything else that requires this module for its exported `sign`) must not
// touch — let alone validate-and-exit(2) on — the REQUIRING process's own argv.
if (require.main === module) {
  const [phase, bin, targetOsArg, signer] = process.argv.slice(2);
  if (!bin || (phase !== 'unsign' && phase !== 'sign')) {
    console.error('usage: sea-sign.cjs <unsign|sign> <binary> [target-os] [signer]');
    process.exit(2);
  }
  sign(phase, bin, targetOsArg, { signerBin: signer });
}
