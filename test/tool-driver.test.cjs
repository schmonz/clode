'use strict';
// test/tool-driver.cjs, the ONE harness every every-tool Phase A driver runs its turn through, against FAKE quaude and
// native binaries: a node script that speaks to the mock as the real target does (POST /v1/messages, read the
// scripted tool_use from the SSE, "run" it, POST the follow-up carrying its tool_result, print the closing text).
// The fake's tool COMPUTES its answer (PRODUCT-<a*b>), so the input never spells it: a driver that read the tool_use
// instead of the tool_result could not find it.
//
// What is held: driveTool returns the tool_result of the scripted call (and '' when the target sent none, never the
// input); each side gets a fresh HOME and CLAUDE_CONFIG_DIR of its own under the driver's base, and the caller's own
// ~/.claude is untouched; native is skipped WITH its reason (named by the caller, or a provider that is not there);
// a script of several calls is answered in order. FakeDriverTool is not a registered tool, so
// test/build-gates/tool-coverage-gates.test.cjs lists this file's driver as foreign, never as a cell.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { driveTool, TOOL_SWITCHES } = require('./tool-driver.cjs');   // first: it applies the suite home, standalone too
const { toolResultText, assertFailsOnMissingOutput } = require('../scripts/lib/tool-result.cjs');

const SKIP = process.platform === 'win32' ? 'the fake targets are #!/bin/sh wrappers' : false;

// The fake target. FAKE_MODE=silent answers the tool_use with a plain text turn (no tool_result at all).
const FAKE_SRC = `'use strict';
const fs = require('node:fs');
const path = require('node:path');
const LABEL = process.argv[2];
const args = process.argv.slice(3);
const prompt = args[args.indexOf('-p') + 1];
const url = process.env.ANTHROPIC_BASE_URL + '/v1/messages';
function parse(sse) {
  const uses = []; let text = '';
  for (const block of sse.split('\\n\\n')) {
    const line = block.split('\\n').find((l) => l.startsWith('data: '));
    if (!line) continue;
    const ev = JSON.parse(line.slice(6));
    if (ev.type === 'content_block_start' && ev.content_block.type === 'tool_use') uses.push({ id: ev.content_block.id, name: ev.content_block.name, json: '' });
    if (ev.type === 'content_block_delta' && ev.delta.type === 'input_json_delta') uses[uses.length - 1].json += ev.delta.partial_json;
    if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') text += ev.delta.text;
  }
  return { uses: uses.map((u) => ({ id: u.id, name: u.name, input: JSON.parse(u.json || '{}') })), text };
}
(async () => {
  const cfg = process.env.CLAUDE_CONFIG_DIR;
  fs.mkdirSync(cfg, { recursive: true });
  fs.writeFileSync(path.join(cfg, 'fake-target-was-here'), LABEL);
  const messages = [{ role: 'user', content: [{ type: 'text', text: prompt }] }];
  for (let i = 0; i < 10; i++) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'fake', messages }) });
    const turn = parse(await r.text());
    if (!turn.uses.length) { process.stdout.write(turn.text + '\\n'); return; }
    messages.push({ role: 'assistant', content: turn.uses.map((u) => ({ type: 'tool_use', id: u.id, name: u.name, input: u.input })) });
    if (process.env.FAKE_MODE === 'silent') { messages.push({ role: 'user', content: [{ type: 'text', text: 'continue' }] }); continue; }
    // A use with a prompt is a fake Agent: its subagent is a fresh conversation, and its answer is the tool_result.
    const answers = [];
    for (const u of turn.uses) {
      if (typeof u.input.prompt !== 'string') { answers.push(LABEL + ' PRODUCT-' + (u.input.a * u.input.b) + ' tasks=' + process.env.CLAUDE_CODE_ENABLE_TASKS + ' home=' + process.env.HOME + ' cfg=' + cfg); continue; }
      const sub = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'fake', messages: [{ role: 'user', content: [{ type: 'text', text: u.input.prompt }] }] }) });
      answers.push(LABEL + ' SUBAGENT-SAID ' + parse(await sub.text()).text);
    }
    messages.push({ role: 'user', content: turn.uses.map((u, k) => ({ type: 'tool_result', tool_use_id: u.id,
      content: [{ type: 'text', text: answers[k] }] })) });
  }
  process.exit(3);
})();
`;

function fakes() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tool-driver-fakes-')));
  const src = path.join(dir, 'fake-target.cjs');
  fs.writeFileSync(src, FAKE_SRC);
  const bin = (label) => {
    const p = path.join(dir, label);
    fs.writeFileSync(p, `#!/bin/sh\nexec '${process.execPath}' '${src}' ${label} "$@"\n`, { mode: 0o755 });
    return p;
  };
  return { dir, quaude: bin('quaude'), native: bin('native') };
}

const FAKE = { name: 'FakeDriverTool', input: { a: 6, b: 7 }, id: 'toolu_fake_driver_1' };
const FAKE_TWO = { name: 'FakeDriverTool', input: { a: 3, b: 5 }, id: 'toolu_fake_driver_2' };
const sawProduct = (m) => toolResultText(m, FAKE.id).includes('PRODUCT-42');
const sawSecond = (m) => toolResultText(m, FAKE_TWO.id).includes('PRODUCT-15');

test('driveTool returns the tool_result of the scripted call, from quaude and from native, each judged', { skip: SKIP }, async () => {
  assertFailsOnMissingOutput(sawProduct, FAKE);
  const f = fakes();
  try {
    const r = await driveTool({ tool: FAKE, quaude: f.quaude, native: f.native });
    assert.strictEqual(r.quaude.status, 0, r.quaude.stderr);
    assert.ok(sawProduct(r.quaude.raw), `quaude: ${JSON.stringify(r.quaude.text)}`);
    assert.match(r.quaude.text, /^quaude PRODUCT-42 /);
    assert.strictEqual(r.quaude.isError, false);
    assert.match(r.quaude.stdout, /TOOL-DRIVER-DONE/, 'the turn reached the closing text');
    assert.strictEqual(r.native.status, 0, r.native.stderr);
    assert.ok(sawProduct(r.native.raw), `native: ${JSON.stringify(r.native.text)}`);
    assert.match(r.native.text, /^native PRODUCT-42 /);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('driveTool never reads the tool_use: a target that sends no tool_result yields empty text', { skip: SKIP }, async () => {
  assertFailsOnMissingOutput(sawProduct, FAKE);
  const f = fakes();
  try {
    const r = await driveTool({ tool: FAKE, quaude: f.quaude, nativeSkip: 'not under test here', env: { FAKE_MODE: 'silent' } });
    assert.strictEqual(r.quaude.status, 0, r.quaude.stderr);
    assert.strictEqual(r.quaude.text, '');
    assert.strictEqual(r.quaude.result, null);
    assert.ok(!sawProduct(r.quaude.raw));
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('driveTool sandboxes HOME and CLAUDE_CONFIG_DIR per side; the caller\'s ~/.claude is untouched', { skip: SKIP }, async () => {
  const f = fakes();
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tool-driver-base-')));
  // The caller's home is the SUITE's throwaway one (tool-driver.cjs applies test/suite-home.cjs, standalone too), never the
  // developer's: this compares listings of a home the run may read, and must not read the real one.
  assert.ok(path.basename(process.env.HOME).startsWith('clode-test-home-'), `HOME ${process.env.HOME} is the suite home`);
  const callerDirs = [process.env.CLAUDE_CONFIG_DIR, path.join(process.env.HOME, '.claude')].filter(Boolean);
  const before = callerDirs.map((d) => [d, fs.existsSync(d) ? fs.readdirSync(d).sort() : null]);
  assertFailsOnMissingOutput(sawProduct, FAKE);
  try {
    const r = await driveTool({ tool: FAKE, base, quaude: f.quaude, native: f.native });
    assert.ok(sawProduct(r.quaude.raw) && sawProduct(r.native.raw));
    for (const side of ['quaude', 'native']) {
      const said = /home=(\S+) cfg=(\S+)$/.exec(r[side].text);
      assert.ok(said, `${side}: ${r[side].text}`);
      const [, home, cfg] = said;
      assert.strictEqual(home, r[side].home.HOME);
      assert.strictEqual(cfg, r[side].home.CLAUDE_CONFIG_DIR);
      assert.ok(home.startsWith(path.join(base, side) + path.sep), `${side}'s HOME ${home} is under ${base}/${side}`);
      assert.ok(cfg.startsWith(home + path.sep), `${side}'s config dir is inside its own HOME`);
      assert.notStrictEqual(home, process.env.HOME);
      assert.strictEqual(fs.readFileSync(path.join(cfg, 'fake-target-was-here'), 'utf8'), side);
    }
    for (const [d, names] of before) {
      assert.deepStrictEqual(fs.existsSync(d) ? fs.readdirSync(d).sort() : null, names, `${d} changed`);
      assert.ok(!fs.existsSync(path.join(d, 'fake-target-was-here')));
    }
    assert.ok(fs.existsSync(base), 'a base the caller made is the caller\'s to remove');
  } finally {
    fs.rmSync(f.dir, { recursive: true, force: true });
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('driveTool reports a native skip with its reason, and a native this box lacks as absent, never as skipped', { skip: SKIP }, async () => {
  assertFailsOnMissingOutput(sawProduct, FAKE);
  const f = fakes();
  try {
    const named = await driveTool({ tool: FAKE, quaude: f.quaude, nativeSkip: 'the turn needs claude.ai credentials' });
    assert.deepStrictEqual(named.native, { skipped: 'the turn needs claude.ai credentials' });
    assert.ok(sawProduct(named.quaude.raw));
    const gone = path.join(f.dir, 'no-such-native');
    const missing = await driveTool({ tool: FAKE, quaude: f.quaude, native: gone });
    assert.match(missing.native.absent, /no-such-native/);
    assert.strictEqual(missing.native.skipped, undefined, 'absent is the box\'s answer, skipped the caller\'s');
    assert.throws(() => driveTool({ tool: FAKE, quaude: f.quaude, nativeSkip: '' }), /one-line reason/);
    const nativeOnly = await driveTool({ tool: FAKE, quaudeSkip: 'measuring native alone', native: f.native });
    assert.deepStrictEqual(nativeOnly.quaude, { skipped: 'measuring native alone' });
    assert.ok(sawProduct(nativeOnly.native.raw));
    assert.throws(() => driveTool({ tool: FAKE, quaudeSkip: 'two\nlines' }), /quaudeSkip must be a one-line reason/);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('driveTool answers a script of several calls in order, and lays the fixture before each side', { skip: SKIP }, async () => {
  assertFailsOnMissingOutput(sawSecond, FAKE_TWO);
  const f = fakes();
  const laid = [];
  try {
    const r = await driveTool({
      script: [{ tool: FAKE }, { tool: FAKE_TWO }], quaude: f.quaude, native: f.native,
      setup: (work) => { fs.writeFileSync(path.join(work, 'fixture.txt'), 'x'); laid.push(work); },
      inspect: (work) => fs.readdirSync(work),
    });
    assert.ok(sawProduct(r.quaude.raw) && sawSecond(r.quaude.raw));
    assert.ok(sawProduct(r.native.raw) && sawSecond(r.native.raw));
    assert.match(r.quaude.text, /PRODUCT-42/, 'text is the FIRST call\'s');
    assert.match(r.quaude.results[FAKE_TWO.id].text, /PRODUCT-15/);
    assert.strictEqual(laid.length, 2);
    assert.strictEqual(laid[0], laid[1], 'both sides run in the same working directory, so paths need no rewriting');
    assert.deepStrictEqual(r.quaude.inspected, ['fixture.txt']);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('driveTool passes a listed switch to both sides', { skip: SKIP }, async () => {
  assertFailsOnMissingOutput(sawProduct, FAKE);
  assert.deepStrictEqual(Object.keys(TOOL_SWITCHES), ['CLAUDE_CODE_ENABLE_TASKS']);
  const f = fakes();
  try {
    const r = await driveTool({ tool: FAKE, quaude: f.quaude, native: f.native, switches: { CLAUDE_CODE_ENABLE_TASKS: 'false' } });
    for (const side of ['quaude', 'native']) {
      assert.ok(sawProduct(r[side].raw));
      assert.match(r[side].text, / tasks=false /, side);
    }
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

const FAKE_NEXT = { name: 'FakeDriverTool', input: { a: 0, b: 2 }, id: 'toolu_fake_driver_next' };
const sawNext = (m) => toolResultText(m, FAKE_NEXT.id).includes('PRODUCT-84');
test('driveTool computes a call\'s input from the log so far (inputFrom), and records what it sent', { skip: SKIP }, async () => {
  assertFailsOnMissingOutput(sawNext, FAKE_NEXT);
  const f = fakes();
  try {
    const fromFirst = (log) => ({ a: Number(/PRODUCT-(\d+)/.exec(toolResultText(log, FAKE.id))[1]), b: 2 });
    const r = await driveTool({ script: [{ tool: FAKE }, { tool: FAKE_NEXT, inputFrom: fromFirst }], quaude: f.quaude, nativeSkip: 'fakes' });
    assert.ok(sawNext(r.quaude.raw), r.quaude.results[FAKE_NEXT.id] && r.quaude.results[FAKE_NEXT.id].text);
    assert.deepStrictEqual(r.quaude.sent[FAKE_NEXT.id], { a: 42, b: 2 });
    assert.deepStrictEqual(r.quaude.sent[FAKE.id], FAKE.input);
    const NOT_FN = 'x';
    assert.throws(() => driveTool({ script: [{ tool: FAKE, inputFrom: NOT_FN }] }), /inputFrom .* must be a function/);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

const FAKE_AGENT = { name: 'FakeDriverTool', input: { prompt: 'answer with SUB-TOKEN-9' }, id: 'toolu_fake_agent_1' };
const sawSubagent = (m) => toolResultText(m, FAKE_AGENT.id).includes('SUBAGENT-SAID SUB-ANSWER-9');
test('driveTool answers an Agent call\'s subagent with its reply, not with the next scripted call', { skip: SKIP }, async () => {
  assertFailsOnMissingOutput(sawSubagent, FAKE_AGENT);
  const f = fakes();
  try {
    const r = await driveTool({ script: [{ tool: FAKE_AGENT, subagent: { prompt: 'SUB-TOKEN-9', reply: 'SUB-ANSWER-9' } }, { tool: FAKE }],
      quaude: f.quaude, nativeSkip: 'fakes' });
    assert.ok(sawSubagent(r.quaude.raw), r.quaude.results[FAKE_AGENT.id] && r.quaude.results[FAKE_AGENT.id].text);
    assert.ok(sawProduct(r.quaude.raw), 'the next scripted call still runs after the subagent');
    assert.throws(() => driveTool({ script: [{ tool: FAKE_AGENT, subagent: { prompt: 'NOT-IN-THE-PROMPT', reply: 'x' } }] }),
      /subagent .* must be \{ prompt, reply \}/);
    assert.throws(() => driveTool({ tool: FAKE, autoModeSeverity: 50.5 }), /autoModeSeverity must be an integer 0-100/);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('driveTool refuses a call that is not a { name, input, id } tool_use', () => {
  const NAMELESS = { name: 'X' };
  assert.throws(() => driveTool({ tool: NAMELESS }), /\{ name, input, id \}/);
  assert.throws(() => driveTool({}), /tool_use/);
  assert.throws(() => driveTool({ script: [{ tool: { name: 'X', input: {}, id: 't_exit' } }, { tool: { name: 'X', input: {}, id: 't_exit_none' } }] }),
    /call id t_exit is inside t_exit_none/, 'an id inside another reads as answered');
  assert.throws(() => driveTool({ tool: FAKE, switches: { CLAUDE_CODE_ENTRYPOINT: 'cli' } }),
    /switches may set only CLAUDE_CODE_ENABLE_TASKS .*not CLAUDE_CODE_ENTRYPOINT/, 'an unlisted switch');
  assert.throws(() => driveTool({ tool: FAKE, switches: { HOME: '/x' } }), /not HOME/, 'a switch is no way round the sandbox');
  for (const k of ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_ENTRYPOINT', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY']) {
    assert.throws(() => driveTool({ tool: FAKE, env: { [k]: '/x' } }), new RegExp(`env may not set ${k}`), k);
  }
});

// The auto-mode classifier's request does not stream: the mock answers it as Messages JSON (cannedMessage), the shape
// 2.1.283 parses `<severity>N` from; measured against native 2026-11-20 (an Agent call in plan mode ran its subagent).
test('the mock answers a { json } reply as Messages JSON, and an SSE string as a stream', async () => {
  const { startMockAnthropic, cannedMessage } = require('./mock-anthropic-helper.cjs');
  const mock = await startMockAnthropic({ respond: (body) => (body.includes('classify') ? cannedMessage('<severity>10', '</severity>') : 'event: x\ndata: {}\n\n') });
  try {
    const post = (text) => fetch(`${mock.url}/v1/messages`, { method: 'POST', body: JSON.stringify({ text }) });
    const j = await post('classify');
    assert.match(j.headers.get('content-type'), /application\/json/);
    assert.deepStrictEqual((await j.json()).content, [{ type: 'text', text: '<severity>10' }]);
    const s = await post('stream');
    assert.match(s.headers.get('content-type'), /text\/event-stream/);
  } finally { await mock.close(); }
});
