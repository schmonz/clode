'use strict';
// depscan vs the host's own tool, on a binary neither wrote.
//
// Tasks 2-4 prove depscan reads what test/fixtures/binfmt.cjs put there --
// a closed loop, since one author wrote both halves. This is the open one:
// a whole-format misreading that the fixture builder happens to share would
// pass there and fail here.
//
// SKIPS ARE HONEST HERE, and deliberately so: this test can only run where
// the host has both a native tool and a native binary. The cross-built and
// Windows coverage this phase exists for lives in test/depscan.test.cjs,
// which runs everywhere. A skip here is "this host cannot be the second
// opinion", not "unverified".
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const { depscanExe } = require('./depscan-build.cjs');

function depsFromDepscan(file) {
  const r = spawnSync(depscanExe(), [file], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `depscan failed on ${file}: ${r.stderr}`);
  return r.stdout.split('\n').filter((l) => l.startsWith('dep=')).map((l) => l.slice(4));
}

function have(cmd) {
  return spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8' }).status === 0;
}

test('darwin: depscan agrees with otool -L on a system binary', { skip: process.platform !== 'darwin' ? 'not darwin' : !have('otool') ? 'no otool' : false }, () => {
  const target = '/bin/sh';
  const otool = spawnSync('otool', ['-L', target], { encoding: 'utf8' });
  assert.strictEqual(otool.status, 0, otool.stderr);
  // otool -L prints "<binary>:" then one indented "<path> (compatibility ...)"
  // line per dependency. /bin/sh on this box is 3-way fat (x86_64 + two
  // arm64e slices, per `lipo -info`) -- but this host's otool (cctools-1040)
  // does NOT split fat output into per-architecture "(architecture ...):"
  // sections; it prints one dependency set. We still guard against a header
  // line being parsed as a dependency (dropping any line ending in ":"), in
  // case a different otool build DOES split by architecture.
  const want = new Set(otool.stdout.split('\n').slice(1)
    .map((l) => l.trim()).filter(Boolean)
    .filter((l) => !/:$/.test(l))
    .map((l) => l.replace(/\s*\(compatibility.*$/, '')));
  // depscan is fat-aware and reports one dep= line PER SLICE (task 4), so a
  // 3-slice binary with one dylib each yields three identical dep= lines.
  // otool's single, unsplit dependency set has no notion of "per slice" to
  // compare against, so the honest comparison here is on the SET of names,
  // not the raw count -- three slices agreeing with each other and with
  // otool is still agreement, not disagreement.
  const got = new Set(depsFromDepscan(target));
  assert.ok(want.size > 0, 'otool -L produced no dependency lines — the harness is wrong, not depscan');
  assert.deepStrictEqual([...got].sort(), [...want].sort(),
    `depscan and otool -L disagree on ${target}`);
});

test('linux/bsd: depscan agrees with ldd on a system binary', { skip: process.platform === 'darwin' || process.platform === 'win32' ? 'not an ldd platform' : !have('ldd') ? 'no ldd' : false }, () => {
  const target = '/bin/sh';
  const ldd = spawnSync('ldd', [target], { encoding: 'utf8' });
  assert.strictEqual(ldd.status, 0, ldd.stderr);
  // ldd resolves to absolute paths; depscan reports the SONAME as recorded in
  // DT_NEEDED. Compare on basename, which is what both agree on. The vDSO has
  // no file and is dropped.
  const want = new Set(ldd.stdout.split('\n')
    .map((l) => (l.match(/^\s*(\S+)\s*=>/) || [])[1])
    .filter(Boolean).filter((n) => !/^linux-vdso/.test(n)));
  const got = new Set(depsFromDepscan(target));
  assert.ok(want.size > 0, 'ldd produced no dependency lines — the harness is wrong, not depscan');
  for (const n of got) {
    assert.ok(want.has(n), `depscan reported ${n}, which ldd did not list: ${[...want].join(', ')}`);
  }
});

test('windows: depscan agrees with dumpbin /dependents', { skip: process.platform !== 'win32' ? 'not windows' : !have('dumpbin') ? 'no dumpbin (needs a VS developer prompt)' : false }, () => {
  const target = process.execPath;                       // node.exe
  const dump = spawnSync('dumpbin', ['/dependents', target], { encoding: 'utf8' });
  assert.strictEqual(dump.status, 0, dump.stderr);
  const want = new Set(dump.stdout.split('\n')
    .map((l) => l.trim()).filter((l) => /\.dll$/i.test(l)).map((l) => l.toLowerCase()));
  const got = new Set(depsFromDepscan(target).map((d) => d.toLowerCase()));
  assert.ok(want.size > 0, 'dumpbin listed no dependents — the harness is wrong, not depscan');
  assert.deepStrictEqual([...got].sort(), [...want].sort());
});

// The opportunistic cross oracle: real foreign-arch engines, if this box has
// them cached. These are the binaries otool/ldd genuinely CANNOT read, so
// there is no second opinion to compare against -- the assertion is only that
// depscan parses them and says something definite.
test('cached cross-built engine templates parse to a definite answer', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = path.join(os.homedir(), '.cache', 'clode', 'templates');
  if (!fs.existsSync(dir)) return;                       // a cache, never required
  // A cosmo APE is an MZ header that is NOT a PE -- depscan reports it as an
  // unrecognized container, correctly. Exclude it by name rather than
  // loosening the assertion below, which would let a real parse failure pass.
  const templates = fs.readdirSync(dir)
    .filter((f) => f.startsWith('tjs-') && !f.includes('cosmo'))
    .slice(0, 12);
  if (templates.length === 0) return;
  let checked = 0;
  for (const t of templates) {
    const r = spawnSync(depscanExe(), [path.join(dir, t)], { encoding: 'utf8' });
    // 0 = parsed. Anything else on a real engine we built is a finding.
    assert.strictEqual(r.status, 0, `depscan could not parse ${t}: ${r.stderr}`);
    assert.match(r.stdout, /^deps=\d+$/m, `${t} produced no deps= line`);
    checked++;
  }
  assert.ok(checked > 0);
});
