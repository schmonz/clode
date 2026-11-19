'use strict';
// CLODE_ENGINE_FLOOR_LOG=<file> -- a record of every time code ran on an engine BELOW the floor it
// needed, for a caller that must know even when the program carried on.
//
// WHY. An engine without a binding HEAD expects is met in two ways, and neither is loud enough on
// its own. node-shim refuses a Stats field the engine cannot report (ERR_CLODE_ENGINE_FLOOR), but
// a refusal is an exception and `try { m = statSync(p).mtimeMs } catch {}` swallows it and takes
// the wrong branch in silence. And some code has a deliberate fallback (rg-native's strerror), so
// there is nothing to throw at all. The build host -- the LAST release's engine, which
// scripts/bootstrap-engine.sh accepts on the build-host floor (scripts/engine-api-floor.cjs) -- is
// exactly where both can happen, and .github/actions/build-leg sets this for the engine-phase steps
// and fails the leg if the file is not empty. The tests' stale stand-in uses the same knob.
//
// EVERY occurrence is appended (not just the first), each with its stack, so the log names every
// read that needs re-measuring. Unset: nothing is written, and the cost is one env read. Under node
// (no __tjs_fs_sync) there is no engine floor, so this is a no-op.
function engineFloorLog(line) {
  const env = (globalThis.tjs && globalThis.tjs.env) || {};
  const file = env.CLODE_ENGINE_FLOOR_LOG;
  const fss = globalThis.__tjs_fs_sync;
  if (!file || !fss) return;
  try {
    const fd = fss.open(file, 'a');
    try { fss.write(fd, new TextEncoder().encode(`${line}\n${new Error('engine-floor').stack}\n`).buffer, -1); }
    finally { fss.close(fd); }
  } catch (e) {
    // Never silently: a caller gating on an EMPTY log would read a failed write as a clean run.
    try { console.error(`engine-floor-log: could not append to ${file} (${(e && e.code) || e}): ${line}`); } catch { /* nothing left */ }
  }
}

module.exports = { engineFloorLog };
