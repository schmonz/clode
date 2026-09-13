'use strict';
// cli-surface.cjs — clode's command-line surface AS DATA: one literal (SURFACE)
// that declares every verb, its subject class and members, its flags, and the
// CLODE_* names it absorbs; a renderer that turns that literal into --help; and a
// parser that matches argv against it. Nothing here does any work — no fs, no
// child_process, no requires at all (clode-self-deps' stdlib sweep sees a module
// with zero imports) — so it is safe to require from the dispatch spine, from
// scripts/stage0.mjs's checkout entry, and from tests.
//
// WHY A TABLE, not the 213-line if-chain over args[0] with inline flag sniffing
// (`args.slice(1).includes('--naude')`) that used to be the whole surface: in that
// shape every verb documented itself, in prose, next to its own branch. That is how
// `--target` came to mean "cross-build a naude" with --naude and "cross-build a
// quaude" without it, with the help text explaining the fallthrough — nobody decided
// that, it accumulated. One literal gives the surface a single place to READ, a
// single place to CHANGE, and something a test can compare help and argv against
// (test/cli-surface.test.cjs; the --target test is the one that makes that
// particular defect structurally unrepeatable rather than merely fixed).
//
// ADDING A VERB is therefore one edit: a new entry in SURFACE.verbs (shipped) or in
// CHECKOUT_ONLY_VERBS (checkout-only — see surfaceFor), plus the branch in
// clode-main.cjs's dispatch that actually does the work. Help, the usage line, the
// subject list and the argv parser all follow from the entry; none of them names a
// verb of its own.

// The one-line description at the top of --help. Here rather than inline in
// renderHelp for the same reason the verbs are: it is surface text, and surface text
// lives in this file.
const TAGLINE = 'build a standalone Claude Code binary for your machine.';

// THE SURFACE. Every field, and what it is FOR:
//   summary       one line, lowercase, no trailing period — rendered under the
//                 verb's usage line in --help.
//   subjectClass  the NOUN CLASS of the verb's positional: 'product' for what
//                 clode builds, 'ingredient' for what clode fetches. null means the
//                 verb takes no positional at all. renderHelp uses it as the label
//                 for the subject list ("products:", "ingredients:"), and parseArgv
//                 uses it to say WHAT it rejected when a positional is not a member.
//   subjects      the members of that class: name -> one-line description. This is
//                 the complete set of accepted positionals; anything else is an
//                 error, and every member here is named in --help (asserted).
//   defaultSubject  which member a bare `clode <verb>` means. null when there is no
//                 positional (or no default), in which case the positional is
//                 required and parseArgv says so.
//   tail          OPTIONAL second positional, as { name, only, doc }: a free-form
//                 value (not a member of a class), accepted AFTER the subject, and
//                 only for the subject `only` names. Exactly one verb has one
//                 (fetch's channel/version); it is declared rather than left to
//                 dispatch because an accepted-but-undocumented positional is the
//                 same lie as a documented-but-ignored flag.
//   ownsArgv      true when the verb's own MODULE parses what follows (build and
//                 bootstrap hand cmd.rest to clode-build.cjs's parseBuildArgs). For
//                 those, a flag-level complaint from parseArgv is NOT the answer —
//                 the module prints its own message, with its own usage line, so there
//                 is exactly one unknown-argument contract per verb. For every other
//                 verb the table IS the whole contract, so a flag error is fatal here.
//                 Absent/false is the safe default: an unrecognised flag is refused
//                 rather than silently ignored.
//   flags         flag name -> one line. Each takes a VALUE (`--out PATH`); the
//                 boolean ones are the globals below, which are LEADING-only. A
//                 flag's text is shared vocabulary, not per-verb prose: two verbs
//                 that take the same flag must describe it identically modulo the
//                 subject noun, which is what keeps --target meaning one thing.
//   env           the CLODE_* names this verb absorbs, as { name, doc } entries,
//                 rendered as the verb's own environment block in --help. These are a
//                 VERBATIM carry of the seven lines the old hand-written help block
//                 carried, placed against the verb whose branch reads them — measured
//                 by grepping libexec/ for each name, not guessed:
//                   CLODE_NO_WATCH  clode-watch.cjs, fired from build's branch
//                   CLODE_TJS       clode-build.cjs + clode-extract.cjs
//                   CLODE_CHANGELOG_URL  clode-update.cjs (fetch) AND clode-watch.cjs
//                                   (read-anthropic-tea-leaves) — so BOTH declare it
//                   CLODE_TARGET_TEMPLATE  clode-build.cjs:1107 + :1514, the quaude cross
//                                   path (`build --target`) AND the bootstrap cross path —
//                                   so BOTH declare it. The first cut had it on bootstrap
//                                   only, which is what "measured, not guessed" is supposed
//                                   to prevent; re-measure by grepping, do not infer from
//                                   which verb the name sounds like it belongs to.
//                 The four that no single verb owns are SURFACE.env below. Phase 3b's task 1
//                 classified every CLODE_* name shipped code reads (test/env-verdicts.cjs);
//                 task 2 then EDITS these entries for every name verdict 'absorbed' rather
//                 than creating them from scratch — CLODE_TEMPLATES_MANIFEST/_BASEURL/_BLOB,
//                 CLODE_RELEASE_BASE, CLODE_TJS_PIN and CLODE_ENGINE_RECIPE (build AND
//                 bootstrap, same reasoning as CLODE_TARGET_TEMPLATE above), CLODE_FETCH_PLATFORM
//                 (fetch), CLODE_VERSION_DIR (global, beside its CLODE_CLAUDE_BIN sibling), and
//                 CLODE_ALLOW_FOREIGN_CARVE=1 (build only — see its own comment there for why it
//                 stays an env var and not a flag). test/env-verdicts.test.cjs's third assertion
//                 (every 'absorbed' verdict must appear in surfaceFor('checkout')'s rendered
//                 help) is what makes "help must never stop documenting a name it documented
//                 before" a property a red test enforces, not a hope.
const SURFACE = {
  verbs: {
    build: {
      summary: 'build a standalone Claude Code binary',
      subjectClass: 'product',
      subjects: { quaude: 'the pinned tjs runtime + the compiled Claude Code bundle',
                  naude: 'a Node SEA; Node hosts only' },
      defaultSubject: 'quaude',
      // clode-build.cjs's parseBuildArgs parses the rest (it also takes
      // --list-targets and --keep-going, which are build-internal rather than surface
      // vocabulary), so its message — not parseArgv's — is what a bad build argv gets.
      ownsArgv: true,
      // --target's text is the SAME SENTENCE fetch uses, with only the subject noun
      // swapped — enforced by test/cli-surface.test.cjs. The brief's draft wording
      // ('cross-build for PLATFORM-ARCH instead of this machine' here, 'fetch the
      // ingredient for …' under fetch) FAILED that test: two sentences, two shades of
      // meaning, which is precisely how --target acquired a second meaning the first
      // time. One sentence: the subject is for another machine, whatever the verb does
      // with it.
      // --out's text is PER-PRODUCT on purpose, because the default IS per-product and
      // --help is the only documentation inside a shipped binary — an artifact that
      // misreports where it wrote its output is the same lie as a documented-but-ignored
      // flag. MEASURED, not assumed: quaude's default comes from clode-build.cjs's
      // resolveBuildOut (the bare name `quaude`, `.exe` iff the build is for windows —
      // i.e. ./quaude), while naude's comes from seaBin -> platform-tag.cjs's seaOut,
      // which is <repo>/build/<artifact-name>/naude, NOT ./naude. The pre-table help
      // claimed a default only for the quaude line for exactly this reason; saying
      // "./<product>" for both was the regression.
      flags: { '--target': 'the product is for PLATFORM-ARCH, not this machine',
               '--out': 'write the artifact here (quaude defaults to ./quaude; naude defaults to '
                 + "build/<artifact-name>/naude under clode's root)" },
      env: [{ name: 'CLODE_NO_WATCH=1',
              doc: 'disable the opportunistic update-signal check that runs during a build' },
            { name: 'CLODE_TJS',
              doc: "tjs template binary for 'clode build' (default: the blobulated builder's "
                + 'own embedded template, else build/tjs/tjs)' },
            // DECLARED ON BOTH VERBS, like CLODE_CHANGELOG_URL. It was bootstrap-only, and
            // that was a measurement miss, not a decision: the readers are
            // clode-build.cjs:1107 and :1514 — both on the QUAUDE cross path, reached by
            // `clode build [quaude] --target`, never by naude — and .github/workflows/ci.yml
            // sets it for a `build --target linux-x64` quaude. A name a verb absorbs but
            // does not document is invisible in a shipped binary, where --help is the only
            // documentation there is.
            { name: 'CLODE_TARGET_TEMPLATE',
              doc: 'an operator-built engine for --target, used INSTEAD of the published template' },
            // PHASE 3B TASK 2: the remaining --target/--list-targets inputs, all read from
            // the SAME resolveManifest/obtainEngine call chain CLODE_TARGET_TEMPLATE's
            // comment above already documents as reached by `build --target` AND
            // `bootstrap --target` — measured by tracing clode-build.cjs:1129-1189, not
            // guessed, so all six are declared on BOTH verbs, same as CLODE_TARGET_TEMPLATE.
            { name: 'CLODE_TEMPLATES_MANIFEST',
              doc: 'a local templates manifest file for --target / --list-targets, instead of '
                + "fetching this clode version's published one (offline builds and tests)" },
            { name: 'CLODE_TEMPLATES_BASEURL',
              doc: "explicit base URL to fetch --target's templates manifest and engine from, "
                + 'overriding CLODE_RELEASE_BASE (an offline mirror, or a pinned release)' },
            { name: 'CLODE_TEMPLATES_BLOB',
              doc: 'a local, already-downloaded templates blob to read the --target engine '
                + 'from instead of range-fetching it (pairs with CLODE_TEMPLATES_MANIFEST for '
                + 'an offline build)' },
            { name: 'CLODE_RELEASE_BASE',
              doc: "override the GitHub release download root that --target's templates "
                + "manifest and engine resolve against (default: "
                + 'https://github.com/schmonz/clode/releases/download)' },
            { name: 'CLODE_TJS_PIN',
              doc: "override this clode's own tjs pin, checked against a --target engine "
                + "template's pin to catch a mismatch (default: derived from PINS.md in a "
                + 'checkout)' },
            { name: 'CLODE_ENGINE_RECIPE',
              doc: "override this clode's own engine-recipe fingerprint, checked against a "
                + "--target engine template's recipe to catch a mismatch (default: baked in, "
                + "else derived from the checkout's own sources)" },
            // CLODE_ALLOW_FOREIGN_CARVE=1 is deliberately NOT a flag (see the block comment
            // just above SURFACE.verbs.build's provider-carve guard in clode-build.cjs, and
            // BACKLOG.md's "P1: a quaude built from a foreign-carved provider LIES about its
            // platform"): it disables the check that the staged provider was carved for THIS
            // build's target, which is the guard standing between a build and that P1 until
            // phase 4 keys the provider store by platform. A discoverable --allow-foreign-carve
            // flag would invite reaching for it to get past a build failure instead of fetching
            // a matching provider; staying an awkward env var, documented here so --help (the
            // only documentation inside a shipped binary) does not hide that it exists, is the
            // deliberate choice. Only reached on the quaude path (`!naude && !self`), so this
            // is NOT declared on bootstrap.
            { name: 'CLODE_ALLOW_FOREIGN_CARVE=1',
              doc: 'disable the check that the staged provider was carved for this build\'s '
                + 'target platform — a safety check, not a template selector; only for '
                + 'deliberately reproducing a foreign-carve mismatch, never a normal build input' }],
    },
    fetch: {
      summary: 'fetch a build ingredient',
      subjectClass: 'ingredient',
      subjects: { claude: 'the upstream binary quaude is built from',
                  node: 'the pinned runtime naude embeds' },
      // NO DEFAULT (task 6): bare `clode fetch` was one of the spellings the break
      // removed, so the ingredient is required and its absence is a usage error the
      // table produces, not a silent choice dispatch makes.
      defaultSubject: null,
      // The one verb with a SECOND positional. It is declared here for the same
      // reason everything else is: `clode fetch [channel|version]` used to exist,
      // still works (test/run.mjs seeds the suite with a pinned provider that way,
      // and man(1) documented it), and an accepted-but-undocumented positional is
      // exactly the lying surface this table exists to end. `name` is what help
      // renders and `only` names the ingredient it applies to, which dispatch
      // enforces.
      tail: { name: '[channel|version]', only: 'claude',
              doc: 'which upstream release to fetch (default: the autoUpdatesChannel setting, else latest)' },
      flags: { '--target': 'the ingredient is for PLATFORM-ARCH, not this machine' },
      env: [{ name: 'CLODE_CHANGELOG_URL',
              doc: 'release-notes source for the post-update signals digest' },
            // PHASE 3B TASK 2: measured at clode-update.cjs:82-84 (fetchPlatform, called
            // from clodeUpdate's `fetch claude` path) and clode-main.cjs:199 (the `fetch
            // claude --target` usage error already tells the user to set this) — a real
            // build-input selector that was user-facing in an error message before it was
            // ever in this table.
            { name: 'CLODE_FETCH_PLATFORM',
              doc: 'choose the upstream provider platform-arch to fetch, overriding host '
                + "detection (the provider store has no platform axis — see 'fetch claude "
                + "--target')" }],
    },
    'read-anthropic-tea-leaves': {
      summary: "infer Anthropic's direction of travel from the changelog (warn-only, never downloads)",
      subjectClass: null,
      subjects: {},
      defaultSubject: null,
      flags: {},
      env: [{ name: 'CLODE_CHANGELOG_URL',
              doc: 'release-notes source for the post-update signals digest' }],
    },
  },
  globals: { '--help': 'show this help and exit', '--version': "print clode's own version and exit",
             '--verbose': "show clode's progress; silent by default" },
  // The CLODE_* names no single verb owns — every command reads them (CLODE_VERBOSE is
  // the --verbose global's environment twin; CLODE_CACHE/CLODE_NODE are resolved in
  // clode-paths.cjs, which everything goes through). Also a verbatim carry: --help is
  // the ONLY documentation inside a released clode binary (package.json ships no `man`
  // and no workflow installs man/clode.1), so a name that leaves this table leaves the
  // artifact's documentation entirely.
  env: [{ name: 'CLODE_VERBOSE=1', doc: 'same as --verbose' },
        { name: 'CLODE_CLAUDE_BIN', doc: 'upstream claude binary to extract from' },
        // PHASE 3B TASK 2: the very next tier of the SAME resolveClaudeBin precedence chain
        // CLODE_CLAUDE_BIN documents just above ("CLODE_CLAUDE_BIN > CLODE_VERSION_DIR >
        // provider `current`", clode-resolve.cjs:93-103) — same kind of candidate as its
        // sibling, declared beside it for the same reason.
        { name: 'CLODE_VERSION_DIR',
          doc: 'explicit installed-version directory to extract from (checked after '
            + 'CLODE_CLAUDE_BIN, before the clode-managed provider)' },
        { name: 'CLODE_NODE', doc: 'host node' },
        { name: 'CLODE_CACHE', doc: 'extracted-bundle cache dir' }],
};

// Verbs the CHECKOUT entry point has and a shipped binary does not (surfaceFor
// below composes them onto SURFACE). The distinction is not cosmetic: `bootstrap`
// builds the BUILDER, from a source checkout, and every call site is the checkout's
// Node clode (cross-blobulate/action.yml, build-leg, release.yml) — never
// clode-builds-clode. Keeping it out of SURFACE.verbs makes "a shipped clode cannot
// bootstrap" a property of DATA instead of a conditional somewhere in dispatch.
//
// Task 6 added the entry, and that really was the whole change: one entry in one
// table, plus the branch in clode-main.cjs that runs it. `bootstrap` takes no
// positional because the thing it builds is not a product — it is clode.
const CHECKOUT_ONLY_VERBS = {
  bootstrap: {
    summary: 'build clode itself from this source checkout (the builder, not a product)',
    subjectClass: null,
    subjects: {},
    defaultSubject: null,
    // The one verb that is NOT invoked as `clode <verb>`: there is no `clode` that
    // accepts bootstrap (bin/ is empty, and a shipped binary refuses it — that is the
    // whole point of CHECKOUT_ONLY_VERBS), so renderHelp's hardcoded `clode ` prefix was
    // advertising an invocation that does not exist. Optional, defaulting to 'clode', so
    // every other verb's entry stays as short as it was; dispatch's own refusal message
    // and man/clode.1 already said `node scripts/stage0.mjs bootstrap`, and now help
    // agrees with both.
    invocation: 'node scripts/stage0.mjs',
    // same parser as build — see SURFACE.verbs.build, which carries the same note: it
    // also takes --list-targets and --keep-going (build-internal rather than surface
    // vocabulary, and boolean where every flag in this table takes a value). bootstrap
    // really does accept them — `node scripts/stage0.mjs bootstrap --list-targets`
    // prints the target list — so parseBuildArgs's usage line names them for both verbs.
    ownsArgv: true,
    // --target reads exactly as it does for a product: the artifact is for another
    // machine. It is the same cross-blobulate path a `build quaude --target` takes
    // (the foreign engine template becomes the base), which is why it composes here
    // and why the old `--self and --target are different build targets` refusal went
    // away with the flags.
    flags: { '--target': 'the builder is for PLATFORM-ARCH, not this machine',
             '--out': 'write the artifact here (default ./clode-native)' },
    env: [{ name: 'CLODE_MAIN_BUNDLE',
            doc: 'the esbuilt clode-main bundle to embed (default: the newest '
              + 'build/*/clode-main.bundle.cjs; build it with `node scripts/build-clode-main.mjs`)' },
          { name: 'CLODE_TARGET_TEMPLATE',
            doc: 'an operator-built engine for --target, used INSTEAD of the published template' },
          // PHASE 3B TASK 2: same six names as build's --target/--list-targets block above,
          // reached through the identical resolveManifest/obtainEngine call chain (`bootstrap
          // --target` runs clodeBuild with product 'clode', which parses the SAME argv before
          // branching on `self` — see clode-build.cjs:1129-1189, reached before the self/naude
          // split). CLODE_ALLOW_FOREIGN_CARVE is NOT among them: its guard is gated `!self`,
          // so bootstrap never reaches it.
          { name: 'CLODE_TEMPLATES_MANIFEST',
            doc: 'a local templates manifest file for --target / --list-targets, instead of '
              + "fetching this clode version's published one (offline builds and tests)" },
          { name: 'CLODE_TEMPLATES_BASEURL',
            doc: "explicit base URL to fetch --target's templates manifest and engine from, "
              + 'overriding CLODE_RELEASE_BASE (an offline mirror, or a pinned release)' },
          { name: 'CLODE_TEMPLATES_BLOB',
            doc: 'a local, already-downloaded templates blob to read the --target engine '
              + 'from instead of range-fetching it (pairs with CLODE_TEMPLATES_MANIFEST for '
              + 'an offline build)' },
          { name: 'CLODE_RELEASE_BASE',
            doc: "override the GitHub release download root that --target's templates "
              + "manifest and engine resolve against (default: "
              + 'https://github.com/schmonz/clode/releases/download)' },
          { name: 'CLODE_TJS_PIN',
            doc: "override this clode's own tjs pin, checked against a --target engine "
              + "template's pin to catch a mismatch (default: derived from PINS.md in a "
              + 'checkout)' },
          { name: 'CLODE_ENGINE_RECIPE',
            doc: "override this clode's own engine-recipe fingerprint, checked against a "
              + "--target engine template's recipe to catch a mismatch (default: baked in, "
              + "else derived from the checkout's own sources)" }],
  },
};

// surfaceFor(kind) — the table as a given ENTRY POINT sees it.
//   'shipped'  — the built clode binary: SURFACE exactly.
//   'checkout' — scripts/stage0.mjs in a source checkout: SURFACE plus
//                CHECKOUT_ONLY_VERBS.
// Returns a fresh TOP-LEVEL object with a fresh `verbs` map. Nothing deeper is copied:
// `globals`, `env` and every verb DEFINITION are the same objects SURFACE holds, so
// `surfaceFor('shipped').globals['--x'] = 1` really does write through to SURFACE. That
// sharing is deliberate for the definitions — one definition per verb, whoever asks — and
// this comment used to claim the copy was defensive ("the caller cannot mutate SURFACE
// through it"), which was simply false. Nothing in this repo mutates a returned surface;
// the guarantee on offer is "the two entry points get different verb MAPS", not immunity.
// `elsewhere` is the OTHER half of the split: the verbs this entry point does not
// have BUT SOMETHING ELSE DOES. It exists so that a shipped clode asked to bootstrap
// can say where bootstrap lives instead of "unknown command" — still a property of
// the data (parseArgv reads the field; no conditional anywhere names 'bootstrap').
function surfaceFor(kind) {
  if (kind === 'shipped') {
    return { verbs: Object.assign({}, SURFACE.verbs), globals: SURFACE.globals, env: SURFACE.env,
             elsewhere: Object.assign({}, CHECKOUT_ONLY_VERBS) };
  }
  if (kind === 'checkout') {
    return { verbs: Object.assign({}, SURFACE.verbs, CHECKOUT_ONLY_VERBS), globals: SURFACE.globals, env: SURFACE.env,
             elsewhere: {} };
  }
  throw new Error(`cli-surface: unknown entry-point kind '${kind}' (want 'shipped' or 'checkout')`);
}

function has(obj, key) { return Object.prototype.hasOwnProperty.call(obj, key); }

// Two columns, aligned to the widest name in THIS list, wrapped at WRAP columns with
// continuation lines hanging under the text column. Data in, text out. The wrap exists
// because the hand-written help block this renderer replaced wrapped its own long lines
// by hand (its CLODE_TJS entry ran to three), and a table-driven help that emits a
// 140-column line would be a readability regression dressed up as a refactor.
const WRAP = 92;

// Greedy word wrap to `room` columns. Never splits a word (a long URL or path stays
// intact and simply overhangs), and never returns an empty list, so the caller always
// has a first line to put the name against.
function wrapText(text, room) {
  const out = [];
  let line = '';
  for (const word of String(text).split(' ')) {
    if (line && line.length + 1 + word.length > room) { out.push(line); line = word; continue; }
    line = line ? line + ' ' + word : word;
  }
  out.push(line);
  return out;
}

function columns(pairs, indent) {
  let width = 0;
  for (const [name] of pairs) if (name.length > width) width = name.length;
  const gutter = indent + ' '.repeat(width + 2);
  const room = Math.max(WRAP - gutter.length, 24);   // never wrap into nothing
  const out = [];
  for (const [name, text] of pairs) {
    const wrapped = wrapText(text, room);
    out.push(indent + name + ' '.repeat(width - name.length + 2) + wrapped[0]);
    for (let i = 1; i < wrapped.length; i++) out.push(gutter + wrapped[i]);
  }
  return out;
}

// renderHelp(version, surface) -> the whole of `clode --help`, newline-terminated.
// Every verb name, subject name and flag name in the output comes from the table —
// there is no per-verb template here, which is what test/cli-surface.test.cjs's
// first test checks (help cannot omit or rename what the table declares).
function renderHelp(version, surface) {
  const lines = [`clode ${version} — ${TAGLINE}`, '', 'Usage:'];
  const verbs = Object.keys(surface.verbs);
  for (let i = 0; i < verbs.length; i++) {
    const verb = verbs[i];
    const def = surface.verbs[verb];
    const subjects = Object.keys(def.subjects);
    const positional = subjects.length ? ` [${subjects.join(' | ')}]` : '';
    const tail = def.tail ? ` ${def.tail.name}` : '';
    const flags = Object.keys(def.flags);
    // `invocation` — how this verb is actually TYPED. Defaults to 'clode' (every shipped
    // verb); a checkout-only verb overrides it, because `clode bootstrap` is not a thing
    // anyone can run. Help must never print a command line that does not exist.
    lines.push(`  ${def.invocation || 'clode'} ${verb}${positional}${tail}${flags.length ? ' [options]' : ''}`);
    lines.push(`      ${def.summary}`);
    if (subjects.length) {
      lines.push(`      ${def.subjectClass}s:`);
      lines.push(...columns(subjects.map((s) => [s, def.subjects[s] + (s === def.defaultSubject ? ' (default)' : '')]), '        '));
    }
    if (def.tail) {
      lines.push(...columns([[def.tail.name,
        def.tail.doc + (def.tail.only ? ` (${def.tail.only} only)` : '')]], '      '));
    }
    if (flags.length) {
      lines.push('      options:');
      lines.push(...columns(flags.map((f) => [f, def.flags[f]]), '        '));
    }
    if (def.env.length) {
      lines.push('      environment:');
      lines.push(...columns(def.env.map((e) => [e.name, e.doc]), '        '));
    }
    if (i < verbs.length - 1) lines.push('');
  }
  lines.push('');
  // The globals are LEADING-only (`clode --help`, not `clode build --help`): after a
  // verb, argv belongs to the verb. The heading says so rather than leaving a reader
  // to discover it from a usage error.
  lines.push('Options (before the command):');
  lines.push(...columns(Object.keys(surface.globals).map((g) => [g, surface.globals[g]]), '  '));
  if (surface.env && surface.env.length) {
    lines.push('');
    lines.push('Key environment overrides (any command):');
    lines.push(...columns(surface.env.map((e) => [e.name, e.doc]), '  '));
  }
  return lines.join('\n') + '\n';
}

// parseArgv(argv, surface) -> { verb, subject, flags, rest, error }
//
//   verb     the resolved verb name, or undefined when argv names no verb in this
//            surface. `verb` being set is the ROUTING answer: dispatch has a branch
//            to run.
//   subject  the resolved positional (a member of the verb's subjects), or
//            undefined. Falls back to nothing — dispatch applies defaultSubject,
//            because "what a bare verb means" is a dispatch decision the table
//            declares, not a parse result.
//   tail     the verb's declared SECOND positional (def.tail), when argv supplied
//            one; undefined otherwise. Only ever set for a verb that declares it.
//   flags    { '--name': value } for the verb's flags, and { '--name': true } for
//            leading globals.
//   globalOrder  the leading globals in the order argv gave them. Dispatch acts on the
//            FIRST print-and-exit one, so `clode --help --version` prints help and
//            `clode --version --help` prints the version — which is what each did
//            before this table existed. An object's key order would carry the same
//            information, but only by accident of insertion; this says it.
//   rest     argv AFTER the verb, with a recognised subject removed: what a verb's
//            own module gets handed (clode-build.cjs's parseBuildArgs owns build's
//            argv contract — imported, not re-implemented, so there is exactly one
//            unknown-argument message).
//   error    the FIRST complaint, as the text dispatch prints after "clode: ".
//            undefined when argv matches the table exactly.
//   errorKind  WHICH LAYER complained: 'verb' (no such command here), 'subject' (the
//            positional is missing, unknown, or not wanted) or 'flag' (everything
//            after it). The distinction is load-bearing, not decoration: verb and
//            subject errors are the TABLE's to reject — dispatch exits 2 on them —
//            while a flag error belongs to the verb's own module, which owns its argv
//            contract (clode-build.cjs's parseBuildArgs) and prints its own usage
//            line. Without the kind, dispatch would have to pattern-match the text.
//
// Shape: leading globals, then the verb, then an optional subject, then flags. A
// global after the verb is an unknown argument, not a global (that is what makes
// `clode build --help` a build error rather than clode's help).
function parseArgv(argv, surface) {
  const args = Array.isArray(argv) ? argv : [];
  const flags = {};
  const globalOrder = [];
  let i = 0;
  while (i < args.length && has(surface.globals, args[i])) {
    flags[args[i]] = true;
    globalOrder.push(args[i]);
    i += 1;
  }

  const token = args[i];
  if (token === undefined || !has(surface.verbs, token)) {
    // The message dispatch has always printed for an unrecognised command, including
    // the empty one (`clode` with no argv at all): clode BUILDS targets, so there is
    // nothing for a stray argv to fall through to. The ONE exception is a verb that
    // exists at the OTHER entry point (surface.elsewhere): a shipped clode asked to
    // bootstrap should say where bootstrap lives. That is read out of the data, so
    // nothing here names a verb.
    const elsewhere = surface.elsewhere || {};
    const error = has(elsewhere, token)
      ? `clode ${token} runs only from a source checkout (node scripts/stage0.mjs ${token}), not from a built clode binary`
      : `unknown command '${token === undefined ? '' : token}'`;
    return { verb: undefined, subject: undefined, tail: undefined, flags, globalOrder, rest: [], error, errorKind: 'verb' };
  }
  const verb = token;
  const def = surface.verbs[verb];
  const after = args.slice(i + 1);

  let subject;
  let tail;
  let error;
  let errorKind;
  const complain = (kind, text) => { if (!error) { error = text; errorKind = kind; } };
  let consumed = 0;
  if (after.length > 0 && !after[0].startsWith('-')) {
    if (has(def.subjects, after[0])) {
      subject = after[0];
      consumed = 1;
    } else if (def.subjectClass === null) {
      complain('subject', `clode ${verb} takes no argument, got '${after[0]}'`);
    } else {
      complain('subject', `unknown ${def.subjectClass} '${after[0]}' for clode ${verb} (choose: ${Object.keys(def.subjects).join(', ')})`);
    }
  } else if (def.subjectClass !== null && !def.defaultSubject) {
    // A required positional, absent. The table knows it is required (no
    // defaultSubject), so the table's parser is where that is said — this is what
    // makes bare `clode fetch` a usage error rather than a silent 'claude'.
    complain('subject', `clode ${verb} needs ${/^[aeiou]/.test(def.subjectClass) ? 'an' : 'a'} ${def.subjectClass} (choose: ${Object.keys(def.subjects).join(', ')})`);
  }
  // The declared second positional, if this verb has one and argv supplied it.
  if (def.tail && consumed === 1 && after.length > 1 && !after[1].startsWith('-')) {
    tail = after[1];
    consumed = 2;
  }
  const rest = after.slice(consumed);

  for (let j = 0; j < rest.length; j++) {
    const tok = rest[j];
    if (has(def.flags, tok)) {
      // Every flag in the table takes a value; the boolean ones are the globals.
      const value = (j + 1 < rest.length && !rest[j + 1].startsWith('-')) ? rest[j + 1] : undefined;
      if (value === undefined) { complain('flag', `clode ${verb}: ${tok} needs a value`); continue; }
      flags[tok] = value;
      j += 1;
    } else {
      complain('flag', `unknown argument '${tok}'`);
    }
  }

  return { verb, subject, tail, flags, globalOrder, rest, error, errorKind };
}

module.exports = { SURFACE, TAGLINE, CHECKOUT_ONLY_VERBS, surfaceFor, renderHelp, parseArgv };
