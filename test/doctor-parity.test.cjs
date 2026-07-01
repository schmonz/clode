'use strict';
// Unit tests for test/doctor-parity.cjs (the /doctor slicer + parser + comparator).
// Ported from test/test_doctor_parity.py plus the synthetic cases in the J5 plan.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { sliceToReport, parseScreen, compare } = require('./doctor-parity.cjs');

const FIX = path.join(__dirname, 'fixtures', 'doctor');
function read(name) { return fs.readFileSync(path.join(FIX, name), 'utf8'); }
function report(name) {
  const [text, complete] = sliceToReport(read(name));
  assert.ok(complete, `${name} is not a complete capture`);
  return text;
}

const RULE = '─'.repeat(50);
function synth(...blocks) {
  // A full capture: welcome chrome, leading rule, blocks separated by blanks, footer.
  return ['welcome', RULE, ...blocks.join('\n\n').split('\n'), 'Enter to close'].join('\n');
}

// --- synthetic cases from the plan ---

test('sliceToReport flags incomplete capture (no rule)', () => {
  const [, ok] = sliceToReport('no rule here\nEnter to close');
  assert.strictEqual(ok, false);
});

test('parity holds with allowed skew add + allowed omission', () => {
  const native = synth('Installation warnings\n├ foo is not in your PATH\n└ ok item');
  const clode = synth('Installation warnings\n├ host bfs rejects flags clode uses — why\n└ ok item');
  const [nat, nok] = sliceToReport(native);
  const [clo, cok] = sliceToReport(clode);
  assert.ok(nok && cok);
  assert.deepStrictEqual(compare(parseScreen(nat), parseScreen(clo)), []);
});

test('an unlisted dropped item is a deviation', () => {
  const native = synth('Section\n├ keep me\n└ drop me');
  const clode = synth('Section\n├ keep me');
  const [nat] = sliceToReport(native);
  const [clo] = sliceToReport(clode);
  const devs = compare(parseScreen(nat), parseScreen(clo));
  assert.ok(devs.some((d) => d.includes('DROPPED item')));
});

// --- fixture-backed cases ported from test_doctor_parity.py ---

test('slice_to_report extracts report and marks complete', () => {
  const [rep, complete] = sliceToReport(read('native-sample.txt'));
  assert.strictEqual(complete, true);
  assert.ok(rep.replace(/^\s+/, '').startsWith('Diagnostics'));
  assert.ok(rep.includes('Enter to close'));
  assert.ok(!rep.includes("What's new"));
});

test('slice_to_report incomplete when top scrolled off', () => {
  const truncated = '  Multiple installations found ⚠\n  └ x\n\n  Enter to close · f to fix\n';
  const [, complete] = sliceToReport(truncated);
  assert.strictEqual(complete, false);
});

test('parse splits into titled blocks', () => {
  const titles = parseScreen(report('native-sample.txt')).map((b) => b.title);
  assert.ok(titles.includes('Diagnostics ✔'));
  assert.ok(titles.includes('Multiple installations found ⚠'));
  assert.ok(titles.includes('Installation warnings ⚠'));
  assert.ok(titles.includes('Remote Control ✔'));
});

test('parse joins wrapped continuations into one item', () => {
  const blocks = new Map(parseScreen(report('native-sample.txt')).map((b) => [b.title, b]));
  const iw = blocks.get('Installation warnings ⚠');
  assert.ok(iw.items.some((it) => it.includes('export PATH=') && it.includes('source ~/.zshrc')));
});

test('parse strips tree glyphs from items', () => {
  const blocks = new Map(parseScreen(report('native-sample.txt')).map((b) => [b.title, b]));
  for (const it of blocks.get('Multiple installations found ⚠').items) {
    assert.ok(!it.startsWith('├') && !it.startsWith('└'));
  }
});

test('compare clean pair is parity', () => {
  const native = parseScreen(report('native-sample.txt'));
  const clode = parseScreen(report('clode-sample.txt'));
  assert.deepStrictEqual(compare(native, clode), []);
});

test('compare flags a dropped section', () => {
  const native = parseScreen(report('native-sample.txt'));
  const clode = parseScreen(report('clode-sample.txt')).filter((b) => b.title !== 'Remote Control ✔');
  const devs = compare(native, clode);
  assert.ok(devs.some((d) => d.includes('DROPPED block') && d.includes('Remote Control')));
});

test('compare flags an unexpected added section', () => {
  const native = parseScreen(report('native-sample.txt'));
  const clode = parseScreen(report('clode-sample.txt'));
  clode.push({ title: 'Surprise telemetry ✔', items: [] });
  const devs = compare(native, clode);
  assert.ok(devs.some((d) => d.includes('ADDED block') && d.includes('Surprise telemetry')));
});

test('compare flags a dropped non-allowlisted item', () => {
  const native = parseScreen(report('native-sample.txt'));
  const clode = parseScreen(report('clode-sample.txt'));
  const iw = clode.find((b) => b.title === 'Installation warnings ⚠');
  iw.items = iw.items.filter((it) => !it.includes('Keychain is not writable'));
  const devs = compare(native, clode);
  assert.ok(devs.some((d) => d.includes('DROPPED item') && d.includes('Keychain is not writable')));
});

test('compare PID volatility does not trip', () => {
  const native = parseScreen(report('native-sample.txt'));
  const clode = parseScreen(report('clode-sample.txt'));
  const vn = native.find((b) => b.title === 'Version locks ✔');
  const vc = clode.find((b) => b.title === 'Version locks ✔');
  assert.deepStrictEqual(vn.items, vc.items);
});

test('compare allows skew items under installation warnings', () => {
  const native = parseScreen(report('native-sample.txt'));
  const clode = parseScreen(report('clode-sample.txt'));
  const iw = clode.find((b) => b.title === 'Installation warnings ⚠');
  assert.ok(iw.items.some((it) => it.includes('rejects flags clode')));
  assert.ok(iw.items.some((it) => it.includes('set CLODE_')));
  assert.deepStrictEqual(compare(native, clode), []);
});

test('compare flags a non-skew added item', () => {
  const native = parseScreen(report('native-sample.txt'));
  const clode = parseScreen(report('clode-sample.txt'));
  const iw = clode.find((b) => b.title === 'Installation warnings ⚠');
  iw.items.push('clode phoned home to evil.example.com');
  const devs = compare(native, clode);
  assert.ok(devs.some((d) => d.includes('ADDED item') && d.includes('evil.example.com')));
});

test('compare allows diagnostics divergence', () => {
  const native = parseScreen(report('native-sample.txt'));
  const clode = parseScreen(report('clode-sample.txt'));
  const dn = native.find((b) => b.title.includes('Diagnostics'));
  const dc = clode.find((b) => b.title.includes('Diagnostics'));
  assert.ok(dn.items.some((it) => it.startsWith('Currently running:') && it.includes('native')));
  assert.ok(dc.items.some((it) => it.startsWith('Currently running:') && it.includes('unknown')));
  assert.ok(dc.items.some((it) => it.startsWith('Invoked:')));
  assert.ok(!dn.items.some((it) => it.startsWith('Invoked:')));
  assert.deepStrictEqual(compare(native, clode), []);
});

test('compare flags non-divergent diagnostics change', () => {
  const native = parseScreen(report('native-sample.txt'));
  const clode = parseScreen(report('clode-sample.txt'));
  const dc = clode.find((b) => b.title.includes('Diagnostics'));
  dc.items = dc.items.filter((it) => !it.startsWith('Platform:'));
  dc.items.push('Platform: solaris-sparc');
  const devs = compare(native, clode);
  assert.ok(devs.some((d) => d.includes('Diagnostics') && d.includes('solaris-sparc')));
});
