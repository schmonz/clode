'use strict';
// throwawayHome(dir): the HOME and CLAUDE_CONFIG_DIR every test that runs the bundle (quaude, naude, native Claude Code)
// against a model hands it, under that test's own temp dir (grep-native Task 10b fix round, ruling G30).
//
// WHY. These runs used to inherit the developer's real HOME, so the bundle read ~/.claude/settings.json and RAN ITS
// HOOKS (on the dev box an iTerm2 status hook that blocks 30 s per call: ten agentic rows timed out in one suite), and
// WROTE into the real ~/.claude (the headless plugin install restamped ~/.claude/plugins/known_marketplaces.json).
// The guard bundle-runs-own-home (test/bundle-home-hermetic.test.cjs) fails any spawn of the bundle whose env does
// not give it one (test/bundle-spawn-scan.cjs finds the spawns). USERPROFILE too: HOME's spelling on Windows.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function throwawayHome(dir) {
  if (!dir || !path.isAbsolute(String(dir))) throw new Error(`throwawayHome needs the test's own absolute temp dir, got ${JSON.stringify(dir)}`);
  const home = path.join(dir, 'home');
  const cfg = path.join(home, '.claude');
  fs.mkdirSync(cfg, { recursive: true });
  return { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: cfg };
}

// freshHome(prefix): throwawayHome under a new temp dir of its own, for a run with no temp dir at hand.
function freshHome(prefix = 'bundle-home-') {
  return throwawayHome(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

module.exports = { throwawayHome, freshHome };
