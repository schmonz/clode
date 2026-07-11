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
