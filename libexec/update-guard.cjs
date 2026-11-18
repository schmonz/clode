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
// THE USER'S --settings (grep-native sandbox round 3, C1 and its fix round 1, I-1). The bundle keeps ONE --settings
// (its eager scanner takes the last occurrence, as commander does), so the guard's own --settings, appended after the
// user's, once discarded the user's whole. The rule for reading it, from the 2.1.283 carve: occurrences are
// `--settings X` and `--settings=X` before any `--`, skipping other options' values (the same scan as hasFlag); the
// last one wins; an empty value loads nothing. A value whose trim starts with '{' and ends with '}' is inline JSON,
// anything else a file path (relative to the working directory). Inline JSON that does not parse, and a file that is
// missing, not a regular file, unreadable or over 2 MiB, make the bundle print its error and exit 1; a file whose
// content is not a JSON object, or that fails the bundle's settings schema (`{"permissions":5}`), is dropped WHOLE
// by the bundle, silently, and the run goes on (measured, native).
//
// So quaude's own keys never ride in the user's file (planGuardDelivery): merged in, a schema-invalid user file took
// them down with it (the update guard, and sandbox.failIfUnavailable: calls after the first ran UNSANDBOXED). With a
// user --settings, that value reaches the bundle UNCHANGED (native's behaviour, errors and drops included) and
// quaude's keys go through layers the bundle loads beside it, each its own (the 2.1.283 carve):
//   - sandbox.failIfUnavailable: `--managed-settings <json>`, the policy tier a parent process hands in. The bundle
//     keeps from it only restrictive values (Mzo; sandbox.failIfUnavailable:true is one, by its own table), above
//     every user, project, local and --settings value, so a user's failIfUnavailable:false stays overridden (D1).
//   - the update guard's PreToolUse hook: `--plugin-dir <dir>`, a session plugin whose hooks/hooks.json holds it
//     (managed settings carry no hooks). Plugin hooks are their own source: a dropped --settings file does not drop
//     them; disableAllHooks and allowManagedHooksOnly govern them as they govern settings hooks.
// Both are only for that case (a user --settings): without one, quaude's keys are its own --settings, inline JSON
// (nothing written to disk by quaude; the bundle stores inline settings itself, as it does for native). Where a
// managed-policy source may exist (it could set disableSideloadFlags, refusing --plugin-dir at startup, and a
// managed-settings file or MDM profile shuts the parent's managed settings out), or the user passed their own
// --managed-settings, quaude falls back to merging into the user's value (planGuardSettings), the one case a
// schema-invalid user file still drops quaude's keys (BACKLOG).
const SETTINGS_FILE_MAX_BYTES = 2097152;
function findOptionArgs(argv, name) {
  const at = [];
  let value;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') break;
    if (typeof a === 'string' && a.startsWith(name + '=')) { at.push([i, 1]); value = a.slice(name.length + 1); continue; }
    if (a === name && i + 1 < argv.length) { at.push([i, 2]); value = argv[i + 1]; i++; continue; }
    i = skipOptionValue(argv, i);
  }
  return at.length ? { value, at } : null;
}
function findSettingsArgs(argv) { return findOptionArgs(argv, '--settings'); }
function settingsIsInline(value) {
  const t = String(value).trim();
  return t.startsWith('{') && t.endsWith('}');
}
// A settings file's bytes as the bundle decodes them: UTF-16LE after an FF FE mark, else UTF-8.
function decodeSettingsBytes(bytes) {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    let out = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) out += String.fromCharCode(bytes[i] | (bytes[i + 1] << 8));
    return out;
  }
  return new TextDecoder('utf-8').decode(bytes);
}
// The settings object the text holds, or null when the bundle would not read one from it. An empty FILE is {}.
function parseSettingsText(text, inline) {
  let t = inline ? String(text).trim() : String(text);
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  if (!inline && t.trim() === '') return {};
  try {
    const v = JSON.parse(t);
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch (_) { return null; }
}
function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
// quaude's settings over the user's: objects merge key by key, arrays concatenate (the user's first: their PreToolUse
// hooks are kept and quaude's run too), any other value of quaude's replaces the user's.
function mergeSettings(user, ours) {
  const out = Object.assign({}, user);
  for (const k of Object.keys(ours)) {
    const u = out[k];
    const v = ours[k];
    if (isPlainObject(u) && isPlainObject(v)) out[k] = mergeSettings(u, v);
    else if (Array.isArray(u) && Array.isArray(v)) out[k] = u.concat(v);
    else out[k] = v;
  }
  return out;
}
// What to hand the bundle. `found` = findSettingsArgs(argv); `fileText` = the user's FILE decoded (a string), or null
// when it could not be used (missing, not a regular file, unreadable, over the limit), or undefined when no file was
// read (no --settings, an empty value, inline JSON). -> { passthrough: true } (argv unchanged: the bundle reports the
// error) | { settings, warning } (settings to write; warning to print, or null).
function planGuardSettings(found, fileText, ours) {
  if (!found || found.value === '') return { settings: ours, warning: null };
  if (settingsIsInline(found.value)) {
    const user = parseSettingsText(found.value, true);
    return user === null ? { passthrough: true } : { settings: mergeSettings(user, ours), warning: null };
  }
  if (fileText === null || fileText === undefined) return { passthrough: true };
  const user = parseSettingsText(fileText, false);
  if (user === null) {
    return { settings: ours, warning: `the --settings file ${found.value} is not a JSON object, so Claude Code skips it`
      + ' and so does quaude: none of its settings apply' };
  }
  return { settings: mergeSettings(user, ours), warning: null };
}
// The index `--` ends options at (argv.length when there is none).
function optionsEnd(argv) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--') return i;
    i = skipOptionValue(argv, i);
  }
  return argv.length;
}
// argv with every user --settings removed and ONE `--settings file`: where the user's last one was, else where options
// end (before a `--`, after which it would be a prompt, not an option).
function withSettingsArg(argv, found, file) {
  const drop = new Set();
  let at = optionsEnd(argv);
  if (found) {
    for (const [i, n] of found.at) for (let k = 0; k < n; k++) drop.add(i + k);
    at = found.at[found.at.length - 1][0];
  }
  const out = [];
  for (let i = 0; i <= argv.length; i++) {
    if (i === at) out.push('--settings', file);
    if (i < argv.length && !drop.has(i)) out.push(argv[i]);
  }
  return out;
}
// Where a managed-policy source may live, as the bundle reads them (the 2.1.283 carve; `providerPlatform` is its baked
// platform, the provider carve's): the managed-settings document and drop-in directory (macOS "/Library/Application
// Support/ClaudeCode", every other platform "/etc/claude-code"), the macOS managed-preferences profiles
// (com.anthropic.claudecode, device and per-user), and a cached server-managed remote-settings.json in the config
// dir. -> { always: true } on Windows (its policy is in the registry, which quaude cannot probe), else { paths }:
// policy may exist when any of them exists, or argv has --managed-settings. Policy can set sandbox.bwrapPath/socatPath
// (sandboxWouldRun), refuse --plugin-dir at startup (disableSideloadFlags), and a managed-settings document or profile
// shuts a parent's managed settings out (first-wins), so quaude then delivers its keys by the path that does not
// depend on any of that (guardDeliveryMode's 'merge').
function policyProbe({ providerPlatform, env }) {
  if (providerPlatform === 'win32') return { always: true, paths: [] };
  const e = env || {};
  const base = providerPlatform === 'darwin' ? '/Library/Application Support/ClaudeCode' : '/etc/claude-code';
  const paths = [base + '/managed-settings.json', base + '/managed-settings.d'];
  if (providerPlatform === 'darwin') {
    paths.push('/Library/Managed Preferences/com.anthropic.claudecode.plist');
    if (e.USER) paths.push('/Library/Managed Preferences/' + e.USER + '/com.anthropic.claudecode.plist');
  }
  paths.push((e.CLAUDE_CONFIG_DIR || ((e.HOME || '') + '/.claude')) + '/remote-settings.json');
  return { always: false, paths };
}
// The session plugin that carries the update guard's hook: its two files, by path inside the plugin directory.
const GUARD_PLUGIN_NAME = 'clode-update-guard';
function guardPluginFiles(hookCommand) {
  return {
    '.claude-plugin/plugin.json': JSON.stringify({
      name: GUARD_PLUGIN_NAME,
      description: 'clode: Claude Code in this binary is rebuilt by clode; the model may not update or reinstall it',
    }) + '\n',
    'hooks/hooks.json': JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: hookCommand }] }] },
    }) + '\n',
  };
}
// How quaude's keys reach the bundle (see "THE USER'S --settings"). `ours` = quaude's settings (hooks, and sandbox
// when required); -> 'own' (no user --settings: ours as the one --settings), 'layers' (a user --settings, left
// unchanged; ours as --managed-settings and --plugin-dir) or 'merge' (the fallback: ours merged into the user's).
function guardDeliveryMode(argv, policyMayOverride) {
  const found = findSettingsArgs(argv);
  if (!found || found.value === '') return 'own';
  if (policyMayOverride || findOptionArgs(argv, '--managed-settings')) return 'merge';
  return 'layers';
}
// argv for 'layers': the user's argv unchanged, plus `--plugin-dir <pluginDir>` and, when sandbox.failIfUnavailable
// is required, `--managed-settings <json>`, where options end (before a `--`).
function withGuardLayers(argv, pluginDir, sandboxRequired) {
  const at = optionsEnd(argv);
  const add = ['--plugin-dir', pluginDir];
  if (sandboxRequired) add.push('--managed-settings', JSON.stringify({ sandbox: { failIfUnavailable: true } }));
  return argv.slice(0, at).concat(add, argv.slice(at));
}
// WHERE NATIVE WOULD SANDBOX (grep-native sandbox round 3, D2; USER: match native). quaude says
// sandbox.failIfUnavailable only where native would actually run the sandbox; elsewhere the bundle's own optional
// branch prints its warning ("Sandbox disabled: ...") and runs commands unsandboxed, as native does, never attempting
// the initialization quaude cannot finish. The bundle's own rule, from the 2.1.283 carve (its baked platform, which
// is the provider carve's: manifest.providerPlatform): macOS always sandboxes (sandbox-exec, no dependency check);
// Linux sandboxes unless /proc/version says WSL1 (/WSL(\d+)/i gives the version, else "microsoft" means 1) or its
// dependency check fails: bubblewrap and socat looked up on PATH (Bun.which), or at sandbox.bwrapPath /
// sandbox.socatPath, which only managed policy sets. quaude cannot read every policy source (server-managed settings, a
// policy helper), so where any might exist (a managed-settings document, a cached remote-settings.json, a
// --managed-settings argument) it keeps the setting: closed, never open. The check's third dependency, ripgrep, is
// quaude's own binary and always present. Every other baked platform keeps the setting too (Windows is unmeasured:
// closed, never open). -> true when quaude must inject sandbox.failIfUnavailable.
function wslVersion(procVersion) {
  if (typeof procVersion !== 'string') return undefined;
  const m = procVersion.match(/WSL(\d+)/i);
  if (m && m[1]) return m[1];
  return procVersion.toLowerCase().includes('microsoft') ? '1' : undefined;
}
function sandboxWouldRun({ providerPlatform, procVersion, hasBwrap, hasSocat, policyMayOverride }) {
  if (providerPlatform !== 'linux') return true;
  if (wslVersion(procVersion) === '1') return false;
  return Boolean((hasBwrap && hasSocat) || policyMayOverride);
}
// <<< guardGating <<<
module.exports = {
  guardVerdict, SUBCOMMANDS, shouldInjectGuard, firstPositional, hasFlag,
  VALUE_OPTIONS, VARIADIC_OPTIONS, OPTIONAL_VALUE_OPTIONS,
  SETTINGS_FILE_MAX_BYTES, findSettingsArgs, settingsIsInline, decodeSettingsBytes, parseSettingsText, mergeSettings,
  planGuardSettings, withSettingsArg, wslVersion, sandboxWouldRun, findOptionArgs, GUARD_PLUGIN_NAME, guardPluginFiles,
  guardDeliveryMode, withGuardLayers, policyProbe,
};
