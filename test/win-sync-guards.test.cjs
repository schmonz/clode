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
