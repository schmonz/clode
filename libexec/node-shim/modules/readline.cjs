'use strict';
// node:readline — the bundle uses readline overwhelmingly to read newline-
// delimited lines from a stream: the Remote Control bridge (`createInterface({
// input: conn}).on('line', line => JSON.parse(line))`), child-process stderr/
// stdout line readers, NDJSON transcript scans (`for await (const line of rl)`),
// and stdin prompts. `readline` was declared in the loader's KNOWN builtins but
// had no module, so `require('readline').createInterface` hit the throwing
// wallProxy. This is the real thing: an Interface that consumes the input's
// 'data'/'end' events, splits on newlines (crlfDelay:Infinity == strip a
// trailing \r), and surfaces lines via both 'line' events AND async iteration.
// Characterized by test/node-shim-readline.test.cjs.
const { EventEmitter } = require('events');
const { StringDecoder } = require('string_decoder');

class Interface extends EventEmitter {
  constructor(options) {
    super();
    // createInterface(input, output) positional form OR ({input, output, ...}).
    const opts = (options && typeof options === 'object' && !options.on && (options.input || options.output))
      ? options
      : { input: options };
    this.input = opts.input || null;
    this.output = opts.output || null;
    this.terminal = !!opts.terminal;
    this.line = '';
    this._prompt = opts.prompt || '';
    this._buf = '';
    this._decoder = new StringDecoder('utf8');
    this._closed = false;
    this._queue = [];          // buffered lines awaiting an async-iterator pull
    this._pending = null;      // resolver for a pending async-iterator next()
    this._questionCb = null;

    if (this.input && typeof this.input.on === 'function') {
      this._onData = (chunk) => this._ingest(chunk);
      this._onEnd = () => this._finish();
      this.input.on('data', this._onData);
      this.input.on('end', this._onEnd);
      this.input.on('close', this._onEnd);
      if (typeof this.input.resume === 'function') this.input.resume();
    }
  }

  _ingest(chunk) {
    this._buf += (typeof chunk === 'string' ? chunk : this._decoder.write(chunk));
    let idx;
    while ((idx = this._buf.indexOf('\n')) !== -1) {
      let line = this._buf.slice(0, idx);
      this._buf = this._buf.slice(idx + 1);
      if (line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1); // strip \r (crlfDelay)
      this._deliver(line);
    }
  }

  _deliver(line) {
    this.line = line;
    if (this._questionCb) {
      const cb = this._questionCb;
      this._questionCb = null;
      cb(line);
      return;
    }
    this.emit('line', line);
    if (this._pending) {
      const resolve = this._pending;
      this._pending = null;
      resolve({ value: line, done: false });
    } else {
      this._queue.push(line);
    }
  }

  _finish() {
    if (this._closed) return;
    const tail = this._buf + this._decoder.end();
    this._buf = '';
    if (tail.length) {
      let line = tail;
      if (line.charCodeAt(line.length - 1) === 13) line = line.slice(0, -1);
      this._deliver(line);
    }
    this._closed = true;
    this.emit('close');
    if (this._pending) {
      const resolve = this._pending;
      this._pending = null;
      resolve({ value: undefined, done: true });
    }
  }

  close() {
    if (this._closed) return;
    if (this.input && this._onData && typeof this.input.removeListener === 'function') {
      this.input.removeListener('data', this._onData);
      this.input.removeListener('end', this._onEnd);
      this.input.removeListener('close', this._onEnd);
    }
    this._finish();
  }

  write(data) {
    if (this.output && typeof this.output.write === 'function' && data != null) this.output.write(data);
  }

  question(query, optionsOrCb, maybeCb) {
    const cb = typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb;
    this.write(query);
    this._questionCb = typeof cb === 'function' ? cb : () => {};
  }

  setPrompt(p) { this._prompt = p; }
  prompt() { if (this._prompt) this.write(this._prompt); }
  pause() { if (this.input && typeof this.input.pause === 'function') this.input.pause(); return this; }
  resume() { if (this.input && typeof this.input.resume === 'function') this.input.resume(); return this; }

  [Symbol.asyncIterator]() {
    const self = this;
    return {
      next() {
        if (self._queue.length) return Promise.resolve({ value: self._queue.shift(), done: false });
        if (self._closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => { self._pending = resolve; });
      },
      return() { self.close(); return Promise.resolve({ value: undefined, done: true }); },
      [Symbol.asyncIterator]() { return this; },
    };
  }
}

function createInterface(options, output) {
  if (output !== undefined && (!options || typeof options !== 'object' || options.on)) {
    return new Interface({ input: options, output });
  }
  return new Interface(options);
}

// Cursor/erase helpers node exposes at module level (readline.clearLine(stream,
// dir), etc.). tty.WriteStream carries the real escapes; here we keep them safe
// no-ops that honor the optional callback, matching tty.cjs's approach.
function clearLine(_stream, _dir, cb) { if (typeof cb === 'function') cb(); return true; }
function cursorTo(_stream, _x, _y, cb) { const c = typeof _y === 'function' ? _y : cb; if (typeof c === 'function') c(); return true; }
function moveCursor(_stream, _dx, _dy, cb) { if (typeof cb === 'function') cb(); return true; }
function clearScreenDown(_stream, cb) { if (typeof cb === 'function') cb(); return true; }
function emitKeypressEvents() { /* no keypress synthesis under the shim */ }

module.exports = {
  Interface,
  createInterface,
  clearLine,
  cursorTo,
  moveCursor,
  clearScreenDown,
  emitKeypressEvents,
};
module.exports.default = module.exports;
