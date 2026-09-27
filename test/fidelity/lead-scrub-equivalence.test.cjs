'use strict';
// LEAD-SCRUB-POSSESSIVE against NATIVE: the carve's own bracketedLeadScrubPattern builder runs
// inside native Bun (JavaScriptCore, the truth) on the list the carve's `get lead` really passes,
// the HOOKED builder runs under quaude's engine and shim (the subject), and over one corpus both
// must mark the same brackets in every input and neutralize every input to the same text.
//
// Why a corpus at all, when the rewrite is proven local (libexec/extract-claude-js.cjs,
// LEAD-SCRUB-POSSESSIVE)? The proof covers the separators. This row covers what the proof takes
// as given: that QuickJS reads the rewritten 1.5-million-character pattern, its classes, case
// folding and lookarounds, as JavaScriptCore reads the original. Native cannot run the rewrite
// itself ("regular expression too large", JavaScriptCore's limit is 1 MiB of pattern), so the
// comparison is exactly the one users see: native's pattern on native, ours on ours.
//
// THE CONTROL THAT THE CORPUS CAN FAIL. A joiner separator that backtracking may shorten (the
// atomic group made a plain one) must answer differently from native on this corpus, or the
// corpus is blind to the one thing the rewrite had to keep. With the real classes that happens
// only before a span, through the two joiners a span may end on (U+02D0 and U+A4FD, measured over
// every code point at 2.1.283), which is why the corpus has a part built from them. The letter
// separator has no such control here: its class shares no character with any letter, digit or
// dash class (measured), so its atomicity is unobservable with these classes; the unit tests'
// stand-in classes make it observable (test/extract-hooks.test.cjs).
//
// WHEN IT RUNS. Against the pinned provider (test/provider-resolve.cjs), which must also run on
// this host: it is the native oracle. A provider that does not run here (CI's minimised one) skips
// and says so; a provider without the builder (before 2.1.278) skips and says so. A hook that did
// not apply is not a skip: it throws.
const { test } = require('node:test');
const assert = require('node:assert');
const { defineGuard, guardTests } = require('../guard.cjs');
const LS = require('../lead-scrub-oracle.cjs');
const { tjsPath } = require('../node-shim-helper.cjs');
const { providerBin, skipReason } = require('../provider-resolve.cjs');
const { nativeVersion } = require('../../scripts/lib/native-oracle.cjs');
const { transformGraph } = require('../../libexec/extract-claude-js.cjs');

const CORPUS_FLOOR = 7000;

// PURE. truth/subject are evaluateLead() results; controls, results that must NOT equal truth.
function judge({ truth, subject, controls, parts, note }) {
  const findings = [];
  if (truth.error) findings.push(`native could not build the original pattern: ${truth.error}`);
  if (subject.error) findings.push(`quaude could not build the rewritten pattern: ${subject.error}`);
  const n = truth.res ? truth.res.length : 0;
  if (!truth.error && !subject.error) {
    if (subject.res.length !== n) findings.push(`quaude answered ${subject.res.length} inputs, native ${n}`);
    if (subject.captures !== 0) findings.push(`the rewritten pattern still has ${subject.captures} capture group(s)`);
    const partOf = (i) => { let k = i; for (const [name, list] of Object.entries(parts)) { if (k < list.length) return name; k -= list.length; } return '?'; };
    const differ = [];
    for (let i = 0; i < n; i++) if (truth.res[i] !== subject.res[i]) differ.push(i);
    for (const i of differ.slice(0, 20)) {
      findings.push(`input ${i} (${partOf(i)}): native ${JSON.stringify(truth.res[i])}, quaude ${JSON.stringify(subject.res[i])}`);
    }
    if (differ.length > 20) findings.push(`... and ${differ.length - 20} more differing inputs`);
  }
  for (const [name, c] of Object.entries(controls)) {
    if (c.error) findings.push(`control "${name}" could not run: ${c.error}`);
    else if (truth.res && c.res.every((r, i) => r === truth.res[i])) {
      findings.push(`the corpus cannot tell ${name} from native: the equality above could not fail`);
    }
  }
  return { findings, examined: n, note };
}

// The joiner separator made a plain group that backtracking may shorten, in the carve's own names.
function naiveJoiner(text, names) {
  const atomic = `return\`(?=(\${${names.MU_D}}\${${names.MU_E}}))(?:\\\\\${${names.MU_U}})\`}`;
  if (text.split(atomic).length !== 2) throw new Error('lead-scrub guard: the joiner helper is not where the anchor put it');
  return text.split(atomic).join(`return\`(\${${names.MU_D}}\${${names.MU_E}})\`}`);
}

const guard = defineGuard({
  name: 'lead-scrub-equivalence',
  floor: CORPUS_FLOOR,
  read() {
    if (!tjsPath()) return { skip: 'no tjs binary (CLODE_TJS); quaude\'s engine is the subject' };
    const bin = providerBin();
    if (!bin) return { skip: skipReason() };
    const version = nativeVersion(bin);
    if (!/^\d+\.\d+\.\d+/.test(version)) {
      return { skip: `the provider ${bin} does not run on this host (--version printed `
        + `${JSON.stringify(version.slice(0, 160))}), and it is the native oracle` };
    }
    const sources = LS.preHookSources(bin);
    const { sources: hooked, report } = transformGraph(sources);
    const r = report.find((e) => e.key === 'lead_scrub_possessive');
    if (!r) throw new Error('transformGraph reports no lead_scrub_possessive hook');
    if (r.benign) return { skip: `${version}: ${r.why}` };
    if (!r.applied) throw new Error(`${version}: hook lead_scrub_possessive did not apply: ${r.why}`);
    const builder = LS.findBuilder(sources);
    const list = LS.leadList(sources, builder);
    if (!list) throw new Error(`${version}: cannot find the phrase list \`get lead\` hands the builder in ${builder.module}`);
    const original = LS.moduleAsFunctionBody(builder.text, builder.names);
    const rewritten = LS.moduleAsFunctionBody(hooked[builder.module], builder.names);
    const { parts } = LS.buildCorpus(new Function(original)().__free, list, builder.symbols);
    const corpus = Object.values(parts).flat();
    const truth = LS.runNativeLead(bin, original, list, corpus);
    const subject = LS.runQuaudeLead(rewritten, list, corpus);
    // QuickJS cannot build the control (it keeps every capture group), so native runs it.
    const control = LS.runNativeLead(bin, LS.moduleAsFunctionBody(naiveJoiner(builder.text, builder.names), builder.names), list, corpus);
    const words = list.flat().filter((g) => typeof g === 'string');
    const differ = control.res ? control.res.filter((x, i) => x !== truth.res[i]).length : 0;
    const note = `${version}, ${builder.module}: ${list.length} phrases, ${words.length} words; native's pattern `
      + `${truth.captures} capture groups, quaude's ${subject.captures} (${subject.sourceLength} characters); `
      + `corpus ${Object.entries(parts).map(([k, v]) => `${k} ${v.length}`).join(', ')}; the backtracking `
      + `joiner control differs from native on ${differ}`;
    return { truth, subject, controls: { 'a backtracking joiner separator': control }, parts, note };
  },
  scan: judge,
  control() {
    // The verbatim 2.1.283 builder with stand-in classes (test/lead-scrub-oracle.cjs): the original
    // as the truth, and as the subject the same builder with its joiner separator made one
    // backtracking may shorten, which answers differently on the sample corpus.
    const corpus = LS.sampleCorpus();
    const spec = LS.sampleSpec();
    const res = (text) => LS.matchesOver(LS.loadBuilder(text)(spec), corpus);
    return { truth: { res: res(LS.MODULE_283) }, subject: { res: res(LS.NAIVE_MU_283), captures: 0 },
      controls: {}, parts: { sample: corpus } };
  },
});

guardTests(guard, { test, assert });
