'use strict';
// clode-fuse — the `clode build` subcommand (clode's own namespace, NOT a
// passthrough): fuse a standalone quaude binary on THIS machine. quaude is the
// product users make/use/update; it is derived work and is NEVER distributed —
// fusing always happens locally (canon; CI may fuse in ephemeral runners for
// tests only).
//
// Pipeline (Q1a design memo spike/quickjs/results/quaude-fuse-design.md):
//   1. resolve + extract + hook the upstream bundle (existing cache machinery);
//   2. ensure the ext-dep closure (existing deps machinery);
//   3. copy the pinned tjs template and ad-hoc re-sign the COPY while it is
//      still a valid Mach-O (sign-THEN-append: appending tail data breaks
//      strict codesign validation, and --remove-signature dies outright, so
//      signing after assembly is impossible — but the kernel only validates
//      mapped code pages, so the fused binary executes fine on the template's
//      signature; memo §6.1);
//   4. spawn the fuse worker (libexec/quaude-fuse.js) UNDER THE TEMPLATE
//      ITSELF — bytecode writer == runtime, BC_VERSION lockstep automatic —
//      which compiles cli.cjs to bytecode, assembles the member archive +
//      manifest + bootstrap, and appends;
//   5. smoke the result LOUDLY: `quaude -p 'say PONG'` against an in-process
//      canned Messages mock (no network, no key), then `quaude
//      --quaude-attest` — any failure exits nonzero and says why.
//
// Usage: clode build [--out PATH]        (default ./quaude)
//        clode build --self [--out PATH] (default ./clode-native)
// Env:   CLODE_TJS         — the tjs template binary (default <root>/build/tjs/tjs)
//        CLODE_MAIN_BUNDLE — the esbuilt clode-main bundle for --self (default:
//                            newest build/*/clode-main.bundle.cjs)
//
// --self fuses the BUILDER itself: the same trailer format with role "builder"
// — the esbuilt clode-main bundle as a SOURCE entry (65KB; bytecode would force
// strict mode on the esbuild output for no parse win — measured 0.24s boot),
// plus everything `clode build` needs as fuse INPUTS on a machine with no
// checkout and no node: the node-shim tree, the libexec support files
// (extractor, bun-shim, worker, bootstrap), and the ext-dep closure (quaude
// member inputs — clode-main itself imports node builtins only). When `build`
// later RUNS under that fused builder, the payload is materialized back to
// disk first (subprocesses — the template-tjs worker — need real files).

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync } = require('node:child_process');

const resolve = require('./clode-resolve.cjs');
const extract = require('./clode-extract.cjs');
const deps = require('./clode-deps.cjs');
const { clodeCacheDir, depsStore } = require('./clode-paths.cjs');
const { seaBin } = require('../scripts/platform-tag.cjs');

function sha256File(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

// Read package.json's declared `dependencies` — the SOURCE OF TRUTH for the
// ext-dep closure (duplication audit §1). Throws (not a silent []) when the
// manifest is missing/unparseable: the whole closure hinges on this, so a bad
// read must fail the build loudly rather than silently embed nothing.
function readDirectDeps(pkgJsonPath) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  } catch (e) {
    throw new Error(`cannot read '${pkgJsonPath}' to compute the ext-dep closure (${(e && e.message) || e})`);
  }
  return Object.keys(pkg.dependencies || {});
}

// Walk the runtime ext-dep closure from package.json's direct `dependencies`,
// resolving each package's OWN dependencies from ITS manifest under nmDir (a
// flat node_modules — every package here is a direct child, matching how
// ensureDeps/npm install lays this closure out today: no version conflicts).
// This is the ONE place that decides which packages quaude embeds — it must
// never be hand-listed a second time (that drifted silently: duplication
// audit §1, the failure this replaces). Fails loud (throws), not a silent
// skip, when a declared dependency is missing under nmDir — the whole point
// of computing this at BUILD time is to catch that before it becomes a
// runtime "Cannot find module" deep in a session.
//
// opts.versions: an optional Map the walk fills as a side effect, name ->
// the version each package's OWN package.json declares (i.e. what is
// actually on disk, about to be embedded). Callers use this to render the
// manifest BOM (name@version) and to gate node_modules against
// package-lock.json (assertClosureMatchesLockfile, below) without a second
// read pass over the same files.
function computeDepClosure(nmDir, directDeps, opts = {}) {
  const versions = opts.versions;
  const seen = new Set();
  const queue = directDeps.map((name) => ({ name, via: 'package.json' }));
  while (queue.length) {
    const { name, via } = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const pkgPath = path.join(nmDir, name, 'package.json');
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    } catch (e) {
      throw new Error(`ext-dep closure: '${name}' (required by ${via}) not found under ${nmDir} (run clode once, or npm install) [${(e && e.message) || e}]`);
    }
    if (versions) versions.set(name, pkg.version);
    // Only `dependencies` are followed. `optionalDependencies` are
    // deliberately NOT walked: quaude runs under tjs (no native addon
    // support) and a SEA cannot carry .node binaries either, so an optional
    // dep that happens to be a native addon could never load in either
    // target even if embedded — and "optional" already means the package
    // works without it. (Today's closure declares none; this is the general
    // rule, not a reaction to a specific package.)
    for (const dep of Object.keys(pkg.dependencies || {})) queue.push({ name: dep, via: name });

    // Peer dependencies are NOT walked either — same reasoning as
    // optionalDependencies above, confirmed concretely by the one package
    // that has any: `ws`'s peers (bufferutil, utf-8-validate) are both native
    // addons, both marked optional in peerDependenciesMeta, and neither is
    // installed. Silently skipping an OPTIONAL peer is fine (it is optional
    // by the package's own declaration). But silently skipping a REQUIRED
    // (non-optional) peer would be the exact duplication-audit-§1 bug through
    // a new door: a future dep bump could add a real, load-bearing peer that
    // this walk never follows, quaude would still build+PONG+attest clean,
    // and it would fail "Cannot find module" the moment Claude Code actually
    // exercised that code path. So: fail loud instead, naming the package and
    // the peer, so a human decides (embed it as a real dependency, or mark it
    // optional upstream) rather than shipping a silently-broken binary.
    // Nothing triggers this today — that is the point; it is a tripwire.
    const peerMeta = pkg.peerDependenciesMeta || {};
    for (const peer of Object.keys(pkg.peerDependencies || {})) {
      const optional = !!(peerMeta[peer] && peerMeta[peer].optional);
      if (!optional) {
        throw new Error(`ext-dep closure: '${name}' declares a REQUIRED peer dependency '${peer}' that computeDepClosure does not follow (only optional peers are skipped, by design — see the comment above) — either add '${peer}' to package.json's dependencies so it is embedded, or mark it optional in '${name}'s peerDependenciesMeta, then rebuild`);
      }
    }
  }
  return [...seen].sort();
}

// npm ci guarantees node_modules matches package-lock.json bit-for-bit; a
// dev's plain `npm install` does not — it can leave node_modules AHEAD of (or
// behind) the lockfile, same package name, different resolved version.
// computeDepClosure above embeds whatever bytes are ACTUALLY on disk, so
// without this gate a stale/dirty node_modules would silently ship a quaude
// with an unpinned dependency version, and nothing would ever say so.
//
// Deliberately targeted, not `npm ci` shelled out: this only reads (never
// mutates) node_modules and package-lock.json, checking EXACTLY the closure
// we are about to embed (closureVersions, filled by computeDepClosure's
// walk — no second directory read). Fails loud, naming the package, both
// versions, and the fix.
function assertClosureMatchesLockfile(closureVersions, lockfilePath) {
  let lock;
  try {
    lock = JSON.parse(fs.readFileSync(lockfilePath, 'utf8'));
  } catch (e) {
    throw new Error(`cannot read '${lockfilePath}' to verify the ext-dep closure matches the lockfile (${(e && e.message) || e})`);
  }
  const packages = lock.packages || {};
  for (const [name, diskVersion] of closureVersions) {
    const entry = packages[`node_modules/${name}`];
    if (!entry || !entry.version) {
      throw new Error(`ext-dep closure: '${name}' (resolved ${diskVersion} under node_modules) has no entry in '${lockfilePath}' — node_modules is out of sync with the lockfile; run 'npm ci'`);
    }
    if (entry.version !== diskVersion) {
      throw new Error(`ext-dep closure: '${name}' is ${diskVersion} under node_modules but package-lock.json pins ${entry.version} — node_modules is out of sync with the lockfile; run 'npm ci'`);
    }
  }
}

// ---- dep-closure DRIFT gate --------------------------------------------------
// Every gate above (readDirectDeps, computeDepClosure, assertClosureMatchesLockfile)
// computes flawlessly from ONE unverified premise: deps/claude/package.json's
// direct dependencies are a human's transcription of what Claude Code's bundle
// actually requires, written once and never checked against the bundle itself.
// If upstream adds a require() the seed list doesn't know about, every layer
// below still builds green and PONGs clean — the gap only shows up as a runtime
// "Cannot find module" deep in a user's session, long after 'clode build'
// printed success. This closes that gap: scan the EXTRACTED cli.cjs +
// bun-shim.cjs for every bare (non-builtin, non-relative) package specifier they
// reference, and fail the build loud if one isn't accounted for — by the
// computed closure, by bun-shim.cjs's own runtime module resolution (bun:
// pseudo-modules, host-module stubs like undici), or by the justified
// KNOWN_UNREACHABLE allowlist below. Measured against the real 2.1.210 bundle;
// full analysis in .superpowers/sdd/seed-drift-report.md — that measurement is
// what found node-fetch missing (now in deps/claude/package.json) and is what
// justifies every KNOWN_UNREACHABLE entry.
//
// Deliberately regex, not an AST parse (cli.cjs is ~19MB; a full parse of every
// build is not worth the cost for a presence scan). Two forms only:
//   require("x") / __require("x")  — Bun's/esbuild's CJS require, the ONLY form
//     that actually resolves a module at runtime in this bundle.
//   import("x")                    — dynamic import, also a real runtime call.
// Static `import x from "y"` is DELIBERATELY not scanned: Claude Code ships
// embedded skill/reference documentation (design-system self-check scripts, SDK
// usage examples) as STRING literals inside cli.cjs, many of which are
// themselves ESM source text quoting real package names for the reader/model —
// scanning declarative `from '...'` on the real bundle turned up a dozen "bare
// names" that were 100% prose/doc noise (down to literal English words like
// 'now' and 'wide' caught by "...from 'now'"/"...from 'wide'" in comments), and
// zero real findings beyond what require()/import() already found. Since
// cli.cjs demonstrably loads and runs (a real build's PONG smoke proves it),
// any literal ESM `import ... from` text in the file CANNOT be live code (it
// would be a SyntaxError in the CJS module Node/tjs actually execute) — it is
// always inert string content.
const SPECIFIER_PATTERNS = [
  /(?:require|__require)\(["']([a-zA-Z0-9_/:@.-]+)["']\)/g,
  /\bimport\(["']([a-zA-Z0-9_/:@.-]+)["']\)/g,
];

const NODE_BUILTINS = new Set(require('node:module').builtinModules);

// A specifier is a node builtin if EITHER the literal spec or its node:-prefix-
// stripped form is builtin: some builtins are only requireable bare ('fs'), a
// few only with the prefix ('node:sqlite', 'node:test' — Module.builtinModules
// lists those WITH the prefix and does not also list the bare form), so a
// single-form check misses one direction or the other.
function isBuiltinSpecifier(spec) {
  const bare = spec.startsWith('node:') ? spec.slice(5) : spec;
  return NODE_BUILTINS.has(spec) || NODE_BUILTINS.has(bare);
}

// '@scope/name/sub/path' -> '@scope/name'; 'pkg/sub/path' -> 'pkg'. Same
// granularity as the closure (readDirectDeps/computeDepClosure operate on
// package names, not import subpaths).
function specifierPackageName(spec) {
  if (spec.startsWith('@')) return spec.split('/').slice(0, 2).join('/');
  return spec.split('/')[0];
}

// Every bare (non-builtin, non-relative/absolute) package NAME `file`
// references via require()/__require()/dynamic import(). Reads latin1 (1 char
// == 1 byte, same convention as extract-claude-js.cjs) so this scans the raw
// carved bytes without a re-encode.
function scanBareSpecifiers(file) {
  const src = fs.readFileSync(file, 'latin1');
  const names = new Set();
  for (const re of SPECIFIER_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src))) {
      const spec = m[1];
      if (!spec || spec.startsWith('.') || spec.startsWith('/')) continue;
      if (isBuiltinSpecifier(spec)) continue;
      names.add(specifierPackageName(spec));
    }
  }
  return names;
}

// Modules libexec/bun-shim.cjs answers itself before Node's/tjs's own resolver
// ever sees them: `bun:*` pseudo-modules (bun:ffi, bun:sqlite — a Module._load
// hook intercepts these) and HOST_MODULES stubs (undici — real proxying is
// delegated to Node's NODE_USE_ENV_PROXY instead of reimplementing it). These
// are NOT npm packages quaude/naude embed, so the dep-closure gate must not
// demand them from the closure.
//
// Read straight out of bun-shim.cjs's SOURCE TEXT — its `const PROVIDES = {...}`
// declaration, kept JSON-shaped expressly so this parse is a JSON.parse and not a
// guess. Both ways of EXECUTING the shim to ask it are closed to us:
//   - SPAWNING a host — what this did, via `process.execPath -e` — assumes
//     process.execPath is a Node. Under a fused native builder it is the fused
//     clode binary itself: there is no node on the box (that is the entire point
//     of that artifact), it has no `-e`, and it exited 2 with its own usage. That
//     broke EVERY `clode build` under clode-native while CI stayed green.
//   - REQUIRING it in-process installs bun-shim's process-wide Module._load hook
//     and globals (globalThis.Bun/WebSocket, an fs.readSync patch) — machinery
//     meant for a RUNNING quaude/naude, not clode's own builder.
// Reading the text has neither problem, and it makes the gate host-free: nothing
// in `clode build`'s dep-closure path now needs an interpreter (scanBareSpecifiers
// is already a regex over these same bytes; the closure walk is fs + JSON).
//
// bun-shim.cjs remains the ONE place these names live — this reads its actual
// source, not a generated mirror of it, so there is no second copy to rot and no
// refresh step to forget. (A mirror + a drift test was the first cut of this fix;
// one truth beats two truths plus a policeman.) The shim's own exports come from
// that same literal, so a running shim and this gate cannot disagree about what
// is shim-provided.
function shimProvidedModules(libexecDir, opts = {}) {
  const readFile = opts.readFileSync || fs.readFileSync;
  const shimPath = path.join(libexecDir, 'bun-shim.cjs');
  let src;
  try {
    src = readFile(shimPath, 'utf8');
  } catch (e) {
    throw new Error(`dep-closure gate: cannot read '${shimPath}' for shim-provided modules [${(e && e.message) || e}]`);
  }
  // Anchored to the declaration, non-greedy to its first `};` — PROVIDES is
  // JSON-shaped by contract (bun-shim.cjs says so where it is defined), so this
  // is a parse, not a heuristic. Every failure below is LOUD: a gate that
  // silently found no shim-provided modules would demand bun:ffi/bun:sqlite from
  // the ext-dep closure and fail the build for a nonsense reason.
  const m = /const PROVIDES = (\{[\s\S]*?\});/.exec(src);
  if (!m) {
    throw new Error(`dep-closure gate: no 'const PROVIDES = {...}' declaration in '${shimPath}' — it is the single source of truth for shim-provided modules; restore it (and keep it JSON-shaped) rather than routing around this`);
  }
  let data;
  try {
    data = JSON.parse(m[1]);
  } catch (e) {
    throw new Error(`dep-closure gate: '${shimPath}'s PROVIDES is not JSON-shaped (single quotes? a comment? a trailing comma? an expression?) — it must stay literal JSON so this gate can read it without an interpreter [${(e && e.message) || e}]`);
  }
  if (!Array.isArray(data.bunBuiltins) || !Array.isArray(data.hostModules)) {
    throw new Error(`dep-closure gate: '${shimPath}'s PROVIDES is malformed (want {"bunBuiltins":[], "hostModules":[]})`);
  }
  return new Set([...data.bunBuiltins, ...data.hostModules]);
}

// Specifiers the real 2.1.210 bundle references that are demonstrably NEVER
// reached by anything clode builds or tests — each verified BY HAND against the
// extracted bundle (full analysis: .superpowers/sdd/seed-drift-report.md), not
// assumed. An entry without a concrete reason is a bug, not a convenience: this
// list is a decision record, not a dumping ground.
const KNOWN_UNREACHABLE = {
  // ajv is fully vendored INTO cli.cjs (its own `Ajv` class ships in the
  // bundle) and IS instantiated: `new V9c.Ajv({allErrors:!0,validateFormats:!1})`.
  // The 'ajv/dist/runtime/...' requires only appear inside ajv's OWN
  // standalone code-generation feature (a tagged-template string ajv emits
  // when asked to produce a SEPARATELY-requirable validator file) — a feature
  // that only activates with an explicit `code:{source:true}}` option, which
  // CC's one `new Ajv(...)` call site does not pass. Dead text inside a
  // vendored package's unused feature, not a live require.
  ajv: "vendored + instantiated without standalone codegen (`code:{source:true}}`); the require() text is inert inside ajv's own unused codegen template",
  // Same codegen feature, and doubly dead here: CC's one Ajv instance also
  // passes `validateFormats:!1` (false), so the format-validation feature
  // ajv-formats provides is switched off outright.
  'ajv-formats': 'same dead ajv codegen path as `ajv` above, and CC disables format validation (`validateFormats:false`) so this would never even be reached if codegen were live',
  // Bun-only heap/GC introspection (a `Bun.heapStats`-shaped API) for a
  // diagnostics feature. The one call site wraps it in its own try/catch and
  // silently produces no heap stats on failure — bun:jsc is not stubbed by
  // bun-shim.cjs (unlike bun:ffi/bun:sqlite) and is not resolvable under Node
  // or tjs, but nothing downstream depends on it succeeding.
  'bun:jsc': 'Bun-only heap introspection, call site wrapped in try/catch, degrades to "no heap stats" — never available or needed under Node/tjs',
  // esbuild/playwright/playwright-core/react/react-dom/typescript/ts-morph all
  // come from the SAME embedded region (~16.7-17.0MB into the 19.8MB bundle):
  // a "design system self-check" skill/reference script CC ships as example
  // source TEXT (for the model to write out and run, or to show the user), not
  // code that runs inside cli.cjs's own process. Proven inert, not assumed:
  // that region contains literal ESM `import x from 'y'` declarative-import
  // syntax, which cannot appear in cli.cjs's own live code (cli.cjs is Bun's
  // CJS output and demonstrably loads+runs — a real `import` statement there
  // would be a SyntaxError). A doc block quoting real package names is not a
  // dependency.
  esbuild: 'embedded design-system self-check skill/doc TEXT (the region contains literal ESM `import` syntax, proving it is a string, not live cli.cjs code) — same region as ts-morph/typescript/react/playwright below',
  playwright: 'embedded design-system self-check skill/doc TEXT, same region as esbuild above — guarded there by try/catch + a NO_RENDER_CHECK flag in the doc text itself',
  'playwright-core': "appears inside a shell-command EXAMPLE string (\"xvfb-run -a node -e '...require(\\'playwright-core\\')...'\"), not a require() cli.cjs itself executes",
  react: 'appears inside a string literal fed to esbuild as virtual entry CONTENTS ("window.__dsReact=require(\\"react\\");"), building some OTHER bundle — not a require() cli.cjs itself executes',
  'react-dom': 'same virtual-esbuild-entry string as react above, same reasoning',
  typescript: 'embedded design-system self-check skill/doc TEXT, same region as esbuild above',
  'ts-morph': 'embedded design-system self-check skill/doc TEXT, same region as esbuild above',
};

// THE GATE: every bare package specifier `files` reference must be explained —
// by the computed ext-dep closure, by bun-shim.cjs's own runtime module
// resolution, or by the justified KNOWN_UNREACHABLE allowlist above. Anything
// else fails the build LOUD, naming the package and the fix, rather than
// shipping a quaude/naude that PONGs clean today and throws "Cannot find
// module" the first time a user's session reaches the untested code path.
function assertNoUnknownBareSpecifiers(files, closure, libexecDir, opts = {}) {
  const known = new Set(closure);
  const shimProvided = shimProvidedModules(libexecDir, opts);
  const unknown = new Map(); // name -> first file it was seen in
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    for (const name of scanBareSpecifiers(file)) {
      if (known.has(name) || shimProvided.has(name) || KNOWN_UNREACHABLE[name]) continue;
      if (!unknown.has(name)) unknown.set(name, file);
    }
  }
  if (unknown.size) {
    const lines = [...unknown.entries()]
      .map(([name, file]) => `  - '${name}' (seen in ${path.basename(file)})`);
    throw new Error(
      `dep-closure gate: the bundle references package(s) not covered by the ext-dep `
      + `closure, bun-shim's own module resolution, or the KNOWN_UNREACHABLE allowlist:\n`
      + `${lines.join('\n')}\n`
      + `  Fix: if it's genuinely needed, add it to deps/claude/package.json's `
      + `dependencies (then npm install); if it's dead/optional code, add it to `
      + `KNOWN_UNREACHABLE in libexec/clode-fuse.cjs with a concrete reason.`);
  }
}

// Resolve node_modules for the ext-dep closure the same way in both build
// targets that embed Claude Code (the quaude/--self shared block below, and
// `clode build --naude` above it): ensureDeps (installs into the deps store
// unless deps ship beside this checkout), then the two candidate locations an
// npm/repo layout can leave it in. Throws (never a silent null) — the whole
// ext-dep closure hinges on finding this directory. Factored out so this
// resolution logic lives in exactly one place (the reason this whole file
// exists — see computeDepClosure's comment on duplication audit §1).
function resolveClaudeNmDir({ libexec, here, verbose, env, ROOT }) {
  deps.ensureDeps({ libexec, here, verbose, env });
  const nmCandidates = [path.join(ROOT, 'deps', 'claude', 'node_modules'), path.join(depsStore(env), 'node_modules')];
  const nmDir = nmCandidates.find((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
  if (!nmDir) throw new Error(`no node_modules with the runtime deps (looked in: ${nmCandidates.join(', ')})`);
  return nmDir;
}

// Land the user's upstream Claude Code bundle on disk, extracted and ready to
// fuse (quaude) or bake into a SEA (naude). BOTH `clode build` targets need the
// identical five-step sequence — resolve the binary, follow a wrapper, key a
// cache dir by its identity, extract if that dir is cold — and they ran it
// twice, in parallel copies, for long enough that the naude copy grew a comment
// claiming it reused the quaude one ("no duplication"). It did not.
//
// `prefix` names the failing target ('build' / 'build --naude') so the caller's
// errors still say WHICH build died — the only real difference between the two
// former copies. `libexec` is a parameter rather than a closure read because the
// quaude caller may hand us the MATERIALIZED libexec (a fused builder unpacks
// its VFS to a temp dir and rebinds it), while naude always passes the on-disk
// one. Errors come back as { error } for the caller to route through its own
// fail() — this helper never writes to stderr or picks an exit code.
function stageUpstreamCli({ env, libexec, verbose, prefix, log }) {
  let bin = resolve.resolveClaudeBin({ env });
  if (bin == null || !resolve.pathExists(bin)) {
    return {
      error: bin == null
        ? `${prefix}: no Claude Code binary found — run 'clode fetch [channel|version]' to fetch one, or install the provider package, or set CLODE_CLAUDE_BIN`
        : `${prefix}: claude binary not found at '${bin}'`,
    };
  }
  bin = resolve.followWrapper(bin);
  const key = resolve.cacheKey(bin);
  const stageDir = path.join(clodeCacheDir(env), key);
  if (log) log(`clode: ${prefix}: staging bundle ${key} ...`);
  try {
    extract.extractIfNeeded({ bin, cacheDir: stageDir, libexec, verbose, key });
  } catch (e) {
    return { error: `${prefix}: extraction failed: ${(e && e.message) || e}` };
  }
  return { stageDir, key, cliPath: path.join(stageDir, 'cli.cjs') };
}

// A minimal in-process stand-in for the Anthropic Messages API, answering every
// POST .../messages with the canonical streaming-SSE single-turn "PONG". A
// product-side mirror of test/mock-anthropic-helper.cjs (which is not shipped);
// keep the SSE sequence in step with it.
function cannedSSE(text) {
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  return (
    ev('message_start', { type: 'message_start', message: { id: 'msg_clode_build_smoke', type: 'message', role: 'assistant', model: 'claude-opus-4-8', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 8, output_tokens: 0 } } }) +
    ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
    ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }) +
    ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
    ev('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }) +
    ev('message_stop', { type: 'message_stop' })
  );
}
function startPongMock() {
  const requests = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url });
      if (req.method === 'POST' && /\/messages$/.test(req.url.split('?')[0])) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.end(cannedSSE('PONG'));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  return new Promise((ok) => {
    server.listen(0, '127.0.0.1', () => ok({
      url: `http://127.0.0.1:${server.address().port}`,
      requests,
      close: () => new Promise((r) => server.close(r)),
    }));
  });
}

// The shared build-target smoke (duplication audit §2): run `<bin> -p 'say
// PONG'` against the in-process canned Messages mock, with NODE_PATH
// deliberately stripped (a pass PROVES the binary resolves every module from
// its own payload, not the build host's ambient NODE_PATH), and assert the
// mock actually RECEIVED the POST (a hang or a silently-broken client would
// otherwise exit clean without ever calling out). Before this was factored
// out, only quaude ran this proof; `clode build --naude` checked nothing
// beyond the child's exit status, so a naude that booted but couldn't reach
// the API — or only "worked" because the build host's NODE_PATH leaked in —
// still printed success. Per-target bits (quaude's --quaude-attest; naude's
// build-time stripped-node/SIGSEGV diagnostic) stay OUT of this function and
// live with their own target.
async function smokeTarget(bin, { spawnRun, env, cwd, timeout }) {
  const mock = await startPongMock();
  let result;
  try {
    const smokeEnv = { ...env, ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: 'sk-ant-clode-build-smoke' };
    delete smokeEnv.NODE_PATH;
    result = await spawnRun(bin, ['-p', 'say PONG'], { env: smokeEnv, cwd, timeout });
  } finally { await mock.close(); }
  const posted = mock.requests.some((q) => q.method === 'POST' && /\/messages/.test(q.url));
  if (result.status !== 0 || !/PONG/.test(result.stdout) || !posted) {
    // `how` carries run()'s verdict verbatim (timed out / killed / exit N). A smoke
    // that HUNG and one that exited nonzero are different bugs; reporting only a
    // status makes them look identical to whoever reads the failure.
    return { ok: false, status: result.status, how: describeExit(result), posted, stdout: result.stdout, stderr: result.stderr };
  }
  return { ok: true };
}

// CLODE_TIMEOUT_SCALE: integer multiplier for every subprocess timeout in
// the build pipeline (default 1). The timeouts are HANG guards, not pacing —
// but a TCG-emulated guest runs 10-20x slower than metal, and the fuse
// worker's 5-minute guard killed a healthy bytecode compile on the matrix's
// freebsd-arm64 leg (dispatch #14, 2026-07-10). CI's VM legs set 10.
function timeoutScale(env) {
  const n = parseInt((env || {}).CLODE_TIMEOUT_SCALE, 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

// Ad-hoc codesign a Mach-O template so it can exec / be appended to. On old
// macOS (Mavericks) the bundled codesign_allocate cannot sign a FAT binary that
// carries an arm64 slice — it dies "malformed object (unknown load command 5)".
// When signing a fat template fails and the host arch is one of its slices, thin
// to the host slice IN PLACE and retry: the worker only needs the host slice,
// and the fused output degrades to a host-arch quaude (honest — a box whose
// tooling can't sign the arm64 slice can neither run nor verify a universal one).
// Modern hosts sign the fat template unchanged, so universal output is preserved.
// Injectable spawnSync/platform/arch keep it unit-testable. Returns
// { ok: true } | { ok: false, error }.
function codesignAdHoc(file, opts = {}) {
  const sp = opts.spawnSync || spawnSync;
  const platform = opts.platform || process.platform;
  const arch = opts.arch || process.arch;
  const log = opts.log || (() => {});
  if (platform !== 'darwin') return { ok: true };
  const sign = () => sp('codesign', ['-s', '-', '--force', file], { encoding: 'utf8' });
  let cs = sign();
  if (cs.status === 0) return { ok: true };
  // Signing failed. On old macOS (Mavericks, verified 10.9.5) codesign_allocate
  // cannot sign a fat Mach-O carrying an arm64 slice. Thin to the host slice IN
  // PLACE and retry. Attempt the thin DIRECTLY: old `lipo` has no `-archs` flag,
  // and `lipo -thin` succeeds iff the file is fat AND contains the slice (else it
  // errors harmlessly — already-thin or missing-slice → we keep the sign error).
  // node arch 'x64' -> Mach-O arch 'x86_64'.
  const hostSlice = arch === 'x64' ? 'x86_64' : arch;
  const thin = sp('lipo', [file, '-thin', hostSlice, '-output', file], { encoding: 'utf8' });
  if (thin.status === 0) {
    log(`clode: build: thinned fat template to ${hostSlice} (host codesign cannot sign the fat binary)`);
    cs = sign();
    if (cs.status === 0) return { ok: true };
  }
  return { ok: false, error: cs.stderr || cs.stdout };
}

// Async spawn with capture + timeout (spawnSync would starve the in-process
// mock server — the same reason the test harnesses spawn async).
//
// Reports HOW a child ended, not just a number. `run` fires the timeout, so it is
// the only place that knows a kill was ours; throwing that away and handing the
// caller a bare status turned "we SIGKILLed this after 20 minutes" into "exit
// null", or — before the node-shim reported signal kills correctly — into the
// actively false "exit 0". Both sent a real investigation after a phantom
// (haiku-x64, 2026-07-17). timedOut/signal cost nothing and are the difference
// between a diagnosis and a hunt.
function run(cmd, args, opts = {}) {
  return new Promise((ok) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: opts.env, cwd: opts.cwd,
    });
    let stdout = '', stderr = '';
    let timedOut = false;
    const timeoutMs = opts.timeout || 120000;
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const to = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* */ } }, timeoutMs);
    child.on('exit', (status, signal) => {
      clearTimeout(to);
      ok({ status, signal: signal || null, timedOut, timeoutMs, stdout, stderr });
    });
    child.on('error', (e) => {
      clearTimeout(to);
      ok({ status: null, signal: null, timedOut, timeoutMs, stdout, stderr: stderr + String(e) });
    });
  });
}

// How a child ended, in words a human can act on. "exit 0" for a process we
// killed is a lie; "exit null" is a riddle. Used by every LOUD failure path below
// so the reader learns whether the thing crashed, was killed, or simply said no.
function describeExit(r) {
  if (r && r.timedOut) return `TIMED OUT after ${Math.round((r.timeoutMs || 0) / 1000)}s and was SIGKILLed`;
  if (r && r.signal) return `killed by ${r.signal}`;
  return `exit ${r ? r.status : '?'}`;
}

// Shared argv contract for `clode build [--naude|--self] [--out PATH]`.
// Exported so clode-main.cjs can validate BEFORE deciding whether to fire
// the watch trigger: a build that will not happen (bad/unknown argv) must
// not phone home or write <cache>/clode/last-watch — see clode-main.cjs's
// build branch. Returns { naude, self, out } on success or { error } on a
// bad argv; never throws, never writes anywhere (pure parse).
function parseBuildArgs(args) {
  let naude = false;
  let self = false;
  let out = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--naude') { naude = true; }
    else if (args[i] === '--self') { self = true; }
    else if (args[i] === '--out' && args[i + 1]) { out = args[++i]; }
    else return { error: `build: unknown argument '${args[i]}' (usage: clode build [--self] [--out PATH])` };
  }
  // --naude (a Node SEA) and --self (the native clode builder) are different
  // build TARGETS, not composable modifiers — silently picking one would
  // build something other than what the user asked for.
  if (naude && self) {
    return { error: 'build: --naude and --self are different build targets (Node SEA vs the native clode builder) — pick one' };
  }
  return { naude, self, out };
}

// clode build [--out PATH]. Returns the exit status (0 on success). Injectable
// bits (env/stderr/stdout) keep the unit-testable surface consistent with the
// sibling subcommand modules.
async function clodeBuild(args, opts) {
  const { here, version } = opts;
  const env = opts.env || process.env;
  const stderr = opts.stderr || process.stderr;
  const stdout = opts.stdout || process.stdout;
  // The one spawn seam every build step goes through (the fuse worker, the
  // smokes, and the naude build). Injectable so the --naude wiring (and any
  // future step) is testable without spawning a real subprocess; defaults to
  // the module-level async `run`.
  const spawnRun = opts.run || run;
  const verbose = !!env.CLODE_VERBOSE;
  const clodeLog = (m) => { if (verbose) stderr.write(m + '\n'); };
  const fail = (m) => { stderr.write('clode: ' + m + '\n'); return 1; };
  const SCALE = timeoutScale(env);

  // -- argv: parsed ONCE for the whole subcommand, before either branch below
  // consumes it (parseBuildArgs below — the same function clode-main.cjs
  // calls to gate the watch trigger, so there is exactly one unknown-arg
  // contract, not two). --naude used to short-circuit BEFORE this validation
  // existed, which meant an unknown flag after --naude was silently ignored,
  // --naude + --self silently picked one target and dropped the other, and
  // --out was forwarded to a stub that quietly dropped it too (build wrote to
  // build/<tag>/naude and exited 0 regardless of what the user asked for).
  const parsed = parseBuildArgs(args);
  if (parsed.error) return fail(parsed.error);
  const { naude, self, out: parsedOut } = parsed;
  let out = parsedOut;

  // -- naude branch (Task 4): `clode build --naude` bakes Claude Code into a
  // Node SEA instead of fusing a quaude. It reuses the SAME resolve + extract
  // machinery as the quaude path to land the user's cli.cjs, then hands that
  // cli.cjs to scripts/build-naude.mjs (which runs the esbuild/postject SEA
  // pipeline — Node >= 24 hosts only) and RETURNS, never touching the fuse.
  if (naude) {
    // A fused NATIVE clode (the builder-role VFS the quaude/self path
    // materializes below) runs under tjs and ships no scripts/ dir on disk —
    // there is nothing for a Node SEA pipeline to spawn, and process.execPath
    // is the tjs template, not a Node >= 24 host. Without this guard the user
    // got a mystery exit (exec failure garbage, or a bare exit-127 with no
    // output); fail loud instead, naming the real alternatives. Same
    // fused-builder signal the materialization step below already keys on —
    // no new global.
    const vfs = globalThis.__quaudeVFS;
    if (vfs && vfs.manifest && vfs.manifest.role === 'builder') {
      return fail('build --naude: naude requires a Node >= 24 host; this is a fused builder running under tjs — use `clode build` (quaude) here, or run clode under node to build a naude');
    }
    const ROOT = path.resolve(opts.libexec, '..');
    const outArgs = out ? ['--out', out] : [];
    // The same resolve+extract the quaude path runs (stageUpstreamCli) — shared
    // for real now, prefix-parameterized so the errors still name this target.
    const staged = stageUpstreamCli({
      env, libexec: opts.libexec, verbose, prefix: 'build --naude', log: clodeLog,
    });
    if (staged.error) return fail(staged.error);
    const { stageDir, cliPath } = staged;

    // -- dep-closure DRIFT gate (see the full rationale on assertNoUnknownBareSpecifiers,
    // above): naude embeds the same Claude Code bundle and the same ext-dep
    // closure (build-naude.mjs runs its own `npm ci` against deps/claude's
    // manifest/lockfile below) as quaude, so it needs the same protection
    // against a package the bundle references but the seed list never learned
    // about. Computed fresh here — this branch returns before reaching the
    // quaude/--self shared block's own closure computation.
    try {
      const nmDir = resolveClaudeNmDir({ libexec: opts.libexec, here, verbose, env, ROOT });
      const pkgJsonPath = path.join(ROOT, 'deps', 'claude', 'package.json');
      const extDeps = computeDepClosure(nmDir, readDirectDeps(pkgJsonPath));
      assertNoUnknownBareSpecifiers(
        [cliPath, path.join(stageDir, 'bun-shim.cjs')], extDeps, opts.libexec, { env });
    } catch (e) {
      return fail(`build --naude: ${(e && e.message) || e}`);
    }

    clodeLog(`clode: build --naude: building the Node SEA from ${cliPath} ...`);
    // build-naude.mjs runs as a SEPARATE process — its esbuild --define reads
    // CLODE_SELF from ITS OWN env (process.env), never opts.self directly — so
    // the builder path (opts.self, this function's own param, NOT the local
    // `self` boolean above) must be handed down through the child's env.
    const r = await spawnRun(process.execPath,
      [path.join(ROOT, 'scripts', 'build-naude.mjs'), '--cli', cliPath, ...outArgs],
      { env: { ...env, ...(opts.self ? { CLODE_SELF: opts.self } : {}) }, timeout: 600000 * SCALE });
    if (r.status !== 0) {
      return fail(`build --naude: build-naude failed (${describeExit(r)}):\n${r.stdout}${r.stderr}`);
    }
    if (r.stdout) clodeLog(r.stdout.trimEnd());

    // -- smoke: the SAME shared contract quaude's build already runs (mock +
    // NODE_PATH-stripped -p PONG + assert-the-POST-landed — smokeTarget,
    // duplication audit §2). Before this, `clode build --naude` only checked
    // build-naude's exit status: build-naude.mjs's OWN self-check
    // (smokeCheck) proves the baked bundle boots, but never proves it can
    // actually reach the API — the equivalent quaude bug was impossible. The
    // naude output path mirrors build-naude.mjs's own default (an explicit
    // --out wins; otherwise its artifact-named seaBin default — see
    // scripts/platform-tag.cjs's artifactDir for why that key, not platformTag()).
    const naudeOut = out || seaBin(ROOT, 'naude', { version });
    const naudeWork = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-naude-smoke-'));
    try {
      clodeLog('clode: build --naude: smoke -p against the canned Messages mock ...');
      const smoke = await smokeTarget(naudeOut, {
        spawnRun,
        env: { ...env, NAUDE_CACHE: path.join(naudeWork, 'cache') },
        cwd: naudeWork,
        timeout: 120000 * SCALE,
      });
      if (!smoke.ok) {
        stderr.write('clode: build --naude: SMOKE FAILED — the built naude did not complete the mock round-trip\n');
        stderr.write(`clode: build --naude: ${smoke.how} posted=${smoke.posted} stdout:\n${smoke.stdout}\nstderr:\n${smoke.stderr}\n`);
        return 1;
      }
    } finally {
      try { fs.rmSync(naudeWork, { recursive: true, force: true }); } catch { /* best effort */ }
    }

    stdout.write('clode: built naude (Node SEA with Claude Code baked in)\n');
    stdout.write(`clode: smoke: PONG round-trip ok — run '${naudeOut}' to use it\n`);
    return 0;
  }

  // naude/self/out were already parsed + validated above (shared with the
  // --naude branch, which returned before reaching here). On Windows a bare
  // `clode build` should yield a runnable .exe. An explicit
  // --out is respected verbatim (the user owns that name); only the DEFAULT
  // gains .exe. win32-guarded → POSIX default (quaude / clode-native) unchanged.
  out = path.resolve(out || (self ? 'clode-native' : 'quaude') + (process.platform === 'win32' ? '.exe' : ''));

  const ROOT = path.resolve(opts.libexec, '..');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-build-'));
  try {
    // -- fused-builder payload: when `build` runs under a fused NATIVE clode
    // (the bootstrap mounted the builder-role VFS), the fuse inputs are archive
    // members, but the worker is a template-tjs SUBPROCESS that needs real
    // files — materialize libexec + node-shim + node_modules to disk once.
    let libexec = opts.libexec;
    let nmDir = null;
    const vfs = globalThis.__quaudeVFS;
    if (vfs && vfs.manifest && vfs.manifest.role === 'builder') {
      const mat = path.join(work, 'payload');
      for (const [name, bytes] of vfs.files) {
        let dest;
        if (name.startsWith('node-shim/')) dest = path.join(mat, 'libexec', name);
        else if (name.startsWith('libexec/')) dest = path.join(mat, name);
        else if (name.startsWith('node_modules/')) dest = path.join(mat, name);
        // target-env.cjs rides at the archive ROOT (bare name, no libexec/
        // prefix — see quaude-fuse.js: the fused node-shim's SHIM_DIR has no
        // 'libexec' ancestor in the archive namespace, so process.cjs's
        // relative require needs it there). On disk it belongs beside
        // node-shim/, i.e. libexec/target-env.cjs, same as this repo.
        else if (name === 'target-env.cjs') dest = path.join(mat, 'libexec', name);
        // deps/claude/package.json + deps/claude/package-lock.json (archive
        // paths preserved verbatim under mat/ — no bare-name special-casing
        // needed like target-env.cjs above): the ext-dep closure's direct-deps
        // SOURCE OF TRUTH (readDirectDeps below) and the lockfile gate's SOURCE
        // OF TRUTH (assertClosureMatchesLockfile below) — Claude Code's deps,
        // NOT clode's own (clode has none). A fused builder ships no repo
        // checkout, so without these members a builder-fused `clode build`
        // (self-hosting) would have nowhere to read them from when it later
        // computes/gates the closure for the quaude it fuses (duplication
        // audit §1).
        else if (name.startsWith('deps/claude/')) dest = path.join(mat, name);
        else continue;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, Buffer.from(bytes));
      }
      libexec = path.join(mat, 'libexec');
      nmDir = path.join(mat, 'node_modules');
      clodeLog(`clode: build: materialized the fused payload -> ${mat}`);
    }
    // ROOT/deps/claude/package.json is the ext-dep closure's source of truth
    // (readDirectDeps below) — Claude Code's runtime deps (buffer, ws, yaml,
    // ...), not clode's own (clode has none; see deps/claude/package.json's
    // description). `libexec` is the local var above — REASSIGNED to
    // mat/libexec under a fused builder — so this always points at the tree
    // that actually has the manifest on disk (mat under a fused builder, the
    // real checkout otherwise), unlike the `ROOT` const above (which is fixed
    // to opts.libexec's parent and stays virtual under a fused builder).
    const pkgJsonPath = path.join(path.dirname(libexec), 'deps', 'claude', 'package.json');
    // Same tree as pkgJsonPath, same reasoning: the lockfile gate's source of
    // truth (assertClosureMatchesLockfile below) — mat/deps/claude/package-lock.json
    // under a fused builder (materialized above), the real checkout otherwise.
    const lockfilePath = path.join(path.dirname(libexec), 'deps', 'claude', 'package-lock.json');

    // -- template resolution: an explicit CLODE_TJS wins (and must exist —
    // fail loud, never fall through a typo); then the EMBEDDED pristine
    // template a builder-role fuse carries (Q2 Decision 2 — the shipped
    // builder needs nothing on disk); then the pinned tjs this repo builds
    // (scripts/build-tjs.mjs).
    let template = env.CLODE_TJS || null;
    if (!template && vfs && vfs.manifest && vfs.manifest.role === 'builder' && vfs.files.get('template/tjs')) {
      // The embedded template is materialized to disk and spawned as the fuse
      // WORKER. On Windows name it .exe so CreateProcess execs the PE
      // unambiguously (a bare extension-less name is fragile). POSIX unchanged.
      template = path.join(work, process.platform === 'win32' ? 'template-tjs.exe' : 'template-tjs');
      fs.writeFileSync(template, Buffer.from(vfs.files.get('template/tjs')));
      fs.chmodSync(template, 0o755);
      // Verify the materialized bytes against the manifest BEFORE exec'ing
      // them: a truncated or corrupted write shows up as a bare exit-127
      // spawn failure with no output (matrix openbsd leg, dispatch #8
      // 2026-07-10) — this converts that into a precise loud error.
      const want = vfs.manifest.template || {};
      const got = fs.statSync(template).size;
      if (want.len && got !== want.len) {
        return fail(`build: embedded template materialized ${got} bytes; manifest says ${want.len} (shim fs write fault?)`);
      }
      if (want.sha256 && sha256File(template) !== want.sha256) {
        return fail('build: embedded template sha256 mismatch after materialization (shim fs write fault?)');
      }
      if (process.platform === 'darwin') {
        // Same discipline as the fuse copy below: a materialized Mach-O may
        // need its ad-hoc signature refreshed before it can exec. On old macOS
        // a fat template can't be signed — thin-to-host-and-retry (see helper).
        const r = codesignAdHoc(template, { log: clodeLog });
        if (!r.ok) return fail(`build: codesign of the embedded template failed:\n${r.error}`);
      }
      clodeLog(`clode: build: using the embedded tjs template -> ${template}`);
    }
    if (!template) template = path.join(ROOT, 'build', 'tjs', 'tjs');
    if (!fs.existsSync(template)) {
      return fail(`build: no tjs template at '${template}' (run scripts/build-tjs.mjs, or set CLODE_TJS)`);
    }
    // CROSS-FUSE (cross-fuse design, prereq 3): CLODE_TARGET_TEMPLATE names a
    // FOREIGN-platform tjs to receive the trailer, while the worker still runs
    // under the host `template` (CLODE_TJS). Sound because canonical-LE makes
    // the compiled bytecode endian-portable and the pinned quickjs-ng gives
    // both engines the same BC_VERSION/fingerprint (attest records both). The
    // host cannot exec the foreign output, so codesign + the PONG/attest smoke
    // are skipped — the target's own oracle (its VM/hardware) proves it.
    const crossTarget = env.CLODE_TARGET_TEMPLATE || null;
    if (crossTarget && !fs.existsSync(crossTarget)) {
      return fail(`build: no CLODE_TARGET_TEMPLATE at '${crossTarget}'`);
    }
    const baseTemplate = crossTarget || template;

    // -- payload staging: the upstream Claude Code bundle (default), or the
    // esbuilt clode-main bundle (--self).
    let stageDir, key;
    if (self) {
      let bundle = env.CLODE_MAIN_BUNDLE;
      if (bundle) {
        if (!fs.existsSync(bundle)) return fail(`build --self: no esbuilt clode-main bundle at '${bundle}' (CLODE_MAIN_BUNDLE)`);
      } else {
        // Newest build/*/clode-main.bundle.cjs. `node scripts/build-clode-main.mjs`
        // now writes ONE unkeyed copy at build/bundle/ (the bundle is platform-
        // INDEPENDENT pure JS — see that script's OUT comment), so this usually
        // finds exactly one candidate. The scan itself stays GENERIC (any
        // build/* subdir) rather than hardcoding build/bundle/: a long-lived dev
        // box's build/ tree can still carry old per-platform-tag-dir bundles
        // from before this layout existed (gitignored litter, never migrated —
        // see scripts/platform-tag.cjs's file header), and "newest wins" must
        // keep working across both layouts without special-casing either.
        let newest = null;
        try {
          for (const d of fs.readdirSync(path.join(ROOT, 'build'))) {
            const c = path.join(ROOT, 'build', d, 'clode-main.bundle.cjs');
            try {
              const m = fs.statSync(c).mtimeMs;
              if (!newest || m > newest.m) newest = { c, m };
            } catch { /* not this dir */ }
          }
        } catch { /* no build dir */ }
        if (!newest) {
          return fail('build --self: no esbuilt clode-main bundle found (run `node scripts/build-clode-main.mjs`, or set CLODE_MAIN_BUNDLE)');
        }
        bundle = newest.c;
      }
      // The bundle freezes clode's own logic as of whenever it was esbuilt, so a
      // stale one silently fuses a WRONG builder — this has already bitten once
      // (the sparc cross-fuse campaign hit an 8-day-stale bundle that crashed
      // inside the fused builder's extractIfNeeded; the fix at the time was a
      // convention — "run build-clode-main.mjs first" — and conventions don't hold,
      // as this same skew recurring here proves). So this is a hard gate, not a
      // warning: fail loud and name the exact command rather than fuse a builder
      // that answers a dead flag surface. Deliberately the simple "newest mtime
      // under libexec/*.cjs" rule (a superset of clode-main's real require graph)
      // rather than a clever per-module dependency walk — obviously correct beats
      // clever here. Applies even when CLODE_MAIN_BUNDLE was set explicitly: an
      // override picks WHICH bundle, not whether it's fresh, and the failure mode
      // (wrong builder fused silently) is identical either way.
      const bm = fs.statSync(bundle).mtimeMs;
      // Exclude AppleDouble sidecars (this mount litters libexec/._*.cjs — see
      // git-gc-fails-appledouble): they are not real sources, and their mtimes
      // can drift independently of the file they shadow, which would make the
      // gate cry wolf on a genuinely fresh bundle.
      const staleSrc = fs.readdirSync(libexec).find((f) => /\.(cjs|mjs|js)$/.test(f) && !f.startsWith('._')
        && fs.statSync(path.join(libexec, f)).mtimeMs > bm);
      if (staleSrc) {
        return fail(`build --self: ${bundle} is older than libexec/${staleSrc} — a stale bundle would fuse a WRONG builder (dead flag surface / extractIfNeeded crash); re-run \`node scripts/build-clode-main.mjs\` and try again`);
      }
      stageDir = path.join(work, 'stage');
      fs.mkdirSync(stageDir, { recursive: true });
      fs.copyFileSync(bundle, path.join(stageDir, 'clode-main.bundle.cjs'));
      // Sibling bundle from the same build-clode-main.mjs run: the naude entry
      // point, pre-esbuilt off the user path (Task 4). Carried alongside
      // clode-main.bundle.cjs so the fuse worker (quaude-fuse.js) can ship it
      // as a builder-role member too. The stale-bundle gate above already
      // guarantees clode-main.bundle.cjs's freshness; since both bundles come
      // from the same script run, no separate freshness gate is needed here.
      fs.copyFileSync(path.join(path.dirname(bundle), 'naude-entry.bundle.cjs'), path.join(stageDir, 'naude-entry.bundle.cjs'));
      clodeLog(`clode: build: staging builder bundle ${bundle} ...`);
    } else {
      // Upstream bundle: resolve + extract + hook via the existing machinery —
      // `libexec` here is the possibly-materialized one (a fused builder rebinds
      // it above), which is why stageUpstreamCli takes it as an argument.
      const staged = stageUpstreamCli({ env, libexec, verbose, prefix: 'build', log: clodeLog });
      if (staged.error) return fail(staged.error);
      key = staged.key;
      stageDir = staged.stageDir;
    }

    // -- ext-dep closure (both roles: quaude requires them at runtime; the
    // builder ships them as the member INPUTS for the quaude it will fuse).
    // Already materialized from the payload under a fused builder; otherwise
    // ensureDeps installs into the deps store unless the deps ship beside
    // this checkout (deps/claude/node_modules — Claude Code's deps, not
    // clode's own; repo/npm layout).
    if (!nmDir) {
      try {
        nmDir = resolveClaudeNmDir({ libexec, here, verbose, env, ROOT });
      } catch (e) {
        return fail(`build: ${(e && e.message) || e}`);
      }
    }

    // The closure travels to the fuse worker as DATA (extras.json below), not
    // code: quaude-fuse.js runs under tjs and cannot require() a shared node
    // module to recompute this itself. Computed HONESTLY from package.json's
    // `dependencies` + their transitive closure (readDirectDeps/
    // computeDepClosure, above) — this used to be a second, independently
    // hand-maintained list living in quaude-fuse.js that silently rotted
    // whenever package.json's dependencies changed without a matching edit
    // there (duplication audit §1).
    // closureVersions is filled as a side effect of the walk (name -> the
    // version each package's OWN package.json declares) — it feeds BOTH the
    // lockfile gate and the manifest BOM below, off one read pass.
    let extDeps;
    const closureVersions = new Map();
    try {
      extDeps = computeDepClosure(nmDir, readDirectDeps(pkgJsonPath), { versions: closureVersions });
    } catch (e) {
      return fail(`build: ${(e && e.message) || e}`);
    }

    // -- dep-closure DRIFT gate (see assertNoUnknownBareSpecifiers's comment,
    // above, for the full rationale): quaude only — --self ships clode's OWN
    // esbuilt bundle, not Claude Code's, so there is nothing to scan for that
    // role (stageDir holds clode-main.bundle.cjs, not cli.cjs/bun-shim.cjs).
    if (!self) {
      try {
        assertNoUnknownBareSpecifiers(
          [path.join(stageDir, 'cli.cjs'), path.join(stageDir, 'bun-shim.cjs')],
          extDeps, libexec, { env });
      } catch (e) {
        return fail(`build: ${(e && e.message) || e}`);
      }
    }

    // -- lockfile gate: node_modules must match package-lock.json (Task b).
    // `npm ci` guarantees this; a dev's `npm install` does not — a
    // stale/dirty node_modules would otherwise silently embed an unpinned
    // dependency version. See assertClosureMatchesLockfile's comment for why
    // this reads targeted files rather than shelling out to `npm ci`.
    try {
      assertClosureMatchesLockfile(closureVersions, lockfilePath);
    } catch (e) {
      return fail(`build: ${(e && e.message) || e}`);
    }

    // -- manifest BOM (Task a): the resolved closure as name@version, so "what
    // is in this quaude?" is answerable at a glance from manifest.json alone,
    // without cross-referencing package.json + node_modules by hand. Sorted
    // the same as extDeps (deterministic, diffable across builds).
    const depsBom = extDeps.map((name) => `${name}@${closureVersions.get(name)}`);

    // -- node-side manifest fields (the worker adds engine/idna/members/fusedAt).
    const extras = {
      quaude: '1', // archive/manifest schema version (shared by both roles)
      role: self ? 'builder' : 'quaude',
      bundleVersion: key, // undefined for --self (no upstream bundle) — dropped by JSON
      clodeVersion: version,
      template: { sha256: sha256File(baseTemplate), len: fs.statSync(baseTemplate).size },
      // The transforms baked into the fused artifact beyond the members
      // themselves: the extractor that hooked cli.cjs (memo §6.9 — staleness of
      // the frozen entry transforms is detectable via these + bundleVersion).
      hooks: { 'extract-claude-js.cjs': sha256File(path.join(libexec, 'extract-claude-js.cjs')) },
      // The ext-dep closure quaude-fuse.js must embed as members (duplication
      // audit §1) — package.json's dependencies + their transitive closure,
      // walked from nmDir just above. NOT part of the quaude manifest (the
      // worker consumes this from extras.json but never re-emits it).
      deps: extDeps,
      // The declared bill of materials — name@version for every package in
      // the closure just above — carried through to manifest.json verbatim
      // (Task a). Distinct from `deps` (bare names, the worker's own member-
      // collection input, never re-emitted): `bom` IS re-emitted, into the
      // shipped manifest, so a built quaude states its own closure without
      // needing extras.json (which does not ship).
      bom: depsBom,
      // The clode that built this quaude. Its patched in-app updater calls back
      // here (CLODE_SELF): a baked binary cannot rebuild itself. null when unknown,
      // so the updater fails loud rather than spawning something wrong. NOTE:
      // opts.self, not the local `self` boolean above (that one means "fuse the
      // builder itself", i.e. --self — an unrelated flag that happens to share a name).
      builder: opts.self || null,
    };

    // -- sign-then-append (memo §6.1): copy template -> re-sign the copy while
    // it is still a plain Mach-O -> the worker appends. Never sign after
    // appending.
    const signedBase = path.join(work, 'template-signed');
    const extrasPath = path.join(work, 'extras.json');
    fs.copyFileSync(baseTemplate, signedBase);
    fs.chmodSync(signedBase, 0o755);
    if (process.platform === 'darwin' && !crossTarget) {
      // Normal case: signedBase is a copy of `template`, already thinned above if
      // the host couldn't sign the fat binary — so this signs a host-arch slice
      // and succeeds first try. The retry logic is kept for the CLODE_TJS path
      // (an explicit fat template that skipped the embedded-materialize branch).
      const r = codesignAdHoc(signedBase, { log: clodeLog });
      if (!r.ok) return fail(`build: codesign of the template copy failed:\n${r.error}`);
      clodeLog('clode: build: template copy re-signed (ad-hoc)');
    }
    fs.writeFileSync(extrasPath, JSON.stringify(extras));

    // -- fuse, under the template itself.
    clodeLog(`clode: build: fusing ${out} ...`);
    const w = await spawnRun(template, ['run', path.join(libexec, 'quaude-fuse.js'),
      signedBase, stageDir, path.join(libexec, 'node-shim'), nmDir,
      path.join(libexec, 'quaude-bootstrap.mjs'), extrasPath, out,
      // --self embeds the PRISTINE base template as a member (Decision 2) so a
      // fused builder can materialize+exec it as the fuse worker with nothing
      // else on disk. This MUST be baseTemplate (the target-platform base,
      // = crossTarget for a cross-fuse), NOT `template` (the HOST engine that
      // runs THIS worker) — else a cross-fused builder ships a host-arch
      // template it cannot exec on the target. Native --self: baseTemplate ===
      // template, so this is unchanged there. The quaude role embeds nothing
      // (its base IS the signed copy).
      ...(self ? [baseTemplate] : [])], { env, timeout: 300000 * SCALE });
    if (w.status !== 0) {
      let extra = '';
      if (!w.stdout && !w.stderr) {
        // A bare status with no output = the child never ran (exec failed
        // inside the spawn; 127 is libuv's could-not-exec convention). Say
        // what we tried to exec so a remote CI log is diagnosable.
        try {
          extra = `\n(no worker output — exec failure? template=${template} size=${fs.statSync(template).size})`;
        } catch {
          extra = `\n(no worker output — exec failure? template=${template} MISSING)`;
        }
      }
      return fail(`build: fuse worker failed (${describeExit(w)}):\n${w.stdout}${w.stderr}${extra}`);
    }
    clodeLog(w.stdout.trimEnd());

    // Cross-fuse: the trailer is written to a foreign-platform base the host
    // cannot exec, so stop here — no PONG/attest/version smoke. The output is
    // proven on the target's own oracle (its VM/hardware). attest still runs
    // THERE (it verifies member shas from the trailer, arch-independent).
    if (crossTarget) {
      stdout.write(`clode: cross-fused ${out} (${fs.statSync(out).size} bytes, target ${path.basename(crossTarget)}) — smoke on the target\n`);
      return 0;
    }

    if (self) {
      // -- builder smoke: its own flags must answer, with NODE_PATH stripped
      // (self-containment proof at the same strength as the quaude smoke).
      clodeLog('clode: build: smoke --version/--help ...');
      const smokeEnv = { ...env };
      delete smokeEnv.NODE_PATH;
      const v = await spawnRun(out, ['--version'], { env: smokeEnv, cwd: work, timeout: 120000 * SCALE });
      if (v.status !== 0 || !/^clode /.test(v.stdout)) {
        stderr.write(`clode: build --self: SMOKE FAILED — the fused builder did not answer --version\n`);
        stderr.write(`clode: build --self: ${describeExit(v)} stdout:\n${v.stdout}\nstderr:\n${v.stderr}\n`);
        return 1;
      }
      const h = await spawnRun(out, ['--help'], { env: smokeEnv, cwd: work, timeout: 120000 * SCALE });
      if (h.status !== 0 || !/clode build/.test(h.stdout)) {
        stderr.write(`clode: build --self: SMOKE FAILED — the fused builder did not answer --help\n`);
        stderr.write(`clode: build --self: ${describeExit(h)} stdout:\n${h.stdout}\nstderr:\n${h.stderr}\n`);
        return 1;
      }
      stdout.write(`clode: fused ${out} (${fs.statSync(out).size} bytes, native clode builder)\n`);
      stdout.write(`clode: smoke: --version + --help ok — run '${out} build' to fuse a quaude\n`);
      return 0;
    }

    // -- smoke 1: the shared contract (smokeTarget, duplication audit §2) —
    // mock + NODE_PATH-stripped -p PONG + assert-the-POST-landed. NODE_PATH is
    // stripped so a pass PROVES the binary is self-contained.
    clodeLog('clode: build: smoke -p against the canned Messages mock ...');
    const smoke = await smokeTarget(out, { spawnRun, env, cwd: work, timeout: 120000 * SCALE });
    if (!smoke.ok) {
      stderr.write(`clode: build: SMOKE FAILED — the fused quaude did not complete the mock round-trip\n`);
      stderr.write(`clode: build: ${smoke.how} posted=${smoke.posted} stdout:\n${smoke.stdout}\nstderr:\n${smoke.stderr}\n`);
      return 1;
    }

    // -- smoke 2: attest must verify every member from the trailer just written
    // (quaude-only — naude has no manifest/trailer to attest).
    const attest = await spawnRun(out, ['--quaude-attest'], { env, cwd: work, timeout: 120000 * SCALE });
    if (attest.status !== 0 || !/quaude-attest: all members verified/.test(attest.stdout)) {
      stderr.write(`clode: build: ATTEST FAILED (${describeExit(attest)}):\n${attest.stdout}\n${attest.stderr}\n`);
      return 1;
    }

    stdout.write(`clode: fused ${out} (${fs.statSync(out).size} bytes, bundle ${key})\n`);
    stdout.write(`clode: smoke: PONG round-trip ok, attest ok — run '${out}' to use it\n`);
    return 0;
  } finally {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

module.exports = {
  clodeBuild, parseBuildArgs, startPongMock, cannedSSE, smokeTarget, timeoutScale, codesignAdHoc, describeExit,
  readDirectDeps, computeDepClosure, assertClosureMatchesLockfile,
  scanBareSpecifiers, specifierPackageName, isBuiltinSpecifier, shimProvidedModules,
  assertNoUnknownBareSpecifiers, KNOWN_UNREACHABLE, resolveClaudeNmDir,
};
