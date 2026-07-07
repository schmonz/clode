'use strict';
// node:tty — minimal surface for the -p boot. The bundle require()s it (ESM
// interop probe tty.__esModule, then tty.isatty) to decide whether stdio is a
// terminal. Under the loader, stdio is treated as non-tty (modules/process.cjs
// sets stdout.isTTY=false and stdin.isTTY=undefined), and the acceptance runs
// capture stdout through a pipe — so isatty is false for every fd. Characterized
// by test/node-shim-core.test.cjs (tty row).
//
// DIVERGENCE: isatty always returns false. This tjs build exposes no per-fd
// terminal probe reachable from JS; `-p` is a non-interactive pipe/redirect
// path where false is correct. A future interactive (TUI) path that must detect
// a real terminal is a later wall — wire it test-first against a tjs primitive
// then. ReadStream/WriteStream are constructor stand-ins for the ESM-interop
// `typeof` / instanceof feature-detects the bundle performs; they are not the
// interactive terminal streams (the -p path never instantiates them).
function isatty(_fd) { return false; }

class ReadStream {}
class WriteStream {}

module.exports = { isatty, ReadStream, WriteStream };
module.exports.default = module.exports;
