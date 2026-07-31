'use strict';
// The old-Darwin poll(2) backend fixup (spec 2026-07-31-old-darwin-poll-backend).
// Darwin 8's kqueue drops socket/pipe/SIGCHLD/async delivery under the fused
// runtime's fd load, so the 10.4-floor legs build libuv's generic posix-poll.c
// instead of kqueue.c. The SOURCE edits are unconditional and inert; only the
// cmake selection is gated on the CLODE_DARWIN_POLL option.
//
// This drives the real source phase (`build-tjs.mjs --source-only`), which resets
// the shared vendor checkout to pristine and re-applies every patch + fixup —
// build-tjs owns that tree, so the reset is its normal behavior. Skips when the
// checkout is absent (a fresh clone would have to hit the network).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const TJS = path.join(REPO, 'spike/quickjs/vendor/txiki.js');
const has = fs.existsSync(path.join(TJS, 'deps/libuv/src/unix/darwin.c'));

function sourcePhase() {
  execFileSync('node', ['scripts/build-tjs.mjs', '--source-only'],
    { cwd: REPO, stdio: 'pipe', encoding: 'utf8' });
}
const read = (rel) => fs.readFileSync(path.join(TJS, rel), 'utf8');

test('the poll-backend fixup lands its five edits in the patched tree', (t) => {
  if (!has) { t.skip('no vendor checkout (spike/quickjs/vendor/txiki.js); run scripts/build-tjs.mjs'); return; }
  sourcePhase();

  // 1. txiki declares the option and makes the macro GLOBAL — it changes
  //    uv_loop_t's layout, so libuv and txiki TUs must agree.
  const tjsCmake = read('CMakeLists.txt');
  assert.match(tjsCmake, /option\(CLODE_DARWIN_POLL /);
  assert.match(tjsCmake, /add_compile_definitions\(CLODE_DARWIN_POLL\)/);

  // 2. libuv swaps the backend sources under the option.
  const uvCmake = read('deps/libuv/CMakeLists.txt');
  assert.match(uvCmake, /if\(NOT CLODE_DARWIN_POLL\)\n {4}list\(APPEND uv_sources src\/unix\/kqueue\.c\)/);
  assert.match(uvCmake, /list\(APPEND uv_sources src\/unix\/posix-poll\.c src\/unix\/no-fsevents\.c\)/);

  // 3. UV_HAVE_KQUEUE goes away (this is what flips process.c off EVFILT_PROC
  //    onto SIGCHLD and async.c onto pipe wakeups), and the loop gains posix
  //    poll fields.
  const darwinH = read('deps/libuv/include/uv/darwin.h');
  assert.match(darwinH, /#if !defined\(CLODE_DARWIN_POLL\)\n#define UV_HAVE_KQUEUE 1\n#endif/);
  assert.match(darwinH, /struct pollfd\* poll_fds;/);

  // 4. darwin.c's kqueue-calling platform hooks yield to posix-poll.c's.
  const darwinC = read('deps/libuv/src/unix/darwin.c');
  assert.match(darwinC, /#if !defined\(CLODE_DARWIN_POLL\)\nint uv__platform_loop_init/);

  // 5. EVFILT_USER async wakeups are off (they would kevent on backend_fd == -1).
  const internalH = read('deps/libuv/src/unix/internal.h');
  assert.match(internalH, /#if defined\(EVFILT_USER\) && defined\(NOTE_TRIGGER\) && !defined\(CLODE_DARWIN_POLL\)/);
});

test('the edits are inert: the option defaults OFF and kqueue stays the default', (t) => {
  if (!has) { t.skip('no vendor checkout (spike/quickjs/vendor/txiki.js)'); return; }
  // No second source phase needed — assert on the tree the first test produced.
  assert.match(read('CMakeLists.txt'), /option\(CLODE_DARWIN_POLL "[^"]+" OFF\)/);
  // Without the macro, darwin.h still defines UV_HAVE_KQUEUE and libuv still
  // compiles kqueue.c + fsevents.c — i.e. every shipping darwin leg is unchanged.
  assert.match(read('deps/libuv/CMakeLists.txt'), /else\(\)\n {4}list\(APPEND uv_sources src\/unix\/fsevents\.c\)/);
});

test('the fixup is idempotent', (t) => {
  if (!has) { t.skip('no vendor checkout (spike/quickjs/vendor/txiki.js)'); return; }
  const before = read('deps/libuv/include/uv/darwin.h');
  sourcePhase();
  assert.strictEqual(read('deps/libuv/include/uv/darwin.h'), before,
    're-running the source phase must not double-apply the fixup');
});
