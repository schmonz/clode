'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { wrapForTerminal, installTermWrap } = require('../libexec/term-wrap.cjs');

const widest = (t) => Math.max(...t.split('\n').map((l) => [...l].length));

test('term-wrap: the 139-column first-run line fits 80, indented under its message', () => {
  const line = "clode: build: no Claude Code binary found — run 'clode fetch claude' to fetch one, or install the pinned Claude Code and pass CLODE_CLAUDE_BIN";
  const w = wrapForTerminal(line, 80);
  assert.ok(widest(w) <= 80, w);
  assert.strictEqual(w.replace(/\n {14}/g, ' '), line, 'only the line breaks changed');
  assert.match(w.split('\n')[1], /^ {14}\S/);
});

test('term-wrap: a line said above a live spinner wraps after its clear', () => {
  const w = wrapForTerminal(`\r\x1b[Kclode: build: ${'skew '.repeat(30).trim()}\n`, 80);
  assert.ok(w.startsWith('\r\x1b[Kclode: build: skew'), JSON.stringify(w));
  assert.ok(widest(w.replace('\r\x1b[K', '')) <= 80, w);
});

test('term-wrap: short lines, spinner redraws, styled lines and unbreakable words are left alone', () => {
  for (const s of ['clode: ok', `\r⠋ Extracting bundle… (0.0s)${' x'.repeat(60)}`, `\x1b[1m${'word '.repeat(30)}\x1b[0m`]) assert.strictEqual(wrapForTerminal(s, 80), s);
  const url = `clode: see https://example.com/${'a'.repeat(100)}`;
  assert.strictEqual(wrapForTerminal(url, 80), `clode: see\n       https://example.com/${'a'.repeat(100)}`);
});

test('term-wrap: only a terminal is wrapped, at its own width, once', () => {
  const got = [];
  const pipe = { isTTY: false, write: (c) => got.push(c) };
  installTermWrap(pipe).write(`${'x '.repeat(60)}\n`);
  assert.strictEqual(got[0], `${'x '.repeat(60)}\n`, 'a pipe gets the bytes unchanged');
  const tty = { isTTY: true, columns: 40, write: (c) => got.push(c) };
  installTermWrap(installTermWrap(tty)).write(`${'word '.repeat(20).trim()}\n`);
  assert.ok(widest(got[1]) <= 40, got[1]);
  const b = Buffer.from(`${'y '.repeat(60)}\n`);
  tty.write(b);
  assert.strictEqual(got[2], b, 'bytes (not a string) pass through');
});
