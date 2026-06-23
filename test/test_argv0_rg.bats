load test_helper

# bin/clode should force system ripgrep (USE_BUILTIN_RIPGREP=0) and ensure the
# chosen rg is on PATH, when a real rg is discoverable.
@test "set_ripgrep_env forces system rg and puts it on PATH when rg exists" {
  tmp="$(mktempd)"
  mkdir -p "$tmp/bin"
  printf '#!/bin/sh\necho rg\n' > "$tmp/bin/rg"; chmod +x "$tmp/bin/rg"

  run env PATH="$tmp/bin:$PATH" CLODE_SOURCED=1 sh -c '
    unset USE_BUILTIN_RIPGREP
    . "'"$PWD"'/bin/clode"
    set_ripgrep_env
    echo "USE_BUILTIN_RIPGREP=$USE_BUILTIN_RIPGREP"
    command -v rg
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"USE_BUILTIN_RIPGREP=0"* ]]
  [[ "$output" == *"/bin/rg"* ]]
}

@test "set_ripgrep_env honors CLODE_RG and prepends its dir to PATH" {
  tmp="$(mktempd)"
  mkdir -p "$tmp/rgdir"
  printf '#!/bin/sh\necho rg\n' > "$tmp/rgdir/rg"; chmod +x "$tmp/rgdir/rg"

  run env PATH="/usr/bin:/bin" CLODE_RG="$tmp/rgdir/rg" CLODE_SOURCED=1 sh -c '
    unset USE_BUILTIN_RIPGREP
    . "'"$PWD"'/bin/clode"
    set_ripgrep_env
    echo "USE_BUILTIN_RIPGREP=$USE_BUILTIN_RIPGREP"
    echo "PATH=$PATH"
  '
  [ "$status" -eq 0 ]
  [[ "$output" == *"USE_BUILTIN_RIPGREP=0"* ]]
  [[ "$output" == *"$tmp/rgdir"* ]]
}

# Robust "no rg" environment: an empty temp dir plus /bin and /usr/bin (which on
# this platform hold sh but not rg — system rg lives in /usr/local/bin). Invoke
# /bin/sh by absolute path so env need not resolve `sh` from the stripped PATH.
@test "set_ripgrep_env leaves config unset when no rg on PATH" {
  tmp="$(mktempd)"; mkdir -p "$tmp/empty"
  run env PATH="$tmp/empty:/bin:/usr/bin" CLODE_RG="" CLODE_SOURCED=1 /bin/sh -c '
    unset USE_BUILTIN_RIPGREP
    . "'"$PWD"'/bin/clode"
    set_ripgrep_env
    echo "USE_BUILTIN_RIPGREP=${USE_BUILTIN_RIPGREP:-unset}"
  '
  [[ "$output" == *"USE_BUILTIN_RIPGREP=unset"* ]]
}
