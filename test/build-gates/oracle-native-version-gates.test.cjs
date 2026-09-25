'use strict';
// The build gate inside `scripts/oracle-native-version.cjs`: the version CI installs as its
// TEXT ORACLE native (linux-x64-pty's "Install the TEXT ORACLE native" step), read from the
// header libexec/unicode-text.cjs's generated table carries.
//
// WHY A GUARD. The script derives a version from bytes and REFUSES (exit 2) when it cannot,
// so the production-gate sweep (test/guards-population.cjs) counted it gate-shaped the day
// it landed, and it was right to: a CI step that cannot name its oracle must fail rather
// than `npm i ...@undefined`, and one that names the WRONG oracle is worse — every text gate
// then SKIPS (ruling R11) and the job goes green having judged nothing. This is the control.
//
// WHAT IS PROVEN. read(): the real header parses to exactly the version the loaded module's
// UNICODE_DATA names (its first word, derived independently of the script's regex).
// control(): a file with no generated region and a header naming no version, both of which
// the script must refuse.
//
// The literal relative require below is load-bearing for the production-gate population
// sweep, which derives "which guard controls this production gate" from that string.
// libexec/unicode-text.cjs is loaded through a path variable instead: it is a FIXTURE here
// (the independent reading), not a module this guard controls.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const assert = require('node:assert');
const { defineGuard, guardTests } = require('../guard.cjs');
const { oracleNativeVersion } = require('../../scripts/oracle-native-version.cjs');

const REPO = path.resolve(__dirname, '..', '..');
const TABLE = path.join(REPO, 'libexec', 'unicode-text.cjs');
const CLI = path.join(REPO, 'scripts', 'oracle-native-version.cjs');

function scan({ cases }) {
  const findings = [];
  for (const c of cases) {
    let got;
    try { got = oracleNativeVersion(c.src); } catch (e) { findings.push(`${c.what}: refused — ${e.message}`); continue; }
    if (got !== c.want) findings.push(`${c.what}: names ${JSON.stringify(got)}, but its header says ${JSON.stringify(c.want)}`);
  }
  return { findings, examined: cases.length, note: 'generated headers read' };
}

guardTests(defineGuard({
  name: 'oracle-native-version',
  floor: 1,
  read() {
    const { UNICODE_DATA } = require(TABLE);
    return { cases: [{ what: 'libexec/unicode-text.cjs', src: fs.readFileSync(TABLE, 'utf8'),
      want: String(UNICODE_DATA.header.nativeClaude).split(' ')[0] }] };
  },
  scan,
  // Both refusals, in the shapes they would really take: a table whose generated region is
  // gone (a hand edit, a failed splice) and a generator run whose native answered nothing.
  control: () => ({ cases: [
    { what: 'no generated region', src: "'use strict';\nmodule.exports = {};\n", want: '2.1.278' },
    { what: 'a header naming no version', src: 'const UNICODE_DATA = {"header":{"nativeClaude":""}};\n', want: '2.1.278' },
  ] }),
}));

test('the CLI prints the bare version CI passes to npm, and nothing else', () => {
  const r = spawnSync(process.execPath, [CLI], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\d+\.\d+\.\d+\n$/);
});
