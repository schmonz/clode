'use strict';
// The CLASS behind the 2.1.238 errno P0.
//
// The bundle reads `constants` tables the shim hand-maintains. When it reads one
// we never populated, the failure mode depends entirely on luck: os.constants.errno
// was absent, `Object.entries(undefined)` threw, and every quaude built against
// 2.1.238 was dead on arrival — loud, but only once someone ran a build. The quiet
// version is worse: a missing fs.constants.S_IFMT makes a file-type mask evaluate
// to NaN and silently misclassify, with nothing to catch it.
//
// Individual rows pin the tables we KNOW the bundle reads (os.constants.signals,
// os.constants.errno, zlib.constants). This row exists for the ones we don't: it
// inventories every constants surface against host node and pins the gap set to a
// golden file, so a gap that appears — because upstream node grew a constant, or
// because someone trimmed a table — shows up as a dated, named failure instead of
// waiting for a boot to trip over it. Closing a gap fails too, asking you to
// ratchet the golden down; the list only shrinks.
//
// Deliberately NOT a demand that every gap be closed. Most of these are unread and
// some are unimplementable here. The product is an accurate, reviewed list.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

const GOLDEN = path.join(__dirname, 'shim-surface', 'constants-golden.json');
const MODULES = ['os', 'fs', 'zlib', 'crypto', 'dns', 'tty', 'net', 'http2'];

// Report shape, not values: group NAMES and their member counts. Values are the
// job of the per-table deep-equal rows; this row is about presence.
const PROBE = `
const out = {};
for (const m of ${JSON.stringify(MODULES)}) {
  let c;
  try { c = require(m).constants; }
  catch (e) { out[m] = 'THROWS'; continue; }
  if (c === undefined || c === null) { out[m] = 'ABSENT'; continue; }
  const g = {};
  for (const k of Object.keys(c)) {
    const v = c[k];
    g[k] = (v && typeof v === 'object') ? Object.keys(v).length : null;
  }
  out[m] = g;
}
console.log(JSON.stringify(out));
`;

function gaps() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-const-'));
  const f = path.join(dir, 'probe.cjs');
  fs.writeFileSync(f, PROBE);
  const host = JSON.parse(execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  const r = runLoader(f);
  assert.strictEqual(r.status, 0, r.stderr);
  const shim = JSON.parse(r.stdout.trim());

  const report = {};
  for (const m of MODULES) {
    const h = host[m], s = shim[m];
    // One side absent/throwing: record LABELS, not the table. Spilling node's
    // whole http2 constants map into the golden would make the file unreviewable,
    // and an unreviewable golden gets rubber-stamped — which is how a golden stops
    // being a decision and becomes decoration.
    const label = (v) => (typeof v === 'string' ? v : `PRESENT(${Object.keys(v).length} groups)`);
    if (typeof h === 'string' || typeof s === 'string') {
      if (label(h) !== label(s)) report[m] = { host: label(h), shim: label(s) };
      continue;
    }
    const missing = Object.keys(h).filter((k) => !(k in s));
    // A group present on both but of a different SIZE is a partial table — the
    // shape that lets a lookup return undefined without anything looking absent.
    const partial = Object.keys(h).filter((k) => k in s && h[k] !== s[k])
      .map((k) => `${k} (host ${h[k]}, shim ${s[k]})`);
    if (missing.length || partial.length) {
      report[m] = {};
      if (missing.length) report[m].missing = missing.sort();
      if (partial.length) report[m].partial = partial.sort();
    }
  }
  return report;
}

test('node-shim constants: the gap inventory matches the reviewed golden', (t) => {
  if (skipUnlessTjs(t)) return;
  const actual = gaps();
  if (process.env.CLODE_UPDATE_CONSTANTS_GOLDEN === '1') {
    fs.writeFileSync(GOLDEN, JSON.stringify(actual, null, 2) + '\n');
    t.diagnostic('golden rewritten');
    return;
  }
  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  assert.deepStrictEqual(actual, golden,
    'constants gap inventory moved. A NEW gap means the shim now lacks something host '
    + 'node has — decide whether the bundle can reach it before accepting. A CLOSED gap '
    + 'is good news: ratchet the golden down. Refresh with '
    + 'CLODE_UPDATE_CONSTANTS_GOLDEN=1 node --test test/node-shim-constants.test.cjs');
});

// THE GENERATOR'S OWN TWO WAYS OF GOING STALE, gated here rather than left to
// whoever next runs it (2026-09-20).
//
// The row above is the downstream symptom: it needs a BUILT tjs engine, it skips
// without one, and when it fires it says `fs.missing: [UV_FS_O_RANDOM, ...]` — true,
// but it does not say that the fix is to re-transcribe node's NODE_DEFINE_CONSTANT
// list. That is exactly how node 24.21.0's four new fs names reached CI: a Renovate
// toolchain bump (#45) went red on two oracle legs only, with a message that reads
// like a shim bug.
//
// scripts/gen-node-constants.mjs already KNOWS both answers — it has a host-vs-list
// ratchet, and it can recompute the exact text it splices into signals.c without the
// vendor tree. Nothing ever ran either check. `--check` runs both and writes nothing,
// on every leg, in milliseconds, before any engine exists:
//
//   * host node exposes a name NODE_CONSTANTS lacks  -> node grew a constant
//   * the committed patch is not what the generator emits -> somebody edited the
//     generator and did not regenerate (97a3fe6 did exactly that, and the drift sat
//     in the tree unnoticed until this row was written)
//
// The reverse direction is never an error: the list is a UNION across platforms, so
// names this host lacks are the design working. See the long comment in the generator.
test('node-constants generator: the name list tracks host node and the committed patch tracks the generator', () => {
  const gen = path.join(__dirname, '..', 'scripts', 'gen-node-constants.mjs');
  const r = require('node:child_process').spawnSync(process.execPath, [gen, '--check'], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `${r.stdout}${r.stderr}`);
});

// VALUES, not just keys (2026-08-27). The gap inventory above compares the KEY SETS of
// host node and the shim; it never looks at what a constant is worth. crypto.constants is
// a 55-entry hand-written literal in libexec/node-shim/modules/crypto.cjs, and exactly
// three of those values were checked anywhere (RSA_PKCS1_PADDING, SSL_OP_NO_TLSv1_3 and
// POINT_CONVERSION_UNCOMPRESSED, in node-shim-api-batch2). A mistyped
// RSA_PKCS1_OAEP_PADDING would have been invisible — which is the same shape as the BSD
// legs shipping 8 of 11 fs.O_* wrong, and the reason platform constants are generated
// from the engine rather than typed by hand.
//
// A shim SUPERSET is allowed and is not a failure: node moves constants in and out across
// releases (24.20.0 has RSA_SSLV23_PADDING, 24.19.0 and 26.3.0 do not), and carrying an
// extra number costs nothing. What must never differ is a value we both claim to have.
test('crypto.constants: every value we share with host node is identical', () => {
  const shim = require('../libexec/node-shim/modules/crypto.cjs').constants;
  const host = require('node:crypto').constants;
  // OPENSSL_VERSION_NUMBER encodes the OpenSSL release the HOST's node was linked against, so
  // it legitimately differs per machine — measured: 811597872 here, 810549360 on CI's runner.
  // It is not a portable constant like a padding mode or an SSL_OP_* bitmask, and under quaude
  // there is no OpenSSL at all (the engine uses mbedtls), so any value the shim reports is a
  // plausible fiction rather than a fact about the process. Comparing it asserts something
  // that cannot be true on two different machines.
  const HOST_DEPENDENT = new Set(['OPENSSL_VERSION_NUMBER']);
  const shared = Object.keys(shim).filter((k) => k in host && !HOST_DEPENDENT.has(k));
  assert.ok(shared.length > 40, `expected the bulk of the table to be comparable, got ${shared.length}`);
  const wrong = shared.filter((k) => host[k] !== shim[k])
    .map((k) => `${k}: shim ${shim[k]} != host ${host[k]}`);
  assert.deepStrictEqual(wrong, [],
    'a hand-written crypto constant disagrees with host node. Regenerate the table with '
    + '`node scripts/gen-crypto-constants.mjs --write` under the PINNED reference node, '
    + 'not by editing the literal.');
});

// THE MESSAGE IS THE GATE (2026-09-21). The row above proves --check PASSES on a
// clean tree; nothing proved it still fails when it should, or that what it prints
// is useful. Both matter, and the second one had already gone wrong.
//
// On its first windows-latest run the check found 58 WSA* errno names that
// NODE_CONSTANTS had never had — Windows-only Winsock errnos, fed into
// os.constants.errno by node's DefineWindowsErrorConstants, a sixth Define*
// function nobody had transcribed. Nothing had grown; no version had moved; the
// list was simply the union of the platforms someone had looked at. The message
// said "node grew a constant" and sent the reader hunting for a toolchain bump
// that did not exist.
//
// So this row injects a name the host "has" and NODE_CONSTANTS cannot, and asserts
// the check fails and explains BOTH causes. Injection, not a golden copy of the WSA
// list: asserting that NODE_CONSTANTS contains names we just typed into
// NODE_CONSTANTS is a gate that cannot fail. What can fail is the check going quiet
// (someone softens the exit) or the wording regressing to one cause.
test('node-constants --check: a name this host has and the list lacks fails LOUDLY, naming both causes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-check-'));
  const preload = path.join(dir, 'inject.cjs');
  // os.constants.errno's own properties are read-only but the object is extensible,
  // so a preload can add one — which is exactly the shape a Windows host presents
  // (79 POSIX names plus 58 Winsock ones in the same object).
  fs.writeFileSync(preload,
    "require('node:os').constants.errno.ECLODENOTAREALERRNO = 424242;\n");
  const gen = path.join(__dirname, '..', 'scripts', 'gen-node-constants.mjs');
  const r = require('node:child_process')
    .spawnSync(process.execPath, ['--require', preload, gen, '--check'], { encoding: 'utf8' });
  const out = `${r.stdout}${r.stderr}`;
  assert.strictEqual(r.status, 1,
    `--check must FAIL when the host has a name NODE_CONSTANTS lacks; got ${r.status}:\n${out}`);
  assert.match(out, /ECLODENOTAREALERRNO/, `the missing name must be listed:\n${out}`);
  assert.match(out, /GREW/, `cause 1 (a version bump added it) must be named:\n${out}`);
  assert.match(out, /PLATFORM NOBODY TRANSCRIBED FROM/,
    'cause 2 must be named: the 58 WSA* errno names were a platform gap with no version '
    + `change, and "node grew a constant" alone sent the reader after a bump that never happened:\n${out}`);
  assert.match(out, /DefineWindowsErrorConstants/,
    `the fix must name EVERY Define* function feeding the namespace, not just the obvious one:\n${out}`);
});
