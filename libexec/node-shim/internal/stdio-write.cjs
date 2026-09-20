'use strict';
// Synchronous fd write over __tjs_fs_sync.write(fd, ArrayBuffer, position<0 =>
// write(2)). Shared by modules/process.cjs (stdout/stderr) and modules/tty.cjs
// (WriteStream) so the flush-before-exit contract lives in one place. POSIX
// write(2) on a blocking pipe/tty may short-write large payloads — loop until
// every byte lands.
const te = new TextEncoder();
const FSS = globalThis.__tjs_fs_sync;
// BYTES, not a string. child_process.spawnSync replays a captured child's output here to
// emulate stdio:'inherit' (the C primitive cannot inherit an fd), and that output is
// arbitrary bytes: routing it through String() would put U+FFFD wherever a compiler
// emitted a non-UTF-8 byte. The string entry point below is the one process/tty use.
function writeSyncFdBytes(fd, bytes) {
  let off = 0;
  while (off < bytes.length) {
    const chunk = off === 0
      ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
      : bytes.buffer.slice(bytes.byteOffset + off, bytes.byteOffset + bytes.byteLength);
    const n = FSS.write(fd, chunk, -1);
    if (n <= 0) throw new Error('node-shim: stdio write failed');
    off += n;
  }
  return true;
}
function writeSyncFd(fd, s) {
  return writeSyncFdBytes(fd, te.encode(String(s)));
}
module.exports = { writeSyncFd, writeSyncFdBytes };
