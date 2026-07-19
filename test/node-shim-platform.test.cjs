'use strict';
// Platform honesty characterization: 8 of the 22 tjs builder legs (netbsd ×2,
// dragonflybsd, midnightbsd, the three SunOS/illumos legs, haiku) used to
// misreport process.platform as 'linux' — detectPlatform enumerated
// Mac/Win/Linux/FreeBSD/OpenBSD and DEFAULTED to 'linux', and txiki's
// navigator polyfill emits lowercase "<platform> <machine>" for every OS it
// doesn't know. quaude-on-NetBSD noticed: the system prompt said "Platform:
// linux" while uname said NetBSD. The fix keys on
// navigator.userAgentData.platform, which txiki passes through VERBATIM
// (lowercase CMAKE_SYSTEM_NAME) for every OS outside its big five — one
// mapping covers all current and future legs. os.type() grows the matching
// uname -s spellings. Table-driven over the full release matrix, plus a live
// self-consistency row (module-load value == mapping of the real globals) so
// the suite proves honesty on whichever leg it runs.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

const PROG = `
const os = require('node:os');
const out = [];
const cases = [
  // [navigator.userAgentData.platform, navigator.platform, process.platform, os.type()]
  ['macOS',       'MacIntel',           'darwin',      'Darwin'],
  ['Windows',     'Win32',              'win32',       'Windows_NT'],
  ['Linux',       'Linux x86_64',       'linux',       'Linux'],
  ['FreeBSD',     'FreeBSD amd64',      'freebsd',     'FreeBSD'],
  ['OpenBSD',     'OpenBSD amd64',      'openbsd',     'OpenBSD'],
  ['netbsd',      'netbsd amd64',       'netbsd',      'NetBSD'],
  ['netbsd',      'netbsd evbarm',      'netbsd',      'NetBSD'],
  ['dragonfly',   'dragonfly x86_64',   'dragonfly',   'DragonFly'],
  ['sunos',       'sunos i86pc',        'sunos',       'SunOS'],
  ['midnightbsd', 'midnightbsd amd64',  'midnightbsd', 'MidnightBSD'],
  ['haiku',       'haiku x86_64',       'haiku',       'Haiku'],
];
for (const [ua, nav, plat, type] of cases) {
  const got = process.__detectPlatform(ua, nav);
  if (got !== plat) out.push('FAIL detect ' + ua + ': ' + got + ' != ' + plat);
  const t = os.__typeFor(plat);
  if (t !== type) out.push('FAIL type ' + plat + ': ' + t + ' != ' + type);
}
// Live self-consistency on THIS leg: what the module computed at load must
// equal the mapping applied to the real globals, and os.type() must follow.
const live = process.__detectPlatform(navigator.userAgentData?.platform, navigator.platform);
if (process.platform !== live) out.push('FAIL live platform ' + process.platform + ' != ' + live);
if (os.type() !== os.__typeFor(process.platform)) out.push('FAIL live type ' + os.type());
// Live arch honesty: process.arch must equal machineToNodeArch(uname -m), never a
// hardcoded 'arm64' on an x86_64 host (the Mavericks-build bug).
try {
  const mach = String(require('node:child_process').execFileSync('uname', ['-m'], { encoding: 'utf8' })).trim();
  const want = process.machineToNodeArch(mach);
  if (mach && process.arch !== want) out.push('FAIL live arch ' + process.arch + ' != ' + want + ' (uname ' + mach + ')');
} catch (e) { /* uname unavailable: skip */ }
console.log(out.length ? out.join('\\n') : 'OK');
`;

test('process.platform + os.type() are honest for every release-matrix identity', (t) => {
  if (skipUnlessTjs(t)) return;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-platform-'));
  const f = path.join(base, 'prog.cjs');
  fs.writeFileSync(f, PROG);
  const r = runLoader(f, [], { timeout: 8000 });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stdout.trim(), 'OK');
});

// winArch is a pure function of an injected env object, so it's testable by
// direct import rather than a fixture run under the loader — no live tjs
// binary needed. process.cjs itself is NOT requireable outside the loader in
// general (tjs.pid/tjs.exePath are read eagerly at module-eval time), so a
// minimal global.tjs stub is installed first purely to satisfy that
// module-load-time read; winArch itself never touches it when called with an
// explicit env argument (only its default parameter would).
global.tjs = { pid: 0, exePath: '/tjs', env: {} };
const { winArch, machineToNodeArch } = require('../libexec/node-shim/modules/process.cjs');

test('winArch derives honest Windows arch from PROCESSOR_ARCHITECTURE', () => {
  assert.strictEqual(winArch({ PROCESSOR_ARCHITECTURE: 'ARM64' }), 'arm64');
  assert.strictEqual(winArch({ PROCESSOR_ARCHITECTURE: 'AMD64' }), 'x64');
  assert.strictEqual(winArch({ PROCESSOR_ARCHITECTURE: 'X86' }), 'ia32');
  assert.strictEqual(winArch({}), 'x64');   // absent -> safe existing default
});

// machineToNodeArch: `uname -m` machine string -> node process.arch value. This
// is the non-win32 arch source (the old hardcoded 'arm64' was the Mavericks-build
// bug: on an x86_64 host it made codesignAdHoc thin the fat tjs template to
// arm64). Pure, so testable by direct import.
test('machineToNodeArch maps uname -m to node process.arch values', () => {
  assert.strictEqual(machineToNodeArch('x86_64'), 'x64');
  assert.strictEqual(machineToNodeArch('amd64'), 'x64');       // BSD
  assert.strictEqual(machineToNodeArch('arm64'), 'arm64');     // darwin
  assert.strictEqual(machineToNodeArch('aarch64'), 'arm64');   // linux
  assert.strictEqual(machineToNodeArch('evbarm'), 'arm64');    // NetBSD arm64 — mapping, not passthrough
  assert.strictEqual(machineToNodeArch('i686'), 'ia32');
  assert.strictEqual(machineToNodeArch('i386'), 'ia32');
  assert.strictEqual(machineToNodeArch('armv7l'), 'arm');
  assert.strictEqual(machineToNodeArch('powerpc'), 'ppc');
  assert.strictEqual(machineToNodeArch('Arm64'), 'arm64');     // case-insensitive
  assert.strictEqual(machineToNodeArch(''), 'x64');            // unknown/empty -> safe default (NOT the old arm64 lie)
});
