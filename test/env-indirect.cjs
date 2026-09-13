'use strict';
// The INDIRECT half of the env-read corpus — the half test/env-inventory.cjs is
// structurally blind to, and the reason seven shipped names carried no verdict for a
// whole phase.
//
// WHAT WENT WRONG. env-inventory.cjs's READ regex requires a LITERAL `CLODE_*` name
// adjacent to `env.` / `env[`. Shipped code does not always spell it that way:
//
//   libexec/host-provision.cjs:281   const ov = req.overrideEnv && env[req.overrideEnv];
//   libexec/node-shim/modules/tty.cjs  tjs.env[name]          (name from _ttyEnv('CLODE_TTY_…'))
//   scripts/upstream-release-notes.mjs env[REEXEC_SENTINEL]   (a const holding the name)
//
// Each of those reaches real, shipped `CLODE_*` names that the direct scan can never see.
// CLODE_SHA256 / CLODE_TAR / CLODE_GZIP / CLODE_UNZIP / CLODE_TTY_MOUSE / CLODE_TTY_FOCUS /
// CLODE_UPSTREAM_NOTES_REEXEC were all invisible; CLODE_ZSTD was in the table only by the
// accident of a SECOND, direct read in libexec/bun-graph.cjs. So the population was
// reported as 65 when it was 72, and the verdict ratchet could never fire for the seven —
// a gate that cannot fail, inside the instrument built to end exactly that class (see
// BACKLOG.md, "five instruments, one mistake"). This module is what makes the class
// un-missable: not by teaching the direct regex more shapes (there is always one more
// shape), but by requiring every COMPUTED env access in shipped code to be RECORDED.
//
// THE RULE. Scan libexec/ and scripts/ for `env[<expr>]` where <expr> is NOT a string
// literal. Every such FILE must appear in INDIRECT_SITES below. An entry either names the
// `CLODE_*` names that site can reach (folded into the inventory, so each needs a verdict)
// or declares itself KEY_AGNOSTIC — it reads whatever key its caller hands it and fixes no
// name of its own. A new indirect reader in an unrecorded file goes red naming the file
// and line; a recorded file that grows a new `CLODE_*` name goes red too, because
// `reaches` is cross-checked against every bare `'CLODE_*'` literal the file contains.
//
// SCOPE: shipped code only (libexec/, scripts/), the same dirs env-inventory.cjs tags
// `prod`. test/ is deliberately not scanned: a test-only indirect read needs no verdict,
// and the suite is full of `env[k]` loops whose noise would buy nothing.
const fs = require('node:fs');
const path = require('node:path');
const { stripLineComments } = require('./source-scan.cjs');

const REPO = path.resolve(__dirname, '..');

// `env[...]` / `process.env[...]` / `tjs.env[...]` with a COMPUTED key. The negative
// lookahead on a quote is the whole point: a string-literal key is what env-inventory.cjs
// already sees, and re-reporting it here would bury the sites that matter.
const INDIRECT = /(?:(?:process|tjs)\s*\.\s*)?\benv(?:ironment)?\s*\[\s*(?!['"`])([^\]\n]{1,120}?)\s*\]/g;

// A BARE name and nothing else. `'CLODE_TAR'` matches; the install hint
// `'install tar (or gtar/bsdtar), or set CLODE_TAR. …'` does not — prose that MENTIONS a
// name is not a read of it, and pulling sentences into the verdict table would make the
// table's `because` fields worth less, not more.
const BARE_NAME = /(['"`])(CLODE_[A-Z0-9_]+)\1/g;

const KEY_AGNOSTIC = 'key-agnostic';

// INDIRECT_SITES — one entry per shipped FILE that reads env by a computed key.
//
// Keyed by file rather than by line so an unrelated edit above the site does not churn
// this table; the NAMES are what carry meaning, and they are cross-checked against the
// file's own literals (see indirectLiteralAudit) so an entry cannot silently go stale.
//
// `reaches`   the CLODE_* names this site can actually resolve to. These are folded into
//             the inventory as PROD reads of this file, so each one needs a verdict in
//             test/env-verdicts.cjs like any directly-read name.
// `notEnv`    bare CLODE_* literals in the same file that are NOT environment variables
//             (an Error `code`, a cmake option). Each needs its own reason; this is the
//             one place a human gets to say "that literal is not a knob", and saying it
//             is cheaper than letting the audit be loose enough not to ask.
const INDIRECT_SITES = [
  {
    file: 'libexec/bun-shim.cjs',
    reaches: ['CLODE_BFS', 'CLODE_UGREP'],
    because: "warnAppletSkew reads `process.env[known.env]`, where `known` is a CLODE_SHADOWS "
      + 'row and `.env` is that applet\'s override variable — the same names the direct scan '
      + 'already sees elsewhere in this file, reached here through the table.',
    notEnv: {
      CLODE_RG_UNTRANSLATABLE: 'an Error `code` on RgTranslateError, not a variable',
      CLODE_YAML_MISSING: 'an Error `code` thrown when the yaml dep is absent, not a variable',
    },
  },
  {
    file: 'libexec/host-provision.cjs',
    reaches: ['CLODE_SHA256', 'CLODE_TAR', 'CLODE_GZIP', 'CLODE_UNZIP', 'CLODE_ZSTD'],
    because: 'candidateList()/provision() read `env[req.overrideEnv]`, where req is a REGISTRY '
      + "row and `overrideEnv` is that host tool's override variable. THE ORIGINAL BLIND SPOT: "
      + 'four of these five had no verdict at all, and the fifth (CLODE_ZSTD) only had one '
      + 'because libexec/bun-graph.cjs happens to read it directly as well.',
  },
  {
    file: 'libexec/node-shim/modules/tty.cjs',
    reaches: ['CLODE_TTY_MOUSE', 'CLODE_TTY_FOCUS'],
    because: '_ttyEnv(name) reads `tjs.env[name]` for the two mouse/focus tracking opt-ins its '
      + 'own comment documents. Read INSIDE a built quaude, by the shim, at runtime.',
  },
  {
    file: 'scripts/build-tjs.mjs',
    reaches: ['CLODE_TJS_WASM', 'CLODE_TJS_MIMALLOC', 'CLODE_TJS_FFI'],
    because: '_tjsKnob(env, onByDefault) reads `process.env[env]` for the three on/off engine '
      + 'compile knobs it is called with. Already in the verdict table via other direct reads '
      + "in the same file; recorded here so the SITE is accounted for, not just the names.",
    notEnv: {
      CLODE_ATOMIC_SHIM: 'a cmake option name (`-DCLODE_ATOMIC_SHIM=ON`) injected into tjs\'s '
        + 'CMakeLists, not an environment variable — the env knob for it is CLODE_TJS_ATOMIC_SHIM',
    },
  },
  {
    file: 'scripts/upstream-release-notes.mjs',
    reaches: ['CLODE_UPSTREAM_NOTES_REEXEC'],
    because: 'proxyReexecEnv() reads `env[REEXEC_SENTINEL]`, a module const holding the name.',
  },
  {
    file: 'libexec/node-shim/modules/process.cjs',
    reaches: KEY_AGNOSTIC,
    because: "the process.env Proxy's get/set/deleteProperty traps forward EVERY key to "
      + 'tjs.env. It is the shim\'s implementation of process.env itself, so it reaches every '
      + 'name any program reads and fixes none of its own — a verdict here would be a verdict '
      + 'about "all environment variables".',
  },
  {
    file: 'libexec/target-env.cjs',
    reaches: KEY_AGNOSTIC,
    because: 'setIfUnset(env, name, value) is a `: "${VAR:=value}"` helper; the names come from '
      + 'shapeTargetEnv\'s callers and are not CLODE_* knobs this file reads for itself.',
  },
  {
    file: 'scripts/lib/npm-cli.cjs',
    reaches: KEY_AGNOSTIC,
    because: "envWithRealNodeOnPath reads `env[key]` where key is whichever casing of PATH the "
      + 'inherited environment actually used (Windows may spell it `Path`). Not a CLODE_* read '
      + 'at all.',
  },
];

// Every computed env access in shipped code: { file (posix-rel), line, key, text }.
// Repo-relative paths are POSIX ALWAYS — every backslash replaced, not path.sep, for the
// reason env-inventory.cjs spells out at its own call site.
function findIndirectEnvSites() {
  const out = [];
  for (const dir of ['libexec', 'scripts']) {
    const abs = path.join(REPO, dir);
    if (!fs.existsSync(abs)) continue;
    for (const f of walk(abs, [])) {
      if (!/\.(?:c|m)?js$/.test(f)) continue;
      let src; try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
      const rel = path.relative(REPO, f).split('\\').join('/');
      const lines = stripLineComments(src).split('\n');
      lines.forEach((line, i) => {
        INDIRECT.lastIndex = 0;
        let m;
        while ((m = INDIRECT.exec(line))) out.push({ file: rel, line: i + 1, key: m[1], text: line.trim() });
      });
    }
  }
  return out;
}

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

// Every bare 'CLODE_*' literal in a recorded file, so `reaches` cannot go stale: a name
// that appears in the file but in neither `reaches` nor `notEnv` is an unaccounted knob.
function indirectLiteralAudit() {
  const findings = [];
  for (const site of INDIRECT_SITES) {
    const abs = path.join(REPO, site.file);
    let src; try { src = fs.readFileSync(abs, 'utf8'); } catch { findings.push({ site: site.file, missingFile: true }); continue; }
    const seen = new Set();
    for (const m of stripLineComments(src).matchAll(BARE_NAME)) seen.add(m[2]);
    const reaches = site.reaches === KEY_AGNOSTIC ? [] : site.reaches;
    for (const name of [...seen].sort()) {
      if (reaches.includes(name)) continue;
      if (site.notEnv && Object.prototype.hasOwnProperty.call(site.notEnv, name)) continue;
      findings.push({ site: site.file, name });
    }
  }
  return findings;
}

// name -> [file, …] for the names reached indirectly. env-inventory.cjs folds these in as
// prod reads so they carry verdicts exactly like a directly-read name.
function indirectReads() {
  const m = new Map();
  for (const site of INDIRECT_SITES) {
    if (site.reaches === KEY_AGNOSTIC) continue;
    for (const name of site.reaches) {
      if (!m.has(name)) m.set(name, []);
      if (!m.get(name).includes(site.file)) m.get(name).push(site.file);
    }
  }
  return m;
}

module.exports = { INDIRECT_SITES, KEY_AGNOSTIC, findIndirectEnvSites, indirectLiteralAudit, indirectReads, REPO };
