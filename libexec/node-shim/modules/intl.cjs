// node-shim: a pragmatic Intl polyfill for the constructors the Claude Code
// bundle actually uses. quickjs-ng (the tjs engine) ships NO Intl object, so
// without this every `new Intl.X(...)` is `new undefined(...)` → TypeError
// "not a function". That is the exact wall the interactive TUI hits the moment
// a turn renders: `wuh` (the token-count formatter) calls
// `new Intl.NumberFormat("en-US",{notation:"compact",…})`.
//
// Scope: en-US / en only (the sole locale the bundle passes). Correctness is
// tuned to the bundle's option shapes; where a faithful implementation would
// need data quickjs lacks (a tz database, ICU rounding modes) we approximate in
// a way that renders rather than throws, and say so at the call site. This is
// the "wire a fuller Intl" the loader's Segmenter comment anticipated.

// ---- Intl.Segmenter (grapheme) — moved here from loader.cjs verbatim ----
const MARK = /\p{Mark}/u; // combining marks (accents, etc.)
const ZWJ = '‍';
class Segmenter {
  constructor(_locales, options) { this._granularity = (options && options.granularity) || 'grapheme'; }
  segment(input) {
    const str = String(input);
    const cps = Array.from(str); // code-point aware
    const clusters = [];
    let i = 0, index = 0;
    while (i < cps.length) {
      let seg = cps[i]; i++;
      // extend the cluster with trailing combining marks and ZWJ joins so a
      // base+accent (and simple ZWJ emoji sequences) form ONE cluster.
      for (;;) {
        if (i < cps.length && MARK.test(cps[i])) { seg += cps[i]; i++; continue; }
        if (i < cps.length && cps[i] === ZWJ && i + 1 < cps.length) { seg += cps[i] + cps[i + 1]; i += 2; continue; }
        break;
      }
      clusters.push({ segment: seg, index, input: str }); index += seg.length;
    }
    return { [Symbol.iterator]() { return clusters[Symbol.iterator](); } };
  }
  resolvedOptions() { return { granularity: this._granularity }; }
}

// ---- Intl.NumberFormat (en-US: standard + compact) ----
// Rounding uses toFixed (half-away-from-zero) rather than the bundle's requested
// roundingMode:"halfEven" — a sub-last-digit difference for display counts.
const group = (ip) => ip.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
function fixTrim(x, minFD, maxFD, grouping) {
  if (maxFD < minFD) maxFD = minFD;
  const s = Math.abs(x).toFixed(Math.min(Math.max(maxFD | 0, 0), 100));
  let [ip, fp = ''] = s.split('.');
  while (fp.length > minFD && fp.endsWith('0')) fp = fp.slice(0, -1);
  if (grouping) ip = group(ip);
  return (x < 0 && Number(x) !== 0 ? '-' : '') + (fp.length ? ip + '.' + fp : ip);
}
function fmtNumber(n, o) {
  n = Number(n);
  o = o || {};
  if (!isFinite(n)) return String(n);
  const grouping = o.useGrouping !== false && o.useGrouping !== 'never';
  if (o.notation === 'compact') {
    const abs = Math.abs(n);
    for (const [v, suf] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) {
      if (abs >= v) return fixTrim(n / v, o.minimumFractionDigits || 0, o.maximumFractionDigits == null ? 1 : o.maximumFractionDigits, false) + suf;
    }
    return fixTrim(n, o.minimumFractionDigits || 0, o.maximumFractionDigits || 0, grouping);
  }
  return fixTrim(n, o.minimumFractionDigits || 0, o.maximumFractionDigits == null ? 3 : o.maximumFractionDigits, grouping);
}
class NumberFormat {
  constructor(_l, o) { this._o = o || {}; }
  format(n) { return fmtNumber(n, this._o); }
  formatToParts(n) { return [{ type: 'literal', value: this.format(n) }]; }
  resolvedOptions() { return Object.assign({ locale: 'en-US', numberingSystem: 'latn', style: 'decimal' }, this._o); }
}

// ---- Intl.DateTimeFormat (en-US) ----
// Honors year/month/day/hour/minute/second/weekday. timeZone is NOT applied
// (quickjs Date is local-only and there is no tz database) — an approximation
// that keeps the TUI rendering instead of throwing.
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const p2 = (x) => String(x).padStart(2, '0');
class DateTimeFormat {
  constructor(_l, o) { this._o = o || {}; }
  format(d) {
    d = d == null ? new Date() : (d instanceof Date ? d : new Date(d));
    const o = this._o;
    const wd = o.weekday ? (o.weekday === 'long' ? DAYL : DAY)[d.getDay()] : '';
    let datePart = '';
    if (o.month === 'long' || o.month === 'short') {
      datePart = (o.month === 'long' ? MONL : MON)[d.getMonth()] +
        (o.day ? ' ' + (o.day === '2-digit' ? p2(d.getDate()) : d.getDate()) : '') +
        (o.year ? ', ' + (o.year === '2-digit' ? p2(d.getFullYear() % 100) : d.getFullYear()) : '');
    } else if (o.year || o.month || o.day) {
      const mdy = [];
      if (o.month) mdy.push(o.month === '2-digit' ? p2(d.getMonth() + 1) : String(d.getMonth() + 1));
      if (o.day) mdy.push(o.day === '2-digit' ? p2(d.getDate()) : String(d.getDate()));
      if (o.year) mdy.push(o.year === '2-digit' ? p2(d.getFullYear() % 100) : String(d.getFullYear()));
      datePart = mdy.join('/');
    }
    let timePart = '';
    if (o.hour || o.minute || o.second) {
      const h24 = d.getHours();
      const h24sys = o.hour12 === false || o.hourCycle === 'h23' || o.hourCycle === 'h24';
      let hh = h24;
      if (!h24sys) { hh = h24 % 12; if (hh === 0) hh = 12; }
      const bits = [];
      if (o.hour) bits.push(o.hour === '2-digit' ? p2(hh) : String(hh));
      if (o.minute) bits.push(o.minute === '2-digit' ? p2(d.getMinutes()) : String(d.getMinutes()));
      if (o.second) bits.push(o.second === '2-digit' ? p2(d.getSeconds()) : String(d.getSeconds()));
      timePart = bits.join(':');
      if (!h24sys) timePart += ' ' + (h24 < 12 ? 'AM' : 'PM');
    }
    const body = [datePart, timePart].filter(Boolean).join(', ');
    return [wd, body].filter(Boolean).join(', ') || d.toISOString();
  }
  formatToParts(d) { return [{ type: 'literal', value: this.format(d) }]; }
  resolvedOptions() { return Object.assign({ locale: 'en-US', timeZone: this._o.timeZone || 'UTC', calendar: 'gregory', numberingSystem: 'latn' }, this._o); }
}

// ---- Intl.RelativeTimeFormat (en) ----
class RelativeTimeFormat {
  constructor(_l, o) { this._o = o || {}; }
  format(v, unit) {
    const n = Number(v), u = String(unit).replace(/s$/, '');
    const noun = Math.abs(n) === 1 ? u : u + 's';
    return n < 0 ? `${Math.abs(n)} ${noun} ago` : n > 0 ? `in ${n} ${noun}` : `this ${u}`;
  }
  formatToParts(v, unit) { return [{ type: 'literal', value: this.format(v, unit) }]; }
  resolvedOptions() { return Object.assign({ locale: 'en', style: 'long', numeric: 'always' }, this._o); }
}

// ---- Intl.Collator — locale-agnostic ordinal compare ----
class Collator {
  constructor(_l, o) { this._o = o || {}; }
  compare(a, b) { a = String(a); b = String(b); return a < b ? -1 : a > b ? 1 : 0; }
  resolvedOptions() { return Object.assign({ locale: 'en-US', usage: 'sort', sensitivity: 'variant' }, this._o); }
}

// ---- Intl.DisplayNames — identity (returns the code when no mapping) ----
class DisplayNames {
  constructor(_l, o) { this._o = o || {}; }
  of(code) { return code == null ? undefined : String(code); }
  resolvedOptions() { return Object.assign({ locale: 'en', type: 'language', style: 'long', fallback: 'code' }, this._o); }
}

// ---- Intl.Locale — minimal BCP-47 tag parsing ----
class Locale {
  constructor(tag, opts) {
    this._tag = String(tag && tag.toString ? tag.toString() : (tag || 'en-US'));
    const parts = this._tag.split('-');
    this.language = (opts && opts.language) || parts[0] || 'en';
    this.region = (opts && opts.region) || parts.find((p) => /^[A-Z]{2}$/.test(p));
    this.script = (opts && opts.script) || parts.find((p) => /^[A-Z][a-z]{3}$/.test(p));
    this.baseName = this._tag;
  }
  toString() { return this._tag; }
  maximize() { return this; }
  minimize() { return this; }
}

// ECMA-402's three LEGACY constructors — Collator, NumberFormat, DateTimeFormat —
// are callable WITHOUT `new` (web-compat): V8/Node return an instance either way,
// and the bundle relies on it (the interactive TUI does `Intl.DateTimeFormat(...)`
// with no `new` — an ES6 `class` throws "class constructors must be invoked with
// 'new'", which crashed the TUI). Wrap those three so both call forms work; the
// newer constructors (Segmenter/RelativeTimeFormat/DisplayNames/Locale) correctly
// REQUIRE `new` in V8, so they stay plain classes. Locked by
// test/node-shim-intl.test.cjs (node-parity on both call forms).
const newOptional = (C) => {
  const F = function (...args) { return new C(...args); };
  F.prototype = C.prototype;
  try { Object.defineProperty(F, 'name', { value: C.name }); } catch { /* ignore */ }
  return F;
};

module.exports = {
  Segmenter,
  NumberFormat: newOptional(NumberFormat),
  DateTimeFormat: newOptional(DateTimeFormat),
  RelativeTimeFormat,
  Collator: newOptional(Collator),
  DisplayNames, Locale,
  getCanonicalLocales: (l) => (Array.isArray(l) ? l.map(String) : [String(l)]),
  supportedValuesOf: () => [],
};
