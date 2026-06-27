#!/usr/bin/env node
// clode update guard — a PreToolUse(Bash) hook. Reads the hook event JSON on
// stdin; if the Bash command is `claude update`/`upgrade`, denies it and points at
// clode's own update path. Injected clode-only via --settings by bin/clode and
// NEVER persisted to a shared settings file, so upstream claude is unaffected.
// Always exits 0 — the deny is conveyed via permissionDecision (current PreToolUse
// schema: a non-zero exit would make Claude Code ignore the JSON).
let buf = '';
process.stdin.on('data', (d) => { buf += d; });
process.stdin.on('end', () => {
  let cmd = '';
  try { cmd = ((JSON.parse(buf).tool_input) || {}).command || ''; } catch (e) {}
  if (/\bclaude\s+(update|upgrade)\b/.test(cmd)) {
    const self = process.env.CLODE_SELF || 'clode';
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          'clode manages updates. Run `' + self + ' update` instead — ' +
          '`claude update` targets a separate upstream install and will not update clode.',
      },
    }));
  }
  process.exit(0);
});
