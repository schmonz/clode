'use strict';
// GUARD: SHIPPED CODE TAKES ITS TEMP FILES FROM mkdtemp, NEVER A PID-NAMED PATH IN THE SHARED TEMP DIR.
//
// libexec had two styles (latent-capabilities audit, D9): fs.mkdtempSync directories, and files named
// `<os.tmpdir()>/clode-...-<pid>`. A pid-named path is predictable in a shared /tmp, so a symlink planted there first
// is followed by the writeFileSync; and one of them (clode-build's naude extras) was never removed, leaving a file
// behind per naude build. host-provision's zstd KAT, clode-update's changelog, clode-build's naude extras and
// bun-shim's heap snapshot now each write inside a directory of their own from mkdtemp and remove it.
//
// Not this rule: an atomic publish beside its target (`<target>.partial-<pid>` then rename, as naude-sea and
// clode-extract do) lives in a directory clode owns, and its name only has to differ from a concurrent writer's.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { defineGuard, guardTests } = require('./guard.cjs');
const { stripLineComments, discoverFilesByExt } = require('./source-scan.cjs');

const REPO = path.resolve(__dirname, '..');
const LIBEXEC = path.join(REPO, 'libexec');
// os.tmpdir() (or a tmpdir() alias) and process.pid in the same path expression.
const PID_IN_TMPDIR = /tmpdir\(\)[^;\n]{0,120}process\.pid/;

function readLibexecSources() {
  const files = discoverFilesByExt(LIBEXEC, ['.cjs', '.js', '.mjs']);
  return { sources: files.map((f) => ({ rel: path.relative(REPO, f).split(path.sep).join('/'), text: stripLineComments(fs.readFileSync(f, 'utf8')) })) };
}

function scanPidTempFiles({ sources }) {
  const findings = [];
  for (const s of sources) {
    s.text.split('\n').forEach((line, i) => {
      if (PID_IN_TMPDIR.test(line)) findings.push(`${s.rel}:${i + 1}: a pid-named path in the shared temp dir; take a directory from fs.mkdtempSync(path.join(os.tmpdir(), 'clode-<what>-')) and remove it when done`);
    });
  }
  return { findings, examined: sources.length };
}

// Measured 2026-11-27: 96 .cjs/.js/.mjs files under libexec (node_modules excluded).
guardTests(defineGuard({
  name: 'no-pid-temp-files',
  floor: 80,
  read: readLibexecSources,
  scan: scanPidTempFiles,
  // the defect as it was: clode-build.cjs's naude extras
  control: () => ({ sources: [{ rel: 'libexec/clode-build.cjs', text: 'const extrasPath = path.join(os.tmpdir(), `clode-naude-extras-${process.pid}.json`);' }] }),
}));

test('no-pid-temp-files: each old spelling is recognised, a mkdtemp directory is not', () => {
  for (const text of [
    'const tmp = path.join(os.tmpdir(), `clode-kat-zstd-${process.pid}.zst`);',
    'const cltmp = path.join(os.tmpdir(), `clode-changelog.${process.pid}`);',
    'const f = pathx.join(os.tmpdir(), `clode-heap-${process.pid}-${Date.now()}.heapsnapshot`);',
  ]) {
    const { findings } = scanPidTempFiles({ sources: [{ rel: 'synthetic.cjs', text }] });
    assert.strictEqual(findings.length, 1, text);
    assert.match(findings[0], /^synthetic\.cjs:1: a pid-named path/);
  }
  assert.deepStrictEqual(scanPidTempFiles({ sources: [{ rel: 'synthetic.cjs', text: "const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-heap-'));" }] }).findings, []);
});
