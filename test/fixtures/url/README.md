# URL characterization corpus (ada-ectomy Phase 1)

Test data and runners that freeze today's URL/URLSearchParams behavior of the
patched tjs binary as the contract for replacing txiki's `deps/ada` (C++20)
with a plain-C implementation. See `test/url-characterization.test.cjs` and
`spike/quickjs/results/ada-ectomy-contract.md`.

## Vendored web-platform-tests data

Fetched 2026-07-09 from
`https://raw.githubusercontent.com/web-platform-tests/wpt/<COMMIT>/url/resources/`

- wpt commit: `181476aa16e8b28a07698bef3a0275fa53dd22e5`
  (latest commit touching `url/resources` at vendor time, dated 2026-07-05)
- License: web-platform-tests is distributed under the 3-Clause BSD License
  (https://github.com/web-platform-tests/wpt/blob/master/LICENSE.md).
  These JSON files are test data from that project, vendored unmodified.

| file | sha256 |
| --- | --- |
| `urltestdata.json` | `355c9f1e5f34aae66ba8adfabf3c853f5cd30ea22964ef7a53eb292e7975d81e` |
| `setters_tests.json` | `53897bd1c296d8a44c0d62cdd3ab11599dacb3a2162ef6d65037aa7ec61c530d` |
| `toascii.json` | `644eba9d5b593df8095cfa307222f3014542ff9cc02d555f8e5660059d80470f` |
| `percent-encoding.json` | `ac3d9ec89f51e3855f9967ef8414eb470653a25d385cb88cbc3dc1c4d878d71c` |

Notes on coverage:

- `percent-encoding.json` carries expectations for several legacy document
  encodings; only the `utf-8` expectation is exercisable through the URL API
  directly, so the runner records search/hash for that alone.
- wpt's URLSearchParams suites (`urlsearchparams-*.any.js`) are executable
  scripts, not data, and are NOT vendored. The gap is covered by a
  hand-written ~54-case corpus in `urlchar-core.mjs` (constructor forms,
  parse edge cases, +/space/%-encoding, sort stability, delete semantics,
  iteration order, URL coupling).
- wpt master is slightly ahead of ada here: 8 `urltestdata.json` cases with
  invalid-punycode `xn--` labels are expected to parse per a recent spec
  change, but ada (3.4.2 in tjs, 3.4.4 in host node) rejects them. The
  characterization records observed behavior, not wpt expectations.

## Runners

- `urlchar-core.mjs` — engine-neutral corpus runner (no I/O, deterministic
  payload). Runs under host node (imported by the test) and under tjs.
- `urlchar-tjs-main.mjs` — tjs entry point:
  `build/tjs/tjs run test/fixtures/url/urlchar-tjs-main.mjs` prints the
  results payload as JSON on stdout. (Uses `TextDecoder(..., {ignoreBOM:true})`
  because tjs's default TextDecoder strips U+FEFF anywhere in the stream,
  which would corrupt the mid-string-BOM corpus case.)

## Golden

`golden-tjs-url.json` — the frozen tjs-today results payload (the contract a
future C URL implementation must reproduce). Verified by sha256 recorded in
`test/url-characterization.test.cjs`. Regeneration is explicit only:

```
CLODE_REGEN_URL_GOLDEN=1 node --test test/url-characterization.test.cjs
```

then update `GOLDEN_SHA256` in the test with the printed value.

Every parse/setters/toascii case carries a `nonAsciiHost` tag (heuristic on
input text, deterministic across engines) so a staged IDNA implementation can
be graded per-level against the same corpus.
