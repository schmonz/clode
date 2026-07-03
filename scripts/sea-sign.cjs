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

const [phase, bin] = process.argv.slice(2);
if (!bin || (phase !== 'unsign' && phase !== 'sign')) {
  console.error('usage: sea-sign.cjs <unsign|sign> <binary>');
  process.exit(2);
}

function run(cmd, args) { execFileSync(cmd, args, { stdio: 'inherit' }); }

if (phase === 'unsign') {
  if (process.platform === 'darwin') run('codesign', ['--remove-signature', bin]);
  else if (process.platform === 'win32') {
    try { run('signtool', ['remove', '/s', bin]); }
    catch { console.error('sea-sign: signtool unavailable — shipping unsigned'); }
  }
} else { // sign
  if (process.platform === 'darwin') run('codesign', ['--sign', '-', bin]); // ad-hoc; required or it won't run
}
