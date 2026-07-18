'use strict';
// The callback the built target's patched in-app updater invokes as
// `CLODE_SELF --clode-internal-update [channel]`. Runs IN clode (the builder):
// fetch a newer Claude Code, rebuild THIS target's kind into a temp in the
// target's OWN dir (so the later rename never crosses filesystems), then swap.
// The rebuild is clodeBuild, whose smoke already gates PONG (+ attest for quaude)
// and exits non-zero on any failure — that IS the verify. Every failure here is
// loud, non-zero, and leaves the target's bytes unchanged. quaude and naude take
// the identical path (the only difference is the --naude build flag). Seams
// (fetch/build/swap + fs probes) injected for tests.
const fs = require('node:fs');
const path = require('node:path');
const { swapInPlace } = require('./clode-swap.cjs');

async function targetUpdate(channel, opts) {
  const {
    env = process.env,
    stderr = process.stderr,
    stdout = process.stdout,
    fetch,
    build,
    swap = swapInPlace,
    existsSync = fs.existsSync,
    accessSync = fs.accessSync,
    rmSync = (p) => fs.rmSync(p, { force: true }),
    randToken = String(process.pid),
  } = opts;
  const fail = (m) => { stderr.write('clode: --clode-internal-update: ' + m + '\n'); return 1; };

  const kind = env.CLODE_TARGET_KIND;
  const target = env.CLODE_TARGET;
  if (kind !== 'quaude' && kind !== 'naude') {
    return fail(`CLODE_TARGET_KIND is ${kind ? `'${kind}' (not quaude|naude)` : 'unset'} — this target did not declare what it is; rebuild it with \`clode build\``);
  }
  if (!target) return fail('CLODE_TARGET is unset — this target did not declare its path; rebuild it');
  if (!existsSync(target)) return fail(`the target no longer exists at ${target}`);

  const dir = path.dirname(target);
  // Fail BEFORE building: never build then discover we cannot replace the file.
  try { accessSync(dir, fs.constants.W_OK); }
  catch { return fail(`the target's directory is not writable: ${dir} — rerun with permission to replace ${path.basename(target)}`); }

  // 1) fetch a newer Claude Code (clode's existing fetch path).
  try { await fetch(channel); }
  catch (e) { return fail(`could not fetch a newer Claude Code: ${(e && e.message) || e}`); }

  // 2) rebuild THIS kind into a temp IN THE TARGET'S DIR. clodeBuild smokes
  //    PONG (+ attest for quaude) and exits non-zero on any failure.
  const temp = path.join(dir, `.${path.basename(target)}.update-${randToken}`);
  const buildArgs = [...(kind === 'naude' ? ['--naude'] : []), '--out', temp];
  let status;
  try { status = await build(buildArgs); }
  catch (e) { try { rmSync(temp); } catch { /* */ } return fail(`rebuild failed: ${(e && e.message) || e}`); }
  if (status !== 0) { try { rmSync(temp); } catch { /* */ } return fail('rebuild failed (see the build output above) — the target is unchanged'); }

  // 3) swap the verified temp over the target.
  try { swap(temp, target, { platform: process.platform, randToken }); }
  catch (e) { try { rmSync(temp); } catch { /* */ } return fail(`swap failed: ${(e && e.message) || e} — the target is unchanged`); }

  stdout.write(`clode: rebuilt ${kind} at ${target} — restart to apply\n`);
  return 0;
}

module.exports = { targetUpdate };
