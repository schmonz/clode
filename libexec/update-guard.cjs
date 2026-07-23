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
// >>> guardVerdict (canonical; drift-tested against libexec/update-guard.cjs) >>>
const PKG = /@anthropic-ai\/claude-code\b/;
const CLAUDE_UPDATE = /\bclaude\s+(?:update|upgrade)\b/;
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
// <<< guardVerdict <<<
// >>> guardGating (canonical; drift-tested against libexec/quaude-bootstrap.mjs) >>>
// Every subcommand keyword + alias the bundle registers. The update-guard's
// `--settings` is an option of the DEFAULT command only; subcommands reject it
// (and never run the model's Bash tool, so don't need the guard). Kept honest
// against the bundle by test/guard-subcommands-gate.test.cjs.
const SUBCOMMANDS = new Set([
  'add', 'add-from-claude-desktop', 'add-json', 'agents', 'auth', 'auto-mode',
  'autoremove', 'clear', 'config', 'critique', 'defaults', 'details', 'disable',
  'doctor', 'enable', 'eval', 'gateway', 'get', 'i', 'import',
  'import-conversations', 'init', 'install', 'list', 'login', 'logout',
  'marketplace', 'mcp', 'new', 'plugin', 'plugins', 'project', 'prune', 'purge',
  'rc', 'remote-control', 'remove', 'reset', 'reset-project-choices', 'rm',
  'serve', 'setup', 'setup-token', 'show', 'status', 'tag', 'ultrareview',
  'uninstall', 'update', 'upgrade', 'validate', 'xaa',
]);
// Inject the guard --settings only for the default/model command: any -p/--print
// invocation, or one whose first non-flag token is not a subcommand keyword.
function shouldInjectGuard(argv) {
  for (const a of argv) { if (a === '-p' || a === '--print') return true; }
  for (const a of argv) {
    if (typeof a === 'string' && a.charAt(0) === '-') continue;
    return !SUBCOMMANDS.has(a);
  }
  return true;
}
// <<< guardGating <<<
module.exports = { guardVerdict, SUBCOMMANDS, shouldInjectGuard };
