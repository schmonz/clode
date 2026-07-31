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

test('the poll-backend fixup lands its seven edits in the patched tree', (t) => {
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
  //    poll fields — proven by asserting the WIRING (cf_signals directly
  //    followed by the new field-list macro inside UV_PLATFORM_LOOP_FIELDS),
  //    not just that the field-list macro is declared SOMEWHERE in the file:
  //    a dropped `.replace(fieldsOld, fieldsNew)` call would still leave the
  //    macro's own declaration text present (it's a separate string literal in
  //    the fixup), so asserting only `/struct pollfd\* poll_fds;/` can't catch
  //    that — loop->poll_fds would have no such struct member and the ON build
  //    fails to compile, while this test kept passing.
  const darwinH = read('deps/libuv/include/uv/darwin.h');
  assert.match(darwinH, /#if !defined\(CLODE_DARWIN_POLL\)\n#define UV_HAVE_KQUEUE 1\n#endif/);
  assert.match(darwinH, /cf_signals;\s*\\\n\s*UV_CLODE_DARWIN_POLL_FIELDS/);

  // 4. darwin.c's kqueue-calling platform hooks yield to posix-poll.c's.
  const darwinC = read('deps/libuv/src/unix/darwin.c');
  assert.match(darwinC, /#if !defined\(CLODE_DARWIN_POLL\)\nint uv__platform_loop_init/);

  // 5. EVFILT_USER async wakeups are off (they would kevent on backend_fd == -1).
  const internalH = read('deps/libuv/src/unix/internal.h');
  assert.match(internalH, /#if defined\(EVFILT_USER\) && defined\(NOTE_TRIGGER\) && !defined\(CLODE_DARWIN_POLL\)/);

  // 6. uv__fs_event()'s UNREACHABLE() shim widens to cover CLODE_DARWIN_POLL —
  //    without this, dropping kqueue.c (edit 2, the only real definition)
  //    leaves core.c's UV__FS_EVENT case (core.o always links) calling an
  //    undefined symbol: the ON build fails to LINK, not just to run.
  assert.match(internalH, /#if \(!defined\(__APPLE__\) \|\| defined\(CLODE_DARWIN_POLL\)\) &&/);
  assert.match(internalH, /#define uv__fs_event\(loop, w, events\) UNREACHABLE\(\)/);

  // 7. posix-poll.c: the wait call inside uv__io_poll is the guarded
  //    select()-based wrapper, not a bare poll() (Apple's poll(2) is broken
  //    under load on 10.3-10.8 — see the fixup's own comment for the
  //    measured Tiger symptom and the curl prior-art citation).
  // The guard must wrap the ENTIRE helper — opening immediately before its
  // doc comment and closing immediately after its closing brace — not just
  // appear SOMEWHERE earlier in the file. A lazy [\s\S]*? between an earlier,
  // unrelated `#if defined(CLODE_DARWIN_POLL)` (the includes guard, above)
  // and this function would happily cross intervening #endif/#if lines to
  // reach the target text, so this would still pass on an UNGUARDED helper —
  // exactly the inertness property the cosmo leg and every non-darwin leg
  // depend on. [^#]* refuses to cross any '#' (no preprocessor directive
  // appears inside the comment or the function body), which forces the match
  // to start at the helper's OWN guard.
  const posixPollC = read('deps/libuv/src/unix/posix-poll.c');
  assert.match(posixPollC,
    /#if defined\(CLODE_DARWIN_POLL\)\n\/\*[^#]*?\*\/\nstatic int uv__clode_poll_select\(struct pollfd\* fds, nfds_t nfds, int timeout\) \{[^#]*?\n\}\n#endif\n/);
  assert.match(posixPollC,
    /#if defined\(CLODE_DARWIN_POLL\)\n {4}nfds = uv__clode_poll_select\(loop->poll_fds, \(nfds_t\)loop->poll_fds_used, timeout\);\n#else\n {4}nfds = poll\(loop->poll_fds, \(nfds_t\)loop->poll_fds_used, timeout\);\n#endif/);
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
  const beforeDarwinH = read('deps/libuv/include/uv/darwin.h');
  // The gate marker AND the newest (7th) edit both now live in posix-poll.c —
  // that is the exact file a double-application (the failure this gate
  // exists to prevent) would show up in, so diff it too, not just darwin.h
  // (whose own edit is 6 edits upstream of the gate now).
  const beforePosixPollC = read('deps/libuv/src/unix/posix-poll.c');
  sourcePhase();
  assert.strictEqual(read('deps/libuv/include/uv/darwin.h'), beforeDarwinH,
    're-running the source phase must not double-apply the fixup');
  assert.strictEqual(read('deps/libuv/src/unix/posix-poll.c'), beforePosixPollC,
    're-running the source phase must not double-apply edit (7) in posix-poll.c');
});

// --- Source-text guards below: assert against scripts/build-tjs.mjs's OWN text,
// not the vendor tree, so they run on every CI job (ubuntu/windows have no
// vendor checkout — every test above SKIPs there, and this codebase's doctrine
// is explicit that a skipped oracle is not a pass, .github/workflows/ci.yml:341).
// These don't re-prove exact wiring (the vendor-tree tests above own that); they
// catch the coarser regression of the fixup being dropped or unregistered
// entirely, everywhere, unconditionally.
const buildTjsSrc = fs.readFileSync(path.join(REPO, 'scripts/build-tjs.mjs'), 'utf8');

test('build-tjs.mjs: the poll-backend fixup is registered right after the tty-kqueue fixup', () => {
  assert.match(buildTjsSrc,
    /fixupLibuvTtyKqueueOldDarwin\(tjsDir\);\s*\n\s*fixupLibuvPollBackendOldDarwin\(tjsDir\);/);
});

test('build-tjs.mjs: the fixup body carries all seven CLODE_DARWIN_POLL edit guards', () => {
  const fnStart = buildTjsSrc.indexOf('function fixupLibuvPollBackendOldDarwin(dir) {');
  const fnEnd = buildTjsSrc.indexOf('\nfunction fixupTjsHandleDump(dir) {', fnStart);
  assert.ok(fnStart >= 0 && fnEnd > fnStart, 'fixupLibuvPollBackendOldDarwin function body must exist');
  const body = buildTjsSrc.slice(fnStart, fnEnd);

  // (1) txiki CMakeLists.txt: option + global compile definition.
  assert.ok(body.includes('add_compile_definitions(CLODE_DARWIN_POLL)'), 'edit 1: global compile definition');
  // (2) libuv CMakeLists.txt: source-list swap.
  assert.ok(body.includes('if(NOT CLODE_DARWIN_POLL)'), 'edit 2: kqueue.c gated out');
  assert.ok(body.includes('src/unix/posix-poll.c src/unix/no-fsevents.c'), 'edit 2: posix-poll.c gated in');
  // (3) darwin.h: UV_HAVE_KQUEUE gated, loop fields added.
  assert.ok(body.includes('poll_fds_iterating'), 'edit 3: posix-poll loop fields declared');
  assert.ok(body.includes('UV_CLODE_DARWIN_POLL_FIELDS'), 'edit 3: loop fields wired into UV_PLATFORM_LOOP_FIELDS');
  // (4) darwin.c: kqueue-calling platform hooks gated out.
  assert.ok(body.includes("hooksNew = '#if !defined(CLODE_DARWIN_POLL)"), 'edit 4: platform-hook pair gated');
  // (5) internal.h: EVFILT_USER async wakeups gated out.
  assert.ok(body.includes('defined(EVFILT_USER) && defined(NOTE_TRIGGER) && !defined(CLODE_DARWIN_POLL)'),
    'edit 5: EVFILT_USER gated');
  // (6) internal.h: uv__fs_event() UNREACHABLE() shim widened (the link-time fix).
  assert.ok(body.includes('!defined(__APPLE__) || defined(CLODE_DARWIN_POLL)'), 'edit 6: uv__fs_event shim widened');
  // (7) posix-poll.c: poll(2) itself is broken under load on Apple 10.3-10.8
  //     (curl prior art), so the wait call goes through a select()-based
  //     wrapper instead — this is the gate marker too (the new LAST edit).
  assert.ok(body.includes('static int uv__clode_poll_select(struct pollfd* fds, nfds_t nfds, int timeout)'),
    'edit 7: select()-based poll() replacement declared');
  assert.ok(body.includes('nfds = uv__clode_poll_select(loop->poll_fds, (nfds_t)loop->poll_fds_used, timeout);'),
    'edit 7: uv__io_poll calls the select()-based wrapper under the guard');
  assert.ok(body.includes('daniel.haxx.se/blog/2016/10/11/poll-on-mac-10-12-is-broken'),
    'edit 7: curl prior-art citation present');
});

test('the darwin-poll knob refuses a non-darwin target, loudly and early', () => {
  // posix-poll.c replaces kqueue.c, which only the Apple/BSD cmake branches
  // compile — asking for it on a Linux/NetBSD target is a build-config bug, not
  // a silent no-op. The guard runs before any phase, so --source-only trips it.
  let err = null;
  try {
    execFileSync('node', ['scripts/build-tjs.mjs', '--source-only'], {
      cwd: REPO,
      stdio: 'pipe',
      encoding: 'utf8',
      env: { ...process.env,
             CLODE_TJS_DARWIN_POLL: '1',
             CLODE_TJS_CROSS_FILE: 'scripts/netbsd-m68k.toolchain.cmake' },
    });
  } catch (e) { err = e; }
  assert.ok(err, 'expected a non-zero exit');
  assert.match(String(err.stderr), /CLODE_TJS_DARWIN_POLL=1 is darwin-only/);
});
