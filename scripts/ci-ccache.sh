#!/bin/sh
# ci-ccache — the ONE way CI gives a leg the same compiler launcher a local build has.
#
# WHY THIS EXISTS. scripts/ccache-launcher.cjs already enables ccache whenever
# findTool('ccache') resolves, and scripts/build-tjs.cjs already prints one greppable
# `build-tjs: ccache: ...` line saying which way that went. None of that was ever WIRED
# in CI: nothing under .github/ installed ccache, and nothing set or persisted a
# CCACHE_DIR. So on a runner that happened to ship one (windows-latest does, via
# Strawberry Perl) it started cold every run and could never hit, and everywhere else the
# launcher was simply inert. Either way CI got none of the benefit a local build gets.
#
# WHAT IT BUYS, and why the recipe-keyed engine cache does not already cover it. The
# tjs-cache in .github/actions/build-leg/action.yml is keyed on the engine RECIPE HASH
# (scripts/engine-recipe.mjs), so it is all-or-nothing: a hit skips the compile entirely,
# and a MISS gives nothing at all. The recipe hash moves whenever ANY engine source moves
# — including an orchestration file that changes not one translation unit — and every such
# move rebuilds all 42 legs completely from scratch (it moved three times on 2026-09-20
# alone). ccache keys on PREPROCESSED SOURCE instead, so on exactly those moves the vast
# majority of the ~371 translation units are byte-identical and still hit. Measured on the
# developer box this file is meant to make CI resemble: cold 0/371 hits, warm 370/371
# (99.7%), 59.4s -> 34.0s wall clock.
#
# WHY A SHELL SCRIPT AND NOT INLINE YAML. Four leg classes need this (native host, the
# NetBSD build.sh cross legs, the alpine containers, the docker cross-toolchain
# containers) and they run under four different package managers. Inline, that is four
# copies of the same decision in a YAML file, which is how this repo has repeatedly paid
# for two hand-maintained lists of one fact. One file, called four times, cannot drift.
#
# WHY NOT libexec/host-provision.cjs. That resolver is for tools the SHIPPED artifacts
# need at runtime (sha256, gzip, unzip, zstd, rg/ugrep, bfs): it probes PATH and runs a
# known-answer test, and it deliberately never installs anything. ccache is a build-host
# convenience for CI only — no product resolves it, and the thing needed here is exactly
# the install host-provision refuses to do. The idiom this follows instead is the one
# already in .github/: `apt-get install` for the cross containers, `apk add` for the
# alpine guests, `brew install` in .github/actions/full-smoke.
#
# POSIX sh, no bashisms: one of its callers is a busybox-ash alpine container.
#
# USAGE
#   scripts/ci-ccache.sh provide <label>   install if absent, configure, zero the counters
#   scripts/ci-ccache.sh report  <label>   print this build's hit/miss counters
#
# `provide` FAILS LOUD when it cannot produce a ccache. That matches the rest of the
# matrix after the phase-0 work (see the guest package installs in
# .github/actions/guest/action.yml: "a failed install fails HERE, naming itself") and it
# is the only way the first run can tell the truth about which runner classes can have
# one. A leg that should not have ccache at all is excluded by its `if:` in
# .github/actions/build-leg/action.yml, not by this script shrugging.
set -eu

cmd="${1:-}"
label="${2:-?}"

# ONE greppable prefix, plain ASCII, on stderr — the same shape and the same reasons as
# build-tjs.cjs's `build-tjs: ccache:` line (a CI log gets grepped for it, and the leg
# whose console mangles UTF-8 punctuation is exactly the leg where it would matter).
say() { printf 'ci-ccache: %s: %s\n' "$label" "$*" >&2; }

die() { say "$@"; exit 1; }

# Root in every container; a sudo-capable non-root on the hosted runners.
as_root() {
  if [ "$(id -u)" = 0 ]; then "$@"; else sudo "$@"; fi
}

have() { command -v "$1" >/dev/null 2>&1; }

install_ccache() {
  # THREE entries, and no speculative fourth. Each one is a package manager VERIFIED to
  # carry ccache on an image a wired leg actually runs:
  #   apk      alpine 3.22, all eight arches the musl legs build (x86_64 aarch64 s390x
  #            x86 armv7 ppc64le riscv64 loongarch64) — each checked individually against
  #            pkgs.alpinelinux.org, with a nonsense package name as the control
  #   apt-get  the ubuntu-24.04 / ubuntu-24.04-arm hosted runners; debian:trixie
  #            (linux-riscv64, linux-s390x); debian:bookworm-slim (ci/osxcross-darwin);
  #            and ubuntu:24.04 — the base of the pinned ghcr gcc-powerpc-apple-darwin8
  #            image, read out of its config blob rather than assumed
  #   brew     the macos-14 hosted runner
  # A `pkgin`/`pkg`/`pkgman` branch was DELIBERATELY not added: no leg that reaches this
  # script runs under one (the VM guests cannot persist a cache and are excluded outright),
  # `pkg` means two unrelated things on FreeBSD and Solaris, and an unverified branch is a
  # guess wearing the clothes of support. The failure below names the gap instead.
  if have apk; then as_root apk add --no-cache ccache
  elif have apt-get; then
    as_root apt-get update -q
    as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends ccache
  elif have brew; then HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 brew install ccache
  else
    die "NO PACKAGE MANAGER this script knows (tried apk, apt-get, brew) -- teach scripts/ci-ccache.sh about this image, or drop the leg from the ccache set in .github/actions/build-leg/action.yml"
  fi
}

# Repo-wide actions/cache usage, printed ALONGSIDE the ccache verdict line so a human
# reading one leg's log can tell "the entry was EVICTED" (capacity/LRU pressure) apart
# from "the wiring is broken" -- see .superpowers/sdd/guest-carve-and-ccache.md for the
# measured cause: ccache's own tarballs are 6-8 MB each, but a handful of multi-GB guest
# images and toolchain caches on `refs/pull/*/merge` fill the repo's shared 10 GB budget,
# evicting a run-scoped ccache entry before the next run can ever read it. That distinction
# cost two wrong predictions before it was diagnosed by hand; this line is what makes it
# readable from a leg's own log instead of re-derived from the coordinator's memory.
#
# READ-ONLY and best-effort, on purpose (see the header docstring on why a diagnostic that
# can break a leg is worse than no diagnostic): it needs GITHUB_REPOSITORY (set by every
# Actions run already), GITHUB_TOKEN (the caller passes it explicitly -- composite actions
# do not inherit secrets/tokens implicitly) and curl, and the token needs the `actions:
# read` permission scope. Any of those missing, or GitHub answering non-200 (403 for a
# scope this workflow has not granted, a rate limit, a network hiccup on an air-gapped
# guest), degrades to a stated "usage unknown" -- never a guess, never a failed leg.
report_usage() {
  verdict="$1"
  repo="${GITHUB_REPOSITORY:-}"
  token="${GITHUB_TOKEN:-}"
  if [ -z "$repo" ] || [ -z "$token" ] || ! have curl; then
    say 'cache usage unknown (no GITHUB_REPOSITORY/GITHUB_TOKEN/curl available to ask)'
    return 0
  fi
  body=$(curl -fsS --max-time 10 \
    -H "Authorization: Bearer $token" \
    -H 'Accept: application/vnd.github+json' \
    "https://api.github.com/repos/$repo/actions/cache/usage" 2>/dev/null) || {
    say 'cache usage unknown (actions/cache/usage request failed -- network, scope, or rate limit)'
    return 0
  }
  bytes=$(printf '%s' "$body" | grep -o '"active_caches_size_in_bytes":[0-9]*' | head -1 | cut -d: -f2)
  count=$(printf '%s' "$body" | grep -o '"active_caches_count":[0-9]*' | head -1 | cut -d: -f2)
  if [ -z "$bytes" ] || [ -z "$count" ]; then
    say 'cache usage unknown (unexpected response from actions/cache/usage)'
    return 0
  fi
  # 10,000,000,000 -- GitHub's own documented per-repository Actions-cache budget
  # (LRU-evicted across every branch and PR). Not a gate: this is reporting, not a limit
  # this script enforces.
  limit=10000000000
  pct=$(awk -v b="$bytes" -v l="$limit" 'BEGIN { printf "%.1f", (100 * b / l) }')
  # 70% is not a guess: the run this diagnosis was built from sat at 7,770,191,495 /
  # 10,000,000,000 (77.7%) with FOUR entries -- none of them ccache -- holding 89% of
  # that, and every ccache entry on main was already evicted. Below the measured
  # incident's own occupancy, calling eviction "likely" would be exactly the guess the
  # brief said not to make; naming it only when the evidence THIS job actually has
  # (this build's own verdict plus this fetch's own occupancy) matches the incident is
  # not a guess.
  near=$(awk -v b="$bytes" -v l="$limit" 'BEGIN { print (b / l >= 0.70) ? 1 : 0 }')
  if [ "$verdict" = "ALL-MISS" ] && [ "$near" = "1" ]; then
    say "cache usage: entries=$count bytes=$bytes of $limit (${pct}%) -- VERDICT=ALL-MISS at ${pct}% of the repo cache budget: EVICTION is the likely cause, not broken wiring"
  else
    say "cache usage: entries=$count bytes=$bytes of $limit (${pct}%)"
  fi
}

case "$cmd" in
  provide)
    # CCACHE_DIR is the ONE thing CI must say that a local build does not: ccache's own
    # default lives under the user's cache home, which on a hosted runner is thrown away
    # with the machine and, in the container legs, is not even on a bind mount the
    # runner's actions/cache can see. The caller sets it; refusing to guess here is what
    # keeps the persisted path and the compiled-against path the same fact.
    [ -n "${CCACHE_DIR:-}" ] || die 'CCACHE_DIR is unset -- the caller must name the directory actions/cache persists, or this build would warm a cache nobody keeps'
    if have ccache; then
      say "already present ($(command -v ccache))"
    else
      say 'absent -- installing'
      install_ccache
      have ccache || die 'install reported success but no ccache is on PATH'
    fi
    mkdir -p "$CCACHE_DIR"
    # max_size is the second deliberate divergence from a local build (which keeps
    # ccache's 5 GiB default). A GitHub repository gets ONE 10 GB cache budget, LRU-
    # evicted, already shared by the tjs engine cache, the macOS SDK, the cosmocc
    # toolchain, the NetBSD cross toolchain and the bootstrap slices — and the engine
    # cache is worth far more per byte than this one, so ccache must not be able to
    # crowd it out. A full 371-object engine build measured ~23 MB of ccache content
    # (115 MB for five builds' worth of misses), so the 200M default below holds roughly
    # eight generations of objects per leg while capping the worst case at 200M x the
    # ~27 legs wired = 5.4 GB, and the realistic case an order below that.
    #
    # A LITERAL, NOT AN ENV KNOB. The first cut read CLODE_CI_CCACHE_MAXSIZE with 200M as
    # the default, and test/env-verdicts.cjs's name inventory went red on it within one
    # suite run: every CLODE_* name shipped code reads owes a recorded verdict. That is the
    # ratchet asking the right question -- nothing sets this, no leg has yet been shown to
    # need a different size, and a knob that exists only in case somebody wants it is a
    # name with no reason behind it. The day a leg needs its own ceiling, the env var comes
    # back WITH the measurement that earns its verdict.
    # Short flags throughout (-M/-z/-s, not --max-size/--zero-stats/--show-stats):
    # they are the spelling ccache 3.x and 4.x BOTH accept, and the images here are
    # not all on the same major.
    ccache -M 200M >/dev/null
    # Zero the counters so `report` below describes THIS build, not a cumulative total
    # that no reader can turn back into "did this run hit". The stored objects survive:
    # -z touches counters only.
    ccache -z >/dev/null
    say "ready dir=$CCACHE_DIR max=200M version=$(ccache --version 2>/dev/null | head -1)"
    ;;
  report)
    # The fact the existing `build-tjs: ccache: ENABLED ...` line CANNOT carry: it reports
    # the DECISION, taken before the compile, and says nothing about whether the cache
    # then hit. Without this, a leg with a cold or non-persisting cache is indistinguish-
    # able in the log from one running at 99% hits -- which is the same invisibility that
    # let ccache drive MSVC on a release leg for an unknown number of runs.
    if ! have ccache; then
      say 'NO STATS (no ccache on PATH at report time)'
      report_usage 'NO-STATS'
      exit 0
    fi
    # ONE LINE A HUMAN CAN SCAN 42 LEGS OF, then the full dump underneath it for whoever
    # wants detail. The one-liner is derived from `ccache --print-stats` (tab-separated
    # counter names, ccache 4.x) rather than scraped out of `-s`, whose human layout
    # changes between majors AND omits zeroed counters entirely -- a leg where NOTHING
    # went through the launcher would otherwise print a stats block with no numbers in
    # it, which reads like "no information" instead of like the finding it is.
    stats=$(ccache --print-stats 2>/dev/null || true)
    if [ -n "$stats" ]; then
      line=$(printf '%s\n' "$stats" | awk -F'\t' '
        $1 == "direct_cache_hit" { d = $2 }
        $1 == "preprocessed_cache_hit" { p = $2 }
        $1 == "cache_miss" { m = $2 }
        END {
          h = d + p; t = h + m;
          # VERDICT is the greppable token. NOTHING-CACHED is not an error here on
          # purpose: no run has yet established which leg classes route their compiler
          # through the launcher at all, and a gate cut before the baseline is a gate
          # cut on a guess. It is the obvious next ratchet once the first run says.
          printf "HITS=%d MISSES=%d TOTAL=%d RATE=%s VERDICT=%s",
            h, m, t, (t ? sprintf("%.1f%%", 100 * h / t) : "n/a"),
            (t == 0 ? "NOTHING-CACHED" : (h == 0 ? "ALL-MISS" : "HIT"));
        }')
      say "$line"
      verdict=$(printf '%s' "$line" | sed -n 's/.*VERDICT=\([A-Za-z-]*\).*/\1/p')
    else
      say 'HITS=? MISSES=? VERDICT=NO-PRINT-STATS (ccache too old for --print-stats)'
      verdict='NO-PRINT-STATS'
    fi
    say "full stats for this build (dir=${CCACHE_DIR:-<unset>})"
    ccache -s 2>&1 || true
    report_usage "$verdict"
    ;;
  *)
    die 'usage: scripts/ci-ccache.sh provide|report <label>'
    ;;
esac
