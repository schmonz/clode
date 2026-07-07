'use strict';
// node:timers + node:timers/promises — the -p boot require()s both. The bundle
// captures `require('timers/promises')` as a namespace and uses the
// promise-timers (chiefly setTimeout as an awaitable delay). Everything here is
// a REAL implementation built on the global timer primitives the loader already
// installs (setTimeout / setImmediate / queueMicrotask) — no stub.
// Characterized by test/node-shim-core.test.cjs (timers/promises row).
//
// The loader routes `timers/promises` to this file's `.promises` export (the
// same generalized subpath handling as `fs/promises`); a bare `require('timers')`
// gets the callback API below.

// ---- callback API (node:timers) — thin pass-through to the globals. Node's
// `timers` builtin re-exports exactly these; the globals the loader installs
// already carry Node semantics (setImmediate is polyfilled in loader.cjs).
const callbackApi = {
  setTimeout: (...a) => setTimeout(...a),
  clearTimeout: (...a) => clearTimeout(...a),
  setInterval: (...a) => setInterval(...a),
  clearInterval: (...a) => clearInterval(...a),
  setImmediate: (...a) => setImmediate(...a),
  clearImmediate: (...a) => clearImmediate(...a),
};

// ---- promise API (node:timers/promises)
// setTimeout(delay, value, options?) -> Promise<value> resolved after `delay`.
// AbortSignal support: if opts.signal is already aborted, reject immediately;
// otherwise reject on 'abort' and clear the pending timer (matches host node).
function pSetTimeout(delay = 1, value, opts = {}) {
  const signal = opts && opts.signal;
  if (signal && signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const id = setTimeout(() => {
      if (signal) signal.removeEventListener && signal.removeEventListener('abort', onAbort);
      resolve(value);
    }, delay);
    function onAbort() { clearTimeout(id); reject(abortError(signal)); }
    if (signal && signal.addEventListener) signal.addEventListener('abort', onAbort, { once: true });
  });
}

// setImmediate(value, options?) -> Promise<value> on the next loop turn.
function pSetImmediate(value, opts = {}) {
  const signal = opts && opts.signal;
  if (signal && signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const id = setImmediate(() => {
      if (signal) signal.removeEventListener && signal.removeEventListener('abort', onAbort);
      resolve(value);
    });
    function onAbort() { clearImmediate(id); reject(abortError(signal)); }
    if (signal && signal.addEventListener) signal.addEventListener('abort', onAbort, { once: true });
  });
}

// setInterval(delay, value, options?) -> AsyncIterable yielding `value` every
// `delay` ms. Real async generator over setInterval; honours opts.signal.
async function* pSetInterval(delay = 1, value, opts = {}) {
  const signal = opts && opts.signal;
  if (signal && signal.aborted) throw abortError(signal);
  const queue = [];
  let resolveNext = null;
  let aborted = false;
  const id = setInterval(() => {
    if (resolveNext) { const r = resolveNext; resolveNext = null; r(); }
    else queue.push(1);
  }, delay);
  const onAbort = () => { aborted = true; if (resolveNext) { const r = resolveNext; resolveNext = null; r(); } };
  if (signal && signal.addEventListener) signal.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      if (aborted) throw abortError(signal);
      if (queue.length) { queue.shift(); yield value; continue; }
      await new Promise((res) => { resolveNext = res; });
    }
  } finally {
    clearInterval(id);
    if (signal && signal.removeEventListener) signal.removeEventListener('abort', onAbort);
  }
}

function abortError(signal) {
  const reason = signal && signal.reason;
  if (reason !== undefined) return reason;
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  e.code = 'ABORT_ERR';
  return e;
}

// scheduler.wait(delay) === promise setTimeout; scheduler.yield() === next turn.
const scheduler = {
  wait: (delay, opts) => pSetTimeout(delay, undefined, opts),
  yield: () => pSetImmediate(undefined),
};

const promises = {
  setTimeout: pSetTimeout,
  setImmediate: pSetImmediate,
  setInterval: pSetInterval,
  scheduler,
};

module.exports = Object.assign({}, callbackApi, { promises });
module.exports.default = module.exports;
