#!/bin/sh
# Local Haiku r1beta5 box for iterating the tjs pipe-write deadlock
# (haiku-tjs-write-deadlock: a tjs child writing >64KB to a pipe never completes).
#
# Mirrors CI's cross-platform-actions backend: the SAME image
# (cross-platform-actions/haiku-builder v0.1.0 haiku-r1beta5-x86-64.qcow2), the same
# qemu-system-x86_64 + e1000 + virtio + user `user`/empty-password recipe. So a fix
# proven here is a fix proven for the leg. Under TCG on an arm64 mac (no KVM/hvf for
# an x86 guest) it is slower than CI, but the bug is a DEADLOCK, not a race — speed
# does not change reproduction.
#
# Image lives on LOCAL disk (/private/tmp), never the NFS-mounted repo (the qemu NFS
# lock lesson the sparc guests learned). SSH: `ssh -p 2222 user@localhost` (no
# password). This script keeps the image PERSISTENT (no snapshot) so a built/patched
# tjs survives between sessions; delete the qcow2 to reset.
set -eu

VMDIR=/private/tmp/haiku-vm
IMG="$VMDIR/haiku-r1beta5.qcow2"
SSH_PORT=2222

[ -f "$IMG" ] || { echo "haiku-box: no image at $IMG — download it first:" >&2
  echo "  curl -sL -o $IMG https://github.com/cross-platform-actions/haiku-builder/releases/download/v0.1.0/haiku-r1beta5-x86-64.qcow2" >&2
  exit 1; }

echo "haiku-box: booting (TCG); ssh in with: ssh -p $SSH_PORT user@localhost"
# usb-tablet gives ABSOLUTE mouse positioning — the PS/2 default is relative and
# near-impossible to drive precisely via the monitor. VNC on :1 + a monitor socket
# let a headless host both screenshot (screendump) and click/type (mouse_move /
# mouse_button / sendkey) to bring up sshd on the GUI, since this cpa image does NOT
# start sshd on boot.
exec qemu-system-x86_64 \
  -M q35 -accel tcg -smp 2 -m 4096 \
  -drive file="$IMG",if=virtio,format=qcow2 \
  -device e1000,netdev=net0 \
  -netdev user,id=net0,hostfwd=tcp::${SSH_PORT}-:22 \
  -device qemu-xhci -device usb-tablet \
  -vnc :1 \
  -monitor unix:/private/tmp/haiku-vm/mon.sock,server,nowait \
  -qmp unix:/private/tmp/haiku-vm/qmp.sock,server,nowait \
  -serial file:/private/tmp/haiku-vm/serial.log
