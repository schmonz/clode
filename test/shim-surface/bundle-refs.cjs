'use strict';
// Alias-aware scan of the pinned upstream bundle: "which properties of module M
// does upstream actually reference?"
//
// WHY THIS EXISTS, and why it is not the wall tripwire:
// test/node-shim-wall-tripwires.test.cjs deliberately matches only the DIRECT
// `require("fs").watch(` shape, because an alias-aware ALARM would be red on day
// one against vendored dead code, and a ratchet that is red before it catches
// anything is one nobody trusts. That reasoning is sound for an alarm. It is
// exactly WRONG for a MAP: when the output is a reviewed, goldened inventory
// rather than a pass/fail siren, over-inclusion costs a line of review and
// under-inclusion costs a silent gap. On 2026-08-01 that under-inclusion let the
// shim's fs.watch comment claim "the bundle has 0 call sites" while four
// existed, three of them first-party.
//
// So: the tripwire stays narrow and loud. This stays wide and quiet. They are
// answering different questions and must not be merged.
//
// TECHNIQUE: a minifier rewrites `require("fs")` to `var Zlm=require("fs")` and
// every later use to `Zlm.watch(...)`. So resolve aliases first, then look for
// `<alias>.<prop>`. Verified by hand against 2.1.218: Zlm/w3f/DTp/MDt all
// resolve to require("fs") and all four call `.watch(`.
//
// LIMITS, stated because a map that overstates its own reach is worse than none:
//   - Dynamic access (`fs[name]()`) is invisible. No regex fixes that.
//   - Re-export chains (`var A=require("fs"); var B=A;`) are followed one hop
//     only (DIRECT_ALIAS below), not transitively.
//   - Destructured imports (`var {watch}=require("fs")`) are captured as a
//     binding, but subsequent bare `watch(...)` calls are NOT distinguished from
//     any other identifier of that name, so they are reported as `destructured`
//     and left for a human rather than counted as call sites.
//   - Presence of a reference does NOT prove reachability at runtime. That is
//     the runtime recorder's job, not this file's.

const fs = require('node:fs');

// `var X=require("fs")`, `X = require("node:fs")`, with or without a leading
// interop wrapper (`X=__toESM(require("fs"))`).
function aliasesFor(text, moduleName) {
  const out = new Set();
  const specs = [moduleName, `node:${moduleName}`];
  for (const spec of specs) {
    const esc = spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Capture the identifier being assigned. Allow an optional single-call
    // interop wrapper between `=` and `require(`.
    const re = new RegExp(
      `([A-Za-z_$][A-Za-z0-9_$]*)\\s*=\\s*(?:[A-Za-z_$][A-Za-z0-9_$]*\\()?require\\(\\s*["']${esc}["']\\s*\\)`,
      'g',
    );
    let m;
    while ((m = re.exec(text)) !== null) out.add(m[1]);
  }
  return out;
}

// `var {watch, readFile: rf} = require("fs")`
function destructuredFor(text, moduleName) {
  const out = new Set();
  const specs = [moduleName, `node:${moduleName}`];
  for (const spec of specs) {
    const esc = spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\{([^{}]{0,400}?)\\}\\s*=\\s*require\\(\\s*["']${esc}["']\\s*\\)`, 'g');
    let m;
    while ((m = re.exec(text)) !== null) {
      for (const part of m[1].split(',')) {
        const name = part.split(':')[0].trim();
        if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) out.add(name);
      }
    }
  }
  return out;
}

// Count `<alias>.<prop>` occurrences, distinguishing a call (`(` follows) from a
// bare read. A bare read matters: feature detection (`typeof fs.glob==="function"`)
// changes control flow without ever calling the thing.
//
// PERFORMANCE — why this is one indexed pass and not the obvious nested loop:
// the naive shape (for each alias, for each property, indexOf over the bundle)
// is O(aliases x props x bundleSize). Real numbers from this repo: `fs` alone
// resolves to 154 aliases, times ~40 missing properties, times a 255MB bundle,
// is ~1.5 TB of scanning for ONE module — it did not finish in two minutes when
// written that way. Instead, tokenize `<ident>.<ident>` ONCE into an index and
// answer every later question from the map. One pass, reused by all callers.
//
// The index is built lazily and cached on the text object's behalf by the
// caller (buildIndex returns it; hold onto it across modules).
function buildIndex(text) {
  const index = new Map(); // "alias.prop" -> { calls, reads }
  const re = /([A-Za-z_$][A-Za-z0-9_$]*)\.([A-Za-z_$][A-Za-z0-9_$]*)\s*(\()?/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    // Reject `a.b.c` — the middle `.b` would otherwise look like a fresh alias
    // reference when it is really a property of something else.
    const before = text[m.index - 1];
    if (before === '.') continue;
    const key = `${m[1]}.${m[2]}`;
    let e = index.get(key);
    if (!e) { e = { calls: 0, reads: 0 }; index.set(key, e); }
    if (m[3]) e.calls++; else e.reads++;
  }
  return index;
}

function referencesTo(index, aliases, prop) {
  let calls = 0;
  let reads = 0;
  for (const alias of aliases) {
    const e = index.get(`${alias}.${prop}`);
    if (e) { calls += e.calls; reads += e.reads; }
  }
  return { calls, reads };
}

function loadBundle(bundlePath) {
  return fs.readFileSync(bundlePath, 'latin1');
}

module.exports = { aliasesFor, destructuredFor, referencesTo, buildIndex, loadBundle };
