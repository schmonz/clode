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
    this.destroyed = false;
    this.readableEnded = false;
    this.readable = true; // Task 4b: child_process wraps a real child stdout/stderr in this
    if (typeof opts.read === 'function') this._read = opts.read;
  }
  _read() {}
  // destroy() (Task 4 wall): the bundle's execa-style stream cleanup does
  // `stream.destroy()` on child/consumed streams (get-stream's `Q2n`), and
  // stream/promises finished() waits on 'close' which destroy() emits. Node's
  // destroy marks the stream destroyed, emits 'error' (only if given) then
  // 'close', and is idempotent. DIVERGENCE: this does not abort an in-flight
  // read/underlying resource (there is none for a plain node-shim Readable) —
  // it is the observable destroyed/'close' contract, characterized in
  // test/node-shim-stream.test.cjs.
  destroy(err) {
    if (this.destroyed) return this;
    this.destroyed = true;
    queueMicrotask(() => { if (err) this.emit('error', err); this.emit('close'); });
    return this;
  }
  pause() { return this; }
  resume() { return this; }
  push(chunk) {
    if (chunk === null) {
      this._ended = true;
      this.readableEnded = true;
      this.readable = false;
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
  // Async iteration (`for await (const chunk of readable)`) — the SSE reader
  // consumes the response body this way, and stream/consumers' collect() does
  // too, both while the producing side (Readable.from / a fetch pump) is ALSO
  // suspended in its own `for await`. That concurrency is exactly the shape that
  // trips a tjs/QuickJS codegen bug:
  //
  // DIVERGENCE (tjs bug workaround, NOT a semantic divergence): when an
  // `async function*` (async generator) is suspended at an `await`/`yield` while
  // a SECOND async context (another `for await`, another async generator) is
  // concurrently live, this tjs build corrupts the generator's closed-over local
  // variable slots — a captured `const queue = []` reads back as an unrelated
  // function object, so `queue.push` throws "not a function". Reproduced minimally
  // (two concurrent async iterators over shim Readables) and confirmed absent on
  // host node. The fix is to implement asyncIterator as a MANUAL async iterator
  // OBJECT (plain next()->Promise), never as an `async function*` — a manual
  // iterator holds its state in a normal closure/function scope that tjs compiles
  // correctly, so the observable behavior is identical to node's async iteration
  // (characterized by test/node-shim-stream.test.cjs: async-iteration + consumers
  // rows) with no reliance on the buggy async-generator path. If a future tjs
  // rebuild fixes the codegen this can revert to the `async function*` form.
  [Symbol.asyncIterator]() {
    const self = this;
    const queue = [];
    let resolveNext = null;
    let done = false;
    let errored = null;
    self.on('data', (d) => { queue.push(d); if (resolveNext) { const r = resolveNext; resolveNext = null; r(); } });
    self.on('end', () => { done = true; if (resolveNext) { const r = resolveNext; resolveNext = null; r(); } });
    self.on('error', (e) => { errored = e; if (resolveNext) { const r = resolveNext; resolveNext = null; r(); } });
    const settle = (resolve, reject) => {
      if (queue.length) { resolve({ value: queue.shift(), done: false }); return true; }
      if (errored) { reject(errored); return true; }
      if (done) { resolve({ value: undefined, done: true }); return true; }
      return false;
    };
    return {
      [Symbol.asyncIterator]() { return this; },
      next() {
        return new Promise((resolve, reject) => {
          if (settle(resolve, reject)) return;
          resolveNext = () => { settle(resolve, reject); };
        });
      },
      return(value) { done = true; return Promise.resolve({ value, done: true }); },
    };
  }
}
Readable.from = function from(iterable) {
  const r = new Readable({ read() {} });
  (async () => { try { for await (const c of iterable) r.push(c); r.push(null); } catch (e) { r.emit('error', e); } })();
  return r;
};

class Writable extends EventEmitter {
  constructor(opts = {}) { super(); this._ended = false; this.destroyed = false; this.writableEnded = false; if (typeof opts.write === 'function') this._write = opts.write; }
  _write(chunk, enc, cb) { cb(); }
  // See Readable.destroy — same observable destroyed/'close' contract.
  destroy(err) {
    if (this.destroyed) return this;
    this.destroyed = true;
    queueMicrotask(() => { if (err) this.emit('error', err); this.emit('close'); });
    return this;
  }
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

// Transform (Task 4 wall): the -p bundle subclasses stream.Transform for text
// pipelines (`class X extends require('stream').Transform`). A real Transform is
// a duplex: writes are fed through _transform(chunk, enc, cb) whose pushed
// output surfaces on the readable side; end() runs _flush(cb) then closes the
// readable side. Modeled over Readable (push/'data'/'end') + a writable face,
// mirroring PassThrough's ordering discipline. Characterized by
// test/node-shim-stream.test.cjs (Transform row). Behavioral subset (no
// object-mode/highWaterMark backpressure); extend test-first if a later path
// needs it.
class Transform extends Readable {
  constructor(opts = {}) {
    super(opts);
    if (typeof opts.transform === 'function') this._transform = opts.transform;
    if (typeof opts.flush === 'function') this._flush = opts.flush;
  }
  _transform(chunk, enc, cb) { cb(null, chunk); } // default: identity passthrough
  _flush(cb) { cb(); }
  write(chunk, enc, cb) {
    if (typeof enc === 'function') { cb = enc; enc = undefined; }
    const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    this._transform(b, enc, (err, out) => {
      if (err) { this.emit('error', err); if (cb) cb(err); return; }
      if (out != null) this.push(out);
      if (cb) cb();
    });
    return true;
  }
  end(chunk, enc, cb) {
    if (typeof chunk === 'function') { cb = chunk; chunk = enc = undefined; }
    else if (typeof enc === 'function') { cb = enc; enc = undefined; }
    const finish = () => {
      this._flush((err, out) => {
        if (err) { this.emit('error', err); if (cb) cb(err); return; }
        if (out != null) this.push(out);
        this.push(null);                       // schedules 'end' (readable side)
        if (cb) queueMicrotask(cb);
        queueMicrotask(() => this.emit('finish'));
      });
    };
    if (chunk != null) this.write(chunk, enc, finish);
    else finish();
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

// stream/consumers (Task 4 wall): consume a stream (a node-shim Readable, an
// async-iterable, or a WHATWG ReadableStream via getReader) fully into a value.
// The -p bundle captures require('stream/consumers'). Real, characterized by
// test/node-shim-stream.test.cjs (consumers row).
function toBuf(c) { return Buffer.isBuffer(c) ? c : Buffer.from(c); }
async function collect(stream) {
  const chunks = [];
  if (stream && typeof stream.getReader === 'function') {
    const reader = stream.getReader();
    for (;;) { const { done, value } = await reader.read(); if (done) break; if (value != null) chunks.push(toBuf(value)); }
  } else {
    for await (const c of stream) chunks.push(toBuf(c));
  }
  return Buffer.concat(chunks);
}
const consumers = {
  buffer: (s) => collect(s),
  arrayBuffer: async (s) => { const b = await collect(s); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); },
  bytes: async (s) => new Uint8Array(await collect(s)),
  text: async (s) => (await collect(s)).toString('utf8'),
  json: async (s) => JSON.parse((await collect(s)).toString('utf8')),
  blob: async (s) => { const b = await collect(s); if (typeof Blob === 'undefined') throw new Error('node-shim: stream/consumers.blob needs a global Blob (absent in this tjs)'); return new Blob([b]); },
};

// stream/promises (Task 4 wall): promise forms of pipeline/finished.
const promises = {
  pipeline: (...args) => new Promise((res, rej) => { pipeline(...args, (e) => (e ? rej(e) : res())); }),
  finished: (stream) => new Promise((res, rej) => {
    stream.on('end', res); stream.on('finish', res); stream.on('close', res);
    stream.on('error', rej);
  }),
};

module.exports = { Readable, Writable, PassThrough, Transform, pipeline, Stream: Readable, consumers, promises };
module.exports.default = module.exports;
