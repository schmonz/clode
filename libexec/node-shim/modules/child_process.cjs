'use strict';
// node:child_process — LOAD-TIME stub only. bun-shim.cjs's top-level body
// probes cp.execFile/execFileSync/spawn/spawnSync/exec/execSync with a plain
// property GET (`const orig = cp[m]; if (typeof orig !== 'function') continue;`)
// to monkeypatch them. Because this module previously had no .cjs file, the
// loader's absent-module wallProxy walled EVERY property GET (not just calls),
// so that probe itself threw at load time -- a genuine load-time touch beyond
// the v8/util surface this task's brief anticipated.
//
// A real, working spawn/exec surface (over tjs.spawn) is deliberately NOT
// implemented here -- that's the Task-5 wall-walk's job, test-first, once a
// bundle code path actually CALLS one of these. Exporting a plain object with
// no such keys makes the GET return `undefined` (Node's own missing-prop
// idiom for a real, if incomplete, module) instead of a branded wall, so
// bun-shim's `typeof orig !== 'function'` check just skips patching -- and a
// later CALL surfaces as a bare `cp.spawn is not a function` TypeError, the
// exact signal the wall-walk converts into a real implementation.
module.exports = {};
