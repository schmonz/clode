#!/bin/sh
# build.sh — the front door: a clean clone to a working `clode`, on a machine with no node.
#
# WHAT IT IS FOR. Everything this repo builds is declared in ONE place
# (scripts/build-graph.cjs) and run from ONE place (scripts/build-runner.cjs). Neither of
# those is a command a developer should have to assemble by hand, because assembling it by
# hand means knowing which interpreter to use — and the whole point of this build is that
# the machine may not have one. So this file is the only invocation: it RESOLVES an engine,
# then hands the runner to it. Type `./build.sh` and you get the artifact the graph's root
# step produces; pass arguments and they go to the runner verbatim (`./build.sh --help`).
#
# WHY IT IS NAMED `build.sh` AND NOT `build`. `build/` is a directory in every working
# checkout — the scratch bundle and the built binaries live there — and on a
# case-insensitive filesystem (macOS's default, where this repo is developed) a file cannot
# share that name. The suffix is not a style choice; it is the only spelling available. The
# name is declared ONCE, in scripts/build-graph.cjs's ENTRY_REL, so the generated
# docs/build.md and the gate in test/build-graph.test.cjs quote the graph rather than each
# keeping a copy of a filename.
#
# IT VALIDATES NOTHING. Not one argument is inspected here. scripts/build-runner.cjs already
# refuses an undeclared step id, an undeclared machine, and a selection that matches no step,
# each with the reason and the list of what IS declared — and a second copy of that
# validation, written in shell, is how the two answers start to disagree. This file's job is
# to get the runner running and then get out of the way, which is what `exec` below means:
# the build's exit status IS this script's, with no shell in between to soften it.
#
# THE VERDICT LINE, and the failure mode it exists against. A build that quietly fell back
# to node looks exactly like the node-free path working. So every run prints exactly one
# greppable line before it hands off, in the shape scripts/build-tjs-boot.sh already uses:
#
#   build: engine=<tjs|node|none> target=<target> resolver-rc=<rc> args=<args> path=<path>
#
#   engine=tjs   an engine was resolved and the graph ran UNDER it, through HEAD's
#                node-shim loader. This is the node-free build actually working.
#   engine=node  the resolver said exit 3 — the pinned pack has no slice for this target —
#                so this machine ran the graph under node this once. A green run says
#                NOTHING about the node-free path.
#   engine=none  nothing ran; the reason is on stderr immediately above.
#
# A REFUSAL IS NOT A FALLBACK. Only exit 3 falls back to node. Any other non-zero from the
# resolver is a FINDING — a bad digest, a hasher that cannot reproduce a known answer, an
# engine below HEAD's API floor — and converting findings into silent node builds is exactly
# the gate that cannot fail.
#
# POSIX sh, and free of external commands on purpose (no dirname, no basename): it runs in
# alpine containers and minimal VM guests, and one of its cases is "this machine has no
# node", which is easiest to express honestly with a PATH that holds almost nothing.
#
# EXIT
#   the build's own status, or 1 (refused / nothing to run)
set -eu

case "$0" in */*) SELFDIR=${0%/*} ;; *) SELFDIR=. ;; esac
REPO=$(CDPATH= cd -- "$SELFDIR" && pwd)
RESOLVER=$REPO/scripts/bootstrap-engine.sh
LOADER=$REPO/libexec/node-shim/loader.cjs
RUNNER=$REPO/scripts/build-runner.cjs

# The verdict line is a flat list of key=value pairs, so no value may contain a space:
# `args=--only bundle.clode-main` would read as two fields to anything that splits on
# whitespace, including this file's own test. Comma-joined instead.
ARGS=
for b_a in "$@"; do ARGS="${ARGS:+$ARGS,}$b_a"; done

verdict() {  # engine path
  printf 'build: engine=%s target=%s resolver-rc=%s args=%s path=%s\n' \
    "$1" "$TARGET" "$RC" "${ARGS:-(root)}" "$2"
}

TARGET=$("$RESOLVER" --print-target 2>/dev/null || printf '%s' '(unknown)')
RC=0
TJS=$("$RESOLVER") || RC=$?

case "$RC" in
  0)
    if [ -z "$TJS" ]; then
      verdict none -
      printf '%s\n' "build.sh: the resolver exited 0 but named no engine. Refusing rather
  than running the build under the empty string, which is how a build ends up green having
  built nothing." >&2
      exit 1
    fi
    verdict tjs "$TJS"
    exec "$TJS" run "$LOADER" "$RUNNER" "$@"
    ;;
  3)
    NODE=$(command -v node 2>/dev/null || :)
    if [ -z "$NODE" ]; then
      verdict none -
      printf '%s\n' "build.sh: the pinned pack has no slice for $TARGET, so this machine
  would run the graph under node — and there is no node here. That is a real gap, not a
  flake: either cut a release so the pack carries $TARGET, or set CLODE_TJS to an engine
  you already have." >&2
      exit 1
    fi
    verdict node "$NODE"
    exec "$NODE" "$RUNNER" "$@"
    ;;
  *)
    verdict none -
    printf '%s\n' "build.sh: scripts/bootstrap-engine.sh REFUSED (exit $RC); its reason is
  immediately above. A refusal is a finding — a bad digest, a hasher that cannot reproduce
  a known answer, an engine below HEAD's API floor — so this does NOT quietly fall back to
  node. Fix the finding, or set CLODE_TJS deliberately." >&2
    exit 1
    ;;
esac
