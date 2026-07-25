// Shared rg→ugrep fixture, consumed by the JS unit test (Task 1) and the
// locked twin test (Task 2). Both implementations must agree over OK; both
// must reject over THROWS. Keep inputs to forms BOTH twins handle.
'use strict';
const D = ['-r', '--ignore-files', '-I']; // injected defaults, in order
module.exports = {
  OK: [
    { in: ['foo'],                    out: [...D, 'foo'] },
    { in: ['-i', 'foo'],              out: [...D, '-i', 'foo'] },
    { in: ['-n', 'foo', 'src'],       out: [...D, '-n', 'foo', 'src'] },
    { in: ['-S', 'foo'],              out: [...D, '-j', 'foo'] },
    { in: ['--smart-case', 'foo'],    out: [...D, '-j', 'foo'] },
    { in: ['-g', '*.js', 'foo'],      out: [...D, '--include=*.js', 'foo'] },
    { in: ['--glob=!*.min.js', 'x'],  out: [...D, '--exclude=*.min.js', 'x'] },
    { in: ['--no-ignore', 'foo'],     out: ['-r', '-I', 'foo'] },
    { in: ['--hidden', 'foo'],        out: [...D, '-.', 'foo'] },
    { in: ['-A', '3', 'foo'],         out: [...D, '-A', '3', 'foo'] },
    { in: ['--', '-foo'],             out: [...D, '--', '-foo'] },
  ],
  THROWS: [
    { in: ['--json', 'foo'], flag: '--json' },
    { in: ['-t', 'py', 'foo'], flag: '-t' },
    { in: ['--files'], flag: '--files' },
  ],
};
