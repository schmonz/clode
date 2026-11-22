'use strict';
// probeEnv(homeDir): the MINIMAL environment scripts/mcp-transport-probe.mjs runs its client in, not ...process.env.
// The client runs with --debug --debug-to-stderr and the probe's FAIL path prints its stderr, so a developer's
// ANTHROPIC_*/CLAUDE_* token or OAuth state must never reach it. Only what a process needs to start and reach
// localhost, the temp dirs, and a throwaway home on EVERY platform (HOME alone was a no-op on Windows, where the
// profile is USERPROFILE).
//
// THE CASE SPELLINGS ARE LOAD-BEARING. node's process.env is case-insensitive on Windows, so each read below finds the
// variable whatever its spelling; but the object built here is passed to the child as-is, and the child sees exactly
// these keys. The first version copied this same list through a computed process.env[k] and carried every spelling
// (PATH and Path, SystemRoot and SYSTEMROOT, windir and WINDIR); a rewrite to one spelling each made both Windows SSE
// smokes connect to nothing (CI 45005386065: "early start-up round for 1 configured server(s)" and then ETIMEDOUT),
// where the copy had passed (CI 44986483868). Literal names, because a computed env read must be a recorded indirect
// site (test/env-indirect.cjs); test/probe-env.test.cjs holds this list to the copy's.
function probeEnv(homeDir, fs = require('node:fs'), path = require('node:path')) {
  const cfgDir = path.join(homeDir, '.claude');
  fs.mkdirSync(cfgDir, { recursive: true });
  const e = process.env;
  const carried = {
    PATH: e.PATH, Path: e.Path,
    SystemRoot: e.SystemRoot, SYSTEMROOT: e.SYSTEMROOT,
    windir: e.windir, WINDIR: e.WINDIR,
    ComSpec: e.ComSpec, PATHEXT: e.PATHEXT, SystemDrive: e.SystemDrive,
    TEMP: e.TEMP, TMP: e.TMP, TMPDIR: e.TMPDIR,
    LANG: e.LANG, LC_ALL: e.LC_ALL, TERM: e.TERM,
  };
  // As the copy did: a variable that is not set is not passed at all.
  for (const k of Object.keys(carried)) if (carried[k] === undefined) delete carried[k];
  return { ...carried, HOME: homeDir, USERPROFILE: homeDir, CLAUDE_CONFIG_DIR: cfgDir, ANTHROPIC_API_KEY: 'sk-probe-notreal' };
}

module.exports = { probeEnv };
