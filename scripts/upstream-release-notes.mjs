#!/usr/bin/env node
// WHAT UPSTREAM SAID between two Claude Code versions — printed as a LEAD, and
// never as an explanation.
//
// Usage: node scripts/upstream-release-notes.mjs --from 2.1.241 [--to 2.1.243] [--json]
//
// WHY THIS EXISTS. Upstream has now broken clode twice with no change in this
// repo — os.constants.errno in 2.1.238, and the Bun code-splitting repackage in
// 2.1.243 that killed `clode build` outright on every platform. Both times we
// found out by accident, and both times a PUBLIC CHANGELOG had already named the
// area before we started byte-diffing 340MB binaries. On 2.1.243 the entries
// about install size and on-demand code loading were sitting in
// anthropics/claude-code's CHANGELOG.md the whole time; nobody looked, because
// nothing in the failing job ever pointed there. This is that pointer: cheap
// context, printed at the moment the question actually gets asked.
//
// THE ONE THING THIS TOOL MUST NEVER DO: read as a diagnosis.
//
// The 2.1.243 changelog said the binary "is now zstd-compressed (about 75 MB
// instead of 340 MB on Linux x64)". That is TRUE — of the native installer's
// download channel. It is IRRELEVANT to the npm artifact clode carves, which was
// uncompressed in BOTH versions and GREW from 325,055,632 to 361,529,696 bytes.
// The line was passed on as a hypothesis and sent an investigation down the
// compression path for hours; the actual cause was Bun code splitting (1 CJS
// module -> 1391 ESM chunks, see BACKLOG.md "2.1.243"). A changelog entry can be
// entirely true and entirely irrelevant to us, because upstream is describing
// THEIR product and their channels, not our carve.
//
// So the framing is load-bearing, more than the code is. Every rendering path
// here states, in the output and not merely in a comment, that these are
// upstream's words about upstream's product, unverified against our artifact,
// and are places to LOOK. If you edit this file, keep that header text at least
// as strong as you found it. Softening it to "here's what changed" would restore
// exactly the failure mode it was written to prevent.
//
// SECOND RULE: THIS MUST NEVER BECOME A SECOND THING TO DEBUG. It runs inside a
// job that is already failing. Network down, GitHub 503, HTML error page, a
// pruned changelog, a version we can't find — every one of those prints one
// honest line to stderr and EXITS 0. A diagnostic aid that converts a real red
// into a confusing red has made the incident worse, and a red that says
// "upstream-release-notes: fetch failed" teaches people to distrust the job that
// actually caught something. The ONLY nonzero exit is exit 64, a usage error in
// OUR OWN invocation (a missing --from), which is a bug in the caller, not a
// fact about the world.
//
// "No delta" IS AN ANSWER, and a useful one: it means upstream announced nothing
// between those versions, so whatever broke is probably not an upstream
// announcement — look at our own diff first. It gets its own line, never silence.
//
// PROXIES, the house way. This repo does not reimplement proxying (see
// libexec/bun-shim.cjs and libexec/target-env.cjs, which set NODE_USE_ENV_PROXY=1
// and delegate to Node). Node reads that option AT STARTUP — setting
// process.env.NODE_USE_ENV_PROXY from inside a running process is too late, and
// silently does nothing (verified on this box, node v26.3.0: with HTTPS_PROXY set
// and NODE_USE_ENV_PROXY=1 in the environment, fetch hits the proxy; assigning it
// at runtime, fetch goes direct). So when a proxy var is set and the option is
// not, we re-exec ourselves ONCE with it set, guarded by a sentinel so it can
// never loop, and fall through to a direct fetch if the re-exec cannot be spawned.
// That is delegation, still — just applied a moment earlier than a library could.
//
// Node builtins only, no dependencies. The pure parts (parseChangelog,
// selectRange, renderText, renderJson, parseArgs, proxyReexecEnv) are exported and
// characterized hermetically by test/upstream-release-notes.test.cjs against a
// fixture string; nothing in the default suite touches the network.
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const CHANGELOG_URL =
  'https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md';

// A failing job should not wait on a hung TLS handshake to learn something
// optional. Short, fixed, and deliberately not configurable.
const FETCH_TIMEOUT_MS = 20000;

// How many recent sections to show when the requested --from is not in the file.
const FALLBACK_COUNT = 5;

const REEXEC_SENTINEL = 'CLODE_UPSTREAM_NOTES_REEXEC';

// ---------------------------------------------------------------- pure parts

// CHANGELOG.md is `## <version>` sections, newest first, and we preserve THAT
// order rather than sorting: the file is upstream's own statement of sequence,
// and version strings are theirs to shape (a future 2.2.0-rc.1 must not be
// re-ordered by our idea of semver). A line that is `##` followed by anything is
// a section head; everything up to the next one is its body.
export function parseChangelog(text) {
  const src = typeof text === 'string' ? text : '';
  const lines = src.split(/\r?\n/);
  const sections = [];
  let cur = null;
  for (const line of lines) {
    const m = /^##[ \t]+(\S.*?)[ \t]*$/.exec(line);
    if (m) {
      cur = { version: m[1], body: [] };
      sections.push(cur);
    } else if (cur) {
      cur.body.push(line);
    }
  }
  return sections.map((s) => ({ version: s.version, body: s.body.join('\n').trim() }));
}

// Pick the entries strictly after `from` and through `to`, newest first.
//
// Every outcome is a NAMED status with a note, because each one means something
// different to whoever is staring at a red job, and "print nothing" is never the
// right answer to any of them.
//
//   delta          - the normal case: entries to go look at
//   no-delta       - upstream announced nothing in this range; a real answer
//   from-not-found - too old or pruned; newest FALLBACK_COUNT as context only
//   to-not-found   - the version we tested isn't in the changelog yet (or ever)
//   inverted       - --from is NEWER than --to; the caller has them backwards
//   no-sections    - the fetch returned something that is not a changelog
export function selectRange(sections, opts = {}) {
  const list = Array.isArray(sections) ? sections : [];
  const fallback = Number.isInteger(opts.fallbackCount) ? opts.fallbackCount : FALLBACK_COUNT;
  const from = opts.from;

  if (!list.length) {
    return {
      status: 'no-sections', from: from ?? null, to: opts.to ?? null, entries: [],
      note: 'the fetched document contains no `## <version>` sections — it is not a changelog '
        + '(an error page? a moved file?). Nothing to say about upstream.',
    };
  }

  const newest = list[0].version;
  const to = opts.to || newest;
  const idxOf = (v) => list.findIndex((s) => s.version === v);
  const iTo = idxOf(to);
  const iFrom = idxOf(from);

  if (iTo < 0) {
    return {
      status: 'to-not-found', from: from ?? null, to, entries: list.slice(0, fallback),
      note: `--to ${to} is not in the changelog (unreleased, or upstream renamed it). `
        + `Newest is ${newest}. Showing the newest ${Math.min(fallback, list.length)} `
        + 'sections as context only — the range you asked for could not be computed.',
    };
  }
  if (iFrom < 0) {
    return {
      status: 'from-not-found', from: from ?? null, to, entries: list.slice(0, fallback),
      note: `--from ${from} is not in the changelog (too old, or pruned upstream). `
        + `Newest is ${newest}. Showing the newest ${Math.min(fallback, list.length)} `
        + 'sections as context only — the range you asked for could not be computed.',
    };
  }
  if (iTo > iFrom) {
    return {
      status: 'inverted', from, to, entries: [],
      note: `--from ${from} is NEWER than --to ${to} in the changelog; the arguments look `
        + 'swapped. Nothing selected rather than guessing which you meant.',
    };
  }

  // Strictly after `from` (exclusive), through `to` (inclusive). File order is
  // newest-first, so that is [iTo, iFrom).
  const entries = list.slice(iTo, iFrom);
  if (!entries.length) {
    return {
      status: 'no-delta', from, to, entries: [],
      note: from === to
        ? `--from and --to are both ${to}: an empty range by construction.`
        : `upstream published no sections between ${from} and ${to}.`,
    };
  }
  return {
    status: 'delta', from, to, entries,
    note: `${entries.length} upstream release${entries.length === 1 ? '' : 's'} `
      + `after ${from}, through ${to}.`,
  };
}

// THE FRAMING. Read this before changing a word of it; the file header explains
// why it is the most important thing here.
const LEAD_NOT_DIAGNOSIS = [
  '  This is what UPSTREAM SAID about THEIR product. It is not a statement about',
  '  clode, and not one word of it has been checked against the artifact we carve.',
  '  Read it as a list of places to GO LOOK.',
  '',
  '  Why this warning is here (2026-08-24): 2.1.243 broke `clode build`, and its',
  '  changelog said the binary "is now zstd-compressed (about 75 MB instead of',
  '  340 MB)". True — of the native installer\'s download channel. The npm artifact',
  '  clode carves was uncompressed in both versions and GREW, 325MB -> 361MB.',
  '  Repeating that line as the cause cost an investigation the better part of a',
  '  day; the real change was Bun code splitting. An entry can be entirely true',
  '  and entirely irrelevant to us. Confirm every cause against the bundle itself.',
].join('\n');

const CONFIRM_IT_YOURSELF =
  'None of the above is evidence. Evidence is `node libexec/extract-claude-js.cjs\n'
  + '<binary> /tmp/cli.cjs` and `node scripts/upstream-drift-check.mjs <binary>` run\n'
  + 'against the actual bundle.';

export function renderText(sel, opts = {}) {
  const source = opts.source || CHANGELOG_URL;
  const out = [];

  if (sel.status === 'no-delta' || sel.status === 'inverted') {
    out.push(`upstream changelog: NO DELTA — ${sel.note}`);
    out.push(`source: ${source}`);
    if (sel.status === 'no-delta') {
      out.push('');
      out.push('That is a useful answer, not a failure: upstream announced nothing in this');
      out.push('range, so whatever broke is probably NOT an upstream announcement. Look at');
      out.push('our own diff, our environment, and the provider binary itself first.');
    }
    return out.join('\n') + '\n';
  }

  if (sel.status === 'no-sections') {
    out.push(`upstream changelog: UNREADABLE — ${sel.note}`);
    out.push(`source: ${source}`);
    return out.join('\n') + '\n';
  }

  const heading = sel.status === 'delta'
    ? `upstream changelog — a LEAD, not a diagnosis: after ${sel.from}, through ${sel.to}`
    : 'upstream changelog — a LEAD, not a diagnosis: CONTEXT ONLY';
  out.push(heading);
  out.push(`source: ${source}`);
  out.push(sel.note.split('\n').map((l) => `note:   ${l}`).join('\n'));
  out.push('');
  out.push(LEAD_NOT_DIAGNOSIS);
  out.push('');
  for (const e of sel.entries) {
    out.push(`## ${e.version}`);
    if (e.body) out.push(e.body);
    out.push('');
  }
  out.push(CONFIRM_IT_YOURSELF);
  return out.join('\n') + '\n';
}

// Machine consumption. `framing` travels WITH the data on purpose: anything that
// reprints these entries elsewhere (a job summary, an issue comment) should carry
// the warning along, not strip it off.
export function renderJson(sel, opts = {}) {
  return JSON.stringify({
    source: opts.source || CHANGELOG_URL,
    framing: 'LEAD_NOT_DIAGNOSIS: upstream\'s words about upstream\'s product, unverified '
      + 'against the artifact clode carves. Places to look, never a cause.',
    status: sel.status,
    from: sel.from ?? null,
    to: sel.to ?? null,
    note: sel.note,
    entries: sel.entries.map((e) => ({ version: e.version, body: e.body })),
    ...(sel.error ? { error: sel.error } : {}),
  }, null, 2) + '\n';
}

export function parseArgs(argv) {
  const a = { from: null, to: null, json: false, url: CHANGELOG_URL };
  const rest = Array.isArray(argv) ? argv.slice() : [];
  while (rest.length) {
    const arg = rest.shift();
    if (arg === '--json') a.json = true;
    else if (arg === '--from') a.from = rest.shift() ?? null;
    else if (arg === '--to') a.to = rest.shift() ?? null;
    else if (arg === '--url') a.url = rest.shift() ?? null;
    else if (arg.startsWith('--from=')) a.from = arg.slice('--from='.length);
    else if (arg.startsWith('--to=')) a.to = arg.slice('--to='.length);
    else if (arg.startsWith('--url=')) a.url = arg.slice('--url='.length);
    else if (arg === '-h' || arg === '--help') a.help = true;
    else return { ...a, error: `unknown argument: ${arg}` };
  }
  if (!a.help && !a.from) return { ...a, error: 'missing required --from <version>' };
  return a;
}

export const USAGE =
  'usage: upstream-release-notes.mjs --from <version> [--to <version>] [--json] [--url <url>]\n'
  + '  Prints what upstream SAID between two Claude Code versions, newest first.\n'
  + '  A lead to investigate — never a diagnosis. --to defaults to the newest section.\n'
  + '  Network/parse failures print one line and exit 0; only a usage error exits nonzero.\n';

// The proxy decision, as a pure function so it is testable without spawning.
// Returns the env overrides for a re-exec, or null when no re-exec is warranted:
// already enabled, already re-executed once (sentinel), or no proxy configured.
export function proxyReexecEnv(env = {}) {
  if (env[REEXEC_SENTINEL] === '1') return null;         // never twice
  if (env.NODE_USE_ENV_PROXY === '1') return null;       // Node already honors it
  const proxy = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  if (!proxy) return null;
  return { NODE_USE_ENV_PROXY: '1', [REEXEC_SENTINEL]: '1' };
}

// ------------------------------------------------------------------- runtime

// One honest line, and only ever one. Node's fetch reports nearly everything as a
// bare "fetch failed" and hides the real reason on .cause — an unhelpful line is
// how a diagnostic aid becomes the thing you debug, so unwrap the chain.
function reasonOf(err) {
  const parts = [];
  for (let e = err, depth = 0; e && depth < 4; e = e.cause, depth++) {
    const m = (e && e.message) || (typeof e === 'string' ? e : '');
    if (m && !parts.includes(m)) parts.push(m);
  }
  return parts.join(': ') || String(err);
}

function unavailable(err) {
  return `upstream-release-notes: could not fetch upstream changelog: ${reasonOf(err)}\n`;
}

export async function fetchChangelog(url, opts = {}) {
  const doFetch = opts.fetchImpl || globalThis.fetch;
  if (typeof doFetch !== 'function') throw new Error('no fetch available in this runtime');
  const signal = opts.signal
    || (typeof AbortSignal !== 'undefined' && AbortSignal.timeout
      ? AbortSignal.timeout(FETCH_TIMEOUT_MS)
      : undefined);
  const res = await doFetch(url, {
    redirect: 'follow',
    signal,
    headers: { accept: 'text/plain', 'user-agent': 'clode-upstream-release-notes' },
  });
  if (!res || !res.ok) throw new Error(`HTTP ${res ? res.status : '(no response)'} for ${url}`);
  return res.text();
}

// Returns the process exit code. Everything except a usage error returns 0 —
// see the header. stdout/stderr are injected so tests never touch the real ones.
export async function run(opts = {}) {
  const argv = opts.argv || [];
  const stdout = opts.stdout || ((s) => process.stdout.write(s));
  const stderr = opts.stderr || ((s) => process.stderr.write(s));

  const args = parseArgs(argv);
  if (args.help) { stdout(USAGE); return 0; }
  if (args.error) { stderr(`upstream-release-notes: ${args.error}\n\n${USAGE}`); return 64; }

  let text;
  try {
    text = await fetchChangelog(args.url, opts);
  } catch (e) {
    stderr(unavailable(e));
    if (args.json) {
      stdout(renderJson({
        status: 'unavailable', from: args.from, to: args.to, entries: [],
        note: 'the upstream changelog could not be fetched; this says nothing about upstream, '
          + 'only about our network. Not a finding.',
        error: reasonOf(e),
      }, { source: args.url }));
    }
    return 0;   // a diagnostic aid must never become a second thing to debug
  }

  let sel;
  try {
    sel = selectRange(parseChangelog(text), { from: args.from, to: args.to });
  } catch (e) {
    stderr(unavailable(e));
    return 0;
  }
  stdout(args.json ? renderJson(sel, { source: args.url }) : renderText(sel, { source: args.url }));
  return 0;
}

async function main() {
  // Delegate proxying to Node, one startup earlier (see the header).
  const overrides = proxyReexecEnv(process.env);
  if (overrides) {
    try {
      const r = spawnSync(process.execPath, [process.argv[1], ...process.argv.slice(2)],
        { stdio: 'inherit', env: { ...process.env, ...overrides } });
      if (r && r.status !== null) return r.status;
      // Could not spawn (or it was signalled): fall through and try direct.
    } catch { /* fall through to a direct fetch; a proxy hint is not worth failing over */ }
  }
  return run({ argv: process.argv.slice(2) });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Even an unexpected throw in here exits 0 (bar the usage error above): the
  // job that called us has a real failure to report and this is not it.
  main().then(
    (code) => process.exit(code),
    (e) => { process.stderr.write(unavailable(e)); process.exit(0); },
  );
}
