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
  'autoremove', 'clear', 'config', 'critique', 'defaults', 'design-login', 'details',
  'disable', 'doctor', 'edit-chrome-settings', 'edit-hook', 'edit-memory-settings',
  'edit-permission-rules', 'edit-sandbox-settings', 'edit-skill-overrides', 'enable',
  'eval', 'gateway', 'get', 'i', 'import',
  'import-conversations', 'init', 'install', 'kill', 'list', 'login', 'logout',
  'marketplace', 'mcp', 'new', 'plugin', 'plugins', 'project', 'prune', 'purge',
  'rc', 'remote-control', 'remove', 'reset', 'reset-project-choices', 'rm',
  'sandbox', 'serve', 'setup', 'setup-token', 'show', 'status', 'tag',
  'ultrareview', 'uninstall', 'update', 'upgrade', 'validate', 'xaa',
]);
// THE BUNDLE'S OWN ARGV RULE (grep-native sandbox round 3, I1). Which tokens are option VALUES decides where the
// first positional is, and so whether argv names a subcommand: `quaude --add-dir config` is the model command with
// one added directory, not `config`. These tables are the bundle's own: its eager argv scanner's three sets (the
// option that takes a value, the variadic ones that take values up to the next flag, the ones whose value is
// optional and taken only when the next token is not a flag), plus the commander root options that take a value
// and are missing from that scanner (2.1.283: --attach-serve, --project-config-root). A hand copy, so
// test/guard-subcommands-gate.test.cjs derives all of it from the pinned carve and goes red on any difference.
// Measured on native 2.1.283: `claude --debug auto-mode --help` and `claude --add-dir config auto-mode --help`
// print the ROOT help (the option took the token); `claude --verbose auto-mode --help` prints auto-mode's.
const VALUE_OPTIONS = new Set([
  '--prefill', '--prefill-b64', '--deep-link-repo', '--deep-link-last-fetch', '--deep-link-cwd-b64', '--handle-uri',
  '--settings', '--managed-settings', '--setting-sources', '--client-data-url', '--watch-artifact',
  '--watch-artifact-no-autoreact', '--team-name', '--agent-id', '--agent-name', '--agent-color', '--parent-session-id',
  '--agent-type', '--model', '--agent', '--routine', '--effort', '--permission-mode', '--inherit-permission-mode',
  '--proactivity', '--debug-file', '--system-prompt', '--system-prompt-file', '--append-system-prompt',
  '--append-system-prompt-file', '--system-prompt-snapshot', '--append-subagent-system-prompt',
  '--append-subagent-system-prompt-file', '--plan-mode-instructions', '--permission-prompt-tool',
  '--permission-prompts', '--json-schema', '--fallback-model', '--advisor', '--agents', '--name', '-n',
  '--allowedTools', '--allowed-tools', '--disallowedTools', '--disallowed-tools', '--tools', '--add-dir',
  '--mcp-config', '--betas', '--file', '--channels', '--dangerously-load-development-channels', '--plugin-dir',
  '--plugin-dir-no-mcp', '--plugin-url', '--remote-control-session-name-prefix', '--sdk-url', '--exec', '-m',
  '--thinking', '--thinking-display', '--max-thinking-tokens', '--max-turns', '--max-budget-usd', '--task-budget',
  '--autocompact', '--rewind-files', '--resume-session-at', '--resume-drops-turn', '--workload', '--output-format',
  '--input-format', '--teammate-mode', '--messaging-socket-path', '--session-id', '--environment', '--pool', '--ref',
  '--on-branch', '--correlation-id', '--forward-home-settings',
  '--attach-serve', '--project-config-root',
]);
const VARIADIC_OPTIONS = new Set([
  '--allowedTools', '--allowed-tools', '--disallowedTools', '--disallowed-tools', '--tools', '--add-dir',
  '--mcp-config', '--betas', '--file', '--channels', '--dangerously-load-development-channels',
]);
const OPTIONAL_VALUE_OPTIONS = new Set([
  '-d', '--debug', '-r', '--resume', '--from-pr', '-w', '--worktree', '--teleport', '--cloud', '--remote',
  '--project', '--remote-control', '--rc', '--prompt-suggestions',
]);
// A flag is any token longer than one character that starts with '-' (a lone '-' is a positional).
function isFlagToken(a) { return typeof a === 'string' && a.length > 1 && a.charAt(0) === '-'; }
// The index of the last token option argv[i] consumes (i itself when it takes no value).
function skipOptionValue(argv, i) {
  const t = argv[i];
  if (OPTIONAL_VALUE_OPTIONS.has(t)) return argv[i + 1] !== undefined && !isFlagToken(argv[i + 1]) ? i + 1 : i;
  if (!VALUE_OPTIONS.has(t)) return i;
  let r = i + 1;
  if (VARIADIC_OPTIONS.has(t)) while (r + 1 < argv.length && !isFlagToken(argv[r + 1])) r++;
  return r;
}
// The first positional (the subcommand, if argv names one); after `--` it is the next token.
function firstPositional(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--') return argv[i + 1];
    if (!isFlagToken(argv[i])) return argv[i];
    i = skipOptionValue(argv, i);
  }
  return undefined;
}
// Whether flag `name` is present as a flag (not as another option's value), before any `--`.
function hasFlag(argv, name) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--') return false;
    if (argv[i] === name) return true;
    i = skipOptionValue(argv, i);
  }
  return false;
}
// Inject the guard --settings only for the default/model command: any -p/--print invocation, or one whose first
// positional is not a subcommand keyword.
function shouldInjectGuard(argv) {
  if (hasFlag(argv, '-p') || hasFlag(argv, '--print')) return true;
  const first = firstPositional(argv);
  return first === undefined || !SUBCOMMANDS.has(first);
}
// <<< guardGating <<<
module.exports = {
  guardVerdict, SUBCOMMANDS, shouldInjectGuard, firstPositional, hasFlag,
  VALUE_OPTIONS, VARIADIC_OPTIONS, OPTIONAL_VALUE_OPTIONS,
};
