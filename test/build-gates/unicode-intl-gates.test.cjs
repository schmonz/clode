'use strict';
// forced-win32: spawn-injected: no test here spawns; it reads the committed header and calls the pure chooseIntl/rulesThrough, never nativeIntl or a native run
// unicode-intl-gates: the build gate over the TABLE-VERSION CHECK (scripts/gen-unicode-data.cjs chooseIntl,
// scripts/lib/native-intl.cjs). libexec/unicode-text.cjs's uax29 profile clusters with tables generated at the
// Unicode version linux native's Intl.Segmenter reports (header.intl, INTL-FOLLOWS-BUNDLED-ICU), and with the
// UAX #29 RULES of that version (UAX29_RULES_THROUGH, gb9cLinkerOnly). Read from the committed header, this holds
// that the version is pinned with the very inputs the header hashes, that it came from the platform whose ICU is
// the bundle's own, and that the rules have been read through it — so tables regenerated at a Unicode whose rules
// nobody implemented (2.1.330's linux ICU moved to 18.0, whose UAX #29 rev 49 rewrote GB9c) go red here by name,
// not as four stray Indic rows in a pty job.
//
// FLOOR: 4 (the header's intl version, platform and its four pinned inputs' hashes, read as one table; each
// check below counts once: pinned, hashes, platform, rules).
// CONTROL: the real header with intl moved to 19.0.0 (unpinned, past the rules) on darwin.
const fs = require('node:fs');
const path = require('node:path');
const { defineGuard, guardTests } = require('../guard.cjs');
const { chooseIntl, rulesThrough } = require('../../scripts/gen-unicode-data.cjs');
const { INTL_PLATFORM, compareVersions } = require('../../scripts/lib/native-intl.cjs');
const ucd = require('../../scripts/lib/ucd.cjs');

const REPO = path.resolve(__dirname, '..', '..');
const TEXT = path.join(REPO, 'libexec', 'unicode-text.cjs');

function headerOf(src) {
  const m = /^const UNICODE_DATA = (\{.*\});$/m.exec(src);
  return m ? JSON.parse(m[1]).header : null;
}

guardTests(defineGuard({
  name: 'unicode-intl-version',
  floor: 4,
  read() {
    const src = fs.readFileSync(TEXT, 'utf8');
    return { header: headerOf(src), through: rulesThrough(src), pins: ucd.pins() };
  },
  scan({ header, through, pins }) {
    const intl = header && header.intl;
    if (!intl) return { examined: 0, findings: ['libexec/unicode-text.cjs\'s header has no intl block'] };
    const findings = [];
    if (!pins[intl.unicode]) findings.push(`header.intl.unicode ${intl.unicode} is not pinned in scripts/unicode-inputs.json`);
    else {
      for (const [name, sha] of Object.entries(intl.ucdSha256 || {})) {
        if (!pins[intl.unicode][name] || pins[intl.unicode][name].sha256 !== sha) findings.push(`header.intl ${intl.unicode}/${name} hashes ${sha}, the pin says otherwise`);
      }
      if (Object.keys(intl.ucdSha256 || {}).length !== 4) findings.push(`header.intl hashes ${Object.keys(intl.ucdSha256 || {}).length} inputs, not the 4 uax29 reads`);
    }
    if (intl.platform !== INTL_PLATFORM) findings.push(`header.intl came from a ${intl.platform} native; uax29 follows ${INTL_PLATFORM}'s bundled ICU`);
    if (compareVersions(intl.unicode, through) > 0) findings.push(`header.intl.unicode ${intl.unicode} is past UAX29_RULES_THROUGH ${through}`);
    // And the generator itself refuses the same table (what a regeneration would have said).
    try { chooseIntl({ unicode: intl.unicode, icu: intl.icu, platform: intl.platform }, header, pins, through); } catch (e) { findings.push(`gen-unicode-data refuses it: ${e.message}`); }
    return { examined: 4, findings };
  },
  control() {
    const header = headerOf(fs.readFileSync(TEXT, 'utf8'));
    return { header: { ...header, intl: { ...header.intl, unicode: '19.0.0', platform: 'darwin' } }, through: '18.0.0', pins: ucd.pins() };
  },
}));
