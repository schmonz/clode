'use strict';
// READ A FUSED QUAUDE FROM DISK, WITHOUT RUNNING IT.
//
// A quaude is [base exe][members][index JSON][QAUDEv0 footer 32B][bootstrap bc][tx1k1.js 12B]
// (libexec/quaude-bootstrap.mjs owns the layout). Everything the target knows about itself —
// manifest.json included — is a plain member in that stack, so any host can answer questions
// about any quaude: a foreign-arch cross-build it cannot exec, a target from a release
// archive, one built by someone else.
//
// THAT MATTERS BECAUSE THE OBVIOUS TOOL LIES. A quaude stores the bundle as BYTECODE, so
// `strings` on one finds nothing to answer "which platform was this carved for?" — an hour was
// spent on exactly that in 2026-08-29 and it produced a confident wrong answer. --quaude-attest
// prints the manifest, but only on a target this host can execute, which excludes every
// cross-build. This reader has neither limitation.
//
// ONE COPY. This lived, character for character, in test/quaude-cross-fuse.test.cjs and
// test/clode-native.test.cjs before it lived here.
const assert = require('node:assert');
const fs = require('node:fs');

function readTrailerIndex(file) {
  const buf = fs.readFileSync(file);
  const tx = buf.subarray(buf.length - 12);
  assert.strictEqual(tx.subarray(0, 8).toString('latin1'), 'tx1k1.js', 'missing tx1k1.js trailer');
  const bcOffset = tx.readUInt32LE(8);
  const footer = buf.subarray(bcOffset - 32, bcOffset);
  assert.strictEqual(footer.subarray(0, 8).toString('latin1'), 'QAUDEv0\0', 'bad archive footer magic');
  const indexOff = Number(footer.readBigUInt64LE(8));
  const indexLen = Number(footer.readBigUInt64LE(16));
  const index = JSON.parse(buf.subarray(indexOff, indexOff + indexLen).toString('utf8'));
  const member = (name) => {
    const m = index.members.find((x) => x.name === name);
    return m && { ...m, data: buf.subarray(m.offset, m.offset + m.len) };
  };
  return { buf, index, member, names: index.members.map((m) => m.name) };
}

// The fused artifact's own account of itself. Throws (rather than returning undefined) when
// the member is missing: a quaude with no manifest is a broken fuse, not a quiet null.
function readManifest(file) {
  const { member } = readTrailerIndex(file);
  const m = member('manifest.json');
  assert.ok(m, `${file}: the archive has no manifest.json member`);
  return JSON.parse(m.data.toString('utf8'));
}

module.exports = { readTrailerIndex, readManifest };
