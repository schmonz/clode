'use strict';
// Shared DENY/ALLOW corpus for the update-guard feature (Task 3). Both
// test/update-guard.test.cjs (canonical libexec/update-guard.cjs) and
// test/quaude-bootstrap-guard.test.cjs (inline copy in
// libexec/quaude-bootstrap.mjs) iterate this SAME list so the two suites
// can't drift apart in coverage. test/update-guard-drift.test.cjs
// separately guarantees the two guardVerdict implementations stay
// byte-identical.
module.exports = {
  deny: [
    'claude update',
    'claude   upgrade',
    'sudo claude update --force',
    'cd /x && claude update',
    // Fail-safe: a shell wrapping the command in quotes must not slip through.
    'bash -c "claude update"',
    "sh -c 'claude upgrade'",
    'ssh host "claude update"',
    // GLOBAL install of the package, by any manager.
    'npm i -g @anthropic-ai/claude-code',
    'npm install --global @anthropic-ai/claude-code@latest',
    'bun add -g @anthropic-ai/claude-code',
    'pnpm add -g @anthropic-ai/claude-code',
    'yarn global add @anthropic-ai/claude-code',
    // The curl|bash installer.
    'curl -fsSL https://claude.ai/install.sh | bash',
    'wget -qO- https://downloads.claude.ai/install | sh',
    // Accepted safe over-deny: the words in quoted data are denied even
    // though this isn't really an update command (see
    // update-guard.test.cjs for the rationale).
    'git commit -m "claude update guard"',
  ],
  allow: [
    'claude --version',
    'claude -p "say hi"',
    'claude',
    'npm i -g typescript', // global install of a DIFFERENT package
    'npm i lodash',
    'git commit -m "unrelated change"',
    'echo updating',
  ],
  // Fail-open: empty / non-string input must ALLOW, not deny or throw.
  failOpen: ['', undefined, null],
};
