'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { defineGuard, guardTests } = require('./guard.cjs');

const loaderSrc = fs.readFileSync(
  path.join(__dirname, '..', 'libexec/node-shim/loader.cjs'), 'utf8');

// Extract the marker-delimited path-helper block and eval it with a mocked
// Windows `navigator` + `tjs`, so we test the REAL loader source in isolation.
function loadP({ win, cwd }) {
  const m = loaderSrc.match(/\/\* @loader-paths-start \*\/([\s\S]*?)\/\* @loader-paths-end \*\//);
  assert.ok(m, 'loader-paths markers must exist');
  const navigator = win ? { userAgentData: { platform: 'Windows' } } : { userAgentData: { platform: 'macOS' } };
  const tjs = { cwd };
  const sandbox = { navigator, tjs, module: { exports: {} } };
  vm.createContext(sandbox);
  vm.runInContext(m[1] + '\nmodule.exports = { P, IS_WIN };', sandbox);
  return sandbox.module.exports;
}

test('loader P: Windows drive path is absolute and preserved', () => {
  const { P, IS_WIN } = loadP({ win: true, cwd: 'C:\\proj' });
  assert.equal(IS_WIN, true);
  assert.equal(P.isAbs('C:\\Users\\x'), true);
  assert.equal(P.isAbs('\\\\srv\\share'), true);
  assert.equal(P.resolve('C:\\a\\b\\loader.cjs'), 'C:/a/b/loader.cjs');
  assert.equal(P.dirname('C:\\a\\b\\loader.cjs'), 'C:/a/b');
  assert.equal(P.join('C:\\a\\b', 'modules'), 'C:/a/b/modules');
});

test('loader P: Windows UNC path preserves the \\\\server\\share root', () => {
  // A \\server\share (\\wsl.localhost\...) checkout must keep its TWO-slash root
  // through normalize/join, or the shim resolves its own modules to a bogus
  // single-slash path and every builtin walls (observed as a boot stack overflow
  // via the wallProxy). Regression guard for the UNC dev-box wall.
  const { P } = loadP({ win: true, cwd: '\\\\wsl.localhost\\Ubuntu' });
  assert.equal(P.normalize('//wsl.localhost/Ubuntu/x/loader.cjs'), '//wsl.localhost/Ubuntu/x/loader.cjs');
  assert.equal(P.resolve('\\\\wsl.localhost\\Ubuntu\\a\\loader.cjs'), '//wsl.localhost/Ubuntu/a/loader.cjs');
  assert.equal(P.dirname('//wsl.localhost/Ubuntu/a/loader.cjs'), '//wsl.localhost/Ubuntu/a');
  assert.equal(P.join('//wsl.localhost/Ubuntu/a/node-shim', 'modules'), '//wsl.localhost/Ubuntu/a/node-shim/modules');
});

test('loader P: POSIX behavior unchanged', () => {
  const { P, IS_WIN } = loadP({ win: false, cwd: '/proj' });
  assert.equal(IS_WIN, false);
  assert.equal(P.isAbs('/a/b'), true);
  assert.equal(P.isAbs('a/b'), false);
  assert.equal(P.resolve('/a/b/loader.cjs'), '/a/b/loader.cjs');
  assert.equal(P.dirname('/a/b/loader.cjs'), '/a/b');
  assert.equal(P.join('/a/b', 'modules'), '/a/b/modules');
});

// --- the rest: pure presence/absence regex checks against real shim/build sources ---
//
// Folded into one guard: each of these used to be its own bare assert.match/
// assert.doesNotMatch test with no positive control — a pattern that silently
// stopped matching (a rename, a refactor) would read as "passing" the same as
// a genuinely-guarded feature.
const CHECKS = [
  ['cpSrc', /PATHEXT/, 'match', 'child_process: resolveExe probes PATHEXT'],
  ['cpSrc', /CP_IS_WIN\s*\?\s*';'\s*:\s*':'/, 'match', 'child_process: PATH split on ; on win32'],
  ['cpSrc', /ComSpec/, 'match', 'child_process: shell-mode consults ComSpec'],
  ['cpSrc', /\/d \/s \/c/, 'match', 'child_process: shell-mode uses cmd.exe /d /s /c'],
  ['cpSrc', /\[a-zA-Z\]:/, 'match', 'child_process: win32 exe-resolution recognizes drive letters'],
  ['osSrc', /EOL:.*win32.*\\r\\n/, 'match', 'os.EOL is CRLF on win32'],
  ['procSrc', /get arch\(\).*win32.*winArch\(\)/, 'match', 'process.arch derives honest arch on win32'],
  ['procSrc', /PROCESSOR_ARCHITECTURE/, 'match', 'process.arch reads PROCESSOR_ARCHITECTURE'],
  ['procSrc', /execPath:\s*tjs\.exePath/, 'match', 'process.execPath uses tjs.exePath'],
  ['urlSrc', /replace\(\/\\\\\/g, ?'\/'\)/, 'match', 'url.pathToFileURL normalizes backslashes'],
  ['urlSrc', /\[a-zA-Z\]:\$/, 'match', 'url.pathToFileURL recognizes drive-letter paths'],
  ['loaderSrc2', /NODE_PATH_DELIM\s*=\s*IS_WIN\s*\?\s*';'\s*:\s*':'/, 'match', 'loader splits NODE_PATH on the platform delimiter'],
  ['loaderSrc2', /process\.env\.NODE_PATH \|\| ''\)\.split\(':'\)/, 'notMatch', 'loader must not hardcode POSIX-only NODE_PATH splitting'],
  ['fsSrc', /split\(\/\[\\\\\/\]\/\)/, 'match', 'fs.mkdirSync recursive walk is separator-aware'],
  ['fsSrc', /path\.resolve\(p\)\.split\('\/'\)/, 'notMatch', 'fs.mkdirSync must not hardcode a POSIX-only split'],
  ['fuseSrc', /template-tjs\.exe/, 'match', 'clode-fuse: the materialized template is named .exe on win32'],
  ['buildTjsSrc', /CLODE_TJS_WIN_MINGW/, 'match', 'build-tjs: CLODE_TJS_WIN_MINGW selects mingw'],
  ['buildTjsSrc', /-G['"]?,?\s*['"]Ninja['"]/, 'match', 'build-tjs: mingw path selects Ninja'],
  ['buildTjsSrc', /CMAKE_C_COMPILER=gcc/, 'match', 'build-tjs: mingw path selects gcc'],
  ['buildTjsSrc', /winMsvc\s*=\s*!winMingw\s*&&\s*!crossFile\s*&&\s*\(process\.platform === 'win32'/, 'match', 'build-tjs: win32 defaults to MSVC'],
  ['buildTjsSrc', /CLODE_TJS_WIN_MINGW[\s\S]{0,200}crossFile[\s\S]{0,80}throw|crossFile[\s\S]{0,80}CLODE_TJS_WIN_MINGW[\s\S]{0,80}throw/, 'match', 'build-tjs: mingw excludes cross'],
  ['buildTjsSrc', /CLODE_TJS_WIN_MSVC is exclusive with/, 'match', 'build-tjs: MSVC opt-in names its exclusions'],
  ['buildTjsSrc', /CLODE_TJS_WIN_MSVC === '1'\s*&&\s*\(crossFile\s*\|\|\s*winMingw\)/, 'match', 'build-tjs: MSVC excludes cross/mingw'],
];

// PURE: `sources` maps each key above to its already-read text.
function scanWinShimGuards({ sources }) {
  const findings = [];
  let examined = 0;
  for (const [key, re, expect, label] of CHECKS) {
    examined++;
    const hit = re.test(sources[key]);
    if (expect === 'match' && !hit) findings.push(`${label} — pattern not found in ${key}`);
    if (expect === 'notMatch' && hit) findings.push(`${label} — forbidden pattern found in ${key}`);
  }
  return { findings, examined };
}

const guard = defineGuard({
  name: 'win-shim-guards',
  read: () => ({
    sources: {
      cpSrc: fs.readFileSync(path.join(__dirname, '..', 'libexec/node-shim/modules/child_process.cjs'), 'utf8'),
      osSrc: fs.readFileSync(path.join(__dirname, '..', 'libexec/node-shim/modules/os.cjs'), 'utf8'),
      procSrc: fs.readFileSync(path.join(__dirname, '..', 'libexec/node-shim/modules/process.cjs'), 'utf8'),
      urlSrc: fs.readFileSync(path.join(__dirname, '..', 'libexec/node-shim/modules/url.cjs'), 'utf8'),
      loaderSrc2: fs.readFileSync(path.join(__dirname, '..', 'libexec/node-shim/loader.cjs'), 'utf8'),
      fsSrc: fs.readFileSync(path.join(__dirname, '..', 'libexec/node-shim/modules/fs.cjs'), 'utf8'),
      fuseSrc: fs.readFileSync(path.join(__dirname, '..', 'libexec/clode-fuse.cjs'), 'utf8'),
      buildTjsSrc: fs.readFileSync(path.join(__dirname, '..', 'scripts/build-tjs.mjs'), 'utf8'),
    },
  }),
  scan: scanWinShimGuards,
  // Models both directions: every "must be present" pattern gone, and the
  // "must be absent" POSIX-only hardcodes reintroduced.
  control: () => ({
    sources: {
      cpSrc: '// nothing win32-specific here',
      osSrc: '// nothing win32-specific here',
      procSrc: '// nothing win32-specific here',
      urlSrc: '// nothing win32-specific here',
      loaderSrc2: "(process.env.NODE_PATH || '').split(':')",
      fsSrc: "path.resolve(p).split('/')",
      fuseSrc: '// no windows template naming here',
      buildTjsSrc: '// no windows compiler selection here',
    },
  }),
});
guardTests(guard);

const { resolveBuildOut } = require(path.join(__dirname, '..', 'libexec/clode-fuse.cjs'));

test('clode-fuse: a windows target output ends in .exe (default and explicit --out)', () => {
  // Behavioral (was a source-grep for the old inline `win32 ? '.exe'`): the .exe
  // now follows the TARGET, and an explicit --out gains it too.
  assert.strictEqual(resolveBuildOut({ out: null, target: 'windows-amd64', self: false, hostPlatform: 'linux' }), 'quaude.exe');
  assert.strictEqual(resolveBuildOut({ out: null, target: null, self: false, hostPlatform: 'win32' }), 'quaude.exe'); // native windows host
  assert.strictEqual(resolveBuildOut({ out: 'quaude-windows-amd64', target: 'windows-amd64', self: false, hostPlatform: 'linux' }), 'quaude-windows-amd64.exe');
  assert.strictEqual(resolveBuildOut({ out: null, target: 'linux-x64', self: false, hostPlatform: 'win32' }), 'quaude'); // non-windows target: no .exe
});
