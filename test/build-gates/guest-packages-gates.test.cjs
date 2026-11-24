'use strict';
// scripts/guest-packages-check.mjs -- the guest-package catalog check, as a registered guard.
//
// The live sweep needs the network and runs in upstream-drift.yml's `guest-packages` job. What can
// run offline, on every suite, is THE FREEBSD 15 CASE: the manifest's real freebsd legs against a
// catalog with the shape FreeBSD 15.x quarterly actually has (`cmake-core`, no `cmake` metapackage).
// The control is the manifest line as it stood when ci run 45354661143's freebsd-amd64 leg died after
// a 15-minute VM boot ("No packages available to install matching 'cmake'"): it must be refused,
// or this is not a guard.
//
// The literal relative require below is what the build-gates population sweep reads to know this
// guard controls scripts/guest-packages-check.mjs (require() of an ES module: node >= 22.12).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { checkPackages, splitPackages, targets } = require('../../scripts/guest-packages-check.mjs');
const { defineGuard, guardTests } = require('../guard.cjs');

const FREEBSD15 = {
  names: new Set(['cmake-core', 'gmake', 'node', 'git', 'bash']),
  origins: new Set(['devel/cmake-core', 'devel/gmake', 'www/node', 'devel/git', 'shells/bash']),
};

const guard = defineGuard({
  name: 'guest-packages-resolve-in-freebsd15-catalog',
  read: () => ({
    legs: targets().map((t) => t.leg).filter((l) => l['guest-platform'] === 'freebsd'),
    catalog: FREEBSD15,
  }),
  scan: ({ legs, catalog }) => ({
    findings: legs.flatMap((leg) => checkPackages({
      leg: leg.leg, tiers: [], style: 'pkg', label: 'FreeBSD:15', catalog, packages: splitPackages(leg),
    }).filter((f) => f.status === 'missing').map((f) => `${f.leg}: '${f.name}' does not resolve`)),
    examined: legs.length,
  }),
  floor: 2,                                   // freebsd-amd64 + freebsd-arm64
  control: () => ({
    legs: [{ leg: 'freebsd-amd64', 'guest-platform': 'freebsd', 'guest-packages': 'cmake gmake node git bash' }],
    catalog: FREEBSD15,
  }),
});
guardTests(guard);

// THE ADAPTERS' PREMISE. The checker resolves names the way the guest's package manager does
// (pkg / pkgin / pkg_add / IPS). If the guest action's install step moves to a different manager or
// verb, the checker would keep answering for the wrong one -- a silent pass. So the install verbs the
// checker's adapters assume are pinned to the action's text.
const installGuard = defineGuard({
  name: 'guest-packages-checker-matches-guest-install-step',
  read: () => ({ yml: fs.readFileSync(path.join(__dirname, '..', '..', '.github/actions/guest/action.yml'), 'utf8') }),
  scan: ({ yml }) => {
    const findings = [];
    const lost = (platform, verb) => findings.push(`${platform}: the guest action no longer installs with \`${verb}\`, which scripts/guest-packages-check.mjs assumes`);
    if (!/pkg install -y \$PKGS/.test(yml)) lost('freebsd/dragonflybsd', 'pkg install -y $PKGS');
    if (!/ASSUME_ALWAYS_YES=YES pkg upgrade -y/.test(yml)) lost('dragonflybsd', 'pkg upgrade -y first (the catalog it installs from is the LATEST one)');
    if (!/pkgin -y install \$PKGS/.test(yml)) lost('netbsd', 'pkgin -y install $PKGS');
    if (!/pkg_add \$PKGS/.test(yml)) lost('openbsd', 'pkg_add $PKGS');
    if (!/pkg install -q "\$p"/.test(yml)) lost('omnios', 'pkg install -q "$p"');
    return { findings, examined: 5 };
  },
  floor: 5,
  control: () => ({ yml: '    - name: Run the guest script\n      run: sudo some-new-manager add $PKGS\n' }),
});
guardTests(installGuard);

test('the control is refused for exactly the package that killed run 45354661143', () => {
  const { legs, catalog } = guard.control();
  const bad = checkPackages({ leg: 'x', tiers: [], style: 'pkg', label: '', catalog, packages: splitPackages(legs[0]) })
    .filter((f) => f.status === 'missing');
  assert.deepStrictEqual(bad.map((f) => f.name), ['cmake']);
});
