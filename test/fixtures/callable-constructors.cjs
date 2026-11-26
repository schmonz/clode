'use strict';
// Run under host node (to ask which constructors node lets an ES5 subclass `.call(this)`) and under the shim (to
// check it lets them too, and that the call really initializes `this`). argv[2]: 'list' or a JSON list to check.
const util = require('node:util');
const NEW = /without 'new'|invoked with 'new'/;
const MODULES = process.argv[3] ? JSON.parse(process.argv[3]) : [];

function lookup(name) {
  const [m, ...rest] = name.split('.');
  let v = require('node:' + m);
  for (const p of rest) v = v == null ? undefined : v[p];
  return v;
}

if (process.argv[2] === 'list') {
  const out = [];
  const seen = new Set();
  for (const m of MODULES) {
    let x; try { x = require('node:' + m); } catch { continue; }
    const visit = (obj, prefix) => {
      for (const k of Object.getOwnPropertyNames(obj)) {
        let v; try { v = obj[k]; } catch { continue; }
        if (typeof v !== 'function' || !/^[A-Z]/.test(k) || !v.prototype || seen.has(v)) continue;
        seen.add(v);
        if (/^class\b/.test(Function.prototype.toString.call(v))) continue;
        try { v.call(Object.create(v.prototype)); } catch (e) { if (NEW.test(e.message)) continue; }
        out.push(prefix + k);
      }
    };
    visit(x, m + '.');
    if (typeof x === 'function') out.push(m);
  }
  console.log(JSON.stringify(out));
  process.exit(0);   // a constructed server would hold the loop open
} else {
  const report = { refused: [], absent: [], behaviour: {} };
  for (const name of JSON.parse(process.argv[2])) {
    let C; try { C = lookup(name); } catch { C = undefined; }
    if (typeof C !== 'function') { report.absent.push(name); continue; }
    const o = Object.create(C.prototype);
    try { C.call(o); } catch (e) { if (NEW.test(e.message)) report.refused.push(name); }
    // argument-less construction may fail LATER (a ReadStream of no path): that is not the question asked here
    if (typeof o.on === 'function') { try { o.on('error', () => {}); } catch { /* not an emitter after all */ } }
  }
  // and the call INITIALIZES the subclass instance: state and identity, not a stand-in
  const EventEmitter = require('node:events');
  const { Writable, Readable } = require('node:stream');
  const { StringDecoder } = require('node:string_decoder');
  function Em() { EventEmitter.call(this); } util.inherits(Em, EventEmitter);
  const em = new Em(); let heard; em.on('x', function (v) { heard = [v, this === em]; }); em.emit('x', 7);
  report.behaviour.eventEmitter = heard;
  function Sink() { Writable.call(this); this.got = []; } util.inherits(Sink, Writable);
  Sink.prototype._write = function (c, e, cb) { this.got.push(String(c)); cb(); };
  const sink = new Sink(); sink.write('a'); sink.end('b');
  function Src() { Readable.call(this); } util.inherits(Src, Readable);
  Src.prototype._read = function () {};
  const src = new Src(); const seen = []; src.on('data', (c) => seen.push(String(c)));
  src.push('p'); src.push(null);
  function Dec() { StringDecoder.call(this, 'utf8'); } util.inherits(Dec, StringDecoder);
  report.behaviour.stringDecoder = new Dec().write(Buffer.from('hé'));
  setTimeout(() => {
    report.behaviour.writable = sink.got;
    report.behaviour.readable = seen;
    console.log(JSON.stringify(report));
    process.exit(0);
  }, 50);
}
