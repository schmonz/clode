#!/usr/bin/env node
'use strict';
// The macOS floor gate's verdict: does a Mach-O (as `otool -l` prints it) carry exactly
// the pinned deployment floor, in the load command that floor's dyld reads?
//
//   floor <  10.14  -> LC_VERSION_MIN_MACOSX `version` == floor, and NO LC_BUILD_VERSION
//                      (pre-10.14 dyld does not understand it: 10.4 ppc/i386, 10.6 x64);
//   floor >= 10.14  -> LC_BUILD_VERSION `minos` == floor (arm64 only ever carries this).
//
// WHY A SCRIPT. The gate was inline bash in .github/actions/build-leg/action.yml with no
// control: nothing proved it could fail. And the case it exists for is real — the arm64
// slice of the published clode-0.20260831.1-macos carries minos 14.0 under an 11.0 floor
// label, because the leg never pinned a deployment target (fixed in a0a2d4e). The rows in
// test/build-gates/macho-floor-gates.test.cjs are real `otool -l` captures, that release's among them.

const fs = require('node:fs');

// Every LC_BUILD_VERSION minos and LC_VERSION_MIN_MACOSX version in `otool -l` text.
function parseOtoolLoadCommands(text) {
  const out = { buildVersion: [], versionMin: [], loadCommands: 0 };
  let cur = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (/^Load command \d+$/.test(line)) { out.loadCommands++; cur = null; continue; }
    const cmd = /^cmd (\S+)$/.exec(line);
    if (cmd) { cur = cmd[1]; continue; }
    if (cur === 'LC_BUILD_VERSION') {
      const m = /^minos (\S+)$/.exec(line);
      if (m) { out.buildVersion.push(m[1]); cur = null; }
    } else if (cur === 'LC_VERSION_MIN_MACOSX') {
      const m = /^version (\S+)$/.exec(line);
      if (m) { out.versionMin.push(m[1]); cur = null; }
    }
  }
  return out;
}

function usesBuildVersion(floor) {
  const m = /^(\d+)\.(\d+)/.exec(String(floor));
  if (!m) throw new Error(`floor '${floor}' is not <major>.<minor>`);
  return Number(m[1]) * 100 + Number(m[2]) >= 1014;
}

// [] when `otoolText` carries exactly `floor` where that floor's dyld looks; else reasons.
function floorFindings(otoolText, floor) {
  const p = parseOtoolLoadCommands(otoolText);
  if (p.loadCommands === 0) return ['no load commands in the otool -l output (not a Mach-O, or otool failed)'];
  const findings = [];
  if (usesBuildVersion(floor)) {
    if (p.buildVersion.length === 0) findings.push(`no LC_BUILD_VERSION; a ${floor} floor is carried as its minos`);
    for (const v of p.buildVersion) if (v !== floor) findings.push(`LC_BUILD_VERSION minos ${v}, want ${floor}`);
  } else {
    if (p.buildVersion.length) findings.push(`LC_BUILD_VERSION present (minos ${p.buildVersion.join(', ')}) — pre-10.14 dyld needs LC_VERSION_MIN_MACOSX for a ${floor} floor`);
    if (p.versionMin.length === 0) findings.push(`no LC_VERSION_MIN_MACOSX; a ${floor} floor must carry one`);
    for (const v of p.versionMin) if (v !== floor) findings.push(`LC_VERSION_MIN_MACOSX ${v}, want ${floor}`);
  }
  return findings;
}

module.exports = { parseOtoolLoadCommands, usesBuildVersion, floorFindings };

if (require.main === module) {
  const [cmd, floor, file] = process.argv.slice(2);
  if (cmd !== 'check' || !floor || !file) {
    process.stderr.write('usage: macho-floor.cjs check <floor> <otool-l-output-file>\n');
    process.exit(2);
  }
  const why = floorFindings(fs.readFileSync(file, 'utf8'), floor);
  if (why.length) {
    for (const w of why) process.stderr.write(`ERROR: floor gate: ${w}\n`);
    process.exit(1);
  }
  const p = parseOtoolLoadCommands(fs.readFileSync(file, 'utf8'));
  process.stdout.write(`floor gate ok: ${usesBuildVersion(floor) ? `LC_BUILD_VERSION minos ${p.buildVersion[0]}` : `LC_VERSION_MIN_MACOSX ${p.versionMin[0]}`}\n`);
}
