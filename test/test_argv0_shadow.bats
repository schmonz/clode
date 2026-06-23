# test/test_argv0_shadow.bats
load test_helper

# Render a rewritten snapshot, then source it with a stub `ugrep` on PATH and
# confirm `grep` (the shadow) execs the stub with the upstream flags.
@test "rewritten grep shadow execs the real ugrep with upstream flags" {
  tmp="$(mktempd)"
  # rewrite the fixture snapshot via the shim
  "$CLODE_NODE" -e '
    const fs=require("fs"), {rewriteSnapshot}=require(process.argv[1]);
    process.stdout.write(rewriteSnapshot(fs.readFileSync(process.argv[2],"utf8")));
  ' "$PWD/libexec/bun-shim.cjs" "$PWD/test/fixtures/snapshot-execpath.sh" > "$tmp/snap.sh"

  # a stub ugrep that records argv
  mkdir -p "$tmp/bin"
  cat > "$tmp/bin/ugrep" <<EOF
#!/bin/sh
echo "ugrep-called: \$*"
EOF
  chmod +x "$tmp/bin/ugrep"

  run env PATH="$tmp/bin:$PATH" sh -c ". '$tmp/snap.sh'; grep needle"
  [ "$status" -eq 0 ]
  [[ "$output" == *"ugrep-called:"* ]]
  [[ "$output" == *"--ignore-files"* ]]
  [[ "$output" == *"needle"* ]]
}

@test "rewritten grep shadow fails loud when ugrep is absent" {
  tmp="$(mktempd)"
  "$CLODE_NODE" -e '
    const fs=require("fs"), {rewriteSnapshot}=require(process.argv[1]);
    process.stdout.write(rewriteSnapshot(fs.readFileSync(process.argv[2],"utf8")));
  ' "$PWD/libexec/bun-shim.cjs" "$PWD/test/fixtures/snapshot-execpath.sh" > "$tmp/snap.sh"

  # Use a minimal PATH that has sh (/bin/sh) but no ugrep, and clear CLODE_UGREP
  run env PATH="$tmp/bin:/bin:/usr/bin" CLODE_UGREP="" sh -c ". '$tmp/snap.sh'; grep needle"
  [ "$status" -eq 127 ]
  [[ "$output" == *"clode: grep needs 'ugrep'"* ]]
}
