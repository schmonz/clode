#!/bin/sh
# build-tjs-boot — the ONE way CI runs scripts/build-tjs.cjs.
#
# WHAT IT IS FOR. `node scripts/build-tjs.cjs <flag>` is being replaced, call site by call
# site, with the same build running under a tjs engine that predates it. Resolving that
# engine is scripts/bootstrap-engine.sh's job. This file is the other half: it takes the
# resolver's answer and turns it into an invocation, ONCE, so three call sites in
# .github/actions/build-leg/action.yml cannot drift into three subtly different spellings
# of which only one is ever exercised.
#
# THE ONE RULE, INHERITED: `build-tjs.cjs` must never call this, for the same reason it
# must never call the resolver — it is the program being bootstrapped. Pinned by
# test/build-tjs-boot.test.cjs.
#
# THE FAILURE MODE THIS IS DESIGNED AGAINST. A CI-only change can fail in a way CI reports
# as GREEN: the node fallback quietly takes over, the build succeeds, and nothing was ever
# exercised under tjs. So every run prints exactly one greppable line before it hands off:
#
#   build-tjs-engine: engine=<tjs|node|none> site=<site> args=<args> target=<target> resolver-rc=<rc> path=<path>
#
#   engine=tjs   the resolver produced an engine and build-tjs.cjs ran UNDER it, through
#                HEAD's node-shim loader. This is the flip actually working.
#   engine=node  the resolver said exit 3 — no slice for this target in the pinned pack —
#                so this leg built its first engine under node and self-hosts from the
#                next release. A green run says NOTHING about tjs.
#   engine=none  nothing ran. The resolver refused (a bad digest, a lying hasher, an
#                engine below HEAD's API floor), or it said fall back and there is no node
#                here. The step is red; the reason is on stderr immediately above.
#
# A REFUSAL IS NOT A FALLBACK. Only exit 3 falls back to node. Exit 1 is a FINDING, and
# converting findings into silent node builds is exactly the gate that cannot fail.
#
# POSIX sh, and deliberately free of external commands (no dirname, no basename): it runs
# in alpine containers and in minimal VM guests, and one of its cases is "this machine has
# no node", which is easiest to express honestly with a PATH that holds almost nothing.
#
# USAGE
#   scripts/build-tjs-boot.sh <site> <build-tjs argument>...
#     <site>  a short label naming the call site, for the log line above
# EXIT
#   the build's own status, or 1 (refused / nothing to run), or 2 (usage)
set -eu

if [ $# -lt 2 ]; then
  printf '%s\n' "usage: build-tjs-boot.sh <site> <build-tjs argument>..." >&2
  exit 2
fi
SITE=$1
shift
# The log line below is a flat list of key=value pairs, so no value may contain a space:
# `args=--source-only --build-only` would read as two fields to anything that splits on
# whitespace, including this file's own test. Comma-joined instead.
ARGS=
for bb_a in "$@"; do ARGS="${ARGS:+$ARGS,}$bb_a"; done

case "$0" in */*) SELFDIR=${0%/*} ;; *) SELFDIR=. ;; esac
REPO=$(CDPATH= cd -- "$SELFDIR/.." && pwd)
RESOLVER=$REPO/scripts/bootstrap-engine.sh
LOADER=$REPO/libexec/node-shim/loader.cjs
BUILD_TJS=$REPO/scripts/build-tjs.cjs

verdict() {  # engine path
  printf 'build-tjs-engine: engine=%s site=%s args=%s target=%s resolver-rc=%s path=%s\n' \
    "$1" "$SITE" "$ARGS" "$TARGET" "$RC" "$2"
}

TARGET=$("$RESOLVER" --print-target 2>/dev/null || printf '%s' '(unknown)')
RC=0
TJS=$("$RESOLVER") || RC=$?

case "$RC" in
  0)
    if [ -z "$TJS" ]; then
      verdict none -
      printf '%s\n' "build-tjs-boot: the resolver exited 0 but named no engine. Refusing
  rather than running build-tjs.cjs under the empty string, which is how a step ends up
  green having built nothing." >&2
      exit 1
    fi
    verdict tjs "$TJS"
    exec "$TJS" run "$LOADER" "$BUILD_TJS" "$@"
    ;;
  3)
    NODE=$(command -v node 2>/dev/null || :)
    if [ -z "$NODE" ]; then
      verdict none -
      printf '%s\n' "build-tjs-boot: the pinned pack has no slice for $TARGET, so this leg
  would build its first engine under node — and there is no node on this machine. That is
  a real gap, not a flake: either cut a release so the pack carries $TARGET, or put a node
  back on this machine, or set CLODE_TJS to an engine you already have." >&2
      exit 1
    fi
    verdict node "$NODE"
    exec "$NODE" "$BUILD_TJS" "$@"
    ;;
  *)
    verdict none -
    printf '%s\n' "build-tjs-boot: scripts/bootstrap-engine.sh REFUSED (exit $RC); its
  reason is immediately above. A refusal is a finding — a bad digest, a hasher that
  cannot reproduce a known answer, an engine below HEAD's API floor — so this does NOT
  quietly fall back to node. Fix the finding, or set CLODE_TJS deliberately." >&2
    exit 1
    ;;
esac
