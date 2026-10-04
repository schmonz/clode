'use strict';
// rg-regex.cjs — rg's regex dialect, decided in JS, for quaude's rg (grep-native Task 5b).
//
// WHY (user ruling 2026-10-03). No ugrep mode matches the regex dialect rg uses (Rust's regex
// crate: regex-syntax 0.8.4 + regex-automata 0.4.7, as ripgrep 14.1.1 configures them), and
// ugrep's versions disagree with each other (task-5 report; BACKLOG). So UGREP PROPOSES and
// THIS FILE DECIDES: ugrep selects candidate lines with prefilter(), a pattern in ugrep's own
// dialect that selects a SUPERSET of the lines rg selects, and verifyLine() then decides each
// candidate line and finds its matches exactly as rg's matcher does.
//
// THE MATCHER is a Pike VM over a Thompson NFA, built the way regex-automata builds it
// (compile() mirrors its compiler.rs: c_alt_iter, c_at_least, c_bounded, c_zero_or_one), and
// run the way its PikeVM runs it (thread priority, the epsilon closure's visited set, the
// unanchored start added at every position until a match is found). That is rg's own
// leftmost-first semantics, by construction, not by translation to a backtracking engine.
// RG-RE-LINEAR-TIME, and its scope, stated honestly: ONE search does at most 2 x states x positions
// steps, whatever the pattern, so `(a+)+$` or `(a|aa)*b` cost what `a` costs per state; there is
// no backtracking to explode. But the constant is the NFA's state count (`.{0,1000}needle` has
// 2,009 states), and rg's find_iter searches a line once per match, so ONE LINE costs up to
// O(states x length^2) (`a.*z|a`), as rg's own does. RG-RE-REFUSE-COST bounds a line's steps
// (lineStepBudget, 64 a byte), the async twin decides in slices of steps, and the NFA's size is bounded
// (MAX_STATES, and rg's own limit, RG-RE-REFUSE-SIZE-LIMIT): each refuses by name.
//
// THE BYTES (stated once). The matcher reads a line's BYTES as rg does. A valid UTF-8 sequence
// (Rust's own decode: no overlongs, no surrogates, nothing past U+10FFFF) is one code point;
// any other byte is a unit of its own that NO class and no `.` can match (RG-RE-DOT: Rust's
// Unicode-mode classes are UTF-8 automata). Every byte offset is a position, including those
// inside a multi-byte character, where only an empty match can occur (regex-automata's
// utf8_empty(false), which grep-regex sets: `x*` on a CJK character matches at 0, 1, 2 and 3).
// Each line is its own haystack: [lineStart, lineEnd), the terminator excluded, as rg's line
// selection reads it (the one place rg's matches read past the line start is refused:
// RG-RE-REFUSE-LOOKBEHIND).
//
// THE RULES, one statement each (each has a same-named test in test/rg-regex.test.cjs whose
// literals are native's embedded rg):
//   RG-RE-LEFTMOST-FIRST   alternation prefers the earlier branch (`a|ab` matches `a`), as a
//                          priority-ordered Pike VM does; ugrep's leftmost-longest is never used
//   RG-RE-PERL-UNICODE     \w \d \s (and negations) are Unicode: native's own tables
//   RG-RE-WORD-BOUNDARY    \b \B \< \> \b{start,end,start-half,end-half} over Unicode word
//                          characters, an invalid byte never a word character (look.rs's rules)
//   RG-RE-POSIX-ASCII      [[:class:]] is ASCII, inside a bracket (native's tables)
//   RG-RE-DOT              `.` and every class match a valid character, never an invalid byte
//   RG-RE-CASE             -i, (?i), (?i:...), (?-i): Rust's simple case folding (native's table),
//                          folded before a class is negated
//   RG-RE-ANCHORS          ^ and $ are the line's start and end (multi-line, \n the terminator;
//                          \r is a character)
//   RG-RE-EMPTY            empty matches at every byte position, inside characters too
//                          (utf8_empty(false)); RG-EMPTY-AFTER-MATCH (verifyLine) skips one at the
//                          end of the match before it
//   RG-RE-GREED            lazy and greedy repetition, counted repetition and (?U), compiled as
//                          compiler.rs compiles them (x* over a sub that can match empty is (x+)?)
//   RG-RE-SYNTAX           regex-syntax 0.8.4's grammar, the pattern wrapped as `(?:PATTERN)`
//   RG-RE-ALT-MERGE        branches that are all single characters, or all classes, are one class
//                          before rg strips \n and bans NUL (`\n|a` is [a]; `[ab]|\n` is refused)
//   RG-RE-LITERAL          a plain literal matches its bytes, leftmost, without overlap
//   RG-RE-MATCH-AT-UNTERMINATED-END  the matcher's match at the end of an unterminated last line
//                          is reported (rg selects the line by it; its printers do not print it)
//   RG-RE-LINEAR-TIME      ONE search is at most 2 x states x positions steps (a line, up to
//                          states x length^2: RG-RE-REFUSE-COST bounds it)
//   RG-RE-PREFILTER-SUPERSET  ugrep, given prefilter(), proposes every line rg selects
//   RG-RE-REFUSE-*         REFUSALS, below
//
// THE PREFILTER is a SUPERSET by construction. Widening rules, applied to the translated
// pattern (prefilter() below): an assertion (^ $ \b \B ...) becomes nothing; a class becomes a
// bracket of ASCII letters/digits/underscore when it is exactly such ranges, its members
// spelled out when it has at most PREFILTER_SMALL of them, and `.` otherwise (ugrep's `.`
// matches every character and every invalid byte, measured); a literal under case
// insensitivity becomes its whole simple-case-folding class; a repetition of at most SMALL_REP
// stays counted (greedy); a longer or unbounded one is never written at all (THE PIECES RULE, at
// summary() below: ugrep stalls on one over a long line), so the prefilter is the best piece every
// match contains; a branch that can only match the empty string makes its alternation optional.
// ugrep never sees -i: case folding is spelled into the pattern, rg's folding, not ugrep's.
//
// WHAT REFUSES (translateRgRegex -> { refuse }), each by name: everything quaude's rg cannot
// answer exactly, and everything rg itself rejects (its message is rg's own; ours names the
// construct). See REFUSALS below.
//
// Pure CommonJS over nothing but plain JS: runs under tjs and under node alike. Loaded by
// rg-native.cjs as `require(__dirname + '/rg-regex.cjs')`, so it travels beside it (and
// bun-shim.cjs) in every packaging (test/shim-companions.test.cjs).

// BEGIN GENERATED rg-regex-data
// rg's regex character data, measured from native's embedded rg (ripgrep 14.1.1 (rev 7c1d0ed28a)) by
// scripts/gen-rg-regex-data.cjs. Do not edit; regenerate.
const RG_REGEX_DATA = {"header":{"rg":"ripgrep 14.1.1 (rev 7c1d0ed28a)","generator":"scripts/gen-rg-regex-data.cjs"},"word":"1c,9,8,p,5,0,2,p,1c,0,b,0,5,0,6,m,2,u,2,cp,5,b,f,4,8,0,2,0,i,38,2,1,3,3,2,0,7,0,2,2,2,0,2,j,2,2a,2,3u,2,4s,2,11,3,0,7,14,9,18,2,0,2,1,2,1,2,0,9,q,5,3,u,a,6,21,5,2t,2,7,3,9,2,i,3,0,h,1m,3,2s,f,1h,5,0,3,0,3,19,j,r,5,a,6,n,2,5,9,22,2,3k,3,9,2,i,2,7,3,1,3,l,2,6,2,0,4,3,3,8,3,1,3,3,9,0,5,1,2,4,3,b,b,0,2,0,3,2,2,5,5,1,3,l,2,6,2,1,2,1,2,1,3,0,2,4,5,1,3,2,4,0,8,3,2,0,8,f,c,2,2,8,2,2,2,l,2,6,2,1,2,4,3,9,2,2,2,2,3,0,g,3,3,9,a,6,2,2,2,7,3,1,3,l,2,6,2,1,2,4,3,8,3,1,3,2,8,2,5,1,2,4,3,9,2,0,h,1,2,5,4,2,2,3,4,1,2,0,2,1,4,1,4,2,4,b,5,4,4,2,2,3,3,0,7,0,f,9,h,c,2,2,2,m,2,f,3,8,2,2,2,3,8,1,2,2,3,0,3,3,3,9,h,3,2,7,2,2,2,m,2,9,2,4,3,8,2,2,2,3,8,1,7,1,2,3,3,9,2,2,d,c,2,2,2,1e,2,2,2,4,6,3,8,4,3,9,b,5,2,2,2,h,4,n,2,8,2,0,3,6,4,0,5,5,2,0,2,7,7,9,3,1,e,1l,6,e,2,9,14,1,2,0,2,4,2,n,2,0,2,m,3,4,2,0,2,6,2,9,3,3,x,0,o,1,7,9,c,0,2,0,2,0,5,9,2,z,5,j,2,h,2,z,a,0,1m,21,7,25,3,11,2,0,6,0,3,16,2,98,2,3,3,6,2,0,2,3,3,14,2,3,3,w,2,3,3,6,2,0,2,3,3,e,2,1k,2,3,3,1u,3,2,x,f,h,2d,3,5,4,h7,3,g,2,p,6,22,4,a,8,l,a,l,c,j,d,c,2,2,2,1,d,2b,4,0,5,1,3,9,y,2,2,a,7,2g,8,16,6,1x,b,u,2,b,5,b,b,13,3,4,c,17,5,p,7,9,13,r,5,1q,2,s,3,a,7,9,e,0,9,u,1e,24,4,9,i,8,d,37,d,1j,9,9,4,1c,3,a,6,16,3,2,h,2,2,12,6,et,3,5,3,11,3,5,3,7,2,0,2,0,2,0,2,u,3,1g,2,6,2,0,4,2,2,6,4,3,3,5,5,c,6,2,2,6,g,1,1e,1,k,0,t,0,e,0,h,c,1g,w,i,0,5,0,3,9,2,0,4,4,7,0,2,0,2,0,2,3,2,a,3,3,6,4,5,0,i,14,mm,1f,1ef,6c,7,8,d,11,2,0,6,0,3,1j,8,0,g,n,a,6,2,6,2,6,2,6,2,6,2,6,2,6,2,6,2,v,1c,0,d2,2,q,e,2,4,3,4,5,2d,3,1,3,2,2,2h,2,3,6,16,2,2l,i,v,1d,f,e9,533,1t,h3g,1w,19,3,7g,4,r,l,1e,2,9,2,36,12,8,3,2u,3,1u,3,1,2,0,2,7,m,1h,5,0,k,1f,d,1x,b,9,7,n,4,0,2,1c,3,z,d,s,4,1s,f,a,7,u,2,1i,a,d,3,9,7,m,4,20,p,2,3,f,3,4,b,5,3,5,3,5,a,6,2,6,2,16,2,d,7,3e,2,1,3,9,7,8mb,d,m,5,1c,6it,a5,3,2x,13,6,d,4,6,b,2,c,2,4,2,0,2,1,2,1,2,2z,y,a2,j,1r,3,1h,15,b,5,f,h,f,4,1,p,2,x,4,2,3q,k,9,8,p,5,0,2,p,c,2g,4,5,3,5,3,5,3,2,10,b,2,p,2,i,2,1,2,e,3,d,z,3e,1y,1g,3t,0,3n,s,4,1c,g,0,w,v,e,t,6,16,6,t,3,z,5,7,2,4,17,4d,3,9,7,z,5,z,5,13,9,1f,d,a,2,e,2,6,2,1,2,a,2,e,2,6,2,1,4,1f,d,8m,a,l,b,7,p,5,2,15,2,8,1y,5,3,0,2,17,2,1,4,0,3,m,b,m,a,u,1u,i,2,1,b,l,b,p,1z,1j,7,1,1t,3,2,1,6,7,2,2,2,s,3,2,5,0,x,s,4,s,10,7,2,t,q,1h,b,l,b,i,e,h,33,20,1k,1e,e,1e,e,13,9,9,7,11,4,4,2,m,6z,15,2,1,4,1,h,2,1k,w,b,0,9,w,w,l,17,k,s,m,a,1y,w,f,a,1n,8,0,e,o,8,9,7,1g,2,9,5,3,9,z,3,0,a,1w,5,3,2,c,2,0,10,h,2,10,7,3,1r,6,2,0,2,3,2,e,2,9,8,1m,6,9,7,3,2,7,3,1,3,l,2,6,2,1,2,4,2,9,3,1,3,2,3,0,7,0,6,6,3,6,4,4,c,9,2,0,3,0,2,11,2,9,2,0,3,0,2,3,2,7,e,1,u,22,6,9,5,3,v,1x,2,0,9,9,4n,1h,3,8,o,5,z,1s,4,0,c,9,13,1k,8,9,7,j,t,q,3,e,5,9,7,6,56,1m,2u,21,m,7,3,0,3,7,2,1,2,t,2,1,3,8,d,9,1z,7,3,19,3,7,2,1,s,1q,9,0,9,21,4,0,j,20,5k,w,g,9,7,8,2,18,2,8,g,9,p,t,3,l,2,d,22,6,2,1,2,17,4,0,2,1,2,8,9,9,7,5,2,1,2,10,2,1,2,5,8,9,8n,m,a,g,2,14,4,4,e,a,2e,0,28,pl,2v,32,i,5f,219,2o,g,tr,h,l,b,32y,6,g6,5a2,1l,1c7,fs,8,u,2,9,7,26,2,9,7,t,3,4,c,1i,a,3,d,9,a,k,6,i,c1,18,4,9,5j,1r,3l,22,5,1k,8,g,1t,1,2,1,c,1,f,4qf,9,yd,16,9,6w8,3,2,6,2,1,2,82,g,0,u,2,3,0,f,3,9,az,1s5,2y,6,c,4,8,8,9,4,1,382,9,ef,19,3,m,f3,4,4,5,9,7,3,6,v,3,45,2,cc,2c,2,1y,2,1,3,0,3,1,3,3,2,b,2,0,2,6,2,1s,2,3,3,7,2,6,2,r,2,3,2,4,2,0,4,6,2,9f,3,o,2,o,2,u,2,o,2,u,2,o,2,u,2,o,2,u,2,o,2,7,3,1d,e9,1i,5,1d,9,0,f,0,n,4,2,e,up,u,7,5,5y,6,2,g,3,6,2,1,2,4,6,1p,y,0,35,18,4,d,3,9,5,0,8y,u,i,1l,d3,15,5z,16,di,6,2,3,2,1,2,e,2,5g,c,6,16,23,5,9,x3,3,2,q,2,1,2,0,3,0,2,9,2,3,2,0,2,0,7,0,5,0,2,0,2,0,2,2,2,1,2,0,3,0,2,0,2,0,2,0,2,0,2,1,2,0,3,3,2,6,2,3,2,3,2,0,2,9,2,g,6,2,2,4,2,g,hh,p,7,p,7,p,21z,9,sn,wyn,x,37d,7,65,3,4g1,f,5rk,g,h9,1wj,f1,15v,3t6,6,38f,f9e9,6n","digit":"1c,9,17r,9,3r,9,5j,9,bh,9,3b,9,3b,9,3b,9,3b,9,3b,9,3b,9,3b,9,3b,9,3b,9,2p,9,3b,9,1z,9,7r,9,1z,9,1fr,9,13,9,8d,9,3l,9,4n,9,7,9,53,9,2f,9,3r,9,7,9,r7r,9,iv,9,13,9,5j,9,n,9,2f,9,bb,9,gev,9,13b,9,1on,9,7,9,m5,9,3l,9,1p,9,41,9,7r,9,9j,9,3b,9,af,9,2v,9,7,j,25,9,br,9,2v,9,if,9,2f,9,6v,9,1z,9,br,9,d07,9,1t3,9,2f,9,3r,9,ev,9,iuv,9,251,1d,1tt,9,br,9,dz,9,6w,9,nq,9,3o7,9","space":"9,0,2,2,j,0,2t,0,r,0,4bk,0,1vk,a,u,1,6,0,1c,0,335,0","posix":{"alnum":"1c,9,8,p,7,p","alpha":"1t,p,7,p","ascii":"0,9,2,38","blank":"9,0,n,0","cntrl":"0,9,2,k,2o,0","digit":"1c,9","graph":"x,2l","lower":"2p,p","print":"w,2m","punct":"x,e,b,6,r,5,r,3","space":"9,0,2,2,j,0","upper":"1t,p","word":"1c,9,8,p,5,0,2,p","xdigit":"1c,9,8,5,r,5"},"fold":"1t.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w.6hr,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w.8c,1.w,1.w,1.w,1.w,1.w,1.w,1.w,2j.kn.lj,b.w,1.w,1.w,1.w,1.w,1.w.6ee,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,2.w,1.w,1.w,1.w,1.w,1.w,1.w,1.5vj,w.3d,1.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,4.1,2.1,2.1,3.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,3.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,3.1,2.1,2.1,3.5f,1.5u,1.1,2.1,2.5q,1.1,2.5p,1.5p,1.1,3.27,1.5m,1.5n,1.1,2.5p,1.5r,1.2p,1.5v,1.5t,1.1,2.4j,1.wu9,1.5v,1.5x,1.3m,1.5y,1.1,2.1,2.1,2.62,1.1,2.62,3.1,2.62,1.1,2.61,1.61,1.1,2.1,2.63,1.1,4.1,3.1k,5.1.2,3.1.2,3.1.2,3.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,3.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,3.1.2,3.1,4.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,4.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,8.8bv,1.1,3.8bs,1.8cf,1.8cf,1.1,3.1x,1.1z,1.1,2.1,2.1,2.1,2.1,2.8bj,1.8bg,1.8bi,a.wnj,5.wnf,3.wo7,1.wmg,1.wn8,4.wn8,1.8af,1.wn5,5.8al,c.89z,5.wn7,5.wmi,m.wlx,1.wlu,4n.2c.38.5mh,17.1,2.1,4.1,5.3m,1.3m,1.3m,2.38,7.12,2.11,1.11,1.11,2.1s,2.1r,1.1r,1.5kz,1.w,1.w.1q,1.w,1.w,1.w.2o,1.w,1.w,1.w.1l.2k,2.w.2e,1.w,2.w,1.w,1.w,1.w.1i,1.w.28,2.v.w,1.w,1.w,1.w.1b,1.w,1.w,1.w.5tp,1.w,1.w,5.5kj,v.8,9.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,4.7,5.1,3.1,6.28,1.28,1.28,1.28,1.28,1.28,1.28,1.28,1.28,1.28,1.28,1.28,1.28,1.28,1.28,1.28,1.w,1.w,1.w.4tq,1.w,1.w.4tp,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w.4tg,1.w,1.w,1.w.4te,1.w.4te.4tf,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w.4t8,1.w,1.w,1.w,1.w,1.w,1d.1,2.1.4rp,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,a.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.f,1.1,2.1,2.1,2.1,2.1,2.1,2.1,3.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,3.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,28a.5ls,1.5ls,1.5ls,1.5ls,1.5ls,1.5ls,1.5ls,1.5ls,1.5ls,1.5ls,1.5ls,1.5ls,1.5ls,1.5ls,1.5ls,1.5ls,1.5ls,1.5ls,1.5ls,1.5ls,1.5ls,1.5ls,1.5ls,1.5ls,1.5ls,1.5ls,1.5ls,1.5ls,1.5ls,1.5ls,1.5ls,1.5ls,1.5ls,1.5ls,1.5ls,1.5ls,1.5ls,1.5ls,2.5ls,6.5ls,3.2bk,1.2bk,1.2bk,1.2bk,1.2bk,1.2bk,1.2bk,1.2bk,1.2bk,1.2bk,1.2bk,1.2bk,1.2bk,1.2bk,1.2bk,1.2bk,1.2bk,1.2bk,1.2bk,1.2bk,1.2bk,1.2bk,1.2bk,1.2bk,1.2bk,1.2bk,1.2bk,1.2bk,1.2bk,1.2bk,1.2bk,1.2bk,1.2bk,1.2bk,1.2bk,1.2bk,1.2bk,1.2bk,1.2bk,1.2bk,1.2bk,1.2bk,1.2bk,3.2bk,1.2bk,1.2bk,ip.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.tzk,1.8,1.8,1.8,1.8,1.8,1.8,1oz.r7m.r7n,1.1,6o.r9g,4.2xy,h.raw,36.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1.1n,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,c.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.8,1.8,1.8,1.8,1.8,1.8,1.8,1.8,9.8,1.8,1.8,1.8,1.8,1.8,b.8,1.8,1.8,1.8,1.8,1.8,1.8,1.8,9.8,1.8,1.8,1.8,1.8,1.8,1.8,1.8,9.8,1.8,1.8,1.8,1.8,1.8,c.8,2.8,2.8,2.8,9.8,1.8,1.8,1.8,1.8,1.8,1.8,1.8,9.22,1.22,1.2e,1.2e,1.2e,1.2e,1.2s,1.2s,1.3k,1.3k,1.34,1.34,1.3i,1.3i,3.8,1.8,1.8,1.8,1.8,1.8,1.8,1.8,9.8,1.8,1.8,1.8,1.8,1.8,1.8,1.8,9.8,1.8,1.8,1.8,1.8,1.8,1.8,1.8,9.8,1.8,2.9,g.9,d.8,1.8,f.8,1.8,4.7,e.9,8v.s,1a.g,1.g,1.g,1.g,1.g,1.g,1.g,1.g,1.g,1.g,1.g,1.g,1.g,1.g,1.g,1.g,k.1,mr.q,1.q,1.q,1.q,1.q,1.q,1.q,1.q,1.q,1.q,1.q,1.q,1.q,1.q,1.q,1.q,1.q,1.q,1.q,1.q,1.q,1.q,1.q,1.q,1.q,1.q,1f5.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1.1c,1d.1,7.1,2.1,2.1,7.1,3.1,b.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,9.1,2.1,5.1,nym.1,2.1,2.1,2.1,2.1,4.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,k.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,3s.1,2.1,2.1,2.1,2.1,2.1,2.1,4.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,b.1,2.1,3.1,2.1,2.1,2.1,2.1,5.1,5.1,2.1,2.1c,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,b.ps,1.1,2.1,2.1,2.1,2.1,2.1,2.1,2.1,5.1,2.1,3.1,4.1,6.1,2.1,2.1,r.1,geo.1,t8.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,xy.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,3t.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,1.14,4d.13,1.13,1.13,1.13,1.13,1.13,1.13,1.13,1.13,1.13,1.13,2.13,1.13,1.13,1.13,1.13,1.13,1.13,1.13,1.13,1.13,1.13,1.13,1.13,1.13,1.13,2.13,1.13,1.13,1.13,1.13,1.13,1.13,2.13,1.13,1d7.1s,1.1s,1.1s,1.1s,1.1s,1.1s,1.1s,1.1s,1.1s,1.1s,1.1s,1.1s,1.1s,1.1s,1.1s,1.1s,1.1s,1.1s,1.1s,1.1s,1.1s,1.1s,1.1s,1.1s,1.1s,1.1s,1.1s,1.1s,1.1s,1.1s,1.1s,1.1s,1.1s,1.1s,1.1s,1.1s,1.1s,1.1s,1.1s,1.1s,1.1s,1.1s,1.1s,1.1s,1.1s,1.1s,1.1s,1.1s,1.1s,1.1s,1.1s,4e.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,27v.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,gw1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,1.w,o81.y,1.y,1.y,1.y,1.y,1.y,1.y,1.y,1.y,1.y,1.y,1.y,1.y,1.y,1.y,1.y,1.y,1.y,1.y,1.y,1.y,1.y,1.y,1.y,1.y,1.y,1.y,1.y,1.y,1.y,1.y,1.y,1.y,1.y"};
// END GENERATED rg-regex-data

// ---- the data, decoded once, on first use ------------------------------------------------------
let _data = null;
function data() {
  if (_data) return _data;
  const ranges = (s) => { let p = 0; return s.split(',').map((x) => (p += parseInt(x, 36))); };
  const fold = new Map();
  let prev = 0;
  for (const g of RG_REGEX_DATA.fold.split(',')) {
    const p = g.split('.').map((x) => parseInt(x, 36));
    const first = prev + p[0];
    prev = first;
    const cls = [first, ...p.slice(1).map((x) => first + x)];
    for (const c of cls) fold.set(c, cls);
  }
  const posix = {};
  for (const k of Object.keys(RG_REGEX_DATA.posix)) posix[k] = ranges(RG_REGEX_DATA.posix[k]);
  _data = { word: ranges(RG_REGEX_DATA.word), digit: ranges(RG_REGEX_DATA.digit), space: ranges(RG_REGEX_DATA.space), posix, fold };
  return _data;
}

// ---- classes: sorted, merged [lo, hi, lo, hi, ...] over Unicode scalar values -------------------
function norm(flat) {
  const ps = [];
  for (let i = 0; i < flat.length; i += 2) ps.push([flat[i], flat[i + 1]]);
  ps.sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [lo, hi] of ps) {
    if (out.length && lo <= out[out.length - 1] + 1) { if (hi > out[out.length - 1]) out[out.length - 1] = hi; } else out.push(lo, hi);
  }
  return out;
}
const union = (a, b) => norm(a.concat(b));
// The complement among Unicode SCALAR values: a Rust class never holds a surrogate.
function negate(a) {
  const out = [];
  let next = 0;
  for (let i = 0; i < a.length; i += 2) { if (a[i] > next) out.push(next, a[i] - 1); next = a[i + 1] + 1; }
  if (next <= 0x10ffff) out.push(next, 0x10ffff);
  const res = [];
  for (let i = 0; i < out.length; i += 2) {
    const lo = out[i], hi = out[i + 1];
    if (hi < 0xd800 || lo > 0xdfff) res.push(lo, hi);
    else { if (lo < 0xd800) res.push(lo, 0xd7ff); if (hi > 0xdfff) res.push(0xe000, hi); }
  }
  return res;
}
function has(a, c) {
  let lo = 0, hi = (a.length >> 1) - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (c < a[2 * m]) hi = m - 1; else if (c > a[2 * m + 1]) lo = m + 1; else return true;
  }
  return false;
}
// RG-RE-CASE: Rust's simple case folding (regex-syntax's case_fold_simple), as native's tables.
function foldClass(a) {
  const add = [];
  for (const [c, cls] of data().fold) if (has(a, c)) for (const m of cls) add.push(m, m);
  return add.length ? union(a, add) : a;
}
const single = (c) => [c, c];
const utf8Len = (c) => (c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4);
// The class without \n: rg strips \n from every class (grep-regex strip.rs).
function withoutNewline(set) {
  const out = [];
  for (let i = 0; i < set.length; i += 2) {
    const lo = set[i], hi = set[i + 1];
    if (lo <= 0x0a && hi >= 0x0a) { if (lo < 0x0a) out.push(lo, 0x09); if (hi > 0x0a) out.push(0x0b, hi); } else out.push(lo, hi);
  }
  return out;
}
const count = (a) => { let n = 0; for (let i = 0; i < a.length; i += 2) n += a[i + 1] - a[i] + 1; return n; };

// ---- refusals -----------------------------------------------------------------------------------
// rg's NFA size limit (grep-regex config.rs: 100 MiB); RG-RE-REFUSE-SIZE-LIMIT, below.
const NFA_SIZE_LIMIT = 100 * (1 << 20);
// Each is ONE named rule. `rgRejects` marks the patterns rg ITSELF refuses (rc 2, its own
// message): quaude refuses those too, naming the construct, never answering where rg errors.
const REFUSALS = {
  'RG-RE-REFUSE-SYNTAX': { rgRejects: true, what: 'is not a regex rg accepts' },
  'RG-RE-REFUSE-UNICODE-CLASS': { what: 'uses a Unicode property class (\\p, \\P), whose tables quaude does not carry' },
  'RG-RE-REFUSE-TEXT-ANCHOR': { what: 'uses a text anchor (\\A, \\z, or ^/$ under (?-m)), which rg answers differently for its line selection and its matches (measured)' },
  'RG-RE-REFUSE-BYTES': { what: 'turns Unicode mode off ((?-u)), which matches bytes inside characters' },
  'RG-RE-REFUSE-VERBOSE': { what: 'uses the verbose flag (?x)' },
  'RG-RE-REFUSE-CRLF': { what: 'uses the CRLF flag (?R)' },
  'RG-RE-REFUSE-CLASS-SET': { what: 'nests a class, or uses class set operations (&&, --, ~~)' },
  'RG-RE-REFUSE-NEWLINE': { rgRejects: true, what: 'can match a line terminator, which rg refuses without -U' },
  'RG-RE-REFUSE-NUL': { rgRejects: true, what: 'matches only NUL, which rg refuses while it detects binary files' },
  'RG-RE-REFUSE-SIZE': { what: 'is larger or deeper than quaude\'s rg compiles' },
  'RG-RE-REFUSE-COST': { what: 'needs more matching on one line than quaude\'s rg allows a line (64 steps a byte, lineStepBudget), where rg would take far less time' },
  'RG-RE-REFUSE-SIZE-LIMIT': { what: `may compile past the size rg allows a regex (${NFA_SIZE_LIMIT} bytes of NFA, rg's limit; quaude's rg bounds that size from above and refuses when the bound passes it)` },
  'RG-RE-REFUSE-CAPTURE-NAME': { what: 'names a group with non-ASCII characters' },
  'RG-RE-REFUSE-LOOKBEHIND': { what: 'looks behind a line that starts inside a character (\\B or \\b{start-half} on a line whose first byte is a UTF-8 continuation byte), where rg\'s answer depends on the bytes before the line (measured)' },
};
class RgRegexRefusal extends Error {
  constructor(rule, detail) {
    super(`${rule}: ${detail}`);
    this.name = 'RgRegexRefusal';
    this.rule = rule;
    this.detail = detail;
  }
}
const refuse = (rule, detail) => { throw new RgRegexRefusal(rule, detail); };
function refusalReason(e) {
  const r = REFUSALS[e.rule];
  return r.rgRejects
    ? `quaude answers rg with its own emulation over ugrep, on purpose, and rg itself rejects this pattern: it ${r.what} (${e.rule}: ${e.detail}); nothing was searched`
    : `quaude answers rg with its own emulation over ugrep, on purpose, and this pattern ${r.what}, so it cannot give the answer native's rg gives and refuses rather than answer differently (${e.rule}: ${e.detail}); nothing was searched`;
}

// ---- the parser: regex-syntax 0.8.4's grammar (ast/parse.rs), translated as it translates -------
// It produces the HIR directly: { k: 'cls', set } | { k: 'look', look } | { k: 'cat', subs }
// | { k: 'alt', subs } | { k: 'rep', sub, min, max (null: unbounded), greedy } | { k: 'empty' }.
// Flags (i, U) are applied as the translator applies them: a `(?flags)` lasts to the end of its
// group, across `|`; `(?flags:...)` only inside.
const NEST_LIMIT = 100;
const META = new Set('\\.+*?()|[]{}^$#&-~');
const isEscapeable = (c) => META.has(String.fromCodePoint(c)) || (c < 0x80 && !/[0-9A-Za-z<>]/.test(String.fromCodePoint(c)));
const isSpace = (c) => c === 0x0a || has(data().space, c);
const isHex = (c) => (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
const ASCII_NAMES = new Set(['alnum', 'alpha', 'ascii', 'blank', 'cntrl', 'digit', 'graph', 'lower', 'print', 'punct', 'space', 'upper', 'word', 'xdigit']);
const ch = (s) => s.codePointAt(0);

class Parser {
  constructor(pattern, ignoreCase) {
    this.p = Array.from(pattern, (s) => s.codePointAt(0));
    this.i = 0;
    this.flags = { i: !!ignoreCase, U: false };
    this.depth = 0;
    this.names = new Set();
  }
  eof() { return this.i >= this.p.length; }
  c() { return this.p[this.i]; }
  peek() { return this.p[this.i + 1]; }
  is(s) { return this.c() === ch(s); }
  bumpIf(s) {
    const cs = Array.from(s, (x) => x.codePointAt(0));
    for (let k = 0; k < cs.length; k++) if (this.p[this.i + k] !== cs[k]) return false;
    this.i += cs.length;
    return true;
  }
  syntax(detail) { refuse('RG-RE-REFUSE-SYNTAX', `${detail} at character ${this.i}`); }

  // ONE group's contents: alternation of concatenations, up to ')' or the end.
  parseGroupBody() {
    if (++this.depth > NEST_LIMIT) refuse('RG-RE-REFUSE-SIZE', `nesting deeper than ${NEST_LIMIT}`);
    const saved = { ...this.flags };
    const branches = [];
    let items = [];
    for (;;) {
      if (this.eof() || this.is(')')) break;
      if (this.is('|')) { this.i++; branches.push(items); items = []; continue; }
      if (this.is('(')) { this.parseGroup(items); continue; }
      if (this.is('[')) { items.push({ k: 'cls', set: this.parseBracket() }); continue; }
      if (this.is('?') || this.is('*') || this.is('+')) { this.parseRepetition(items); continue; }
      if (this.is('{')) { this.parseCounted(items); continue; }
      items.push(this.parsePrimitive());
    }
    branches.push(items);
    this.flags = saved;
    this.depth--;
    const cats = branches.map((its) => ({ k: 'cat', subs: its.filter((x) => x.k !== 'flags') }));
    return cats.length === 1 ? cats[0] : { k: 'alt', subs: cats };
  }

  parseGroup(items) {
    this.i++; // (
    if (this.bumpIf('?=') || this.bumpIf('?!') || this.bumpIf('?<=') || this.bumpIf('?<!')) this.syntax('look-around is not supported');
    let scoped = null;
    if (this.bumpIf('?P<') || this.bumpIf('?<')) {
      this.parseCaptureName();
    } else if (this.bumpIf('?')) {
      if (this.eof()) this.syntax('unclosed group');
      const f = this.parseFlags();
      const end = this.c();
      this.i++;
      if (end === ch(')')) {
        if (!f.length) this.syntax('repetition operator missing expression');
        this.applyFlags(f);
        items.push({ k: 'flags' });
        return;
      }
      scoped = f;
    }
    const saved = { ...this.flags };
    if (scoped) this.applyFlags(scoped);
    const body = this.parseGroupBody();
    this.flags = saved;
    if (this.eof() || !this.is(')')) this.syntax('unclosed group');
    this.i++;
    // A capture group stays one (regex-syntax's Hir::capture): it is never a literal or a class,
    // so it keeps its branch out of RG-RE-ALT-MERGE.
    const capture = !scoped;
    if (!capture && body.k === 'cat' && body.subs.length === 0) items.push({ k: 'empty', group: true });
    else items.push({ k: 'group', sub: body, cap: capture });
  }

  parseCaptureName() {
    if (this.eof()) this.syntax('unexpected end of capture name');
    const start = this.i;
    for (;;) {
      if (this.eof()) this.syntax('unexpected end of capture name');
      const c = this.c();
      if (c === ch('>')) break;
      if (c >= 0x80) refuse('RG-RE-REFUSE-CAPTURE-NAME', 'a group name with a non-ASCII character');
      const s = String.fromCodePoint(c);
      const ok = this.i === start ? /[_A-Za-z]/.test(s) : /[_.\[\]0-9A-Za-z]/.test(s);
      if (!ok) this.syntax('invalid capture group name');
      this.i++;
    }
    const name = String.fromCodePoint(...this.p.slice(start, this.i));
    this.i++; // >
    if (!name) this.syntax('empty capture group name');
    if (this.names.has(name)) this.syntax('duplicate capture group name');
    this.names.add(name);
  }

  // Flags up to ':' or ')' (the caller consumes that). [{ flag, on }]
  parseFlags() {
    const out = [];
    const seen = new Set();
    let negated = false, sawNeg = false, lastNeg = false;
    while (!this.eof() && !this.is(':') && !this.is(')')) {
      const c = String.fromCodePoint(this.c());
      if (c === '-') {
        if (sawNeg) this.syntax('repeated negation in flags');
        sawNeg = true; negated = true; lastNeg = true;
      } else {
        if (!'imsUuRx'.includes(c)) this.syntax('unrecognized flag');
        if (seen.has(c)) this.syntax('duplicate flag');
        seen.add(c);
        out.push({ flag: c, on: !negated });
        lastNeg = false;
      }
      this.i++;
    }
    if (this.eof()) this.syntax('unexpected end of flags');
    if (lastNeg) this.syntax('dangling flag negation');
    return out;
  }
  applyFlags(f) {
    for (const { flag, on } of f) {
      if (flag === 'i') this.flags.i = on;
      else if (flag === 'U') this.flags.U = on;
      else if (flag === 'x' && on) refuse('RG-RE-REFUSE-VERBOSE', '(?x)');
      else if (flag === 'R' && on) refuse('RG-RE-REFUSE-CRLF', '(?R)');
      else if (flag === 'u' && !on) refuse('RG-RE-REFUSE-BYTES', '(?-u)');
      else if (flag === 'm' && !on) refuse('RG-RE-REFUSE-TEXT-ANCHOR', '(?-m)');
      // m on, s either way (no line holds a \n), u on, x/R off: nothing changes
    }
  }

  operand(items) {
    const last = items.pop();
    if (!last || last.k === 'flags' || (last.k === 'empty' && !last.group)) this.syntax('repetition operator missing expression');
    return last;
  }
  greedy(lazyMark) { return this.flags.U ? lazyMark : !lazyMark; }
  parseRepetition(items) {
    const op = String.fromCodePoint(this.c());
    const sub = this.operand(items);
    this.i++;
    let lazy = false;
    if (!this.eof() && this.is('?')) { lazy = true; this.i++; }
    const [min, max] = op === '?' ? [0, 1] : op === '*' ? [0, null] : [1, null];
    items.push({ k: 'rep', sub, min, max, greedy: this.greedy(lazy) });
  }
  skipWs() { while (!this.eof() && isSpace(this.c())) this.i++; }
  decimal() {
    this.skipWs();
    let s = '';
    while (!this.eof() && this.c() >= 0x30 && this.c() <= 0x39) { s += String.fromCodePoint(this.c()); this.i++; }
    this.skipWs();
    if (!s) return null;
    const n = Number(s);
    if (n > 0xffffffff) this.syntax('repetition count is too big');
    return n;
  }
  parseCounted(items) {
    const sub = this.operand(items);
    this.i++; // {
    if (this.eof()) this.syntax('unclosed counted repetition');
    const lo = this.decimal();
    if (this.eof()) this.syntax('unclosed counted repetition');
    let min, max;
    if (this.is(',')) {
      this.i++;
      if (this.eof()) this.syntax('unclosed counted repetition');
      if (!this.is('}')) {
        if (lo === null) this.syntax('repetition quantifier expects a valid decimal');
        const hi = this.decimal();
        if (hi === null) this.syntax('repetition quantifier expects a valid decimal');
        [min, max] = [lo, hi];
      } else {
        if (lo === null) this.syntax('repetition quantifier expects a valid decimal');
        [min, max] = [lo, null];
      }
    } else {
      if (lo === null) this.syntax('repetition quantifier expects a valid decimal');
      [min, max] = [lo, lo];
    }
    if (this.eof() || !this.is('}')) this.syntax('unclosed counted repetition');
    this.i++;
    let lazy = false;
    if (!this.eof() && this.is('?')) { lazy = true; this.i++; }
    if (max !== null && min > max) this.syntax('invalid repetition count range');
    items.push({ k: 'rep', sub, min, max, greedy: this.greedy(lazy) });
  }

  // A literal code point as the translator makes it: folded under (?i). A \n or a NUL is
  // judged after the HIR is built (checkHir), as rg judges it (RG-RE-ALT-MERGE).
  literal(c) {
    return { k: 'cls', set: this.flags.i ? foldClass(single(c)) : single(c) };
  }

  parsePrimitive() {
    const c = this.c();
    if (c === ch('\\')) return this.parseEscape(false);
    this.i++;
    if (c === ch('.')) return { k: 'cls', set: negate(single(0x0a)) };
    if (c === ch('^')) return { k: 'look', look: 'startLF' };
    if (c === ch('$')) return { k: 'look', look: 'endLF' };
    return this.literal(c);
  }

  // `\...` -> a HIR node (outside a class), or for a class item { lit } | { set } (inClass).
  parseEscape(inClass) {
    this.i++; // backslash
    if (this.eof()) this.syntax('incomplete escape sequence');
    const c = this.c();
    const s = String.fromCodePoint(c);
    if (/[0-9]/.test(s)) this.syntax('backreferences are not supported');
    if (s === 'x' || s === 'u' || s === 'U') {
      const v = this.parseHex(s);
      return inClass ? { lit: v } : this.literal(v);
    }
    if (s === 'p' || s === 'P') refuse('RG-RE-REFUSE-UNICODE-CLASS', `\\${s}`);
    if ('dswDSW'.includes(s)) {
      this.i++;
      const t = data();
      const base = s.toLowerCase() === 'd' ? t.digit : s.toLowerCase() === 's' ? t.space : t.word;
      const set = s === s.toUpperCase() ? negate(base) : base;
      return inClass ? { set } : { k: 'cls', set };
    }
    this.i++;
    if (META.has(s) || isEscapeable(c)) return inClass ? { lit: c } : this.literal(c);
    const special = { a: 7, f: 12, t: 9, n: 10, r: 13, v: 11 }[s];
    if (special !== undefined) return inClass ? { lit: special } : this.literal(special);
    if (inClass) {
      if ('AzbB<>'.includes(s)) this.syntax('invalid escape sequence in a character class');
      this.syntax('unrecognized escape sequence');
    }
    if (s === 'A' || s === 'z') refuse('RG-RE-REFUSE-TEXT-ANCHOR', `\\${s}`);
    if (s === 'B') return { k: 'look', look: 'notWord' };
    if (s === '<') return { k: 'look', look: 'wordStart' };
    if (s === '>') return { k: 'look', look: 'wordEnd' };
    if (s === 'b') {
      if (!this.eof() && this.is('{')) {
        const save = this.i;
        this.i++;
        if (this.eof()) this.syntax('unexpected end of special word boundary or repetition');
        if (/[A-Za-z-]/.test(String.fromCodePoint(this.c()))) {
          let name = '';
          while (!this.eof() && /[A-Za-z-]/.test(String.fromCodePoint(this.c()))) { name += String.fromCodePoint(this.c()); this.i++; }
          if (this.eof() || !this.is('}')) this.syntax('unclosed special word boundary');
          this.i++;
          const look = { start: 'wordStart', end: 'wordEnd', 'start-half': 'wordStartHalf', 'end-half': 'wordEndHalf' }[name];
          if (!look) this.syntax('unrecognized special word boundary');
          return { k: 'look', look };
        }
        this.i = save;
      }
      return { k: 'look', look: 'word' };
    }
    return this.syntax('unrecognized escape sequence');
  }

  parseHex(kind) {
    const digits = kind === 'x' ? 2 : kind === 'u' ? 4 : 8;
    this.i++;
    if (this.eof()) this.syntax('incomplete escape sequence');
    let h = '';
    if (this.is('{')) {
      for (;;) {
        this.i++;
        if (this.eof()) this.syntax('incomplete escape sequence');
        if (this.is('}')) break;
        if (!isHex(this.c())) this.syntax('invalid hexadecimal digit');
        h += String.fromCodePoint(this.c());
      }
      this.i++;
      if (!h) this.syntax('empty hexadecimal literal');
    } else {
      for (let k = 0; k < digits; k++) {
        if (k > 0) { this.i++; if (this.eof()) this.syntax('incomplete escape sequence'); }
        if (!isHex(this.c())) this.syntax('invalid hexadecimal digit');
        h += String.fromCodePoint(this.c());
      }
      this.i++;
    }
    const v = h.length > 8 ? Infinity : parseInt(h, 16);
    if (!(v <= 0x10ffff) || (v >= 0xd800 && v <= 0xdfff)) this.syntax('invalid hexadecimal value');
    return v;
  }

  // `[...]`: regex-syntax's parse_set_class without nesting or set operations (refused).
  parseBracket() {
    const start = this.i;
    this.i++; // [
    if (this.eof()) this.syntax('unclosed character class');
    let negated = false;
    if (this.is('^')) { negated = true; this.i++; if (this.eof()) this.syntax('unclosed character class'); }
    let acc = [];
    let any = false;
    while (this.is('-')) { acc.push(0x2d, 0x2d); any = true; this.i++; if (this.eof()) this.syntax('unclosed character class'); }
    if (!any && this.is(']')) { acc.push(0x5d, 0x5d); this.i++; if (this.eof()) this.syntax('unclosed character class'); }
    for (;;) {
      if (this.eof()) this.syntax(`unclosed character class (opened at character ${start})`);
      const c = this.c();
      if (c === ch('[')) {
        const a = this.maybeAscii();
        if (a) { acc = acc.concat(a); continue; }
        refuse('RG-RE-REFUSE-CLASS-SET', 'a nested class');
      }
      if (c === ch(']')) { this.i++; break; }
      if ((c === ch('&') && this.peek() === ch('&')) || (c === ch('-') && this.peek() === ch('-')) || (c === ch('~') && this.peek() === ch('~'))) {
        refuse('RG-RE-REFUSE-CLASS-SET', `the class operator ${String.fromCodePoint(c, c)}`);
      }
      acc = acc.concat(this.parseClassRange());
    }
    let set = norm(acc);
    if (this.flags.i) set = foldClass(set);
    if (negated) set = negate(set);
    return set;
  }
  // [:name:] / [:^name:] inside a class, or null (regex-syntax's maybe_parse_ascii_class).
  maybeAscii() {
    const save = this.i;
    const fail = () => { this.i = save; return null; };
    this.i++;
    if (this.eof() || !this.is(':')) return fail();
    this.i++;
    if (this.eof()) return fail();
    let neg = false;
    if (this.is('^')) { neg = true; this.i++; if (this.eof()) return fail(); }
    let name = '';
    while (!this.eof() && !this.is(':')) { name += String.fromCodePoint(this.c()); this.i++; }
    if (this.eof() || !this.bumpIf(':]')) return fail();
    if (!ASCII_NAMES.has(name)) return fail();
    let set = data().posix[name];
    if (this.flags.i) set = foldClass(set);
    return neg ? negate(set) : set;
  }
  classItem() {
    if (this.is('\\')) return this.parseEscape(true);
    const c = this.c();
    this.i++;
    return { lit: c };
  }
  parseClassRange() {
    const a = this.classItem();
    if (this.eof()) this.syntax('unclosed character class');
    if (!this.is('-') || this.peek() === ch(']') || this.peek() === ch('-')) return a.set ? a.set : [a.lit, a.lit];
    this.i++;
    if (this.eof()) this.syntax('unclosed character class');
    const b = this.classItem();
    if (a.set || b.set) this.syntax('invalid range boundary, must be a literal');
    if (a.lit > b.lit) this.syntax('invalid character class range');
    return [a.lit, b.lit];
  }
}

// ---- the HIR's length properties and smart constructors (regex-syntax hir/mod.rs) ---------------
// minLen / maxLen in BYTES; null = none (unbounded, or matches nothing).
function lens(n) {
  if (n.lens) return n.lens;
  let r;
  switch (n.k) {
    case 'empty': case 'look': r = [0, 0]; break;
    case 'cap': r = lens(n.sub); break;
    case 'cls': r = n.set.length ? [utf8Len(n.set[0]), utf8Len(n.set[n.set.length - 1])] : [null, null]; break;
    case 'rep': {
      const [a, b] = lens(n.sub);
      r = [a === null ? null : a * n.min, n.max === null || b === null ? null : b * n.max];
      break;
    }
    case 'cat': {
      let a = 0, b = 0;
      for (const s of n.subs) { const [x, y] = lens(s); a = a === null || x === null ? null : a + x; b = b === null || y === null ? null : b + y; }
      r = [a, b];
      break;
    }
    case 'alt': {
      let a, b, pa = false, pb = false;
      for (const s of n.subs) {
        const [x, y] = lens(s);
        if (!pa) { if (x === null) { a = null; pa = true; } else if (a === undefined || x < a) a = x; }
        if (!pb) { if (y === null) { b = null; pb = true; } else if (b === undefined || y > b) b = y; }
      }
      r = [a === undefined ? null : a, b === undefined ? null : b];
      break;
    }
    default: throw new Error(`rg-regex: no lengths for ${n.k}`);
  }
  n.lens = r;
  return r;
}
// The HIR as regex-syntax shapes it: groups dissolve, empties drop out of concatenations, and
// Hir::repetition's one semantic rule: a sub that can only match the empty string repeats at
// most once (min and max clamped to 1); x{0} is empty, x{1} is x.
function hir(n) {
  switch (n.k) {
    case 'group': return n.cap ? { k: 'cap', sub: hir(n.sub) } : hir(n.sub);
    case 'cap': return n;
    case 'cat': {
      const subs = [];
      for (const s of n.subs.map(hir)) { if (s.k === 'cat') subs.push(...s.subs); else if (s.k !== 'empty') subs.push(s); }
      return subs.length === 0 ? { k: 'empty' } : subs.length === 1 ? subs[0] : { k: 'cat', subs };
    }
    case 'alt': {
      const subs = [];
      for (const s of n.subs.map(hir)) { if (s.k === 'alt') subs.push(...s.subs); else subs.push(s); }
      if (subs.length === 1) return subs[0];
      // RG-RE-ALT-MERGE (Hir::alternation's singleton_chars / class_chars): branches that are ALL
      // single characters (a one-character class is a literal there), or ALL classes of any other
      // size, become one class. A mix, or anything else, stays an alternation.
      const one = (s) => s.k === 'cls' && count(s.set) === 1;
      const many = (s) => s.k === 'cls' && count(s.set) !== 1;
      if (subs.every(one) || subs.every(many)) return { k: 'cls', set: subs.reduce((a, s) => union(a, s.set), []) };
      return { k: 'alt', subs };
    }
    case 'rep': {
      const sub = hir(n.sub);
      let { min, max } = n;
      if (lens(sub)[1] === 0) { min = Math.min(min, 1); max = max === null ? 1 : Math.min(max, 1); }
      if (min === 0 && max === 0) return { k: 'empty' };
      if (min === 1 && max === 1) return sub;
      return { k: 'rep', sub, min, max, greedy: n.greedy };
    }
    default: return n;
  }
}

// rg's two refusals of a translated pattern, applied to the HIR as rg applies them, after
// RG-RE-ALT-MERGE: ban.rs first (a literal NUL, or a class of NUL alone: binary detection is on),
// then strip.rs (a literal \n, or a class of \n alone: no -U). A one-character class is a literal.
function checkHir(n) {
  switch (n.k) {
    case 'cls':
      if (n.set.length === 2 && n.set[0] === 0 && n.set[1] === 0) refuse('RG-RE-REFUSE-NUL', 'a NUL');
      if (n.set.length && !withoutNewline(n.set).length) refuse('RG-RE-REFUSE-NEWLINE', 'a \\n');
      return;
    case 'cat': case 'alt': for (const s of n.subs) checkHir(s); return;
    case 'rep': case 'cap': checkHir(n.sub); return;
    default: return;
  }
}

// ---- RG-RE-REFUSE-SIZE-LIMIT: an upper bound of the NFA rg would build --------------------------
// rg builds its regex with a 100 MiB NFA size limit (grep-regex config.rs size_limit) and refuses
// one past it: `compiled regex exceeds size limit of 104857600`, rc 2 (measured: `\w{2099}`,
// `.{104858}`, `a{3276794}` are its first refusals; `\w{2098}` it answers). The limit is on
// regex-automata 0.4.7's builder memory (builder.rs memory_usage): 32 bytes a state, 8 a byte-range
// transition, 4 a union alternate, for the forward NFA and the reverse one each. sizeBound() bounds
// that from ABOVE, construct by construct (a class by Utf8Sequences with no suffix sharing, which
// regex-automata's compilers only ever reduce; an all-literal alternation by its literal trie), so
// ours refuses wherever rg does, and earlier where sharing makes rg's NFA smaller. First refusals,
// ours / rg's (measured 2026-10-03): \w{752} / {2099}, \W{816} / {2251}, \d{10457} / {20465},
// .{85668} / {104858}, (?i)k{379917} / {444312}, (?:ab|cd){161817} / {416101}, [a-z]{1456349} /
// {1456353}, a{3276785} / {3276794} (a literal and an ASCII class cost what rg counts, 32 and 72
// bytes a copy; past 50,000 states RG-RE-REFUSE-SIZE refuses first anyway).
const ST = 32, TR = 8, AL = 4, UNION2 = ST + 2 * AL;
// Utf8Sequences (regex-syntax utf8.rs) over a class: how many sequences, and their bytes in all.
function utf8Shape(set) {
  let seqs = 0, bytes = 0;
  for (let i = 0; i < set.length; i += 2) {
    const stack = [[set[i], set[i + 1]]];
    while (stack.length) {
      let [s, e] = stack.pop();
      for (;;) {
        if (s < 0xe000 && e > 0xd7ff) { stack.push([0xe000, e]); e = 0xd7ff; continue; }
        if (s > e) break;
        let split = false;
        for (const max of [0x7f, 0x7ff, 0xffff]) if (s <= max && max < e) { stack.push([max + 1, e]); e = max; split = true; break; }
        if (split) continue;
        if (e <= 0x7f) { seqs++; bytes += 1; break; }
        for (let k = 1; k < 4 && !split; k++) {
          const m = (1 << (6 * k)) - 1;
          if ((s & ~m) !== (e & ~m)) {
            if ((s & m) !== 0) { stack.push([(s | m) + 1, e]); e = s | m; split = true; }
            else if ((e & m) !== m) { stack.push([e & ~m, e]); e = (e & ~m) - 1; split = true; }
          }
        }
        if (split) continue;
        seqs++; bytes += utf8Len(s);
        break;
      }
    }
  }
  return { seqs, bytes };
}
// The UTF-8 bytes of a parsed branch that is one case-sensitive literal string, else -1.
function literalBytes(n) {
  if (n.k === 'cls') return count(n.set) === 1 ? utf8Len(n.set[0]) : -1;
  if (n.k === 'group' && !n.cap) return literalBytes(n.sub);
  if (n.k !== 'cat') return -1;
  let b = 0;
  for (const x of n.subs) { const y = literalBytes(x); if (y < 0) return -1; b += y; }
  return b;
}
function sizeBound(n) {
  switch (n.k) {
    case 'empty': case 'look': return ST;
    case 'cls': {
      const c = count(n.set);
      if (c === 0) return 2 * ST;
      if (c === 1) return ST * utf8Len(n.set[0]);        // a one-character class is a literal: a state a byte
      if (n.set[n.set.length - 1] <= 0x7f) return 2 * ST + TR * (n.set.length / 2);
      const { seqs, bytes } = utf8Shape(n.set);
      return 2 * ST + (ST + TR) * bytes + AL * seqs;
    }
    case 'group': return (n.cap ? 2 * ST : 0) + sizeBound(n.sub);
    case 'cat': return n.subs.length ? n.subs.reduce((a, x) => a + sizeBound(x), 0) : ST;
    case 'alt': {
      let sum = 2 * ST + AL * n.subs.length, lit = 0, allLit = true;
      for (const x of n.subs) { sum += sizeBound(x); const b = literalBytes(x); if (b < 0) allLit = false; else lit += b; }
      // an all-literal alternation compiles as a literal trie (literal_trie.rs): per trie node at
      // most a range or sparse state, a union and their transitions and alternates
      return allLit ? Math.max(sum, 4 * ST + 4 * ST * lit + AL * n.subs.length) : sum;
    }
    case 'rep': {
      const e = sizeBound(n.sub), { min, max } = n;
      if (min === 0 && max === 1) return UNION2 + ST + e;
      if (max === null) return min === 0 ? e + 2 * UNION2 + ST : min === 1 ? e + UNION2 : min * e + UNION2;
      if (min === max) return min === 0 ? ST : min * e;
      return min * e + (max - min) * (e + UNION2) + ST;
    }
    default: throw new Error(`rg-regex: no size bound for ${n.k}`);
  }
}
// What every regex adds: group 0's capture states, the match state, the unanchored prefix.
const SIZE_OVERHEAD = 512;

// ---- the Thompson NFA, compiled as regex-automata's compiler.rs compiles it ----------------------
const EMPTY = 0, CLS = 1, LOOK = 2, SPLIT = 3, MATCH = 4;
const MAX_STATES = 50000;
class Builder {
  constructor() { this.kind = []; this.next = []; this.arg = []; this.alts = []; this.rev = []; }
  add(kind, arg) {
    if (this.kind.length >= MAX_STATES) refuse('RG-RE-REFUSE-SIZE', `more than ${MAX_STATES} NFA states`);
    this.kind.push(kind); this.next.push(-1); this.arg.push(arg === undefined ? -1 : arg); this.alts.push(null); this.rev.push(false);
    return this.kind.length - 1;
  }
  union(reverse) { const s = this.add(SPLIT); this.alts[s] = []; this.rev[s] = !!reverse; return s; }
  patch(from, to) { if (this.kind[from] === SPLIT) this.alts[from].push(to); else this.next[from] = to; }
  empty() { const s = this.add(EMPTY); return { start: s, end: s }; }
}
function compile(node, b, classes) {
  const c = (n) => compile(n, b, classes);
  switch (node.k) {
    case 'empty': return b.empty();
    case 'cls': { classes.push(node.set); const s = b.add(CLS, classes.length - 1); return { start: s, end: s }; }
    case 'look': { const s = b.add(LOOK, node.look); return { start: s, end: s }; }
    case 'cat': {
      const first = c(node.subs[0]);
      let end = first.end;
      for (let i = 1; i < node.subs.length; i++) { const x = c(node.subs[i]); b.patch(end, x.start); end = x.end; }
      return { start: first.start, end };
    }
    case 'alt': {
      const u = b.union(false), e = b.add(EMPTY);
      for (const sub of node.subs) { const x = c(sub); b.patch(u, x.start); b.patch(x.end, e); }
      return { start: u, end: e };
    }
    case 'rep': return compileRep(node, b, c);
    case 'cap': return c(node.sub);
    default: throw new Error(`rg-regex: cannot compile ${node.k}`);
  }
}
function exactly(n, k, b, c) {
  if (k === 0) return b.empty();
  const first = c(n);
  let end = first.end;
  for (let i = 1; i < k; i++) { const x = c(n); b.patch(end, x.start); end = x.end; }
  return { start: first.start, end };
}
function compileRep({ sub, min, max, greedy }, b, c) {
  const U = () => b.union(!greedy);
  if (min === 0 && max === 1) {                                         // c_zero_or_one
    const u = U(), x = c(sub), e = b.add(EMPTY);
    b.patch(u, x.start); b.patch(u, e); b.patch(x.end, e);
    return { start: u, end: e };
  }
  if (max === null) {                                                    // c_at_least
    if (min === 0) {
      if (lens(sub)[0] !== null && lens(sub)[0] > 0) {
        const u = U(), x = c(sub);
        b.patch(u, x.start); b.patch(x.end, u);
        return { start: u, end: u };
      }
      // x* where x can match empty, compiled as (x+)? (rust-lang/regex#779)
      const x = c(sub), plus = U();
      b.patch(x.end, plus); b.patch(plus, x.start);
      const q = U(), e = b.add(EMPTY);
      b.patch(q, x.start); b.patch(q, e); b.patch(plus, e);
      return { start: q, end: e };
    }
    if (min === 1) {
      const x = c(sub), u = U();
      b.patch(x.end, u); b.patch(u, x.start);
      return { start: x.start, end: u };
    }
    const pre = exactly(sub, min - 1, b, c), last = c(sub), u = U();
    b.patch(pre.end, last.start); b.patch(last.end, u); b.patch(u, last.start);
    return { start: pre.start, end: u };
  }
  if (min === max) return exactly(sub, min, b, c);                       // c_exactly
  const pre = exactly(sub, min, b, c), e = b.add(EMPTY);                // c_bounded
  let prev = pre.end;
  for (let i = min; i < max; i++) {
    const u = U(), x = c(sub);
    b.patch(prev, u); b.patch(u, x.start); b.patch(u, e);
    prev = x.end;
  }
  b.patch(prev, e);
  return { start: pre.start, end: e };
}

// The UTF-8 bytes of a pattern that is one case-sensitive literal string, else null.
function literalOf(node) {
  const parts = node.k === 'cls' ? [node] : node.k === 'cat' ? node.subs : null;
  if (!parts || !parts.every((x) => x.k === 'cls' && x.set.length === 2 && x.set[0] === x.set[1])) return null;
  return Buffer.from(String.fromCodePoint(...parts.map((x) => x.set[0])), 'utf8');
}

// A compiled program: flat typed arrays the Pike VM walks.
function program(node) {
  const b = new Builder(), classes = [];
  const body = compile(node, b, classes);
  const m = b.add(MATCH);
  b.patch(body.end, m);
  const n = b.kind.length;
  const kind = Uint8Array.from(b.kind), next = Int32Array.from(b.next);
  const LOOKS = ['startLF', 'endLF', 'word', 'notWord', 'wordStart', 'wordEnd', 'wordStartHalf', 'wordEndHalf'];
  const arg = new Int32Array(n);
  const alts = new Array(n).fill(null);
  for (let s = 0; s < n; s++) {
    if (kind[s] === LOOK) arg[s] = LOOKS.indexOf(b.arg[s]);
    else arg[s] = b.arg[s];
    if (kind[s] === SPLIT) alts[s] = Int32Array.from(b.rev[s] ? b.alts[s].slice().reverse() : b.alts[s]);
  }
  // each class with an ASCII bitmap for the common case
  const cls = classes.map((set) => {
    const ascii = new Uint8Array(128);
    for (let i = 0; i < set.length; i += 2) for (let c = set[i]; c <= set[i + 1] && c < 128; c++) ascii[c] = 1;
    return { set, ascii };
  });
  // RG-RE-REFUSE-LOOKBEHIND: \B and \b{start-half} are the look-behinds that tell an invalid
  // byte from a line's start; rg answers them differently by where the line sits (below).
  const lookbehind = b.kind.some((k, s) => k === LOOK && (b.arg[s] === 'notWord' || b.arg[s] === 'wordStartHalf'));
  let altsTotal = 0;
  for (const a of alts) if (a) altsTotal += a.length;
  // The FIRST-BYTE SKIP's tables: the classes the start's closure reaches, when it reaches no
  // assertion and no match (then every match starts with one of them).
  const first = [];
  let accel = true;
  const seen = new Set(), todo = [body.start];
  while (todo.length) {
    const st = todo.pop();
    if (seen.has(st)) continue;
    seen.add(st);
    if (kind[st] === CLS) first.push(cls[arg[st]]);
    else if (kind[st] === EMPTY) todo.push(next[st]);
    else if (kind[st] === SPLIT) todo.push(...alts[st]);
    else { accel = false; break; }                       // LOOK or MATCH
  }
  const firstAscii = new Uint8Array(128);
  let firstNonAscii = false;
  for (const k of first) {
    for (let c = 0; c < 128; c++) if (k.ascii[c]) firstAscii[c] = 1;
    if (k.set.length && k.set[k.set.length - 1] >= 0x80) firstNonAscii = true;
  }
  return { n, kind, next, arg, alts, cls, start: body.start, marks: new Int32Array(n), stamp: 0, steps: 0, lookbehind,
    aS: new Int32Array(n), aT: new Int32Array(n), bS: new Int32Array(n), bT: new Int32Array(n), stack: new Int32Array(altsTotal + n + 1),
    accel, firstAscii, firstNonAscii, lit: literalOf(node), mStart: -1, mEnd: -1 };
}

// ---- UTF-8 as regex-automata's util/utf8.rs decodes it ------------------------------------------
// decode(buf, p, end): the code point at p and its length in `len`, or -1 (an invalid unit).
let _len = 1;
function decode(buf, p, end) {
  const b0 = buf[p];
  if (b0 < 0x80) { _len = 1; return b0; }
  let n;
  if ((b0 & 0xc0) === 0x80) n = 0; else if (b0 <= 0xdf) n = 2; else if (b0 <= 0xef) n = 3; else if (b0 <= 0xf7) n = 4; else n = 0;
  _len = 1;
  if (n === 0 || p + n > end) return -1;
  const b1 = buf[p + 1];
  if (n === 2) {
    if (b0 < 0xc2 || (b1 & 0xc0) !== 0x80) return -1;
    _len = 2; return ((b0 & 0x1f) << 6) | (b1 & 0x3f);
  }
  const b2 = buf[p + 2];
  if (n === 3) {
    const lo = b0 === 0xe0 ? 0xa0 : 0x80, hi = b0 === 0xed ? 0x9f : 0xbf;
    if (b1 < lo || b1 > hi || (b2 & 0xc0) !== 0x80) return -1;
    _len = 3; return ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f);
  }
  const b3 = buf[p + 3];
  const lo = b0 === 0xf0 ? 0x90 : 0x80, hi = b0 === 0xf4 ? 0x8f : 0xbf;
  if (b0 > 0xf4 || b1 < lo || b1 > hi || (b2 & 0xc0) !== 0x80 || (b3 & 0xc0) !== 0x80) return -1;
  _len = 4; return ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
}
// decode_last(buf[from..at]): Rust's own, including its quirk (it backs up over at most three
// continuation bytes and decodes the FIRST character there, which may end before `at`).
// -2: nothing before `at`; -1: invalid; else the code point.
function decodeLast(buf, from, at) {
  if (at <= from) return -2;
  let s = at - 1;
  const limit = Math.max(from, at - 4);
  while (s > limit && (buf[s] & 0xc0) === 0x80) s--;
  return decode(buf, s, at);
}
const isWord = (c) => c >= 0 && (c < 128 ? (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || c === 0x5f || (c >= 0x61 && c <= 0x7a) : has(data().word, c));

// The look-arounds at `at`, the haystack being the line [from, end) (look.rs).
function lookAt(kind, buf, from, end, at) {
  switch (kind) {
    case 0: return at === from;                                          // ^ (StartLF)
    case 1: return at === end;                                           // $ (EndLF)
    default: break;
  }
  const before = decodeLast(buf, from, at);
  const after = at < end ? decode(buf, at, end) : -2;
  const wb = isWord(before), wa = isWord(after);
  switch (kind) {
    case 2: return wb !== wa;                                            // \b
    case 3: return before !== -1 && after !== -1 && wb === wa;           // \B: never inside invalid UTF-8
    case 4: return !wb && wa;                                            // \b{start}, \<
    case 5: return wb && !wa;                                            // \b{end}, \>
    case 6: return before !== -1 && !wb;                                 // \b{start-half}
    case 7: return after !== -1 && !wa;                                  // \b{end-half}
    default: throw new Error(`rg-regex: look ${kind}`);
  }
}

// ---- the Pike VM (regex-automata's nfa/thompson/pikevm.rs search_imp) ----------------------------
// Threads are (state, start) pairs in priority order, in typed arrays the program owns (no
// allocation per position). One leftmost-first search of the line [from, end) starting at `at`:
// sets prog.mStart/prog.mEnd and returns true, or returns false.
// The epsilon closure of `sid` at position p, appended to (S, T) from N; returns the new length.
// Module state (_c*) rather than a closure made per search: JS here is single-threaded and a
// search never re-enters itself.
let _cProg = null, _cBuf = null, _cFrom = 0, _cEnd = 0, _cBase = 0, _cSteps = 0;
function closure(sid, p, S, T, N, start) {
  const { kind, next, arg, alts, marks, stack } = _cProg;
  const stamp = _cBase + p;
  let sp = 0;
  stack[sp++] = sid;
  while (sp) {
    let st = stack[--sp];
    for (;;) {
      if (marks[st] === stamp) break;
      marks[st] = stamp;
      _cSteps++;
      const k = kind[st];
      if (k === CLS || k === MATCH) { S[N] = st; T[N] = start; N++; break; }
      if (k === EMPTY) { st = next[st]; continue; }
      if (k === LOOK) { if (!lookAt(arg[st], _cBuf, _cFrom, _cEnd, p)) break; st = next[st]; continue; }
      // SPLIT: the first alternative now, the rest in order after it
      const a = alts[st];
      if (!a.length) break;
      for (let i = a.length - 1; i >= 1; i--) stack[sp++] = a[i];
      st = a[0];
    }
  }
  return N;
}
// One leftmost-first search of the line [from, end) starting at `at`, RESUMABLE: searchStart sets it
// up in prog.cur, searchRun runs it until it ends (1: a match, in prog.mStart/prog.mEnd; 0: none) or
// has taken `limit` steps (-1: paused between two positions, to be run again). Pausing changes
// nothing it finds: the threads, the landing set and the visited stamps all wait in prog.cur.
function searchStart(prog, buf, from, end, at) {
  const { marks } = prog;
  if (prog.stamp > 0x3fffffff - 2 * (end - at + 2)) { marks.fill(0); prog.stamp = 0; }
  const base = prog.stamp + 1 - at;        // the visited stamp for position p is base + p
  prog.stamp += end - at + 2;
  prog.cur = { buf, from, end, base, p: at, curS: prog.aS, curT: prog.aT, landS: prog.bS, landT: prog.bT,
    landN: 0, landAt: -1, hmStart: -1, hmEnd: -1 };
}
function searchRun(prog, limit) {
  const { kind, next, arg, cls, accel, firstAscii, firstNonAscii } = prog;
  const st0 = prog.cur;
  const { buf, from, end } = st0;
  _cProg = prog; _cBuf = buf; _cFrom = from; _cEnd = end; _cSteps = 0; _cBase = st0.base;
  let { p, curS, curT, landS, landT, landN, landAt, hmStart, hmEnd } = st0;
  let curN = 0, steps = 0, paused = false;
  // RG-RE-LINEAR-TIME, counted: each state is entered at most once per position (the closure's
  // visited stamp) and each thread stepped at most once, so steps <= 2 x states x positions.
  for (; p <= end; p++) {
    if (steps + _cSteps >= limit) { paused = true; break; }
    if (p === landAt) {
      const s0 = curS, t0 = curT;
      curS = landS; curT = landT; curN = landN;
      landS = s0; landT = t0; landN = 0; landAt = -1;
    } else curN = 0;
    if (curN === 0 && landAt === -1) {
      if (hmEnd >= 0) break;
      // FIRST-BYTE SKIP, when the start can neither match empty nor look around: a position
      // whose byte no first class can begin cannot start a match, so it is passed over.
      if (accel) {
        while (p < end) {
          const c0 = buf[p];
          if (c0 < 0x80 ? firstAscii[c0] : (firstNonAscii && c0 >= 0xc2 && c0 <= 0xf4)) break;
          p++;
        }
      }
    }
    if (hmEnd < 0) curN = closure(prog.start, p, curS, curT, curN, p);
    if (!curN) continue;
    const c = p < end ? decode(buf, p, end) : -1, len = _len;
    for (let i = 0; i < curN; i++) {
      const sid = curS[i];
      steps++;
      if (kind[sid] === MATCH) { hmStart = curT[i]; hmEnd = p; break; }
      if (c < 0) continue;
      const k = cls[arg[sid]];
      if (c < 128 ? k.ascii[c] : has(k.set, c)) { landN = closure(next[sid], p + len, landS, landT, landN, curT[i]); landAt = p + len; }
    }
  }
  const used = steps + _cSteps;
  prog.steps += used;
  _cProg = null; _cBuf = null;
  if (paused) {
    Object.assign(st0, { p, curS, curT, landS, landT, landN, landAt, hmStart, hmEnd });
    return { state: -1, used };
  }
  prog.cur = null;
  if (hmEnd < 0) return { state: 0, used };
  prog.mStart = hmStart; prog.mEnd = hmEnd;
  return { state: 1, used };
}

// ---- rg's find_iter over one line (grep-matcher's try_find_iter_at) ------------------------------
// lineVerifier(buf, start, end, compiled) -> { run(maxSteps) }: every match rg's matcher reports on
// the line [start, end) (the terminator excluded), as [{ start, end }] in buf's offsets, once run()
// has taken the steps it needs; until then run() returns null (paused) and is called again.
// verifyLine is one run to the end. RG-EMPTY-AFTER-MATCH: an empty match at the end of the match
// before it is skipped, and after an empty match the next search starts one BYTE on (so inside a
// character, where only empty matches occur). An empty result means rg does not select the line.
// RG-RE-REFUSE-LOOKBEHIND (measured 2026-10-03): on a line whose first byte is a UTF-8
// continuation byte, rg answers \B and \b{start-half} one byte into the line by the bytes
// BEFORE the line: `\b{start-half}` on `\x80 x` reports offset 1 when the line starts at byte 4
// or later and not when it starts at 2 or 3, while its line selection sees the line alone. On
// every other line the look-behind stops inside the line, and both readings agree.
// RG-RE-REFUSE-COST: one line's matching may take at most lineStepBudget(its length) steps:
// STEPS_PER_BYTE x (length + 1) + STEP_BUDGET_FLOOR. RG-RE-LINEAR-TIME bounds ONE search by
// 2 x states x positions, so a line costs states x length per search, and rg's find_iter can search
// a line once per match, which makes a line O(states x length^2) at worst (`a.*z|a`). So the budget
// scales with the line (review N1: a flat 2^24 refused ORDINARY patterns on minified lines past
// about 3 MB, and one refused line fails the whole search; the pinned carve's cli.cjs is one 59 MB
// line). Measured in steps per byte (2026-10-03): ordinary patterns over a 5 MB slice of that line
// take at most 12 (`\w+` 3.4, `"[^"]*"` 3.8, `[a-zA-Z_]\w*\(` 4.4, `import.*from` 5.0, `x|` 7.0,
// `[^,;]{20,}` 12.0), and the same over a synthetic 5 MB bundle line; the pathological lines take 194
// (`[a-z]{1,64}@` over 200 KB of letters), 303 (`.{0,100}needle`), 2,000 (`\w{2000}`) and 12,500
// (`a.*z|a` over 5 KB). 64 sits between: five times the costliest ordinary pattern, a third of the
// cheapest pathological one. The floor (2^20) is for short lines, where a pattern's own size
// dominates. tjs runs about 5 million steps a second here, so a refused line has cost at most
// 13 microseconds a byte; an ordinary one is answered whatever its length.
const STEPS_PER_BYTE = 64, STEP_BUDGET_FLOOR = 2 ** 20;
const lineStepBudget = (len) => STEPS_PER_BYTE * (len + 1) + STEP_BUDGET_FLOOR;
function lineVerifier(buf, start, end, compiled) {
  const prog = compiled.prog || compiled;
  if (prog.lookbehind && start < end && (buf[start] & 0xc0) === 0x80) {
    throw new RgRegexRefusal('RG-RE-REFUSE-LOOKBEHIND', `a line at byte ${start} starts with a continuation byte`);
  }
  const out = [];
  // RG-RE-LITERAL: a pattern that is one case-sensitive literal (no class, no assertion, never
  // empty) matches where its UTF-8 bytes occur, leftmost and without overlap, which is what the
  // Pike VM would find, found by search for the bytes instead. A literal's first byte is never a
  // continuation byte, so an occurrence always starts on a character.
  if (prog.lit) {
    const line = buf.subarray(start, end), lit = prog.lit;
    for (let i = line.indexOf(lit); i !== -1; i = line.indexOf(lit, i + lit.length)) out.push({ start: start + i, end: start + i + lit.length });
    return { run: () => out };
  }
  let lastEnd = start, lastMatch = -1, searching = false, spent = 0, done = false;
  const budget = lineStepBudget(end - start);
  const run = (maxSteps) => {
    if (done) return out;
    let left = maxSteps;
    for (;;) {
      if (!searching) {
        if (lastEnd > end) { done = true; return out; }
        searchStart(prog, buf, start, end, lastEnd);
        searching = true;
      }
      const r = searchRun(prog, Math.min(left, budget - spent + 1));
      spent += r.used; left -= r.used;
      if (spent > budget) {
        prog.cur = null;
        throw new RgRegexRefusal('RG-RE-REFUSE-COST', `a line at byte ${start} (${end - start} bytes) needs more than ${budget} steps`);
      }
      if (r.state === -1) return null;                          // paused, run again
      searching = false;
      if (r.state === 0) { done = true; return out; }
      const m = { start: prog.mStart, end: prog.mEnd };
      if (m.start === m.end) {
        lastEnd = m.end + 1;
        if (m.end === lastMatch) continue;
      } else lastEnd = m.end;
      lastMatch = m.end;
      out.push(m);
      if (left <= 0) return null;
    }
  };
  return { run };
}
function verifyLine(buf, start, end, compiled) {
  return lineVerifier(buf, start, end, compiled).run(Infinity);
}

// ---- the prefilter: ugrep's default dialect, a superset by construction --------------------------
const PREFILTER_SMALL = 8;
const ugrepLit = (c) => (/[A-Za-z0-9_]/.test(String.fromCodePoint(c)) && c < 128 ? String.fromCodePoint(c)
  : c < 128 ? `\\x${c.toString(16).padStart(2, '0')}` : `\\x{${c.toString(16)}}`);
function isAlnumRanges(set) {
  const ok = [[0x30, 0x39], [0x41, 0x5a], [0x5f, 0x5f], [0x61, 0x7a]];
  for (let i = 0; i < set.length; i += 2) if (!ok.some(([lo, hi]) => set[i] >= lo && set[i + 1] <= hi)) return false;
  return true;
}
// One class, widened for ugrep (the class rules in the header).
function clsPre(fullSet) {
  const set = withoutNewline(fullSet);
  if (count(set) === 0) return '.';                   // matches nothing: any widening will do
  if (count(set) === 1) return ugrepLit(set[0]);
  if (isAlnumRanges(set)) {
    let s = '[';
    for (let i = 0; i < set.length; i += 2) s += set[i] === set[i + 1] ? String.fromCodePoint(set[i]) : `${String.fromCodePoint(set[i])}-${String.fromCodePoint(set[i + 1])}`;
    return s + ']';
  }
  if (count(set) <= PREFILTER_SMALL) {
    const m = [];
    for (let i = 0; i < set.length; i += 2) for (let c = set[i]; c <= set[i + 1]; c++) m.push(ugrepLit(c));
    return `(?:${m.join('|')})`;
  }
  return '.';
}
// THE PIECES RULE: no prefilter holds an unbounded repetition, a counted repetition inside
// another, or an exact part heavier than PREFILTER_WEIGHT, because ugrep is slow on each over a long
// line. Measured on ugrep 7.8.2 over a 5 MB minified line with no match (2026-10-03):
//   unbounded   `needle` 46 ms; `(?:.)*needle` over 20 minutes; `x(?:.)*needle`, `(?:.)+needle`
//               past 20 s
//   nested      `(?:(?:.){0,16}b){2}` 1.6 s, `{4}` / `{8}` / `{16}` past 30 s (the DFA grows with
//               the product of the counts)
//   weight      `(?:.){0,k}needle` takes 123 ms at k = 4, 189 at 8, 340 at 16, 696 at 32,
//               1,219 at 64, 2,276 at 128: about linear in the window
// So a counted repetition is exact only when its sub holds none, its count is at most SMALL_REP,
// and its weight (count x the sub's weight; a character 1, a concatenation or alternation the
// sum of its parts) is at most PREFILTER_WEIGHT = 32, which keeps any prefilter under about 0.7 s
// over a 5 MB line. A node is summarised as EXACT (a pattern matching every string the node
// matches) or else as HEAD / TAIL (what every match of it starts / ends with) and BEST (a piece
// every match of it contains). A concatenation joins exact parts into pieces, starting a new piece
// where the next part would pass the weight, and breaks a piece at a part that is not exact,
// keeping that part's head on the left and its tail on the right; a repetition that is not exact
// gives one copy of its sub, or nothing when it may repeat zero times. Every match of the whole
// contains every piece, so the highest-scoring piece (literal characters 2, other classes 1,
// `.` 0) is a superset filter; a piece past the weight is dropped (nothing required), never kept.
const SMALL_REP = 16, PREFILTER_WEIGHT = 32;
const NOTHING = { pat: '', score: 0, weight: 0, reps: false };
const pieceOf = (parts) => ({ pat: parts.map((x) => x.pat).join(''), score: parts.reduce((a, x) => a + x.score, 0),
  weight: parts.reduce((a, x) => a + x.weight, 0), reps: parts.some((x) => x.reps) });
const light = (x) => (x.weight > PREFILTER_WEIGHT ? NOTHING : x);
const better = (a, b) => (b.score > a.score || (b.score === a.score && b.pat.length > a.pat.length) ? b : a);
// An alternation of required pieces: nothing is required when one branch requires nothing.
function altPiece(list) {
  if (list.some((x) => x.pat === '')) return NOTHING;
  return light({ pat: list.length === 1 ? list[0].pat : `(?:${list.map((x) => x.pat).join('|')})`, score: Math.min(...list.map((x) => x.score)),
    weight: list.reduce((a, x) => a + x.weight, 0), reps: list.some((x) => x.reps) });
}
// An alternation of exact branches: one that matches only the empty string makes it optional.
function altExact(list) {
  const real = list.filter((x) => x.pat !== '');
  if (!real.length) return NOTHING;
  const g = `(?:${real.map((x) => x.pat).join('|')})`;
  const weight = real.reduce((a, x) => a + x.weight, 0), reps = real.some((x) => x.reps);
  return real.length < list.length ? { pat: `${g}?`, score: 0, weight, reps } : { pat: g, score: Math.min(...real.map((x) => x.score)), weight, reps };
}
// An exact summary also serves as its own head, tail and best.
const asExact = (e) => ({ exact: e, head: e, tail: e, best: e });
function summary(n) {
  switch (n.k) {
    case 'empty': case 'look': return asExact(NOTHING);
    // a literal character narrows most, a class less, `.` not at all
    case 'cls': {
      const p = clsPre(n.set);
      return asExact({ pat: p, score: p === '.' ? 0 : count(withoutNewline(n.set)) === 1 ? 2 : 1, weight: 1, reps: false });
    }
    case 'cap': return summary(n.sub);
    case 'cat': {
      const pieces = [], cands = [];
      let cur = [], curW = 0, exact = true;
      const close = () => { pieces.push(pieceOf(cur)); cur = []; curW = 0; };
      for (const c of n.subs) {
        const sc = summary(c);
        if (sc.exact) {
          if (curW + sc.exact.weight > PREFILTER_WEIGHT) { exact = false; close(); }
          cur.push(sc.exact); curW += sc.exact.weight;
          continue;
        }
        exact = false;
        if (curW + sc.head.weight > PREFILTER_WEIGHT) close();
        cur.push(sc.head);
        close();
        cands.push(sc.best);
        cur = [sc.tail]; curW = sc.tail.weight;
      }
      close();
      if (exact) return asExact(pieces[0]);
      return { exact: null, head: light(pieces[0]), tail: light(pieces[pieces.length - 1]), best: [...pieces, ...cands].map(light).reduce(better, NOTHING) };
    }
    case 'alt': {
      const ss = n.subs.map(summary);
      if (ss.every((x) => x.exact)) {
        const e = altExact(ss.map((x) => x.exact));
        if (e.weight <= PREFILTER_WEIGHT) return asExact(e);
      }
      return { exact: null, head: altPiece(ss.map((x) => x.head)), tail: altPiece(ss.map((x) => x.tail)), best: altPiece(ss.map((x) => x.best)) };
    }
    case 'rep': {
      const sc = summary(n.sub), { min, max } = n;
      if (sc.exact && max !== null && max <= SMALL_REP && !sc.exact.reps && max * sc.exact.weight <= PREFILTER_WEIGHT) {
        if (sc.exact.pat === '') return asExact(NOTHING);
        const q = min === 0 && max === 1 ? '?' : min === max ? `{${min}}` : `{${min},${max}}`;
        return asExact({ pat: `(?:${sc.exact.pat})${q}`, score: min > 0 ? sc.exact.score * min : 0, weight: max * sc.exact.weight, reps: true });
      }
      if (min === 0) return { exact: null, head: NOTHING, tail: NOTHING, best: NOTHING };
      return { exact: null, head: sc.head, tail: sc.tail, best: sc.best };
    }
    default: throw new Error(`rg-regex: no prefilter for ${n.k}`);
  }
}
// -> a ugrep pattern string, '' for "every line".
function pre(n) {
  return summary(n).best.pat;
}

// ---- the entry point ------------------------------------------------------------------------------
// translateRgRegex(pattern, { ignoreCase }) -> { prog, prefilter } | { refuse, rule }.
// `prog` is the compiled matcher verifyLine runs; `prefilter` the ugrep pattern ('' = every line).
// rg wraps each pattern as `(?:PATTERN)` before parsing (grep-regex config.rs), so `a)(b` is
// `(?:a)(b)` there and here.
function translateRgRegex(pattern, opts = {}) {
  try {
    const ps = new Parser(`(?:${pattern})`, opts.ignoreCase);
    const ast = ps.parseGroupBody();
    if (!ps.eof()) ps.syntax('unopened group');
    const bound = sizeBound(ast) + SIZE_OVERHEAD;
    if (bound > NFA_SIZE_LIMIT) refuse('RG-RE-REFUSE-SIZE-LIMIT', `an NFA of up to ${bound > 1e15 ? 'more than 1e15' : Math.ceil(bound)} bytes`);
    const node = hir(ast);
    checkHir(node);
    return { prog: program(node), prefilter: pre(node) };
  } catch (e) {
    if (e instanceof RgRegexRefusal) return { refuse: refusalReason(e), rule: e.rule };
    throw e;
  }
}

module.exports = { translateRgRegex, verifyLine, lineVerifier, lineStepBudget, REFUSALS, RgRegexRefusal, refusalReason };
