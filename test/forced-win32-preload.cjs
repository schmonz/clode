'use strict';
// The preload half of the forced-win32 second pass. See test/forced-win32.cjs for WHY
// this exists, WHAT it can and cannot catch, and where it runs.
//
// This file is loaded with `node --require` BEFORE the test file, which is the whole
// mechanism: `process.platform` is read at call time by product and test code, so a
// module that branches on it takes the win32 branch for real. Nothing is mocked and no
// test file is edited — this is exactly the wrapper shape that produced the RED for the
// third round of Windows-only failures, promoted from a one-off into a standing pass.
//
// TWO THINGS HAVE TO HAPPEN HERE, IN THIS ORDER.
//
// 1. A TEMP DIRECTORY THAT EXISTS. `os.tmpdir()` on the win32 branch answers
//    `process.env.TEMP || process.env.TMP || ...`, and on a POSIX box neither is set —
//    so flipping the platform alone makes `os.tmpdir()` return the string
//    "undefined\temp" and EVERY `fs.mkdtempSync(path.join(os.tmpdir(), ...))` in the
//    suite fails with ENOENT. That is noise about this shim, not about Windows, and a
//    pass whose failures are all its own fault is a pass nobody reads. Pointing TEMP at
//    the real tmpdir keeps `os.tmpdir()` WORKING while still routing it through the
//    win32 branch — so a test that hardcodes `/tmp` instead of asking still goes red,
//    which is the assumption worth catching.
//
// 2. THE FLIP ITSELF, last, so the lookup above sees the real platform.
const os = require('node:os');
const realTmp = os.tmpdir();
if (!process.env.TEMP) process.env.TEMP = realTmp;
if (!process.env.TMP) process.env.TMP = realTmp;

// `configurable: true` on purpose: a test that needs the real platform back can redefine
// it, and node:test's own internals never touch this property.
Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

// A witness, so the pass can PROVE the flip reached the child rather than assuming a
// --require that silently did not load (test/forced-win32.test.cjs asserts on it).
process.env.CLODE_FORCED_WIN32 = '1';
