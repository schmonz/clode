'use strict';
// Two guards over unpacking: libexec/unpack.cjs's refusals (GUARD 1, below the second), and no
// host archive tool anywhere in shipped code (GUARD 2, first).
//
// GUARD 2 — NO HOST ARCHIVE TOOL IN SHIPPED CODE.
//
// Every archive clode reads goes through libexec/unpack.cjs (one gunzip over node:zlib, which is
// the engine's miniz under tjs; a tar reader; a zip reader), and the one archive it writes,
// naude's deps.tar, through scripts/tar-pack.cjs. Before that, unpacking was three host tools
// found by host-provision.cjs (tar, gzip, unzip) plus a DecompressionStream fallback, and the
// two pinned-download seams disagreed about .zip: clode-node ran `unzip`, which Windows does not
// ship, and clode-rcodesign ran `tar -xf`, which GNU tar cannot read
// (docs/superpowers/findings/2026-11-27-latent-capabilities-audit.md, D3).
//
// THE CLASS, not the instance: any spawn of a tar/gzip/unzip-family program by name in libexec/
// (shipped) or scripts/ (the build path, which a published clode carries pieces of), whether as
// a spawn argument (`spawnSync('tar', ...)`) or a command string (`'unzip -o ...'`). A
// provision('tar'|'gzip'|'unzip') is already refused by host-provision-gates' unknown-requirement
// guard, since those ids left the registry.
//
// The literal relative require below is load-bearing for the population sweep (guards-population.cjs).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeEntries } = require('../../libexec/unpack.cjs');
const { defineGuard, guardTests } = require('../guard.cjs');
const { stripLineComments, discoverFilesByExt } = require('../source-scan.cjs');

const REPO = path.resolve(__dirname, '..', '..');

// Developer harnesses that pack the checkout into a tarball and ship it to a remote box over
// ssh; neither is on any clode build path, and the box they ship to has its own tar.
const EXCLUDED = {
  'scripts/first-run.mjs': 'dev harness: packs the checkout to drive a first run on a remote box',
  'scripts/netbsd-arm64-evidence.mjs': 'dev harness: ships `git ls-files` to the local NetBSD VM',
};

const TOOLS = 'tar|gtar|bsdtar|gzip|gunzip|zcat|pigz|unzip';
const SPAWN_RE = new RegExp(String.raw`\b(?:spawn|spawnSync|execFile|execFileSync|exec|execSync|spawnRun|sh|run)\(\s*['"\x60](${TOOLS})['"\x60]`, 'g');
const COMMAND_RE = new RegExp(String.raw`['"\x60](${TOOLS}) -[A-Za-z]`, 'g');

function readSources() {
  const files = [
    ...discoverFilesByExt(path.join(REPO, 'libexec'), ['.cjs', '.js', '.mjs']),
    ...discoverFilesByExt(path.join(REPO, 'scripts'), ['.cjs', '.js', '.mjs']),
  ];
  return {
    sources: files
      .map((f) => ({ rel: path.relative(REPO, f).split(path.sep).join('/'), file: f }))
      .filter((s) => !EXCLUDED[s.rel])
      .map((s) => ({ rel: s.rel, text: stripLineComments(fs.readFileSync(s.file, 'utf8')) })),
  };
}

function scanHostArchiveTool({ sources }) {
  const findings = [];
  for (const s of sources) {
    for (const re of [SPAWN_RE, COMMAND_RE]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(s.text))) {
        findings.push(`${s.rel}: runs the host '${m[1]}' (${JSON.stringify(m[0])}); read archives with libexec/unpack.cjs (gunzip, readTar, readZip, extractArchive) and write tars with scripts/tar-pack.cjs`);
      }
    }
  }
  return { findings, examined: sources.length };
}

// Measured 2026-11-27: 96 .cjs/.js/.mjs files under libexec and ~150 under scripts. The floor is
// far above a broken walk, which would find a handful or none.
guardTests(defineGuard({
  name: 'no-host-archive-tool',
  floor: 150,
  read: readSources,
  scan: scanHostArchiveTool,
  // the defect as it was in build-naude.mjs, and the command-string shape. (The provision-resolved
  // spawns, `spawn(tarBin, ...)`, were reached through provision('tar'), which the
  // unknown-requirement guard now refuses.)
  control: () => ({
    sources: [
      { rel: 'scripts/build-naude.mjs', text: "const archive = execFileSync('tar', ['-cf', '-', 'node_modules'], { cwd: parent });" },
      { rel: 'libexec/x.cjs', text: "execSync(`gzip -dc ${f}`);" },
    ],
  }),
}));

const { test } = require('node:test');
const assert = require('node:assert');

test('no-host-archive-tool: each shape is recognised on its own, and prose is not a spawn', () => {
  const one = (text) => scanHostArchiveTool({ sources: [{ rel: 's.cjs', text }] }).findings.length;
  assert.strictEqual(one("spawnSync('tar', ['-xf', a])"), 1);
  assert.strictEqual(one("execFileSync(\"bsdtar\", args)"), 1);
  assert.strictEqual(one("run('unzip -o -q a.zip')"), 1);   // a command string
  assert.strictEqual(one("const cmd = 'gunzip -c f.gz';"), 1);
  assert.strictEqual(one("const kind = 'tar.gz'; // unpack reads a tar"), 0);
  assert.strictEqual(one("throw new Error('install tar, or set CLODE_TAR')"), 0);
});

// ==========================================================================
// GUARD 1 — EVERY ARCHIVE ENTRY LANDS UNDER THE DESTINATION, OR THE EXTRACTION REFUSES.
// ==========================================================================
//
// A downloaded archive is untrusted until its sha256 matches the pin, and naude unpacks deps.tar
// on every cold launch, so libexec/unpack.cjs's writeEntries refuses an entry that would land
// outside the destination: an absolute name, a `..` segment, or a path through a symlink the same
// extraction just made (the classic tar escape: `esc -> /somewhere`, then `esc/planted`). Host tar
// and unzip refuse these by default; when the extraction moved in process those refusals became
// ours to keep. The scan runs the REAL writeEntries over each hostile entry list in a throwaway
// directory and reports every one that was written without a refusal. The control hands the same
// cases to a writer with the checks taken out, the shape the code would have if they were lost.
function hostileCases() {
  const file = (name) => ({ name, type: 'file', mode: 0o644, data: Buffer.from('x') });
  const cases = [
    { what: 'an absolute POSIX name', entries: [file('/clode-unpack-guard-escape')] },
    { what: 'a drive-letter name', entries: [file('C:/clode-unpack-guard-escape')] },
    { what: 'a .. segment', entries: [file('a/../../clode-unpack-guard-escape')] },
  ];
  if (process.platform !== 'win32') {
    cases.push({ what: 'a path through a symlink the extraction made', entries: (outside) => [
      { name: 'esc', type: 'symlink', mode: 0o777, linkname: outside },
      file('esc/planted'),
    ] });
  }
  return cases;
}

function scanEscapes({ cases, write }) {
  const findings = [];
  for (const c of cases) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-unpack-guard-'));
    const dest = path.join(base, 'dest');
    const outside = path.join(base, 'outside');
    fs.mkdirSync(outside, { recursive: true });
    try {
      const entries = typeof c.entries === 'function' ? c.entries(outside) : c.entries;
      let refused = false;
      try { write(entries, dest); } catch { refused = true; }
      if (!refused) findings.push(`${c.what}: extracted without a refusal`);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
      try { fs.rmSync('/clode-unpack-guard-escape', { force: true }); } catch { /* not ours to have made */ }
    }
  }
  return { findings, examined: cases.length };
}

// A writer with every check taken out: names joined onto the destination as they come. The
// absolute and drive-letter cases it "extracts" are kept inside the throwaway directory (joined,
// not resolved), so the control can never write outside it either.
function naiveWrite(entries, dest) {
  for (const e of entries) {
    const target = path.join(dest, e.name.replace(/^[A-Za-z]:/, ''));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (e.type === 'symlink') fs.symlinkSync(e.linkname, target);
    else fs.writeFileSync(target, e.data);
  }
}

guardTests(defineGuard({
  name: 'unpack-stays-in-destination',
  floor: 3,
  read: () => ({ cases: hostileCases(), write: writeEntries }),
  scan: scanEscapes,
  control: () => ({ cases: hostileCases(), write: naiveWrite }),
}));
