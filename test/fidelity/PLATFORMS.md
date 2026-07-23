# Reachable-Platform Runbook

This document specifies how to run the **platform-sensitive subset** of the fidelity recipe on each exotic rig beyond the primary darwin box. Platform-sensitive rows are those tagged `platform` in the `axes` column of `RECIPE.md` — they capture failures that broke per-platform before (file I/O sizes, pipe deadlocks, signals, TTY, spawn, applet discovery, config writes).

Platform-sensitive row ids: **A1, A2, B1, C1, C2, C3, C4, D1, D2, D3, D4, D5, D6, E1, E2, E3, F4, G3**

## Rig: Primary darwin (local)

**Engines available:** Claude (upstream), naude (Node SEA), quaude (tjs)
**Test scope:** Full recipe (all rows A–I)
**Result recording:** Record pass/fail for each engine in `test/fidelity/RECIPE.md` or `test/fidelity/RECIPE-RESULTS.md` (TBD by operator)

This is the canonical reference run. The operator executes the full recipe here in one sitting, producing a pass/fail matrix per engine. Any divergence between naude/quaude and Claude is localized here, and platform-sensitive failures are cross-checked on exotics below.

---

## Rig: iTerm2 autonomous rig (darwin interactive TUI)

**Where:** Local darwin machine, in iTerm2 terminal, autonomous TUI mode
**Engines available:** Claude (upstream), naude (Node SEA), quaude (tjs) — same as primary, but interactive
**Test scope:** Platform-sensitive rows only: **A1, A2, B1, C1, C2, C3, C4, D1, D2, D3, D4, D5, D6, E1, E2, E3, F4, G3**
**Special note:** This rig is the ONLY place to run **F4** (trust-prompt freeze under iTerm2), which requires interactive keystroke delivery to the TUI. The row is platform-tagged because the freeze is iTerm2-specific.
**Result recording:** Append platform tag `darwin-tui` to each row result in the result matrix

### How to run:
1. Launch iTerm2 (or the configured autonomous-TUI rig).
2. For each platform-sensitive row id, execute the action and record Claude / naude / quaude divergence (if any).
3. F4 (trust-prompt) must be run interactively: keystrokes must reach the prompt, and the prompt must advance (not freeze).
4. Record results with `platform: darwin-tui` tag.

---

## Rig: NetBSD/arm64 SSH VM

**Where:** `ssh <credentials> <host>`
**Engines available:** naude (Node, if compiled into VM), quaude (tjs — confirmed via the netbsd-arm64 leg)
**Reference engine:** naude (if available; else quaude runs alone)
**Test scope:** Platform-sensitive rows only: **A1, A2, B1, C1, C2, C3, C4, D1, D2, D3, D4, D5, D6, E1, E2, E3, F4, G3**
**Result recording:** Append platform tag `netbsd-arm64` to each row result

### How to run:
1. SSH to the NetBSD/arm64 VM.
2. Install or copy the naude + quaude binaries to the VM (see deployment strategy; exact steps depend on the operator's setup).
3. For each platform-sensitive row, execute the action using naude as the reference (if available) and quaude as the subject.
4. Key differences from darwin: ARM64 architecture, NetBSD kernel (different signal handling, spawn semantics, file I/O buffering).
5. Record results with `platform: netbsd-arm64` tag. Note which engine(s) were present.

---

## Rig: Tiger PPC VM

**Where:** `ssh -p 1215 schmonz@localhost` (or operator's configured credentials)
**Engines available:** quaude (tjs — proven on real PowerPC via cross-fuse), naude (Node — if available on the guest)
**Reference engine:** naude (if available; else quaude self-compares or is compared against Claude results from primary)
**Test scope:** Platform-sensitive rows only: **A1, A2, B1, C1, C2, C3, C4, D1, D2, D3, D4, D5, D6, E1, E2, E3, F4, G3**
**Result recording:** Append platform tag `darwin-ppc` to each row result

### How to run:
1. SSH to the Tiger PPC VM (10.4.11 G4, qemu guest).
2. Copy the quaude binary (cross-fused for ppc on an arm64 host) to the VM.
3. Optionally, if naude is compiled and available on the VM, use it as the reference engine.
4. For each platform-sensitive row, execute the action and record pass/fail.
5. Key differences from darwin: 32-bit big-endian PowerPC, pre-10.5 (no posix_spawn), fork/exec semantics differ.
6. Record results with `platform: darwin-ppc` tag.

---

## Rig: Haiku box

**Where:** Direct access to Haiku hardware or VM
**Engines available:** quaude (tjs — confirmed via haiku-x64 leg), naude (Node — check if present on Haiku)
**Reference engine:** naude (if Node is installed; else quaude self-compares)
**Test scope:** Platform-sensitive rows only: **A1, A2, B1, C1, C2, C3, C4, D1, D2, D3, D4, D5, D6, E1, E2, E3, F4, G3**
**Result recording:** Append platform tag `haiku-x64` to each row result
**Known issue:** C2 (large write >64 KB to a pipe) was historically deadlocked on Haiku; verify fix holds.

### How to run:
1. Log in to the Haiku box (direct console or SSH, depending on setup).
2. Copy naude and quaude binaries to the box.
3. For each platform-sensitive row, execute the action. Pay special attention to C2 (large I/O) — this platform previously had a uv_write deadlock for pipes >64 KB.
4. Record results with `platform: haiku-x64` tag.

---

## Rig: sparc VM

**Where:** qemu guest (NetBSD/sparc), managed by the fidelity harness or deployed separately
**Engines available:** quaude (tjs — confirmed via netbsd-sparc leg and canonical-LE bytecode proof)
**Reference engine:** None (upstream Claude and naude are not available on sparc; quaude self-compares via deterministic oracle)
**Test scope:** Platform-sensitive rows only: **A1, A2, B1, C1, C2, C3, C4, D1, D2, D3, D4, D5, D6, E1, E2, E3, F4, G3**
**Result recording:** Append platform tag `netbsd-sparc` to each row result
**Key characteristic:** 32-bit big-endian SPARC; canonical-LE bytecode proof (the shipped LE bytecode deserializes correctly on 32-bit BE).

### How to run:
1. Boot or access the sparc VM (qemu sun4m guest with NetBSD 10.1).
2. Copy the quaude binary (cross-fused on x64, then booted on sparc) to the guest.
3. For each platform-sensitive row, execute the action against quaude.
   - Because there is no reference engine, results are recorded as "quaude: pass/fail" with notes on any crashes or anomalies.
   - Behavioral correctness is adjudicated by: (a) the deterministic oracle (matching naude output from the primary run), (b) the absence of crashes, (c) endianness-specific rows (e.g., regexp literals under canonical-LE) passing.
4. Record results with `platform: netbsd-sparc` tag.

---

## Result recording

Each result record in the matrix includes:
- Row id (e.g., A1, C2)
- Engine (Claude, naude, quaude)
- Platform tag (darwin-tui, netbsd-arm64, darwin-ppc, haiku-x64, netbsd-sparc)
- Pass / fail / blocked
- Divergence note (if any — which engine(s) differ, and the symptom)

Format (TBD by operator, but suggested):
```
| A1 | claude: pass | naude: pass | quaude: fail | darwin-tui | config not persisted after relaunch |
| A1 | naude: pass  | quaude: pass | - | netbsd-arm64 | - |
```

Rows that pass on all three engines are recorded once and marked green. Rows that diverge are recorded per engine with a divergence note.

---

## Validation checklist

Before shipping fidelity results:
- [ ] All platform-sensitive rows have been run on at least the primary darwin and one exotic (recommended: NetBSD/arm64 for remote-exec proof, Haiku for the historical >64 KB deadlock).
- [ ] F4 (trust-prompt iTerm2 freeze) was run interactively on the iTerm2 rig.
- [ ] All three engines (Claude, naude, quaude) were tested on darwin; exotics used the available subset.
- [ ] Any divergence between engines is localized (naude-only = SEA/shim bug; quaude-only = tjs engine bug; both = upstream).
- [ ] sparc results were recorded even though no reference engine was available (deterministic oracle + crash-safety as proxy).
