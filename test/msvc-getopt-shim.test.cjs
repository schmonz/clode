'use strict';
// The MSVC getopt shim (fixupQjscMsvcGetopt in scripts/build-tjs.mjs), checked
// the only way that means anything: DIFFERENTIALLY, against the platform getopt,
// on the exact option string src/qjsc.c passes.
//
// WHY THIS EXISTS. src/qjsc.c calls getopt/optarg/optind unconditionally and MSVC
// ships none of them. That went unnoticed for 16 days because `tjsc` is
// EXCLUDE_FROM_ALL upstream and nothing built it until 0c72693 made bytecode
// regen the default; the failure then showed up only on a Windows runner, only
// on a cache miss. Hand-written C that no test can reach is how that repeats, so
// this compiles the shim HERE, on any POSIX box, and diffs its behaviour against
// the real getopt. A wrong shim fails on a Mac in seconds instead of on a
// Windows runner in a fortnight.
//
// It reads the bytes the fixup actually WRITES (running the real function on a
// synthetic qjsc.c), not a copy of them — a copy is the thing that drifts.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { defineGuard, guardTests } = require('./guard.cjs');

const repo = path.resolve(__dirname, '..');
const buildTjsSrc = fs.readFileSync(path.join(repo, 'scripts/build-tjs.mjs'), 'utf8');

// Brace-balanced extraction, same as test/tjs-bytecode-regen.test.cjs.
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start > -1, `function ${name} not found in build-tjs.mjs`);
  const braceStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

// The include block the fixup anchors on — verbatim from upstream txiki qjsc.c.
const QJSC_ANCHOR = '#include <assert.h>\n#include <errno.h>\n#include <inttypes.h>\n'
  + '#include <stdarg.h>\n#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\n';

function runFixup(fileContents) {
  const fn = new Function('fs', 'path', 'console',
    `${extractFunction(buildTjsSrc, 'fixupQjscMsvcGetopt')}; return fixupQjscMsvcGetopt;`)(
    fs, path, { log() {} });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qjsc-fixup-'));
  fs.mkdirSync(path.join(dir, 'src'));
  const f = path.join(dir, 'src/qjsc.c');
  fs.writeFileSync(f, fileContents);
  fn(dir);
  return { dir, out: fs.readFileSync(f, 'utf8') };
}

test('the fixup refuses a tree whose include anchor moved, instead of skipping', () => {
  assert.throws(() => runFixup('#include <stdio.h>\nint main(void){return 0;}\n'),
    /include anchor not found/,
    'a moved pin must fail loudly — a silent skip is the defect this guards');
});

test('the fixup is idempotent', () => {
  const { out } = runFixup(QJSC_ANCHOR);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qjsc-fixup2-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src/qjsc.c'), out);
  const fn = new Function('fs', 'path', 'console',
    `${extractFunction(buildTjsSrc, 'fixupQjscMsvcGetopt')}; return fixupQjscMsvcGetopt;`)(
    fs, path, { log() {} });
  fn(dir);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'src/qjsc.c'), 'utf8'), out);
});

// The shim's C, sliced out of what the fixup wrote.
function shimSource() {
  const { out } = runFixup(QJSC_ANCHOR);
  const begin = out.indexOf('/* ---- MSVC ships no getopt');
  assert.ok(begin > -1, 'shim marker comment missing from the fixup output');
  const end = out.indexOf('\n#endif\n', begin);
  assert.ok(end > -1, 'shim #endif missing from the fixup output');
  return out.slice(begin, end + '\n#endif\n'.length);
}

// qjsc's own option string (src/qjsc.c: getopt(argc, argv, "ho:p:n:ms")).
const OPTSTRING = 'ho:p:n:ms';
const MAIN = `
#include <stdio.h>
int main(int argc, char **argv) {
    int c;
    while ((c = getopt(argc, argv, "${OPTSTRING}")) != -1) {
        if (c == '?') printf("opt ?\\n");
        else printf("opt %c arg=%s\\n", c, optarg ? optarg : "(null)");
    }
    printf("optind=%d\\n", optind);
    for (int i = optind; i < argc; i++) printf("rest %s\\n", argv[i]);
    return 0;
}
`;

// Options strictly before operands. GNU getopt PERMUTES interleaved operands and
// BSD getopt does not, so an interleaved vector would diff by platform and prove
// nothing about the shim. qjsc is always invoked options-first (build-tjs.mjs
// passes -m -s -o OUT -n NAME -p PREFIX IN), so this is the surface that matters.
const VECTORS = [
  ['-m', '-s', '-o', 'out.c', '-n', 'name', '-p', 'pfx', 'in.js'],   // how build-tjs actually calls it
  ['-m', '-s', '-oout.c', '-nname', '-ppfx', 'in.js'],               // attached-argument form
  ['-ms', '-o', 'out.c', 'in.js'],                                   // clustered flags
  ['-mso', 'out.c', 'a.js', 'b.js'],                                 // cluster ending in an option that takes an argument
  ['-h'],
  ['in.js'],
  [],
  ['--', '-notanopt'],
  ['-z', 'in.js'],                                                   // unknown option
];

// A missing argument at the END of argv is the one case the platform getopts
// disagree on among THEMSELVES: BSD leaves optind past argc (measured: 3 for
// argc 2), glibc does not. Pinning the shim to whichever libc the test box has
// would make this test assert the runner, not the shim. What qjsc actually
// depends on is asserted instead: the scan terminates, reports '?', and leaves
// optind >= argc so `if (optind >= argc)` (src/qjsc.c:334) takes the usage path.
const DEGENERATE = [['-o'], ['-n'], ['-p']];


const CC = ['cc', 'clang', 'gcc'].find((c) => spawnSync(c, ['--version'], { stdio: 'ignore' }).status === 0);

test('shim getopt matches the platform getopt on qjsc\'s option string', { skip: CC ? false : 'no C compiler on PATH' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'getopt-diff-'));
  // The shim is _MSC_VER-guarded in the real tree; force it on so this box
  // compiles the same bytes cl.exe will.
  fs.writeFileSync(path.join(dir, 'shim.c'),
    `#define _MSC_VER 1\n#include <string.h>\n#include <stdlib.h>\n${shimSource()}${MAIN}`);
  // NOT <unistd.h>: glibc hides the POSIX getopt declarations under a strict
  // -std=c11 (no _POSIX_C_SOURCE), so ref.c compiled on darwin and failed on
  // ubuntu with "'optarg' undeclared" — the REFERENCE half of a differential
  // failing to build, which says nothing about the shim. Declaring the three
  // symbols directly takes the header's feature-test-macro rules out of it
  // entirely; they are ordinary libc globals on every POSIX host.
  fs.writeFileSync(path.join(dir, 'ref.c'),
    `#include <string.h>\n#include <stdlib.h>\n`
    + `extern char *optarg;\nextern int optind;\n`
    + `int getopt(int argc, char *const argv[], const char *optstring);\n${MAIN}`);
  for (const which of ['shim', 'ref']) {
    const r = spawnSync(CC, ['-std=c11', '-o', path.join(dir, which), path.join(dir, `${which}.c`)],
      { encoding: 'utf8' });
    assert.strictEqual(r.status, 0, `${which}.c failed to compile:\n${r.stderr}`);
  }
  // Windows' CRT writes "\n" as "\r\n". The strict comparisons below are immune
  // (both sides get the same treatment), which is exactly why the line endings
  // went unnoticed until the REGEX assertions ran on windows-latest and the
  // literal \n stopped matching. Normalise once, here.
  const stdout = (bin, argv) =>
    (spawnSync(path.join(dir, bin), argv, { encoding: 'utf8', timeout: 5000 }).stdout || '')
      .replace(/\r\n/g, '\n');
  for (const argv of VECTORS) {
    assert.strictEqual(stdout('shim', argv), stdout('ref', argv), `argv: ${JSON.stringify(argv)}`);
  }
  for (const argv of DEGENERATE) {
    const r = spawnSync(path.join(dir, 'shim'), argv, { encoding: 'utf8', timeout: 5000 });
    const out = (r.stdout || '').replace(/\r\n/g, '\n');
    assert.strictEqual(r.status, 0, `argv ${JSON.stringify(argv)}: did not terminate cleanly`);
    assert.match(out, /^opt \?\n/, `argv ${JSON.stringify(argv)}: expected a '?' report`);
    const optind = Number(out.match(/optind=(\d+)/)[1]);
    assert.ok(optind >= argv.length + 1,
      `argv ${JSON.stringify(argv)}: optind ${optind} < argc ${argv.length + 1} — qjsc would read past the options`);
  }
});

// PURE: `src` is the already-read build-tjs.mjs text.
function scanFixupRegistration({ src }) {
  const findings = [];
  let examined = 0;

  examined++;
  if (!/^\s*fixupQjscMsvcGetopt\(tjsDir\);$/m.test(src)) {
    findings.push('fixupQjscMsvcGetopt is defined but never called');
  }

  // The native regen path used to hardcode 'tjsc', so the moment the compile was
  // fixed it would throw "tjsc did not build" on Windows instead.
  examined++;
  const natives = [...src.matchAll(/path\.join\((?:hostB|b)uildDir, ([^)]*)\)/g)]
    .map((m) => m[1]).filter((a) => a.includes('tjsc'));
  if (natives.length !== 2) {
    findings.push(`expected 2 tjsc path.joins, got ${natives.length}`);
  } else {
    for (const a of natives) {
      if (!/win32.*tjsc\.exe/.test(a)) findings.push(`a tjsc path is missing the win32 .exe suffix: ${a}`);
    }
  }

  return { findings, examined };
}

const fixupRegistrationGuard = defineGuard({
  name: 'msvc-getopt-fixup-registration',
  read: () => ({ src: fs.readFileSync(path.join(repo, 'scripts/build-tjs.mjs'), 'utf8') }),
  scan: scanFixupRegistration,
  // I2 (coordinator, 2026-09-04): table-driven — two fixed markers checked in ONE named
  // build script. Floored at the exact measured count (2).
  floor: 2,
  control: () => ({ src: '// no fixup call, no tjsc path.joins here' }),
});
guardTests(fixupRegistrationGuard);
