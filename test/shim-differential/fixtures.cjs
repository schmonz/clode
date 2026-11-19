'use strict';
// The fixture tree every differential case runs against, built by ONE function so the oracle (node)
// and the subject (tjs + node-shim) see the same names. Read-only cases share one tree the test
// builds once (so identity fields, dev and ino, are comparable across the two runtimes); a case that
// mutates gets a fresh tree of its own on each side, built here by each runtime, and is judged by
// what it returns and by what the tree looks like afterwards.
//
// Plain fs calls only (writeFileSync, mkdirSync, symlinkSync), the ones every other row of the suite
// already relies on, so the builder is not itself under test.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// name -> what it is. `missing` and `notdir` are never created; `fifo` only where mkfifo exists.
const FIXTURES = {
  file: 'a regular file, two lines',
  empty: 'an empty regular file',
  dir: 'a directory holding two files and a subdirectory',
  emptydir: 'an empty directory',
  symlink: 'a symlink to file',
  dirlink: 'a symlink to dir',
  dangling: 'a symlink to a name that does not exist',
  fifo: 'a named pipe',
  missing: 'a name that does not exist',
  notdir: 'file/x: a path through a regular file',
};

function build(root, { fifo = true } = {}) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'file'), 'hello\nworld\n');
  fs.writeFileSync(path.join(root, 'empty'), '');
  fs.mkdirSync(path.join(root, 'dir'));
  fs.writeFileSync(path.join(root, 'dir', 'a.txt'), 'a\n');
  fs.writeFileSync(path.join(root, 'dir', 'b.json'), '{"b":1}\n');
  fs.mkdirSync(path.join(root, 'dir', 'sub'));
  fs.writeFileSync(path.join(root, 'dir', 'sub', 'c'), 'c');
  fs.mkdirSync(path.join(root, 'emptydir'));
  fs.symlinkSync('file', path.join(root, 'symlink'));
  fs.symlinkSync('dir', path.join(root, 'dirlink'));
  fs.symlinkSync('nowhere', path.join(root, 'dangling'));
  if (fifo && process.platform !== 'win32') {
    try { execFileSync('mkfifo', [path.join(root, 'fifo')]); } catch { /* reported as a missing fixture */ }
  }
  return root;
}

function fixturePath(root, name) {
  if (name === 'notdir') return path.join(root, 'file', 'x');
  return path.join(root, name);
}

module.exports = { FIXTURES, build, fixturePath };
