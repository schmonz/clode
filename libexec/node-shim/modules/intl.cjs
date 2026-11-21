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

// ---- Intl.Segmenter (grapheme) ----
// UAX #29 extended grapheme clusters from the ONE clustering implementation,
// libexec/unicode-text.cjs, in its `uax29` profile: native Intl.Segmenter is ICU's
// UAX #29, and that profile is exactly it (GraphemeBreakTest 766/766; judged against
// native Bun over every code point by test/fidelity/text-differential.test.cjs). It used
// to be a code-point splitter that re-joined \p{Mark} and ZWJ pairs, which split flags,
// Hangul syllables, conjuncts and Prepends. Required RELATIVELY, the way process.cjs
// requires ../../target-env.cjs: from this modules/ dir that is libexec/ in a checkout
// and the archive root in a quaude or a native builder, where unicode-text.cjs rides
// beside bun-shim.cjs (libexec/quaude-blobulate.js).
//
// Required at the FIRST segment(), not when this module loads: the loader installs this
// polyfill in EVERY tjs process, and evaluating unicode-text.cjs's generated tables is most
// of a bare boot. Measured 2026-09-25 under tjs on darwin-arm64, interleaved medians: the
// loader running an empty program 44.1 -> 20.0 ms (40 runs each), `clode --version` 90.5 ->
// 66.4 ms (20 each) — paid by the builder and its workers, which never segment. A quaude
// pays it either way (bun-shim.cjs requires the module when it loads).
let graphemeBoundaries = null;
class Segmenter {
  constructor(_locales, options) { this._granularity = (options && options.granularity) || 'grapheme'; }
  segment(input) {
    if (graphemeBoundaries === null) ({ graphemeBoundaries } = require('../../unicode-text.cjs'));
    const str = String(input);
    const clusters = [];
    let index = 0;
    for (const end of graphemeBoundaries(str)) {
      clusters.push({ segment: str.slice(index, end), index, input: str });
      index = end;
    }
    // ECMA-402 %SegmentsPrototype% has TWO members: [Symbol.iterator] and
    // containing(). This polyfill shipped only the iterator, which is a gap that
    // reads as absence rather than as an error — `segments.containing` is plain
    // `undefined`, so a caller gets a NAMELESS quickjs "TypeError: not a
    // function" from a line that never mentions Intl. That is exactly how it was
    // found: npm slice-ansi (which then backed Bun.sliceAnsi) tokenises text with
    // `graphemeSegments.containing(index)`, every Ink layout pass that truncates
    // a string threw, upstream caught it, logged "frame dropped" and rendered
    // NOTHING. The TUI emitted 518 bytes of pure control sequences.
    //
    // containing(index): the segment whose code-unit range covers `index`, or
    // undefined when `index` is outside [0, input.length). Linear scan — the
    // clusters are already materialised and the bundle's strings are line-sized.
    return {
      [Symbol.iterator]() { return clusters[Symbol.iterator](); },
      containing(index) {
        const n = Math.trunc(Number(index)) || 0;
        if (n < 0 || n >= str.length) return undefined;
        for (const c of clusters) {
          if (n >= c.index && n < c.index + c.segment.length) return c;
        }
        return undefined;
      },
    };
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

// ---- Intl.DateTimeFormat (en-US; en-CA and sv-SE numeric dates) ----
// Built as PARTS (formatToParts is the primitive, format joins it), judged against
// native Bun's own ICU by test/node-shim-intl.test.cjs. ECMA-402's ToDateTimeOptions
// supplies the defaults: a formatter given no date or time field formats the date.
// timeZone: UTC and its aliases are honoured (getUTC*); any other zone is NOT applied
// (quickjs Date is local-only and there is no tz database), an approximation that
// renders the local clock instead of throwing.
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const p2 = (x) => String(x).padStart(2, '0');
const UTC_ZONES = new Set(['UTC', 'Etc/UTC', 'Etc/UCT', 'UCT', 'GMT', 'Etc/GMT', 'Etc/GMT0', 'Etc/GMT+0', 'Etc/GMT-0',
  'GMT0', 'Zulu', 'Etc/Zulu', 'Universal', 'Etc/Universal']);
const DATE_FIELDS = ['weekday', 'year', 'month', 'day'];
const TIME_FIELDS = ['dayPeriod', 'hour', 'minute', 'second', 'fractionalSecondDigits'];
// Locales whose numeric date is year-first, dash-separated and zero-padded (en-CA's and
// sv-SE's short date), and whose clock is 24-hour (sv-SE).
const ISO_DATE = new Set(['en-CA', 'sv-SE', 'sv']);
const H23 = new Set(['sv-SE', 'sv']);
// THE ONE PLATFORM FACT HERE (a written reason, per the one-implementation rule): native's ICU is not the same ICU
// everywhere. On macOS Bun uses the system's (Apple's CLDR), which joins a text-month date to its time with " at "
// ("Jan 1 at 2:59 AM"); on Linux it carries its own ICU, which joins them with ", " ("Jan 1, 2:59 AM", node's answer
// too). Measured 2026-11-21 with the BUN_OPTIONS preload oracle in native 2.1.330, darwin-arm64 and linux-x64-musl: of
// 120 rows those 13 joins are the only difference (test/fixtures/intl-locale-native.json, -linux.json). Windows and
// the BSDs carry Bun's own ICU too, so they take Linux's join; unmeasured there (no native oracle has run on them).
const DATE_TIME_AT = !!(globalThis.process && globalThis.process.platform === 'darwin');
const localeOf = (l) => {
  const first = Array.isArray(l) ? l[0] : l;
  return first == null ? 'en-US' : String(first && first.toString ? first.toString() : first);
};
// ECMA-402 ToDateTimeOptions(options, required, defaults); dateStyle/timeStyle are
// lowered to the fields they name in the locale.
function toDateTimeOptions(options, required, defaults, locale) {
  const o = Object.assign({}, options == null ? {} : Object(options));
  if (o.dateStyle !== undefined || o.timeStyle !== undefined) {
    const iso = ISO_DATE.has(locale);
    if (o.dateStyle === 'short') Object.assign(o, iso ? { year: 'numeric', month: '2-digit', day: '2-digit' } : { year: '2-digit', month: 'numeric', day: 'numeric' });
    else if (o.dateStyle === 'medium') Object.assign(o, { year: 'numeric', month: 'short', day: 'numeric' });
    else if (o.dateStyle === 'long') Object.assign(o, { year: 'numeric', month: 'long', day: 'numeric' });
    else if (o.dateStyle === 'full') Object.assign(o, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    if (o.timeStyle === 'short') Object.assign(o, { hour: 'numeric', minute: '2-digit' });
    else if (o.timeStyle === 'medium' || o.timeStyle === 'long' || o.timeStyle === 'full') Object.assign(o, { hour: 'numeric', minute: '2-digit', second: '2-digit' });
    return o;
  }
  let need = true;
  if (required === 'date' || required === 'any') for (const k of DATE_FIELDS) if (o[k] !== undefined) need = false;
  if (required === 'time' || required === 'any') for (const k of TIME_FIELDS) if (o[k] !== undefined) need = false;
  if (need && (defaults === 'date' || defaults === 'all')) Object.assign(o, { year: 'numeric', month: 'numeric', day: 'numeric' });
  if (need && (defaults === 'time' || defaults === 'all')) Object.assign(o, { hour: 'numeric', minute: 'numeric', second: 'numeric' });
  return o;
}
function clockOf(d, timeZone) {
  if (timeZone !== undefined && UTC_ZONES.has(String(timeZone))) {
    return { Y: d.getUTCFullYear(), M: d.getUTCMonth(), D: d.getUTCDate(), w: d.getUTCDay(), h: d.getUTCHours(), m: d.getUTCMinutes(), s: d.getUTCSeconds() };
  }
  return { Y: d.getFullYear(), M: d.getMonth(), D: d.getDate(), w: d.getDay(), h: d.getHours(), m: d.getMinutes(), s: d.getSeconds() };
}
function dateTimeParts(d, o, locale) {
  const c = clockOf(d, o.timeZone);
  const P = [];
  const put = (type, value) => P.push({ type, value: String(value) });
  const lit = (value) => put('literal', value);
  const textMonth = o.month === 'long' || o.month === 'short' || o.month === 'narrow';
  const hasDate = o.year !== undefined || o.month !== undefined || o.day !== undefined;
  const hasTime = o.hour !== undefined || o.minute !== undefined || o.second !== undefined;
  const year = o.year === '2-digit' ? p2(c.Y % 100) : String(c.Y);
  const day = o.day === '2-digit' ? p2(c.D) : String(c.D);
  if (o.weekday !== undefined) {
    put('weekday', (o.weekday === 'long' ? DAYL : DAY)[c.w]);
    if (hasDate || hasTime) lit(', ');
  }
  if (textMonth) {
    const name = (o.month === 'long' ? MONL : MON)[c.M];
    put('month', o.month === 'narrow' ? name[0] : name);
    if (o.day !== undefined) { lit(' '); put('day', day); }
    if (o.year !== undefined) { lit(o.day !== undefined ? ', ' : ' '); put('year', year); }
  } else if (hasDate) {
    const month = o.month === '2-digit' ? p2(c.M + 1) : String(c.M + 1);
    if (ISO_DATE.has(locale) && o.year !== undefined && o.month !== undefined && o.day !== undefined) {
      put('year', year); lit('-'); put('month', p2(c.M + 1)); lit('-'); put('day', p2(c.D));
    } else {
      const order = [['month', o.month, month], ['day', o.day, day], ['year', o.year, year]].filter((f) => f[1] !== undefined);
      order.forEach(([type, , value], i) => { if (i) lit('/'); put(type, value); });
    }
  }
  if (hasTime) {
    if (hasDate) lit(textMonth && DATE_TIME_AT ? ' at ' : H23.has(locale) ? ' ' : ', ');
    const h12 = o.hour12 !== undefined ? !!o.hour12
      : o.hourCycle !== undefined ? (o.hourCycle === 'h11' || o.hourCycle === 'h12') : !H23.has(locale);
    const shown = [];
    if (o.hour !== undefined) {
      const hh = h12 ? (c.h % 12 || 12) : c.h;
      shown.push(['hour', o.hour === '2-digit' || !h12 ? p2(hh) : String(hh)]);
    }
    if (o.minute !== undefined) shown.push(['minute', o.hour !== undefined || o.minute === '2-digit' ? p2(c.m) : String(c.m)]);
    if (o.second !== undefined) shown.push(['second', o.minute !== undefined || o.second === '2-digit' ? p2(c.s) : String(c.s)]);
    shown.forEach(([type, value], i) => { if (i) lit(':'); put(type, value); });
    if (h12 && o.hour !== undefined) { lit(' '); put('dayPeriod', c.h < 12 ? 'AM' : 'PM'); }
  }
  return P;
}
const asDate = (d) => (d === undefined ? new Date() : (d instanceof Date ? d : new Date(d)));
class DateTimeFormat {
  constructor(l, o) { this._l = localeOf(l); this._o = toDateTimeOptions(o, 'any', 'date', this._l); }
  formatToParts(d) {
    d = asDate(d);
    if (isNaN(d.getTime())) throw new RangeError('Invalid time value');
    return dateTimeParts(d, this._o, this._l);
  }
  format(d) { return this.formatToParts(d).map((p) => p.value).join(''); }
  resolvedOptions() { return Object.assign({ locale: this._l, timeZone: this._o.timeZone || 'UTC', calendar: 'gregory', numberingSystem: 'latn' }, this._o); }
}

// ECMA-402 DEFINES Date.prototype.toLocaleString / toLocaleDateString / toLocaleTimeString
// and Number.prototype.toLocaleString in terms of DateTimeFormat and NumberFormat. quickjs's
// own versions ignore both arguments ("01/01/2027, 02:59:07 AM" for any options), so the
// bundle's CronCreate answered "Next run: 01/01/2027 02:59:00am" where native says
// "Jan 1 2:59am", and its cost lines lost their grouping and fixed decimals. Installed
// here because this module is evaluated only on an engine with no Intl (the loader's gate):
// where Intl is native, its toLocale* methods are native too.
function installLocaleMethods(G) {
  const define = (proto, name, fn) => Object.defineProperty(proto, name, { value: fn, writable: true, configurable: true, enumerable: false });
  for (const [name, required, defaults] of [['toLocaleString', 'any', 'all'], ['toLocaleDateString', 'date', 'date'], ['toLocaleTimeString', 'time', 'time']]) {
    define(G.Date.prototype, name, {
      [name](locales, options) {
        if (isNaN(this.getTime())) return 'Invalid Date';
        const l = localeOf(locales);
        return dateTimeParts(this, toDateTimeOptions(options, required, defaults, l), l).map((p) => p.value).join('');
      },
    }[name]);
  }
  define(G.Number.prototype, 'toLocaleString', {
    toLocaleString(_locales, options) { return fmtNumber(Number.prototype.valueOf.call(this), options); },
  }.toLocaleString);
}
installLocaleMethods(globalThis);

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

// ---- Intl.ListFormat — the en patterns native's ICU answers with ----
// 2.1.330 builds one at MODULE LOAD in the REPL's survey chunk (`new Intl.ListFormat("en",{style:"long",
// type:"conjunction"})`), so without it the REPL import threw and the TUI never painted. [pair, middle, end]
// separators per type and style, each measured in native Bun (test/fixtures/intl-locale-native.json).
const LIST_SEPARATORS = {
  conjunction: { long: [' and ', ', ', ', and '], short: [' & ', ', ', ', & '], narrow: [', ', ', ', ', '] },
  disjunction: { long: [' or ', ', ', ', or '], short: [' or ', ', ', ', or '], narrow: [' or ', ', ', ', or '] },
  unit: { long: [', ', ', ', ', '], short: [', ', ', ', ', '], narrow: [' ', ' ', ' '] },
};
class ListFormat {
  constructor(l, o) {
    const opt = o || {};
    const type = opt.type === undefined ? 'conjunction' : String(opt.type);
    const style = opt.style === undefined ? 'long' : String(opt.style);
    if (!LIST_SEPARATORS[type]) throw new RangeError(`Value ${type} out of range for Intl.ListFormat options property type`);
    if (!LIST_SEPARATORS[type][style]) throw new RangeError(`Value ${style} out of range for Intl.ListFormat options property style`);
    this._r = { locale: localeOf(l), type, style };
  }
  formatToParts(list) {
    const items = [];
    for (const x of list === undefined ? [] : list) {
      if (typeof x !== 'string') throw new TypeError('Iterable yielded a value that is not a string');
      items.push(x);
    }
    const [pair, middle, end] = LIST_SEPARATORS[this._r.type][this._r.style];
    const parts = [];
    items.forEach((x, i) => {
      if (i > 0) parts.push({ type: 'literal', value: items.length === 2 ? pair : i === items.length - 1 ? end : middle });
      parts.push({ type: 'element', value: x });
    });
    return parts;
  }
  format(list) { return this.formatToParts(list).map((p) => p.value).join(''); }
  resolvedOptions() { return Object.assign({}, this._r); }
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
  RelativeTimeFormat, ListFormat,
  Collator: newOptional(Collator),
  DisplayNames, Locale,
  getCanonicalLocales: (l) => (Array.isArray(l) ? l.map(String) : [String(l)]),
  supportedValuesOf: () => [],
};
