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
function tjsPlatform(uaPlatform, map = globalThis.__clodeMapPlatform) {
  // No map installed and none injected (e.g. a host-node caller that never
  // ran main()): fall back to the same "no signal" default target-env.cjs's
  // mapPlatform uses, rather than silently miscategorizing. This is NOT a
  // second copy of the 5-case switch — only the empty-input default survives
  // here, so there is nothing left to drift.
  if (typeof map === 'function') return map(uaPlatform);
  return uaPlatform ? String(uaPlatform).toLowerCase() : 'linux';
}

// POSIX st_mode bits (no node:fs constants module under tjs): S_IFMT/S_IFREG
// isolate the file-type bits, S_IXUSR|S_IXGRP|S_IXOTH the executable ones.
// Verified against a real tjs.stat: a regular file's mode is 0o100644 or
// 0o100755, a directory's is 0o040755 (S_IFMT masks to 0o100000 / 0o040000).
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
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
  const platform = tjsPlatform(uaPlatform, map);
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
// THE USER'S --settings (grep-native sandbox round 3, C1). The bundle keeps ONE --settings (its eager scanner takes the
// last occurrence, as commander does), so the guard's own --settings, appended after the user's, discarded the user's
// whole: under quaude a user --settings never applied (permissions, hooks, env, and a sandbox enabled there failed
// OPEN). Now the user's value is read by the bundle's own rule and quaude's settings are merged into it: exactly one
// --settings reaches the bundle. The rule, from the 2.1.283 carve: occurrences are `--settings X` and `--settings=X`
// before any `--`, skipping other options' values (the same scan as hasFlag); the last one wins; an empty value loads
// nothing. A value whose trim starts with '{' and ends with '}' is inline JSON, anything else a file path (relative to
// the working directory). Inline JSON that does not parse, and a file that is missing, not a regular file, unreadable
// or over 2 MiB, make the bundle print its error and exit 1 before anything runs: then argv goes to the bundle
// UNCHANGED, so the user sees exactly that error. A file whose content is not a JSON object is skipped by the bundle,
// which runs on without it (measured, native: rc 0, nothing from it applied); quaude skips it the same way, says so on
// stderr, and keeps its own settings. A file that parses but fails the bundle's schema is dropped whole by the bundle,
// and with it the settings quaude merged in: native drops that file too, but the guard and the sandbox setting go with
// it (BACKLOG, the one case this merge cannot cover without the bundle's schema).
const SETTINGS_FILE_MAX_BYTES = 2097152;
function findSettingsArgs(argv) {
  const at = [];
  let value;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') break;
    if (typeof a === 'string' && a.startsWith('--settings=')) { at.push([i, 1]); value = a.slice('--settings='.length); continue; }
    if (a === '--settings' && i + 1 < argv.length) { at.push([i, 2]); value = argv[i + 1]; i++; continue; }
    i = skipOptionValue(argv, i);
  }
  return at.length ? { value, at } : null;
}
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

// What sandboxWouldRun (guardGating) needs to know: the bundle's baked platform, and on Linux the facts its own
// dependency check reads. Bun.which looks a name up on PATH (the env the bundle will see, already shaped by
// bootstrapTargetEnv); a policy source that could set sandbox.bwrapPath/socatPath is any managed-settings document
// (/etc/claude-code/managed-settings.json or managed-settings.d), a cached remote-settings.json in the config dir, or
// a --managed-settings argument.
async function sandboxFacts(tjs, providerPlatform, argv) {
  if (providerPlatform !== 'linux') return { providerPlatform };
  const exists = async (p) => { try { await tjs.stat(p); return true; } catch (_) { return false; } };
  const onPath = async (name) => {
    for (const dir of String(tjs.env.PATH || '').split(':')) {
      if (!dir) continue;
      try {
        const st = await tjs.stat(dir + '/' + name);
        if (((st.mode || 0) & S_IFMT) === S_IFREG && ((st.mode || 0) & S_IXALL) !== 0) return true;
      } catch (_) { /* not here */ }
    }
    return false;
  };
  let procVersion;
  try { procVersion = new TextDecoder().decode(await tjs.readFile('/proc/version')); } catch (_) { procVersion = undefined; }
  const configDir = tjs.env.CLAUDE_CONFIG_DIR || ((tjs.env.HOME || '') + '/.claude');
  const policyMayOverride = argv.some((a) => a === '--managed-settings' || String(a).startsWith('--managed-settings='))
    || await exists('/etc/claude-code/managed-settings.json') || await exists('/etc/claude-code/managed-settings.d')
    || await exists(configDir + '/remote-settings.json');
  return { providerPlatform, procVersion, hasBwrap: await onPath('bwrap'), hasSocat: await onPath('socat'), policyMayOverride };
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
  const uaPlatform = typeof navigator !== 'undefined' && navigator.userAgentData && navigator.userAgentData.platform;
  const asRg = !!rgEntrySrc && evalMember(rgEntrySrc).isRgInvocation(tjs.args[0], tjs.env, tjsPlatform(uaPlatform, tem0.mapPlatform));

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
    await bootstrapTargetEnv(tjs);

    // 7.6) Guard injection: wire the model's Bash tool through the update
    // guard by writing an ephemeral PreToolUse settings file and appending
    // --settings to the argv the loader hands the bundle (step 8, below).
    // The hook calls back into tjs.exePath — quaude's own binary (the
    // analogue of naude-entry.cjs's execPath; see its matching injection).
    // tjs.exePath falsy -> skip entirely (nothing known to call back into).
    if (tjs.exePath && shouldInjectGuard(rest)) {
      const platform = tjsPlatform(undefined, globalThis.__clodeMapPlatform);
      const sep = platform === 'win32' ? '\\' : '/';
      const tmpBase = tjs.tmpDir ?? tjs.env.TMPDIR ?? (platform === 'win32' ? 'C:\\Windows\\Temp' : '/tmp');
      // Name the settings file DETERMINISTICALLY by its content, not by pid. tjs wires no process-exit hook
      // (process.cjs: "tjs.exit does not run handlers"), so a per-pid file would leak one tiny JSON per boot with no
      // way to clean it up in-process. A hash-of-content name makes the write idempotent: one file per distinct
      // (binary, user --settings) pair, and concurrent sessions with the same pair write byte-identical content to
      // the same path (no collision, no accumulation) — no cleanup needed.
      // SANDBOXED BASH FAILS CLOSED (user ruling 2026-10-05) — THE NAMED DIVERGENCE, stated here once: quaude cannot
      // provide Claude Code's sandbox yet (its initialization needs node:net servers the node-shim lacks:
      // net.createServer throws "quaude does not support the sandbox yet"; BACKLOG), so where native WOULD sandbox,
      // an ENABLED sandbox is REQUIRED under quaude: this settings file says sandbox.failIfUnavailable, the bundle's
      // own setting for it (no patch to the bundle). With the sandbox enabled from any source the bundle merges, it
      // then takes its own required branch: every Bash call is refused ("Sandbox is required but failed to initialize:
      // quaude does not support the sandbox yet: net.createServer ..."), where the optional branch disabled the
      // sandbox for the rest of the session and ran every later call UNSANDBOXED. Native runs those commands
      // sandboxed. Where native would NOT sandbox (Linux without bubblewrap or socat, WSL1; sandboxWouldRun in the
      // guardGating block), nothing is injected (USER ruling D2, match native): the bundle prints native's warning and
      // runs commands unsandboxed, as native does. The setting OVERRIDES a user's own sandbox.failIfUnavailable:false
      // (USER ruling D1): nothing ever runs unsandboxed where native would have sandboxed it. With the sandbox off
      // nothing changes (the setting is read only when it is enabled); dangerouslyDisableSandbox keeps native's policy
      // (allowUnsandboxedCommands, the permission rules). naude injects no such setting: under Node the sandbox's
      // servers exist and its initialization does not fail, but naude does not run sandboxed commands either (each is
      // refused, "Shell '/bin/bash' not found in PATH", measured 2026-10-05 on macOS; BACKLOG): it fails closed by
      // another gap, never open.
      const required = sandboxWouldRun(await sandboxFacts(tjs, manifest.providerPlatform, rest));
      const guardSettings = {
        hooks: {
          PreToolUse: [
            {
              matcher: 'Bash',
              hooks: [
                { type: 'command', command: '"' + tjs.exePath + '" --clode-update-guard' },
              ],
            },
          ],
        },
      };
      if (required) guardSettings.sandbox = { failIfUnavailable: true };
      // The user's own --settings, merged (libexec/update-guard.cjs states the rule: guardGating, "THE USER'S
      // --settings"). A value the bundle cannot use reaches it unchanged: it prints its own error and exits.
      const found = findSettingsArgs(rest);
      let fileText;
      if (found && found.value !== '' && !settingsIsInline(found.value)) fileText = await readSettingsFile(tjs, found.value);
      const plan = planGuardSettings(found, fileText, guardSettings);
      if (!plan.passthrough) {
        if (plan.warning) console.error(`quaude: ${plan.warning}`);
        const text = JSON.stringify(plan.settings);
        // Named by CONTENT (which includes tjs.exePath): concurrent sessions with the same settings write byte-identical
        // files to one path, different settings never share one. Mode 0600: a user's settings may carry secrets (env).
        const guardKey = (await sha256hex(new TextEncoder().encode(text))).slice(0, 16);
        const guardSettingsFile = tmpBase.replace(/[\\/]+$/, '') + sep + `clode-guard-${guardKey}.json`;
        await tjs.writeFile(guardSettingsFile, new TextEncoder().encode(text), { mode: 0o600 });
        rest = withSettingsArg(rest, found, guardSettingsFile);
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
