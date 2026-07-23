# Converting a RECIPE row into a test

`test/fidelity/RECIPE.md` rows come in three shapes. Each maps to one test
template below. Pick the template by the row's *nature*, not its category
letter — e.g. most of category F is "interactive/render" (template b), but F1
and F2 are really deterministic-engine claims exercised through a render, and
already have `→` tests (`test/node-shim-vflag-regex.test.cjs`,
`test/node-shim-agentic.test.cjs`).

**The rule, always:** a new divergence lands as a **failing test first** (see
`superpowers:systematic-debugging` / `superpowers:test-driven-development`),
*then* the fix. Never write the test to match whatever the buggy build
currently does. If, once written, the test genuinely surfaces a live
divergence, keep it failing (or `t.skip('FAILS: ...')` with the concrete
reason) and leave the RECIPE row at `?` — do not force it green just to get a
clean run. `test/node-shim-cloexec.test.cjs` (RECIPE row E2) is the existing
example of this: it found a real quaude-vs-naude divergence and was left
skipped with a `// FAILS:` note rather than fudged.

After adding or mapping a test, update the row's `test` cell in `RECIPE.md`
and confirm `node test/fidelity/audit.mjs` still reports the row as guarded
(for `→` rows only; `?` rows are not audited).

---

## (a) Deterministic engine row → an oracle-models naude-vs-quaude test

Use this when the row is a claim about engine/runtime *behavior* that should
be identical given identical inputs: file I/O, signals, spawn semantics,
env propagation, applet discovery, config writes. These convert to a test that
runs the SAME code under both runtimes and diffs the observable result — a
client-observable invariant (exit code, stdout, a written file's bytes), never
prose.

Two live shapes exist, pick whichever fits:

**a1. Shim-primitive shape** — a small fixture body run once under host node
(the reference) and once under `tjs run node-shim/loader.cjs` (the shim under
test), via `test/node-shim-helper.cjs`'s `runLoader`/`skipUnlessTjs`. This is
the shape of Task 5's real tests:
- `test/node-shim-large-output.test.cjs` (RECIPE C2) — spawn/read/write with a
  >64KB payload, asserting exact byte-for-byte match against the node
  baseline, no hang.
- `test/node-shim-cloexec.test.cjs` (RECIPE E2) — an fd-inheritance oracle,
  diffed against real node's own `spawnSync` on the same fixture.

Skeleton:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runLoader, skipUnlessTjs } = require('./node-shim-helper.cjs');

function prog(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-<ROW>-'));
  const f = path.join(dir, 'p.cjs');
  fs.writeFileSync(f, body);
  return f;
}

const BODY = `
  // ... exercise the exact API/path the row is about, then:
  console.log(JSON.stringify({ /* client-observable result */ }));
`;

test('<row action>, matching node', (t) => {
  if (skipUnlessTjs(t)) return;
  const f = prog(BODY);
  const node = JSON.parse(execFileSync(process.execPath, [f], { encoding: 'utf8' }).trim());
  // assert the node baseline itself is sane, THEN:
  const r = runLoader(f, [], { timeout: 20000 });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout.trim()), node, 'quaude matches node exactly');
});
```

**a2. Full-CLI shape** — when the row needs the actual bundled `cli.cjs`
(a real agentic turn against a mock Anthropic server), use
`test/oracle-models.cjs`'s `stageProviderCli()` +
`runNaudeModelAsync()`/`runQuaudeModelAsync()`. This is the shape of
`test/node-shim-roundtrip-oracle.test.cjs`:

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { skipUnlessTjs } = require('./node-shim-helper.cjs');
const { startMockAnthropic } = require('./mock-anthropic-helper.cjs');
const { stageProviderCli, runNaudeModelAsync, runQuaudeModelAsync } = require('./oracle-models.cjs');

test('<row action> matches the naude reference byte for byte', async (t) => {
  if (skipUnlessTjs(t)) return;
  const staged = stageProviderCli();
  if (!staged) { t.skip('no Bun-packaged CC provider (CLODE_PROVIDER_BIN / CLODE_CLAUDE_BIN)'); return; }

  const mock = await startMockAnthropic();
  let naude;
  try {
    naude = await runNaudeModelAsync(staged.cli, ['-p', '<prompt>'], { cwd: staged.dir, env: mockEnv(mock), timeout: 90000 });
  } finally { await mock.close(); }

  const mock2 = await startMockAnthropic();
  let quaude;
  try {
    quaude = await runQuaudeModelAsync(staged.cli, ['-p', '<prompt>'], { cwd: staged.dir, env: mockEnv(mock2), timeout: 90000 });
  } finally { await mock2.close(); }

  assert.strictEqual(quaude.status, naude.status);
  assert.strictEqual(quaude.stdout.trim(), naude.stdout.trim());
});
```

Both shapes SKIP cleanly (no tjs binary, no provider) rather than fail —
never make a row's test hard-require infra a plain `npm test` run doesn't
have.

---

## (b) Interactive/render row → an e2e-pty capture, gated behind `CLODE_LIVE_RENDER`

Use this when the row is about what actually *renders* under a real
pseudo-terminal: TUI paint, slash-command output, repaint-on-close, resize,
trust-prompt keystrokes. These build a real quaude (`clode build`) and drive
it under `test/tui-screen.cjs` (a real `node-pty` + `@xterm/headless` VT100
emulator) via `test/e2e-pty.cjs`'s `capture()`, asserting a **rendered-frame
marker** in the returned screen string — never model prose. Real exports:
`seedClaudeProfile(home, opts)`, `capture(sbx, opts)`, `TUI_SCREEN`, where
`sbx` is a `sandbox()` from `test/e2e.cjs` (`{dir, home, stateRoot, env}`).
Live examples: `test/e2e-tui-tjs.test.cjs`, `test/e2e-doctor-parity.test.cjs`,
and this task's `test/fidelity/stale-frames.pty.test.cjs`.

Gate on `CLODE_LIVE_RENDER=1` — these spawn a real bundle (Keychain probes,
possible network) — matching the existing hermeticity boundary. Without the
flag, the test file must exit 0 with every test `t.skip`'d, never error.

Skeleton:

```js
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sandbox, REPO } = require('../e2e.cjs');           // or './e2e.cjs' outside fidelity/
const { seedClaudeProfile, capture } = require('../e2e-pty.cjs');
const { resolveClaudeBin } = require('../../libexec/clode-resolve.cjs');
const { tjsPath } = require('../node-shim-helper.cjs');

const ENTRY = path.join(REPO, 'bin', 'clode');
function realProvider() {
  try { const p = resolveClaudeBin({ env: process.env }); if (p && fs.existsSync(p)) return p; } catch { /* */ }
  return null;
}

let SKIP = null, SCREEN = '', SBX = null, DIR = null;
before(() => {
  if (process.env.CLODE_LIVE_RENDER !== '1') { SKIP = 'live-render opt-in only (set CLODE_LIVE_RENDER=1)'; return; }
  if (!tjsPath()) { SKIP = 'no tjs binary (CLODE_TJS or build/tjs/tjs)'; return; }
  const provider = realProvider();
  if (!provider) { SKIP = 'no resolvable Claude Code provider'; return; }
  SBX = sandbox();
  seedClaudeProfile(SBX.home, { cwd: REPO });
  DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fidelity-<row>-'));
  const quaude = path.join(DIR, 'quaude');
  const build = spawnSync(process.execPath, [ENTRY, 'build', '--out', quaude], {
    encoding: 'utf8', timeout: 300000,
    env: { ...process.env, CLODE_CLAUDE_BIN: provider, CLODE_CACHE: path.join(DIR, 'cache'), CLODE_TJS: tjsPath(), DYLD_INSERT_LIBRARIES: '' },
  });
  if (build.status !== 0) { SKIP = `clode build failed:\n${build.stdout}\n${build.stderr}`; return; }
  SCREEN = capture(SBX, { seconds: 12, thenHex: ['<hex>@<delay>', ...], rows: 120, cols: 100, cmd: [quaude] });
});
after(() => {
  if (SBX) { try { fs.rmSync(SBX.dir, { recursive: true, force: true }); } catch { /* */ } }
  if (DIR) { try { fs.rmSync(DIR, { recursive: true, force: true }); } catch { /* */ } }
});

test('<row: a rendered-frame marker appears/disappears as expected>', (t) => {
  if (SKIP) { t.skip(SKIP); return; }
  assert.match(SCREEN, /<marker>/);      // or assert.doesNotMatch for an "erased" claim
});
```

**Two-engine PTY diff is a harness extension, not shipped today.** The
original plan for this template imagined driving *both* naude and quaude
under one call (`makeWsWorlds()`/`worlds.naude`/`worlds.quaude`) — those
names never existed in `test/e2e-pty.cjs`. The closest real two-sided PTY
capture is `test/e2e-doctor-parity.test.cjs`, which captures the **native**
provider binary and quaude side by side and diffs them with
`test/doctor-parity.cjs` — but that diff is itself still `t.skip`'d pending an
allowlist (see that file's comment), and there's no equivalent that captures
a **naude** SEA build's live render (naude is packaged, not just staged, so
driving one under a PTY needs its own `clode build --naude`, not yet wired
into this harness). If a row genuinely needs a naude-vs-quaude *render* diff
(not just the naude-vs-quaude oracle-models comparison in template (a)),
treat wiring that up as its own small harness-extension task; until then,
write the row as a **single-engine capture asserting a client-observable
marker directly** (as in `test/fidelity/stale-frames.pty.test.cjs`), which is
still a real regression net — it just doesn't get its reference for free from
a second live engine.

---

## (c) Model-nondeterministic row → assert only the client-observable side effect

Use this when the row necessarily involves what the *model* does (a 3-4 turn
conversation, an MCP tool call, a subagent) — the model's wording is not
reproducible or worth asserting on. Convert to a test against a **mock**
Anthropic server (`test/mock-anthropic-helper.cjs`'s `startMockAnthropic()`)
with a **canned** scripted response, so the "model" side is fully
deterministic, and assert only the client-observable side effect: a file was
written with expected content, a specific tool was dispatched (inspect
`mock.requests`), the process exited 0, a specific string reached stdout.
Never assert on free-form model prose.

`test/node-shim-agentic.test.cjs` (RECIPE F2's guarding test) is the live
example: it scripts a mock conversation (prompt → `tool_use(Bash)` → the tool
actually runs → its real stdout flows back in the `tool_result` → a final
`TOOLDONE` marker), and asserts only exit code + the presence/absence of
specific marker strings (`TOOLDONE`, never "bash output unavailable") — not
what the model "said" about the tool result.

Skeleton (building on `test/oracle-models.cjs`'s `runQuaudeModelAsync`, or a
built binary via `runBinaryAsync`):

```js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { skipUnlessTjs } = require('./node-shim-helper.cjs');
const { startMockAnthropic, cannedSSE, cannedToolUseSSE } = require('./mock-anthropic-helper.cjs');
const { stageProviderCli, runQuaudeModelAsync } = require('./oracle-models.cjs');

const TOOL_ID = 'toolu_row_1';

test('<row: a full turn produces the expected side effect>', async (t) => {
  if (skipUnlessTjs(t)) return;
  const staged = stageProviderCli();
  if (!staged) { t.skip('no Bun-packaged CC provider'); return; }

  // startMockAnthropic({ respond }) -- `respond(requestBody)` picks the canned
  // SSE for THIS POST by inspecting the running conversation (e.g. whether
  // the tool_use id already appears, meaning the tool_result came back), so
  // one mock instance scripts a whole multi-turn exchange. Real shape, see
  // test/node-shim-agentic.test.cjs.
  const mock = await startMockAnthropic({
    respond: (body) => body.includes(TOOL_ID)
      ? cannedSSE('TOOLDONE')                                    // 2nd POST carries the tool_result -> final text
      : cannedToolUseSSE('Bash', { command: '<scripted command>' }, TOOL_ID), // 1st POST -> request a tool call
  });
  try {
    const r = await runQuaudeModelAsync(staged.cli, ['-p', '<scripted prompt>'], {
      cwd: staged.dir,
      env: { ...process.env, ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: 'sk-ant-mock' },
      timeout: 90000,
    });
    assert.strictEqual(r.status, 0, r.stderr);
    // Assert the SIDE EFFECT, not model wording:
    assert.match(r.stdout, /TOOLDONE/);                                 // exact marker
    assert.ok(!/output unavailable|too large/i.test(r.stdout));         // known failure modes
    const followUp = mock.requests.find((q) => q.method === 'POST' && q.body && q.body.includes(TOOL_ID) && q.body.includes('tool_result'));
    assert.ok(followUp, 'the tool_result never made it back to the mock');
  } finally {
    await mock.close();
  }
});
```

---

## Quick reference

| Row nature | Template | Harness | Example |
|---|---|---|---|
| deterministic engine behavior (fs/signals/spawn/env) | (a1) | `node-shim-helper.cjs` | `test/node-shim-large-output.test.cjs`, `test/node-shim-cloexec.test.cjs` |
| deterministic behavior needing the full bundled CLI | (a2) | `oracle-models.cjs` | `test/node-shim-roundtrip-oracle.test.cjs` |
| interactive TUI / render | (b) | `e2e-pty.cjs` + `tui-screen.cjs`, gated `CLODE_LIVE_RENDER` | `test/e2e-tui-tjs.test.cjs`, `test/e2e-doctor-parity.test.cjs`, `test/fidelity/stale-frames.pty.test.cjs` |
| model-nondeterministic (turns, tools, MCP, subagents) | (c) | `mock-anthropic-helper.cjs` + `oracle-models.cjs` | `test/node-shim-agentic.test.cjs` |
