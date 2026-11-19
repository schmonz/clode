'use strict';
// ucd-input.cjs: a pinned Unicode input (scripts/unicode-inputs.json), for a test.
//
// The suite runs under its own throwaway HOME (suite-home.cjs), so the clode cache a test would find there is empty:
// on linux-x64-pty (CI 44460009323) CI's warm-up step had cached every pinned input in the runner's real cache, and all
// six text-diff gates still SKIPPED offline, reading /tmp/clode-test-home-*/.cache/clode/unicode. The real cache is
// handed over as ONE named input, CLODE_TEST_UCD_CACHE (suite-home.cjs), and read here READ ONLY: a copy there is used
// only when it hashes to its pin (scripts/lib/ucd.cjs readOnlyDir), and nothing is ever written there. Otherwise it is
// the suite's own cache as before, and offline (CLODE_OFFLINE=1) a miss is still a UcdOfflineMiss, which the caller
// reports as a skip naming the file. Offline mode is unchanged: nothing here reaches the network.
require('./suite-home.cjs');
const path = require('node:path');
const { clodeCacheDir } = require('../libexec/clode-paths.cjs');
const ucd = require('../scripts/lib/ucd.cjs');

function ucdInputOptions(env = process.env) {
  return {
    cacheDir: path.join(clodeCacheDir(env), 'unicode'),
    offline: env.CLODE_OFFLINE === '1',
    readOnlyDir: env.CLODE_TEST_UCD_CACHE || null,
  };
}
function ucdInput(version, name, env = process.env) {
  return ucd.fetchVerified(version, name, ucdInputOptions(env));
}

module.exports = { ucdInput, ucdInputOptions };
