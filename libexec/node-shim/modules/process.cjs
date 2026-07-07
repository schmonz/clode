'use strict';
// node:process — M1 surface. Extended in Task 5 (nextTick, hrtime, stdio).
//
// tjs API notes (verified empirically against the pinned tjs v26.6.0
// binary; see libexec/node-shim/loader.cjs header for the full writeup):
//   - tjs.cwd, tjs.exePath, tjs.pid are already-evaluated VALUES, not
//     functions (unlike the brief's tjs.cwd()/tjs.exit() draft assumed for
//     cwd/exePath/pid — exit() genuinely is a function).
//   - tjs.platform does not exist on the global; navigator.platform
//     ('MacIntel' / 'Linux x86_64' / 'Win32' / ...) is the real signal.
//   - tjs.stdout / tjs.stderr are WritableStreams with no .write method;
//     you must tjs.stdout.getWriter() once and reuse the writer.
//   - tjs has no arch signal in this build; hardcoded 'arm64' below.
//     M4 (NetBSD/mac68k guest) must revisit this.
const te = new TextEncoder();

function detectPlatform() {
  const np = (typeof navigator !== 'undefined' && navigator.platform) || '';
  if (/^Mac/.test(np)) return 'darwin';
  if (/^Win/.test(np)) return 'win32';
  if (/^Linux/.test(np)) return 'linux';
  if (/FreeBSD/i.test(np)) return 'freebsd';
  if (/OpenBSD/i.test(np)) return 'openbsd';
  return 'linux';
}

let _stdoutWriter, _stderrWriter;
function writeOut(s) {
  if (!_stdoutWriter) _stdoutWriter = tjs.stdout.getWriter();
  _stdoutWriter.write(te.encode(String(s)));
  return true;
}
function writeErr(s) {
  if (!_stderrWriter) _stderrWriter = tjs.stderr.getWriter();
  _stderrWriter.write(te.encode(String(s)));
  return true;
}

module.exports = {
  argv: [],                                  // loader overwrites after load
  env: new Proxy({}, {
    get: (_, k) => (typeof k === 'string' ? tjs.env[k] : undefined),
    has: (_, k) => typeof k === 'string' && k in tjs.env,
    ownKeys: () => Reflect.ownKeys(tjs.env),
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
  }),
  platform: detectPlatform(),
  arch: 'arm64', // M4: derive per-platform (no arch signal in this tjs build)
  pid: tjs.pid,
  execPath: tjs.exePath ?? '/tjs',
  cwd: () => tjs.cwd,
  exit: (c) => tjs.exit(c ?? 0),
  exitCode: 0,
  versions: { node: '24.0.0-node-shim-m1' },
  stdout: { write: writeOut, isTTY: false },
  stderr: { write: writeErr, isTTY: false },
};
