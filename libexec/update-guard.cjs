'use strict';
// guardVerdict — the model, running INSIDE a target, must not update/reinstall
// Claude Code: a baked target's Claude Code is fixed in its bytecode/SEA, and
// clode rebuilds it for real via the update callback. Given a Bash command
// string, return the PreToolUse deny-JSON when it is a model-issued
// Claude-Code update/reinstall, else null (allow). PURE — no I/O.
//
// THIS IS THE CANONICAL COPY. esbuild inlines it into naude-entry.bundle.cjs.
// quaude-bootstrap.mjs (raw-compiled, no runtime imports) carries a
// BYTE-IDENTICAL inline copy; test/update-guard-drift.test.cjs enforces that.
// If you change the logic here, change it there too — the drift test will fail
// otherwise.
const PKG = /@anthropic-ai\/claude-code\b/;
const CLAUDE_UPDATE = /(?<!["'])\bclaude\s+(?:update|upgrade)\b/;
const INSTALLER = /\b(?:curl|wget)\b[^\n|]*\|[^\n]*\b(?:sh|bash)\b/;
function guardVerdict(command, opts) {
  const cmd = typeof command === 'string' ? command : '';
  const globalInstall = PKG.test(cmd)
    && (/(?:^|\s)(?:-g|--global)(?=\s|$)/.test(cmd) || /\byarn\s+global\s+add\b/.test(cmd));
  const installer = INSTALLER.test(cmd) && (PKG.test(cmd) || /claude/i.test(cmd));
  if (!(CLAUDE_UPDATE.test(cmd) || globalInstall || installer)) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        'clode manages Claude Code for this binary — it rebuilds itself to a '
        + 'newer version automatically when upstream ships one (restart to apply). '
        + '`claude update` / reinstalling will not change this binary (it targets a '
        + 'separate install).',
    },
  };
}
module.exports = { guardVerdict };
