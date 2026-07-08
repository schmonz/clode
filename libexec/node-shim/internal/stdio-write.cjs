'use strict';
// Synchronous fd write over __tjs_fs_sync.write(fd, ArrayBuffer, position<0 =>
// write(2)). Shared by modules/process.cjs (stdout/stderr) and modules/tty.cjs
// (WriteStream) so the flush-before-exit contract lives in one place. POSIX
// write(2) on a blocking pipe/tty may short-write large payloads — loop until
// every byte lands.
const te = new TextEncoder();
const FSS = globalThis.__tjs_fs_sync;
function writeSyncFd(fd, s) {
  const bytes = te.encode(String(s));
  let off = 0;
  while (off < bytes.length) {
    const chunk = off === 0 ? bytes.buffer : bytes.buffer.slice(off);
    const n = FSS.write(fd, chunk, -1);
    if (n <= 0) throw new Error('node-shim: stdio write failed');
    off += n;
  }
  return true;
}
module.exports = { writeSyncFd };
