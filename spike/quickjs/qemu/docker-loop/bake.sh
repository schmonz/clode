#!/bin/sh
# bake.sh — run the engine bake (wall #2) in the docker inner loop, and extract
# the synced-out sparc `tjs` from the serial console into $OUT_DIR/tjs-sparc.
# Uses the BAKED (gmake+cmake) image. Long TCG run (~30-60 min). The S2 source
# tarballs are staged from the repo into a tmpfs workspace so :8180 serves them
# fast. On success the decoded tjs is cksum-verified against the guest's marker.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
SPK=$(cd "$HERE/../.." && pwd)                       # spike/quickjs
IMG_DIR="${CLODE_SPARC_IMG_DIR:-$HOME/clode-ci-images/sparc}"
OUT_DIR="${CLODE_SPARC_OUT:-$HOME/clode-ci-images/sparc/out}"
mkdir -p "$OUT_DIR"

exec docker run --rm \
  --tmpfs /work:rw,size=12g \
  -v "$IMG_DIR:/img:ro" \
  -v "$HERE/..:/repo:ro" \
  -v "$SPK/vendor/dist:/dist:ro" \
  -v "$OUT_DIR:/out:rw" \
  clode-sparc-ci \
  sh -eu -c '
    mkdir -p /work/workdir /work/workspace/.matrix/qemu-bake /work/tmp
    # qemu -snapshot writes guest churn (~1GB build tree) to an overlay in TMPDIR;
    # keep it on the RAM-backed tmpfs, NOT the tiny (3GB) container/VM disk.
    export TMPDIR=/work/tmp
    echo "[bake] decompressing baked toolchain image -> tmpfs..."
    zstd -d -q /img/wd0-baked-10.1-gmake-cmake.img.zst -o /work/workdir/wd0.img
    # Stage where the COMMITTED ci-guest-bake.sh expects (same layout CI uses).
    echo "[bake] staging canonical-LE source tarballs into .matrix/qemu-bake ..."
    cp /dist/txiki-canonical-le.tar.gz /dist/simde-v0.8.2.tar.gz /work/workspace/.matrix/qemu-bake/
    cp /repo/ci-guest-bake.sh /work/workspace/ci-guest-bake.sh
    echo "[bake] launching driver (this is a long TCG build)..."
    /opt/venv/bin/python3 /repo/ci-sparc-driver.py \
      --workdir /work/workdir --workspace /work/workspace \
      --recipe ci-guest-bake.sh \
      --memory 512M --machine SS-20 \
      --overall-timeout 9000 --setup-timeout 900 --recipe-timeout 5400 &
    dpid=$!
    for i in $(seq 1 30); do [ -f /work/workdir/ci-sparc-console.log ] && break; sleep 1; done
    tail -n +1 -f /work/workdir/ci-sparc-console.log &
    tpid=$!
    wait $dpid; rc=$?
    sleep 1; kill $tpid 2>/dev/null || true
    echo "[bake] driver exit=$rc"

    LOG=/work/workdir/ci-sparc-console.log
    if grep -q "TJS-GZB64-BEGIN" "$LOG" && grep -q "TJS-GZB64-END" "$LOG"; then
      echo "[bake] extracting synced-out tjs from the console log..."
      awk "/=== TJS-GZB64-BEGIN ===/{f=1;next} /=== TJS-GZB64-END ===/{f=0} f" "$LOG" \
        | tr -d "\r" | grep -E "^[A-Za-z0-9+/=]+$" \
        | openssl base64 -d | gunzip -c > /out/tjs-sparc || { echo "[bake] DECODE FAILED"; exit 1; }
      echo "[bake] wrote /out/tjs-sparc ($(wc -c < /out/tjs-sparc) bytes)"
      want=$(grep -oE "bake-tjs-cksum=[0-9]+ bake-tjs-len=[0-9]+" "$LOG" | tail -1)
      got=$(cksum /out/tjs-sparc | awk "{print \"bake-tjs-cksum=\"\$1\" bake-tjs-len=\"\$2}")
      echo "[bake] want: $want"
      echo "[bake] got : $got"
      if [ "$want" = "$got" ]; then echo "[bake] SYNC-OUT VERIFIED (cksum+len match)"; else echo "[bake] SYNC-OUT CKSUM MISMATCH"; rc=1; fi
      file /out/tjs-sparc 2>/dev/null || true
    else
      echo "[bake] NO tjs block in log — bake did not reach sync-out (see markers above)"
    fi
    exit $rc
  '
