#!/bin/sh
# boot-proof.sh — the make-or-break proof for Task 4, run FIRST.
# By the time this script runs on the guest, the driver has already:
#   - booted qemu-sun4m off the pinned wd0.img (no_install),
#   - brought the guest network up (dhcpcd) and pinged the host (10.0.2.2),
#   - fetched THIS file over the :8180 host file server (ftp).
# So reaching here at all proves the whole qemu path. We just record a
# little host info and emit the driver's success vocabulary.
set -ux
echo "=== HOSTINFO ==="
date
uname -a
sysctl -n hw.model 2>/dev/null || true
echo "mem:"; sysctl -n hw.physmem 2>/dev/null || true
echo "boot-exit=0"
echo "=== GUEST-DONE ==="
