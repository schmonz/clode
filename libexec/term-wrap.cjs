'use strict';
// EVERY LINE CLODE PRINTS TO A TERMINAL FITS IT. Messages are written by some forty call sites across ten modules, and
// each was its own width: on 2026-11-26 a fresh-HOME first run (scripts/first-run.mjs) found lines of 87 and 139
// columns in an 80-column terminal, which the terminal broke mid-word. Wrapping each message where it is written is
// whack-a-mole; this wraps once, where they all go: clode-main installs it on process.stderr and process.stdout, each when it is a terminal.
// A pipe (a test, CI, a log) gets the bytes unchanged, so nothing that parses clode's output sees a difference.
//
// Wrapped: a whole line with no carriage return and no escape sequence (a spinner's \r redraw and a styled line are
// left alone; a line that only starts by clearing the spinner's line is wrapped after that), wider than the terminal,
// at spaces, continuation lines indented under the message after its `clode: ` / `clode: build: ` prefix (or under its
// own leading spaces). A word wider than the room overhangs intact.

const PREFIX = /^(?:clode: (?:[a-z][a-z-]*: )?|\s+)/;

const CLEAR = '\r\x1b[K';   // a line written ABOVE a live spinner (clode-build.cjs makePhaseSpinner say) starts by clearing it

function wrapLine(line, cols) {
  if (line.startsWith(CLEAR)) return CLEAR + wrapLine(line.slice(CLEAR.length), cols);
  if ([...line].length <= cols || line.includes('\r') || line.includes('\x1b')) return line;
  const lead = (PREFIX.exec(line) || [''])[0];
  const indent = ' '.repeat(Math.min(lead.length, Math.floor(cols / 3)));
  const out = [];
  let cur = lead;
  for (const word of line.slice(lead.length).split(' ')) {
    const room = cols - [...cur].length;
    if (cur.trim() && cur !== lead && [...word].length + 1 > room) { out.push(cur); cur = indent + word; continue; }
    cur = cur === lead || cur === indent ? cur + word : `${cur} ${word}`;
  }
  out.push(cur);
  return out.join('\n');
}

function wrapForTerminal(text, cols) {
  return String(text).split('\n').map((l) => wrapLine(l, cols)).join('\n');
}

// Patch a TTY stream's write so each string it is handed is wrapped to the stream's width (its `columns`, else 80).
// Idempotent; a non-TTY stream is returned untouched.
function installTermWrap(stream) {
  if (!stream || !stream.isTTY || stream.__clodeTermWrap) return stream;
  const write = stream.write.bind(stream);
  stream.write = (chunk, ...rest) => write(typeof chunk === 'string' ? wrapForTerminal(chunk, stream.columns > 20 ? stream.columns : 80) : chunk, ...rest);
  stream.__clodeTermWrap = true;
  return stream;
}

module.exports = { wrapForTerminal, wrapLine, installTermWrap };
