#!/usr/bin/env node
'use strict';
// Generate the GENERATED region of libexec/rg-types.cjs: rg's file type table and its version text,
// READ FROM NATIVE'S EMBEDDED rg, never hand-written (memory shim-constants-are-a-class).
//
//   node scripts/gen-rg-types.cjs --native BIN            # regenerate
//   node scripts/gen-rg-types.cjs --native BIN --check    # exit 1 if regeneration would change the file
//   node scripts/gen-rg-types.cjs --native BIN --emit     # print the regenerated file, write nothing
// staleness(current, regenerated) is the --check verdict, exported for its guard
// (test/build-gates/rg-types-gates.test.cjs, rg-types-fresh).
//
// BIN is a native Claude Code (the pinned provider); its embedded rg is reached as upstream reaches it
// (argv0 `rg`, scripts/lib/rg-probe.cjs). What is read:
//   types     `rg --type-list`: one `name: glob, glob` line per type, in name order. Each line must
//             read back exactly (a glob holding `, ` would not), or the generator refuses.
//   version   `rg --version`: its first line, its `features:` line and its PCRE2 line. Its simd lines
//             are rg's rule for the native's architecture (libexec/rg-types.cjs RG-VERSION-SIMD); the
//             generator refuses unless what quaude's rg prints for that architecture is EXACTLY what
//             the native printed (on x86_64 but for the runtime line, which reads the CPU: the rule's
//             named exemption), so the rule is checked against every native it is run with.
// Exit status: 0 written / fresh, 1 --check found the region stale, 2 a refusal.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { providerArchOf } = require('../libexec/extract-claude-js.cjs');

const REPO = path.resolve(__dirname, '..');
const TARGET = path.join(REPO, 'libexec', 'rg-types.cjs');
const BEGIN = '// BEGIN GENERATED rg-types-data';
const END = '// END GENERATED rg-types-data';

function refuse(msg) { process.stderr.write(`gen-rg-types: ${msg}\n`); process.exit(2); }

function nativeRg(bin, args) {
  const r = spawnSync(bin, ['--no-config', ...args], { argv0: 'rg', encoding: 'utf8', timeout: 60000,
    env: { HOME: require('node:os').tmpdir(), PATH: '/usr/bin:/bin' } });
  if (r.error || r.status !== 0) refuse(`native rg ${args.join(' ')} failed (${r.error ? r.error.message : `exit ${r.status}`}): ${r.stderr || ''}`);
  return r.stdout;
}

// The native's architecture as node spells it, read from the binary's header by the ONE reader of
// a provider's arch (extract-claude-js providerArchOf: Mach-O, ELF and PE). A private reader here
// knew Mach-O and ELF only, so a win32 native (and node.exe) read 'unknown' (CI 44443821699).
function binaryArch(bin) {
  return providerArchOf(bin) || 'unknown';
}

function generate(bin) {
  const list = nativeRg(bin, ['--type-list']);
  const types = [];
  for (const line of list.split('\n')) {
    if (!line) continue;
    const m = /^([^:\s]+): (.+)$/.exec(line);
    if (!m) refuse(`--type-list line ${JSON.stringify(line)} is not \`name: globs\``);
    const globs = m[2].split(', ');
    if (`${m[1]}: ${globs.join(', ')}` !== line) refuse(`--type-list line ${JSON.stringify(line)} does not read back`);
    types.push([m[1], globs]);
  }
  if (types.map(([n]) => n).join('\n') !== types.map(([n]) => n).sort().join('\n')) refuse('--type-list is not in name order');
  const long = nativeRg(bin, ['--version']);
  const lines = long.replace(/\n$/, '').split('\n');
  const head = lines[0];
  const features = (lines.find((l) => l.startsWith('features:')) || '').slice('features:'.length);
  const pcre2 = lines[lines.length - 1];
  if (!/^ripgrep /.test(head) || !features || !/^PCRE2 /.test(pcre2)) refuse(`--version is not rg's long version: ${JSON.stringify(long)}`);
  const data = { header: { rg: head, generator: 'scripts/gen-rg-types.cjs' }, version: { head, features, pcre2 }, types };
  return { data, long, arch: binaryArch(bin) };
}

function region(data) {
  return `${BEGIN}\n// rg's type table and version text, read from native's embedded rg (${data.header.rg}) by\n`
    + `// scripts/gen-rg-types.cjs. Do not edit; regenerate.\nconst RG_TYPES_DATA = ${JSON.stringify(data)};\n${END}`;
}

// The --check verdict: what in libexec/rg-types.cjs's generated region differs from native's regeneration,
// by name ([] when nothing does).
function staleness(current, regenerated) {
  if (current === regenerated) return [];
  const dataOf = (src) => { const m = /const RG_TYPES_DATA = (\{.*\});\n/.exec(src); try { return m ? JSON.parse(m[1]) : null; } catch { return null; } };
  const a = dataOf(current), b = dataOf(regenerated);
  if (!a || !b) return ['libexec/rg-types.cjs: the generated RG_TYPES_DATA region is missing or unreadable'];
  const moved = [];
  if (JSON.stringify(a.header) !== JSON.stringify(b.header)) moved.push('header');
  for (const k of ['head', 'features', 'pcre2']) if ((a.version || {})[k] !== (b.version || {})[k]) moved.push(`version.${k}`);
  const ta = new Map(a.types || []), tb = new Map(b.types || []);
  for (const n of new Set([...ta.keys(), ...tb.keys()])) {
    if (JSON.stringify(ta.get(n)) !== JSON.stringify(tb.get(n))) moved.push(`type ${n}`);
  }
  return [`libexec/rg-types.cjs's generated region differs from native's rg: ${moved.length ? moved.join(', ') : 'outside the data (layout)'}`];
}

function splice(src, data) {
  const a = src.indexOf(BEGIN), b = src.indexOf(END);
  if (a === -1 || b === -1 || b < a) refuse(`${TARGET} has no ${BEGIN} ... ${END} region`);
  return src.slice(0, a) + region(data) + src.slice(b + END.length);
}

function main() {
  const argv = process.argv.slice(2);
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--native') o.native = argv[++i];
    else if (argv[i] === '--check') o.check = true;
    else if (argv[i] === '--emit') o.emit = true;
  }
  if (!o.native) refuse('usage: gen-rg-types.cjs --native BIN [--check | --emit]');
  const { data, long, arch } = generate(o.native);
  const src = fs.readFileSync(TARGET, 'utf8');
  const next = splice(src, data);
  // RG-VERSION-SIMD, checked against this native: quaude's rg on its architecture prints what it printed.
  const m = { exports: {} };
  new Function('module', 'exports', 'require', '__dirname', next)(m, m.exports, require, path.dirname(TARGET));
  // On x86_64 the runtime line reads the CPU: RG-VERSION-SIMD's named exemption, so it alone is not compared.
  const exempt = (t) => (arch === 'x64' ? t.replace(/^simd\(runtime\):.*\n/m, '') : t);
  const ours = m.exports.versionText({ arch });
  if (exempt(ours) !== exempt(long)) refuse(`quaude's rg --version for ${arch} would be ${JSON.stringify(ours)}, native printed ${JSON.stringify(long)}`);
  if (m.exports.typeListText() !== nativeRg(o.native, ['--type-list'])) refuse('quaude\'s rg --type-list would not print what native printed');
  if (o.emit) { process.stdout.write(next); return; }
  process.stdout.write(`gen-rg-types: ${data.header.rg}: ${data.types.length} types (native ${arch})\n`);
  if (o.check) {
    const stale = staleness(src, next);
    if (stale.length) { process.stdout.write(`gen-rg-types: STALE: ${stale.join('; ')}\n`); process.exit(1); }
    process.stdout.write('gen-rg-types: fresh\n');
    return;
  }
  if (next !== src) fs.writeFileSync(TARGET, next);
  process.stdout.write(next !== src ? 'gen-rg-types: written\n' : 'gen-rg-types: unchanged\n');
}

if (require.main === module) main();
module.exports = { staleness, binaryArch };
