const { test } = require('node:test');
const assert = require('node:assert');
const { pyJson } = require('../libexec/clode-jsutil.cjs');

test('matches python json.dumps(indent=2, sort_keys=True)', () => {
  // Python: json.dumps({"b":1,"a":"x’y"}, indent=2, sort_keys=True)
  const got = pyJson({ b: 1, a: 'x’y' }, { sortKeys: true });
  assert.strictEqual(got, '{\n  "a": "x\\u2019y",\n  "b": 1\n}');
});

test('insertion order when sortKeys is false', () => {
  const got = pyJson({ b: 1, a: 2 }, { sortKeys: false });
  assert.strictEqual(got, '{\n  "b": 1,\n  "a": 2\n}');
});

test('escapes DEL (0x7f) and control chars like python json.dumps', () => {
  // Python: json.dumps({"d":"\x7f","n":"a\nb"}, indent=2, sort_keys=True)
  // -> DEL becomes  (ensure_ascii), newline stays \n (matches JSON.stringify)
  const got = pyJson({ d: '\x7f', n: 'a\nb' }, { sortKeys: true });
  assert.strictEqual(got, '{\n  "d": "\\u007f",\n  "n": "a\\nb"\n}');
});

test('empty containers and nesting like python', () => {
  const got = pyJson({ x: {}, y: [], z: [{ k: 'é' }] }, { sortKeys: true });
  assert.strictEqual(got, '{\n  "x": {},\n  "y": [],\n  "z": [\n    {\n      "k": "\\u00e9"\n    }\n  ]\n}');
});

test('null values serialize like python (and an own __proto__ key survives)', () => {
  assert.strictEqual(pyJson({ a: null }, { sortKeys: true }), '{\n  "a": null\n}');
  // Python: json.dumps({"__proto__":1}, indent=2, sort_keys=True) -> keeps the key.
  const obj = JSON.parse('{"__proto__":1,"a":2}'); // own enumerable __proto__
  assert.strictEqual(pyJson(obj, { sortKeys: true }), '{\n  "__proto__": 1,\n  "a": 2\n}');
});

test('sortKeys does not mutate the input', () => {
  const input = { b: 1, a: { d: 4, c: 3 } };
  pyJson(input, { sortKeys: true });
  assert.deepStrictEqual(Object.keys(input), ['b', 'a']);
  assert.deepStrictEqual(Object.keys(input.a), ['d', 'c']);
});
