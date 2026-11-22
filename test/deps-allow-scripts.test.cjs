'use strict';
// Every install script our committed lockfiles carry is APPROVED in the manifest beside them.
//
// npm 11.x blocks dependency install scripts unless package.json's allowScripts names the
// package (`npm help install-scripts`), and only WARNS that it skipped them — `npm ci` still
// exits 0. A full-suite run on 2026-11-22 hit it cold: scripts/build-clode-main.mjs copied
// deps/clode/package.json into an empty $TMPDIR toolchain dir, `npm ci` skipped esbuild's
// postinstall ("not yet covered by allowScripts: esbuild@0.28.2"), and ensureToolchain died
// with "esbuild does not load ... even after `npm ci` reported success". It passed alone only
// because the toolchain dir was warm. Older npm ignores the field, so one manifest serves both.
//
// DERIVED, not listed: the set to approve is every lockfile entry npm itself marks
// hasInstallScript, and the approval must name THAT version (npm's own pinned form,
// `npm install-scripts approve` writes pkg@x.y.z) or the bare name. A Renovate bump of
// esbuild that leaves the pin at the old version is exactly the cold-box failure again.
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { defineGuard, guardTests } = require('./guard.cjs');

const DEPS = path.join(__dirname, '..', 'deps');

// PURE. pairs: [{ dir, manifest, lock }] already parsed.
function scanAllowScripts(pairs) {
  const findings = [];
  let examined = 0;
  for (const { dir, manifest, lock } of pairs) {
    const allow = manifest.allowScripts || {};
    for (const [key, entry] of Object.entries(lock.packages || {})) {
      if (!entry.hasInstallScript || !key) continue;
      examined++;
      const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
      const pinned = `${name}@${entry.version}`;
      if (allow[pinned] === true || allow[name] === true) continue;
      findings.push(`deps/${dir}: ${pinned} has an install script the lockfile records, but `
        + `deps/${dir}/package.json's allowScripts does not approve ${pinned} — npm 11 skips it `
        + `on a cold install and still exits 0. Fix: cd into a copy of deps/${dir} and run `
        + `\`npm install-scripts approve ${name}\`, then copy the manifest back.`);
    }
  }
  return { findings, examined, note: 'lockfile entries marked hasInstallScript, across deps/*' };
}

const guard = defineGuard({
  name: 'deps-install-scripts-approved',
  read() {
    const pairs = [];
    for (const dir of fs.readdirSync(DEPS)) {
      const m = path.join(DEPS, dir, 'package.json');
      const l = path.join(DEPS, dir, 'package-lock.json');
      if (!fs.existsSync(m) || !fs.existsSync(l)) continue;
      pairs.push({ dir, manifest: JSON.parse(fs.readFileSync(m, 'utf8')), lock: JSON.parse(fs.readFileSync(l, 'utf8')) });
    }
    return pairs;
  },
  scan: scanAllowScripts,
  // The real shape that bit: the pin left one version behind the lockfile.
  control: () => [{
    dir: 'clode',
    manifest: { allowScripts: { 'esbuild@0.28.1': true } },
    lock: { packages: { '': {}, 'node_modules/esbuild': { version: '0.28.2', hasInstallScript: true } } },
  }],
});

guardTests(guard);

test('deps-install-scripts-approved: a bare-name approval also covers it', () => {
  const r = scanAllowScripts([{
    dir: 'x',
    manifest: { allowScripts: { esbuild: true } },
    lock: { packages: { 'node_modules/esbuild': { version: '9.9.9', hasInstallScript: true } } },
  }]);
  if (r.findings.length || r.examined !== 1) throw new Error(JSON.stringify(r));
});
