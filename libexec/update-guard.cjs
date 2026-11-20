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
// managed-policy source may exist (Windows and WSL always), quaude ALSO merges its keys into the user's value
// (planGuardSettings), belt and braces, because policy can shut the parent's managed settings out (a managed-settings
// document or profile, first-wins). Policy can also refuse --plugin-dir at startup (disableSideloadFlags): quaude then
// fails CLOSED, refusing to start where native starts (accepted, controller ruling). The one residual: policy that
// shuts the parent slice out AND a schema-invalid user --settings file AND the sandbox enabled: the hook survives (the
// plugin), sandbox.failIfUnavailable does not (BACKLOG).
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
// dir. -> { always: true } on Windows (its policy is in the registry, which quaude cannot probe) and under WSL
// (`procVersion`, /proc/version: it inherits Windows' policy), else { paths }:
// policy may exist when any of them exists. This drives delivery only (guardDeliveryMode); whether the sandbox would
// run reads evidence instead (sandboxEvidencePaths, fix round 3). Policy can refuse --plugin-dir at startup
// (disableSideloadFlags), and a managed-settings document or profile shuts a parent's managed settings out
// (first-wins), so quaude then delivers its keys by the path that does not depend on any of that ('merge').
function policyProbe({ providerPlatform, env, procVersion }) {
  if (providerPlatform === 'win32') return { always: true, paths: [] };
  // WSL inherits Windows' admin policy (the registry, the Windows-side managed-settings file), which quaude cannot
  // probe from inside it: "may".
  if (providerPlatform === 'linux' && wslVersion(procVersion) !== undefined) return { always: true, paths: [] };
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
// How quaude's keys reach the bundle (see "THE USER'S --settings"). -> 'own' (no user --settings: quaude's settings
// as the one --settings), 'layers' (a user --settings, left unchanged; quaude's keys as --plugin-dir and
// --managed-settings beside it) or 'merge' (quaude's settings merged into the user's --settings AND the layers, belt
// and braces: fix round 2, controller ruling). 'merge' is where the layers alone may not hold: admin policy may exist
// (`policyMayOverride`: it can shut the parent's managed settings out, or refuse --plugin-dir, failing closed), or the
// user's own --managed-settings is not a JSON object (the bundle ignores it, so quaude cannot merge into it).
function guardDeliveryMode(argv, policyMayOverride) {
  const found = findSettingsArgs(argv);
  if (!found || found.value === '') return 'own';
  if (policyMayOverride) return 'merge';
  const m = findOptionArgs(argv, '--managed-settings');
  if (m && parseManagedSettings(m.value) === null) return 'merge';
  return 'layers';
}
// A --managed-settings value as the bundle reads it (J6o: JSON of the trimmed value, which must be an object), or null.
function parseManagedSettings(value) {
  try {
    const v = JSON.parse(String(value).trim());
    return isPlainObject(v) ? v : null;
  } catch (_) { return null; }
}
// argv with the layers added, where options end (before a `--`): `--plugin-dir <pluginDir>` (the guard's hook) and,
// when sandbox.failIfUnavailable is required, `--managed-settings <json>`. The bundle keeps ONE --managed-settings (the
// last), so a user's own is not displaced: failIfUnavailable is merged into it, in place (their keys kept, ours the
// restrictive value). A user value that is not a JSON object is left as it is (the bundle ignores it and says so,
// as native does); then quaude's value rides only in the merged --settings ('merge').
function withGuardLayers(argv, pluginDir, sandboxRequired) {
  const FIU = { sandbox: { failIfUnavailable: true } };
  let out = argv.slice();
  const add = ['--plugin-dir', pluginDir];
  if (sandboxRequired) {
    const m = findOptionArgs(out, '--managed-settings');
    if (!m) add.push('--managed-settings', JSON.stringify(FIU));
    else {
      const theirs = parseManagedSettings(m.value);
      if (theirs !== null) {
        const [i, n] = m.at[m.at.length - 1];
        const merged = JSON.stringify(mergeSettings(theirs, FIU));
        if (n === 1) out[i] = '--managed-settings=' + merged;
        else out[i + 1] = merged;
      }
    }
  }
  const at = optionsEnd(out);
  return out.slice(0, at).concat(add, out.slice(at));
}
// WHERE NATIVE WOULD SANDBOX (grep-native sandbox round 3, D2; USER: match native). quaude says
// sandbox.failIfUnavailable only where native would actually run the sandbox; elsewhere the bundle's own optional
// branch prints its warning ("Sandbox disabled: ...") and runs commands unsandboxed, as native does, never attempting
// the initialization quaude cannot finish. The bundle's own rule, from the 2.1.283 carve (its baked platform, which
// is the provider carve's: manifest.providerPlatform): macOS always sandboxes (sandbox-exec, no dependency check);
// Linux sandboxes unless /proc/version says WSL1 (/WSL(\d+)/i gives the version, else "microsoft" means 1) or its
// dependency check fails: bubblewrap and socat looked up on PATH (Bun.which), or at sandbox.bwrapPath /
// sandbox.socatPath, which only managed policy sets. Windows sandboxes only behind a gate (Eb -> sX): the env
// CLAUDE_CODE_NANKEEN_KESTREL, truthy by the bundle's rule (envTruthy), or the server gate tengu_nankeen_kestrel
// (default off), which quaude reads where the bundle caches it (nankeenGateCached). The check's third dependency,
// ripgrep, is quaude's own binary and always present. Every other baked platform keeps the setting (closed, never
// open). -> true when quaude must inject sandbox.failIfUnavailable.
//
// Whether policy may point at bwrap/socat (`policyMaySetDeps`) is EVIDENCE only (fix round 3), never the "may exist"
// of policyProbe: that one drives guardDeliveryMode, and is "always" on WSL, where every box without the deps would
// then refuse to start while native warns and runs. Evidence is: a policy source quaude can see (sandboxEvidencePaths)
// exists, or the user's own --managed-settings carries sandbox.bwrapPath or sandbox.socatPath
// (managedSettingsSetsDeps). quaude cannot read every policy source (the Windows registry from WSL, a policy helper),
// so where one of those alone sets the paths, quaude says nothing and the bundle's own check decides: native's warning.
function wslVersion(procVersion) {
  if (typeof procVersion !== 'string') return undefined;
  const m = procVersion.match(/WSL(\d+)/i);
  if (m && m[1]) return m[1];
  return procVersion.toLowerCase().includes('microsoft') ? '1' : undefined;
}
// The bundle's truthy-env rule (Le): "1", "true", "yes", "on", any case, trimmed.
function envTruthy(v) {
  if (!v) return false;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase().trim());
}
// The bundle's global config, where it caches server gates (cachedGrowthBookFeatures): the legacy
// <config dir>/.config.json when it exists, else <CLAUDE_CONFIG_DIR or home>/.claude[-custom-oauth].json (2.1.283
// carve, qs/ea). -> [legacy, config]; the first that exists is the one the bundle reads.
function globalConfigCandidates(env) {
  const e = env || {};
  const home = e.USERPROFILE || e.HOME || '';
  const suffix = e.CLAUDE_CODE_CUSTOM_OAUTH_URL ? '-custom-oauth' : '';
  return [(e.CLAUDE_CONFIG_DIR || (home + '/.claude')) + '/.config.json',
    (e.CLAUDE_CONFIG_DIR || home) + '/.claude' + suffix + '.json'];
}
// Whether the bundle's cached copy of the gate is on, from the global config's text (as the bundle's x(): the value
// itself, in a boolean context). Unreadable or absent: off, the gate's default.
function nankeenGateCached(configText) {
  try {
    const c = JSON.parse(configText);
    return Boolean(c && c.cachedGrowthBookFeatures && c.cachedGrowthBookFeatures.tengu_nankeen_kestrel);
  } catch (_) { return false; }
}
// The policy sources quaude can see that could set sandbox.bwrapPath/socatPath on Linux: the managed-settings document
// and drop-ins, the cached server-managed remote-settings.json, and under WSL the Windows-side managed-settings the
// bundle inherits (OD, "/mnt/c/Program Files/ClaudeCode"). Not the registry (HKLM\SOFTWARE\Policies\ClaudeCode,
// read through reg.exe): quaude does not run reg.exe at every start, a residual (BACKLOG).
function sandboxEvidencePaths({ providerPlatform, env, procVersion }) {
  if (providerPlatform !== 'linux') return [];
  const e = env || {};
  const paths = ['/etc/claude-code/managed-settings.json', '/etc/claude-code/managed-settings.d',
    (e.CLAUDE_CONFIG_DIR || ((e.HOME || '') + '/.claude')) + '/remote-settings.json'];
  if (wslVersion(procVersion) !== undefined) {
    paths.push('/mnt/c/Program Files/ClaudeCode/managed-settings.json', '/mnt/c/Program Files/ClaudeCode/managed-settings.d');
  }
  return paths;
}
// Whether the user's own --managed-settings (the one the bundle keeps, the last) sets sandbox.bwrapPath or socatPath.
function managedSettingsSetsDeps(argv) {
  const m = findOptionArgs(argv, '--managed-settings');
  const v = m ? parseManagedSettings(m.value) : null;
  const sb = v && isPlainObject(v.sandbox) ? v.sandbox : null;
  return Boolean(sb && (sb.bwrapPath !== undefined || sb.socatPath !== undefined));
}
function sandboxWouldRun({ providerPlatform, procVersion, hasBwrap, hasSocat, policyMaySetDeps, nankeenEnv, nankeenGate }) {
  if (providerPlatform === 'win32') return envTruthy(nankeenEnv) || Boolean(nankeenGate);
  if (providerPlatform !== 'linux') return true;
  if (wslVersion(procVersion) === '1') return false;
  return Boolean((hasBwrap && hasSocat) || policyMaySetDeps);
}
// THE GUARD'S PRIVATE DIRECTORY (controller ruling 2026-11-19, option (a); BACKLOG "quaude's private guard
// directory"). Where quaude and naude must put the guard on disk (the plugin; the fallback merged settings), they use
// ONE directory per user, everywhere: `<clode cache>/guard`. The clode cache is resolved as libexec/clode-paths.cjs
// clodeCacheDir resolves it (test/update-guard-dir.test.cjs holds the two equal): CLODE_CACHE, else
// <CLODE_STATE_ROOT>/cache/clode, else <XDG_CACHE_HOME or home/.cache>/clode, home being HOME or the OS's home
// directory. It lies in the user's own home on every platform. It is made 0700, reused by every session, and the
// merged settings in it are pruned after GUARD_SETTINGS_MAX_AGE_MS. It replaced `<tmp>/clode-guard-<uid>` plus a
// fresh mkdtemp fallback, whose ownership check can never pass on Windows (libuv reports uid -1, st_uid 0 and a
// synthesized mode there), so every Windows session made a new directory that nothing removed.
function guardDirPath(env, home, sep) {
  const strip = (s) => String(s).replace(/[\\/]+$/, '');
  let cache;
  if (env.CLODE_CACHE) cache = strip(env.CLODE_CACHE);
  else if (env.CLODE_STATE_ROOT) cache = [strip(env.CLODE_STATE_ROOT), 'cache', 'clode'].join(sep);
  else cache = [env.XDG_CACHE_HOME ? strip(env.XDG_CACHE_HOME) : [strip(home), '.cache'].join(sep), 'clode'].join(sep);
  return cache + sep + 'guard';
}
// Defence in depth, judged on lstat facts ({ type: 'dir'|'link'|'other', uid, mode }) gathered by the caller.
// EVERYWHERE: the directory is a real directory, not a symbolic link (or junction). WHERE THE PLATFORM REPORTS
// OWNERSHIP, on every platform but Windows (`platform`, a fact; a POSIX caller with no uid is refused): it is ours
// and closed to group and other, and its parent is ours or root's and not writable by other (otherwise it could be
// renamed away and replaced). Windows has no POSIX owner or mode to judge, so there the directory's privacy is its
// home's ACL. A refusal is a reason string. The caller REFUSES to start on it,
// and never falls back to another directory.
function guardDirRefusal(dir, st, parent, uid, platform) {
  if (!st) return `${dir} could not be created`;
  if (st.type === 'link') return `${dir} is a symbolic link`;
  if (st.type !== 'dir') return `${dir} is not a directory`;
  // Owner and mode are judged by PLATFORM, a fact, never by whether a uid came back (windows-latest, CI 44572930594:
  // node reports st_uid 0 and a mode synthesized from the read-only bit, 0o40666, whatever the ACL says, so a uid-based
  // guess would judge those numbers as if they were POSIX). Windows has neither; there the profile ACL is the privacy.
  if (platform === 'win32') return null;
  if (!(typeof uid === 'number' && uid >= 0)) return `${dir}: this user's uid is unknown, so its owner cannot be judged`;
  if (st.uid !== uid) return `${dir} is owned by uid ${st.uid}, not by this user (uid ${uid})`;
  if ((st.mode & 0o077) !== 0) return `${dir} is open to other users (mode ${(st.mode & 0o777).toString(8)}, not 700)`;
  if (!parent || parent.type !== 'dir') return `${dir}'s parent is not a directory`;
  if (parent.uid !== uid && parent.uid !== 0) return `${dir}'s parent is owned by uid ${parent.uid}, neither this user nor root`;
  if ((parent.mode & 0o002) !== 0) return `${dir}'s parent is writable by every user (mode ${(parent.mode & 0o777).toString(8)})`;
  return null;
}
// The merged settings hold a copy of the user's --settings, which may carry secrets. They are removed once older than
// a week. tjs.exit runs no exit handlers, so a quaude session cannot remove its own copy, and a session still running
// after a week read its settings long ago. The NODE_EXTRA_CA_CERTS bundles (`ca-[hex].pem`, applyExtraCaCerts) are
// written the same way and go on the same clock, for the same reason: a session reads its bundle at its first
// connection, so a week-old one was read long ago. `entries` is [{ name, mtimeMs }]; returns the names to remove.
const GUARD_SETTINGS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// A quaude uid probe (`.uid-probe-*`, an empty directory) its session failed to remove goes once an hour old: never
// sooner, so a probe another session is judging right now is never taken from under it.
const GUARD_PROBE_MAX_AGE_MS = 60 * 60 * 1000;
function guardSettingsToPrune(entries, nowMs) {
  return entries.filter((e) => (/^(settings-[0-9a-f]+\.json|ca-[0-9a-f]+\.pem)$/.test(e.name)
      && nowMs - e.mtimeMs > GUARD_SETTINGS_MAX_AGE_MS)
    || (/^\.uid-probe-[0-9a-z]+$/.test(e.name) && nowMs - e.mtimeMs > GUARD_PROBE_MAX_AGE_MS))
    .map((e) => e.name);
}
// <<< guardGating <<<
module.exports = {
  guardVerdict, SUBCOMMANDS, shouldInjectGuard, firstPositional, hasFlag,
  VALUE_OPTIONS, VARIADIC_OPTIONS, OPTIONAL_VALUE_OPTIONS,
  SETTINGS_FILE_MAX_BYTES, findSettingsArgs, settingsIsInline, decodeSettingsBytes, parseSettingsText, mergeSettings,
  planGuardSettings, withSettingsArg, wslVersion, sandboxWouldRun, findOptionArgs, GUARD_PLUGIN_NAME, guardPluginFiles,
  guardDeliveryMode, withGuardLayers, policyProbe, parseManagedSettings, envTruthy, globalConfigCandidates,
  nankeenGateCached, sandboxEvidencePaths, managedSettingsSetsDeps,
  guardDirPath, guardDirRefusal, GUARD_SETTINGS_MAX_AGE_MS, guardSettingsToPrune,
};
