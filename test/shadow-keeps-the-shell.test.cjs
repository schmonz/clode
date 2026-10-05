'use strict';
// THE RULE: a search shadow (the grep/find/rg function the rewritten shell snapshot
// defines) runs its applet as a CHILD and returns the applet's status. It never
// replaces the shell that called it.
//
// Why this is a rule and not a detail: the Bash tool runs the model's whole command
// in ONE shell — `source <snapshot> && ... && eval '<command>' && pwd -P >| <cwd file>`
// — and the shadows are FUNCTIONS in that shell. A function body that says
// `exec "$_bin" ...` does not replace "the function's subshell"; there is none. It
// replaces the shell running everything, so `grep -q x f && echo A; echo B` printed
// neither echo, `if grep -q ...; then` lost its branch, and `find ...; echo rc=$?`
// never reported. Found by the NetBSD spike (2026-09-26) and true on every platform,
// in bash and in zsh (zsh runs the last element of a pipeline in the current shell,
// so there even `... | grep x; echo after` lost the tail).
//
// Upstream's own shadow never replaces the calling shell either: zsh gets
// `ARGV0=ugrep "$_cc_bin" ...` (a child), and bash at top level gets
// `(exec -a ugrep "$_cc_bin" ...)` (a subshell). So this rule pulls the rewritten
// shadow TOWARD upstream's behaviour, and it holds in both naude and quaude
// (libexec/bun-shim.cjs is baked into both).
//
// What must NOT change: the applet's exit status, its stdin/stdout/stderr, and how
// it behaves inside a pipeline. The rows below pin all of those too.
//
// The applet is a stand-in, on purpose: this is about the SHELL'S control flow, not
// about ugrep or bfs, so a script whose behaviour we fix exactly lets every row name
// the precise bytes it expects on every host. The same stand-in plays ugrep (for
// grep), bfs (for find) and the quaude binary that answers rg (CLAUDE_CODE_EXECPATH,
// which the bundle sets in the Bash tool's environment: grep-native Task 10c, rg is
// native's own shell function run against that binary as rg).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const bunShim = require('../libexec/bun-shim.cjs');
const { rewriteSnapshot } = bunShim;

// A captured upstream snapshot (grep + find shadows). rewriteSnapshot rebuilds both
// through buildShadow; rg comes from the writer's own rg block (RG_BLOCK, below), so
// one render carries every shadow shape the product emits.
const UPSTREAM = fs.readFileSync(path.join(__dirname, 'fixtures', 'snapshot-execpath.sh'), 'utf8');
// Native 2.1.283's own snapshot, verbatim (its rg is the function form, inside the guard).
const NATIVE_283 = fs.readFileSync(path.join(__dirname, 'fixtures', 'snapshot-2.1.283.sh'), 'utf8');

// The skew-trailer shape (a generation-time probe found the host applet rejects the
// flags) is the other body buildShadow emits. It must obey the same rule.
const FINDINGS = [
  { name: 'grep', applet: 'ugrep', why: 'stand-in skew', fix: 'nothing to fix' },
  { name: 'find', applet: 'bfs', why: 'stand-in skew', fix: 'nothing to fix' },
];
// quaude's snapshot as its writer emits it on a host with no rg (grep-native Task 10b): the bundle reaches rg by
// Bun.which('rg'), which answers quaude's own ABSOLUTE path (RG_PATH: a path string, no file there), and with no argv0
// the writer (2.1.283's aAn) spells rg as an alias inside upstream's "no host rg" guard: `alias rg='<RG_PATH>'`. zsh
// expands an alias in a sourced snapshot, and so does bash, whose snapshot the writer starts with `shopt -s
// expand_aliases` (2.1.283's gAn): that alias would run a missing file in both. rewriteSnapshot replaces THAT line
// (and no other rg alias) with quaude's rg shadow.
const EXPAND = '[ -n "${BASH_VERSION:-}" ] && shopt -s expand_aliases\n';
const RG_BLOCK = `# Check for rg availability\nif ! (unalias rg 2>/dev/null; command -v rg) >/dev/null 2>&1; then\n  alias rg='${bunShim.RG_PATH}'\nfi\n`;
// quaude's snapshot in normal mode: the writer's rg block, then the find/grep shadows (dAn), as the writer orders them.
const NORMAL = `${EXPAND}${RG_BLOCK}${UPSTREAM}`;
const SHAPES = {
  plain: rewriteSnapshot(NORMAL),
  skewed: rewriteSnapshot(NORMAL, FINDINGS),
  native283: rewriteSnapshot(`${EXPAND}${NATIVE_283}`),
};

// The stand-in applet. A "match" is an argument spelled NEEDLE; -q silences the
// output (grep's quiet flag); STDIN copies stdin to stdout (proves stdin reaches the
// applet); --usage-error writes to stderr and exits 2 (grep's usage-error status);
// FLOOD writes lines until the reader goes away (so `| head -1` kills it with SIGPIPE).
const APPLET = [
  '#!/bin/sh',
  'hit=1 quiet=0',
  'for a in "$@"; do',
  '  case "$a" in',
  '    -q) quiet=1 ;;',
  '    NEEDLE) hit=0 ;;',
  '    STDIN) cat; exit 0 ;;',
  '    --usage-error) echo "stand-in: usage error" >&2; exit 2 ;;',
  '    FLOOD) while :; do echo flood; done ;;',
  '  esac',
  'done',
  'if [ "$hit" -eq 0 ] && [ "$quiet" -eq 0 ]; then printf "match-1\\nmatch-2\\n"; fi',
  'exit "$hit"',
  '',
].join('\n');

// Each row is a command the model could send, and the exact result the calling
// shell must produce. `status` is the status of the whole command.
const ROWS = [
  { name: 'an && chain and the command after it both run',
    cmd: 'grep -q NEEDLE f && echo A; echo B', stdout: 'A\nB\n', status: 0 },
  { name: 'an if-branch on grep runs, and so does what follows',
    cmd: 'if grep -q NEEDLE f; then echo yes; else echo no; fi; echo after', stdout: 'yes\nafter\n', status: 0 },
  { name: 'find reports its status to the next command (match)',
    cmd: 'find . -name NEEDLE; echo rc=$?', stdout: 'match-1\nmatch-2\nrc=0\n', status: 0 },
  { name: 'find reports its status to the next command (no match)',
    cmd: 'find . -name absent; echo rc=$?', stdout: 'rc=1\n', status: 0 },
  { name: 'rg reports its status to the next command',
    cmd: 'rg -n NEEDLE .; echo rc=$?', stdout: 'match-1\nmatch-2\nrc=0\n', status: 0 },
  { name: 'a lone grep -q with no match still exits 1',
    cmd: 'grep -q absent f', stdout: '', status: 1 },
  { name: 'a pipeline out of grep is unchanged',
    cmd: 'grep NEEDLE f | head -1', stdout: 'match-1\n', status: 0 },
  { name: 'stdin reaches the applet, and the shell continues after the pipeline',
    cmd: 'echo from-stdin | grep STDIN; echo rc=$?', stdout: 'from-stdin\nrc=0\n', status: 0 },
  { name: 'a usage error keeps status 2 and its stderr',
    cmd: 'grep --usage-error f; echo rc=$?', stdout: 'rc=2\n', status: 0, stderr: /stand-in: usage error/ },
  // SIGPIPE is not skew. `grep ... | head -1` ends the applet with SIGPIPE (status
  // 141); the skew trailer's `[ "$_rc" -ge 2 ]` used to read that as a usage error
  // and print "known applet skew" under a perfectly healthy pipeline.
  { name: 'an applet killed by SIGPIPE in a pipeline reports no skew',
    cmd: 'grep FLOOD f | head -1', stdout: 'flood\n', status: 0, noStderr: /known applet skew/ },
];

// Resolve each shell by NAME, absolutely, once. The Bash tool runs the user's own
// shell, and it is bash or zsh (the NetBSD spike saw zsh; darwin users have both), so
// the rule is asserted in each one that is present and skipped, by name, where it is
// not (zsh is not installed on every CI runner).
function which(name) {
  const r = cp.spawnSync('/bin/sh', ['-c', `command -v ${name}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
}
const SHELLS = process.platform === 'win32' ? [] : [
  { name: 'bash', bin: which('bash'), args: ['-c'] },
  // -f: no startup files, so a developer's ~/.zshenv cannot change what is measured.
  { name: 'zsh', bin: which('zsh'), args: ['-f', '-c'] },
];
const WIN_SKIP = 'the snapshot is sourced by bash/zsh; POSIX-shell sourcing has no Windows analog';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shadow-shell-'));
const applet = path.join(dir, 'applet');
fs.writeFileSync(applet, APPLET, { mode: 0o755 });
fs.writeFileSync(path.join(dir, 'f'), 'NEEDLE here\n');
for (const [shape, text] of Object.entries(SHAPES)) {
  fs.writeFileSync(path.join(dir, `snap-${shape}.sh`), text);
}

// No rg on PATH (the stand-in's directory and the system's, without any dir holding an rg), so upstream's guard
// takes its "no host rg" branch, as on a host without ripgrep.
const NO_RG_PATH = [dir, ...(process.env.PATH || '').split(':').filter((d) => d && !fs.existsSync(path.join(d, 'rg')))].join(':');
function runIn(shell, shape, cmd) {
  const env = { ...process.env, PATH: NO_RG_PATH, CLODE_UGREP: applet, CLODE_BFS: applet, CLAUDE_CODE_EXECPATH: applet, CLODE_T_CMD: cmd };
  delete env.BASH_ENV; delete env.ENV;
  // The Bash tool's own shape: source the snapshot, then eval the command.
  const script = `. '${path.join(dir, `snap-${shape}.sh`)}' && eval "$CLODE_T_CMD"`;
  return cp.spawnSync(shell.bin, [...shell.args, script], { cwd: dir, env, encoding: 'utf8' });
}

if (SHELLS.length === 0) test('a search shadow never replaces the calling shell', { skip: WIN_SKIP }, () => {});
for (const shell of SHELLS) {
  const skip = shell.bin ? false : `${shell.name} is not installed on this host`;
  for (const row of ROWS) {
    test(`${shell.name}: ${row.name}`, { skip }, () => {
      for (const shape of Object.keys(SHAPES)) {
        const r = runIn(shell, shape, row.cmd);
        const where = `${shell.name} (${shell.bin}), ${shape} shadow, command: ${row.cmd}\n`
          + `stdout: ${JSON.stringify(r.stdout)}\nstderr: ${JSON.stringify(r.stderr)}`;
        assert.strictEqual(r.stdout, row.stdout, where);
        assert.strictEqual(r.status, row.status, where);
        if (row.stderr) assert.match(r.stderr, row.stderr, where);
        if (row.noStderr) assert.doesNotMatch(r.stderr, row.noStderr, where);
      }
    });
  }
}

// The instrument: prove each shape's snapshot actually DEFINES the shadows the rows
// call, so a row can never pass because the shell fell through to the system grep,
// find or rg. The stand-in answers NEEDLE with "match-1"; no real tool does.
for (const shell of SHELLS) {
  test(`${shell.name}: the rows exercise the shadows, not the system tools`, { skip: shell.bin ? false : `${shell.name} is not installed on this host` }, () => {
    for (const shape of Object.keys(SHAPES)) {
      for (const tool of ['grep', 'find', 'rg']) {
        const r = runIn(shell, shape, `${tool} NEEDLE f`);
        assert.strictEqual(r.stdout, 'match-1\nmatch-2\n',
          `${shell.name}, ${shape} shadow: ${tool} did not reach the stand-in applet (stderr: ${r.stderr})`);
      }
    }
  });
}

// ---- quaude's own rg alias line, and only it (grep-native Task 10b fix round, review I-1/I-2) -------------------
// The runs below use NO_RG_PATH (above) unless they say otherwise.
function runSnap(shell, file, cmd, PATH = NO_RG_PATH) {
  const env = { ...process.env, PATH, CLODE_UGREP: applet, CLODE_BFS: applet, CLAUDE_CODE_EXECPATH: applet, CLODE_T_CMD: cmd };
  delete env.BASH_ENV; delete env.ENV;
  return cp.spawnSync(shell.bin, [...shell.args, `. '${file}' && eval "$CLODE_T_CMD"`], { cwd: dir, env, encoding: 'utf8' });
}
// --allowedTools naming Grep or Glob (upstream's searchToolsOptIn): the writer emits no find/grep shadows, so the
// snapshot is the rg block alone, and nothing else would define rg.
const OPTIN = path.join(dir, 'snap-optin.sh');
fs.writeFileSync(OPTIN, rewriteSnapshot(`${EXPAND}${RG_BLOCK}`));
// a user's own rg alias (in the rc the snapshot captured) must be honoured, as native honours it: `-q` silences
// the stand-in, so only the alias can explain an empty answer
const USER_ALIAS = path.join(dir, 'snap-user-alias.sh');
fs.writeFileSync(USER_ALIAS, rewriteSnapshot(`${EXPAND}alias rg='rg -q'\n${RG_BLOCK}${UPSTREAM}`));
// grep-native Task 10c: a host rg (here a tripwire) installed. Upstream's guard then defines no rg at all, so the Bash
// tool's `rg` is the host's, in EVERY mode, as native's is: normal mode (find/grep shadows present) and --allowedTools
// naming Grep or Glob (the rg block alone). quaude used to add its own rg beside the find/grep shadows, outside that
// guard, and so ran its translation instead of the host's rg in normal mode.
const HOST_RG = path.join(dir, 'host-rg');
fs.mkdirSync(HOST_RG);
fs.writeFileSync(path.join(HOST_RG, 'rg'), '#!/bin/sh\necho HOST-RG "$@"\n', { mode: 0o755 });
const NORMAL_FILE = path.join(dir, 'snap-normal.sh');
fs.writeFileSync(NORMAL_FILE, rewriteSnapshot(NORMAL));
for (const shell of SHELLS) {
  const skip = shell.bin ? false : `${shell.name} is not installed on this host`;
  test(`${shell.name}: with only the rg block (searchToolsOptIn), rg reaches quaude's rg shadow, not a missing file`, { skip }, () => {
    const r = runSnap(shell, OPTIN, 'rg NEEDLE f; echo rc=$?');
    assert.strictEqual(r.stdout, 'match-1\nmatch-2\nrc=0\n', r.stderr);
  });
  test(`${shell.name}: a user's own rg alias is honoured, as native honours it`, { skip }, () => {
    const r = runSnap(shell, USER_ALIAS, 'rg NEEDLE f; echo rc=$?');
    assert.strictEqual(r.stdout, 'rc=0\n', r.stderr);
  });
  for (const [mode, file] of [['normal mode', NORMAL_FILE], ['the rg block alone (searchToolsOptIn)', OPTIN], ['native 2.1.283\'s own snapshot', path.join(dir, 'snap-native283.sh')]]) {
    test(`${shell.name}: with a host rg installed, the Bash tool's rg is the host's (${mode}), as native's is`, { skip }, () => {
      const r = runSnap(shell, file, 'rg NEEDLE f; echo rc=$?', `${HOST_RG}:${NO_RG_PATH}`);
      assert.strictEqual(r.stdout, 'HOST-RG NEEDLE f\nrc=0\n', r.stderr);
    });
  }
}
test('rewriteSnapshot replaces only quaude\'s own rg alias line, in the file and in the generator, and no other', () => {
  // a host's own rg alias, at a path that is never RG_PATH (rg beside the binary running the bundle: under a node in
  // /usr/local/bin, as in a node container, `/usr/local/bin/rg` IS quaude's line, and was rewritten)
  const hostRg = '/opt/a-host-rg-dir/bin/rg';
  assert.notStrictEqual(hostRg, bunShim.RG_PATH);
  const other = `alias rg='rg -c'\n  alias rg='${hostRg}'\n`;
  assert.strictEqual(rewriteSnapshot(other), other);
  const file = rewriteSnapshot(RG_BLOCK);
  assert.doesNotMatch(file, /alias rg=/);
  assert.match(file, /function rg \{/);
  const gen = `SNAPSHOT_FILE=/x\n      echo '  alias rg='"'${bunShim.RG_PATH}'" >> "$SNAPSHOT_FILE"\n`;
  const g = rewriteSnapshot(gen);
  assert.doesNotMatch(g, /alias rg=/);
  // native's own heredoc and indentation (2.1.283's mAn), with native's function run against this binary (rg-entry.cjs)
  const fn = require('../libexec/rg-entry.cjs').rgShadowFunction(process.execPath);
  assert.ok(g.includes(`      cat >> "$SNAPSHOT_FILE" << 'RIPGREP_FUNC_END'\n  ${fn}\nRIPGREP_FUNC_END\n`), g);
  assert.ok(file.includes(`  ${fn}\n`), file);
});
// The generator itself, through the real interception: the bundle hands child_process a shell command that writes
// the snapshot; with only the rg block in it (no ARGV0 shadow), bun-shim must still rewrite it.
for (const shell of SHELLS) {
  const skip = shell.bin ? false : `${shell.name} is not installed on this host`;
  test(`${shell.name}: the snapshot GENERATOR with only the rg block is rewritten as it is spawned`, { skip }, () => {
    const out = path.join(dir, `gen-${shell.name}.sh`);
    const gen = [`SNAPSHOT_FILE='${out}'`, ': > "$SNAPSHOT_FILE"', `echo '${EXPAND.trim()}' >> "$SNAPSHOT_FILE"`,
      `echo "if ! (unalias rg 2>/dev/null; command -v rg) >/dev/null 2>&1; then" >> "$SNAPSHOT_FILE"`,
      `echo '  alias rg='"'${bunShim.RG_PATH}'" >> "$SNAPSHOT_FILE"`, 'echo "fi" >> "$SNAPSHOT_FILE"', ''].join('\n');
    const w = cp.spawnSync(shell.bin, [...shell.args, gen], { env: { ...process.env, PATH: NO_RG_PATH }, encoding: 'utf8' });
    assert.strictEqual(w.status, 0, w.stderr);
    const r = runSnap(shell, out, 'rg NEEDLE f; echo rc=$?');
    assert.strictEqual(r.stdout, 'match-1\nmatch-2\nrc=0\n', `${fs.readFileSync(out, 'utf8')}\n${r.stderr}`);
  });
}
