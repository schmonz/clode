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
  freebsd|dragonflybsd)
    # -n dry run; lines look like "  cmake: 3.28.1 [repo]" plus a size summary.
    env ASSUME_ALWAYS_YES=NO pkg install -n "$@" 2>&1 \
      | awk '/^\t/ { name=$1; sub(/:$/,"",name); print "PKGCLOSURE", name, $2, 0 }'
    ;;
  netbsd)
    # pkgin -n install prints the full transaction, one package per line.
    pkgin -n install "$@" 2>&1 \
      | awk '/to be installed|to install/ { next } /^[a-zA-Z0-9]/ { print "PKGCLOSURE", $1, "-", 0 }'
    ;;
  openbsd)
    pkg_add -n "$@" 2>&1 \
      | awk '/^pkg_add:/ { next } { print "PKGCLOSURE", $NF, "-", 0 }'
    ;;
  omnios|solaris|openindiana)
    pkg install -n -v "$@" 2>&1 \
      | awk '/^ +[a-z]/ { print "PKGCLOSURE", $1, "-", 0 }'
    ;;
  midnightbsd|haiku)
    echo "guest-pkg-closure: $platform dry-run flag not yet confirmed — see Task 2 step 3" >&2
    exit 3
    ;;
  *) echo "guest-pkg-closure: unsupported platform '$platform'" >&2; exit 2 ;;
esac
