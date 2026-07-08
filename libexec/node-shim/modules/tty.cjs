'use strict';
// node:tty — minimal surface for the -p boot. The bundle require()s it (ESM
// interop probe tty.__esModule, then tty.isatty) to decide whether stdio is a
// terminal. Under the loader, stdio is treated as non-tty (modules/process.cjs
// sets stdout.isTTY=false and stdin.isTTY=undefined), and the acceptance runs
// capture stdout through a pipe — so isatty is false for every fd. Characterized
// by test/node-shim-core.test.cjs (tty row).
//
// isatty over the public tjs stdio streams: fd 0/1/2 map to tjs.stdin/stdout/
// stderr, whose .isTerminal is a real TIOCGWINSZ/isatty-backed probe. Other fds
// aren't individually probeable from JS in this build → false (the bundle only
// asks about 0/1/2).
function isatty(fd) {
  if (fd === 0) return !!tjs.stdin.isTerminal;
  if (fd === 1) return !!tjs.stdout.isTerminal;
  if (fd === 2) return !!tjs.stderr.isTerminal;
  return false;
}

class ReadStream {}
class WriteStream {}

module.exports = { isatty, ReadStream, WriteStream };
module.exports.default = module.exports;
