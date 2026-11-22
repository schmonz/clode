'use strict';
// rg-held-fd-gates: the build gate over the shape RG-HELD-FD (libexec/rg-native.cjs) answers. 2.1.330's Grep on
// Linux searches a single file it holds open by spawning rg with that descriptor in a stdio slot and naming the
// slot's descriptor as the target: `mft="/proc/self/fd/3"`, `target:C?mft:g,inheritFd:C?y.fd:void 0`, and the spawn
// `R!==void 0&&{stdio:["pipe","pipe","pipe",R]}`. quaude's rg finds the file by looking the name's number up in the
// spawn's stdio, so the two must agree: the descriptor the target names IS the slot the spawn puts the held fd in.
// Read from the PINNED carve, found by structure (never by those minified names), so the day upstream moves the slot,
// renames the path (/dev/fd/N), or drops the shape, this goes red instead of every Linux Grep failing in a pty job.
//
// FLOOR: 2 (the held target's descriptor name, the spawn's stdio slot, each found exactly once).
// CONTROL: the 2.1.330 slices with one more "pipe" before the held fd (the slot moves to 4, the name still says 3).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { defineGuard, guardTests } = require('../guard.cjs');
const rgn = require('../../libexec/rg-native.cjs');
const { decodeGraphRunner } = require('../../libexec/inspect-claude-bundle.cjs');

const REPO = path.resolve(__dirname, '..', '..');
const EXTRACT = path.join(REPO, 'libexec', 'extract-claude-js.cjs');

// VERBATIM from the 2.1.330 darwin-arm64 carve (decoded graph.json, 2026-11-21), joined with ';'.
const CARVE_2_1_330 = 'var Q=1000,ee=60,mft="/proc/self/fd/3";'
  + 'return{lexical:e,canonical:g,spawnCwd:mUt(g,nre().rgPath),target:C?mft:g,inheritFd:C?y.fd:void 0,relativeOutput:!1,isDirectory:!1,recheckBeforeSpawn:U,close:()=>y.close()};'
  + 'k={...p&&{argv0:p},...R!==void 0&&{stdio:["pipe","pipe","pipe",R]},cwd:l===void 0?f:".",env:d$(),signal:r,windowsHide:!0}';

const ID = '[\\w$]+';
// The held target: `target:<cond>?<NAME>:<path>,inheritFd:<cond>?<handle>.fd:void 0`, NAME bound to a descriptor name.
// The spawn: `<fd>!==void 0&&{stdio:[...,<fd>]}`, the slot index of <fd>.
function scanHeldFd({ text, what }) {
  const findings = [];
  let examined = 0, named = null, slot = null;
  const targets = [...text.matchAll(new RegExp(`target:${ID}\\?(${ID}):${ID},inheritFd:${ID}\\?${ID}\\.fd:void 0`, 'g'))];
  if (targets.length !== 1) findings.push(`held target: \`target:C?NAME:path,inheritFd:C?handle.fd:void 0\` is in the carve ${targets.length} times, not once`);
  else {
    const name = targets[0][1].replace(/\$/g, '\\$');
    const binds = [...text.matchAll(new RegExp(`(?:^|[,;{\\s])${name}="([^"]*)"`, 'g'))];
    if (binds.length !== 1) findings.push(`held target: ${targets[0][1]} is bound to a string ${binds.length} times, not once`);
    else {
      named = binds[0][1];
      const n = rgn.childDescriptor(named);
      if (n === null) findings.push(`held target: ${targets[0][1]}="${named}" is no descriptor name quaude's rg reads (rg-native.cjs childDescriptor)`);
      else { examined++; named = { path: named, n }; }
    }
  }
  const spawns = [...text.matchAll(new RegExp(`(${ID})!==void 0&&\\{stdio:\\[([^\\]]*)\\]\\}`, 'g'))];
  if (spawns.length !== 1) findings.push(`spawn: \`fd!==void 0&&{stdio:[...,fd]}\` is in the carve ${spawns.length} times, not once`);
  else {
    const slots = spawns[0][2].split(',');
    const i = slots.indexOf(spawns[0][1]);
    if (i < 0) findings.push(`spawn: its stdio [${spawns[0][2]}] holds no ${spawns[0][1]}`);
    else { examined++; slot = i; }
  }
  if (named && named.n !== undefined && slot !== null && named.n !== slot) {
    findings.push(`the held target names descriptor ${named.n} (${named.path}) but the spawn hands the held fd over as stdio[${slot}]: `
      + 'quaude\'s rg (spawnDescriptors) would look in the wrong slot');
  }
  // and quaude's rg answers that slot: the descriptor table a spawn of this shape builds holds the fd there
  if (named && named.n !== undefined && slot !== null && named.n === slot) {
    const stdio = ['pipe', 'pipe', 'pipe']; stdio[slot] = 41;
    if (rgn.spawnDescriptors(stdio)(named.n) !== 41) findings.push(`quaude's rg does not find stdio[${slot}] under ${named.path}`);
  }
  return { findings, examined, note: `${what}: ${examined} of 2 found (the held target's descriptor name, the spawn's stdio slot)` };
}

// The carve of CLODE_PROVIDER_BIN, decoded the way inspect-claude-bundle reads it (the test/build-gates convention:
// BACKLOG.md, "readCarve has seven copies"; this is the eighth).
function readCarve() {
  const bin = process.env.CLODE_PROVIDER_BIN;
  if (!bin || !fs.existsSync(bin)) return { skip: 'no CLODE_PROVIDER_BIN (point it at a real claude binary to run this gate)' };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rg-held-fd-gate-'));
  try {
    const cli = path.join(dir, 'cli.cjs');
    const ex = spawnSync(process.execPath, [EXTRACT, bin, cli], { encoding: 'utf8' });
    if (ex.status !== 0) throw new Error(`extract-claude-js could not carve ${bin}: ${(ex.stderr || '').slice(0, 400)}`);
    const decoded = decodeGraphRunner(cli);
    return { text: decoded !== null ? decoded : fs.readFileSync(cli, 'latin1'), what: `the carve of ${bin}` };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

const controlText = () => CARVE_2_1_330.replace('stdio:["pipe","pipe","pipe",R]', 'stdio:["pipe","pipe","pipe","pipe",R]');

guardTests(defineGuard({
  name: 'rg-held-fd-from-carve',
  floor: 2,
  read: readCarve,
  scan: scanHeldFd,
  control: () => ({ text: controlText(), what: 'synthetic control' }),
}));

test('the verbatim 2.1.330 slices agree: /proc/self/fd/3 is stdio[3]', () => {
  const r = scanHeldFd({ text: CARVE_2_1_330, what: 'fixture' });
  assert.deepStrictEqual(r.findings, []);
  assert.strictEqual(r.examined, 2);
});

test('the control moves the slot and only the slot: one finding naming both numbers', () => {
  const r = scanHeldFd({ text: controlText(), what: 'control' });
  assert.strictEqual(r.examined, 2);
  assert.strictEqual(r.findings.length, 1, r.findings.join('\n'));
  assert.match(r.findings[0], /names descriptor 3 .* as stdio\[4\]/);
});

test('/dev/fd/N reads the same; a name quaude\'s rg cannot read, or a shape gone or doubled, is a finding', () => {
  assert.deepStrictEqual(scanHeldFd({ text: CARVE_2_1_330.replace('"/proc/self/fd/3"', '"/dev/fd/3"'), what: 'x' }).findings, []);
  const odd = scanHeldFd({ text: CARVE_2_1_330.replace('"/proc/self/fd/3"', '"/proc/self/fdinfo/3"'), what: 'x' });
  assert.match(odd.findings.join('\n'), /no descriptor name quaude's rg reads/);
  assert.strictEqual(odd.examined, 1);
  const gone = scanHeldFd({ text: CARVE_2_1_330.replace('inheritFd:C?y.fd:void 0', 'fd:y.fd'), what: 'x' });
  assert.strictEqual(gone.examined, 1);
  assert.match(gone.findings.join('\n'), /held target: .* 0 times/);
  const twice = scanHeldFd({ text: CARVE_2_1_330 + ';' + CARVE_2_1_330, what: 'x' });
  assert.strictEqual(twice.examined, 0);
});
