'use strict';
// EVERY PLATFORM'S CARVE OF ONE UPSTREAM VERSION, measured for what the shim must answer. The Bun.ant surface is
// per platform (memory: "Bun.ant surface is per-platform"): 2.1.332's win32 carves alone reach windowsPolicyValue,
// so the build gate, which carves the one provider its runner has, could only see it on Windows CI after a push. This
// asks every platform upstream publishes for a version, before anyone bumps the pin to it (scripts/every-carve.mjs;
// upstream-drift.yml runs it daily for `next`).
const { bunAntMembers, unaccountedBunAnt } = require('../../libexec/inspect-claude-bundle.cjs');

// results: [{ platform, text } | { platform, error }] -> { ok, lines, unaccounted }
// A platform that could not be measured is NOT clean: it is reported, and fails the verdict, because "nothing found"
// from a download that never happened is the green this exists to remove.
function everyCarveVerdict(results, provided) {
  const lines = [];
  const unaccounted = {};
  let ok = results.length > 0;
  if (!ok) lines.push('no platform measured (an empty manifest?)');
  for (const r of results) {
    if (r.error) { ok = false; lines.push(`${r.platform}: NOT MEASURED: ${r.error}`); continue; }
    const members = bunAntMembers(r.text);
    const missing = unaccountedBunAnt(members, provided);
    if (missing.length) { ok = false; unaccounted[r.platform] = missing; }
    lines.push(`${r.platform}: ${members.length} Bun.ant member(s)${missing.length ? `; UNACCOUNTED: ${missing.join(', ')}` : ', all accounted for'}`);
  }
  return { ok, lines, unaccounted };
}

module.exports = { everyCarveVerdict };
