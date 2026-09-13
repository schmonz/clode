'use strict';
// clode-blobulate — THE BLOBULATE STEP, and nothing else.
//
// To blobulate is to ATTACH A PAYLOAD TO AN ENGINE IMAGE: take a binary that knows
// how to run JavaScript and hand it back carrying the program it should run, so the
// result is one file that needs nothing else on disk. Everything around that step —
// resolving the provider, extracting and hooking the bundle, walking and gating the
// ext-dep closure, signing the engine copy, smoking and attesting the product — is
// the ORCHESTRATOR's job (clode-build.cjs). This module is the middle: given inputs
// already staged on disk, it produces the attached artifact.
//
// TWO MECHANISMS, one step. They differ in how the bytes ride, not in what the step
// means:
//
//   'trailer'  (quaude, and --self)  — the payload is APPENDED to a copy of the tjs
//     engine as a canonical-LE trailer: a member archive + manifest + bootstrap,
//     written by libexec/quaude-blobulate.js running UNDER THE ENGINE ITSELF so the
//     bytecode writer and the runtime are the same binary (BC_VERSION lockstep is
//     then automatic, not asserted). Appending tail data breaks strict codesign
//     validation, so the engine copy is signed BEFORE this step runs and never
//     after — see clode-build.cjs's sign-then-append note.
//
//   'postject' (naude)  — the payload is INJECTED into a Node SEA: postject writes
//     the blob into a Mach-O/ELF/PE section of the pinned Node itself, via
//     scripts/build-naude.mjs running under the blob-gen node. Nothing is appended,
//     so the output must be re-signed AFTER injection (build-naude.mjs's job).
//
// BOTH DIRECTIONS OF A PAYLOAD live here, which is why materializeBlobPayload is a
// sibling of blobulate() rather than orchestration: a clode that was ITSELF
// blobulated carries its build inputs as archive members, so before it can attach a
// payload to anything it must first restore the one it is carrying to real files (the
// worker and the assembler are SUBPROCESSES — they cannot read out of a VFS). One
// module, one member-name namespace, read and written in the same place.
//
// WHAT THIS MODULE DOES NOT DO. It never spawns anything itself: every mechanism
// goes through the caller's injected `spawnRun`, which is the one seam every build
// step in this project already passes through. It phrases no user-facing sentence
// either — it hands back a structured result (plus, for the one failure only it can
// explain, the diagnostic fragment) and lets the orchestrator write the message, so
// every `clode: build: ...` line keeps coming from one place.
//
// Loading contract: this is a NODE-side sibling of clode-build.cjs (plain require,
// esbuilt into the clode-main bundle for a blobulated builder). It is NOT loadable
// from the tjs-side worker, whose `require` is a deliberate loud stub — anything on
// that side of the spawn seam must go through loadLibexecCjs instead.

const fs = require('node:fs');
const path = require('node:path');

// Materialize the builder-role VFS members to `mat` on disk. A blobulated NATIVE
// clode runs under tjs and ships NO checkout — so any subprocess it must spawn
// (the blobulate WORKER for a quaude/--self build, or scripts/build-naude.mjs for a
// naude build) needs real files. This is the SUPERSET both build targets need:
// the node-shim tree + libexec support + ext-dep node_modules + deps manifests
// (quaude/--self), plus the prebuilt naude bundle, postject, and the naude
// assembler scripts (build --naude). Extra members a given target doesn't use
// are harmless. Member-name -> on-disk-home mapping mirrors quaude-blobulate.js's
// archive namespace (target-env.cjs and the naude bundle ride at the archive
// ROOT; everything else keeps its path).
function materializeBlobPayload(vfs, mat) {
  for (const [name, bytes] of vfs.files) {
    let dest;
    if (name.startsWith('node-shim/')) dest = path.join(mat, 'libexec', name);
    else if (name.startsWith('libexec/')) dest = path.join(mat, name);
    else if (name.startsWith('node_modules/')) dest = path.join(mat, name);
    // target-env.cjs rides at the archive ROOT (bare name) but belongs beside
    // node-shim/ on disk, i.e. libexec/target-env.cjs — see quaude-blobulate.js.
    else if (name === 'target-env.cjs') dest = path.join(mat, 'libexec', name);
    // deps/claude (ext-dep closure + lockfile sources of truth) AND deps/clode
    // (postject's carried JS — build --naude's --postject) keep their paths.
    else if (name.startsWith('deps/')) dest = path.join(mat, name);
    // The naude assembler + its one sibling require (platform-tag.cjs). A blobulated
    // builder ships no scripts/ dir; build --naude spawns the MATERIALIZED copy.
    else if (name.startsWith('scripts/')) dest = path.join(mat, name);
    // The prebuilt naude SEA main, carried at the archive root (Task 4).
    else if (name === 'naude-entry.bundle.cjs') dest = path.join(mat, name);
    else continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, Buffer.from(bytes));
  }
}

// Append the payload as a canonical-LE trailer, by running the worker UNDER the
// engine. Inputs (all already on disk — staged by the orchestrator):
//   spawnRun      the one spawn seam; (cmd, args, {env, timeout}) -> {status, stdout, stderr}
//   engine        the HOST engine that RUNS the worker (never the cross target)
//   libexec       the tree the worker, the shim and the bootstrap are read from —
//                 the materialized payload under a blobulated builder, the checkout otherwise
//   signedBase    the already-signed engine COPY the trailer is appended to
//   stageDir      the staged bundle (cli.cjs + hooks, or the esbuilt clode-main bundle)
//   nmDir         the resolved ext-dep node_modules to embed as members
//   extrasPath    the node-side manifest fields, as JSON (the worker adds its own)
//   out           where to write the attached artifact
//   embedTemplate --self only: the PRISTINE base engine to carry as a member, so a
//                 blobulated builder can materialize+exec it as its own worker later
//   env, timeout  passed to the spawn verbatim (the caller owns the budget)
//   report        optional Reporter: this step declares/starts/finishes the step
//                 named 'blobulate' — it is this module's own step, so it is
//                 reported here rather than by whoever calls it
//   ingest        optional (line) -> boolean: the Composer's ingest, over the spawn
//                 seam. Returns false for a line that is not a protocol sentinel.
// Returns { ok, result, passthrough, diagnosis } — never a phrased error: the
// orchestrator owns the wording of every `clode: build: ...` line.
async function blobulateTrailer(opts) {
  const { spawnRun, engine, libexec, signedBase, stageDir, nmDir, extrasPath, out,
    embedTemplate, env, timeout, report, ingest } = opts;
  if (report) { report.plan([{ name: 'blobulate' }]); report.start('blobulate'); }
  const w = await spawnRun(engine, ['run', path.join(libexec, 'quaude-blobulate.js'),
    signedBase, stageDir, path.join(libexec, 'node-shim'), nmDir,
    path.join(libexec, 'quaude-bootstrap.mjs'), extrasPath, out,
    // --self embeds the PRISTINE base template as a member (Decision 2) so a
    // blobulated builder can materialize+exec it as the blobulate worker with nothing
    // else on disk. This MUST be the target-platform base (= the cross template
    // for a cross-blobulate), NOT the `engine` that runs THIS worker — else a
    // cross-blobulated builder ships a host-arch template it cannot exec on the
    // target. Native --self: the two are the same file, so this is unchanged
    // there. The quaude role embeds nothing (its base IS the signed copy).
    ...(embedTemplate ? [embedTemplate] : [])], { env, timeout });
  if (report) report.finish('blobulate');
  // Route the worker's protocol lines into the caller's composer, over the spawn
  // seam — the one every build step goes through — BEFORE the status check:
  // a failed blobulate may still have reported real partial progress (compile got
  // partway through before the worker died) worth keeping. `run` buffers the
  // whole child stdout rather than streaming it, so this happens once the
  // worker has already exited, not live — the trace log and the totals a
  // LATER phase's spinner reads are still real, they just update in one
  // jump rather than incrementally during 'Blobulating' itself.
  //
  // ingest() returns false for a line that is not one of its `@clode-step `
  // sentinels — anything else the worker printed (its own console.log
  // narration) is real content and must reach the human-facing log
  // untouched; only the sentinel lines themselves are filtered out, so a
  // `clode build` log stops showing raw JSON.
  let passthrough = '';
  for (const line of w.stdout.split('\n')) {
    if (!(ingest && ingest(line))) passthrough += line + '\n';
  }
  let diagnosis = '';
  if (w.status !== 0 && !w.stdout && !w.stderr) {
    // A bare status with no output = the child never ran (exec failed
    // inside the spawn; 127 is libuv's could-not-exec convention). Say
    // what we tried to exec so a remote CI log is diagnosable. Checked
    // against the RAW w.stdout on purpose (not `passthrough`): a
    // worker whose only output was sentinel lines still ran, and must
    // not be misreported as an exec failure.
    try {
      diagnosis = `\n(no worker output — exec failure? template=${engine} size=${fs.statSync(engine).size})`;
    } catch {
      diagnosis = `\n(no worker output — exec failure? template=${engine} MISSING)`;
    }
  }
  return { ok: w.status === 0, result: w, passthrough, diagnosis };
}

// Inject the payload as a SEA blob, by running the naude assembler under the
// blob-gen node. Inputs:
//   spawnRun      the spawn seam (the naude branch's own, so its tests can capture
//                 this argv without stubbing every other spawn in the build)
//   assembleRoot  the tree the assembler and postject's carried JS are read from —
//                 the materialized payload under a blobulated builder, the checkout otherwise
//   blobgenNode   the pinned node that RUNS the assembler (always this host's arch:
//                 it executes --experimental-sea-config)
//   embedNode     the pinned node whose bytes the blob is injected INTO (the
//                 TARGET's; the same file as blobgenNode for a native build)
//   targetOs      the OUTPUT's platform, which decides the signing rules
//   cli           the extracted, hooked Claude Code entry to bake in
//   bundle        the prebuilt SEA main (naude-entry.bundle.cjs)
//   nmDir         the resolved ext-dep node_modules to tar into the blob
//   extrasPath    the self-description fields, as JSON — removed once the
//                 assembler has read it, whatever its exit status
//   signerBin     off-Mac darwin only: the rcodesign to sign the output with
//   out           optional; absent means build-naude.mjs's own default output path
//   env, timeout  passed to the spawn verbatim
// Returns { ok, result } — the orchestrator phrases the failure.
async function blobulatePostject(opts) {
  const { spawnRun, assembleRoot, blobgenNode, embedNode, targetOs, cli, bundle,
    nmDir, extrasPath, signerBin, out, env, timeout } = opts;
  // build-naude.mjs runs as a SEPARATE process UNDER the blob-gen node (the
  // one that RUNS --experimental-sea-config). Every input is passed
  // explicitly: --blobgen-node/--embed-node (split roles — native passes
  // the same path for both, but named explicitly rather than via the
  // --node alias so this call site never depends on which case it is),
  // --target-os (the signing rules the OUTPUT needs, not the host's),
  // --bundle (the prebuilt SEA main), --nmdir (the deps to tar), --postject
  // (its carried JS).
  const r = await spawnRun(blobgenNode, [
    path.join(assembleRoot, 'scripts', 'build-naude.mjs'),
    '--cli', cli,
    '--blobgen-node', blobgenNode,
    '--embed-node', embedNode,
    '--target-os', targetOs,
    '--bundle', bundle,
    '--nmdir', nmDir,
    '--postject', path.join(assembleRoot, 'deps', 'clode', 'node_modules', 'postject'),
    '--extras', extrasPath,
    ...(signerBin ? ['--darwin-signer', signerBin] : []),
    ...(out ? ['--out', out] : []),
  ], { env, timeout });
  try { fs.rmSync(extrasPath, { force: true }); } catch { /* best effort */ }
  return { ok: r.status === 0, result: r };
}

// The step, one entry point, dispatched on the MECHANISM — not on the product.
// 'trailer' vs 'postject' is the only thing that differs between a quaude, a
// --self builder and a naude at this point in the build; everything else that
// distinguishes them was already decided by the orchestrator upstream.
async function blobulate(opts) {
  const mechanism = opts && opts.mechanism;
  if (mechanism === 'trailer') return blobulateTrailer(opts);
  if (mechanism === 'postject') return blobulatePostject(opts);
  throw new Error(`unknown blobulate mechanism '${mechanism}' (expected 'trailer' or 'postject')`);
}

module.exports = { blobulate, materializeBlobPayload };
