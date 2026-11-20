'use strict';
// throwawayHome(dir): a HOME, USERPROFILE and CLAUDE_CONFIG_DIR under a test's own temp dir, for a run that needs a home
// of its OWN, distinct from the suite's (grep-native Task 10b fix rounds, rulings G30 and G33).
//
// The whole suite already runs under a throwaway home (test/suite-home.cjs, guarded fail-closed by
// test/suite-home-hermetic.test.cjs), so nothing reaches the developer's ~/.claude by default. This is for runs that
// must not share even that: two sides of a differential, a run whose home is inspected afterwards, a bundle turn
// whose session state must not leak into the next. USERPROFILE too: HOME's spelling on Windows.
//
// CLAUDE_CODE_TMPDIR too (every-tool Task 3 fix round): Claude Code's per-uid temp dir defaults to /tmp/claude-<uid>,
// shared by every run on the box, the developer's own sessions included. A turn whose Bash tool runs makes a
// directory there named for its cwd, and nothing removed it, so every agentic row left one behind (measured
// 2026-11-19 on this box: 1110 dirs named for a temp cwd, 35 of them agentic-tools' `...-T-agtool-*`). It is a private 0700 dir under the test's own, as the product asks.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function throwawayHome(dir) {
  if (!dir || !path.isAbsolute(String(dir))) throw new Error(`throwawayHome needs the test's own absolute temp dir, got ${JSON.stringify(dir)}`);
  const home = path.join(dir, 'home');
  const cfg = path.join(home, '.claude');
  fs.mkdirSync(cfg, { recursive: true });
  const tmp = path.join(dir, 'claude-tmp');
  fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
  return { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: cfg, CLAUDE_CODE_TMPDIR: tmp };
}

// freshHome(prefix): throwawayHome under a new temp dir of its own, for a run with no temp dir at hand.
function freshHome(prefix = 'bundle-home-') {
  return throwawayHome(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

module.exports = { throwawayHome, freshHome };
