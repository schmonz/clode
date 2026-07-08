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

// The async fd-0 keystroke pump: tjs.stdin is a WHATWG ReadableStream; read it
// and push Buffer chunks into this Node Readable so Ink's input loop sees live
// keypresses. Started lazily (Node's stdin is paused until a consumer pulls) so
// merely touching process.stdin doesn't hold the loop open on non-interactive
// paths. Three equivalent lazy-start triggers, matching host node's observable
// "stdin flows once someone asks for data" behavior: resume(), an 'on(data)'
// listener (the shim's base Readable.on() calls this._read() the first time a
// 'data' listener is added — see stream.cjs — so overriding _read() to start
// the pump wires this up for free), and setRawMode(true) (Ink's actual path).
// _startPump is idempotent (guarded by _pumping) so it's safe to call from all
// three. DIVERGENCE (documented): backpressure is best-effort — we push every
// chunk the reader yields rather than honoring highWaterMark pauses/pause();
// Ink reads keystrokes fast enough that this is not observable.
class ReadStream extends Readable {
  constructor(fd) {
    super();
    this.fd = fd;
    this.isTTY = true;
    this.isRaw = false;
    this._pumping = false;
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
          if (done) { this.push(null); break; }
          if (value && value.length) this.push(Buffer.from(value));
        }
      } catch (e) {
        this.destroy(e);
      } finally {
        try { reader.releaseLock(); } catch { /* */ }
      }
    })();
  }
  setRawMode(mode) {
    try { tjs.stdin.setRawMode(!!mode); } catch { /* not a terminal */ }
    this.isRaw = !!mode;
    if (mode) this._startPump();
    return this;
  }
  // setEncoding: the shim's node:stream Readable (a behavioral subset, see
  // stream.cjs) has no real setEncoding/decoder machinery — push() always wraps
  // non-Buffer chunks back into a Buffer via Buffer.from(String(chunk)), which
  // would double-encode a decoded string. So this override decodes to a string
  // itself and emits 'data' directly, bypassing the base class's Buffer-only
  // push() when an encoding is set (matching host node's post-setEncoding
  // 'data'-emits-strings contract); with no encoding set, behavior is unchanged.
  //
  // For utf-8/utf8 (Ink's own encoding, the path that must be right), a
  // multi-byte character can arrive split across two pump reads (e.g. the
  // 4-byte emoji F0 9F 99 82 delivered as two separate keystroke chunks). Host
  // node's internal StringDecoder buffers an incomplete trailing sequence and
  // reassembles it on the next chunk; decoding each chunk independently would
  // instead emit U+FFFD replacement characters for the split bytes. So we keep
  // a SINGLE persistent TextDecoder for the lifetime of the stream and feed it
  // chunks with { stream: true }, which carries incomplete trailing bytes
  // forward exactly like StringDecoder does.
  setEncoding(enc) {
    this._encoding = enc;
    const norm = String(enc).toLowerCase();
    this._utf8Decoder = (norm === 'utf8' || norm === 'utf-8') ? new TextDecoder('utf-8') : null;
    return this;
  }
  push(chunk) {
    if (chunk !== null && this._encoding) {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (this._utf8Decoder) {
        const s = this._utf8Decoder.decode(b, { stream: true });
        if (s.length) queueMicrotask(() => this.emit('data', s));
        return true;
      }
      // DIVERGENCE (documented, not fixed): non-utf8 encodings decode each
      // pump chunk independently with no carried decoder state, so a
      // multi-byte sequence split across two reads will NOT reassemble here
      // the way host node's StringDecoder would. Ink only ever uses utf8 (the
      // path above), so this fallback is best-effort rather than faithful.
      queueMicrotask(() => this.emit('data', b.toString(this._encoding)));
      return true;
    }
    return super.push(chunk);
  }
  resume() { this._startPump(); return super.resume(); }
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
