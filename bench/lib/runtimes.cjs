'use strict';
const path = require('node:path');
const fs = require('node:fs');

// Default build-dir artifact basenames per runtime. Env overrides win; the
// build-dir probe is the fallback so a plain `npm run bench` finds locally
// built binaries without configuration.
const DEFAULTS = {
  quaude: { envKey: 'QUAUDE_BIN', base: 'quaude' },
  naude: { envKey: 'NAUDE_BIN', base: 'naude' },
  claude: { envKey: 'CLAUDE_BIN', base: 'claude' },
};

function resolveRuntimes({ env = {}, buildDir, existsSync = fs.existsSync }) {
  return Object.entries(DEFAULTS).map(([name, { envKey, base }]) => {
    const override = env[envKey];
    const bin = override || path.join(buildDir, base);
    return { name, bin, present: Boolean(existsSync(bin)) };
  });
}

function presentRuntimes(list) {
  return list.filter((r) => r.present);
}

module.exports = { resolveRuntimes, presentRuntimes, DEFAULTS };
