'use strict';
// Source-text + logic tests for build hermeticity (scripts/build-tjs.mjs):
// cmake must not resolve vendored deps through a third-party package-manager
// prefix (pkgsrc/Homebrew/MacPorts/Fink), and the built engine's dynamic
// deps must not land in one either. These run UNCONDITIONALLY, no build tree
// required — see .github/workflows/ci.yml:341 ("a skipped oracle is not a
// pass"). The house pattern (test/win-shim-guards.test.cjs, test/win-sync-
// guards.test.cjs) is grepping the real source so the test tracks the actual
// shipped behavior, not a reimplementation of it.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repo = path.join(__dirname, '..');
const buildTjsSrc = fs.readFileSync(path.join(repo, 'scripts/build-tjs.mjs'), 'utf8');

// ---- HALF 1: CMAKE_IGNORE_PREFIX_PATH, native builds only -----------------

test('build-tjs: pushes CMAKE_IGNORE_PREFIX_PATH with every package-manager prefix', () => {
  assert.match(buildTjsSrc, /CMAKE_IGNORE_PREFIX_PATH/);
  // Anchored to the actual PKG_MANAGER_ROOTS array literal (same pattern as
  // the denylist test below), NOT "appears anywhere in the file" — a naive
  // whole-file search passes even if the array itself is emptied, because
  // this file's own explanatory comments list all the prefixes in prose.
  // See PROOF below.
  const constStart = buildTjsSrc.indexOf('const PKG_MANAGER_ROOTS = [');
  assert.ok(constStart > -1, 'const PKG_MANAGER_ROOTS = [...] not found');
  const constEnd = buildTjsSrc.indexOf('\n', constStart);
  const constLine = buildTjsSrc.slice(constStart, constEnd);
  for (const prefix of ['/opt/pkg', '/opt/homebrew', '/usr/local', '/opt/local', '/sw', '/usr/pkg']) {
    assert.ok(constLine.includes(`'${prefix}'`),
      `expected ${prefix} in the PKG_MANAGER_ROOTS array literal, got: ${constLine}`);
  }
  // Also confirm the cmake push uses THIS constant (single source of truth
  // for both the cmake ignore-list and the post-build denylist below) —
  // not a second, independently-hand-copied list that could silently drift
  // (this is exactly how /usr/pkg went missing from the cmake half while
  // staying present in the dependency-check half, breaking native NetBSD).
  assert.match(buildTjsSrc, /cmakeArgs\.push\(`-DCMAKE_IGNORE_PREFIX_PATH=\$\{PKG_MANAGER_ROOTS\.join/,
    'the CMAKE_IGNORE_PREFIX_PATH push must read PKG_MANAGER_ROOTS, not a separate hardcoded list');
});

// PROOF that the test above is not a tautology: run it against a build-tjs.mjs
// text with PKG_MANAGER_ROOTS emptied to `[]`. If this fails to fail, the
// test above is worthless (it would also pass with the real protection
// deleted). See task-14-report.md for the actual node output of this block.
test('build-tjs: PROOF — the prefix-list test above actually fails against an emptied constant', () => {
  const emptied = buildTjsSrc.replace(
    /const PKG_MANAGER_ROOTS = \[[^\]]*\];/,
    'const PKG_MANAGER_ROOTS = [];',
  );
  assert.notStrictEqual(emptied, buildTjsSrc, 'the emptying replace must actually match something');
  const constStart = emptied.indexOf('const PKG_MANAGER_ROOTS = [');
  const constEnd = emptied.indexOf('\n', constStart);
  const constLine = emptied.slice(constStart, constEnd);
  let caught = null;
  try {
    for (const prefix of ['/opt/pkg', '/opt/homebrew', '/usr/local', '/opt/local', '/sw', '/usr/pkg']) {
      assert.ok(constLine.includes(`'${prefix}'`),
        `expected ${prefix} in the PKG_MANAGER_ROOTS array literal, got: ${constLine}`);
    }
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, 'the tightened assertion must throw when PKG_MANAGER_ROOTS is emptied — if it did not, it is a tautology again');
});

test('build-tjs: CMAKE_IGNORE_PREFIX_PATH is gated on !crossFile (native only)', () => {
  // The push must be inside an `if (!crossFile)` (or equivalent) so a cross
  // toolchain file — which already owns CMAKE_FIND_ROOT_PATH_MODE_* — is not
  // fought by a host-side ignore-list stacked on top of it.
  // Find the actual cmakeArgs.push(...) call (not just the first mention of
  // the flag's name, which also appears earlier in the explanatory comment).
  const idx = buildTjsSrc.indexOf('cmakeArgs.push(`-DCMAKE_IGNORE_PREFIX_PATH');
  assert.ok(idx > -1, 'cmakeArgs.push(...CMAKE_IGNORE_PREFIX_PATH...) not found');
  const before = buildTjsSrc.slice(Math.max(0, idx - 400), idx);
  assert.match(before, /if\s*\(\s*!crossFile\s*\)/,
    'CMAKE_IGNORE_PREFIX_PATH push must be guarded by !crossFile');
});

test('build-tjs: an old cmake (<3.23) does not silently skip the protection — it warns loudly', () => {
  // CMAKE_IGNORE_PREFIX_PATH requires cmake >= 3.23. The spec is explicit:
  // do not silently omit the protection on an old cmake — say so.
  assert.match(buildTjsSrc, /3\.23/);
  assert.match(buildTjsSrc, /predates|too old|unavailable/i);
});

// Behavioral: extract the ACTUAL cmakeVersionSupportsIgnorePrefixPath(major,
// minor) function out of build-tjs.mjs (brace-balanced, via extractFunction
// below — the same machinery already used for parseOtoolDeps/parseLddDeps)
// and run it directly, rather than hand-copying the comparison into the
// test. A hand copy tracks nothing: flipping `>= 23` to `< 23` (or `>` to
// `>=` on the major-version branch) in build-tjs.mjs would leave a
// hand-copied `gate` here green forever. This is defined as its own
// function declaration (not inline in the `if`) in build-tjs.mjs
// specifically so it can be extracted and exercised here.
test('build-tjs: version-gate arithmetic accepts 3.23+, rejects older', () => {
  const src = extractFunction(buildTjsSrc, 'cmakeVersionSupportsIgnorePrefixPath');
  // eslint-disable-next-line no-new-func
  const gate = new Function(`${src}\nreturn cmakeVersionSupportsIgnorePrefixPath;`)();
  assert.strictEqual(gate(3, 23), true);
  assert.strictEqual(gate(4, 0), true);
  assert.strictEqual(gate(3, 22), false);
  assert.strictEqual(gate(2, 8), false);
});

// ---- HALF 2: post-build dependency check -----------------------------------

test('build-tjs: hermeticity dependency check exists and is invoked after the build', () => {
  assert.match(buildTjsSrc, /function checkHermeticDeps/);
  assert.match(buildTjsSrc, /checkHermeticDeps\(path\.join\(outDir, outName\)\)/);
});

test('build-tjs: dependency check covers both otool (darwin) and ldd (ELF) paths', () => {
  assert.match(buildTjsSrc, /otool/);
  assert.match(buildTjsSrc, /-L['"]?,?\s*enginePath|['"]-L['"],\s*enginePath/);
  assert.match(buildTjsSrc, /\bldd\b/);
  assert.match(buildTjsSrc, /function parseOtoolDeps/);
  assert.match(buildTjsSrc, /function parseLddDeps/);
});

test('build-tjs: dependency check skips (not fails) for cross-built, Windows, and missing-tool', () => {
  const fnStart = buildTjsSrc.indexOf('function checkHermeticDeps');
  assert.ok(fnStart > -1);
  const fnEnd = buildTjsSrc.indexOf('\nfunction ', fnStart + 1) === -1
    ? buildTjsSrc.indexOf('\n// CLODE_TJS_SMOKE=off', fnStart)
    : buildTjsSrc.indexOf('\nfunction ', fnStart + 1);
  const fnSrc = buildTjsSrc.slice(fnStart, fnEnd > -1 ? fnEnd : undefined);
  assert.match(fnSrc, /crossFile/);
  assert.match(fnSrc, /SKIPPED/);
  assert.match(fnSrc, /win32/);
  assert.match(fnSrc, /catch/);
  // Skips must be loud (console.log/error), not silent returns.
  const skipCount = (fnSrc.match(/SKIPPED/g) || []).length;
  assert.ok(skipCount >= 3, `expected at least 3 SKIPPED notices (cross/win32/missing-tool), found ${skipCount}`);
});

test('build-tjs: dependency check FAILS loudly (throws) naming the library and prefix on a hit', () => {
  const fnStart = buildTjsSrc.indexOf('function checkHermeticDeps');
  const fnSrc = buildTjsSrc.slice(fnStart, buildTjsSrc.indexOf('\n// CLODE_TJS_SMOKE=off', fnStart));
  assert.match(fnSrc, /throw new Error/);
  assert.match(fnSrc, /CMAKE_IGNORE_PREFIX_PATH/); // points back at the fix
});

// ---- DENYLIST regression guard ---------------------------------------------
//
// This is the load-bearing test in this file. A previous attempt at this
// check used an ALLOWLIST of system prefixes (['/lib/', '/usr/lib/']) and was
// broken two ways:
//   - glibc's ldd emits `/lib64/ld-linux-x86-64.so.2`; that path does NOT
//     start with '/lib/' (it's /lib64, a sibling, not a child), so a good
//     dependency was flagged — would have failed native linux-x64-glibc.
//   - BSD ldd (FreeBSD/NetBSD/DragonFly) print the INSPECTED BINARY'S OWN
//     PATH as a header line first; a naive line-matcher captured that too —
//     would have failed freebsd-amd64/netbsd-amd64/dragonflybsd-amd64,
//     all publish:true legs.
// DO NOT "simplify" this back into an allowlist — that regresses both.
test('build-tjs: dependency check uses a DENYLIST of package-manager roots, not an allowlist', () => {
  assert.match(buildTjsSrc, /PKG_MANAGER_ROOTS/);
  // Regression guard for the actual broken shape (not just the word
  // "allowlist", which legitimately appears in this file's own explanatory
  // prose describing the bug it avoids): the matcher must walk the
  // package-manager denylist (`dep === root || dep.startsWith(root + '/')`),
  // never a bare hardcoded system-prefix test. The /lib64-vs-/lib and
  // BSD-header false positives an allowlist produces are exercised for real
  // against the shipped parseLddDeps below (glibc-style / BSD-style tests).
  assert.match(buildTjsSrc, /hitRoot[\s\S]{0,120}dep\.startsWith/);
  for (const root of ['/opt/pkg', '/opt/homebrew', '/opt/local', '/sw', '/usr/pkg', '/usr/local']) {
    assert.match(buildTjsSrc, new RegExp(`PKG_MANAGER_ROOTS[\\s\\S]{0,200}${root.replace(/\//g, '\\/')}`),
      `expected ${root} in PKG_MANAGER_ROOTS`);
  }
});

// ---- parser behavior, exercised directly against real-world ldd output ----
// (extracted verbatim from the source so the regression guard tracks the
// actual shipped parser, not a hand copy of its logic)

// Brace-balanced extraction (a plain non-greedy regex breaks the moment the
// function body contains its own `}`, e.g. inside `.filter(Boolean)`).
function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start > -1, `function ${name} not found in build-tjs.mjs`);
  const braceStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces extracting ${name}`);
}

function loadParsers() {
  // NOT vm.createContext: a separate vm context has its own Array/Object
  // realm, and node:assert's deepStrictEqual rejects cross-realm arrays as
  // "same structure but not reference-equal" even when the contents match.
  // `new Function` compiles in the CURRENT realm (this is trusted, local
  // test-only source — the exact text we just read from build-tjs.mjs — not
  // arbitrary input), so the returned arrays are ordinary same-realm arrays.
  const src = `${extractFunction(buildTjsSrc, 'parseOtoolDeps')}\n${extractFunction(buildTjsSrc, 'parseLddDeps')}`;
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${src}\nreturn { parseOtoolDeps, parseLddDeps };`);
  return factory();
}

// Derive PKG_MANAGER_ROOTS from the real array literal (not a hand copy) so
// the harness below tracks the shipped denylist, same principle as
// extractFunction/loadParsers above.
function extractPkgManagerRoots() {
  const m = buildTjsSrc.match(/const PKG_MANAGER_ROOTS = (\[[^\]]*\]);/);
  assert.ok(m, 'PKG_MANAGER_ROOTS array literal not found in build-tjs.mjs');
  // eslint-disable-next-line no-new-func
  return new Function(`return ${m[1]};`)();
}

// Load the REAL checkHermeticDeps (brace-balanced extraction, same as the
// parsers above) with its free variables (crossFile, wantStatic, process,
// runOut, console) supplied as injectable stubs, so MINOR-4/MINOR-5 style
// regressions (a wrong SKIPPED-vs-OK verdict) are caught by actually running
// the shipped function, not by re-describing its logic in prose.
function loadCheckHermeticDeps({ crossFile, wantStatic, platform, runOut, logs }) {
  const src = [
    extractFunction(buildTjsSrc, 'parseOtoolDeps'),
    extractFunction(buildTjsSrc, 'parseLddDeps'),
    extractFunction(buildTjsSrc, 'checkHermeticDeps'),
  ].join('\n');
  const processStub = { platform };
  const consoleStub = {
    log: (...args) => logs.push(args.join(' ')),
    error: (...args) => logs.push(args.join(' ')),
  };
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'crossFile', 'wantStatic', 'process', 'runOut', 'PKG_MANAGER_ROOTS', 'console',
    `${src}\nreturn checkHermeticDeps;`,
  );
  return factory(crossFile, wantStatic, processStub, runOut, extractPkgManagerRoots(), consoleStub);
}

// ---- MINOR 4: an unparseable-but-successful ldd run must not read as OK ----
test('checkHermeticDeps: OpenBSD-style ldd table (no name=>path lines) reports SKIPPED, not OK', () => {
  // Real OpenBSD ldd(1) output shape: a "Start End Type Open Ref GrpRef
  // Name" table, not glibc/BSD's "name => path" or bare "/path" lines.
  // parseLddDeps recognizes neither the header nor the data rows (the hex
  // addresses are the first token, not a path starting with '/'), so it
  // returns [] — which must NOT be reported as a verified-clean hermeticity
  // pass for openbsd-amd64/openbsd-arm64 (both publish:true).
  const openbsdTable = '        Start    End      Type  Open Ref GrpRef Name\n'
    + '00000000c1e0f000 00000000c1e2f000 exe   1    0   0    /usr/local/bin/tjs\n'
    + '00000000c1e00000 00000000c1e0e000 rlib  0    1   0    /usr/lib/libc.so.95.0\n';
  const logs = [];
  const check = loadCheckHermeticDeps({
    crossFile: null,
    wantStatic: false,
    platform: 'openbsd',
    runOut: () => openbsdTable,
    logs,
  });
  assert.doesNotThrow(() => check('/usr/local/bin/tjs'));
  const joined = logs.join('\n');
  console.log('OpenBSD-table harness log:', joined);
  assert.match(joined, /SKIPPED/);
  assert.doesNotMatch(joined, /OK —/);
});

// ---- MINOR 5: static builds must short-circuit BEFORE otool/ldd, with an --
// ---- accurate message, not fall into the "tool unavailable" catch --------
test('checkHermeticDeps: a static build reports "static link" and never invokes ldd/otool', () => {
  const logs = [];
  let runOutCalled = false;
  const check = loadCheckHermeticDeps({
    crossFile: null,
    wantStatic: true,
    platform: 'linux',
    runOut: () => { runOutCalled = true; return ''; },
    logs,
  });
  assert.doesNotThrow(() => check('/build/tjs-musl/tjs'));
  assert.strictEqual(runOutCalled, false, 'a static build must not shell out to ldd/otool at all');
  const joined = logs.join('\n');
  console.log('static-build harness log:', joined);
  assert.match(joined, /static link/);
  assert.doesNotMatch(joined, /unavailable or failed to run/,
    'static builds must not print the misleading "ldd unavailable or failed to run" catch message');
});

test('parseLddDeps: glibc-style output (linux-vdso + /lib64 dynamic linker) is not flagged', () => {
  const { parseLddDeps } = loadParsers();
  const out = '\tlinux-vdso.so.1 (0x00007ffd12345000)\n'
    + '\t/lib64/ld-linux-x86-64.so.2 (0x00007f0000000000)\n'
    + '\tlibc.so.6 => /lib/x86_64-linux-gnu/libc.so.6 (0x00007f0000100000)\n';
  const deps = parseLddDeps(out, '/some/build/tjs/linux-glibc-x64/tjs');
  console.log('glibc ldd sanity: parsed deps =', JSON.stringify(deps));
  assert.deepStrictEqual(deps, ['/lib64/ld-linux-x86-64.so.2', '/lib/x86_64-linux-gnu/libc.so.6']);
  const PKG_MANAGER_ROOTS = ['/opt/pkg', '/opt/homebrew', '/opt/local', '/sw', '/usr/pkg', '/usr/local'];
  const flagged = deps.filter((d) => PKG_MANAGER_ROOTS.some((r) => d === r || d.startsWith(`${r}/`)));
  assert.deepStrictEqual(flagged, [], 'glibc dynamic linker / libc must not be flagged');
});

test('parseLddDeps: BSD-style header line for a binary living under /usr/local is not flagged', () => {
  const { parseLddDeps } = loadParsers();
  const out = '/usr/local/bin/tjs:\n\tlibc.so.7 => /lib/libc.so.7 (0x800600000)\n';
  const deps = parseLddDeps(out, '/usr/local/bin/tjs');
  console.log('BSD ldd sanity: parsed deps =', JSON.stringify(deps));
  assert.deepStrictEqual(deps, ['/lib/libc.so.7']);
  const PKG_MANAGER_ROOTS = ['/opt/pkg', '/opt/homebrew', '/opt/local', '/sw', '/usr/pkg', '/usr/local'];
  const flagged = deps.filter((d) => PKG_MANAGER_ROOTS.some((r) => d === r || d.startsWith(`${r}/`)));
  assert.deepStrictEqual(flagged, [], 'the binary\'s own /usr/local header line must not be flagged as a dependency');
});

test('parseLddDeps: a real /usr/local dependency IS flagged (the check still catches real hits)', () => {
  const { parseLddDeps } = loadParsers();
  const out = '\tlibffi.so.8 => /usr/local/lib/libffi.so.8 (0x00007f0000200000)\n';
  const deps = parseLddDeps(out, '/some/build/tjs/linux-x64/tjs');
  const PKG_MANAGER_ROOTS = ['/opt/pkg', '/opt/homebrew', '/opt/local', '/sw', '/usr/pkg', '/usr/local'];
  const flagged = deps.filter((d) => PKG_MANAGER_ROOTS.some((r) => d === r || d.startsWith(`${r}/`)));
  assert.deepStrictEqual(flagged, ['/usr/local/lib/libffi.so.8']);
});

test('parseOtoolDeps: skips the self-path header, flags a real /opt/pkg hit', () => {
  const { parseOtoolDeps } = loadParsers();
  const out = '/Users/x/clode/build/tjs/macos-26-arm64/tjs:\n'
    + '\t/opt/pkg/lib/libffi.8.dylib (compatibility version 8.0.0, current version 8.1.0)\n'
    + '\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1345.0.0)\n';
  const deps = parseOtoolDeps(out);
  assert.deepStrictEqual(deps, ['/opt/pkg/lib/libffi.8.dylib', '/usr/lib/libSystem.B.dylib']);
  const PKG_MANAGER_ROOTS = ['/opt/pkg', '/opt/homebrew', '/opt/local', '/sw', '/usr/pkg', '/usr/local'];
  const flagged = deps.filter((d) => PKG_MANAGER_ROOTS.some((r) => d === r || d.startsWith(`${r}/`)));
  assert.deepStrictEqual(flagged, ['/opt/pkg/lib/libffi.8.dylib']);
});

// ---- optional: a locally built engine, if one exists ----------------------

test('local engine (if built): dynamic deps contain no package-manager paths', () => {
  const { tjsBin } = require(path.join(repo, 'scripts/platform-tag.cjs'));
  let enginePath;
  try {
    enginePath = tjsBin(repo);
  } catch {
    console.log('local engine check: SKIPPED (platform-tag could not resolve a local engine path on this host)');
    return;
  }
  if (!enginePath || !fs.existsSync(enginePath)) {
    console.log(`local engine check: SKIPPED (no local engine built at ${enginePath || '<unresolved>'})`);
    return;
  }
  const PKG_MANAGER_ROOTS = ['/opt/pkg', '/opt/homebrew', '/opt/local', '/sw', '/usr/pkg', '/usr/local'];
  let out;
  const tool = process.platform === 'darwin' ? 'otool' : 'ldd';
  try {
    out = process.platform === 'darwin'
      ? execFileSync('otool', ['-L', enginePath], { encoding: 'utf8' })
      : execFileSync('ldd', [enginePath], { encoding: 'utf8' });
  } catch (e) {
    console.log(`local engine check: SKIPPED (${tool} unavailable or failed: ${e.message})`);
    return;
  }
  const { parseOtoolDeps, parseLddDeps } = loadParsers();
  const deps = process.platform === 'darwin' ? parseOtoolDeps(out) : parseLddDeps(out, enginePath);
  const flagged = deps.filter((d) => PKG_MANAGER_ROOTS.some((r) => d === r || d.startsWith(`${r}/`)));
  assert.deepStrictEqual(flagged, [],
    `local engine at ${enginePath} links a package-manager dependency: ${flagged.join(', ')}`);
});
