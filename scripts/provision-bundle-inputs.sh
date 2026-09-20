#!/bin/sh
# provision-bundle-inputs — put the JS bundle step's two inputs on disk WITHOUT npm.
#
# THE PROBLEM. scripts/bundle-inputs-gate.cjs refuses a checkout that cannot build the
# txiki JS bundles, and names two halves: the pinned esbuild, and txiki's OWN JS
# dependency tree (web-streams-polyfill, uuid, getopts, @jsr/std__tar and the rest),
# which esbuild bundles INTO the engine. Both used to arrive only as a side effect of
# `npm install` inside the checkout, and npm is a Node program. That refusal is the
# honest state of a node-free `--source-only`; this file is what makes it unnecessary.
#
# WHERE THE PINS COME FROM — DERIVED, AND THIS IS THE WHOLE DESIGN.
# Not a table in this repo. The pinned txiki checkout carries its own
# `package-lock.json`, and ensureCheckout (scripts/build-tjs.cjs) has already verified
# that checkout's HEAD against spike/quickjs/PINS.md before anything calls us. So for
# every package the gate names we read, out of that lockfile:
#
#   version    what the pinned txiki commit resolved to
#   resolved   the exact tarball URL (registry.npmjs.org, or npm.jsr.io for @jsr/*)
#   integrity  sha512-<base64>, npm's own published digest
#
# A hand-written digest table here would be the fifteenth list in this tree that can go
# stale, and it would have to move every time the txiki pin moves. The lockfile cannot
# go stale: it IS the pin. `--plan` prints exactly what it read, so an operator can see
# the derivation without a network.
#
# THE BUNDLER, without npm and without a Node wrapper. esbuild publishes one prebuilt
# native binary per platform as an ORDINARY npm tarball — @esbuild/<os>-<arch> — with no
# install script and no JS in it at all (verified 2026-09-20: @esbuild/darwin-arm64
# 0.28.1 is three files, `package/bin/esbuild` is a 10.5MB Mach-O, and it answers
# `--version` with 0.28.1). The `esbuild` package's own postinstall does nothing more
# than copy that binary into place, which is why a warm npm checkout's
# node_modules/.bin/esbuild is already a native executable and not a `#!/usr/bin/env node`
# script. We reproduce that end state directly: extract the platform package and link
# node_modules/.bin/esbuild at its binary. ensureEsbuild and the gate both look exactly
# there, so NEITHER of them changes for this.
#
# VERIFICATION. The lockfile's integrity is sha512-<base64>; a host hasher prints hex. So
# two things are picked and KNOWN-ANSWER TESTED before either is trusted: a sha512 tool
# (the scripts/bootstrap-engine.sh chain, one algorithm up) and the base64->hex decoder
# below. Hashing is where this project has silently gone wrong before — a pure-JS verifier
# that hung, a "sha256" that was not one — so nothing here trusts a tool it has not just
# watched reproduce a digest we already know. A digest mismatch DELETES the file and
# refuses; it never falls back to "well, it downloaded".
#
# NOT A GATE, AND IT MUST NOT BECOME ONE. It provisions or it explains why it could not.
# bundle-inputs-gate.cjs is still the thing that refuses, and it re-derives the answer from
# the tree afterwards — so a half-done provision is caught by the gate naming what is
# still missing, not by trusting this script's exit code.
#
# POSIX sh, deliberately: same audience as scripts/bootstrap-engine.sh (alpine containers,
# minimal VM guests). No bashisms, no arrays, no `local`, no `tar --strip-components`.
#
# USAGE
#   provision-bundle-inputs.sh <checkout-dir> <name>...
#   provision-bundle-inputs.sh --plan <checkout-dir> <name>...
#     <name>  a package name the gate asked for, or the literal `esbuild`, which means
#             "this host's @esbuild/<os>-<arch> platform binary", not the JS wrapper.
# EXIT
#   0  everything named is on disk      1  refused / could not, loudly and specifically
#   2  usage                            3  nothing to do (offline, or an unmapped platform)
set -eu

PLAN=
if [ "${1:-}" = '--plan' ]; then PLAN=1; shift; fi
if [ $# -lt 2 ]; then
  printf '%s\n' "usage: provision-bundle-inputs.sh [--plan] <checkout-dir> <name>..." >&2
  exit 2
fi
DIR=$1
shift
LOCK=$DIR/package-lock.json

note() { printf '%s\n' "$*" >&2; }
die() { printf '%s\n' "$*" >&2; exit 1; }

[ -f "$LOCK" ] || die "provision-bundle-inputs: no $LOCK.
  Every version, URL and digest this script uses is READ from that lockfile — it is the
  pin, and there is no table here to fall back on. Either this is not a txiki checkout,
  or it is a partial one; let the source phase re-clone it."

TMP=$(mktemp -d "${TMPDIR:-/tmp}/clode-bundle-inputs.XXXXXX")
trap 'rm -rf "$TMP"' EXIT INT TERM HUP

# --- the cache root ----------------------------------------------------------
# Same precedence as scripts/bootstrap-engine.sh's cache_root (which mirrors
# libexec/clode-paths.cjs). Tarballs are cached, not extracted trees: re-extracting is
# milliseconds and a cached TARBALL can be re-verified against the lockfile digest, which
# is the property that makes a cache hit as trustworthy as a fresh fetch.
cache_root() {
  if [ -n "${CLODE_CACHE:-}" ]; then printf '%s\n' "$CLODE_CACHE"; return 0; fi
  if [ -n "${CLODE_STATE_ROOT:-}" ]; then printf '%s/cache/clode\n' "$CLODE_STATE_ROOT"; return 0; fi
  if [ -n "${XDG_CACHE_HOME:-}" ]; then printf '%s/clode\n' "$XDG_CACHE_HOME"; return 0; fi
  printf '%s/.cache/clode\n' "${HOME:-}"
}
CACHE=$(cache_root)/bundle-inputs

# --- the lockfile, read with awk --------------------------------------------
# A targeted reader, not a JSON parser, for the same reason bootstrap-engine.sh's is: this
# runs where jq does not exist. Depth-tracked so a nested object inside an entry (every
# entry with `"dependencies": {`) cannot end it early, and fields are only accepted at
# depth 1 so a `"version"` nested inside `"bin"` can never be mistaken for the package's.
lock_field() {  # name field
  awk -v k="node_modules/$1" -v f="$2" '
    { line=$0; gsub(/^[ \t]+|[ \t]+$/, "", line)
      if (!inside) {
        if (line == "\"" k "\": {" || line == "\"" k "\":{") { inside=1; depth=1 }
        next
      }
      if (depth == 1 && index(line, "\"" f "\":") == 1) {
        v=line; sub(/^"[^"]*"[ \t]*:[ \t]*/, "", v); sub(/,$/, "", v)
        gsub(/^"|"$/, "", v); print v; exit
      }
      o = gsub(/\{/, "{", line); c = gsub(/\}/, "}", line)
      depth += o - c
      if (depth <= 0) exit
    }' "$LOCK"
}

# --- sha512: base64 (what npm records) vs hex (what hashers print) ----------
# A base64 decoder in awk, because the expected digest arrives base64 and every portable
# sha512 tool prints hex. `base64 -d` is not portable (-D on older macOS, absent in some
# minimal guests) and `openssl base64 -d` would make openssl mandatory; 20 lines of awk
# make neither true. KAT'd below against a digest we already know, so a decoder that
# silently truncated could not be used to "verify" anything.
b64_to_hex() {
  awk -v s="$1" '
    BEGIN {
      a="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
      for (i = 1; i <= 64; i++) v[substr(a, i, 1)] = i - 1
      hx="0123456789abcdef"
      gsub(/[=[:space:]]/, "", s)
      acc=0; bits=0; out=""
      n=length(s)
      for (i = 1; i <= n; i++) {
        c=substr(s, i, 1)
        if (!(c in v)) exit 1
        acc = acc * 64 + v[c]; bits += 6
        if (bits >= 8) {
          bits -= 8; p = 2 ^ bits
          byte = int(acc / p); acc = acc - byte * p
          out = out substr(hx, int(byte / 16) + 1, 1) substr(hx, (byte % 16) + 1, 1)
        }
      }
      print out
    }'
}

KAT_INPUT='clode-bundle-inputs'
KAT_HEX='e9d0822b9ac9028f9617eea1091d79268a457b6aa54a319154d0aa8190e0374d313ebe32fae23d888378182eae403418c52af63500a8a7b193e7bc3adff40abf'
KAT_B64='6dCCK5rJAo+WF+6hCR15JopFe2qlSjGRVNCqgZDgN00xPr4y+uI9iIN4GC6uQDQYxSr2NQCop7GT57w63/QKvw=='

HASHER=
HASHER_PICKED=
KAT_TRIED=

hash_file() {
  eval "$HASHER \"\$1\"" 2>/dev/null | tr -c '0-9a-f' '\n' | grep -E '^[0-9a-f]{128}$' | head -n 1
}

try_hasher() {
  th_word=${1%% *}
  command -v "$th_word" >/dev/null 2>&1 || return 1
  HASHER=$1
  th_got=$(hash_file "$TMP/kat")
  if [ "$th_got" = "$KAT_HEX" ]; then return 0; fi
  HASHER=
  KAT_TRIED="$KAT_TRIED
  $1 -> ${th_got:-(no 128-hex digest in its output)}"
  return 1
}

# ONE pick per run, and the DECODER is tested in the same breath as the hasher: both
# answers must agree on a string whose digest is written above. Either one broken alone
# would turn every verification into a false negative; broken together in a way that
# cancels out is what this pairing makes impossible.
pick_hasher() {
  if [ -n "$HASHER_PICKED" ]; then
    if [ -n "$HASHER" ]; then return 0; fi
    return 1
  fi
  HASHER_PICKED=1
  printf '%s' "$KAT_INPUT" > "$TMP/kat"
  ph_dec=$(b64_to_hex "$KAT_B64" || :)
  if [ "$ph_dec" != "$KAT_HEX" ]; then
    HASHER=
    KAT_TRIED="$KAT_TRIED
  the base64 decoder -> ${ph_dec:-(nothing)} (expected $KAT_HEX)"
    return 1
  fi
  if [ -n "${CLODE_SHA512:-}" ]; then
    if try_hasher "$CLODE_SHA512"; then return 0; fi
    return 1
  fi
  if try_hasher 'sha512sum' || try_hasher 'shasum -a 512' || try_hasher 'sha512 -q' \
    || try_hasher 'openssl dgst -sha512' || try_hasher 'cksum -a sha512' \
    || try_hasher 'digest -a sha512'; then return 0; fi
  return 1
}

require_hasher() {
  if pick_hasher; then return 0; fi
  die "provision-bundle-inputs: nothing on this host can verify a sha512, so a downloaded
  build input will not be trusted.$KAT_TRIED
  sha512 of '$KAT_INPUT' must be $KAT_HEX.
  Install one (sha512sum / shasum / openssl / cksum -a sha512 / digest -a sha512), point
  CLODE_SHA512 at one, or run this phase on a host with Node so npm can install these."
}

verify() {  # file integrity-field
  vf_want=$(b64_to_hex "${2#sha512-}" || :)
  vf_got=$(hash_file "$1" || :)
  [ -n "$vf_want" ] && [ "$vf_got" = "$vf_want" ]
}

# --- the network -------------------------------------------------------------
fetch() {  # url out
  if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 3 -o "$2" "$1"; return $?; fi
  if command -v wget >/dev/null 2>&1; then wget -q -O "$2" "$1"; return $?; fi
  die "provision-bundle-inputs: neither curl nor wget is on this host, so the pinned
  build inputs cannot be fetched. Install one, or run this phase on a host with Node."
}

# --- this host's esbuild platform package ------------------------------------
# esbuild's own naming, not clode's canonical vocabulary: these strings are package names
# on the registry (@esbuild/darwin-arm64), so canonical-name.cjs's amd64/macos spelling
# would be exactly wrong here. A platform this cannot spell is NAMED and refused — never
# guessed, because a guess resolves to a 404 or, worse, to another platform's binary.
esbuild_platform() {
  ep_os=$(uname -s 2>/dev/null | tr 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' 'abcdefghijklmnopqrstuvwxyz')
  case "$ep_os" in
    darwin) ep_os=darwin ;;
    linux) ep_os=linux ;;
    freebsd) ep_os=freebsd ;;
    netbsd) ep_os=netbsd ;;
    openbsd) ep_os=openbsd ;;
    sunos) ep_os=sunos ;;
    *) return 1 ;;
  esac
  ep_arch=$(uname -m 2>/dev/null)
  case "$ep_arch" in
    x86_64|amd64) ep_arch=x64 ;;
    aarch64|arm64) ep_arch=arm64 ;;
    i386|i486|i586|i686) ep_arch=ia32 ;;
    armv7*|earmv7*|armv6*) ep_arch=arm ;;
    ppc64le|powerpc64le) ep_arch=ppc64 ;;
    riscv64) ep_arch=riscv64 ;;
    s390x) ep_arch=s390x ;;
    loongarch64) ep_arch=loong64 ;;
    *) return 1 ;;
  esac
  printf '%s-%s\n' "$ep_os" "$ep_arch"
}

# --- one package -------------------------------------------------------------
# dest is where the package's own package.json must end up, i.e. what both esbuild's
# resolver and bundle-inputs-gate.cjs look for.
provision_one() {  # lockname dest
  po_name=$1
  po_dest=$2
  po_ver=$(lock_field "$po_name" version)
  po_url=$(lock_field "$po_name" resolved)
  po_int=$(lock_field "$po_name" integrity)
  if [ -z "$po_ver" ] || [ -z "$po_url" ] || [ -z "$po_int" ]; then
    die "provision-bundle-inputs: $LOCK has no complete entry for $po_name
  (version='$po_ver' resolved='$po_url' integrity='$po_int').
  The gate derived this name from an import under src/js/**, so the pinned txiki
  checkout is expected to declare it. A name the lockfile does not carry cannot be
  pinned, and an unpinned fetch is not something this script will do."
  fi
  case "$po_int" in
    sha512-*) : ;;
    *) die "provision-bundle-inputs: $po_name's integrity in $LOCK is '$po_int', which is
  not the sha512-<base64> this verifies. Refusing rather than skipping the check." ;;
  esac
  po_tgz=$CACHE/$(printf '%s' "$po_name" | tr '/@' '__')-$po_ver.tgz

  if [ -n "$PLAN" ]; then
    printf 'plan %s %s %s %s\n' "$po_name" "$po_ver" "$po_url" "$po_int"
    return 0
  fi

  require_hasher
  if [ -f "$po_tgz" ] && ! verify "$po_tgz" "$po_int"; then
    note "provision-bundle-inputs: cached $po_tgz does not match the sha512 $LOCK records — discarding and re-fetching."
    rm -f "$po_tgz"
  fi
  if [ ! -f "$po_tgz" ]; then
    if [ "${CLODE_OFFLINE:-}" = '1' ]; then
      die "provision-bundle-inputs: CLODE_OFFLINE=1 and $po_name@$po_ver is not in the
  cache at $po_tgz, so there is nothing to provision it from. Run online once to fill the
  cache, or unset CLODE_OFFLINE."
    fi
    mkdir -p "$CACHE"
    note "provision-bundle-inputs: fetching $po_name@$po_ver"
    fetch "$po_url" "$TMP/dl.tgz" || die "provision-bundle-inputs: could not fetch $po_url"
    if ! verify "$TMP/dl.tgz" "$po_int"; then
      die "provision-bundle-inputs: $po_url does not match the sha512 $LOCK records for
  $po_name@$po_ver.
    expected $(b64_to_hex "${po_int#sha512-}")
    got      $(hash_file "$TMP/dl.tgz")
  Refusing to use it. These bytes get bundled INTO the engine, so a digest that does not
  match the pin is a supply-chain finding, not a flake."
    fi
    mv "$TMP/dl.tgz" "$po_tgz"
  fi

  # Extract via an explicit gzip pipe and a `package/` move rather than
  # `tar --strip-components`, which busybox/old-BSD tar spell differently or not at all.
  # The move also PROVES the single-root assumption instead of assuming it.
  rm -rf "$TMP/x"
  mkdir -p "$TMP/x"
  gzip -dc < "$po_tgz" | (cd "$TMP/x" && tar -xf -) \
    || die "provision-bundle-inputs: could not unpack $po_tgz"
  [ -d "$TMP/x/package" ] || die "provision-bundle-inputs: $po_tgz does not have the single
  top-level 'package/' directory every npm tarball has — refusing to guess its layout."
  rm -rf "$po_dest"
  mkdir -p "$(dirname "$po_dest")" 2>/dev/null || :
  mv "$TMP/x/package" "$po_dest"
  printf 'provisioned %s@%s -> %s\n' "$po_name" "$po_ver" "$po_dest"
}

RC=0
for want in "$@"; do
  case "$want" in
    esbuild)
      tok=$(esbuild_platform || :)
      if [ -z "$tok" ]; then
        note "provision-bundle-inputs: no esbuild platform package for $(uname -s 2>/dev/null)/$(uname -m 2>/dev/null)."
        note "provision-bundle-inputs: esbuild publishes one prebuilt binary per platform and this host is not one of them; set CLODE_ESBUILD, or build the bundles on a host that is."
        RC=3
        continue
      fi
      dest=$DIR/node_modules/@esbuild/$tok
      if [ -n "$PLAN" ]; then
        provision_one "@esbuild/$tok" "$dest"
        continue
      fi
      [ -x "$dest/bin/esbuild" ] || provision_one "@esbuild/$tok" "$dest"
      chmod +x "$dest/bin/esbuild" 2>/dev/null || :
      # The end state a warm `npm install` leaves behind: .bin/esbuild IS the native
      # binary (esbuild's postinstall overwrites its JS wrapper with it), never a
      # `#!/usr/bin/env node` script — which is the whole reason a node-free host can use
      # it. ensureEsbuild and bundle-inputs-gate.cjs both look exactly here, so neither
      # needs to know this script exists.
      mkdir -p "$DIR/node_modules/.bin"
      rm -f "$DIR/node_modules/.bin/esbuild"
      ln -s "../@esbuild/$tok/bin/esbuild" "$DIR/node_modules/.bin/esbuild" 2>/dev/null \
        || cp "$dest/bin/esbuild" "$DIR/node_modules/.bin/esbuild"
      printf 'provisioned the bundler -> %s/node_modules/.bin/esbuild\n' "$DIR"
      ;;
    *)
      dest=$DIR/node_modules/$want
      if [ -n "$PLAN" ]; then provision_one "$want" "$dest"; continue; fi
      [ -f "$dest/package.json" ] || provision_one "$want" "$dest"
      ;;
  esac
done
exit $RC
