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
const { execFileSync } = require('node:child_process');

function run(cmd, args) { execFileSync(cmd, args, { stdio: 'inherit' }); }

// Sign for the TARGET os, not necessarily the host's — a cross-build's output
// binary is for another platform than the one running this script. Defaults to
// the host (process.platform), matching every native (host==target) build.
function sign(phase, bin, os = process.platform) {
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
  const [phase, bin, targetOsArg] = process.argv.slice(2);
  if (!bin || (phase !== 'unsign' && phase !== 'sign')) {
    console.error('usage: sea-sign.cjs <unsign|sign> <binary> [target-os]');
    process.exit(2);
  }
  sign(phase, bin, targetOsArg);
}
