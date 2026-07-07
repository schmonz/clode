'use strict';
// node:stream — the minimal Readable/Writable/PassThrough the SDK's SSE reader
// and the bundle touch, over node:events. Locked by test/node-shim-stream.test.cjs.
// DIVERGENCE: this is a behavioral subset (flowing-mode data/end/finish, async
// iteration, pipe/pipeline) — NOT node's full backpressure/highWaterMark state
// machine. Every implemented behavior is characterized against host node; extend
// test-first (Task 4) if the response reader needs more.
const { EventEmitter } = require('node:events');

class Readable extends EventEmitter {
  constructor(opts = {}) {
    super();
    this._reading = false;
    this._ended = false;
    this._buf = [];
    if (typeof opts.read === 'function') this._read = opts.read;
  }
  _read() {}
  push(chunk) {
    if (chunk === null) {
      this._ended = true;
      queueMicrotask(() => this.emit('end'));
      return false;
    }
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    queueMicrotask(() => this.emit('data', b));
    return true;
  }
  pipe(dest) {
    this.on('data', (d) => dest.write(d));
    this.on('end', () => dest.end && dest.end());
    return dest;
  }
  on(name, fn) { super.on(name, fn); if (name === 'data' && !this._reading) { this._reading = true; queueMicrotask(() => this._read()); } return this; }
  async *[Symbol.asyncIterator]() {
    const queue = [];
    let resolveNext = null;
    let done = false;
    this.on('data', (d) => { queue.push(d); if (resolveNext) { resolveNext(); resolveNext = null; } });
    this.on('end', () => { done = true; if (resolveNext) { resolveNext(); resolveNext = null; } });
    for (;;) {
      if (queue.length) { yield queue.shift(); continue; }
      if (done) return;
      await new Promise((r) => { resolveNext = r; });
    }
  }
}
Readable.from = function from(iterable) {
  const r = new Readable({ read() {} });
  (async () => { try { for await (const c of iterable) r.push(c); r.push(null); } catch (e) { r.emit('error', e); } })();
  return r;
};

class Writable extends EventEmitter {
  constructor(opts = {}) { super(); this._ended = false; if (typeof opts.write === 'function') this._write = opts.write; }
  _write(chunk, enc, cb) { cb(); }
  write(chunk, enc, cb) {
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    if (typeof enc === 'function') { cb = enc; enc = undefined; }
    this._write(b, enc, (err) => { if (err) this.emit('error', err); if (cb) cb(err); });
    return true;
  }
  end(chunk, enc, cb) {
    if (chunk != null) this.write(chunk, enc);
    if (typeof chunk === 'function') cb = chunk;
    this._ended = true;
    queueMicrotask(() => { this.emit('finish'); if (cb) cb(); });
    return this;
  }
}

class PassThrough extends Readable {
  constructor(opts = {}) { super(opts); }
  write(chunk) { this.push(chunk); return true; }
  end(chunk) { if (chunk != null) this.push(chunk); this.push(null); return this; }
}

function pipeline(...args) {
  const cb = typeof args[args.length - 1] === 'function' ? args.pop() : null;
  let cur = args[0];
  for (let i = 1; i < args.length; i++) cur = cur.pipe(args[i]);
  const last = args[args.length - 1];
  last.on('finish', () => cb && cb(null));
  last.on('end', () => cb && cb(null));
  last.on('error', (e) => cb && cb(e));
  return last;
}

module.exports = { Readable, Writable, PassThrough, pipeline, Stream: Readable };
module.exports.default = module.exports;
