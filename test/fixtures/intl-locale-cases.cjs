'use strict';
// The date, number and list formatting shapes the 2.1.330 bundle uses, one string per row. Self-contained, so
// test/node-shim-intl.test.cjs runs its SOURCE (cases.toString()) under tjs+loader and inside native Bun
// (scripts/lib/native-oracle.cjs), both at TZ=America/New_York; intl-locale-native.json is native's answer.
module.exports = function cases() {
  const D = [new Date(2027, 0, 1, 2, 59, 7), new Date(2026, 10, 21, 13, 5, 0), new Date(2026, 10, 21, 0, 0, 9), new Date(Date.UTC(2026, 6, 4, 23, 30))];
  const C = [
    ['toLocaleString', 'en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }],
    ['toLocaleString', 'en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }],
    ['toLocaleString', 'en-US', { month: 'long', year: 'numeric' }],
    ['toLocaleString', 'en-US', { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }],
    ['toLocaleString', 'en-US', undefined],
    ['toLocaleString', undefined, undefined],
    ['toLocaleString', 'en-US', { timeZone: 'UTC', hour: 'numeric', minute: '2-digit' }],
    ['toLocaleString', 'en-US', { hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }],
    ['toLocaleString', 'en-US', { hour: 'numeric', minute: '2-digit', hour12: false }],
    ['toLocaleTimeString', 'en-US', { hour: 'numeric', minute: '2-digit', hour12: true }],
    ['toLocaleTimeString', 'en-US', { hour: 'numeric', minute: '2-digit' }],
    ['toLocaleTimeString', undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }],
    ['toLocaleTimeString', 'en-US', { hour: 'numeric' }],
    ['toLocaleTimeString', undefined, undefined],
    ['toLocaleDateString', 'en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }],
    ['toLocaleDateString', 'en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }],
    ['toLocaleDateString', 'en-US', { weekday: 'long' }],
    ['toLocaleDateString', 'en-CA', undefined],
    ['toLocaleDateString', undefined, undefined],
  ];
  const out = [];
  for (const d of D) for (const [m, l, o] of C) out.push(`${m} ${l} ${JSON.stringify(o)} => ${d[m](l, o)}`);
  const d = D[0];
  // the bundle's own CronCreate/CronList formatter (chunk Pet, 2.1.330), verbatim but for the zone
  const pet = (e, r) => e.toLocaleString('en-US', { month: 'short', day: 'numeric', ...r?.includeYear && { year: 'numeric' }, hour: 'numeric', minute: '2-digit', timeZone: undefined })
    .replace(/,? at |, (?=\d{1,2}:)/, ' ').replace(/[  ]([AP]M)/i, (o, t) => t.toLowerCase());
  out.push(`Pet => ${pet(d)} | ${pet(d, { includeYear: true })}`);
  for (const [l, o] of [['en-US', undefined], ['en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }],
    ['sv-SE', { dateStyle: 'short', timeStyle: 'medium' }], ['en-US', { dateStyle: 'short', timeStyle: 'short' }],
    ['en-US', { hourCycle: 'h23', hour12: false, year: 'numeric', month: 'numeric', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }]]) {
    out.push(`DateTimeFormat ${l} ${JSON.stringify(o)} => ${new Intl.DateTimeFormat(l, o).format(d)}`);
  }
  out.push(`formatToParts => ${JSON.stringify(new Intl.DateTimeFormat('en-US', { year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d))}`);
  out.push(`formatToParts => ${JSON.stringify(new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).formatToParts(d))}`);
  out.push(`invalid => ${new Date(NaN).toLocaleString('en-US')}`);
  for (const n of [0, 1234.5, 1234567.891, 0.5, -12]) {
    for (const o of [undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }, { minimumFractionDigits: 1 }]) out.push(`${n}.toLocaleString ${JSON.stringify(o)} => ${n.toLocaleString('en-US', o)}`);
  }
  // Intl.ListFormat: 2.1.330 builds one at module load in the REPL chunk, so its absence kept the TUI from painting
  const L = [[], ['a'], ['a', 'b'], ['a', 'b', 'c'], ['a', 'b', 'c', 'd']];
  for (const type of [undefined, 'conjunction', 'disjunction', 'unit']) for (const style of [undefined, 'long', 'short', 'narrow']) {
    const o = {}; if (type) o.type = type; if (style) o.style = style;
    const f = new Intl.ListFormat('en', o);
    out.push(`ListFormat ${JSON.stringify(o)} => ${L.map((l) => JSON.stringify(f.format(l))).join(' | ')} :: ${JSON.stringify(f.resolvedOptions())}`);
  }
  out.push(`ListFormat parts => ${JSON.stringify(new Intl.ListFormat('en', { type: 'disjunction' }).formatToParts(['x', 'y', 'z']))}`);
  out.push(`ListFormat iterable => ${new Intl.ListFormat('en').format(new Set(['p', 'q']))}`);
  const thrown = (fn) => { try { fn(); return 'no throw'; } catch (e) { return e instanceof TypeError ? 'TypeError' : 'other'; } };
  out.push(`ListFormat non-string => ${thrown(() => new Intl.ListFormat('en').format(['a', 1]))}`);
  out.push(`ListFormat without new => ${thrown(() => Intl.ListFormat('en'))}`);
  return out;
};
