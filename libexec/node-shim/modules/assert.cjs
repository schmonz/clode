'use strict';
// node:assert — faithful subset. The bundle requires it (13×) and uses ok,
// strictEqual, equal, deepStrictEqual, throws, rejects, etc. Deep equality
// delegates to util.isDeepStrictEqual (already characterization-locked).
// AssertionError carries code 'ERR_ASSERTION' + actual/expected/operator, as
// Node does. `assert(x)` is callable (=== assert.ok); `assert.strict` is the
// same surface with the loose (equal/deepEqual) methods aliased to strict.
const util = require('node:util');

class AssertionError extends Error {
  constructor(opts = {}) {
    const { message, actual, expected, operator, stackStartFn } = opts;
    super(message || `${inspect(actual)} ${operator} ${inspect(expected)}`);
    this.name = 'AssertionError';
    this.code = 'ERR_ASSERTION';
    this.actual = actual;
    this.expected = expected;
    this.operator = operator;
    this.generatedMessage = !message;
    if (Error.captureStackTrace && stackStartFn) {
      try { Error.captureStackTrace(this, stackStartFn); } catch { /* best effort */ }
    }
  }
}

function inspect(v) {
  try { return typeof v === 'string' ? JSON.stringify(v) : util.inspect(v); }
  catch { return String(v); }
}

function ok(value, message) {
  if (!value) {
    throw new AssertionError({
      message: message instanceof Error ? undefined : message,
      actual: value, expected: true, operator: '==', stackStartFn: ok,
    });
  }
}
// assert(...) is ok(...)
function assert(value, message) { ok(value, message); }
assert.ok = ok;
assert.AssertionError = AssertionError;

function fail(message) {
  if (message instanceof Error) throw message;
  throw new AssertionError({ message: message || 'Failed', operator: 'fail', stackStartFn: fail });
}
assert.fail = fail;

assert.equal = function equal(a, e, m) {
  // eslint-disable-next-line eqeqeq
  if (a != e) throw new AssertionError({ message: m, actual: a, expected: e, operator: '==', stackStartFn: equal });
};
assert.notEqual = function notEqual(a, e, m) {
  // eslint-disable-next-line eqeqeq
  if (a == e) throw new AssertionError({ message: m, actual: a, expected: e, operator: '!=', stackStartFn: notEqual });
};
assert.strictEqual = function strictEqual(a, e, m) {
  if (!Object.is(a, e)) throw new AssertionError({ message: m, actual: a, expected: e, operator: 'strictEqual', stackStartFn: strictEqual });
};
assert.notStrictEqual = function notStrictEqual(a, e, m) {
  if (Object.is(a, e)) throw new AssertionError({ message: m, actual: a, expected: e, operator: 'notStrictEqual', stackStartFn: notStrictEqual });
};
assert.deepStrictEqual = function deepStrictEqual(a, e, m) {
  if (!util.isDeepStrictEqual(a, e)) throw new AssertionError({ message: m, actual: a, expected: e, operator: 'deepStrictEqual', stackStartFn: deepStrictEqual });
};
assert.notDeepStrictEqual = function notDeepStrictEqual(a, e, m) {
  if (util.isDeepStrictEqual(a, e)) throw new AssertionError({ message: m, actual: a, expected: e, operator: 'notDeepStrictEqual', stackStartFn: notDeepStrictEqual });
};
// Loose deep equality: Node's deepEqual is looser (== leaf comparison, ignores
// prototypes). We approximate with the strict deep check, which is a SUPERSET of
// cases the bundle exercises (it uses deepStrictEqual far more). Documented
// divergence: deepEqual here is as strict as deepStrictEqual (never wrong-passes,
// may wrong-fail on `1 == '1'` leaves — a future wall if it bites).
assert.deepEqual = assert.deepStrictEqual;
assert.notDeepEqual = assert.notDeepStrictEqual;

function matchExpectation(err, expected) {
  if (expected == null) return true;
  if (expected instanceof RegExp) return expected.test(String(err && err.message !== undefined ? err.message : err));
  if (typeof expected === 'function') {
    // Error constructor or a validation predicate.
    if (expected.prototype instanceof Error || expected === Error) return err instanceof expected;
    return expected(err) === true || expected(err) === undefined;
  }
  if (expected instanceof Error) {
    return (expected.message === undefined || expected.message === err.message)
      && (expected.name === undefined || expected.name === err.name);
  }
  if (typeof expected === 'object') {
    for (const k of Object.keys(expected)) { if (!util.isDeepStrictEqual(err[k], expected[k])) return false; }
    return true;
  }
  return true;
}

assert.throws = function throws(fn, expected, message) {
  let caught;
  try { fn(); } catch (e) { caught = e; }
  if (!caught) throw new AssertionError({ message: message || 'Missing expected exception.', operator: 'throws', stackStartFn: throws });
  if (typeof expected === 'string') { message = expected; expected = undefined; }
  if (!matchExpectation(caught, expected)) throw caught;
};
assert.doesNotThrow = function doesNotThrow(fn, expected, message) {
  let caught;
  try { fn(); } catch (e) { caught = e; }
  if (caught) {
    if (typeof expected === 'string') { message = expected; expected = undefined; }
    if (matchExpectation(caught, expected)) throw new AssertionError({ message: message || `Got unwanted exception.\n${caught && caught.message}`, operator: 'doesNotThrow', stackStartFn: doesNotThrow });
    throw caught;
  }
};
assert.rejects = async function rejects(fnOrPromise, expected, message) {
  let caught;
  try { await (typeof fnOrPromise === 'function' ? fnOrPromise() : fnOrPromise); }
  catch (e) { caught = e; }
  if (!caught) throw new AssertionError({ message: message || 'Missing expected rejection.', operator: 'rejects', stackStartFn: rejects });
  if (typeof expected === 'string') { message = expected; expected = undefined; }
  if (!matchExpectation(caught, expected)) throw caught;
};
assert.doesNotReject = async function doesNotReject(fnOrPromise, expected, message) {
  let caught;
  try { await (typeof fnOrPromise === 'function' ? fnOrPromise() : fnOrPromise); }
  catch (e) { caught = e; }
  if (caught) {
    if (typeof expected === 'string') { message = expected; expected = undefined; }
    if (matchExpectation(caught, expected)) throw new AssertionError({ message: message || `Got unwanted rejection.\n${caught && caught.message}`, operator: 'doesNotReject', stackStartFn: doesNotReject });
    throw caught;
  }
};
assert.match = function match(str, re, message) {
  if (!(re instanceof RegExp)) throw new TypeError('The "regexp" argument must be an instance of RegExp.');
  if (!re.test(str)) throw new AssertionError({ message, actual: str, expected: re, operator: 'match', stackStartFn: match });
};
assert.doesNotMatch = function doesNotMatch(str, re, message) {
  if (!(re instanceof RegExp)) throw new TypeError('The "regexp" argument must be an instance of RegExp.');
  if (re.test(str)) throw new AssertionError({ message, actual: str, expected: re, operator: 'doesNotMatch', stackStartFn: doesNotMatch });
};
assert.ifError = function ifError(err) {
  if (err !== null && err !== undefined) {
    throw new AssertionError({ message: `ifError got unwanted exception: ${err && err.message !== undefined ? err.message : err}`, actual: err, expected: null, operator: 'ifError', stackStartFn: ifError });
  }
};

// assert.strict: same functions, with loose aliases pointing at strict variants.
const strict = Object.assign(function strict(value, message) { ok(value, message); }, assert, {
  equal: assert.strictEqual,
  notEqual: assert.notStrictEqual,
  deepEqual: assert.deepStrictEqual,
  notDeepEqual: assert.notDeepStrictEqual,
});
strict.strict = strict;
assert.strict = strict;
assert.default = assert;

module.exports = assert;
