# Reachable-Platform Runbook

This document specifies how to run the **platform-sensitive subset** of the fidelity recipe on each exotic rig beyond the primary darwin box. Platform-sensitive rows are those tagged `platform` in the `axes` column of `RECIPE.md` — they capture failures that broke per-platform before (file I/O sizes, pipe deadlocks, signals, TTY, spawn, applet discovery, config writes).

Platform-sensitive row ids: **A1, A2, B1, C1, C2, C3, C4, D1, D2, D3, D4, D5, D6, E1, E2, E3, F4, G3, J6** (19 rows)

Derived with (covers categories **A–J**, not just A–I, so a future category addition isn't silently missed again):
```
node -e "const t=require('fs').readFileSync('test/fidelity/RECIPE.md','utf8');const rows=[...t.matchAll(/^\|\s*([A-J]\d+)\s*\|[^|]*\|[^|]*\|\s*([^|]*)\|/gm)].filter(m=>/platform/.test(m[2])).map(m=>m[1]);console.log(rows.join(','))"
```

## Reference model for exotic rigs

Node only publishes binaries for a bounded set of platforms (see
`docs/superpowers/specs/2026-07-17-clode-fetches-naude-engine-design.md`) —
**not** Haiku, NetBSD (any arch), sparc, or m68k/PPC. So on the NetBSD/arm64,
Tiger-PPC, Haiku, and sparc rigs below, **naude generally cannot run locally**
— there is no local naude (or upstream Claude) reference engine on the box.
The reference model on those rigs is: run the row's Claude + naude behavior
on the **primary darwin rig** first (the darwin baseline), then compare
quaude-on-exotic against that darwin baseline, not against a local reference.
(This corrects an earlier plan-doc example that assumed naude itself could
serve as the on-box reference on an exotic rig such as NetBSD/sparc.)

## Rig: Primary darwin (local)

**Engines available:** Claude (upstream), naude (Node SEA), quaude (tjs)
**Test scope:** Full recipe (all rows A–J)
**Applets:** Check `command -v rg bfs ugrep` first, then exercise both the present and absent case for the `applets`-tagged rows (see `test/fidelity/applet-config.mjs` for the present/absent config helper).
**Result recording:** Record pass/fail for each engine in `test/fidelity/RECIPE.md` or `test/fidelity/RECIPE-RESULTS.md` (TBD by operator)

This is the canonical reference run. The operator executes the full recipe here in one sitting, producing a pass/fail matrix per engine. Any divergence between naude/quaude and Claude is localized here, and platform-sensitive failures are cross-checked on exotics below.

---

## Rig: iTerm2 autonomous rig (darwin interactive TUI)

**Where:** Local darwin machine, in iTerm2 terminal, autonomous TUI mode
**Engines available:** Claude (upstream), naude (Node SEA), quaude (tjs) — same as primary, but interactive
**Test scope:** Platform-sensitive rows only: **A1, A2, B1, C1, C2, C3, C4, D1, D2, D3, D4, D5, D6, E1, E2, E3, F4, G3, J6**
**Applets:** Check `command -v rg bfs ugrep`; same present/absent config exercise as the primary rig, via `test/fidelity/applet-config.mjs`.
**Special note:** This rig is the ONLY place to run **F4** (trust-prompt freeze under iTerm2) and **J6** (interactive `/remote-control` shows "is active" in the TUI) — both require interactive keystroke delivery to a live TUI. Both rows are platform-tagged because they need real keystrokes reaching the running process, not a scripted/headless harness.
**Result recording:** Append platform tag `darwin-tui` to each row result in the result matrix

### How to run:
1. Launch iTerm2 (or the configured autonomous-TUI rig).
2. For each platform-sensitive row id, execute the action and record Claude / naude / quaude divergence (if any).
3. F4 (trust-prompt) must be run interactively: keystrokes must reach the prompt, and the prompt must advance (not freeze).
4. J6 (`/remote-control`) must be run interactively: issue the command in the live TUI and confirm it shows "is active" with a session URL, not just that the process didn't crash.
5. Record results with `platform: darwin-tui` tag.

---

## Rig: NetBSD/arm64 SSH VM

**Where:** `ssh <credentials> <host>`
**Engines available:** quaude (tjs — confirmed via the netbsd-arm64 leg). Node does not publish official NetBSD binaries for any architecture, so naude structurally cannot run here — this is not an arm64-specific gap, it applies to NetBSD regardless of arch (double-checked against the naude-reach design doc, which excludes NetBSD outright, not just some arches).
**Reference engine:** None locally. Use the **darwin baseline**: run this row's Claude + naude behavior on the primary darwin rig, then compare quaude-on-NetBSD/arm64 against that recorded darwin baseline.
**Test scope:** Platform-sensitive rows only: **A1, A2, B1, C1, C2, C3, C4, D1, D2, D3, D4, D5, D6, E1, E2, E3, F4, G3**
**Applets:** Check `command -v rg bfs ugrep` on the VM; exercise present/absent per `test/fidelity/applet-config.mjs` (a pkgsrc box may have none of the three installed by default).
**Result recording:** Append platform tag `netbsd-arm64` to each row result

### How to run:
1. Run the full recipe (or at least these platform-sensitive rows) on the primary darwin rig first, and record the Claude + naude behavior as the darwin baseline.
2. SSH to the NetBSD/arm64 VM.
3. Install or copy the quaude binary to the VM (see deployment strategy; exact steps depend on the operator's setup).
4. For each platform-sensitive row, execute the action with quaude as the subject and compare against the recorded darwin baseline (not a local reference — there isn't one).
5. Key differences from darwin: ARM64 architecture, NetBSD kernel (different signal handling, spawn semantics, file I/O buffering).
6. Record results with `platform: netbsd-arm64` tag, noting the divergence (if any) against the darwin baseline.

---

## Rig: Tiger PPC VM

**Where:** `ssh -p 1215 schmonz@localhost` (or operator's configured credentials)
**Engines available:** quaude (tjs — proven on real PowerPC via cross-fuse). Node has never published PowerPC macOS binaries and Tiger (10.4) predates any Node build in any case, so naude cannot run here.
**Reference engine:** None locally. Use the **darwin baseline**: run this row's Claude + naude behavior on the primary darwin rig, then compare quaude-on-Tiger-PPC against that recorded darwin baseline.
**Test scope:** Platform-sensitive rows only: **A1, A2, B1, C1, C2, C3, C4, D1, D2, D3, D4, D5, D6, E1, E2, E3, F4, G3**
**Applets:** Check `command -v rg bfs ugrep` on the guest; exercise present/absent per `test/fidelity/applet-config.mjs`. A stock Tiger guest is unlikely to have any of the three preinstalled — verify rather than assume.
**Result recording:** Append platform tag `darwin-ppc` to each row result

### How to run:
1. Run the full recipe (or at least these platform-sensitive rows) on the primary darwin rig first, and record the Claude + naude behavior as the darwin baseline.
2. SSH to the Tiger PPC VM (10.4.11 G4, qemu guest).
3. Copy the quaude binary (cross-fused for ppc on an arm64 host) to the VM.
4. For each platform-sensitive row, execute the action with quaude as the subject and compare against the recorded darwin baseline (not a local reference — there isn't one).
5. Key differences from darwin: 32-bit big-endian PowerPC, pre-10.5 (no posix_spawn), fork/exec semantics differ.
6. Record results with `platform: darwin-ppc` tag, noting the divergence (if any) against the darwin baseline.

---

## Rig: Haiku box

**Where:** Direct access to Haiku hardware or VM
**Engines available:** quaude (tjs — confirmed via haiku-x64 leg). Node does not publish Haiku binaries, so naude cannot run here.
**Reference engine:** None locally. Use the **darwin baseline**: run this row's Claude + naude behavior on the primary darwin rig, then compare quaude-on-Haiku against that recorded darwin baseline.
**Test scope:** Platform-sensitive rows only: **A1, A2, B1, C1, C2, C3, C4, D1, D2, D3, D4, D5, D6, E1, E2, E3, F4, G3**
**Applets:** Check `command -v rg bfs ugrep` on the box; exercise present/absent per `test/fidelity/applet-config.mjs`.
**Result recording:** Append platform tag `haiku-x64` to each row result
**Known issue:** C2 (large write >64 KB to a pipe) was historically deadlocked on Haiku; verify fix holds.

### How to run:
1. Run the full recipe (or at least these platform-sensitive rows) on the primary darwin rig first, and record the Claude + naude behavior as the darwin baseline.
2. Log in to the Haiku box (direct console or SSH, depending on setup).
3. Copy the quaude binary to the box.
4. For each platform-sensitive row, execute the action with quaude as the subject and compare against the recorded darwin baseline. Pay special attention to C2 (large I/O) — this platform previously had a uv_write deadlock for pipes >64 KB.
5. Record results with `platform: haiku-x64` tag, noting the divergence (if any) against the darwin baseline.

---

## Rig: sparc VM

**Where:** qemu guest (NetBSD/sparc), managed by the fidelity harness or deployed separately
**Engines available:** quaude (tjs — confirmed via netbsd-sparc leg and canonical-LE bytecode proof)
**Reference engine:** None locally — no local reference engine (upstream Claude and naude are not available on sparc; quaude self-compares via deterministic oracle against the darwin baseline recorded in the primary run).
**Test scope:** Platform-sensitive rows only: **A1, A2, B1, C1, C2, C3, C4, D1, D2, D3, D4, D5, D6, E1, E2, E3, F4, G3**
**Applets:** Check `command -v rg bfs ugrep` on the guest; exercise present/absent per `test/fidelity/applet-config.mjs`.
**Result recording:** Append platform tag `netbsd-sparc` to each row result
**Key characteristic:** 32-bit big-endian SPARC; canonical-LE bytecode proof (the shipped LE bytecode deserializes correctly on 32-bit BE).

### How to run:
1. Run the full recipe (or at least these platform-sensitive rows) on the primary darwin rig first, and record the Claude + naude behavior as the darwin baseline.
2. Boot or access the sparc VM (qemu sun4m guest with NetBSD 10.1).
3. Copy the quaude binary (cross-fused on x64, then booted on sparc) to the guest.
4. For each platform-sensitive row, execute the action against quaude.
   - Because there is no local reference engine, results are recorded as "quaude: pass/fail" with notes on any crashes or anomalies.
   - Behavioral correctness is adjudicated by: (a) the deterministic oracle (matching naude output recorded in the darwin baseline), (b) the absence of crashes, (c) endianness-specific rows (e.g., regexp literals under canonical-LE) passing.
5. Record results with `platform: netbsd-sparc` tag.

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
- [ ] F4 (trust-prompt iTerm2 freeze) and J6 (interactive `/remote-control` "is active") were both run interactively on the iTerm2 rig.
- [ ] All three engines (Claude, naude, quaude) were tested on darwin; exotic rigs (NetBSD/arm64, Tiger PPC, Haiku, sparc) compared quaude against the darwin baseline, since naude cannot run there.
- [ ] Any divergence between engines is localized per `RECIPE.md`'s localization rule: diverges at quaude but not naude ⇒ the tjs engine/node-shim; diverges at naude too ⇒ our SEA/build/shim-shared-with-naude; all three agree ⇒ fidelity holds. Claude is the reference baseline, never the blamed party.
- [ ] Per-rig applet availability (`rg`/`bfs`/`ugrep`) was checked and both present/absent configs exercised where the `applets` axis applies.
- [ ] sparc results were recorded even though no local reference engine was available (deterministic oracle + crash-safety as proxy).
