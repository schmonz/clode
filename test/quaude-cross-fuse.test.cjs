'use strict';
// Cross-fuse (CLODE_TARGET_TEMPLATE) characterization: `clode build` appends a
// valid trailer stack onto a FOREIGN base and skips the host smoke. Proven
// locally (byte-append on the host) — a stand-in foreign base (a copy of the
// host tjs named tjs.exe) exercises the cross path; the real PE base + self-load
// is CI (the windows-amd64 leg's exec=host native fuse + PONG). Layout per quaude-bootstrap.mjs:
// [base][members][index JSON][QAUDEv0 footer 32B][bootstrap bc][tx1k1.js 12B].
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tjsPath } = require('./node-shim-helper.cjs');
const { readTrailerIndex } = require('./quaude-archive.cjs');

const REPO = path.join(__dirname, '..');
const ENTRY = path.join(REPO, 'bin', 'clode');

function stageMainBundle() {
  // Newest build/*/clode-main.bundle.cjs — generic scan (typically finds the
  // single unkeyed build/bundle/ copy; see scripts/platform-tag.cjs's file
  // header), same fallback as test/clode-native.test.cjs.
  const buildDir = path.join(REPO, 'build');
  let tags = [];
  try { tags = fs.readdirSync(buildDir); } catch { return null; }
  let newest = null;
  for (const d of tags) {
    const c = path.join(buildDir, d, 'clode-main.bundle.cjs');
    try { const m = fs.statSync(c).mtimeMs; if (!newest || m > newest.m) newest = { c, m }; } catch { /* */ }
  }
  return newest && newest.c;
}

let SKIP = null, DIR = null, OUT = null, BUILD = null;
before(() => {
  if (!tjsPath()) { SKIP = 'no tjs binary (CLODE_TJS or build/tjs/tjs)'; return; }
  const bundle = stageMainBundle();
  if (!bundle) { SKIP = 'no esbuilt clode-main bundle (run node scripts/build-clode-main.mjs)'; return; }
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'xfuse-'));
  const foreign = path.join(DIR, 'tjs.exe');           // foreign-base stand-in
  fs.copyFileSync(tjsPath(), foreign);
  OUT = path.join(DIR, 'quaude.exe');
  BUILD = spawnSync(process.execPath, [ENTRY, 'build', '--self', '--out', OUT], {
    encoding: 'utf8', timeout: 300000,
    env: {
      ...process.env, CLODE_TJS: tjsPath(), CLODE_TARGET_TEMPLATE: foreign, CLODE_MAIN_BUNDLE: bundle,
      // No per-file CLODE_STATE_ROOT: this env spreads `...process.env`, so
      // test/run.mjs's single, central CLODE_STATE_ROOT already covers the
      // build-trace.jsonl append clodeBuild's finally makes (Task 5).
      DYLD_INSERT_LIBRARIES: '',
    },
  });
});
after(() => { if (DIR) { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } } });

test('cross-fuse succeeds and reports "smoke on the target" (host smoke skipped)', (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  assert.strictEqual(BUILD.status, 0, `cross-fuse failed:\n${BUILD.stdout}\n${BUILD.stderr}`);
  assert.match(BUILD.stdout, /cross-fused .*— smoke on the target/, `stdout:\n${BUILD.stdout}`);
});

test('cross-fused output carries a valid trailer stack over the foreign base', (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  const { names } = readTrailerIndex(OUT);
  assert.ok(names.includes('manifest.json'), `index lacks manifest.json: ${names.join(',')}`);
  assert.ok(names.includes('node-shim/loader.cjs'), `index lacks node-shim/loader.cjs: ${names.join(',')}`);
  assert.ok(names.includes('libexec/host-provision.cjs'),
    `host-provision.cjs must ride in the builder-role fuse so a self-fused clode-native can re-fuse targets that provision host tools: ${names.join(',')}`);
});

test('cross-fused output keeps its .exe name and a nonzero size', (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  assert.ok(OUT.endsWith('.exe'));
  assert.ok(fs.statSync(OUT).size > 1024 * 1024, 'cross-fused output implausibly small');
});
