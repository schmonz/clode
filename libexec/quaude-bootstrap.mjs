// quaude first-stage bootstrap. Compiled to quickjs bytecode at blobulate time
// (libexec/clode-build.cjs -> libexec/quaude-blobulate.js) and appended to a copy of
// the tjs binary under the stock `tx1k1.js` 12-byte trailer, so the UNMODIFIED
// pinned tjs runs it at startup, before any CLI parsing (txiki's standalone
// detection in run-main). ES module (=> strict), no imports.
//
// Blobulated-file layout (all offsets absolute file coordinates):
//   [tjs binary, ad-hoc signed BEFORE anything is appended]
//   [member data ...]
//   [index JSON: {version, members:[{name, offset, len, sha256}]}]
//   [quaude footer, 32B: "QAUDEv0\0" + u64LE indexOff + u64LE indexLen + 8B zero]
//   [this bootstrap, as serialized quickjs bytecode]
//   [tx1k1.js trailer, 12B: "tx1k1.js" + u32LE offset-of-bootstrap-bytecode]
//
// Responsibilities: locate + parse the archive; boot-verify the manifest +
// loader members (cheap; FULL verification of every member is
// --clode-attest's job — policy per the Q1a design memo §5); for the quaude
// role, carve --clode-* out of argv BEFORE any bundle-visible code runs (the
// reserved namespace — everything else belongs to Claude Code) and apply the
// target-env contract (target-env.cjs — DISABLE_INSTALLATION_CHECKS, the rg
// PATH shaping), while the BUILDER role (a blobulated native clode) owns its whole
// argv, gets no carve, and gets NO target-env contract either (that contract
// is Claude-Code-target-shaped and pointless for the builder itself); mount
// globalThis.__quaudeVFS; evaluate the archived
// node-shim loader, which boots the manifest's entry member (cli.qbc for
// quaude, the esbuilt clode-main bundle for the builder).

// The reserved argv namespace + the attest report format, INLINED from the canonical
// libexec/clode-attest.cjs. This file is compiled raw to tjs bytecode with no runtime
// imports, so it cannot require() the shared module the way naude-entry.cjs and
// clode-build.cjs do; test/update-guard-drift.test.cjs holds the two copies byte-identical.
// Same mechanism, and the same reason, as the guardVerdict copy below.
// >>> clodeAttest (canonical; drift-tested against libexec/quaude-bootstrap.mjs) >>>
// The reserved argv namespace. A built target owns every `--clode-*` flag; an unknown one
// is an ERROR (it must never reach Claude Code, which would report it as its own). Every
// other argument belongs to the bundle, verbatim and in order.
const CLODE_FLAGS = ['--clode-attest'];
function carveClodeArgs(args, known = CLODE_FLAGS) {
  const clode = [], rest = [], unknown = [];
  for (const a of args) {
    if (typeof a === 'string' && a.startsWith('--clode-')) {
      (known.includes(a) ? clode : unknown).push(a);
    } else rest.push(a);
  }
  return { clode, rest, unknown };
}

// manifest.bom entries are "name@version"; a scoped package (@scope/name@version) has a
// leading '@' that is NOT the version separator, so split on the LAST '@'.
function depNameFromSpec(spec) {
  const i = spec.lastIndexOf('@');
  return i > 0 ? spec.slice(0, i) : spec;
}

// The verdict. ONE string per outcome, naming neither product — `clode build` greps the
// success line for whichever target it just produced.
const ATTEST_VERIFIED = 'clode-attest: all members verified';
const ATTEST_FAILED = 'clode-attest: VERIFICATION FAILED';

// members: [{ name, len, ok }]  — one per hashed unit the product actually re-hashed.
// bom:     [{ spec, marker, present }] — SET verification: a whole declared package can be
//          silently ABSENT without any present member failing, which per-member hashing
//          alone would never notice.
// notes:   plain strings, printed as `note: ...` — what this product did NOT verify.
function attestReport({ manifestText, members, bom, notes }) {
  const lines = String(manifestText).replace(/\n+$/, '').split('\n');
  let ok = true;
  for (const m of members) {
    if (!m.ok) ok = false;
    lines.push(`${m.ok ? 'ok  ' : 'FAIL'} ${m.name} (${m.len} bytes)`);
  }
  for (const b of bom || []) {
    if (!b.present) ok = false;
    lines.push(`${b.present ? 'ok  ' : 'FAIL'} bom: ${b.spec} -> ${b.marker}`);
  }
  for (const n of notes || []) lines.push(`note: ${n}`);
  lines.push(ok ? ATTEST_VERIFIED : ATTEST_FAILED);
  return { ok, lines, text: lines.join('\n') + '\n' };
}
// <<< clodeAttest <<<

// What rg reads of the archive: everything but the bundle (graph.*, cli.qbc), the pristine engine template and the
// bundle's npm packages, none of which rg-entry.cjs or its companions load. Every rg the Bash tool runs pays this
// read, so it skips ~74 MB of a 2.1.283 quaude's 80.
const RG_UNREAD = /^(?:graph[.-]|cli\.qbc$|template\/|node_modules\/)/;

async function sha256hex(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

// tjs -> node spelling. This used to duplicate the node-shim's detectPlatform
// switch (libexec/node-shim/modules/process.cjs) character-for-character; the
// switch itself now lives ONCE, as target-env.cjs's mapPlatform — the same
// require-free member this bootstrap already evaluates early for
// shapeTargetEnv/probePaths (see globalThis.__clodeMapPlatform, installed
// alongside those below, in main()). `map` is a real DI parameter (not just a
// global read), matching bootstrapTargetEnv's existing shape/probe seam,
// so host-node tests can inject target-env.cjs's mapPlatform directly instead
// of relying on main() (which never runs outside the blobulated binary) to
// populate the global. tjs.system.platform is EMPTY, so
// navigator.userAgentData.platform is the only source this early.
// >>> tjsPlatform (test/update-guard-dir.test.cjs runs it with hostPlatform) >>>
function tjsPlatform(uaPlatform, map = globalThis.__clodeMapPlatform) {
  // No map installed and none injected (e.g. a host-node caller that never
  // ran main()): fall back to the same "no signal" default target-env.cjs's
  // mapPlatform uses, rather than silently miscategorizing. This is NOT a
  // second copy of the 5-case switch — only the empty-input default survives
  // here, so there is nothing left to drift.
  if (typeof map === 'function') return map(uaPlatform);
  return uaPlatform ? String(uaPlatform).toLowerCase() : 'linux';
}
// <<< tjsPlatform <<<

// POSIX st_mode bits (no node:fs constants module under tjs): S_IFMT/S_IFREG
// isolate the file-type bits, S_IXUSR|S_IXGRP|S_IXOTH the executable ones.
// Verified against a real tjs.stat: a regular file's mode is 0o100644 or
// 0o100755, a directory's is 0o040755 (S_IFMT masks to 0o100000 / 0o040000).
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IXALL = 0o111;

// The env contract every built target applies to itself. ASYNC because tjs has
// no statSync: probe every candidate target-env can ask about (probePaths),
// stat each one ONCE, then answer shapeTargetEnv's two DIFFERENT questions
// ("does it exist?" vs "can I run it?" — see target-env.cjs's findOnPath)
// synchronously from that single pass. Exported + primitive-injected so it
// unit-tests under host node — the same pattern as the inlined pure helpers above.
export async function bootstrapTargetEnv(tjs, opts = {}) {
  const {
    shape = globalThis.__clodeShapeTargetEnv,
    probe = globalThis.__clodeProbePaths,
    map = globalThis.__clodeMapPlatform,
    uaPlatform = (typeof navigator !== 'undefined' && navigator.userAgentData && navigator.userAgentData.platform),
  } = opts;
  const platform = opts.platform || tjsPlatform(uaPlatform, map);
  const delimiter = platform === 'win32' ? ';' : ':';
  const sep = platform === 'win32' ? '\\' : '/';

  // path -> {exists, isExec}, filled from ONE tjs.stat per candidate.
  const stats = new Map();
  for (const p of probe({ env: tjs.env, platform, delimiter })) {
    try {
      const st = await tjs.stat(p);
      const mode = st.mode || 0;
      const isFile = (mode & S_IFMT) === S_IFREG;
      stats.set(p, { exists: true, isExec: isFile && (mode & S_IXALL) !== 0 });
    } catch {
      stats.set(p, { exists: false, isExec: false }); // absent, EACCES, etc.
    }
  }

  return shape({
    env: tjs.env,
    platform,
    delimiter,
    exists: (p) => Boolean(stats.get(p)?.exists),
    isExec: (p) => Boolean(stats.get(p)?.isExec),
    dirname: (p) => { const i = p.lastIndexOf(sep); return i <= 0 ? sep : p.slice(0, i); },
  });
}

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
export { guardVerdict };

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
// after a week read its settings long ago. `entries` is [{ name, mtimeMs }]; returns the names to remove.
const GUARD_SETTINGS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
function guardSettingsToPrune(entries, nowMs) {
  return entries.filter((e) => /^settings-[0-9a-f]+\.json$/.test(e.name) && nowMs - e.mtimeMs > GUARD_SETTINGS_MAX_AGE_MS)
    .map((e) => e.name);
}
// <<< guardGating <<<

// The user's --settings FILE, decoded as the bundle decodes it, or null when the bundle could not use it (missing, not a
// regular file, over its 2 MiB limit, unreadable): the bundle then prints its own error. Relative to the working
// directory, as the bundle resolves it.
async function readSettingsFile(tjs, file) {
  try {
    const st = await tjs.stat(file);
    if (((st.mode || 0) & S_IFMT) !== S_IFREG || st.size > SETTINGS_FILE_MAX_BYTES) return null;
    return decodeSettingsBytes(await tjs.readFile(file));
  } catch (_) { return null; }
}

// /proc/version (Linux, WSL), or undefined where there is none.
async function readProcVersion(tjs) {
  try { return new TextDecoder().decode(await tjs.readFile('/proc/version')); } catch (_) { return undefined; }
}
// Whether an admin managed-policy source may exist (policyProbe, guardGating, says where).
async function policyMayExist(tjs, providerPlatform, procVersion) {
  const probe = policyProbe({ providerPlatform, env: tjs.env, procVersion });
  if (probe.always) return true;
  for (const p of probe.paths) { try { await tjs.lstat(p); return true; } catch (_) { /* absent */ } }
  return false;
}

// What sandboxWouldRun (guardGating) needs to know: the bundle's baked platform; on Windows the gate's env and its
// cached value (read-only: the bundle's global config, the first of globalConfigCandidates that exists); on Linux the
// facts its own dependency check reads. Bun.which looks a name up on PATH (the env the bundle will see, already shaped
// by bootstrapTargetEnv); `policyMaySetDeps`: EVIDENCE that policy could set sandbox.bwrapPath/socatPath (a visible
// policy source exists, or the user's --managed-settings sets them), never mere "may exist" (fix round 3).
async function sandboxFacts(tjs, providerPlatform, procVersion, argv) {
  const env = tjs.env;
  if (providerPlatform === 'win32') {
    let nankeenGate = false;
    for (const p of globalConfigCandidates(env)) {
      let st;
      try { st = await tjs.stat(p); } catch (_) { continue; }
      if (((st.mode || 0) & S_IFMT) === S_IFREG) {
        try { nankeenGate = nankeenGateCached(new TextDecoder().decode(await tjs.readFile(p))); } catch (_) { /* off */ }
      }
      break;
    }
    return { providerPlatform, nankeenEnv: env.CLAUDE_CODE_NANKEEN_KESTREL, nankeenGate };
  }
  if (providerPlatform !== 'linux') return { providerPlatform };
  const onPath = async (name) => {
    for (const dir of String(env.PATH || '').split(':')) {
      if (!dir) continue;
      try {
        const st = await tjs.stat(dir + '/' + name);
        if (((st.mode || 0) & S_IFMT) === S_IFREG && ((st.mode || 0) & S_IXALL) !== 0) return true;
      } catch (_) { /* not here */ }
    }
    return false;
  };
  let policyMaySetDeps = managedSettingsSetsDeps(argv);
  for (const p of sandboxEvidencePaths({ providerPlatform, env, procVersion })) {
    if (policyMaySetDeps) break;
    try { await tjs.lstat(p); policyMaySetDeps = true; } catch (_) { /* absent */ }
  }
  return { providerPlatform, procVersion, hasBwrap: await onPath('bwrap'), hasSocat: await onPath('socat'), policyMaySetDeps };
}

// >>> quaudeGuardDir (quaude's I/O around guardGating's guardDirPath and guardDirRefusal; test/update-guard-dir.test.cjs runs it on a fake tjs) >>>
// quaude's PRIVATE directory for what it must put on disk (the guard plugin; the fallback merged settings):
// guardDirPath's `<clode cache>/guard`, one per user on every platform, made 0700 and reused. Its parents are made
// with the default mode, the directory itself 0700, and guardDirRefusal judges what lstat then reports. A refusal
// comes back as { refusal }, and the caller refuses to start: never a fallback to another directory. Inside it
// nothing can be planted or swapped by another user, so the plain writes below are safe.
//
// The host's platform and path separator, resolved ONCE in main() and passed down. tjs.system.platform is empty, so
// navigator.userAgentData.platform is the only signal; with no signal passed, tjsPlatform answers linux on EVERY host (a
// Windows quaude then judged its guard directory by the POSIX rule and refused to start: the review of af7b803).
function hostPlatform(map) {
  const ua = typeof navigator !== 'undefined' && navigator.userAgentData && navigator.userAgentData.platform;
  const platform = tjsPlatform(ua, map);
  return { platform, sep: platform === 'win32' ? '\\' : '/' };
}
// The effective uid, from the owner of a directory made just now inside `dir`. Not tjs.system.userInfo: it THROWS when
// the uid has no passwd entry (docker -u 1234, OpenShift's random uids). undefined when no probe can be made there, and
// guardDirRefusal then refuses (fail closed).
async function effectiveUid(tjs, dir, sep) {
  const probe = dir + sep + '.uid-probe-' + Math.random().toString(36).slice(2);
  try { await tjs.makeDir(probe, { mode: 0o700 }); } catch (_) { return undefined; }
  try { return (await tjs.lstat(probe)).uid; } catch (_) { return undefined; } finally {
    try { await tjs.remove(probe); } catch (_) { /* a leftover probe is empty and harmless */ }
  }
}
async function privateGuardDir(tjs, env, sep, platform) {
  const dir = guardDirPath(env, env.HOME || tjs.homeDir || '', sep);
  const parent = dir.slice(0, dir.lastIndexOf(sep));
  try { await tjs.makeDir(parent, { recursive: true }); } catch (_) { /* judged below */ }
  try { await tjs.makeDir(dir, { mode: 0o700 }); } catch (_) { /* exists, or cannot: judged below */ }
  const facts = async (p) => {
    try {
      const st = await tjs.lstat(p);
      const fmt = (st.mode || 0) & 0o170000;
      return { type: fmt === 0o040000 ? 'dir' : fmt === 0o120000 ? 'link' : 'other', uid: st.uid, mode: st.mode || 0 };
    } catch (_) { return null; }
  };
  const st = await facts(dir);
  // Only into a real directory (never through a link), and only where an owner is judged.
  const uid = platform !== 'win32' && st && st.type === 'dir' ? await effectiveUid(tjs, dir, sep) : undefined;
  const refusal = guardDirRefusal(dir, st, await facts(parent), uid, platform);
  return refusal ? { refusal } : { dir };
}
async function pruneGuardSettings(tjs, dir, sep, nowMs) {
  const entries = [];
  try {
    for await (const e of await tjs.readDir(dir)) {
      try {
        const st = await tjs.lstat(dir + sep + e.name);
        entries.push({ name: e.name, mtimeMs: st.mtim instanceof Date ? st.mtim.getTime() : Number(st.mtim) });
      } catch (_) { /* gone */ }
    }
  } catch (_) { /* nothing to prune */ }
  for (const name of guardSettingsToPrune(entries, nowMs)) {
    try { await tjs.remove(dir + sep + name); } catch (_) { /* gone, or not ours to remove */ }
  }
}
// <<< quaudeGuardDir <<<
// Write `text` to `file` unless it already holds exactly that: to a temporary name, then renamed over it, so a session
// starting meanwhile reads the old bytes or the new, never a torn file.
async function writeFileOnce(tjs, file, text) {
  const bytes = new TextEncoder().encode(text);
  try { if (new TextDecoder().decode(await tjs.readFile(file)) === text) return; } catch (_) { /* absent */ }
  const tmp = file + '.' + Math.random().toString(36).slice(2) + '.tmp';
  await tjs.writeFile(tmp, bytes, { mode: 0o600 });
  await tjs.rename(tmp, file);
}

async function main() {
  const dec = new TextDecoder();
  const die = (msg, code) => { console.error(`quaude: ${msg}`); tjs.exit(code); };

  const g = tjs.args.slice(1);
  const exef = await tjs.open(tjs.exePath, 'rb');
  const exeSize = (await exef.stat()).size;

  // 1) tx1k1 trailer -> where our bootstrap bytecode starts.
  const trailer = new Uint8Array(12);
  await exef.read(trailer, exeSize - 12);
  if (dec.decode(trailer.subarray(0, 8)) !== 'tx1k1.js') die('missing tx1k1.js trailer (not a blobulated binary?)', 70);
  const bcOffset = new DataView(trailer.buffer, 8, 4).getUint32(0, true);

  // 2) quaude footer: the 32 bytes immediately before the bootstrap bytecode.
  const footer = new Uint8Array(32);
  await exef.read(footer, bcOffset - 32);
  if (dec.decode(footer.subarray(0, 8)) !== 'QAUDEv0\0') die('bad archive footer magic', 70);
  const fdv = new DataView(footer.buffer);
  const indexOff = Number(fdv.getBigUint64(8, true));
  const indexLen = Number(fdv.getBigUint64(16, true));

  // 3) index.
  const indexBuf = new Uint8Array(indexLen);
  await exef.read(indexBuf, indexOff);
  const index = JSON.parse(dec.decode(indexBuf));

  // 3.5) RG-ARGV0 (grep-native Task 10c): a quaude invoked as rg IS rg, as native's claude binary is; the Bash tool's
  // `rg` is upstream's shell function run against this binary that way. The rule is rg-entry.cjs's, stated once:
  // its member is evaluated here (its top level requires nothing), on the platform target-env.cjs's mapPlatform
  // names (path separators are a platform's). Every argument is then rg's, `--clode-*` included (native's rg has
  // no such flags either).
  const smallMember = async (name) => {
    const m = index.members.find((x) => x.name === name);
    if (!m) return null;
    const b = new Uint8Array(m.len);
    await exef.read(b, m.offset);
    return dec.decode(b);
  };
  const evalMember = (src) => {
    const mod = { exports: {} };
    (0, new Function('module', 'exports', 'require', src))(mod, mod.exports, () => ({}));   // nothing to require yet
    return mod.exports;
  };
  const tem0 = evalMember(await smallMember('target-env.cjs'));
  const rgEntrySrc = await smallMember('rg-entry.cjs');
  // The host's platform and separator, ONCE for all of main (hostPlatform, in the quaudeGuardDir block).
  const { platform, sep } = hostPlatform(tem0.mapPlatform);
  const asRg = !!rgEntrySrc && evalMember(rgEntrySrc).isRgInvocation(tjs.args[0], tjs.env, platform);

  // 0) Guard dispatch: quaude's own patched updater hook calls back
  // `"<quaude>" --clode-update-guard` as a PreToolUse(Bash) command (wired by
  // the --settings injection below, step 8). Read the whole hook-input JSON
  // off tjs.stdin, ask the pure guardVerdict above, and emit its answer (or
  // nothing, on any parse failure — fail OPEN) — BEFORE any member but the two
  // small ones RG-ARGV0 needs is read. Mirrors naude-entry.cjs's runNaude guard-dispatch branch.
  // Write via the synchronous __tjs_fs_sync patch (a raw-engine global, not
  // a node-shim addition — see mod_fs_sync.c), NOT tjs.stdout.getWriter():
  // process.cjs documents that an unawaited writer.write() immediately
  // followed by exit() can lose bytes; a synchronous write(2) before exit()
  // cannot.
  if (!asRg && g[0] === '--clode-update-guard') {
    await exef.close();
    let text = '';
    try {
      const reader = tjs.stdin.getReader();
      const chunks = [];
      let total = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.length) { chunks.push(value); total += value.length; }
      }
      const buf = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) { buf.set(c, off); off += c.length; }
      text = dec.decode(buf);
    } catch { /* unreadable stdin -> fail open below */ }
    let verdict = null;
    try {
      const parsed = JSON.parse(text);
      verdict = guardVerdict((parsed.tool_input || {}).command);
    } catch { verdict = null; }
    if (verdict) {
      // write(2) on a blocking pipe/tty may short-write large payloads --
      // loop until every byte lands (mirrors node-shim's writeSyncFd in
      // libexec/node-shim/internal/stdio-write.cjs). Fail OPEN: if a write
      // returns <= 0, stop and fall through to exit(0) rather than throwing.
      const bytes = new TextEncoder().encode(JSON.stringify(verdict));
      let off = 0;
      while (off < bytes.length) {
        const chunk = off === 0 ? bytes.buffer : bytes.buffer.slice(off);
        const n = globalThis.__tjs_fs_sync.write(1, chunk, -1);
        if (n <= 0) break;
        off += n;
      }
    }
    tjs.exit(0);
    return;
  }

  // 4) members (eager read; lazy/mmap is a rung-2 optimization). The manifest and
  // the loader first: they decide the role, and with it what else is read.
  const files = new Map();
  const readMember = async (m) => {
    const buf = new Uint8Array(m.len);
    await exef.read(buf, m.offset);
    files.set(m.name, buf);
  };
  const BOOT = ['manifest.json', 'node-shim/loader.cjs'];
  for (const name of BOOT) {
    const m = index.members.find((x) => x.name === name);
    if (!m) die(`archive is missing ${name}`, 70);
    await readMember(m);
  }

  // 5) boot-verify (fast integrity gate): the manifest we are about to trust
  // and the loader we are about to evaluate must hash to what the index
  // promises. Full per-member verification runs on --clode-attest only
  // (design memo §5 policy).
  for (const name of BOOT) {
    const m = index.members.find((x) => x.name === name);
    if (!files.get(name)) die(`archive is missing ${name}`, 70);
    if ((await sha256hex(files.get(name))) !== m.sha256) die(`${name} failed integrity check (corrupt blobulate?)`, 70);
  }

  // 6) role (manifest, just verified): quaude reserves the --clode-* argv
  // namespace; the BUILDER role (a blobulated native clode, Q1c) owns its whole
  // argv — clode's own flags are all --clode-*/subcommands, so nothing is
  // carved and there is no --clode-attest short-circuit for it.
  const manifest = JSON.parse(dec.decode(files.get('manifest.json')));
  const isBuilder = (manifest.role ?? 'quaude') === 'builder';
  const rgRole = asRg && !isBuilder;
  for (const m of index.members) {
    if (files.has(m.name) || (rgRole && RG_UNREAD.test(m.name))) continue;
    await readMember(m);
  }
  await exef.close();

  // 6.5) rg (RG-ARGV0): rg-entry.cjs answers, with every argument, before the bundle or any of the target's
  // contract (target-env, the update guard) is touched: no Claude Code runs here.
  if (rgRole) {
    globalThis.__quaudeVFS = { files, index, manifest };
    globalThis.__quaudeArgs = tjs.args.slice(1);
    globalThis.__quaudeEntry = 'rg-entry.cjs';
    (0, new Function(dec.decode(files.get('node-shim/loader.cjs'))))();
    return;
  }
  let rest = tjs.args.slice(1);
  if (!isBuilder) {
    // argv carve-out: strip --clode-* BEFORE any bundle code can observe argv.
    const { clode, rest: carved, unknown } = carveClodeArgs(rest);
    if (unknown.length) {
      die(`unknown option '${unknown[0]}' (the --clode-* namespace is reserved; known: ${CLODE_FLAGS.join(', ')})`, 64);
    }
    rest = carved;

    // 7) --clode-attest: manifest verbatim, then recompute EVERY member hash from the
    // trailer being executed and compare against the index. Same flag, same format, and
    // the same verdict line a naude prints (libexec/clode-attest.cjs) — `clode build`
    // greps ONE string for either target.
    if (clode.includes('--clode-attest')) {
      const members = [];
      for (const m of index.members) {
        members.push({ name: m.name, len: m.len, ok: (await sha256hex(files.get(m.name))) === m.sha256 });
      }
      // SET verification (Task a, stretch goal): the per-member loop above only proves
      // that whatever IS in the archive is intact — it says nothing about a whole
      // declared package being silently ABSENT. manifest.bom (name@version) is the
      // declared closure; check that every one of them actually landed a member in this
      // same archive. `files` already holds every member this trailer carries (step 4,
      // above), so this is a presence check, not a new read.
      const bom = (manifest.bom || []).map((spec) => {
        const marker = `node_modules/${depNameFromSpec(spec)}/package.json`;
        return { spec, marker, present: files.has(marker) };
      });
      const report = attestReport({ manifestText: dec.decode(files.get('manifest.json')), members, bom });
      for (const line of report.lines) console.log(line);
      tjs.exit(report.ok ? 0 : 1);
    }

    // 7.5) Apply the target env contract before ANY bundle code runs. target-env.cjs
    // is a member: evaluate it the same way the loader is evaluated below (it is
    // CJS, so hand it a module shim), then adapt it to tjs primitives.
    //
    // BUILDER-role only exception: a blobulated native clode is the BUILDER, not a
    // built target — applying this contract to itself would set
    // DISABLE_INSTALLATION_CHECKS/NODE_USE_ENV_PROXY on the builder's own
    // process for no reason and could prepend an rg dir to the builder's PATH.
    // So: quaude only.
    // BARE member name 'target-env.cjs' (no libexec/ prefix): the node-shim's
    // process.cjs also requires this member (relative to its blobulated SHIM_DIR,
    // which has no 'libexec' ancestor in the archive namespace — see
    // quaude-blobulate.js), so this and that require must agree on where it lives.
    const tem = { exports: {} };
    (0, new Function('module', 'exports', dec.decode(files.get('target-env.cjs'))))(tem, tem.exports);
    globalThis.__clodeShapeTargetEnv = tem.exports.shapeTargetEnv;
    globalThis.__clodeProbePaths = tem.exports.probePaths;
    // The shared uaPlatform->node switch (see tjsPlatform, above) — installed
    // from the same evaluated member as shapeTargetEnv/probePaths, so there is
    // exactly one copy of the mapping running under tjs.
    globalThis.__clodeMapPlatform = tem.exports.mapPlatform;
    await bootstrapTargetEnv(tjs, { platform });

    // 7.6) Guard injection: wire the model's Bash tool through the update
    // guard (a PreToolUse hook) and, where required, sandbox.failIfUnavailable,
    // in the argv the loader hands the bundle (step 8, below).
    // The hook calls back into tjs.exePath — quaude's own binary (the
    // analogue of naude-entry.cjs's execPath; see its matching injection).
    // tjs.exePath falsy -> skip entirely (nothing known to call back into).
    if (tjs.exePath && shouldInjectGuard(rest)) {
      // SANDBOXED BASH FAILS CLOSED (user ruling 2026-10-05) — THE NAMED DIVERGENCE, stated here once: quaude cannot
      // provide Claude Code's sandbox yet (its initialization needs node:net servers the node-shim lacks:
      // net.createServer throws "quaude does not support the sandbox yet"; BACKLOG), so where native WOULD sandbox,
      // an ENABLED sandbox is REQUIRED under quaude: quaude says sandbox.failIfUnavailable, the bundle's
      // own setting for it (no patch to the bundle). With the sandbox enabled from any source the bundle merges, it
      // then takes its own required branch: every Bash call is refused ("Sandbox is required but failed to initialize:
      // quaude does not support the sandbox yet: net.createServer ..."), where the optional branch disabled the
      // sandbox for the rest of the session and ran every later call UNSANDBOXED. Native runs those commands
      // sandboxed. Where native would NOT sandbox (every quaude from the linux carve, NetBSD and Haiku included, without
      // bubblewrap or socat on PATH, and WSL1; Windows unless its gate is on; sandboxWouldRun in the guardGating
      // block), nothing is injected (USER ruling D2, match native): the bundle prints native's warning and
      // runs commands unsandboxed, as native does. The setting OVERRIDES a user's own sandbox.failIfUnavailable:false
      // (USER ruling D1): nothing ever runs unsandboxed where native would have sandboxed it. With the sandbox off
      // nothing changes (the setting is read only when it is enabled); dangerouslyDisableSandbox keeps native's policy
      // (allowUnsandboxedCommands, the permission rules). naude injects no such setting: under Node the sandbox's
      // servers exist and its initialization does not fail, but naude does not run sandboxed commands either (each is
      // refused, "Shell '/bin/bash' not found in PATH", measured 2026-10-05 on macOS; BACKLOG): it fails closed by
      // another gap, never open.
      const procVersion = await readProcVersion(tjs);
      const policyMayOverride = await policyMayExist(tjs, manifest.providerPlatform, procVersion);
      const required = sandboxWouldRun(await sandboxFacts(tjs, manifest.providerPlatform, procVersion, rest));
      const hookCommand = '"' + tjs.exePath + '" --clode-update-guard';
      const guardSettings = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: hookCommand }] }] } };
      if (required) guardSettings.sandbox = { failIfUnavailable: true };
      // How quaude's keys reach the bundle: libexec/update-guard.cjs states the rule (guardGating, "THE USER'S
      // --settings"). Never inside a user --settings value where it can be avoided: a value the bundle drops takes
      // whatever rides in it along.
      const mode = guardDeliveryMode(rest, policyMayOverride);
      if (mode === 'own') {
        // Inline JSON: nothing on disk from quaude (the bundle keeps inline --settings itself, as it does natively).
        rest = withSettingsArg(rest, findSettingsArgs(rest), JSON.stringify(guardSettings));
      } else {
        // The guard is never left out for want of a private directory: refuse to start (fail closed) instead.
        const got = await privateGuardDir(tjs, tjs.env, sep, platform);
        if (got.refusal) die(`refusing to start: the update guard's private directory is unsafe: ${got.refusal}`, 1);
        const dir = got.dir;
        await pruneGuardSettings(tjs, dir, sep, Date.now());
        if (mode === 'merge') {
          // Belt and braces: quaude's keys merged into the user's value too (a value the bundle cannot use reaches it
          // unchanged: it prints its own error and exits).
          const found = findSettingsArgs(rest);
          let fileText;
          if (!settingsIsInline(found.value)) fileText = await readSettingsFile(tjs, found.value);
          const plan = planGuardSettings(found, fileText, guardSettings);
          if (!plan.passthrough) {
            if (plan.warning) console.error(`quaude: ${plan.warning}`);
            const text = JSON.stringify(plan.settings);
            const file = dir + sep + 'settings-' + (await sha256hex(new TextEncoder().encode(text))).slice(0, 16) + '.json';
            await writeFileOnce(tjs, file, text);
            rest = withSettingsArg(rest, found, file);
          }
        }
        // The layers, in 'layers' and 'merge' alike: the guard's hook as a session plugin, sandbox.failIfUnavailable as
        // managed settings.
        const files = guardPluginFiles(hookCommand);
        const pluginDir = dir + sep + 'plugin-' + (await sha256hex(new TextEncoder().encode(JSON.stringify(files)))).slice(0, 16);
        for (const rel of Object.keys(files)) {
          const parts = rel.split('/');
          let d = pluginDir;
          for (const part of [''].concat(parts.slice(0, -1))) {
            d = part ? d + sep + part : d;
            try { await tjs.makeDir(d, { mode: 0o700 }); } catch (_) { /* exists */ }
          }
          await writeFileOnce(tjs, pluginDir + sep + parts.join(sep), files[rel]);
        }
        rest = withGuardLayers(rest, pluginDir, required);
      }
    }
  }

  // 8) mount + boot: the archived loader resolves everything under /quaude/;
  // the manifest rides along so the loader picks the role's entry member.
  globalThis.__quaudeVFS = { files, index, manifest };
  globalThis.__quaudeArgs = rest;
  // Pre-load tjs:sqlite for the node-shim's node:sqlite provider (which bun:sqlite
  // maps onto): node's DatabaseSync is sync but import('tjs:sqlite') is async, so
  // await it HERE (before the loader boots the cli) and stash the module;
  // node-shim/modules/sqlite.cjs reads it sync. Non-fatal — a build without
  // tjs:sqlite just leaves node:sqlite (and bun:sqlite) fail-loud on use.
  try { globalThis.__clodeTjsSqlite = await import('tjs:sqlite'); } catch (_) { /* no sqlite in this engine */ }
  (0, new Function(dec.decode(files.get('node-shim/loader.cjs'))))();
}

// Under tjs (the blobulated binary) run; under host node (unit tests importing the
// carve function) do nothing.
if (globalThis.tjs) await main();
