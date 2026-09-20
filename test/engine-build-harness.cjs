'use strict';
// engine-build-harness — the ONE copy of "drive a real engine build and look at what it
// produced".
//
// WHY THIS FILE EXISTS. `copyCheckout` had been written FOUR times, byte-identically
// (test/ccache.test.cjs, test/tjs-bytecode-e2e.test.cjs, test/build-tjs-no-node.test.cjs,
// test/tjs-reproducible-engine.test.cjs), and the per-leg reproducibility gate would have
// made a fifth. Same for `findBuildDir`/`listObjects`/`sha256Of`, which existed once but
// were about to be copied. This repo's standing complaint about two hand-maintained lists
// (test/release-gate-globs.test.cjs is its monument) applies to two hand-maintained copies
// of a function just as well: a fix to one of five lands in one of five.
//
// NOTHING HERE ASSERTS. It reads, it copies, it spawns, it compares, and it returns
// values or throws on a precondition it cannot meet. Callers decide what a result means —
// which is what lets the same machinery serve ccache's object-grain audit, the
// double-build reproducibility gate, and a human running one leg by hand.
//
// NOT REQUIRED BY scripts/build-tjs.cjs, deliberately. It lives under test/ so it is
// outside the engine recipe's file set (scripts/engine-recipe.mjs FILES) and outside
// test/guards-population.cjs's production-gate population. Adding a reproducibility
// harness must not rebuild all 44 legs.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { tjsPath } = require('./node-shim-helper.cjs');
const { tjsBin, tjsVendorParentDir } = require('../scripts/platform-tag.cjs');

const REPO = path.resolve(__dirname, '..');

// A full engine build on the fastest host here is ~60s; a cold cross leg is minutes. Six
// is the cap test/ccache.test.cjs already used and has never hit.
const ENGINE_BUILD_TIMEOUT_MS = 6 * 60 * 1000;

// A throwaway copy of an EXISTING vendor checkout, never the shared one: build-tjs.cjs
// resets ITS OWN patched tree to pristine on every run, so building three times against
// ~/.cache/clode/tjs-vendor would leave every other build on the box patching from a tree
// this one disturbed mid-flight.
//
// NO process.platform BRANCH. The four inlined copies chose their fast-copy flags by
// platform (`cp -Rc` clonefile on darwin, `cp -R --reflink=auto` on GNU) and then fell
// through to a plain `cp -R` anyway. Trying each candidate in turn and moving on after a
// non-zero exit is the same behaviour with the branch removed — capability detection,
// per house doctrine, and free here because the probe IS the operation.
function copyCheckout(src, dest) {
  const attempts = [['-Rc'], ['-R', '--reflink=auto'], ['-R']];
  for (const flags of attempts) {
    if (spawnSync('cp', [...flags, src, dest]).status === 0) return dest;
    fs.rmSync(dest, { recursive: true, force: true });
  }
  fs.cpSync(src, dest, { recursive: true, verbatimSymlinks: true });
  return dest;
}

// scripts/build-tjs.cjs nests the REAL cmake build dir one level below whatever build-dir
// override it is handed (a per-target hash it derives from outDir, so a shared tree never
// lets two targets collide — see its targetToken()). Rather than reimplement that hash (a
// second copy of a naming scheme is exactly how the netbsd-sparc bake drifted), find the
// one CMakeCache.txt whose PARENT is literally named `build` — the main engine target,
// never the separate build-depscan tool dir alongside it.
function findBuildDir(buildRoot) {
  const found = spawnSync('find', [buildRoot, '-name', 'CMakeCache.txt'], { encoding: 'utf8' });
  if (found.status !== 0) throw new Error(`find over ${buildRoot} failed: ${found.stderr}`);
  const hits = found.stdout.split('\n').filter(Boolean)
    .filter((p) => path.basename(path.dirname(p)) === 'build');
  if (hits.length !== 1) {
    throw new Error(`expected exactly one main-engine CMakeCache.txt under ${buildRoot}, `
      + `found: ${JSON.stringify(hits)}`);
  }
  // path.resolve, not path.dirname alone: `find` is an external program and the string
  // it printed is ITS spelling of the path, not ours. Git-for-Windows' find hands back
  // `C:\\...\\root/abc123/build` under a backslash root, which made every caller that
  // compares or joins this value fail on separators (run 35521083887, test 976); a `.`
  // segment in the root does the same on POSIX. Callers get a path this function owns.
  return path.resolve(path.dirname(hits[0]));
}

// Every compiled translation unit under a build dir, relative to IT (not to the repo), so
// the same relative name lines up across independently rooted build dirs.
//
// `*.o`, NOT `*.c.o`: the engine build emits exactly one object that is not a C TU (WAMR's
// hand-written invokeNative_aarch64_simd.s.o). It is not routed through ccache, which is a
// reason to keep it out of cacheable-call accounting, not a reason to stop checking that it
// comes out the same — it is an input to the very link whose bytes this file compares.
function listObjects(buildDir) {
  const found = spawnSync('find', [buildDir, '-name', '*.o'], { encoding: 'utf8' });
  if (found.status !== 0) throw new Error(`find over ${buildDir} failed: ${found.stderr}`);
  return found.stdout.split('\n').filter(Boolean)
    .map((abs) => path.relative(buildDir, abs).split(path.sep).join('/'))
    .sort();
}

// HOW MUCH REAL WORK A PHASE DID, measured rather than assumed: the object files under a
// build dir that were WRITTEN at or after `sinceMs`. Callers stamp a marker file
// immediately before spawning the build and pass that file's own mtime, so the comparison
// never crosses from a clock reading to a filesystem timestamp (two sources that disagree
// on NFS, on FAT, and on any host whose clock is being stepped).
//
// WHY THIS IS THE HONEST UNIT. Nothing here can see the compiler's process table, and
// counting ninja's edges would mean parsing its log — a second, driftable notion of the
// same fact. An object file written during the phase is the product of a compile that
// happened, and it is also exactly the artifact whose bytes a reproducibility comparison
// is about. A phase that "succeeded" having written none of them compiled nothing.
function countObjectsWrittenSince(buildDir, sinceMs) {
  let n = 0;
  for (const rel of listObjects(buildDir)) {
    if (fs.statSync(path.join(buildDir, rel)).mtimeMs >= sinceMs) n++;
  }
  return n;
}

// Streamed, not loaded whole — these are small, but the habit is the point.
function sha256Of(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

function sha256OfSync(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

// Copies everything a phase's identity check and diagnostics need out of the shared
// buildRoot/outDir before the NEXT phase wipes and overwrites both. It exists because
// outDir and buildRoot are deliberately the SAME path across phases — two builds into two
// DIFFERENT outDir paths bake that path's own string into their objects (the C sources use
// __FILE__-style absolute paths in a few places), which shows up as a "difference" that is
// really two builds disagreeing about where they were told to live.
//
// The engine is snapshotted under a FIXED basename (`tjs`), never `tjs-<label>` — see
// compareArtifacts for the mach-o signature-identifier reason. The label is a DIRECTORY.
function snapshotPhase(label, buildDir, outBin, snapshotsRoot) {
  const objDir = path.join(snapshotsRoot, label, 'objs');
  fs.mkdirSync(objDir, { recursive: true });
  const objects = listObjects(buildDir);
  for (const rel of objects) {
    const dest = path.join(objDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(buildDir, rel), dest);
  }
  const enginePath = path.join(snapshotsRoot, label, path.basename(outBin));
  fs.copyFileSync(outBin, enginePath);
  return { label, objects, objDir, enginePath };
}

// ---- THE COMPARISON, and the one rule it refuses to let a caller break --------------
//
// COMPARE IDENTICALLY-NAMED OUTPUTS. On mach-o the ad-hoc code signature's identifier is
// derived from the output FILENAME, so snapshotting two byte-identical builds as `tjs-a`
// and `tjs-b` makes them differ — a phantom delta the build did not produce, on every
// darwin run, chased once already (BACKLOG.md, "Build reproducibility — measured, per
// platform"). A comment saying "remember to use the same name" is a rule that gets
// forgotten at the fifth call site; a refusal is one that cannot.
function compareArtifacts(a, b) {
  if (path.basename(a) !== path.basename(b)) {
    throw new Error('compareArtifacts: refusing to compare differently-named outputs '
      + `(${path.basename(a)} vs ${path.basename(b)}). On mach-o the ad-hoc signature's `
      + 'identifier derives from the output FILENAME, so two byte-identical builds '
      + 'snapshotted under different names differ by construction. Snapshot both phases '
      + 'under the SAME basename in different directories.');
  }
  for (const p of [a, b]) {
    if (!fs.existsSync(p)) {
      throw new Error(`compareArtifacts: ${p} does not exist — a build that produced no `
        + 'output is a build FAILURE, and must not be reported as a reproducibility finding');
    }
  }
  const sizeA = fs.statSync(a).size;
  const sizeB = fs.statSync(b).size;
  const shaA = sha256OfSync(a);
  const shaB = sha256OfSync(b);
  if (shaA === shaB) {
    return { identical: true, shaA, shaB, sha: shaA, sizeA, sizeB,
      firstDifferingOffset: -1, differingBytes: 0,
      summary: `identical: sha256 ${shaA} over ${sizeA} bytes` };
  }
  if (sizeA !== sizeB) {
    return { identical: false, shaA, shaB, sizeA, sizeB,
      firstDifferingOffset: -1, differingBytes: -1,
      summary: `DIFFERS by size: ${sizeA} vs ${sizeB} bytes (sha ${shaA.slice(0, 12)} vs `
        + `${shaB.slice(0, 12)})` };
  }
  // Same size, different bytes: say WHERE and HOW MANY. "differs, somewhere" sends the
  // next reader back to `cmp -l` by hand; an offset plus a count is usually enough to
  // recognise a UUID (16 bytes), a code signature (hundreds, at the tail) or a baked-in
  // timestamp (a handful, mid-file) without opening either binary.
  const bufA = Buffer.allocUnsafe(1 << 20);
  const bufB = Buffer.allocUnsafe(1 << 20);
  const fdA = fs.openSync(a, 'r');
  const fdB = fs.openSync(b, 'r');
  let first = -1;
  let count = 0;
  let base = 0;
  try {
    for (;;) {
      const nA = fs.readSync(fdA, bufA, 0, bufA.length, null);
      const nB = fs.readSync(fdB, bufB, 0, bufB.length, null);
      const n = Math.min(nA, nB);
      if (n === 0) break;
      for (let i = 0; i < n; i++) {
        if (bufA[i] !== bufB[i]) { if (first < 0) first = base + i; count++; }
      }
      base += n;
    }
  } finally { fs.closeSync(fdA); fs.closeSync(fdB); }
  return { identical: false, shaA, shaB, sizeA, sizeB,
    firstDifferingOffset: first, differingBytes: count,
    summary: `DIFFERS: ${count} byte(s) of ${sizeA}, first at offset ${first} `
      + `(sha ${shaA.slice(0, 12)} vs ${shaB.slice(0, 12)})` };
}

// ---- driving the build ---------------------------------------------------------------

// One engine build, through the SHIPPED entry point. Returns the spawn result plus the
// success marker check: exit 0 alone is not enough (build-tjs.cjs's own header explains
// why — under tjs an unhandled rejection can be swallowed outright).
function runEngineBuild({ env, timeoutMs = ENGINE_BUILD_TIMEOUT_MS, repo = REPO } = {}) {
  const startedAt = Date.now();
  const r = spawnSync(process.execPath, [path.join(repo, 'scripts/build-tjs.cjs')],
    { cwd: repo, env, encoding: 'utf8', timeout: timeoutMs });
  const wallMs = Date.now() - startedAt;
  const ok = r.status === 0 && /\(tjs-shim-ok\)/.test(r.stdout || '');
  return { ok, status: r.status, wallMs, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// ---- "a host with no Node on it", synthesized -----------------------------------------
// MOVED HERE FROM test/build-tjs-no-node.test.cjs when a SECOND file needed it
// (test/build-tjs-cold-provision.test.cjs), for the reason that file's own header already
// gives about duplicated preconditions: "the copy that stops matching is the one that
// starts skipping for the wrong reason". copyCheckout was written four times before it
// landed here; this is the same function one round earlier.
//
// FILTER BY ENTRY, NOT BY DIRECTORY. --build-only shells to cmake, ninja and ccache, and
// on this box all three live in /opt/pkg/bin -- WHICH IS ALSO WHERE node LIVES. Dropping
// every PATH directory that contains a node drops the compiler with it, and the run then
// fails for a reason that has nothing to do with Node absence. So: a farm of symlinks to
// every program on the ambient PATH except the Node family, first-wins so PATH precedence
// is preserved, with the POSIX floor behind it.
const NODE_FAMILY = new Set(['node', 'nodejs', 'npm', 'npx', 'corepack',
  'node.exe', 'npm.cmd', 'npx.cmd']);
const POSIX_FLOOR = '/usr/bin:/bin:/usr/sbin:/sbin';
function nodeFreePath(farmDir) {
  fs.mkdirSync(farmDir, { recursive: true });
  for (const d of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    let entries;
    try { entries = fs.readdirSync(d); } catch { continue; }
    for (const name of entries) {
      if (NODE_FAMILY.has(name)) continue;
      const link = path.join(farmDir, name);
      if (fs.existsSync(link)) continue; // first wins: PATH precedence
      try { fs.symlinkSync(path.join(d, name), link); } catch { /* racy dir, skip */ }
    }
  }
  return `${farmDir}${path.delimiter}${POSIX_FLOOR}`;
}

// Returns { srcCheckout, bare } or null after calling t.skip with the reason.
// Every refusal names what is missing AND how to supply it, because a skip nobody can act
// on is a test that quietly stopped existing.
function nodeFreePreflight(t, farmDir) {
  if (process.platform === 'win32') {
    t.skip('POSIX-only: this gate proves Node-absence with `sh -c \'command -v node\'` '
      + 'and a synthesized POSIX PATH — not a missing engine');
    return null;
  }
  if (!tjsPath()) {
    t.skip(`no engine (CLODE_TJS or ${tjsBin(REPO)}) — build one with \`node scripts/build-tjs.cjs\``);
    return null;
  }
  const srcCheckout = path.join(tjsVendorParentDir(), 'txiki.js');
  if (!fs.existsSync(path.join(srcCheckout, '.git'))) {
    t.skip(`no vendor checkout at ${srcCheckout} — run \`node scripts/build-tjs.cjs --source-only\` `
      + 'once; this gate copies an existing checkout and will not clone 785MB inside a test run');
    return null;
  }
  const bare = nodeFreePath(farmDir);
  const probe = spawnSync('sh', ['-c', 'command -v node || true'],
    { env: { PATH: bare }, encoding: 'utf8' });
  if (probe.stdout.trim()) {
    t.skip(`node is still reachable at ${probe.stdout.trim()} on the synthesized node-free PATH `
      + `(it is inside the POSIX floor ${POSIX_FLOOR}, which this gate cannot drop without `
      + 'losing sh/cc) — this host cannot express "no node" and the gate would prove nothing');
    return null;
  }
  return { srcCheckout, bare };
}

module.exports = {
  REPO, ENGINE_BUILD_TIMEOUT_MS,
  copyCheckout, findBuildDir, listObjects, countObjectsWrittenSince, sha256Of, sha256OfSync,
  compareArtifacts, runEngineBuild, snapshotPhase,
  NODE_FAMILY, POSIX_FLOOR, nodeFreePath, nodeFreePreflight,
};
