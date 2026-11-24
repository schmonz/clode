'use strict';
// The node-shim internals fs.cjs requires, for a test that loads fs.cjs in a vm sandbox with a stand-in engine
// (test/procfs-linux-only.test.cjs, test/win-fs-rename-guard.test.cjs): engine-constants is host node's tables
// (the stand-in for the engine's), and node-errors (which reshapes the engine's errors as node's) is the real one,
// loaded in the same sandbox so it reads those tables. Call it after vm.createContext(sandbox); its result is the
// sandbox's `require`. internal/options.cjs (the options census's tables) is engine-free and loads as is.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const NODE_ERRORS = path.join(__dirname, '..', 'libexec', 'node-shim', 'internal', 'node-errors.cjs');
function hostEngineConstants() {
  return {
    REQUIRED_ABI: 1, fs: fs.constants, signals: os.constants.signals, errno: os.constants.errno,
    dlopen: os.constants.dlopen, priority: os.constants.priority, UV_UDP_REUSEADDR: os.constants.UV_UDP_REUSEADDR,
  };
}
function shimRequire(sandbox, engineConstants = hostEngineConstants()) {
  const nodeErrors = { exports: {} };
  const req = (id) => {
    if (/engine-constants\.cjs$/.test(String(id))) return engineConstants;
    if (/node-errors\.cjs$/.test(String(id))) return nodeErrors.exports;
    // the options tables are plain data and a pure check, the same in any engine
    if (/internal\/options\.cjs$/.test(String(id))) return require(path.join(__dirname, '..', 'libexec', 'node-shim', 'internal', 'options.cjs'));
    return require(id);
  };
  vm.runInContext(`(function (module, exports, require) {\n${fs.readFileSync(NODE_ERRORS, 'utf8')}\n})`, sandbox, { filename: 'node-errors.cjs' })(nodeErrors, nodeErrors.exports, req);
  return req;
}
module.exports = { shimRequire, hostEngineConstants };
