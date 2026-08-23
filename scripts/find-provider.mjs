#!/usr/bin/env node
// Locate the Bun-packaged claude provider binary that CI oracles diff against.
//
// WHY THIS IS A SCRIPT AND NOT A find(1) ONE-LINER. It was this, at six sites:
//
//   PROV="$(find "$(npm root -g)/@anthropic-ai/claude-code" -type f -name claude \
//           -size +20M 2>/dev/null | head -1)"
//   if [ -z "$PROV" ]; then echo "ERROR: no Bun provider found" >&2; exit 1; fi
//
// Under the steps' `set -euo pipefail`, if that directory does not exist find
// exits non-zero, pipefail promotes it past `head`, and set -e kills the step
// AT THE ASSIGNMENT -- so the "ERROR" line below it never runs and 2>/dev/null
// has already eaten the only clue. That is exactly what happened to
// node-shim-oracle in run 32622574608 once it moved into an alpine container:
// the step printed nothing at all after "tjs alive" and exited 1. A gate that
// fails without saying anything is the failure mode this repo exists to end
// ("a skipped oracle is not a pass").
//
// It also only ever looked INSIDE the wrapper package. npm installs the real
// binary as a per-platform optional dependency -- on darwin it lands at
// .../@anthropic-ai/claude-code/node_modules/@anthropic-ai/claude-code-darwin-arm64/claude
// (nested, which is why the find worked there), but the layout is npm's choice,
// not a contract: a sibling install under the global root is equally valid and
// the old command could not see it.
//
// So: search the whole global root, accept either layout, and when nothing is
// found say WHAT WAS LOOKED AT rather than a bare sentence.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const MIN_BYTES = 20 * 1024 * 1024;   // the carved JS bundle is tens of MB; scripts are not
const NAMES = new Set(['claude', 'claude.exe']);

// Launch npm's OWN JS CLI under THIS node rather than the `npm` launcher.
// execFileSync('npm', ...) is ENOENT on Windows, where npm is npm.cmd: libuv's
// path_search_walk_ext only tries .com and .exe, and node's child_process has no
// .bat/.cmd handling. That is precisely how this failed on windows-latest —
// "could not run `npm root -g`: spawnSync npm ENOENT" — and scripts/lib/npm-cli.cjs
// already exists to solve it, with a header saying so.
function globalRoot() {
  const require = createRequire(import.meta.url);
  const { npmCliPath } = require('./lib/npm-cli.cjs');
  try {
    const cli = npmCliPath({ prefix: 'find-provider' });
    return execFileSync(process.execPath, [cli, 'root', '-g'], { encoding: 'utf8' }).trim();
  } catch (e) {
    fail(`could not ask npm for its global root: ${e.message}`);
  }
}

function walk(dir, out = [], depth = 0) {
  if (depth > 6) return out;                 // deep enough for nested node_modules
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out, depth + 1);
    else if (e.isFile() && NAMES.has(e.name)) {
      let size = 0;
      try { size = fs.statSync(p).size; } catch { continue; }
      out.push({ path: p, size });
    }
  }
  return out;
}

function fail(msg, extra = []) {
  process.stderr.write(`find-provider: ${msg}\n`);
  for (const line of extra) process.stderr.write(`  ${line}\n`);
  process.exit(1);
}

const root = globalRoot();
if (!fs.existsSync(root)) {
  fail(`the npm global root does not exist: ${root}`,
    ['`npm i -g @anthropic-ai/claude-code` must run in the SAME environment as this step',
     '(a container job and its host do not share a global prefix).']);
}

// PLATFORM FIRST, size second. The wrapper ships bin/claude.exe alongside the
// per-platform package, and it is BIGGER than the darwin binary -- so a plain
// "largest match wins" hands a Windows PE to a darwin oracle. (Measured: this
// script's own first version did exactly that.) Rank by how well the path
// matches THIS platform, and only break ties by size.
const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : process.arch;
const isMusl = process.platform === 'linux'
  && !process.report.getReport().header.glibcVersionRuntime;
const wantPkg = `claude-code-${process.platform}-${arch}${isMusl ? '-musl' : ''}`;
const wantName = process.platform === 'win32' ? 'claude.exe' : 'claude';

function rank(f) {
  const base = path.basename(f.path);
  if (f.path.includes(wantPkg) && base === wantName) return 0;   // the platform package
  if (f.path.includes(wantPkg)) return 1;
  if (base === wantName) return 2;                               // right kind of file
  return 3;                                                      // wrong platform entirely
}

const found = walk(root).sort((a, b) => rank(a) - rank(b) || b.size - a.size);
const big = found.filter((f) => f.size >= MIN_BYTES && rank(f) < 3);

if (!big.length) {
  const scope = path.join(root, '@anthropic-ai');
  let siblings = [];
  try { siblings = fs.readdirSync(scope); } catch { /* scope absent */ }
  fail('no Bun provider binary found.', [
    `npm root -g:        ${root}`,
    `@anthropic-ai/:     ${siblings.length ? siblings.join(', ') : '(absent)'}`,
    `wanted:             ${wantPkg} / ${wantName}${isMusl ? '  (musl detected)' : ''}`,
    `candidates by name: ${found.length ? found.map((f) => `${f.path} (${f.size}B, rank ${rank(f)})`).join('; ') : '(none)'}`,
    '',
    'The binary ships as a per-platform OPTIONAL dependency, so a libc or arch',
    'npm does not resolve for leaves the wrapper installed with nothing inside it.',
    'On musl that means @anthropic-ai/claude-code-linux-<arch>-musl; if it is',
    'missing above, install it explicitly rather than assuming npm picked it.',
  ]);
}

process.stdout.write(big[0].path + '\n');
