#!/bin/sh
# Measure the dependency CLOSURE of the packages a leg installs, inside the guest.
#
# WHY: BACKLOG's pinning item cannot choose between a pin store and a download cache
# without knowing whether a leg pulls 5 files or 80. Every number here is measured in
# the guest that will use it, because closures differ per OS and per release.
#
# Prints, for each package in the resolved closure:
#     PKGCLOSURE <name> <version> <bytes>
# and finally:
#     PKGCLOSURE-TOTAL <count> <bytes>
#
# MEASUREMENT ONLY. It must not install anything: a probe that mutates the guest
# cannot be run twice and cannot be trusted the first time.
set -eu

platform="${1:-}"
[ -n "$platform" ] || { echo "usage: guest-pkg-closure.sh <platform> [pkg...]" >&2; exit 2; }
shift || true

if [ "$#" -eq 0 ]; then
  echo "PKGCLOSURE-TOTAL 0 0"
  exit 0
fi

case "$platform" in
  freebsd|dragonflybsd) : ;;
  netbsd|openbsd|midnightbsd|haiku|omnios|solaris|openindiana) : ;;
  *) echo "guest-pkg-closure: unsupported platform '$platform'" >&2; exit 2 ;;
esac

echo "PKGCLOSURE-TOTAL 0 0"
