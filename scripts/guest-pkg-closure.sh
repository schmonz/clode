#!/bin/sh
# Measure the dependency CLOSURE of the packages a leg installs, inside the guest.
#
# WHY: BACKLOG's pinning item cannot choose between a pin store and a download cache
# without knowing whether a leg pulls 5 files or 80. Every number here is measured in
# the guest that will use it, because closures differ per OS and per release.
#
# Prints, for each package in the resolved closure:
#     PKGCLOSURE <name> <version> <bytes>
# and finally, exactly once, last:
#     PKGCLOSURE-TOTAL <count> <bytes>
#
# MEASUREMENT ONLY. It must not install anything: a probe that mutates the guest
# cannot be run twice and cannot be trusted the first time.
set -eu

platform="${1:-}"
[ -n "$platform" ] || { echo "usage: guest-pkg-closure.sh <platform> [pkg...]" >&2; exit 2; }
shift || true

# Validate the platform FIRST, before the zero-package shortcut below. An unsupported
# or typo'd platform must fail regardless of how many packages were asked for — a
# zero-package invocation of a bad platform name is not a legitimate empty measurement.
case "$platform" in
  freebsd|dragonflybsd|netbsd|openbsd|omnios|solaris|openindiana) : ;;
  midnightbsd|haiku)
    echo "guest-pkg-closure: $platform dry-run flag not yet confirmed — see Task 2 step 3" >&2
    exit 3
    ;;
  *) echo "guest-pkg-closure: unsupported platform '$platform'" >&2; exit 2 ;;
esac

if [ "$#" -eq 0 ]; then
  echo "PKGCLOSURE-TOTAL 0 0"
  exit 0
fi

case "$platform" in
  freebsd|dragonflybsd)
    # -n dry run; lines look like "  cmake: 3.28.1 [repo]" plus a size summary.
    # Capture output and check the manager's OWN exit status before parsing: a plain
    # pipe would take awk's (always-success) status and a failed query would read as
    # a genuine empty closure, which is the failure this whole script exists to catch.
    if ! out=$(env ASSUME_ALWAYS_YES=NO pkg install -n "$@" 2>&1); then
      printf '%s\n' "$out" >&2
      echo "guest-pkg-closure: pkg query FAILED on $platform — not an empty closure" >&2
      exit 4
    fi
    printf '%s\n' "$out" \
      | awk '
          /^\t/ {
            name=$1; sub(/:$/,"",name); bytes=0
            print "PKGCLOSURE", name, $2, bytes
            n++; b+=bytes
          }
          END { print "PKGCLOSURE-TOTAL", n+0, b+0 }
        '
    ;;
  netbsd)
    # pkgin -n install prints the full transaction, one package per line.
    if ! out=$(pkgin -n install "$@" 2>&1); then
      printf '%s\n' "$out" >&2
      echo "guest-pkg-closure: pkgin query FAILED on $platform — not an empty closure" >&2
      exit 4
    fi
    printf '%s\n' "$out" \
      | awk '
          /to be installed|to install/ { next }
          /^[a-zA-Z0-9]/ {
            bytes=0
            print "PKGCLOSURE", $1, "-", bytes
            n++; b+=bytes
          }
          END { print "PKGCLOSURE-TOTAL", n+0, b+0 }
        '
    ;;
  openbsd)
    if ! out=$(pkg_add -n "$@" 2>&1); then
      printf '%s\n' "$out" >&2
      echo "guest-pkg-closure: pkg_add query FAILED on $platform — not an empty closure" >&2
      exit 4
    fi
    printf '%s\n' "$out" \
      | awk '
          /^pkg_add:/ { next }
          {
            bytes=0
            print "PKGCLOSURE", $NF, "-", bytes
            n++; b+=bytes
          }
          END { print "PKGCLOSURE-TOTAL", n+0, b+0 }
        '
    ;;
  omnios|solaris|openindiana)
    if ! out=$(pkg install -n -v "$@" 2>&1); then
      printf '%s\n' "$out" >&2
      echo "guest-pkg-closure: pkg query FAILED on $platform — not an empty closure" >&2
      exit 4
    fi
    printf '%s\n' "$out" \
      | awk '
          /^ +[a-z]/ {
            bytes=0
            print "PKGCLOSURE", $1, "-", bytes
            n++; b+=bytes
          }
          END { print "PKGCLOSURE-TOTAL", n+0, b+0 }
        '
    ;;
  *)
    # Unreachable: platform was already validated above to be one of the cases here.
    echo "guest-pkg-closure: internal error: unhandled platform '$platform'" >&2
    exit 1
    ;;
esac
