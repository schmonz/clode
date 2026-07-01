#!/usr/bin/env node
'use strict';
// Slice a captured /doctor SCREEN to its report, parse it into blank-separated
// blocks, and compare a native render against a clode render, allowing ONLY clode's
// intended deviations:
//   - it may add the applet-skew items to the Installation warnings block;
//   - it may drop two install-identity-gated warnings (clode runs from its cache
//     dir, so it is neither the npm-global nor the native install);
//   - its Diagnostics section may diverge on the labels in DIAGNOSTICS_DIVERGENT_LABELS
//     (clode runs node + extracted JS, so "Currently running"/"Path"/"Invoked" differ).
// Any other added/dropped block or item is reported.
//
// slice_to_report() extracts the report (leading full-width rule -> 'Enter to close'
// footer) and flags an INCOMPLETE capture when that boundary is missing.
//
// CLI: doctor-parity.cjs NATIVE_SCREEN CLODE_SCREEN
//      exits 0 on parity, 1 on unlisted deviations, 2 on an incomplete capture.
//
// Faithful port of test/doctor_parity.py. One intentional divergence: Python prints
// item strings with %r (single-quoted repr); this uses JSON.stringify (double-quoted).
// The deviation strings are read by humans / asserted on by substring, not byte-
// compared, so this is acceptable.
const fs = require('node:fs');

const TREE_LEADS = ['├', '└', '│'];

// Items clode may ADD to a shared block — the applet-skew finding renders as native
// "Installation warnings" data: an `issue` line + its `Run: fix` line.
const ALLOWED_ADDED_ITEM_SUBSTRINGS = [
  'rejects flags clode', // the skew issue line
  'set CLODE_',          // the skew fix line ("Run: set CLODE_<APPLET> …")
];

// Items clode may omit from "Installation warnings" (each nag is about the install
// you launched AS; clode launches as neither the npm-global nor the native install).
const ALLOWED_OMISSION_SUBSTRINGS = [
  'is not in your PATH',           // the ~/.local/bin PATH nag
  'export PATH=',                  // that nag's "Run:" follow-up
  'Leftover npm global installation',
  'npm -g uninstall',              // that nag's "Run:" follow-up
];

// In Diagnostics, clode legitimately diverges: it runs extracted JS under host node.
// These item LABELS may differ in value OR presence (either direction) ONLY there.
const DIAGNOSTICS_DIVERGENT_LABELS = ['Currently running:', 'Path:', 'Invoked:'];

// The report's top boundary: a full-width horizontal rule (pure dashes, no box
// corners). Unique per report -> also our completeness signal.
const REPORT_RULE = /^\s*─{40,}\s*$/;
const REPORT_FOOTER = 'Enter to close';

function sliceToReport(text) {
  // Return [report_text, complete]. The report runs from the line AFTER the leading
  // full-width rule through the 'Enter to close' footer. complete is false when the
  // rule isn't present exactly once or the footer is missing.
  const lines = text.split('\n');
  const rules = [];
  const feet = [];
  lines.forEach((l, i) => {
    if (REPORT_RULE.test(l)) rules.push(i);
    if (l.includes(REPORT_FOOTER)) feet.push(i);
  });
  if (rules.length !== 1 || feet.length === 0) return [text, false];
  return [lines.slice(rules[0] + 1, feet[feet.length - 1] + 1).join('\n'), true];
}

function normalize(s) {
  // Mask runtime-volatile tokens (the background-server PID in 'Version locks').
  return s.replace(/PID \d+/g, 'PID N');
}

function stripTree(s) {
  // Strip a leading tree connector (├ └ │) and surrounding whitespace.
  s = s.trim();
  while (s.length && TREE_LEADS.includes(s[0])) s = s.slice(1).trim();
  return s;
}

function allowedDropped(title, item) {
  if (ALLOWED_OMISSION_SUBSTRINGS.some((s) => item.includes(s))) return true;
  return title.includes('Diagnostics') && DIAGNOSTICS_DIVERGENT_LABELS.some((l) => item.startsWith(l));
}

function allowedAdded(title, item) {
  if (ALLOWED_ADDED_ITEM_SUBSTRINGS.some((s) => item.includes(s))) return true;
  return title.includes('Diagnostics') && DIAGNOSTICS_DIVERGENT_LABELS.some((l) => item.startsWith(l));
}

function parseScreen(text) {
  // Return an ordered list of {title, items}. Leading/trailing blank lines are
  // ignored; blank lines separate blocks; within a block the first line is the title
  // and each tree-entry line is an item (wrapped continuations joined onto the item,
  // or onto the title for pre-item lines).
  const groups = [];
  let cur = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      if (cur.length) { groups.push(cur); cur = []; }
    } else {
      cur.push(line);
    }
  }
  if (cur.length) groups.push(cur);

  const out = [];
  for (const lines of groups) {
    const b = { title: normalize(stripTree(lines[0])), items: [] };
    for (const line of lines.slice(1)) {
      const lead = line.trim()[0];
      if (TREE_LEADS.includes(lead)) {
        b.items.push(normalize(stripTree(line)));
      } else if (b.items.length) {
        b.items[b.items.length - 1] += ' ' + normalize(line.trim());
      } else {
        b.title += ' ' + normalize(line.trim());
      }
    }
    out.push(b);
  }
  return out;
}

function compare(native, clode) {
  // Return a list of UNLISTED deviation strings; empty means parity holds (modulo the
  // allowlisted skew addition, install-warning omissions, and Diagnostics divergence).
  const dev = [];
  const nt = native.map((b) => b.title);
  const ct = clode.map((b) => b.title);

  for (const b of clode) if (!nt.includes(b.title)) dev.push(`unexpected ADDED block: ${JSON.stringify(b.title)}`);
  for (const b of native) if (!ct.includes(b.title)) dev.push(`unexpected DROPPED block: ${JSON.stringify(b.title)}`);

  const sn = nt.filter((t) => ct.includes(t));
  const sc = ct.filter((t) => nt.includes(t));
  if (JSON.stringify(sn) !== JSON.stringify(sc)) {
    dev.push(`section order changed: native=${JSON.stringify(sn)} clode=${JSON.stringify(sc)}`);
  }

  const byTitle = new Map(clode.map((b) => [b.title, b]));
  for (const nb of native) {
    const cb = byTitle.get(nb.title);
    if (!cb) continue;
    for (const item of nb.items) {
      if (!cb.items.includes(item) && !allowedDropped(nb.title, item)) {
        dev.push(`unexpected DROPPED item in ${JSON.stringify(nb.title)}: ${JSON.stringify(item)}`);
      }
    }
    for (const item of cb.items) {
      if (!nb.items.includes(item) && !allowedAdded(nb.title, item)) {
        dev.push(`unexpected ADDED item in ${JSON.stringify(nb.title)}: ${JSON.stringify(item)}`);
      }
    }
  }
  return dev;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length !== 2) {
    process.stderr.write('usage: doctor-parity.cjs NATIVE_SCREEN CLODE_SCREEN\n');
    process.exit(1);
  }
  const [nat, nok] = sliceToReport(fs.readFileSync(argv[0], 'utf8'));
  const [clo, cok] = sliceToReport(fs.readFileSync(argv[1], 'utf8'));
  if (!nok || !cok) {
    process.stdout.write('INCOMPLETE CAPTURE: /doctor report boundary (rule/footer) not found — '
      + `increase capture --rows (native_complete=${nok} clode_complete=${cok})\n`);
    process.exit(2);
  }
  const devs = compare(parseScreen(nat), parseScreen(clo));
  for (const d of devs) process.stdout.write(d + '\n');
  process.exit(devs.length ? 1 : 0);
}

if (require.main === module) main();
module.exports = { sliceToReport, parseScreen, compare };
