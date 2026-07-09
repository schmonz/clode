# ada-ectomy contract — Phase 1 (characterization)

Date: 2026-07-09. Binary: `build/tjs/tjs` (quickjs-ng + txiki v26.6.0,
vendored ada 3.4.2). Reference engine: host node (24.18.0/26.3.0, ada 3.4.4 —
also ada-backed, hence the near-exact differential).

Goal: replace `deps/ada` (`ada.cpp`, 977 KB, txiki's ONLY C++ translation
unit, requires C++20) with plain C. Before any C is written, this document
plus the golden manifest freeze today's behavior as the contract.

## Artifacts

- Corpus + runners + golden: `test/fixtures/url/` (see its README for wpt
  provenance: commit `181476aa16e8b28a07698bef3a0275fa53dd22e5`, 3-Clause BSD).
- Gate: `test/url-characterization.test.cjs` (node:test, skips without tjs
  binary; golden regen only via `CLODE_REGEN_URL_GOLDEN=1`).
- Golden: `test/fixtures/url/golden-tjs-url.json`,
  sha256 `3debd9afc5ae84c5f3825f8d9054ca47698fbc767625bad392c67253ad1dd4f7`.

## Numbers

- 1,317 corpus cases total: 891 parse (urltestdata) + 278 setters +
  87 toascii + 7 percent-encoding (utf-8 leg) + 54 hand-written
  URLSearchParams.
- node-vs-tjs: 1,284 agree, **33 diverge** (97.5%). Every divergence is
  explained by three root causes (below); none is an ada-parser disagreement.
- `nonAsciiHost`-tagged cases (IDNA-relevant, tagged deterministically from
  input text in the golden): 41 parse + 8 setters + 63 toascii = **112**.

## JS-reachable URL surface in tjs

- `globalThis.URL`, `globalThis.URLSearchParams`: native, `src/url.c` only.
  `URL.canParse`, `URL.parse` (static) included. `origin`, `toString`,
  `toJSON`, `searchParams` (cached, two-way synced), `URLSearchParams.size`,
  iteration (`entries`/`keys`/`values` return **arrays**, not iterators;
  `Symbol.iterator` added in JS via generator over `entries()`).
- `URLPattern`: pure-JS `urlpattern-polyfill` (src/js/polyfills/url.js);
  depends only on `URL`. **No C work needed.**
- `URL.createObjectURL`/`revokeObjectURL`: JS-side registry. No C work.
- IDNA: this build does **full UTS-46** — `new URL('http://bücher.de/')` →
  `xn--bcher-kva.de` (probed live); fullwidth mapping, ignorables, deviation
  chars, mathematical alphanumerics all mapped per corpus. `ada_idna_to_ascii`
  / `ada_idna_to_unicode` exist in ada_c.h but are NOT called by url.c.
- `src/url.c` is the only C consumer of `<ada_c.h>` (79 call sites, 58
  distinct functions).

## The C API to reproduce (what url.c actually calls)

Only these 58 functions need to exist. Everything else in ada_c.h
(`ada_copy`, `ada_get_components`, `ada_get_host_type`, `ada_get_scheme_type`,
all 9 `ada_has_*`, `ada_clear_port`, `ada_clear_hash`, `ada_idna_to_*`,
`ada_get_version*`, `ada_url_omitted`) is dead weight for tjs.

### URL object (29 functions)

| group | functions | contract url.c relies on |
| --- | --- | --- |
| parse | `ada_parse(input,len)`, `ada_parse_with_base(input,len,base,len)` | Always returns a handle (even on failure); failure is signaled by `ada_is_valid(h)==false`. `ada_free` must accept the invalid handle. Input is UTF-8, length-measured — but url.c computes `len = strlen(input)` from a `JS_ToCString` buffer, so embedded NUL truncates before the parser ever sees it (see F1). |
| validity | `ada_is_valid(h)` | Checked once after parse / can_parse never on getters. |
| free | `ada_free(h)`, `ada_free_owned_string(s)` | Idempotence not required; each owned string freed exactly once. |
| canParse | `ada_can_parse(input,len)`, `ada_can_parse_with_base(...)` | Pure boolean; must agree with parse+is_valid. |
| getters | `ada_get_href/protocol/username/password/host/hostname/port/pathname/search/hash` → `ada_string` | Borrowed view `{data,len}` into the URL's internal serialization; url.c copies immediately via `JS_NewStringLen` and holds no view across calls. Need NOT be NUL-terminated. Empty component → `{*, 0}` (data pointer may be anything when len 0). |
| origin | `ada_get_origin` → `ada_owned_string` | Caller-owned; url.c frees via `ada_free_owned_string`. Opaque-origin serializes as `"null"`. |
| setters | `ada_set_href` (bool; url.c throws TypeError on false), `ada_set_protocol/username/password/host/hostname/port/pathname` (bool, **return value ignored** — forgiving: on invalid input the component is left unchanged), `ada_set_search`, `ada_set_hash` (void) | All take strlen-measured C strings (F1 applies to setter values too). After `set_href` and `set_search`, url.c re-syncs a cached URLSearchParams via `ada_search_params_reset` with the new search minus leading `?`. |
| clear | `ada_clear_search` | Used when an attached URLSearchParams serializes to `""`: removes `?` entirely from href. Distinct from `ada_set_search("")` (which url.c never calls with empty—it branches to clear). |

### URLSearchParams (29 functions)

| group | functions | contract |
| --- | --- | --- |
| lifecycle | `ada_parse_search_params(input,len)`, `ada_free_search_params` | Parses application/x-www-form-urlencoded. url.c strips ONE leading `?` itself before calling — and ada strips another (finding F2, frozen in golden). Empty input → empty list. |
| serialize | `ada_search_params_to_string` → owned string | Used for `toString`, copy-construction, and URL sync. Must round-trip raw bytes of invalid-%-UTF-8 (finding F3). |
| mutate | `append`, `set`, `remove(key)`, `remove_value(key,val)`, `reset(input,len)`, `sort` | `set` replaces first occurrence, drops the rest, appends if missing. `sort` is **stable**, keyed by UTF-16 code-unit order (not byte order — matters above the BMP). `reset` re-parses in place (used by URL→params sync). |
| query | `size`, `has(key)`, `has_value(key,val)`, `get(key)` → borrowed `ada_string`, `get_all(key)` → `ada_strings` | url.c calls `has()` BEFORE `get()` to distinguish missing (JS null) from empty — `get`'s missing-key return value is never interpreted. `ada_strings`: `ada_strings_size`, `ada_strings_get(i)` (borrowed views), `ada_free_strings`. |
| iterate | `get_entries/get_keys/get_values` + per-kind `*_iter_has_next` / `*_iter_next` / `free_*_iter` | url.c materializes complete arrays immediately while performing no mutation, so index-based iteration over the live list is sufficient; no snapshot or invalidation semantics are relied on. `entries_iter_next` returns `ada_string_pair` of borrowed views. |

### Encoding boundary (binding-level, unchanged by the swap)

- JS→C: `JS_ToCString` produces UTF-8 (WTF-8 for lone surrogates) and url.c
  measures with `strlen` — the C parser never sees embedded NUL (F1).
- C→JS: `JS_NewStringLen` interprets returned bytes as UTF-8; invalid
  sequences become U+FFFD per quickjs's decoder (one replacement per invalid
  byte — differs from WHATWG's one-per-maximal-subpart, finding F3b). A C
  implementation should therefore store PARAM KEYS/VALUES AS RAW BYTES and
  percent-encode them back on serialize, exactly as ada does — do not
  round-trip through validated strings.

## Findings (all 33 divergences explained)

- **F1 — embedded-NUL truncation (31/33 cases).** url.c uses
  `strlen()` on every string crossing the boundary, so tjs truncates at the
  first U+0000: constructor inputs (`"http://a\0b/"` parses as `http://a/`
  where node throws; a NUL-leading input that node parses after C0-stripping
  throws in tjs), setter values (username/password/pathname/search/hash
  values silently truncated), and `URL.canParse`/`URL.parse` flip
  accordingly. This is a **url.c artifact, not an ada artifact** — the C
  replacement receives the same truncated bytes and will reproduce the golden
  as-is. Flagged for a possible separate (out-of-scope) url.c fix to
  length-based `JS_ToCStringLen`; that fix would require a golden regen.
- **F2 — double `?`-strip in `new URLSearchParams('??a=1')` (1 case).**
  url.c strips one leading `?`, then `ada_parse_search_params` strips
  another; node keeps the second (key `?a`, serializes `%3Fa=1`; tjs: key
  `a`). The C implementation must reproduce ada's leading-`?` strip to keep
  the golden (or url.c stops stripping — behavior change, regen).
- **F3 — invalid percent-encoded UTF-8 in params (1 case).**
  `'a=%E2%80'`: node (WHATWG) lossy-decodes at parse to U+FFFD and
  serializes `a=%EF%BF%BD`; ada keeps the raw bytes and round-trips
  `a=%E2%80` through toString. (F3b) reading the value: tjs yields TWO
  U+FFFD (quickjs byte decoder) vs node's one.
- **Bycatch (not URL, worked around in harness):** tjs's default
  `TextDecoder` strips U+FEFF **anywhere** in the stream, not just a leading
  BOM (`{ignoreBOM:true}` disables both). Spec says leading-only. Candidate
  for the upstream batch.
- **Corpus drift (not a tjs finding):** wpt master expects 8
  invalid-punycode `xn--` inputs to parse (spec change); ada 3.4.2 and 3.4.4
  both reject. Bounded allowance in the sanity test.

## Sizing memo — the C implementation

Scope, ex-IDNA (**~3–4k lines of plain C, zero new deps**):

1. WHATWG basic-URL state machine (~a dozen states) + host parser:
   special-scheme table w/ default ports, IPv4 (dec/oct/hex, trailing-dot),
   IPv6, opaque-host percent-encoding for non-special schemes, dot-segment
   path normalization, `file:` Windows-drive quirks. ~1.5–2.5k lines.
2. Percent-encode sets (C0/fragment/query/special-query/path/userinfo/
   component): seven 256-bit bitmaps + encoder/decoder. ~150 lines.
3. Component storage + serializer. `ada_get_components` is unused, so no
   offset bookkeeping is needed: store components discretely, recompose
   `href` on demand (simpler than ada's url_aggregator single-buffer design).
4. URLSearchParams: byte-string pair vector, form-urlencoded parse/serialize,
   stable sort with a UTF-8→UTF-16-code-unit-order comparator (~30 lines;
   plain byte comparison mis-sorts supplementary-plane keys). ~400–600 lines.
5. UTF-8 helpers (validate, lossy decode for host input). ~150 lines.

### IDNA — staged ladder (decision: full UTS-46 is the completion bar)

URL parsing feeds `fetch()`; anything less than UTS-46 is user-visible, so
the reduced levels exist only to prove out the swap. **Hard requirement at
every level: an unhandleable host must ERROR loudly (TypeError), never
silently mis-parse or mis-resolve.** The golden's `nonAsciiHost` tags (112
cases) grade each level: below L2, the only permitted deviation from golden
on a tagged case is throws-where-golden-succeeds; any VALUE divergence on a
tagged case fails the phase gate.

| level | scope | corpus pass-rate | est. size |
| --- | --- | --- | --- |
| **L0** — reject any non-ASCII host (post percent-decode) with a loud TypeError | proves the parser swap mechanically | parse: 869/891 (22 valid unicode-host cases rejected loudly; the 19 tagged expected-failures still fail correctly). toascii: 42/87 (24 ASCII handled by base host parser + 18 non-ASCII expected-failures rejected). | ~0 extra lines |
| **L1** — ASCII-lowercase + RFC 3492 punycode of non-ASCII labels, **no** UTS-46 mapping | handles already-lowercase/NFC input — the bulk of real-world IDN (`bücher.de` class) | toascii raw: 52/87 (60%); 16 wrong-VALUE (soft hyphen, ZW ignorables, fullwidth forms, NFC compositions like `≠`, math alphanumerics) and 19 invalid inputs **silently accepted** — a fail-loud violation, so bare L1 is inadmissible. **L1' (recommended form):** punycode + a generated "codepoint needs mapping/validation ⇒ reject loudly" bitmap (~8–16 KB) — same 52/87 genuine passes, zero silent mis-parses, remaining 35 all loud rejects. parse corpus: 9/22 tagged successes handled (+6 opaque-host `sc://ñ`-style cases that never IDNA — they percent-encode in the base parser), 7 rejected loudly. | punycode codec ~250 lines + reject table |
| **L2** — full UTS-46: mapping, deviation chars, NFC, bidi + joining-type validation | **completion criterion for the ada-ectomy** | 100% — golden byte-identical by construction | ~1–1.5k lines + generated tables (below) |

L2 table strategy:

- **Mapping table**: generated from Unicode's `IdnaMappingTable.txt`
  (~9,000 ranges) by a committed generator script (~200 lines) → compact
  range array + binary search, ~40–60 KB static const data. Regenerable per
  Unicode version; provenance pinned like the wpt corpus.
- **NFC**: quickjs-ng's bundled `libunicode` already ships normalization —
  `unicode_normalize()` in `deps/quickjs/libunicode.h` (verified present in
  this tree). Reusing it eliminates the entire NFC table burden from our C;
  ada carries its own copy of these tables today, so this is a net size WIN
  over vendored ada.
- **Bidi/joiner validation**: small derived-property tables, ~10 KB.

Bottom line: the whole job is **one focused C file cluster (~4–5.5k lines at
L2) plus two generated tables**, replacing a 977 KB C++20 TU; the golden
manifest plus per-level tags make each rung independently verifiable, and the
existing 33-divergence analysis proves the harness is sharp enough to catch
single-case drift.
