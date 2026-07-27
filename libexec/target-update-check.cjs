'use strict';
// Target-side "is a newer Claude Code available?" check. Runs INSIDE a built
// target (quaude/naude) with NO clode builder present — a pure network GET +
// semver compare, no install, no rebuild. The target's patched in-app updater
// (extract-claude-js.cjs) calls this INSTEAD of trying to update. resolveChannel/
// releasesBase mirror clode-update.cjs so a target checks the SAME channel
// `clode fetch` would. Dependency-free (fetch + injected semver) because it is
// fused as a target member, not run in the builder.

const DEFAULT_RELEASES = 'https://downloads.claude.ai/claude-code-releases';

// The channel claude auto-updates from: explicit arg > CLODE_UPDATE_CHANNEL env >
// 'latest'. (The caller resolves the autoUpdatesChannel setting into the env or
// the explicit arg — this module does not read settings files.)
function resolveChannel(explicit, env) {
  if (explicit) return String(explicit).trim();
  const e = env && env.CLODE_UPDATE_CHANNEL;
  if (e) return String(e).trim();
  return 'latest';
}

function releasesBase(env) {
  return (env && env.CLODE_RELEASES_URL) || DEFAULT_RELEASES;
}

// How long a channel GET may take before it fails fast to 'unknown'. This check
// runs inside the diagnostics builder that /status and `claude doctor` await, so an
// offline/slow-DNS default-'latest' lookup must NOT stall that screen for undici's
// ~300s default — it degrades to the "couldn't check" note in a few seconds.
const FETCH_TIMEOUT_MS = 3000;

// Build the { signal } passed to fetch: a short abort timeout when the runtime
// supports AbortSignal.timeout (Node >=17.3, and tjs's shim). If it's absent we
// simply pass no signal — the check still works, it just isn't time-bounded.
function timeoutSignal(ms) {
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      return AbortSignal.timeout(ms);
    }
  } catch { /* fall through to no-signal */ }
  return undefined;
}

// Resolve the latest version string for a channel. A numeric channel ("2.1.5")
// IS the version (no fetch); otherwise GET <base>/<channel> and trim CR/LF, bounded
// by FETCH_TIMEOUT_MS. Throws on any fetch/HTTP failure — including an abort/timeout
// — so checkUpdate maps it to 'unknown' (the "couldn't check" note).
async function resolveLatest(channel, { env = {}, fetchImpl = fetch, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const chan = resolveChannel(channel, env);
  if (/^\d/.test(chan)) return chan;
  const signal = timeoutSignal(timeoutMs);
  const res = await fetchImpl(`${releasesBase(env)}/${chan}`, signal ? { signal } : {});
  if (!res || !res.ok) throw new Error(`channel ${chan}: HTTP ${res && res.status}`);
  return (await res.text()).replace(/[\r\n]+/g, '').trim();
}

// Three-state result. current = the running bundle's VERSION. semverOrder is
// Bun.semver.order (npm semver compare): >0 means latest is newer than current.
// Any failure (fetch, empty body, unparseable version) collapses to 'unknown'.
async function checkUpdate({ current, channel, env = {}, fetchImpl = fetch, semverOrder, timeoutMs }) {
  let latest;
  try { latest = await resolveLatest(channel, { env, fetchImpl, timeoutMs }); }
  catch { return { state: 'unknown', latest: null, current }; }
  if (!latest) return { state: 'unknown', latest: null, current };
  let newer;
  try { newer = semverOrder(latest, current) > 0; }
  catch { return { state: 'unknown', latest: null, current }; }
  return { state: newer ? 'newer' : 'current', latest, current };
}

module.exports = { resolveChannel, releasesBase, resolveLatest, checkUpdate };
