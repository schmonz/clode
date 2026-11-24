'use strict';
// The gate inside `scripts/record-provider.mjs`: every native Claude Code a CI job installs is recorded (path, size,
// SHA-256) right after the install, and a job that records an oracle holds it to the record at its end
// (`--verify`), so a native rewritten mid-job (CI 45354661143: a self-update, the first suspect) is a refusal by name.
//
// WHY A GUARD. The script derives a verdict from bytes and refuses, so the production-gate sweep
// (test/guards-population.cjs) counts it gate-shaped; and its value depends on CI calling it after EVERY install: an
// install with no record is an instrument nothing can hold to anything. This is that census, and its control.
//
// THE RULE, over .github/**/*.yml: every `npm i|install` of an @anthropic-ai/claude-code package with -g or --prefix
// is followed within 8 lines by `scripts/record-provider.mjs` (bare for the global provider, `--as NAME` for one
// installed on its own, NAME upper-snake), or has a `no-record: <reason>` comment within the 4 lines before it (a job
// that only carves the bytes and never runs a native). A workflow that records an oracle with --as also runs a bare
// `record-provider.mjs --verify`. The literal relative require below is load-bearing for the population sweep.
const fs = require('node:fs');
const path = require('node:path');
const { defineGuard, guardTests } = require('../guard.cjs');
const { NAME_RE } = require('../../scripts/record-provider.mjs');
const { RECORDED_INSTRUMENTS } = require('../env-indirect.cjs');

const REPO = path.resolve(__dirname, '..', '..');
const INSTALL = /npm (?:i|install)\b(?=.*@anthropic-ai\/claude-code)(?=.*(?:\s-g\b|--prefix\b))/;

function listYml(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listYml(p));
    else if (/\.ya?ml$/.test(e.name)) out.push(p);
  }
  return out;
}

// PURE: files = [{ rel, text }]. `examined` counts the installs judged.
function scan(files, known = RECORDED_INSTRUMENTS) {
  const findings = [];
  let examined = 0;
  for (const { rel, text } of files) {
    const lines = text.split('\n');
    let recordsAs = false;
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/record-provider\.mjs --as (\S+)/g)) {
        recordsAs = true;
        const name = m[1].replace(/^["']|["']$/g, '');
        if (!NAME_RE.test(name)) findings.push(`${rel}:${i + 1}: --as ${name} is not an UPPER_SNAKE name`);
        else if (!known.includes(name)) {
          findings.push(`${rel}:${i + 1}: --as ${name} is not in test/env-indirect.cjs RECORDED_INSTRUMENTS, so its `
            + 'CLODE_*_RECORDED_* variables carry no verdict');
        }
      }
      if (/^\s*#/.test(line) || !INSTALL.test(line)) return;
      examined++;
      if (lines.slice(Math.max(0, i - 4), i).some((l) => /#\s*no-record:\s*\S/.test(l))) return;
      const after = lines.slice(i + 1, i + 9).join('\n');
      const prefix = /--prefix\b/.test(line);
      const ok = prefix ? /record-provider\.mjs --as \S+/.test(after) : /record-provider\.mjs(?!\s+--)/.test(after);
      if (!ok) {
        findings.push(`${rel}:${i + 1}: installs a native Claude Code and records nothing after it `
          + `(${prefix ? 'node scripts/record-provider.mjs --as NAME "$BIN"' : 'node scripts/record-provider.mjs'}), `
          + `so nothing can tell if a test rewrote it: ${line.trim().slice(0, 120)}`);
      }
    });
    if (recordsAs && !/record-provider\.mjs --verify\s*$/m.test(text)) {
      findings.push(`${rel}: records an instrument with --as but never runs \`node scripts/record-provider.mjs --verify\``);
    }
  }
  return { findings, examined, note: `${files.length} workflow/action files` };
}

guardTests(defineGuard({
  name: 'record-provider',
  floor: 15,
  read() {
    return listYml(path.join(REPO, '.github')).map((p) => ({ rel: path.relative(REPO, p).split(path.sep).join('/'),
      text: fs.readFileSync(p, 'utf8') }));
  },
  scan,
  control() {
    // linux-x64-pty's TEXT ORACLE step as it was before the record, and the pin's install without its record line.
    const oracle = [
      '        run: |',
      '          OV=$(node scripts/oracle-native-version.cjs)',
      '          npm i --prefix "$RUNNER_TEMP/oracle" @anthropic-ai/claude-code-linux-x64@"$OV" 2>&1 | tail -2',
      '          ORACLE="$RUNNER_TEMP/oracle/node_modules/@anthropic-ai/claude-code-linux-x64/claude"',
      '          echo "CLODE_NATIVE_ORACLE=$ORACLE" >> "$GITHUB_ENV"',
    ].join('\n');
    const pin = '        run: |\n          npm i -g @anthropic-ai/claude-code@"$V" 2>&1 | tail -3\n          echo done\n';
    const filler = Array.from({ length: 15 }, (_, i) => ({ rel: `f${i}.yml`,
      text: `          npm i -g @anthropic-ai/claude-code@"$V" 2>&1 | tail -3\n          node scripts/record-provider.mjs\n` }));
    return [{ rel: 'oracle.yml', text: oracle }, { rel: 'pin.yml', text: pin }, ...filler];
  },
}));

const test = require('node:test');
const assert = require('node:assert');
test('record-provider census: what it passes over and what it names', () => {
  const ok = (text) => scan([{ rel: 'x.yml', text }]).findings;
  assert.deepStrictEqual(ok('# no-record: carves only\nnpm i -g @anthropic-ai/claude-code@next'), []);
  assert.deepStrictEqual(ok('npm i --prefix "$D" @anthropic-ai/claude-code-linux-x64@1\nnode scripts/record-provider.mjs --as RG_ORACLE "$N"\nnode scripts/record-provider.mjs --verify'), []);
  assert.strictEqual(ok('npm i --prefix "$D" @anthropic-ai/claude-code-linux-x64@1\nnode scripts/record-provider.mjs').length, 1, 'a --prefix install needs --as');
  assert.strictEqual(ok('npm i --prefix "$D" @anthropic-ai/claude-code-linux-x64@1\nnode scripts/record-provider.mjs --as RG_ORACLE "$N"').length, 1, '--as with no --verify');
  assert.strictEqual(ok('npm i --prefix "$D" @anthropic-ai/claude-code-linux-x64@1\nnode scripts/record-provider.mjs --as NEW_ONE "$N"\nnode scripts/record-provider.mjs --verify').length, 1, 'an --as NAME with no verdicts');
  assert.strictEqual(ok('npm i -g @anthropic-ai/claude-code@1\nnode scripts/record-provider.mjs --verify').length, 1, 'a verify is not a record');
  assert.deepStrictEqual(ok('npm ci --prefix deps/claude\nnpm pack "@anthropic-ai/claude-code-linux-x64@1"'), [], 'not an install of a native');
});
