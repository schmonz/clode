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
const { defineGuard, guardTests } = require('./guard.cjs');
const { parseDepscan } = require('../scripts/depscan-verdict.cjs');

function depsFromDepscan(file) {
  const r = spawnSync(depscanExe(), [file], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, `depscan failed on ${file}: ${r.stderr}`);
  // Parse with the production parser, not an ad-hoc split('\n') — see the
  // comment on scanFixture in test/depscan.test.cjs (CI run 35284845847):
  // Windows' text-mode stdout turns depscan's '\n' into '\r\n', and only
  // parseDepscan (which .trim()s each line, matching production) tolerates
  // that. Deps are flattened across slices deliberately: this compares
  // against a fat host binary's UNSPLIT dependency set (see the mode:
  // 'exact'/'subset' comments below), so per-slice grouping doesn't matter
  // here.
  return parseDepscan(r.stdout).slices.flatMap((s) => s.deps);
}

function have(cmd) {
  return spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { encoding: 'utf8' }).status === 0;
}

// Guard (task-8 addendum (h)): depscan vs the host's own tool, on a binary neither
// wrote. This used to be three separate platform-gated tests, each reading a real
// artifact (a system binary + a native tool's own output) and deriving a finding by
// set comparison -- exactly guard-shaped, so they collapsed into ONE guard whose
// read() picks whichever native tool this host actually has.
//
// SKIPS ARE HONEST HERE, and deliberately so: this guard can only run where the host
// has both a native tool and a native binary. The cross-built and Windows coverage
// this phase exists for lives in test/depscan.test.cjs, which runs everywhere. A skip
// here is "this host cannot be the second opinion", not "unverified".
const depscanAgreesWithNativeTool = defineGuard({
  name: 'depscan-agrees-with-native-tool',
  floor: 1,
  read() {
    if (process.platform === 'darwin') {
      if (!have('otool')) return { skip: 'no otool' };
      const target = '/bin/sh';
      const otool = spawnSync('otool', ['-L', target], { encoding: 'utf8' });
      if (otool.status !== 0) return { skip: `otool -L failed: ${otool.stderr}` };
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
      if (want.size === 0) throw new Error('otool -L produced no dependency lines — the harness is wrong, not depscan');
      // depscan is fat-aware and reports one dep= line PER SLICE (task 4), so a
      // 3-slice binary with one dylib each yields three identical dep= lines.
      // otool's single, unsplit dependency set has no notion of "per slice" to
      // compare against, so the honest comparison here is on the SET of names,
      // not the raw count -- three slices agreeing with each other and with
      // otool is still agreement, not disagreement. mode 'exact': every name
      // must appear on both sides.
      return { want, got: new Set(depsFromDepscan(target)), target, tool: 'otool -L', mode: 'exact' };
    }
    if (process.platform !== 'win32') {
      if (!have('ldd')) return { skip: 'no ldd' };
      const target = '/bin/sh';
      const ldd = spawnSync('ldd', [target], { encoding: 'utf8' });
      if (ldd.status !== 0) return { skip: `ldd failed: ${ldd.stderr}` };
      // ldd resolves to absolute paths; depscan reports the SONAME as recorded
      // in DT_NEEDED. Compare on basename, which is what both agree on. The
      // vDSO has no file and is dropped. mode 'subset': every depscan dep must
      // be SOMEWHERE in ldd's list, but ldd's list is allowed to know about
      // more than the SONAME table does (e.g. transitively resolved libs).
      const want = new Set(ldd.stdout.split('\n')
        .map((l) => (l.match(/^\s*(\S+)\s*=>/) || [])[1])
        .filter(Boolean).filter((n) => !/^linux-vdso/.test(n)));
      if (want.size === 0) throw new Error('ldd produced no dependency lines — the harness is wrong, not depscan');
      return { want, got: new Set(depsFromDepscan(target)), target, tool: 'ldd', mode: 'subset' };
    }
    if (!have('dumpbin')) return { skip: 'no dumpbin (needs a VS developer prompt)' };
    const target = process.execPath;                     // node.exe
    const dump = spawnSync('dumpbin', ['/dependents', target], { encoding: 'utf8' });
    if (dump.status !== 0) return { skip: `dumpbin failed: ${dump.stderr}` };
    const want = new Set(dump.stdout.split('\n')
      .map((l) => l.trim()).filter((l) => /\.dll$/i.test(l)).map((l) => l.toLowerCase()));
    if (want.size === 0) throw new Error('dumpbin listed no dependents — the harness is wrong, not depscan');
    return { want, got: new Set(depsFromDepscan(target).map((d) => d.toLowerCase())), target, tool: 'dumpbin /dependents', mode: 'exact' };
  },
  scan({ want, got, target, tool, mode }) {
    const findings = [];
    for (const d of got) {
      if (!want.has(d)) findings.push(`depscan reported ${d} on ${target}, which ${tool} did not`);
    }
    if (mode === 'exact') {
      for (const d of want) {
        if (!got.has(d)) findings.push(`${tool} reported ${d} on ${target}, which depscan did not`);
      }
    }
    // Examined = "one head-to-head comparison performed", not the dep count --
    // a statically-linked comparison target would legitimately report zero
    // deps on BOTH sides and that is still a complete, meaningful comparison,
    // not a blind one (the same reasoning test/depscan-guard.test.cjs's
    // "statically linked engine reads as EXAMINED, not BROKEN" regression
    // test made explicit for the sibling hermeticity guard).
    return { findings, examined: 1 };
  },
  control() {
    // A depscan/native-tool pair that DISAGREE in both directions: depscan
    // reports something the native tool never saw, AND the native tool
    // reports something depscan missed. Synthetic paths only -- control()
    // does no I/O.
    return {
      want: new Set(['/usr/lib/libSystem.B.dylib']),
      got: new Set(['/opt/evil/lib/libFake.dylib']),
      target: '/fake/target', tool: 'fake-tool', mode: 'exact',
    };
  },
});

guardTests(depscanAgreesWithNativeTool);

// The opportunistic cross oracle: real foreign-arch engines, if this box has
// them cached. These are the binaries otool/ldd genuinely CANNOT read, so
// there is no second opinion to compare against -- the assertion is only that
// depscan parses them and says something definite.
test('cached cross-built engine templates parse to a definite answer', (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const dir = path.join(os.homedir(), '.cache', 'clode', 'templates');
  // A bare `return` here passes in CI having examined NOTHING, with no
  // diagnostic saying so -- ~/.cache/clode/templates exists on a dev box
  // that has fetched engines and does NOT exist on a CI runner, so this is
  // exactly the "a skipped oracle is not a pass" shape this repo has filed
  // repeatedly, landing in the one environment where nobody is watching the
  // output. t.skip() with a reason makes the run report "skipped, because
  // X" instead of a silent green.
  if (!fs.existsSync(dir)) {
    t.skip(`no template cache at ${dir} — this oracle only runs on a box that has fetched engines`);
    return;
  }
  // An APE is a polyglot; depscan reports its PE face. Its Unix face is
  // statically linked by construction (cosmopolitan's libc), so there are no
  // dynamic dependencies to miss -- but "cosmo is verified" means "its PE
  // imports are verified", and that distinction should not live only in
  // someone's memory. (Corrected 2026-09-17: an earlier version of this
  // comment claimed depscan could not parse an APE at all -- MEASURED false;
  // depscan reads it cleanly as format=pe64 with a real import table. cosmo
  // is included in the oracle below, not excluded.)
  const templates = fs.readdirSync(dir)
    .filter((f) => f.startsWith('tjs-'))
    .slice(0, 12);
  if (templates.length === 0) {
    t.skip(`no tjs-* templates found in ${dir}`);
    return;
  }
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
