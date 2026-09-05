'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { defineGuard, guardTests } = require('./guard.cjs');

const REPO = path.join(__dirname, '..');

// PURE: the '+'-added body of a unified diff, stripped of its leading '+'.
function addedLines(patch) {
  return patch.split('\n').filter((l) => l.startsWith('+')).map((l) => l.slice(1)).join('\n');
}

const FS_CHECKS = [
  [/#if defined\(_WIN32\)[\s\S]*_fullpath/, 'realpath has a _WIN32 branch using _fullpath'],
  [/_lseeki64/, 'pread/pwrite have a _WIN32 branch using _lseeki64'],
  [/defined\(_WIN32\)[\s\S]*?FSS_PATH_STAT\(lstat, stat\)/, 'lstat degrades to stat on _WIN32'],
  [/ENOSYS/, 'readlink/symlink return ENOSYS on _WIN32'],
  [/#\s*ifndef O_NONBLOCK[\s\S]*#\s*define O_NONBLOCK 0/, 'O_NONBLOCK defined to 0 on _WIN32'],
  [/#\s*ifndef PATH_MAX[\s\S]*#\s*define PATH_MAX 4096/, 'PATH_MAX fallback present'],
  [/#\s*ifndef S_ISLNK/, 'S_ISLNK guarded'],
  [/_mkdir\(p\)/, 'mkdir arity guarded for _WIN32'],
  [/oflags \|= O_BINARY/, 'open forces O_BINARY on _WIN32'],
];

const SPAWN_CHECKS = [
  [/#if !defined\(_WIN32\)[\s\S]*#include <poll\.h>/, 'POSIX includes guarded under !_WIN32'],
  [/#if defined\(_WIN32\)[\s\S]*#include <windows\.h>/, 'Windows twin includes windows.h'],
  [/CreateProcessA?\(/, 'Windows path uses CreateProcess'],
  [/FILE_FLAG_OVERLAPPED/, 'Windows drain uses overlapped ReadFile'],
  [/WaitForMultipleObjects/, 'Windows drain uses WaitForMultipleObjects'],
  [/ERROR_FILE_NOT_FOUND[\s\S]*ENOENT/, 'missing exe maps to ENOENT'],
  [/__tjs_spawn_sync/, 'shared init exposes __tjs_spawn_sync (unguarded)'],
];

// PURE: `patches` carries the raw text of both patch files; `buildTjsSrc` the
// driver script. scan() derives the added-lines views itself — deterministic,
// no I/O — so a control can hand it plain strings.
function scanWinSyncGuards({ fsPatch, spawnPatch, buildTjsSrc }) {
  const findings = [];
  let examined = 0;

  const fsAdded = addedLines(fsPatch);
  for (const [re, label] of FS_CHECKS) {
    examined++;
    if (!re.test(fsAdded)) findings.push(`txiki-sync-fs.patch: ${label} — pattern not found`);
  }

  const spawnAdded = addedLines(spawnPatch);
  for (const [re, label] of SPAWN_CHECKS) {
    examined++;
    if (!re.test(spawnAdded)) findings.push(`txiki-sync-spawn.patch: ${label} — pattern not found`);
  }

  examined++;
  if (/CLODE_TJS_STUB_SYNC/.test(buildTjsSrc)) findings.push('build-tjs.mjs: CLODE_TJS_STUB_SYNC must be gone (Phase-0 sync stub not fully retired)');
  examined++;
  if (/fixupStubSyncPrimitives/.test(buildTjsSrc)) findings.push('build-tjs.mjs: fixupStubSyncPrimitives must be gone (Phase-0 sync stub not fully retired)');

  return { findings, examined };
}

const guard = defineGuard({
  name: 'win-sync-guards',
  // FS_CHECKS (9) + SPAWN_CHECKS (7) + 2 build-tjs.mjs checks = 18, fixed by the
  // literal tables above; floor 17 (one under) fires the moment either table
  // silently loses an entry, instead of only catching total blindness.
  floor: 17,
  read: () => ({
    fsPatch: fs.readFileSync(path.join(REPO, 'spike/quickjs/patches/txiki-sync-fs.patch'), 'utf8'),
    spawnPatch: fs.readFileSync(path.join(REPO, 'spike/quickjs/patches/txiki-sync-spawn.patch'), 'utf8'),
    buildTjsSrc: fs.readFileSync(path.join(REPO, 'scripts/build-tjs.mjs'), 'utf8'),
  }),
  scan: scanWinSyncGuards,
  // Models both directions of drift at once: every Windows-sync pattern
  // missing from a gutted patch, AND the retired Phase-0 stub reappearing.
  control: () => ({
    fsPatch: '--- a/x\n+++ b/x\n+nothing relevant\n',
    spawnPatch: '--- a/y\n+++ b/y\n+nothing relevant either\n',
    buildTjsSrc: 'const x = CLODE_TJS_STUB_SYNC; fixupStubSyncPrimitives();',
  }),
});
guardTests(guard);
