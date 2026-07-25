'use strict';
// Idempotently patch harness deps for platforms upstream omits, BEFORE the native
// build. node-pty 1.1.0's src/unix/pty.cc has a forkpty include block with branches
// for __linux__/__APPLE__/__FreeBSD__/__OpenBSD__ but NO __NetBSD__, so on NetBSD it
// includes no header and forkpty/openpty/B38400/VTIME/cfsetispeed are all undeclared
// — the addon won't compile. NetBSD provides these in <util.h> + <termios.h> (linking
// -lutil, which binding.gyp already does for every non-mac/solaris target), IDENTICAL
// to the OpenBSD branch. Add the missing branch so the addon builds — the "make it
// available", not "silently skip", answer. Upstreamable to node-pty verbatim.
const fs = require('node:fs');
const path = require('node:path');

// The exact OpenBSD branch we clone the NetBSD one from (kept as a literal so a shape
// change upstream trips the loud error below instead of silently no-op'ing).
const ANCHOR = '#elif defined(__OpenBSD__)\n#include <util.h>\n#include <termios.h>\n#endif';
const PATCHED = '#elif defined(__OpenBSD__)\n#include <util.h>\n#include <termios.h>\n' +
                '#elif defined(__NetBSD__)\n#include <util.h>\n#include <termios.h>\n#endif';

// Returns true if it changed the file, false if there was nothing to do (node-pty
// absent, or already carries a __NetBSD__ branch). Throws if the upstream block
// changed shape — that must be handled deliberately, not patched blind.
function patchNodePty(harnessDir) {
  const f = path.join(harnessDir, 'node_modules', 'node-pty', 'src', 'unix', 'pty.cc');
  let src;
  try { src = fs.readFileSync(f, 'utf8'); } catch { return false; } // node-pty not installed here
  if (src.includes('__NetBSD__')) return false;                     // already present (ours or upstream's)
  if (!src.includes(ANCHOR)) {
    throw new Error('harness-patch: node-pty pty.cc forkpty include block changed shape; ' +
      'update ANCHOR/PATCHED in test/harness-patch.cjs');
  }
  fs.writeFileSync(f, src.replace(ANCHOR, PATCHED));
  return true;
}

module.exports = { patchNodePty, ANCHOR, PATCHED };
