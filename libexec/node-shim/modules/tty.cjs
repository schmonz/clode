'use strict';
// node:tty — minimal surface for the -p boot. The bundle require()s it (ESM
// interop probe tty.__esModule, then tty.isatty) to decide whether stdio is a
// terminal. Under the loader, stdio is treated as non-tty (modules/process.cjs
// sets stdout.isTTY=false and stdin.isTTY=undefined), and the acceptance runs
// capture stdout through a pipe — so isatty is false for every fd. Characterized
// by test/node-shim-core.test.cjs (tty row).
//
// isatty over fd 0/1/2 via the shared side-effect-free fstat/S_IFCHR check
// (internal/terminal-fd.cjs). REGRESSION HISTORY: this used to read
// tjs.stdin.isTerminal / tjs.stdout.isTerminal / tjs.stderr.isTerminal
// directly — merely READING those tjs stdio streams lazily constructs tjs's
// async libuv wrapper for that fd, which as a side effect flips the fd to
// O_NONBLOCK. That broke writeSyncFd's blocking short-write loop: once
// isatty(1) had been called (e.g. by chalk/supports-color at module load on
// the -p path), a later process.stdout.write() bigger than the pipe's kernel
// buffer (~64KB) would short-write and throw `EUNKNOWN, write ''`, silently
// losing bytes on the non-TTY fast path. See
// test/node-shim-tty.test.cjs ("a large process.stdout.write after
// isatty(1)...") for the characterization lock. Other fds aren't individually
// probeable from JS in this build → false (the bundle only asks about 0/1/2).
const { isTerminalFd } = require('../internal/terminal-fd.cjs');
function isatty(fd) {
  if (fd === 0 || fd === 1 || fd === 2) return isTerminalFd(fd);
  return false;
}

const { EventEmitter } = require('node:events');
const { writeSyncFd } = require('../internal/stdio-write.cjs');

// fd -> the tjs public stream that exposes width/height for that terminal.
function tjsStreamForFd(fd) {
  if (fd === 2) return tjs.stderr;
  return tjs.stdout;
}

const { Readable } = require('node:stream');

// tty.ReadStream over tjs.stdin (a WHATWG ReadableStream). An async pump reads
// tjs.stdin and feeds bytes to whichever consumption mode is in use. Unlike the
// shim's base Readable (stream.cjs), which is FLOWING-ONLY (push → immediately
// emit 'data', no buffer, no .read()), this stream supports BOTH modes, because
// Ink drives stdin in PAUSED mode: it attaches an 'readable' listener and calls
// .read() in a loop (see the bundle's suspendStdin/resumeStdin, which add/remove
// 'readable' listeners). A flowing-only stream never fires 'readable' and has no
// .read(), so Ink's keyboard input would never arrive — the reason the
// interactive TUI hung at startup. So this class owns the read side entirely
// (its own byte queue + decoder) rather than delegating to the base push/'data'.
//
// Modes:
//  - PAUSED (default / after pause()): buffered bytes accumulate in _queue and a
//    'readable' event fires; the consumer drains via read(n).
//  - FLOWING (after resume() or an 'data' listener): buffered bytes are emitted
//    as 'data' events as they arrive.
// The pump starts lazily on the first of: resume(), an 'data'/'readable'
// listener, setRawMode(true), or a read() call (matching node's "stdin flows
// once someone asks for data" so merely touching process.stdin doesn't pin the
// event loop on non-interactive paths). _startPump is idempotent (guarded by
// _pumping). DIVERGENCE (documented): backpressure is best-effort — the pump
// pushes every chunk the reader yields rather than honoring highWaterMark; Ink
// consumes keystrokes fast enough that this is not observable.
//
// Encoding: with setEncoding('utf8') (Ink's own), bytes are decoded through a
// SINGLE persistent TextDecoder fed { stream: true }, so a multi-byte character
// split across two pump reads (e.g. the 4-byte emoji F0 9F 99 82 arriving as two
// chunks) reassembles exactly like host node's StringDecoder, instead of
// emitting U+FFFD. Non-utf8 encodings decode per read()/chunk (best-effort;
// documented) — Ink only uses utf8.
class ReadStream extends Readable {
  constructor(fd) {
    super();
    this.fd = fd;
    this.isTTY = true;
    this.isRaw = false;
    this._pumping = false;
    this._flowing = false;
    this._ended = false;
    this._queue = [];             // pending raw Buffers (paused-mode backlog)
    this._encoding = null;
    this._utf8Decoder = null;
  }
  _read() { this._startPump(); }
  _startPump() {
    if (this._pumping) return;
    this._pumping = true;
    const reader = tjs.stdin.getReader();
    (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) { this._ended = true; if (this._flowing) queueMicrotask(() => this.emit('end')); else queueMicrotask(() => this.emit('readable')); break; }
          if (value && value.length) this._ingest(Buffer.from(value));
        }
      } catch (e) {
        this.destroy(e);
      } finally {
        try { reader.releaseLock(); } catch { /* */ }
      }
    })();
  }
  _ingest(buf) {
    this._queue.push(buf);
    if (this._flowing) this._flush();
    else queueMicrotask(() => this.emit('readable'));
  }
  _flush() {
    while (this._flowing && this._queue.length) {
      const b = this._queue.shift();
      this.emit('data', this._decode(b));
    }
  }
  _decode(buf) {
    if (this._utf8Decoder) return this._utf8Decoder.decode(buf, { stream: true });
    if (this._encoding) return buf.toString(this._encoding);
    return buf;
  }
  // Paused-mode read: return up to n bytes (all buffered if n omitted), or null
  // when nothing is buffered (Ink's loop stops on null). Starts the pump so a
  // first read() before any data still arms input.
  read(n) {
    if (this._queue.length === 0) {
      this._startPump();
      if (this._ended) queueMicrotask(() => this.emit('end'));
      return null;
    }
    let b = this._queue.length === 1 ? this._queue.shift() : Buffer.concat(this._queue.splice(0));
    if (typeof n === 'number' && n >= 0 && n < b.length) {
      this._queue.unshift(b.subarray(n));
      b = b.subarray(0, n);
    }
    return this._decode(b);
  }
  setRawMode(mode) {
    try { tjs.stdin.setRawMode(!!mode); } catch { /* not a terminal */ }
    this.isRaw = !!mode;
    if (mode) this._startPump();
    return this;
  }
  setEncoding(enc) {
    this._encoding = enc;
    const norm = String(enc).toLowerCase();
    this._utf8Decoder = (norm === 'utf8' || norm === 'utf-8') ? new TextDecoder('utf-8') : null;
    return this;
  }
  on(name, fn) {
    const r = super.on(name, fn);
    if (name === 'data') { this._flowing = true; this._startPump(); queueMicrotask(() => this._flush()); }
    else if (name === 'readable') { this._startPump(); if (this._queue.length) queueMicrotask(() => this.emit('readable')); }
    return r;
  }
  resume() { this._flowing = true; this._startPump(); queueMicrotask(() => this._flush()); return this; }
  pause() { this._flowing = false; return this; }
  ref() { return this; }
  unref() { return this; }
}
class WriteStream extends EventEmitter {
  constructor(fd) {
    super();
    this.fd = fd;
    this.isTTY = true;
    this.writable = true;
    this._tjs = tjsStreamForFd(fd);
    // Node's tty.WriteStream emits 'resize' and refreshes columns/rows on
    // SIGWINCH; Ink listens to process.stdout.on('resize'). columns/rows are
    // getters so a resize is reflected even without the event.
    this._onWinch = () => { this.emit('resize'); };
    tjs.addSignalListener('SIGWINCH', this._onWinch);
  }
  get columns() { try { return this._tjs.width; } catch { return undefined; } }
  get rows() { try { return this._tjs.height; } catch { return undefined; } }
  write(chunk, enc, cb) {
    writeSyncFd(this.fd, chunk);
    if (typeof enc === 'function') enc();
    else if (typeof cb === 'function') cb();
    return true;
  }
  end(chunk, enc, cb) {
    if (chunk != null && typeof chunk !== 'function') writeSyncFd(this.fd, chunk);
    const done = typeof chunk === 'function' ? chunk : (typeof enc === 'function' ? enc : cb);
    if (typeof done === 'function') done();
    this.emit('finish');
    return this;
  }
  cork() {}
  uncork() {}
  destroy() { try { tjs.removeSignalListener('SIGWINCH', this._onWinch); } catch { /* */ } return this; }
  setDefaultEncoding() { return this; }
  getWindowSize() { return [this.columns, this.rows]; }
  getColorDepth() { return 24; }   // xterm-256color / truecolor; matches the bundle's assumption
  hasColors(count) { return (count || 16) <= (1 << this.getColorDepth()); }
  // Cursor / erase methods node exposes on tty.WriteStream (via readline). Ink
  // and its deps call process.stdout.cursorTo/clearLine during rendering; absent
  // here they'd be `not a function` and reject the render. Emit the ANSI directly
  // (readline's own escapes). Each returns true and fires an optional callback,
  // matching node's signature.
  cursorTo(x, y, cb) {
    if (typeof y === 'function') { cb = y; y = undefined; }
    if (typeof x === 'number' && typeof y === 'number') writeSyncFd(this.fd, `\x1b[${y + 1};${x + 1}H`);
    else if (typeof x === 'number') writeSyncFd(this.fd, `\x1b[${x + 1}G`);
    if (typeof cb === 'function') cb();
    return true;
  }
  moveCursor(dx, dy, cb) {
    let s = '';
    if (dx < 0) s += `\x1b[${-dx}D`; else if (dx > 0) s += `\x1b[${dx}C`;
    if (dy < 0) s += `\x1b[${-dy}A`; else if (dy > 0) s += `\x1b[${dy}B`;
    if (s) writeSyncFd(this.fd, s);
    if (typeof cb === 'function') cb();
    return true;
  }
  clearLine(dir, cb) {
    // dir: -1 → left (\x1b[1K), 1 → right (\x1b[0K), 0 → whole line (\x1b[2K)
    writeSyncFd(this.fd, dir < 0 ? '\x1b[1K' : dir > 0 ? '\x1b[0K' : '\x1b[2K');
    if (typeof cb === 'function') cb();
    return true;
  }
  clearScreenDown(cb) {
    writeSyncFd(this.fd, '\x1b[0J');
    if (typeof cb === 'function') cb();
    return true;
  }
}

module.exports = { isatty, ReadStream, WriteStream };
module.exports.default = module.exports;
