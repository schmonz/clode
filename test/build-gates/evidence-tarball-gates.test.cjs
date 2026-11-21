'use strict';
// THE EVIDENCE TARBALL CARRIES NO SECRET (memory rule: no secrets in off-box tarballs). scripts/netbsd-arm64-evidence.mjs
// ships the tree to the NetBSD/arm64 VM as a tarball of `git ls-files` only, and refuses one that holds a secret's
// name or anything git does not track (tarballFindings). This holds that rule to the real tree's tracked files, and
// shows it red on a planted gitignored token and an untracked extra.
const { test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { defineGuard, guardTests } = require('../guard.cjs');
const { tarballFindings, SECRET } = require('../../scripts/netbsd-arm64-evidence.mjs');

const REPO = path.resolve(__dirname, '..', '..');

// The tracked files (what the script archives), and the secret-named files really beside them in the repository root
// (where a gitignored clode_gh_token lives): none of those may be tracked, so none is archived.
function readTracked() {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0 || !r.stdout) return { skip: `git ls-files answered nothing here (status ${r.status}): not a git checkout` };
  const files = r.stdout.split('\0').filter(Boolean);
  const beside = fs.readdirSync(REPO).filter((n) => SECRET.test(n));
  return { files, listed: files, beside };
}
// tarballFindings, plus: a secret beside the tree that the archive would carry
function scan({ files, listed, beside = [] }) {
  const r = tarballFindings({ files, listed });
  const inArchive = new Set(listed);
  for (const b of beside) if (inArchive.has(b)) r.findings.push(`${b}: beside the tree AND in the archive`);
  return r;
}

guardTests(defineGuard({
  name: 'evidence-tarball-no-secrets',
  floor: 100,
  read: readTracked,
  scan,
  // The failure this exists for: the gitignored GitHub token beside the tree swept into the archive.
  control: () => ({ files: ['README.md', 'clode_gh_token'], listed: ['README.md', 'clode_gh_token'] }),
}));

test('evidence tarball: an untracked extra, a missing file and every secret name are findings', () => {
  assert.deepStrictEqual(tarballFindings({ files: ['a', 'b'], listed: ['a', 'b'] }).findings, []);
  assert.match(tarballFindings({ files: ['clode_gh_token'], listed: ['clode_gh_token'] }).findings[0], /^clode_gh_token: a secret's name; it must never leave/);
  assert.deepStrictEqual(tarballFindings({ files: ['a'], listed: ['a', '.env'] }).findings, ['.env: in the archive, but not a tracked file (git ls-files)']);
  assert.deepStrictEqual(tarballFindings({ files: ['a', 'b'], listed: ['a'] }).findings, ['b: tracked, but missing from the archive']);
  for (const s of ['clode_gh_token', 'x/.env', '.env.local', 'credentials.json', 'h/.credentials.json', '.netrc', 'k/id_ed25519']) {
    assert.ok(SECRET.test(s), s);
  }
  for (const s of ['test/credential-store-attempted.test.cjs', 'libexec/node-shim/modules/tls-cacert.pem', 'docs/env.md']) {
    assert.ok(!SECRET.test(s), s);
  }
});
