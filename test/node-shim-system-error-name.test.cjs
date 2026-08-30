'use strict';
// util.getSystemErrorName — DIFFERENTIAL against host node, not a golden list.
//
// Upstream imports it: `import{getSystemErrorName as vn,promisify as gt}from"util"`
// (2.1.251, chunk-2g7r0p0x.js is the zlib/downloader chunk; the getSystemErrorName
// importer is the dirSync anchor chunk — see the gap note in
// libexec/node-shim/modules/util.cjs for exactly where, and for the reachability
// measurement). The shim did not provide it, so the generated interop facade bound a
// lazy thrower: it would have failed only at the moment it was called, which is the
// moment an errno was being rendered — a secondary failure on top of the primary one
// it existed to name.
//
// WHY A DIFFERENTIAL AND NOT A TABLE. The obvious implementation — invert
// os.constants.errno — is WRONG, and wrong in a way only a differential can see.
// node's answer is LIBUV's error map, not the platform's errno list. Measured on
// darwin/arm64 against node 24.19.0: of the 79 names in os.constants.errno, 18
// disagree with util.getSystemErrorName. EWOULDBLOCK (35) must come back as "EAGAIN",
// because libuv's UV_ERRNO_MAP has no EWOULDBLOCK at all; EOPNOTSUPP, ECHILD, EDEADLK,
// EDOM, EDQUOT, EIDRM, EINPROGRESS, ESTALE, ETIME and nine more must come back as
// "Unknown system error -N", because libuv does not map them. A shim answering from
// os.constants.errno would be confidently, silently wrong on 18 of 79 — the exact
// shape of the fs O_* incident recorded in
// libexec/node-shim/internal/engine-constants.cjs.
//
// So the implementation asks the engine's OWN libuv (`new tjs.Error(n).code` IS
// uv_err_name(n) — txiki.js src/error.c), and this file proves the answer equals
// node's on every errno THIS platform defines. No table is transcribed anywhere.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const util = require('node:util');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

// The inputs that MATTER are the ones a real call site can produce. Upstream's only
// caller passes `-b`, where b is a raw platform errno read out of libSystem's
// __error(), so the reachable domain is exactly the negation of this platform's errno
// table — DERIVED from the running node, never transcribed (a transcribed list would
// bake this host's platform into every leg; see gen-node-constants.mjs).
const PLATFORM_ERRNOS = [...new Set(Object.values(os.constants.errno))].map((v) => -v);
// Plus the shapes node treats specially, so the CONTRACT is pinned, not just the table.
const EDGE_NUMBERS = [-1, -4094, -4095, -999999, 0, 2, -1.5, 1.5, NaN];
const NUMBERS = [...new Set([...PLATFORM_ERRNOS, ...EDGE_NUMBERS])];
// Non-numbers, as source literals (they cannot all survive JSON).
const NON_NUMBERS = ['"-2"', 'null', 'undefined', '{}', 'true'];
const NON_NUMBER_VALUES = ['-2', null, undefined, {}, true];

// Host node IS the oracle. Errors are compared by constructor + code, not message.
function oracle(v) {
  try { return ['ok', util.getSystemErrorName(v)]; }
  catch (e) { return ['throw', e.constructor.name, e.code]; }
}

function writeProg() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-gsen-'));
  const f = path.join(dir, 'p.cjs');
  fs.writeFileSync(f, `
    const util = require('util');
    const NUMBERS = ${JSON.stringify(NUMBERS.map((n) => (Number.isNaN(n) ? '__NaN__' : n)))}
      .map((n) => (n === '__NaN__' ? NaN : n));
    const OTHERS = [${NON_NUMBERS.join(', ')}];
    const out = [];
    for (const v of NUMBERS.concat(OTHERS)) {
      try { out.push(['ok', util.getSystemErrorName(v)]); }
      catch (e) { out.push(['throw', (e && e.constructor && e.constructor.name) || 'Error', (e && e.code) || undefined]); }
    }
    console.log('RESULT:' + JSON.stringify(out));
  `);
  return f;
}

const LABELS = [...NUMBERS.map(String), ...NON_NUMBERS];
const WANT = [...NUMBERS.map(oracle), ...NON_NUMBER_VALUES.map(oracle)];

test('util.getSystemErrorName matches host node on every errno this platform defines', (t) => {
  if (skipUnlessTjs(t)) return;
  const r = runLoader(writeProg());
  assert.strictEqual(r.status, 0, `loader failed:\n${r.stderr}`);
  const m = r.stdout.match(/RESULT:(.*)/);
  assert.ok(m, `no RESULT line; stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  const got = JSON.parse(m[1]);
  assert.strictEqual(got.length, WANT.length);

  const diffs = [];
  for (let i = 0; i < WANT.length; i++) {
    if (JSON.stringify(got[i]) !== JSON.stringify(WANT[i])) {
      diffs.push(`${LABELS[i]}: shim ${JSON.stringify(got[i])} != node ${JSON.stringify(WANT[i])}`);
    }
  }
  assert.deepStrictEqual(diffs, [],
    `util.getSystemErrorName diverges from host node on ${diffs.length} of ${WANT.length} inputs:\n  `
    + diffs.join('\n  '));
});

// The single row that catches an os.constants.errno-inverting implementation on every
// platform where EWOULDBLOCK === EAGAIN (every libc we ship on). Kept separate from the
// bulk differential so the failure NAMES the mistake instead of burying it in a list.
test('util.getSystemErrorName answers from libuv, not from os.constants.errno', (t) => {
  if (skipUnlessTjs(t)) return;
  const e = os.constants.errno;
  if (e.EWOULDBLOCK !== e.EAGAIN) { t.skip('EWOULDBLOCK !== EAGAIN on this platform'); return; }
  const i = NUMBERS.indexOf(-e.EWOULDBLOCK);
  assert.ok(i >= 0, 'EWOULDBLOCK must be among the probed platform errnos');
  assert.deepStrictEqual(WANT[i], ['ok', 'EAGAIN'],
    'host node must answer EAGAIN here (libuv has no EWOULDBLOCK) — if THIS fails the '
    + 'oracle changed, not the shim');
  const r = runLoader(writeProg());
  assert.strictEqual(r.status, 0, r.stderr);
  const got = JSON.parse(r.stdout.match(/RESULT:(.*)/)[1]);
  assert.deepStrictEqual(got[i], ['ok', 'EAGAIN'],
    `the shim answered ${JSON.stringify(got[i])} for -EWOULDBLOCK (${-e.EWOULDBLOCK}). `
    + 'That is what inverting os.constants.errno produces; node answers EAGAIN because '
    + 'libuv\'s UV_ERRNO_MAP has no EWOULDBLOCK entry. Answer from the engine\'s libuv.');
});
