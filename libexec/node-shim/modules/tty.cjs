'use strict';
// node:tty — minimal surface for the -p boot. The bundle require()s it (ESM
// interop probe tty.__esModule, then tty.isatty) to decide whether stdio is a
// terminal. Under the loader, stdio is treated as non-tty (modules/process.cjs
// sets stdout.isTTY=false and stdin.isTTY=undefined), and the acceptance runs
// capture stdout through a pipe — so isatty is false for every fd. Characterized
// by test/node-shim-core.test.cjs (tty row).
//
// isatty over the public tjs stdio streams: fd 0/1/2 map to tjs.stdin/stdout/
// stderr, whose .isTerminal is a real TIOCGWINSZ/isatty-backed probe. Other fds
// aren't individually probeable from JS in this build → false (the bundle only
// asks about 0/1/2).
function isatty(fd) {
  if (fd === 0) return !!tjs.stdin.isTerminal;
  if (fd === 1) return !!tjs.stdout.isTerminal;
  if (fd === 2) return !!tjs.stderr.isTerminal;
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
// paths. DIVERGENCE (documented): backpressure is best-effort — we push every
// chunk the reader yields rather than honoring highWaterMark pauses; Ink reads
// keystrokes fast enough that this is not observable. Resume/pause flip a flag
// the pump checks between reads.
class ReadStream extends Readable {
  constructor(fd) {
    super({ read() {} });
    this.fd = fd;
    this.isTTY = true;
    this.isRaw = false;
    this._pumping = false;
    this._flowing = false;
  }
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
  setEncoding(enc) { this._encoding = enc; return this; }
  push(chunk) {
    if (chunk !== null && this._encoding) {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
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
}

module.exports = { isatty, ReadStream, WriteStream };
module.exports.default = module.exports;
