# Local Haiku box — iterating the tjs pipe-write deadlock

A local Haiku r1beta5 x86_64 VM that matches CI's cross-platform-actions backend,
for iterating [[haiku-tjs-write-deadlock]] without 22-min CI round trips.

## Bring it up
1. Image (once, LOCAL disk — never the NFS repo):
   `curl -sL -o /private/tmp/haiku-vm/haiku-r1beta5.qcow2 \
      https://github.com/cross-platform-actions/haiku-builder/releases/download/v0.1.0/haiku-r1beta5-x86-64.qcow2`
2. Boot **fully detached** so a harness/session task-cleanup can't kill the VM out
   from under a long build:
   `cd /private/tmp/haiku-vm && nohup bash <repo>/spike/quickjs/qemu/haiku-box.sh > qemu.log 2>&1 </dev/null & disown`
   (macOS has no `setsid`; nohup + disown orphans qemu to launchd, ppid 1). Do NOT
   launch it as a tracked background task — those get reaped. TCG (no accel on arm64
   mac for an x86 guest) — ~3 min to desktop.
   **If the VM dies mid-build, it's cheap:** the qcow2 is PERSISTENT (no snapshot),
   so installed packages, the txiki tree, and every built .o survive. Reboot, redo
   steps 3-4, and `cmake --build` resumes from the objects already on disk.
3. **sshd does NOT auto-start** (the cpa image only sets up ssh for its build-time
   provisioning). Open a Terminal via the GUI, driven over the qemu monitor with
   `haiku-hmon.py` (screenshot/click/type; QMP for ABSOLUTE clicks — HMP mouse_move
   is relative-only):
     Deskbar leaf (top-right ~1230,18) -> Applications -> Terminal (~882,747).
   Opening Terminal is enough; sshd (`/bin/sshd -D`) is already running once the
   desktop is up — it just needed the boot to finish.
4. **Fix DNS** (qemu's forwarding DNS at 10.0.2.3 does not resolve for the guest;
   DHCP clobbers resolv.conf so redo after a lease):
     `echo "nameserver 8.8.8.8" > /system/settings/network/resolv.conf`
5. Reach it: `ssh -p 2222 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null user@localhost`
   (passwordless; user `user`).

## The bug's local repro (tjs-only, no clode)
`tjs.spawn([tjs.exePath,"eval",'console.log("x".repeat(85000))'],{stdout:"pipe"})`
then drain the parent's reader — STALLS at 0 bytes on Haiku, completes on darwin.
The engine dissection (build-leg probes): read path OK, WRITE path (mod_streams.c
async uv_write) never completes. Fix candidate = a 13th txiki patch.

## Toolchain installed: cmake (4.1.6), gcc, git, make. Next: clone tjs @ PINS.md,
apply spike/quickjs/patches/*, build, reproduce, patch mod_streams.c, incremental
rebuild (the whole point — a one-file relink beats a 22-min CI cycle).
