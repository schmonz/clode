'use strict';
// worktrees-proof.cjs — run.mjs's tree gate excludes .claude/worktrees (other agents' git
// worktrees, written by their owners while the suite runs). The exclusion holds only while
// this proof does, and it is checked TWICE: before the suite (the allow-list entry's
// provenBy) and after it (run.mjs compares the two). An exclusion proven only before the run
// would hide anything the suite ITSELF creates there (EnterWorktree makes
// .claude/worktrees/<name>, and every-tool Phase A drives the worktree tools).
//
// PURE given its inputs: { names, lstat, realpath, porcelain, root } -> { proven, names, findings, notes }.
//  - names:     the entry names under the directory (readdir).
//  - lstat:     name -> { isSymbolicLink(), isDirectory() } (throws when gone).
//  - realpath:  absolute path -> real path (throws when gone).
//  - porcelain: `git worktree list --porcelain` output.
//  - root:      the checkout itself (realpath'd), which is the MAIN worktree and is never a
//               proof for an entry: a symlink back to ROOT, or a copy that resolves there,
//               would otherwise pass as "a registered worktree".
const path = require('node:path');

function registeredWorktrees(porcelain, realpath, root) {
  const listed = new Set();
  const notes = [];
  let cur = null;
  const flush = () => {
    if (!cur) return;
    let real = null;
    try { real = realpath(cur.path); } catch { real = null; }
    if (real === null) {
      // A registered worktree whose directory is gone (git calls it prunable). It proves
      // nothing, and it is not fatal: it is named, and only an entry that needed it fails.
      notes.push(`registered worktree ${cur.path} has no directory${cur.prunable ? ' (prunable)' : ''}; it proves nothing`);
    } else if (real !== root) listed.add(real);
    cur = null;
  };
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) { flush(); cur = { path: line.slice('worktree '.length), prunable: false }; }
    else if (cur && line.startsWith('prunable')) cur.prunable = true;
  }
  flush();
  return { listed, notes };
}

function proveWorktrees({ dir, names, lstat, realpath, porcelain, root }) {
  const { listed, notes } = registeredWorktrees(porcelain, realpath, root);
  const findings = [];
  for (const n of names) {
    if (n.startsWith('._')) continue; // the AppleDouble sidecar an NFS share plants beside each entry
    const abs = path.join(dir, n);
    let st;
    try { st = lstat(abs); } catch { findings.push(`${n}: gone between readdir and lstat`); continue; }
    if (st.isSymbolicLink()) { findings.push(`${n}: a symlink, not a worktree directory`); continue; }
    if (!st.isDirectory()) { findings.push(`${n}: not a directory`); continue; }
    let real;
    try { real = realpath(abs); } catch { findings.push(`${n}: cannot be resolved`); continue; }
    if (real === root) { findings.push(`${n}: resolves to the checkout itself`); continue; }
    if (!listed.has(real)) findings.push(`${n}: not a worktree git registers for this repository`);
  }
  const real = names.filter((n) => !n.startsWith('._'));
  if (!real.length) findings.push('no worktree here: nothing to exclude');
  return { proven: findings.length === 0, names: [...names].sort(), findings, notes };
}

// The real filesystem and git, for run.mjs.
function proveWorktreesOnDisk(root) {
  const fs = require('node:fs');
  const dir = path.join(root, '.claude', 'worktrees');
  const realRoot = fs.realpathSync(root);
  let names;
  try { names = fs.readdirSync(dir); } catch { return { proven: false, names: [], findings: [`${dir}: absent`], notes: [] }; }
  const porcelain = require('node:child_process')
    .execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: root, encoding: 'utf8' });
  return proveWorktrees({ dir, names, lstat: (p) => fs.lstatSync(p), realpath: (p) => fs.realpathSync(p), porcelain, root: realRoot });
}

// Before vs after: the exclusion stands only if the proof still holds AND the set of entries
// is the one proven before the suite. A name the suite added (or removed) is a finding.
function compareRuns(before, after) {
  const findings = [...after.findings.map((f) => `after the suite: ${f}`)];
  const b = new Set(before.names);
  const a = new Set(after.names);
  for (const n of a) if (!b.has(n)) findings.push(`created during the suite: .claude/worktrees/${n}`);
  for (const n of b) if (!a.has(n)) findings.push(`deleted during the suite: .claude/worktrees/${n}`);
  return findings;
}

module.exports = { proveWorktrees, proveWorktreesOnDisk, compareRuns, registeredWorktrees };
