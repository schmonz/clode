'use strict';
// throwawayHome(dir): a HOME, USERPROFILE and CLAUDE_CONFIG_DIR under a test's own temp dir, for a run that needs a home
// of its OWN, distinct from the suite's (grep-native Task 10b fix rounds, rulings G30 and G33).
//
// The whole suite already runs under a throwaway home (test/suite-home.cjs, guarded fail-closed by
// test/suite-home-hermetic.test.cjs), so nothing reaches the developer's ~/.claude by default. This is for runs that
// must not share even that: two sides of a differential, a run whose home is inspected afterwards, a bundle turn
// whose session state must not leak into the next. USERPROFILE too: HOME's spelling on Windows.
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
