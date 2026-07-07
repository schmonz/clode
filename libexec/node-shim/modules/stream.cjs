'use strict';
// node:stream — the minimal Readable/Writable/PassThrough the SDK's SSE reader
// and the bundle touch, over node:events. Locked by test/node-shim-stream.test.cjs.
// This is a behavioral SUBSET (flowing-mode 'data'/'end'/'finish', the
// end-callback contract, async iteration, pipe/pipeline). PassThrough emits
// both 'finish' (writable side) and 'end' (readable side), matching host node's
// observable order for a consumed stream ('end' before 'finish'). It is NOT
// node's full backpressure/highWaterMark state machine, and does not model
// paused-mode .read() polling, .destroy()/'close', or web-stream interop.
// Every implemented behavior is characterized against host node
// (test/node-shim-stream.test.cjs); extend test-first (Task 4) if the response
// reader needs more.
const { EventEmitter } = require('node:events');

class Readable extends EventEmitter {
  constructor(opts = {}) {
    super();
    this._reading = false;
    this._ended = false;
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
    // Normalize function-first: .end(cb) / .end(chunk, cb) / .end(chunk, enc, cb).
    // Must test for a callback BEFORE the chunk!=null write, else .end(cb)
    // coerces the callback to a string and writes it as data (host node: no write).
    if (typeof chunk === 'function') { cb = chunk; chunk = enc = undefined; }
    else if (typeof enc === 'function') { cb = enc; enc = undefined; }
    if (chunk != null) this.write(chunk, enc);
    this._ended = true;
    // Host node order: the end-callback runs BEFORE the 'finish' event.
    queueMicrotask(() => { if (cb) cb(); this.emit('finish'); });
    return this;
  }
}

class PassThrough extends Readable {
  constructor(opts = {}) { super(opts); this._ended = false; }
  write(chunk) { this.push(chunk); return true; }
  end(chunk, enc, cb) {
    // Same function-first normalization as Writable.end — .end(cb) must NOT
    // write the callback as data, and the callback MUST be invoked.
    if (typeof chunk === 'function') { cb = chunk; chunk = enc = undefined; }
    else if (typeof enc === 'function') { cb = enc; enc = undefined; }
    if (chunk != null) this.push(chunk);
    this.push(null); // schedules 'end' (readable side)
    this._ended = true;
    // Host-node observable order for a consumed PassThrough is 'end', then the
    // end-callback, then 'finish' (writable side). queueMicrotask is FIFO, so
    // enqueue in that order AFTER push(null)'s 'end' task.
    if (cb) queueMicrotask(cb);
    queueMicrotask(() => this.emit('finish'));
    return this;
  }
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
