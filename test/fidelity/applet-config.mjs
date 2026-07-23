// test/fidelity/applet-config.mjs
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const hosttools = require('../../libexec/clode-hosttools.cjs');

export function appletTempDir(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clode-applets-'));
  // On Windows an extensionless stub is undiscoverable BY DESIGN: findTool honors
  // PATHEXT, so it probes rg.COM/.EXE/.BAT/.CMD and never a bare `rg`. Give the
  // stub a PATHEXT-carrying name and batch content there, a shebang script
  // elsewhere — otherwise the applet axis silently "finds nothing" on Windows.
  const win = process.platform === 'win32';
  for (const name of ['rg', 'ugrep', 'bfs']) {
    if (config[name]) {
      const p = path.join(dir, win ? `${name}.cmd` : name);
      fs.writeFileSync(p, win ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n');
      fs.chmodSync(p, 0o755);
    }
  }
  return dir;
}

export function appletEnv(config, baseEnv = process.env) {
  const dir = appletTempDir(config);
  return { ...baseEnv, PATH: dir + path.delimiter + (baseEnv.PATH || '') };
}

export function discovered(name, env) {
  return hosttools.findTool(name, { env });
}
