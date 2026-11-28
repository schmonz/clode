'use strict';
// 256-colour SGR on a 16-colour terminal (BACKLOG "Tiger's Terminal.app blinks on 256-color text"). Upstream writes
// `ESC[38;5;Nm` whatever the terminal; Tiger's Terminal.app reads `38;5;174` as 38, 5 (BLINK), 174, and the blink
// stays on. quaude's tty.WriteStream rewrites those colours to the 16, as upstream's own colour library converts them
// at level 1, when the terminal lacks 256
// (libexec/node-shim/internal/term-colors.cjs decides; libexec/unicode-text.cjs's SGR-16 rewrites).
//   (a) the capability decision, as a table;
//   (b) the rewriter: one SGR's parameters, the colour table over the codes native's theme picker really
//       writes (test/fixtures/theme-picker-native-2.1.332.bin, captured from native 2.1.332 in a pty under
//       TERM=xterm-color, fresh HOME: byte-identical under TERM=xterm-256color), and a stream split at every byte;
//   (c) the shim under tjs in a real pty: a 256-colour TERM gets the bytes host node writes, exactly; xterm-color
//       gets them rewritten, with no 256-colour or 24-bit code left.
// The built-quaude end-to-end is in test/quaude-build.test.cjs ("theme picker").
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { colorLevel, has256Colors } = require('../libexec/node-shim/internal/term-colors.cjs');
const { sgrParamsTo16, sgr16Rewriter, rgbToAnsi256, ansi256ToAnsi } = require('../libexec/unicode-text.cjs');
const { skipUnlessTjs, tjsPath, LOADER } = require('./node-shim-helper.cjs');
const { ptyRun } = require('./node-shim-tty-helper.cjs');

const FIXTURE = path.join(__dirname, 'fixtures', 'theme-picker-native-2.1.332.bin');
// What counts as a code a 16-colour terminal misreads: 38/48/58 with a 5 or 2 sub-mode, either spelling.
const wideCodes = (s) => (s.match(/\x1b\[[0-9;:]*m/g) || []).filter((q) => /(?:\[|;)[345]8[;:][25][;:]/.test(q));

test('(a) the capability decision: which terminals keep 256-colour SGR', () => {
  const rows = [
    // [env, platform, has256, why]
    [{ TERM: 'xterm-color', TERM_PROGRAM: 'Apple_Terminal' }, 'darwin', false, "Tiger's Terminal.app: the reason this exists"],
    [{ TERM: 'xterm-color', TERM_PROGRAM: 'Apple_Terminal', FORCE_COLOR: '1' }, 'darwin', false, 'FORCE_COLOR=1 is 16 colours'],
    [{ TERM: 'xterm-256color', TERM_PROGRAM: 'Apple_Terminal' }, 'darwin', true, 'Terminal.app since 10.7'],
    [{ TERM: 'xterm-256color' }, 'linux', true, 'every Linux distro default'],
    [{ TERM: 'screen-256color' }, 'linux', true, '-256color'],
    [{ TERM: 'tmux-256color' }, 'linux', true, '-256color'],
    [{ TERM: 'rxvt-unicode-256color' }, 'linux', true, '-256color'],
    [{ TERM: 'xterm-256' }, 'linux', true, "supports-color's -256 spelling"],
    [{ TERM: 'xterm-direct' }, 'linux', true, 'terminfo direct colour'],
    [{ TERM: 'xterm-truecolor' }, 'linux', true, 'names truecolor'],
    [{ TERM: 'xterm-kitty' }, 'linux', true, 'supports-color level 3'],
    [{ TERM: 'xterm-ghostty' }, 'darwin', true, 'supports-color level 3'],
    [{ TERM: 'wezterm' }, 'linux', true, 'supports-color level 3'],
    [{ TERM: 'alacritty' }, 'linux', true, "the bundle's truecolor raise"],
    [{ TERM: 'foot' }, 'linux', true, "the bundle's truecolor raise"],
    [{ TERM: 'xterm', COLORTERM: 'truecolor' }, 'linux', true, 'COLORTERM=truecolor'],
    [{ TERM: 'xterm', COLORTERM: '24bit' }, 'linux', true, 'COLORTERM=24bit'],
    [{ TERM: 'xterm-color', TERM_PROGRAM: 'iTerm.app', TERM_PROGRAM_VERSION: '2.1' }, 'darwin', true, 'iTerm2 at any version'],
    [{ TERM: 'xterm' }, 'linux', false, 'plain xterm: supports-color level 1'],
    [{ TERM: 'screen' }, 'linux', false, 'screen: level 1'],
    [{ TERM: 'vt100' }, 'netbsd', false, 'vt100'],
    [{ TERM: 'linux' }, 'linux', false, 'the Linux console'],
    [{ TERM: 'xterm', COLORTERM: '1' }, 'linux', false, 'COLORTERM set to something else: level 1'],
    [{}, 'linux', false, 'no TERM at all'],
    [{ TERM: 'dumb' }, 'linux', false, 'dumb'],
    [{ FORCE_COLOR: '3' }, 'linux', true, "no TERM: FORCE_COLOR's level stands"],
    [{ TERM: 'xterm-color', FORCE_COLOR: '3' }, 'darwin', false, 'FORCE_COLOR is only the floor, as in supports-color'],
    [{ TERM: 'xterm-256color', FORCE_COLOR: '0' }, 'linux', false, 'FORCE_COLOR=0: no colour'],
    [{ TERM: 'xterm-256color', CI: 'true', GITHUB_ACTIONS: 'true' }, 'linux', true, 'CI variables are not consulted'],
    [{ TERM: 'xterm-color' }, 'win32', true, 'Windows 10+: conhost has 256'],
    [{}, 'win32', true, 'Windows with no TERM'],
  ];
  for (const [env, platform, want, why] of rows) {
    assert.strictEqual(has256Colors(env, platform), want, `${JSON.stringify(env)} on ${platform}: ${why}`);
  }
  assert.strictEqual(colorLevel({ TERM: 'xterm-color', TERM_PROGRAM: 'Apple_Terminal' }, 'darwin'), 1);
});

test('(b) one SGR: the 256-colour and 24-bit parameters become 16-colour ones, nothing else moves', () => {
  const rows = [
    ['38;5;174', '31'], ['48;5;174', '41'], ['38;5;1', '31'], ['38;5;9', '91'], ['48;5;15', '107'],
    ['1;38;5;231;48;5;52', '1;97;40'], ['38;5;77;1', '32;1'], ['0;38;2;255;0;0', '0;91'], ['48;2;0;0;238', '104'],
    ['38:5:196', '91'], ['38:2::0:255:0', '92'], ['38:2:0:255:0', '92'], ['48:2:1:0:0:0', '40'],
    ['58;5;3', ''], ['4;58;2;1;2;3', '4'], ['4:3;58:5:9', '4:3'],
    ['38;5;999', '37'],                               // over 255 reads as 255, the lightest grey
  ];
  for (const [from, to] of rows) assert.strictEqual(sgrParamsTo16(from), to, from);
  // left alone: no 256/24-bit colour, or one missing its parameters, or not an SGR's parameters
  for (const p of ['', '0', '1;31', '38;5', '48;2;1;2', '38', '39;49', '22', '>4;2', '?25', '4:3', '5']) {
    assert.strictEqual(sgrParamsTo16(p), null, p);
  }
});

test('(b) the 16 for every code native 2.1.332\'s theme picker writes: upstream\'s own level-1 conversion', () => {
  const s = fs.readFileSync(FIXTURE, 'latin1');
  const fg = new Set(), bg = new Set();
  for (const m of s.matchAll(/\x1b\[(38|48);5;(\d+)m/g)) (m[1] === '38' ? fg : bg).add(Number(m[2]));
  assert.deepStrictEqual([...fg].sort((a, b) => a - b), [16, 77, 81, 114, 148, 153, 167, 174, 186, 231, 239, 246]);
  assert.deepStrictEqual([...bg].sort((a, b) => a - b), [22, 28, 52, 174]);
  // [palette entry, foreground code]; the background is the same plus 10. Upstream's choice, kept even where it is
  // not pretty: the diff's dark green/red backgrounds (22, 28, 52) and the dark grey 239 go black, 246 white.
  const table = [
    [16, 30], [22, 30], [28, 30], [52, 30], [77, 32], [81, 96], [114, 32], [148, 33], [153, 97], [167, 31], [174, 31],
    [186, 33], [231, 97], [239, 30], [246, 37],
    [196, 91], [46, 92], [21, 94], [226, 93], [201, 95], [51, 96], [232, 30], [255, 37],
    [0, 30], [7, 37], [8, 90], [15, 97],
  ];
  for (const [n, want] of table) {
    assert.strictEqual(ansi256ToAnsi(n, 30), want, `foreground of ${n}`);
    assert.strictEqual(ansi256ToAnsi(n, 40), want + 10, `background of ${n}`);
  }
});

// UPSTREAM'S OWN CONVERSION, run: test/fixtures/color-level1-native-2.1.332.js is `function R` from the 2.1.332 carve's
// /$bunfs/root/chunk-3d163xan.js, verbatim (its colour library's rgb()/bgRgb()). Evaluated with its two free
// constants as that chunk defines them (v=30, y=60) and C returning the opening it is handed, it must agree with
// rgbToAnsi256 + ansi256ToAnsi at level 1, and with rgbToAnsi256 at level 2, over a grid of colours and every grey.
test('(b) rgbToAnsi256 + ansi256ToAnsi are upstream\'s function R, at levels 1 and 2', () => {
  const src = fs.readFileSync(path.join(__dirname, 'fixtures', 'color-level1-native-2.1.332.js'), 'utf8');
  const R = new Function('C', 'v', 'y', `return ${src}`)((_e, opening) => opening, 30, 60);
  let n = 0;
  const check = (r, g, b) => {
    n++;
    for (const base of [30, 40]) {
      assert.strictEqual(R({ level: 1 }, base, r, g, b), `\x1b[${ansi256ToAnsi(rgbToAnsi256(r, g, b), base)}m`, `${base} ${r},${g},${b}`);
      assert.strictEqual(R({ level: 2 }, base, r, g, b), `\x1b[${base + 8};5;${rgbToAnsi256(r, g, b)}m`, `256 ${r},${g},${b}`);
    }
  };
  for (let r = 0; r < 256; r += 15) for (let g = 0; g < 256; g += 15) for (let b = 0; b < 256; b += 15) check(r, g, b);
  for (let x = 0; x < 256; x++) check(x, x, x);
  assert.ok(n > 5000, `${n} colours`);
});

test('(b) a stream split at every byte rewrites as the whole does, holding only a cut-off CSI', () => {
  const whole = fs.readFileSync(FIXTURE, 'utf8');
  const once = sgr16Rewriter();
  const expected = once.rewrite(whole) + once.flush();
  assert.deepStrictEqual(wideCodes(expected), [], 'no 256-colour code survives');
  assert.ok(wideCodes(whole).length >= 30, `the fixture carries the picker's codes (${wideCodes(whole).length})`);
  // the rewrite changes only those codes: put each back and the stream is the fixture again
  assert.strictEqual(expected.replace(/\x1b\[[0-9;]*m/g, ''), whole.replace(/\x1b\[[0-9;]*m/g, ''));
  for (const step of [1, 2, 3, 5, 7, 11, 64]) {
    const r = sgr16Rewriter();
    let out = '';
    for (let i = 0; i < whole.length; i += step) out += r.rewrite(whole.slice(i, i + step));
    out += r.flush();
    assert.strictEqual(out, expected, `split every ${step}`);
  }
  // what is held is a cut-off CSI (or a lone ESC), nothing else: the text before it goes out at once
  const r = sgr16Rewriter();
  assert.strictEqual(r.rewrite('ab\x1b'), 'ab');
  assert.strictEqual(r.rewrite('[38;5'), '');
  assert.strictEqual(r.rewrite(';174mX'), '\x1b[31mX');
  assert.strictEqual(r.rewrite('\x1b]0;title'), '\x1b]0;title', 'an OSC is not held');
  assert.strictEqual(r.rewrite('\x1b[3'), '');
  assert.strictEqual(r.flush(), '\x1b[3');
});

test('(b) mixed SGRs and other sequences: only the wide colours change, introducers kept', () => {
  const r = sgr16Rewriter();
  const s = 'x\x1b[1m\x1b[38;5;167;1m\x1b[?25l\x1b[2J\x9b48;5;22m\x1b[38;2;255;255;0mY\x1b[39;49;22m\x1b[58;5;4m\x1b[4:3m'
    + '\x1b]8;;http://a/38;5;1\x07z\x1b[>4;2m';
  assert.strictEqual(r.rewrite(s),
    'x\x1b[1m\x1b[31;1m\x1b[?25l\x1b[2J\x9b40m\x1b[93mY\x1b[39;49;22m\x1b[4:3m\x1b]8;;http://a/38;5;1\x07z\x1b[>4;2m');
  // a string with nothing to rewrite is handed back as the same string
  const plain = 'hello \x1b[1mworld\x1b[22m';
  assert.strictEqual(sgr16Rewriter().rewrite(plain), plain);
});

// (c) the shim's tty.WriteStream, under tjs in a real pty, against host node writing the same chunks. Mouse and focus
// suppression (tty.cjs's other output filter) is switched off so the comparison sees colour alone.
function writerFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'term-colors-'));
  const f = path.join(dir, 'w.cjs');
  fs.writeFileSync(f, [
    "'use strict';",
    'const fs = require("fs");',
    'const [file, step, rewrite] = process.argv.slice(2);',
    'let s = fs.readFileSync(file, "utf8");',
    `if (rewrite === "1") { const r = require(${JSON.stringify(path.join(__dirname, '..', 'libexec', 'unicode-text.cjs'))}).sgr16Rewriter(); s = r.rewrite(s) + r.flush(); }`,
    'const cps = Array.from(s);',
    'for (let i = 0; i < cps.length; i += Number(step)) process.stdout.write(cps.slice(i, i + Number(step)).join(""));',
    'process.stdout.write("\\n@@END@@\\n");',
  ].join('\n'));
  return f;
}
const ptyEnv = () => {
  const env = { ...process.env, CLODE_TTY_MOUSE: '1', CLODE_TTY_FOCUS: '1', TERM_PROGRAM: 'Apple_Terminal' };
  delete env.COLORTERM; delete env.FORCE_COLOR; delete env.TERM_PROGRAM_VERSION;
  return env;
};
const body = (out) => out.slice(0, out.indexOf('@@END@@'));

const runLoaderPtyArgs = (w, extra, opts) => ptyRun({ ...opts, cmd: tjsPath(), args: ['run', LOADER, w, ...extra] });
const runNodePtyArgs = (w, extra, opts) => ptyRun({ ...opts, cmd: process.execPath, args: [w, ...extra] });

test('(c) under tjs: a 256-colour terminal gets exactly the bytes host node writes', async (t) => {
  if (skipUnlessTjs(t)) return;
  const w = writerFixture();
  const opts = { env: ptyEnv(), name: 'xterm-256color', cols: 100, rows: 40 };
  const qq = await runLoaderPtyArgs(w, [FIXTURE, '7'], opts);
  const rr = await runNodePtyArgs(w, [FIXTURE, '7'], opts);
  assert.ok(rr.out.includes('@@END@@') && qq.out.includes('@@END@@'), `${rr.out.slice(-200)}\n---\n${qq.out.slice(-200)}`);
  assert.ok(wideCodes(body(qq.out)).length >= 30, 'the 256-colour codes reach a 256-colour terminal');
  assert.strictEqual(body(qq.out), body(rr.out));
});

test('(c) under tjs: xterm-color gets the colours rewritten, split writes and all, no 256-colour code left', async (t) => {
  if (skipUnlessTjs(t)) return;
  const w = writerFixture();
  const opts = { env: ptyEnv(), name: 'xterm-color', cols: 100, rows: 40 };
  const qq = await runLoaderPtyArgs(w, [FIXTURE, '3'], opts);
  const rr = await runNodePtyArgs(w, [FIXTURE, '3', '1'], opts);
  assert.ok(rr.out.includes('@@END@@') && qq.out.includes('@@END@@'), `${rr.out.slice(-200)}\n---\n${qq.out.slice(-200)}`);
  assert.deepStrictEqual(wideCodes(body(qq.out)), []);
  assert.strictEqual(body(qq.out), body(rr.out));
});
