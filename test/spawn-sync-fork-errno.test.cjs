'use strict';
// The pre-10.5 Darwin (Tiger) fork/exec branch of the engine's __tjs_spawn_sync must report a
// failed chdir/dup2/execve as the SPAWN's errno, as posix_spawn does everywhere else: node's
// spawnSync gives .error ENOENT and status null for a program that is not there. A child that
// just _exit(127)s instead reads to every caller as "the tool ran and failed". On 2026-11-26
// that made clode build on Tiger read an absent codesign as a failed one and stop, because
// codesignAdHoc's "no codesign on pre-10.5 Darwin" branch keys on error.code === 'ENOENT'.
//
// WHY A SOURCE GUARD and not a run: this branch is compiled only into the darwin-x86 and
// darwin-ppc engines, and both legs are no-exec (nothing in CI can run them). The Tiger VMs
// are the oracle for the behaviour itself (BACKLOG, "code only no-exec legs compile is never
// run"). This guard keeps the shape: in the forked child, every exit is preceded by writing
// the errno to the parent.
const fs = require('node:fs');
const path = require('node:path');
const { defineGuard, guardTests } = require('./guard.cjs');

const PATCH = path.join(__dirname, '..', 'spike', 'quickjs', 'patches', 'txiki-spawn-sync-fork-errno.patch');

// The patch's new side (context and added lines), as C source.
function newSide(patchText) {
  return patchText.split('\n')
    .filter((l) => !l.startsWith('+++') && !l.startsWith('---') && !l.startsWith('@@'))
    .filter((l) => l.startsWith(' ') || l.startsWith('+'))
    .map((l) => l.slice(1)).join('\n');
}

// The forked child's block: from `pid == 0) {` to its matching close brace.
function childBlock(src) {
  const at = src.indexOf('pid == 0) {');
  if (at < 0) return null;
  let depth = 0;
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
  }
  return null;
}

const guard = defineGuard({
  name: 'pre-10.5 fork/exec spawn reports the child\'s errno before every exit',
  read: () => ({ src: newSide(fs.readFileSync(PATCH, 'utf8')) }),
  scan: ({ src }) => {
    const block = childBlock(src);
    if (block === null) return { findings: [], examined: 0 };
    const findings = [];
    const exits = [...block.matchAll(/_exit\s*\(/g)];
    for (const m of exits) {
      if (!/\bwrite\s*\(/.test(block.slice(0, m.index))) {
        findings.push(`the forked child exits at offset ${m.index} without first writing its errno to the parent`);
      }
    }
    return { findings, examined: exits.length };
  },
  // The branch as it shipped before 2026-11-26: three bare _exit(127)s.
  control: () => ({
    src: [
      '    pid = fork();',
      '    if (pid < 0) {',
      '        rc = errno;',
      '    } else if (pid == 0) {',
      '        if (cwd && chdir(cwd) != 0)',
      '            _exit(127);',
      '        execve(file, cargv, cenv ? cenv : environ);',
      '        _exit(127);',
      '    }',
    ].join('\n'),
  }),
});

guardTests(guard);
