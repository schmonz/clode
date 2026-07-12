'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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

test('loader P: POSIX behavior unchanged', () => {
  const { P, IS_WIN } = loadP({ win: false, cwd: '/proj' });
  assert.equal(IS_WIN, false);
  assert.equal(P.isAbs('/a/b'), true);
  assert.equal(P.isAbs('a/b'), false);
  assert.equal(P.resolve('/a/b/loader.cjs'), '/a/b/loader.cjs');
  assert.equal(P.dirname('/a/b/loader.cjs'), '/a/b');
  assert.equal(P.join('/a/b', 'modules'), '/a/b/modules');
});

const cpSrc = fs.readFileSync(
  path.join(__dirname, '..', 'libexec/node-shim/modules/child_process.cjs'), 'utf8');

test('child_process: resolveExe probes PATHEXT and splits PATH on ; on win32', () => {
  assert.match(cpSrc, /PATHEXT/);
  assert.match(cpSrc, /CP_IS_WIN\s*\?\s*';'\s*:\s*':'/);
});
test('child_process: shell-mode uses cmd.exe /d /s /c on win32', () => {
  assert.match(cpSrc, /ComSpec/);
  assert.match(cpSrc, /\/d \/s \/c/);
});
test('child_process: win32 exe-resolution recognizes backslash/drive as pathed', () => {
  assert.match(cpSrc, /\[a-zA-Z\]:/);
});

const osSrc = fs.readFileSync(path.join(__dirname, '..', 'libexec/node-shim/modules/os.cjs'), 'utf8');
const procSrc = fs.readFileSync(path.join(__dirname, '..', 'libexec/node-shim/modules/process.cjs'), 'utf8');

test('os.EOL is CRLF on win32', () => {
  assert.match(osSrc, /EOL:.*win32.*\\r\\n/);
});
test('process.arch derives x64 on win32 (scoped, documented gap)', () => {
  assert.match(procSrc, /arch:.*win32.*x64/);
});
test('process.execPath uses tjs.exePath', () => {
  assert.match(procSrc, /execPath:\s*tjs\.exePath/);
});

const urlSrc = fs.readFileSync(
  path.join(__dirname, '..', 'libexec/node-shim/modules/url.cjs'), 'utf8');
test('url.pathToFileURL handles Windows drive paths', () => {
  assert.match(urlSrc, /replace\(\/\\\\\/g, ?'\/'\)/);
  assert.match(urlSrc, /\[a-zA-Z\]:\$/);
});

const loaderSrc2 = fs.readFileSync(path.join(__dirname, '..', 'libexec/node-shim/loader.cjs'), 'utf8');
test('loader splits NODE_PATH on the platform delimiter', () => {
  assert.match(loaderSrc2, /NODE_PATH_DELIM\s*=\s*IS_WIN\s*\?\s*';'\s*:\s*':'/);
  assert.doesNotMatch(loaderSrc2, /process\.env\.NODE_PATH \|\| ''\)\.split\(':'\)/);
});

const fsSrc = fs.readFileSync(path.join(__dirname, '..', 'libexec/node-shim/modules/fs.cjs'), 'utf8');
test('fs.mkdirSync recursive walk is separator-aware (win32-safe)', () => {
  assert.match(fsSrc, /split\(\/\[\\\\\/\]\/\)/);
  assert.doesNotMatch(fsSrc, /path\.resolve\(p\)\.split\('\/'\)/);
});

const fuseSrc = fs.readFileSync(path.join(__dirname, '..', 'libexec/clode-fuse.cjs'), 'utf8');

test('clode-fuse: default --out gets .exe on win32', () => {
  // the default (no --out) appends .exe on Windows: quaude -> quaude.exe
  assert.match(fuseSrc, /win32['"]?\s*\?\s*['"]\.exe['"]\s*:\s*['"]['"]/);
});
test('clode-fuse: the materialized template is named .exe on win32', () => {
  assert.match(fuseSrc, /template-tjs\.exe/);
});

const buildTjsSrc = fs.readFileSync(path.join(__dirname, '..', 'scripts/build-tjs.mjs'), 'utf8');

test('build-tjs: CLODE_TJS_WIN_MINGW selects Ninja + mingw gcc', () => {
  assert.match(buildTjsSrc, /CLODE_TJS_WIN_MINGW/);
  assert.match(buildTjsSrc, /-G['"]?,?\s*['"]Ninja['"]/);
  assert.match(buildTjsSrc, /CMAKE_C_COMPILER=gcc/);
});
test('build-tjs: win-mingw and cross-file are mutually exclusive', () => {
  assert.match(buildTjsSrc, /CLODE_TJS_WIN_MINGW[\s\S]{0,200}crossFile[\s\S]{0,80}throw|crossFile[\s\S]{0,80}CLODE_TJS_WIN_MINGW[\s\S]{0,80}throw/);
});
