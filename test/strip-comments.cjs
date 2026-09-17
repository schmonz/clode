'use strict';
// The comment-stripping tokenizer, split out of test/windows-path-ratchet.test.cjs
// (its original home) because a second test file (test/depscan.test.cjs) now needs
// the same primitive. Requiring one node:test file from another re-registers every
// test it declares, so they run twice and report twice -- the reason
// test/depscan-build.cjs is its own module is the same reason this one is. A PURE
// MOVE: the functions below, including the FIX ROUND 1 / FIX ROUND 2 history in
// stripComments()'s EOF-backoff branch, are unchanged from windows-path-ratchet's
// copy -- that history is load-bearing (it explains a real, previously-shipped bug
// in a REGEX predecessor of this tokenizer) and stays attached to the code it
// documents.

// Block comments are replaced by their OWN newlines rather than deleted: removing
// them shifts every line number after the first /* ... */, and a gate that names
// the wrong line is worse than no gate. (Found by this file's own first run.)
//
// A real tokenizer, not a regex: it tracks whether it is inside a STRING, a
// TEMPLATE LITERAL (including nested `${ ... }` interpolation, which can itself
// hold strings/templates/regexes), or a REGEX LITERAL, and ONLY treats `/*` or
// `//` as a real comment when none of those is open. Everything that is not a
// comment — code, and string/template/regex BODIES — passes through completely
// unchanged (never blanked): a template literal injecting C or JS source is
// exactly where the sites this file hunts for were hiding (build-tjs.mjs,
// clode-build.cjs), so their content must stay visible to the RULES below, not
// be swallowed as if it were a comment.
//
// Regex-vs-division is undecidable in general without a real parser; this uses
// the same "previous significant token" heuristic already reviewed and shipped
// in libexec/scc-merge.cjs's `lexicalCodeMask` (`REGEX_OK_AFTER_WORD`) — a
// separate copy, not an import, because that mask conflates "string" and
// "comment" into one "leave verbatim" bit, which is right for renaming and wrong
// here (a comment must be blanked, a string must not).
const REGEX_OK_AFTER_WORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'throw', 'case', 'do', 'else', 'yield', 'await',
]);

// Scans a candidate regex-literal BODY starting right after an opening `/` at `start`
// (i.e. src[start - 1] === '/'). Handles backslash escapes and `[...]` char classes the
// same way a real regex literal would; a regex literal can never contain a literal
// newline, so the scan always stops there. Returns `{ end, closed }` — `end` is the
// index right after the last character examined (either just past a found closing `/`
// plus trailing flags, or at the newline/EOF if none was found); `closed` says which.
// PURE. Shared by stripComments() (real recognition, when `!prevIsValue` says to try it
// for real) and by findAmbiguousRegexDivisionSites() below (speculative: "what WOULD
// this scan find here, even at a position the heuristic decided not to try") — one
// implementation, so the two can never quietly drift apart.
function scanRegexBody(src, start) {
  const n = src.length;
  let j = start;
  let inClass = false;
  let closed = false;
  while (j < n) {
    const cj = src[j];
    if (cj === '\\') { j += 2; continue; }
    if (cj === '\n') break;
    if (cj === '[') { inClass = true; j++; continue; }
    if (cj === ']') { inClass = false; j++; continue; }
    if (cj === '/' && !inClass) { j++; closed = true; break; }
    j++;
  }
  if (closed) {
    while (j < n && /[a-z]/i.test(src[j])) j++; // trailing flags
  }
  return { end: j, closed };
}

// `opts.onAmbiguousSlash(info)`, when supplied, fires once for every bare `/` the
// `prevIsValue` heuristic reads as division (skipping the real regex-literal scan)
// whose SPECULATIVE regex body — what scanRegexBody() would have found had it been
// tried here — contains a raw `/*`. That is FIX ROUND 1's residual, made continuously
// enforceable instead of a one-time manual check: it is exactly the shape that runs
// away, because the real tokenizer below, having decided this `/` is division, goes on
// to read that embedded `/*` as an ordinary (unconditional) comment opener — and if a
// REAL, unrelated `*/` exists later in the file (not just at EOF, which the branch below
// already guards), it silently deletes everything in between. Purely an observer: it
// never changes what stripComments() outputs, so callers that don't pass it see
// identical behaviour to before this hook existed.
function stripComments(src, opts) {
  const onAmbiguousSlash = opts && opts.onAmbiguousSlash;
  let out = '';
  let i = 0;
  const n = src.length;
  // Stack of frames: 'template' (raw template text) or 'code' (the root, or an
  // interpolation opened by a template's `${`). An `interp` frame tracks its own
  // unmatched '{' depth so the `}` that closes it is told apart from a nested
  // block or object literal inside the expression.
  const stack = [{ kind: 'code', interp: false, depth: 0 }];
  let prevIsValue = false; // true => a bare `/` here is division, not a regex start

  const top = () => stack[stack.length - 1];

  while (i < n) {
    const frame = top();
    const c = src[i];

    if (frame.kind === 'template') {
      if (c === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
      if (c === '`') { out += c; i++; stack.pop(); prevIsValue = true; continue; }
      if (c === '$' && src[i + 1] === '{') {
        out += '${'; i += 2;
        stack.push({ kind: 'code', interp: true, depth: 0 });
        prevIsValue = false;
        continue;
      }
      out += c; i++;
      continue;
    }

    // frame.kind === 'code'
    if (c === '/' && src[i + 1] === '*') {
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) j++;
      if (j + 1 < n) {
        // A real closing "*/" was found: commit to the comment.
        const end = j + 2;
        out += src.slice(i, end).replace(/[^\n]/g, '');
        i = end;
        prevIsValue = false;
        continue;
      }
      // FIX ROUND 1 (2026-09-04, coordinator finding): no closing "*/" anywhere before
      // EOF. Every file this guard scans is syntactically valid JS, and valid JS never
      // contains a real, unterminated block comment — so reaching EOF unclosed is proof
      // this "/*" was NOT a real comment opener. It was inside a regex literal the
      // `!prevIsValue` heuristic below failed to recognize (the same "inherent ambiguity
      // after ), ], or an identifier" scc-merge.cjs's own regexAllowed() comment already
      // names): e.g. `fn() /[/*]/.test(x)` — `)` sets prevIsValue, so the regex-literal
      // scan below is never attempted, and the SECOND `/` of the char class `[/*]` reads
      // as an ordinary `/*` right here, which (before this fix) then ran away to the next
      // `*/` anywhere in the file — or to EOF, silently deleting every real line after it,
      // including a genuine `process.env.PATH` site (see the regression test below).
      // Back off: treat this ONE character as ordinary punctuation and let the normal
      // dispatch re-examine everything from here, one character at a time, rather than
      // committing to a "comment" this file's own validity already disproves.
      //
      // NOT A FULL FIX for the family: if a REAL, unrelated block comment happens to sit
      // later in the SAME file, this same misjudged `/*` still runs away and pairs with
      // THAT comment's `*/` instead of reaching EOF, and this fallback cannot tell the
      // difference (a real closing marker exists, just the wrong one). Solving that
      // requires resolving the regex-vs-division ambiguity itself, which needs a real
      // parser; both are the same as the pre-existing "/`*` might be regex-code, might be
      // division" limitation the comment on the regex branch below already documents.
      // FIX ROUND 2 (2026-09-04, coordinator finding): a one-time manual measurement that
      // this residual does not occur today is not enough — the next file to acquire the
      // shape would be swallowed silently, with no record this analysis ever happened.
      // findAmbiguousRegexDivisionSites() below (wired into the
      // `windows-path-ratchet-regex-division-ambiguity` guard) makes the SAME check the
      // one below performs (via onAmbiguousSlash — see that hook) run on every scan, not
      // once by hand.
      prevIsValue = false;
      out += c; i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') j++;
      i = j; // stop before the newline; it is emitted on the next iteration
      prevIsValue = false;
      continue;
    }
    if (c === "'" || c === '"') {
      const q = c;
      let j = i + 1;
      while (j < n && src[j] !== q) {
        if (src[j] === '\\') j += 2;
        else if (src[j] === '\n') break; // an unescaped newline can't appear in '/" strings
        else j++;
      }
      const end = Math.min(j + 1, n);
      out += src.slice(i, end);
      i = end;
      prevIsValue = true;
      continue;
    }
    if (c === '`') {
      out += c; i++;
      stack.push({ kind: 'template' });
      continue;
    }
    if (c === '/' && !prevIsValue) {
      // Candidate regex literal. A `[...]` char class suspends the closing-slash
      // test, same as a real JS lexer; no closing slash on this line means it was
      // not a regex after all (division by something on the next line is not
      // valid JS either way, so this cannot misfire on real code).
      const { end, closed } = scanRegexBody(src, i + 1);
      if (closed) {
        out += src.slice(i, end);
        i = end;
        prevIsValue = true;
        continue;
      }
      prevIsValue = false;
      out += c; i++;
      continue;
    }
    // FIX ROUND 2 (2026-09-04, coordinator finding): `c === '/' && prevIsValue` falls
    // through to the default punctuation branch below UNCHANGED — this block only
    // REPORTS, via onAmbiguousSlash(), when doing so is dangerous. See the function
    // header for what this detects and why.
    if (c === '/' && prevIsValue && onAmbiguousSlash) {
      const { end } = scanRegexBody(src, i + 1);
      const body = src.slice(i + 1, end);
      if (body.includes('/*')) {
        onAmbiguousSlash({
          line: src.slice(0, i).split('\n').length,
          snippet: src.slice(i, Math.min(end, i + 60)),
        });
      }
    }
    if (frame.interp) {
      if (c === '{') { frame.depth++; out += c; i++; prevIsValue = false; continue; }
      if (c === '}') {
        if (frame.depth > 0) { frame.depth--; out += c; i++; prevIsValue = false; continue; }
        out += c; i++; stack.pop(); prevIsValue = false; continue; // closes the `${ ... }`
      }
    }
    if (/[A-Za-z0-9_$]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j++;
      const word = src.slice(i, j);
      out += word;
      i = j;
      prevIsValue = !REGEX_OK_AFTER_WORD.has(word);
      continue;
    }
    if (c === ')' || c === ']') { prevIsValue = true; out += c; i++; continue; }
    if (/\s/.test(c)) { out += c; i++; continue; } // whitespace never changes context
    prevIsValue = false;
    out += c; i++;
  }
  return out;
}

module.exports = { stripComments, scanRegexBody };
