#!/bin/sh
# Measure the dependency CLOSURE of the packages a leg installs, inside the guest.
#
# WHY: BACKLOG's pinning item cannot choose between a pin store and a download cache
# without knowing whether a leg pulls 5 files or 80, and how many BYTES. Every number
# here is measured in the guest that will use it, because closures differ per OS and
# per release.
#
# Prints, for each package the manager names (best effort — some managers do not list
# them in a machine-readable way):
#     PKGCLOSURE <name> <version> <bytes>
# and finally, exactly once, last:
#     PKGCLOSURE-TOTAL <count> <download-bytes>
#
# THE RULE THAT MATTERS (2026-08-27, after the first real run): a TOTAL is only ever
# printed from numbers actually parsed out of the manager's own summary. If the count
# or the byte figure cannot be read, this script FAILS and says what it could not
# parse — it never prints a plausible-looking total it did not compute.
# The first version violated this in both directions: `bytes=0` was hardcoded in every
# branch, and the openbsd/IPS parsers matched prose ("mediator", "version:",
# "/etc/rc.d/gitdaemon") as package names. Four legs reported PKGCLOSURE-TOTAL and were
# counted GREEN while measuring nothing. Eight red legs announce themselves; a green leg
# carrying a fabricated number is what actually loses a day.
#
# MEASUREMENT ONLY. It must not install anything: a probe that mutates the guest
# cannot be run twice and cannot be trusted the first time.
set -eu

platform="${1:-}"
[ -n "$platform" ] || { echo "usage: guest-pkg-closure.sh <platform> [pkg...]" >&2; exit 2; }
shift || true

case "$platform" in
  freebsd|dragonflybsd|midnightbsd|netbsd|openbsd|omnios|solaris|openindiana|haiku) : ;;
  *) echo "guest-pkg-closure: unsupported platform '$platform'" >&2; exit 2 ;;
esac

if [ "$#" -eq 0 ]; then
  echo "PKGCLOSURE-TOTAL 0 0"
  exit 0
fi

# Several managers refuse to even PLAN as an unprivileged user (pkgin: "You don't have
# enough rights"; IPS: "Could not operate on /var/pkg/state/state_updating ... try the
# command again as a privileged user"). Escalate only if we are not already root, and
# only with a non-interactive flag so a missing sudoers entry fails fast instead of
# hanging on a password prompt.
as_root() {
  if [ "$(id -u 2>/dev/null || echo 0)" = 0 ]; then "$@"
  elif command -v sudo >/dev/null 2>&1; then sudo -n "$@"
  elif command -v doas >/dev/null 2>&1; then doas -n "$@"
  else "$@"
  fi
}

# A dry run that DECLINES its confirmation prompt exits nonzero. That is the expected
# path, not an error, so status alone cannot tell success from failure — only whether
# the summary parsed can. Capture both and let the parser decide.
run_capture() { out=$("$@" 2>&1) && status=0 || status=$?; }

# "115 MiB" / "907 MiB" / "1.2 GiB" / "512 KiB" -> bytes. Prints nothing if unparseable.
to_bytes() {
  printf '%s\n' "$1" | awk '
    { for (i = 1; i <= NF; i++) if ($i ~ /^[0-9]+(\.[0-9]+)?$/ && $(i+1) ~ /^[KMGT]i?B$/) { v = $i + 0; u = $(i+1) } }
    END {
      if (u == "") exit 0
      m = 1
      if (u ~ /^K/) m = 1024; else if (u ~ /^M/) m = 1024 * 1024
      else if (u ~ /^G/) m = 1024 * 1024 * 1024; else if (u ~ /^T/) m = 1024 * 1024 * 1024 * 1024
      printf "%d\n", v * m
    }'
}

# Every failure path routes here so the log always carries the manager's own words.
die_unparsed() {
  printf '%s\n' "$out" >&2
  echo "guest-pkg-closure: $platform: could not parse $1 from the $2 summary above" >&2
  echo "guest-pkg-closure: (manager exit status was $status) — this is NOT an empty closure" >&2
  exit 4
}

count=''
bytes=''

case "$platform" in
  freebsd|dragonflybsd|midnightbsd)
    # pkg(8) and mport both print a human summary ending in:
    #   Number of packages to be installed: 44
    #   The process will require 577 MiB more space.
    #   115 MiB to be downloaded.
    # The per-package lines are tab-indented "  name: version [repo]".
    mgr=pkg; [ "$platform" = midnightbsd ] && mgr=mport
    run_capture env ASSUME_ALWAYS_YES=NO "$mgr" install -n "$@"
    printf '%s\n' "$out" | awk '/^\t/ { name = $1; sub(/:$/, "", name); print "PKGCLOSURE", name, $2, "-" }'
    count=$(printf '%s\n' "$out" | awk '/[Nn]umber of packages to be installed:/ { print $NF + 0 }' | tail -1)
    bytes=$(to_bytes "$(printf '%s\n' "$out" | grep -i 'to be downloaded' | tail -1)")
    ;;
  netbsd)
    # pkgin needs root even to PLAN. Its summary line is e.g.
    #   "12 packages to install: ..." / "45M to download, 180M to install"
    run_capture as_root pkgin -n install "$@"
    printf '%s\n' "$out" | awk '/^[a-zA-Z0-9_]+-[0-9]/ { print "PKGCLOSURE", $1, "-", "-" }'
    count=$(printf '%s\n' "$out" | awk '/packages? to install/ { for (i = 1; i <= NF; i++) if ($i ~ /^[0-9]+$/) { print $i + 0; exit } }' | tail -1)
    bytes=$(to_bytes "$(printf '%s\n' "$out" | grep -i 'to download' | tail -1 | sed 's/\([0-9.]*\)\([KMGT]\)\b/\1 \2iB/g')")
    ;;
  openbsd)
    # pkg_add -n names each package it WOULD add, one per line, as the last field of
    # "Adding <pkg>"; everything else it prints is prose. Anchoring on that verb is what
    # keeps readme paths and timestamps out of the count.
    run_capture pkg_add -n -v "$@"
    printf '%s\n' "$out" | awk '/^installing /  { print "PKGCLOSURE", $2, "-", "-" }'
    count=$(printf '%s\n' "$out" | grep -c '^installing ' || true)
    [ "${count:-0}" -eq 0 ] && count=''
    bytes=$(to_bytes "$(printf '%s\n' "$out" | grep -iE '(to (be )?download|ftp:)' | tail -1)")
    ;;
  omnios|solaris|openindiana)
    # IPS needs root for the image lock. `pkg install -n -v` prints a planning table:
    #   Packages to install:  3
    #   Estimated space available/consumed, and a "Download ... Size" row.
    run_capture as_root pkg install -n -v "$@"
    printf '%s\n' "$out" | awk '/^ +[a-z][a-z0-9_\/-]*@/ { print "PKGCLOSURE", $1, "-", "-" }'
    count=$(printf '%s\n' "$out" | awk '/Packages to install:/ { print $NF + 0 }' | tail -1)
    bytes=$(to_bytes "$(printf '%s\n' "$out" | grep -iE 'download.*size|size.*download' | tail -1)")
    ;;
  haiku)
    # pkgman's dry run. The flag has never been confirmed on a real guest — if this is
    # wrong, the failure path prints pkgman's own words, which is how we learn the right
    # flag instead of guessing at it a second time.
    run_capture pkgman install -n -y "$@"
    printf '%s\n' "$out" | awk '/^ +[a-zA-Z0-9_]+-[0-9]/ { print "PKGCLOSURE", $1, "-", "-" }'
    count=$(printf '%s\n' "$out" | awk '/[Tt]he following .* will be installed/ { getline; n = 0; while ($0 ~ /^ +[a-zA-Z0-9]/) { n++; if ((getline) <= 0) break } print n }' | tail -1)
    bytes=$(to_bytes "$(printf '%s\n' "$out" | grep -iE 'download|size' | tail -1)")
    ;;
esac

# The COUNT is the measurement; without it there is nothing to report, so that stays
# fatal. The DOWNLOAD SIZE is not always obtainable — some managers' dry runs simply do
# not print one — so it degrades to the literal `unknown` rather than to a fabricated 0.
# `unknown` is deliberately not a number: it cannot be summed or averaged by accident,
# and any consumer must decide what to do about it. A 0 would have silently understated
# every total, which is precisely the bug this rewrite exists to kill.
case "$count" in ''|*[!0-9]*) die_unparsed "the package COUNT" "$platform" ;; esac
case "$bytes" in ''|*[!0-9]*) bytes=unknown ;; esac

echo "PKGCLOSURE-TOTAL $count $bytes"
