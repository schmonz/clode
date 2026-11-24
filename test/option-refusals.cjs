'use strict';
// The default path takes no refused option. node-shim and bun-shim refuse an option they cannot apply by THROWING
// (libexec/node-shim/internal/options.cjs optionError, libexec/bun-shim.cjs _bunOptionError), and the bundle often
// swallows the throw: refusing the bundle's own http.Agent `timeout` (2026-11-23) silenced every `-p` turn, which
// exited 0 with empty stdout and no error anywhere. Each census row proved its option in isolation; nothing drove the
// bundle with the refusals in place. So both shims append every refusal they raise to CLODE_SHIM_REFUSAL_LOG, and a
// turn on the default path (the mock `-p` round-trip, the agentic Bash turn) runs with it set and must leave it EMPTY:
// a refusal there is a bug in the refusal (honour the option), never in the bundle.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

// env to merge into a turn's spawn env, and the check to run after it
function refusalRecorder(dir, label) {
  const file = path.join(dir, `refusals-${process.pid}-${process.hrtime.bigint()}.jsonl`);
  return {
    file,
    env: { CLODE_SHIM_REFUSAL_LOG: file },
    read() {
      if (!fs.existsSync(file)) return [];
      return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    },
    assertNone() {
      const got = this.read();
      assert.deepStrictEqual(got.map((r) => `${r.entry} '${r.option}' (${r.code}) at ${(r.frames || []).slice(0, 4).join(' < ')}`), [],
        `${label}: the default path took a REFUSED option. The bundle may have swallowed the throw (a silent turn); `
        + 'honour the option instead (libexec/node-shim/internal/options.cjs or libexec/bun-shim.cjs BUN_OPTION_TABLES)');
    },
  };
}

module.exports = { refusalRecorder };
