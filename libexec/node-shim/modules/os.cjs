'use strict';
// node:os — M1 surface.
//
// tjs.homeDir and tjs.tmpDir were verified (not just probed) against the
// pinned tjs v26.6.0 binary: `tjs eval 'console.log(typeof tjs.homeDir,
// typeof tjs.tmpDir)'` -> "string string", and both hold real absolute
// paths (tjs.homeDir === "$HOME", tjs.tmpDir === the OS temp dir). So the
// optimistic reads from the plan draft are correct and kept; the
// tjs.env.HOME / tjs.env.TMPDIR reads remain as fallbacks for engines/builds
// where those properties are absent.
module.exports = {
  homedir: () => tjs.homeDir ?? tjs.env.HOME ?? '/',
  tmpdir: () => (tjs.tmpDir ?? tjs.env.TMPDIR ?? '/tmp').replace(/\/$/, ''),
  platform: () => process.platform,
  arch: () => process.arch,
  EOL: '\n',
  userInfo: () => ({ username: tjs.env.USER ?? 'unknown', homedir: module.exports.homedir() }),
};
