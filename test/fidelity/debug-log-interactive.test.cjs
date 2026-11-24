'use strict';
// quaude's --debug log of an INTERACTIVE session, READ. The live-turn bugs of 2026-11-23 lived on paths only an
// interactive session takes, so a -p turn's log (test/fidelity/debug-log-errors.test.cjs) cannot stand for it: a built
// quaude in a pty, through test/tool-driver.cjs, whose gate (test/debug-log-gate.cjs) reads quaude's --debug-file and
// holds it to native's on the same session (or, where no native runs, to the absolute rules): boot, a typed turn that
// runs one Read, `/tui fullscreen` (the renderer switch, a remount no -p path takes), then /quit, which must end the
// session by itself.
//
// Its own file because its job is the one with a PTY harness, a built quaude and a native that runs (linux-x64-pty,
// node-shim-oracle-darwin), and debug-log-errors' -p rows run where there is no pty (node-shim-oracle).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { driveTool, ptyHarnessMissing } = require('../tool-driver.cjs');
const { toolResultText } = require('../../scripts/lib/tool-result.cjs');

const IREAD = { name: 'Read', input: { file_path: '' }, id: 'toolu_dbglog_read_1' };
test('quaude\'s --debug log of an interactive session (boot, a turn, /tui, /quit) says nothing native\'s does not', async (t) => {
  if (process.platform === 'win32') { t.skip('the interactive session needs a POSIX pty'); return; }
  const missing = ptyHarnessMissing();
  if (missing) { t.skip(missing); return; }
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'debuglog-tui-')));
  try {
    const file = path.join(base, 'work', 'note.txt');
    const use = { ...IREAD, input: { file_path: file } };
    const r = await driveTool({ tool: use, base, interactive: true, prompt: 'read the note',
      setup: (work) => fs.writeFileSync(path.join(work, 'note.txt'), 'DEBUGLOG-NOTE-7\n'),
      after: [{ label: 'tui', send: '/tui fullscreen' }, { label: 'tui-enter', send: '\r' },
        { label: 'quit', send: '/quit' }, { label: 'quit-enter', send: '\r', exits: true }] });
    if (r.quaude.absent) { t.skip(r.quaude.absent); return; }
    assert.strictEqual(r.quaude.status, 0, `the session did not run to /quit: ${r.quaude.stderr}\n${r.quaude.stdout.slice(-800)}`);
    assert.match(toolResultText(r.quaude.raw, use.id), /DEBUGLOG-NOTE-7/, 'the turn\'s Read did not answer');
    // driveTool already rejected on a finding; this says which judgement it was, and that one happened
    assert.ok(r.debugLog && ['differential', 'absolute'].includes(r.debugLog.mode), `no debug-log judgement: ${JSON.stringify(r.debugLog)}`);
    for (const n of r.debugLog.notes) t.diagnostic(n);
    t.diagnostic(`debug log judged ${r.debugLog.mode}ly (native ${r.native.absent ? `absent: ${r.native.absent}` : 'ran'})`);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
