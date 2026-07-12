const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const patch = fs.readFileSync(
  path.join(__dirname, '..', 'spike/quickjs/patches/txiki-sync-fs.patch'), 'utf8');
// The audit reads the '+'-added body of the patch (strip the leading '+').
const added = patch.split('\n').filter((l) => l.startsWith('+')).map((l) => l.slice(1)).join('\n');

test('fs-sync: realpath has a _WIN32 branch using _fullpath', () => {
  assert.match(added, /#if defined\(_WIN32\)[\s\S]*_fullpath/);
});
test('fs-sync: pread/pwrite have a _WIN32 branch using _lseeki64', () => {
  assert.match(added, /_lseeki64/);
});
test('fs-sync: lstat degrades to stat on _WIN32', () => {
  assert.match(added, /defined\(_WIN32\)[\s\S]*?FSS_PATH_STAT\(lstat, stat\)/);
});
test('fs-sync: readlink/symlink return ENOSYS on _WIN32', () => {
  assert.match(added, /ENOSYS/);
});
test('fs-sync: O_NONBLOCK defined to 0 on _WIN32', () => {
  assert.match(added, /#\s*ifndef O_NONBLOCK[\s\S]*#\s*define O_NONBLOCK 0/);
});
test('fs-sync: PATH_MAX fallback present', () => {
  assert.match(added, /#\s*ifndef PATH_MAX[\s\S]*#\s*define PATH_MAX 4096/);
});
test('fs-sync: S_ISLNK guarded', () => {
  assert.match(added, /#\s*ifndef S_ISLNK/);
});
test('fs-sync: mkdir arity guarded for _WIN32', () => {
  assert.match(added, /_mkdir\(p\)/);
});
test('fs-sync: open forces O_BINARY on _WIN32', () => {
  assert.match(added, /oflags \|= O_BINARY/);
});

const spawnPatch = fs.readFileSync(
  path.join(__dirname, '..', 'spike/quickjs/patches/txiki-sync-spawn.patch'), 'utf8');
const spawnAdded = spawnPatch.split('\n').filter((l) => l.startsWith('+')).map((l) => l.slice(1)).join('\n');

test('spawn-sync: POSIX includes guarded under !_WIN32', () => {
  assert.match(spawnAdded, /#if !defined\(_WIN32\)[\s\S]*#include <poll\.h>/);
});
test('spawn-sync: Windows twin includes windows.h', () => {
  assert.match(spawnAdded, /#if defined\(_WIN32\)[\s\S]*#include <windows\.h>/);
});
test('spawn-sync: Windows path uses CreateProcess', () => {
  assert.match(spawnAdded, /CreateProcessA?\(/);
});
test('spawn-sync: Windows drain uses overlapped ReadFile + WaitForMultipleObjects', () => {
  assert.match(spawnAdded, /FILE_FLAG_OVERLAPPED/);
  assert.match(spawnAdded, /WaitForMultipleObjects/);
});
test('spawn-sync: missing exe maps to ENOENT', () => {
  assert.match(spawnAdded, /ERROR_FILE_NOT_FOUND[\s\S]*ENOENT/);
});
test('spawn-sync: shared init exposes __tjs_spawn_sync (unguarded)', () => {
  assert.match(spawnAdded, /__tjs_spawn_sync/);
});

test('build-tjs: the Phase-0 sync stub is fully retired', () => {
  const drv = fs.readFileSync(path.join(__dirname, '..', 'scripts/build-tjs.mjs'), 'utf8');
  assert.doesNotMatch(drv, /CLODE_TJS_STUB_SYNC/, 'CLODE_TJS_STUB_SYNC must be gone');
  assert.doesNotMatch(drv, /fixupStubSyncPrimitives/, 'fixupStubSyncPrimitives must be gone');
});
