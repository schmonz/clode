'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { shouldInjectGuard, SUBCOMMANDS } = require('../libexec/update-guard.cjs');

test('shouldInjectGuard: default/model command injects, subcommands skip', () => {
  assert.strictEqual(shouldInjectGuard([]), true, 'interactive default');
  assert.strictEqual(shouldInjectGuard(['-p', 'do a thing']), true, '-p headless');
  assert.strictEqual(shouldInjectGuard(['--print']), true, '--print');
  assert.strictEqual(shouldInjectGuard(['--debug', '-p', 'x']), true, 'bool flag then -p');
  assert.strictEqual(shouldInjectGuard(['fix the remote-control bug']), true, 'multi-word prompt');
  assert.strictEqual(shouldInjectGuard(['remote-control']), false, 'remote-control subcommand');
  assert.strictEqual(shouldInjectGuard(['rc']), false, 'remote-control alias');
  assert.strictEqual(shouldInjectGuard(['doctor']), false, 'doctor subcommand');
  assert.strictEqual(shouldInjectGuard(['mcp', 'add', 'x']), false, 'nested subcommand keyword first');
  assert.strictEqual(shouldInjectGuard(['--verbose', 'remote-control']), false, 'bool flag then subcommand');
});

// I1 (grep-native sandbox round 3): an option's VALUE is not a subcommand. The bundle's own rule decides which tokens
// are values (libexec/update-guard.cjs's tables, gated against the carve by test/guard-subcommands-gate.test.cjs).
// Each row was measured on native 2.1.283 with `--help` after it: the root help means the model command.
test('shouldInjectGuard: an option value that spells a subcommand is a value, not the subcommand (I1)', () => {
  assert.strictEqual(shouldInjectGuard(['--add-dir', 'config']), true, '--add-dir takes `config` (interactive)');
  assert.strictEqual(shouldInjectGuard(['--add-dir', 'a', 'config']), true, '--add-dir is variadic: up to the next flag');
  assert.strictEqual(shouldInjectGuard(['--model', 'doctor']), true, '--model takes a value');
  assert.strictEqual(shouldInjectGuard(['--settings', 'update']), true, '--settings takes a value');
  assert.strictEqual(shouldInjectGuard(['--debug', 'remote-control']), true,
    '--debug [filter]: an optional value is taken when it is not a flag (native: root help)');
  assert.strictEqual(shouldInjectGuard(['--project-config-root', 'config']), true,
    'a commander root option missing from the eager scanner (native: root help)');
  assert.strictEqual(shouldInjectGuard(['--debug', '--verbose', 'doctor']), false, 'an optional value never takes a flag');
  assert.strictEqual(shouldInjectGuard(['--add-dir', 'a', '--verbose', 'mcp']), false, 'variadic stops at a flag');
  assert.strictEqual(shouldInjectGuard(['--add-dir=config', 'doctor']), false, '--opt=value is one token');
  assert.strictEqual(shouldInjectGuard(['--', 'doctor']), false, 'after `--` the next token is the positional');
  assert.strictEqual(shouldInjectGuard(['--system-prompt', '-p']), true,
    'a value option takes its next token even when it looks like a flag');
  assert.strictEqual(shouldInjectGuard(['--append-system-prompt', '--print', 'doctor']), false,
    '`--print` here is --append-system-prompt\'s value, not the print flag');
});

test('SUBCOMMANDS contains the reported case and its alias', () => {
  assert.ok(SUBCOMMANDS.has('remote-control'));
  assert.ok(SUBCOMMANDS.has('rc'));
});

test('bridge-spawned model sessions ARE guarded (they carry --print)', () => {
  // A Remote Control bridge is a non-model server (skipped, above), but when a
  // phone/claude.ai starts coding, the bridge spawns a model session via the
  // quaude binary with `--print --sdk-url … --session-id … --input-format
  // stream-json`. That spawn re-enters quaude-bootstrap step 7.6, and --print
  // must make shouldInjectGuard return true so the update-guard covers the
  // model session (which CAN run Bash). This locks that coverage.
  const spawnArgv = ['--print', '--sdk-url', 'wss://bridge.example', '--session-id',
    'cse_abc', '--input-format', 'stream-json', '--output-format', 'stream-json'];
  assert.strictEqual(shouldInjectGuard(spawnArgv), true);
  // --print wins even if a subcommand-like token precedes it (defensive).
  assert.strictEqual(shouldInjectGuard(['rc', '--print', 'x']), true);
});

// C1 (grep-native sandbox round 3): the user's own --settings is merged with quaude's, not discarded. The rule is the
// bundle's (libexec/update-guard.cjs, "THE USER'S --settings"); every literal below was measured on native 2.1.283.
const ug = require('../libexec/update-guard.cjs');
const OURS = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '"/q" --clode-update-guard' }] }] },
  sandbox: { failIfUnavailable: true } };

test('findSettingsArgs: both spellings, the last wins, never after `--` or as another option\'s value', () => {
  assert.deepStrictEqual(ug.findSettingsArgs(['-p', 'x']), null);
  assert.deepStrictEqual(ug.findSettingsArgs(['--settings', 'a.json']), { value: 'a.json', at: [[0, 2]] });
  assert.deepStrictEqual(ug.findSettingsArgs(['--settings=a.json', '-p', 'x', '--settings', 'b.json']),
    { value: 'b.json', at: [[0, 1], [3, 2]] }, 'native measured: the last --settings applies');
  assert.deepStrictEqual(ug.findSettingsArgs(['--', '--settings', 'a.json']), null, 'after `--` it is a prompt');
  assert.deepStrictEqual(ug.findSettingsArgs(['--system-prompt', '--settings', 'x']), null, '--system-prompt takes `--settings`');
  assert.deepStrictEqual(ug.findSettingsArgs(['-p', 'x', '--settings']), null, 'a dangling --settings has no value');
  assert.deepStrictEqual(ug.findSettingsArgs(['--settings=']), { value: '', at: [[0, 1]] });
});

test('settingsIsInline: the bundle\'s rule (trimmed, starts with { and ends with }), else a file path', () => {
  assert.strictEqual(ug.settingsIsInline('{"a":1}'), true);
  assert.strictEqual(ug.settingsIsInline('  {"a":1}\n'), true);
  assert.strictEqual(ug.settingsIsInline('{"sandbox": }'), true, 'invalid JSON is still inline: native "Invalid JSON provided"');
  assert.strictEqual(ug.settingsIsInline('[1]'), false, 'native: "Settings file not found: [1]"');
  assert.strictEqual(ug.settingsIsInline('settings.json'), false);
});

test('mergeSettings: objects merge, arrays concatenate (the user\'s PreToolUse kept, quaude\'s added), quaude\'s scalars win', () => {
  const user = { env: { A: '1' }, permissions: { deny: ['Bash(rm:*)'] },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'mine' }] }], Stop: [{ hooks: [] }] },
    sandbox: { enabled: true, failIfUnavailable: false } };
  const m = ug.mergeSettings(user, OURS);
  assert.deepStrictEqual(m.env, { A: '1' });
  assert.deepStrictEqual(m.permissions, { deny: ['Bash(rm:*)'] });
  assert.deepStrictEqual(m.hooks.PreToolUse.map((h) => h.hooks[0].command), ['mine', '"/q" --clode-update-guard']);
  assert.deepStrictEqual(m.hooks.Stop, [{ hooks: [] }]);
  assert.deepStrictEqual(m.sandbox, { enabled: true, failIfUnavailable: true });
  assert.deepStrictEqual(user.hooks.PreToolUse.length, 1, 'the user\'s object is not mutated');
});

test('planGuardSettings: merge what the bundle reads; hand it what it refuses, unchanged; skip what it skips, saying so', () => {
  const plan = (argv, fileText) => ug.planGuardSettings(ug.findSettingsArgs(argv), fileText, OURS);
  assert.deepStrictEqual(plan(['-p', 'x']), { settings: OURS, warning: null }, 'no user --settings');
  assert.deepStrictEqual(plan(['--settings=']), { settings: OURS, warning: null }, 'an empty value loads nothing (native)');
  const inl = plan(['--settings', '{"env":{"A":"1"}}']);
  assert.deepStrictEqual(inl.settings.env, { A: '1' });
  assert.strictEqual(inl.settings.hooks.PreToolUse.length, 1);
  assert.deepStrictEqual(plan(['--settings', '{"sandbox": }']), { passthrough: true }, 'native: "Error: Invalid JSON provided to --settings", rc 1');
  assert.deepStrictEqual(plan(['--settings', 'nope.json'], null), { passthrough: true }, 'native: "Error: Settings file not found", rc 1');
  assert.deepStrictEqual(plan(['--settings', 'f.json'], '{"env":{"B":"2"}}').settings.env, { B: '2' });
  const bom = String.fromCharCode(0xfeff);
  assert.deepStrictEqual(plan(['--settings', 'f.json'], `${bom}{"env":{"B":"2"}}`).settings.env, { B: '2' }, 'a BOM is dropped');
  assert.deepStrictEqual(plan(['--settings', 'f.json'], ' \n').settings, OURS, 'an empty file is {} (native: loaded, empty)');
  const skipped = plan(['--settings', 'f.json'], '{"sandbox": ');
  assert.deepStrictEqual(skipped.settings, OURS, 'native skips a file that does not parse and runs on');
  assert.match(skipped.warning, /--settings file f\.json is not a JSON object.*none of its settings apply/);
  assert.deepStrictEqual(plan(['--settings', 'f.json'], '[1]').settings, OURS, 'not an object: skipped');
});

test('withSettingsArg: ONE --settings, where the user\'s last one was, else before `--`, else at the end', () => {
  const w = (argv) => ug.withSettingsArg(argv, ug.findSettingsArgs(argv), 'G');
  assert.deepStrictEqual(w(['-p', 'x']), ['-p', 'x', '--settings', 'G']);
  assert.deepStrictEqual(w(['--add-dir', 'config', '--', 'hi']), ['--add-dir', 'config', '--settings', 'G', '--', 'hi']);
  assert.deepStrictEqual(w(['--system-prompt', '--', '-p', 'x']), ['--system-prompt', '--', '-p', 'x', '--settings', 'G'],
    'a `--` that is an option\'s value does not end options');
  assert.deepStrictEqual(w(['--settings=a', '-p', 'x', '--settings', 'b', '--verbose']), ['-p', 'x', '--settings', 'G', '--verbose']);
});

test('decodeSettingsBytes: UTF-16LE after FF FE, else UTF-8 (the bundle\'s encoding sniff)', () => {
  const u16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{"a":1}', 'utf16le')]);
  assert.strictEqual(ug.decodeSettingsBytes(u16), '{"a":1}');
  assert.strictEqual(ug.decodeSettingsBytes(Buffer.from('{"a":1}')), '{"a":1}');
});
