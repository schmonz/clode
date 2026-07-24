'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A CONSTRUCTED-CLEAN env: nothing from process.env leaks in (mirrors the
// hermetic contract in test/e2e.cjs). Only a POSIX PATH, the mock base URL, a
// dummy key, HOME, and onboarding-skip flags so a one-shot `-p` run does not
// block on first-run UI.
function cleanEnv({ baseUrl, home }) {
  return {
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: home,
    ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_API_KEY: 'sk-bench-dummy',
    // Skip analytics/update/onboarding side effects during a benchmark run.
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CI: '1',
    TERM: 'dumb',
  };
}

function makeWorkspace({ baseUrl }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-ws-'));
  // Seed a minimal config dir so onboarding does not prompt. The exact shape is
  // confirmed by the Task 7 smoke run; start empty and add only what the run
  // demands.
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  const env = cleanEnv({ baseUrl, home: dir });
  return {
    dir,
    env,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

module.exports = { cleanEnv, makeWorkspace };
