'use strict';
// The engine install must not shoot the build in the head.
//
// THE DEFECT. scripts/build-tjs.cjs ends by putting the freshly built engine at
// outDir/tjs. outDir defaults to scripts/platform-tag.cjs's tjsDir(), which is the SAME
// path scripts/bootstrap-engine.sh's step 2 hands back as "an engine this checkout already
// built" — so `./build.sh` resolves that engine, runs the graph under it, and the graph's
// engine.compile step overwrites the binary the interpreter running it is executing from.
// The install was a copy onto the live path, which truncates the running image; the
// kernel SIGKILLs the process mid-build (`Killed: 9`, or the exec smoke reporting
// `smoke failed: engine did not run`). Reproduced twice by hand. It hits every caller —
// scripts/build-tjs-boot.sh in CI resolves the same engine the same way — which is why the
// fix is in build-tjs.cjs and not a dodge inside build.sh.
//
// THE FIX. Write the new engine to a temporary name IN THE DESTINATION'S OWN DIRECTORY
// (rename(2) is EXDEV across filesystems, so a $TMPDIR staging file would break whichever
// legs do not share a device with outDir), close it, then rename() it into place. POSIX
// rename unlinks the old directory entry rather than truncating the old inode, so a
// process already executing the old image keeps running from it and finishes cleanly.
//
// The two tests below are the two halves of that claim: the OS property the fix rests on,
// proved by running it against a real executing process, and the source actually using it.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { stripComments } = require('./strip-comments.cjs');
const { defineGuard, guardTests } = require('./guard.cjs');

const repo = path.join(__dirname, '..');

// The replacement content. It only has to DIFFER from the running image — the property
// under test is what happens to the process already executing the old bytes, not whether
// the new file runs. (An earlier draft replaced the victim with a byte-identical copy of
// itself and "passed" both halves, proving nothing: nothing in the mapping changed.)
const NEW_BYTES = Buffer.alloc(64 * 1024, 0x7f);

// Replace `dest` in place, the way the tail of scripts/build-tjs.cjs used to. Written as a
// truncating rewrite rather than fs.copyFileSync because "copy the file over" is not ONE
// behavior: node on darwin clones-and-replaces, while libexec/node-shim/modules/fs.cjs
// implements copyFileSync as `writeFileSync(dst, readFileSync(src))` — and the build that
// dies is the node-free one, running under that shim.
function replaceInPlace(dest) {
  try { fs.writeFileSync(dest, NEW_BYTES); fs.chmodSync(dest, 0o755); } catch (e) { return e; }
  return null;
}

// Replace `dest` the way scripts/build-tjs.cjs does now: stage beside it, then rename.
function replaceByRename(dest) {
  const staged = path.join(path.dirname(dest), `.${path.basename(dest)}.new-${process.pid}`);
  fs.writeFileSync(staged, NEW_BYTES);
  fs.chmodSync(staged, 0o755);
  try { fs.renameSync(staged, dest); } catch (e) { fs.rmSync(staged, { force: true }); return e; }
  return null;
}

// Start a victim: a COPY of this node, executing something that outlives the replacement.
// A real executing binary is the whole point — a shell script would be re-read from the
// path by the shell and would prove nothing about a paged-in image.
function runVictim(dir, name) {
  const victim = path.join(dir, name);
  fs.copyFileSync(process.execPath, victim);
  fs.chmodSync(victim, 0o755);
  const child = spawn(victim, ['-e', 'setTimeout(() => process.stdout.write("SURVIVED"), 1500);'],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const done = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  // Let the loader map the image before anything replaces it.
  const started = new Promise((resolve) => setTimeout(resolve, 500));
  return { victim, started, done, read: () => out };
}

// An OS that REFUSES to replace a running image (Linux: ETXTBSY; Windows: the file is
// locked) is not a failure of this test — it is the same protection the fix provides,
// enforced a layer down. These are the codes that mean exactly that.
const LOCKED = new Set(['ETXTBSY', 'EBUSY', 'EPERM', 'EACCES']);

test('replacing a RUNNING executable: in place kills it, rename does not', { timeout: 60000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-install-'));
  try {
    // Half 1 — the defect itself, observed end to end.
    const a = runVictim(dir, 'victim-inplace');
    await a.started;
    const inPlaceErr = replaceInPlace(a.victim);
    const ra = await a.done;
    if (!inPlaceErr) {
      assert.strictEqual(a.read(), '',
        'rewriting a running executable in place left it alive and finishing — if this '
        + 'host really tolerates that, the defect is not reachable here and half 2 below '
        + 'is the only thing under test; investigate rather than relaxing this');
      assert.ok(ra.signal || ra.code !== 0,
        `expected the running victim to be killed, got ${JSON.stringify(ra)}`);
    } else {
      assert.ok(LOCKED.has(inPlaceErr.code),
        `unexpected refusal of the in-place rewrite: ${inPlaceErr.code} ${inPlaceErr.message}`);
    }

    // Half 2 — the fix. rename() either succeeds and the running process finishes, or the
    // OS refuses the rename outright (Windows). What must NEVER happen is a rename that
    // succeeds and still kills the process — which is what a silent fall back to in-place
    // copying, on a platform where rename is refused, would produce.
    const b = runVictim(dir, 'victim-rename');
    await b.started;
    const renameErr = replaceByRename(b.victim);
    const rb = await b.done;
    if (!renameErr) {
      assert.strictEqual(b.read(), 'SURVIVED',
        `rename() over a running executable did not let it finish: ${JSON.stringify(rb)}`);
      assert.strictEqual(rb.code, 0, `victim exited ${JSON.stringify(rb)}`);
    } else {
      assert.ok(LOCKED.has(renameErr.code),
        `unexpected refusal of the rename: ${renameErr.code} ${renameErr.message}`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The source half, as a real guard (test/guard.cjs): it reads an artifact and reports
// findings, so it owes a positive control proving it can fail. The control is the install
// exactly as it was shipped before this fix — if that stops producing findings, this guard
// has gone blind and says so instead of staying green.
const GUARD = defineGuard({
  name: 'engine-install-atomic',
  floor: 4,
  read: () => ({ buildTjs: stripComments(fs.readFileSync(path.join(repo, 'scripts/build-tjs.cjs'), 'utf8')) }),
  // The defect, verbatim from c5b01e6.
  control: () => ({
    buildTjs: "const builtExe = fs.existsSync(path.join(buildDir, 'tjs.exe'));\n"
      + "const outName = builtExe ? 'tjs.exe' : 'tjs';\n"
      + "fs.copyFileSync(path.join(buildDir, builtExe ? 'tjs.exe' : 'tjs'), path.join(outDir, outName));\n"
      + 'fs.chmodSync(path.join(outDir, outName), 0o755);\n',
  }),
  scan: (i) => {
    const findings = [];
    let examined = 0;
    const rule = (ok, finding) => { examined += 1; if (!ok) findings.push(finding); };
    rule(/fs\.renameSync\(staged, installedEngine\)/.test(i.buildTjs),
      'scripts/build-tjs.cjs must rename the staged engine into place');
    rule(/const staged = path\.join\(outDir,/.test(i.buildTjs),
      'the staging path must be inside outDir — rename(2) fails EXDEV across filesystems, '
      + 'so a $TMPDIR staging file would break every leg whose outDir is on another device');
    // Anchored to a write whose DESTINATION is the installed engine, not to copyFileSync
    // in general: build-tjs.cjs legitimately copies the atomic shim into the vendor
    // checkout, and legitimately copies the built binary to `staged`. Whole-file on
    // purpose, so it also catches the tempting Windows fallback — a catch block that
    // quietly copies in place when the rename is refused would reinstate the defect
    // exactly where it is hardest to see.
    rule(!/fs\.(copyFileSync|writeFileSync)\([^;]*?,\s*(installedEngine|path\.join\(outDir, outName\))\s*\)/.test(i.buildTjs),
      'the finished engine is written onto its final path: that truncates the inode a '
      + 'running build may be executing from (Killed: 9 / "smoke failed: engine did not run")');
    rule(!/fs\.chmodSync\((installedEngine|path\.join\(outDir, outName\))/.test(i.buildTjs),
      'chmod belongs on the staged file, before the rename — a chmod on the final path '
      + 'means something wrote to the final path');
    return { findings, examined };
  },
});

guardTests(GUARD);
