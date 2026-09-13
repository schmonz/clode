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
//                 required.
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
//                 The four that no single verb owns are SURFACE.env below. Phase 3b's
//                 51-name classification then EDITS these entries rather than creating
//                 them; help must never stop documenting a name it documented before.
const SURFACE = {
  verbs: {
    build: {
      summary: 'build a standalone Claude Code binary',
      subjectClass: 'product',
      subjects: { quaude: 'the pinned tjs runtime + the compiled Claude Code bundle',
                  naude: 'a Node SEA; Node hosts only' },
      defaultSubject: 'quaude',
      // --target's text is the SAME SENTENCE fetch uses, with only the subject noun
      // swapped — enforced by test/cli-surface.test.cjs. The brief's draft wording
      // ('cross-build for PLATFORM-ARCH instead of this machine' here, 'fetch the
      // ingredient for …' under fetch) FAILED that test: two sentences, two shades of
      // meaning, which is precisely how --target acquired a second meaning the first
      // time. One sentence: the subject is for another machine, whatever the verb does
      // with it.
      flags: { '--target': 'the product is for PLATFORM-ARCH, not this machine',
               '--out': 'write the artifact here (default ./<product>)' },
      env: [{ name: 'CLODE_NO_WATCH=1',
              doc: 'disable the opportunistic update-signal check that runs during a build' },
            { name: 'CLODE_TJS',
              doc: "tjs template binary for 'clode build' (default: the blobulated builder's "
                + 'own embedded template, else build/tjs/tjs)' }],
    },
    fetch: {
      summary: 'fetch a build ingredient',
      subjectClass: 'ingredient',
      subjects: { claude: 'the upstream binary quaude is built from',
                  node: 'the pinned runtime naude embeds' },
      defaultSubject: 'claude',
      flags: { '--target': 'the ingredient is for PLATFORM-ARCH, not this machine' },
      env: [{ name: 'CLODE_CHANGELOG_URL',
              doc: 'release-notes source for the post-update signals digest' }],
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
// Empty today: task 6 adds the `bootstrap` entry here (and the stage0.mjs wiring
// that passes 'checkout'), which is the whole point of the split existing before
// there is anything in it — adding the verb is one entry in one table.
const CHECKOUT_ONLY_VERBS = {};

// surfaceFor(kind) — the table as a given ENTRY POINT sees it.
//   'shipped'  — the built clode binary: SURFACE exactly.
//   'checkout' — scripts/stage0.mjs in a source checkout: SURFACE plus
//                CHECKOUT_ONLY_VERBS.
// Returns a fresh object (the caller cannot mutate SURFACE through it); the verb
// DEFINITIONS are shared, which is deliberate — one definition per verb, whoever
// asks.
function surfaceFor(kind) {
  if (kind === 'shipped') {
    return { verbs: Object.assign({}, SURFACE.verbs), globals: SURFACE.globals, env: SURFACE.env };
  }
  if (kind === 'checkout') {
    return { verbs: Object.assign({}, SURFACE.verbs, CHECKOUT_ONLY_VERBS), globals: SURFACE.globals, env: SURFACE.env };
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
    const flags = Object.keys(def.flags);
    lines.push(`  clode ${verb}${positional}${flags.length ? ' [options]' : ''}`);
    lines.push(`      ${def.summary}`);
    if (subjects.length) {
      lines.push(`      ${def.subjectClass}s:`);
      lines.push(...columns(subjects.map((s) => [s, def.subjects[s] + (s === def.defaultSubject ? ' (default)' : '')]), '        '));
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
    // nothing for a stray argv to fall through to.
    return { verb: undefined, subject: undefined, flags, globalOrder, rest: [], error: `unknown command '${token === undefined ? '' : token}'` };
  }
  const verb = token;
  const def = surface.verbs[verb];
  const tail = args.slice(i + 1);

  let subject;
  let error;
  let consumed = 0;
  if (tail.length > 0 && !tail[0].startsWith('-')) {
    if (has(def.subjects, tail[0])) {
      subject = tail[0];
      consumed = 1;
    } else if (def.subjectClass === null) {
      error = `clode ${verb} takes no argument, got '${tail[0]}'`;
    } else {
      error = `unknown ${def.subjectClass} '${tail[0]}' for clode ${verb} (choose: ${Object.keys(def.subjects).join(', ')})`;
    }
  }
  const rest = tail.slice(consumed);

  for (let j = 0; j < rest.length; j++) {
    const tok = rest[j];
    if (has(def.flags, tok)) {
      // Every flag in the table takes a value; the boolean ones are the globals.
      const value = (j + 1 < rest.length && !rest[j + 1].startsWith('-')) ? rest[j + 1] : undefined;
      if (value === undefined) { if (!error) error = `clode ${verb}: ${tok} needs a value`; continue; }
      flags[tok] = value;
      j += 1;
    } else if (!error) {
      error = `unknown argument '${tok}'`;
    }
  }

  return { verb, subject, flags, globalOrder, rest, error };
}

module.exports = { SURFACE, TAGLINE, CHECKOUT_ONLY_VERBS, surfaceFor, renderHelp, parseArgv };
