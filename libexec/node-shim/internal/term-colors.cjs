'use strict';
// Does quaude's terminal draw 256 colours? node-shim's tty.WriteStream asks, once, and when the answer is no it
// rewrites 256-colour and 24-bit SGR to the 16 colours on the way out (unicode-text.cjs's SGR-16 says how).
//
// WHY THIS DIVERGES FROM UPSTREAM (a deliberate, written-reason divergence; match-upstream-by-default otherwise).
// Upstream Claude Code 2.1.332 writes `ESC[38;5;Nm` / `ESC[48;5;Nm` on its welcome and theme-picker screens whatever
// the terminal, even with FORCE_COLOR=1 (NO_COLOR=1 still leaves 14). On a terminal with no 256 colours that code is
// not merely another colour: Mac OS X 10.4's Terminal.app (TERM=xterm-color, TERM_PROGRAM=Apple_Terminal, no
// COLORTERM) reads `38;5;174` as attributes 38, 5 (BLINK) and 174, and upstream closes colours with 39/49 and never
// with 25 or 0, so everything drawn after it blinks, screens with no 256-colour code included, and an "(ANSI colors
// only)" theme does not help. Native never runs on that terminal; quaude does. Measured 2026-11-27: the user ran
// `printf '\033[38;5;174mhello\033[0m\n'` in Tiger's Terminal.app and it blinked.
//
// THE DECISION mirrors upstream's own colour detection: the supports-color level its chalk instance computes
// (2.1.332's bundle, `function I({environment, argv, isTerminal, windowsRelease})`, plus the bundle's raise of
// alacritty/contour/foot/ghostty/rio/wezterm/xterm-ghostty/xterm-kitty to truecolor), read as "256 colours" at level 2
// and up. Where it differs, and why:
//   - TERM_PROGRAM=Apple_Terminal alone is NOT taken as 256 colours (supports-color says level 2). Tiger's Terminal.app
//     sets it too, and Tiger's is the terminal this exists for. Every Terminal.app since Mac OS X 10.7 sets
//     TERM=xterm-256color by default, which the TERM rule below passes, so a modern Terminal.app is unchanged.
//   - TERM containing "256color", "direct" or "truecolor" (xterm-direct, a terminfo truecolor entry) and
//     COLORTERM=24bit (the other spelling terminals export) are 256 colours too; supports-color only knows `-256` and
//     COLORTERM=truecolor, and calls these level 1.
//   - CI, TeamCity and Azure Pipelines variables are not consulted: they say where the process runs, not what the
//     terminal it draws on can show (a pty under CI is a test harness), and taking them would make a CI run draw
//     differently from the same run on a desk.
//   - win32 is always 256 colours. supports-color says level 2 from Windows 10 build 10586 (conhost's 256 colours);
//     quaude's engine runs on libuv past 1.45 (scripts/build-tjs.cjs), which supports nothing before Windows 10, so
//     every Windows a quaude runs on is past that build. Under a forced-win32 run on a POSIX host this answer is
//     also what keeps the bytes as they were.
//   - command-line --color flags are not read: quaude's argv is upstream's.
// There is no CLODE_* knob: the terminal's own variables are the override (COLORTERM=truecolor, or a -256color TERM,
// says it can; TERM=xterm-color says it cannot), the way every other colour-aware program is told.
//
// The level, as supports-color numbers it (0 none, 1 the 16 colours, 2 256 colours, 3 24-bit).
const TRUECOLOR_TERMS = new Set(['xterm-kitty', 'xterm-ghostty', 'wezterm', 'alacritty', 'contour', 'foot', 'ghostty', 'rio']);
function colorLevel(env, platform) {
  const fc = env.FORCE_COLOR;
  let forced;
  if (fc === '' || fc === 'true') forced = 1;
  else if (fc !== undefined) forced = fc === 'false' ? 0 : parseInt(fc, 10);
  if (forced === 0) return 0;
  const floor = [0, 1, 2, 3][Math.min(forced || 0, 3)] || 0;
  const term = env.TERM || '';
  if (term === 'dumb') return floor;
  if (platform === 'win32') return Math.max(2, floor);
  const ct = env.COLORTERM;
  if (ct === 'truecolor' || ct === '24bit' || TRUECOLOR_TERMS.has(term)) return 3;
  if (env.TERM_PROGRAM === 'iTerm.app') return parseInt(env.TERM_PROGRAM_VERSION || '', 10) >= 3 ? 3 : 2;
  if (/-256(?:color)?$/i.test(term) || /256color|direct|truecolor/i.test(term)) return 2;
  if (ct !== undefined || /^(?:rxvt|screen|vt100|vt220|xterm)|ansi|color|cygwin|linux/i.test(term)) return 1;
  return floor;
}
const has256Colors = (env, platform) => colorLevel(env, platform) >= 2;

module.exports = { colorLevel, has256Colors };
