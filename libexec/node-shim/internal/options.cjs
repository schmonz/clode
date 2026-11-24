'use strict';
// THE OPTIONS TABLES: for every node-shim entry point a caller hands an options object, each key node reads there is
// HONOURED (applied as node applies it, and a behavioural row proves it) or REFUSED BY NAME (a thrown, coded error
// before any side effect). Nothing else: a key the shim reads past in silence is the class this file exists to end.
//
// THE CLASS, measured 2026-11-22/23 in a live NetBSD turn: child_process.spawnSync ignored `stdio: 'inherit'` (the
// /tui relaunch drew into a pipe: a dead terminal), https.Agent ignored `ca` (an untrusted server accepted). Each
// was a key node reads and the shim did not, with no error, so the divergence was invisible until someone looked.
//
// THE RATCHET is test/options-census.test.cjs: the keys node reads at each entry point are derived from node's own
// source (test/fixtures/options-census-node-derive.cjs, recorded in test/fixtures/options-census-node.json), and a
// key in that list that this table neither honours nor refuses goes red, naming it; so does a key named here that
// node no longer reads. bun-shim keeps the same table for Bun's own option objects (libexec/bun-shim.cjs).
//
// THE SHAPE of an entry:
//   honoured: { key: proof }   proof names the behavioural row that shows the key applied:
//                                'row:<label>'            a row of test/fixtures/options-census-probe.cjs, run under
//                                                         host node and under the shim, answers compared;
//                                'test:<file>::<title>'   an existing test (the census checks that it exists).
//   refused:  { key: why }     refuseOptions() throws ERR_SHIM_UNSUPPORTED_OPTION when the key is set; `inert` (below)
//                              names the values that ask for nothing and so are not refused.
//   exempt:   { key: why }     neither honoured nor refused, because refusing would break a path the bundle takes by
//                              default and honouring is not cheap: each one names its BACKLOG.md entry, and the census
//                              checks the entry exists. A short list, read by a human, never a place to park a key.
//   absent:   why              the shim does not provide the entry point at all, or provides it only as a function that
//                              throws: a call fails loud whatever its options, so there is nothing to census.
//   tls:      true             the https TLS keys are node-shim's https TLS tables' (http.cjs TLS_OPTIONS_HONOURED /
//                              UNSUPPORTED_TLS_OPTIONS, the TLS census in test/node-shim-tls-options.test.cjs).

// The values of a refused key that ask for nothing, so passing them is not refused (node's own defaults).
const INERT = {
  serialization: ['json'], detached: [false], allowHalfOpen: [false], insecureHTTPParser: [false],
  joinDuplicateHeaders: [false], setDefaultHeaders: [true], keepAlive: [false], noDelay: [true],
  autoClose: [true], autoDestroy: [true], flush: [false], info: [false], rejectGarbageAfterEnd: [false],
  manualStart: [false], pauseOnCreate: [false], readable: [false], objectMode: [false], readableObjectMode: [false],
  writableObjectMode: [false], maxCachedSessions: [0], memLevel: [8], strategy: [0],
  windowBits: [0, 15],
};

// CLODE_SHIM_REFUSAL_LOG=<file>: every refusal raised is appended there as a JSON line, whether or not its caller
// swallows the throw. A refusal on the bundle's default path is a bug in the refusal; the suite drives a turn with
// this set and requires the file to stay empty (test/option-refusals-default-path.test.cjs).
function recordRefusal(e) {
  const f = typeof process !== 'undefined' && process.env && process.env.CLODE_SHIM_REFUSAL_LOG;
  if (!f) return;
  try {
    const frames = String(new Error().stack || '').split('\n').slice(2, 8).map((l) => l.trim());
    require('fs').appendFileSync(f, JSON.stringify({ code: e.code, entry: e.entry, option: e.option, pid: process.pid, frames }) + '\n');
  } catch { /* a recorder never changes the outcome */ }
}

function optionError(entry, key, why, code = 'ERR_SHIM_UNSUPPORTED_OPTION') {
  const e = Object.assign(new Error(`node-shim: ${entry} option '${key}' cannot be applied by this engine (${why}); `
    + 'refusing rather than ignoring it'), { code, entry, option: key });
  recordRefusal(e);
  return e;
}

const isSet = (key, v) => v !== undefined && v !== null && !(INERT[key] || []).includes(v);

// Throw the refusal for the first refused key `opts` sets (a non-object opts, e.g. an encoding string, sets none).
function refuseOptions(entry, opts) {
  if (!opts || typeof opts !== 'object') return;
  const t = TABLES[entry];
  if (!t || !t.refused) return;
  for (const [key, why] of Object.entries(t.refused)) {
    if (isSet(key, opts[key])) throw optionError(entry, key, why, t.code);
  }
}

const row = (label) => `row:${label}`;
const T = (file, title) => `test:${file}::${title}`;

// ---- child_process ------------------------------------------------------------------------------------------------
const SPAWN = {
  honoured: {
    argv0: row('spawn.argv0'), cwd: row('spawn.cwd'), detached: row('spawn.detached'), env: row('spawn.env'),
    gid: row('spawn.gid'), killSignal: row('spawn.killSignal'), shell: row('spawn.shell'), signal: row('spawn.signal'),
    stdio: row('spawn.stdio'), timeout: row('spawn.timeout'), uid: row('spawn.uid'),
    windowsHide: row('spawn.windowsHide'), windowsVerbatimArguments: row('spawn.windowsVerbatimArguments'),
  },
  refused: { serialization: 'there is no IPC channel (stdio \'ipc\' is refused), so there is nothing to serialize' },
};
const SPAWNSYNC = {
  honoured: {
    argv0: row('spawnSync.argv0'), cwd: T('node-shim-child-process.test.cjs', 'spawnSync: cwd matches node'),
    encoding: row('spawnSync.encoding'), env: T('node-shim-child-process.test.cjs', 'spawnSync: env passthrough matches node'),
    input: T('node-shim-child-process.test.cjs', 'spawnSync: stdin input echoes like node'),
    killSignal: row('spawnSync.killSignal'),
    maxBuffer: T('node-shim-child-process.test.cjs', 'spawnSync: maxBuffer overrun surfaces'), shell: row('spawnSync.shell'),
    stdio: T('node-shim-child-process.test.cjs', 'spawnSync: stdio inherit reaches the PARENT'),
    timeout: T('node-shim-child-process.test.cjs', 'spawnSync: timeout kills and reports like node'),
    windowsHide: row('spawnSync.windowsHide'), windowsVerbatimArguments: row('spawnSync.windowsVerbatimArguments'),
  },
  refused: {
    detached: 'the synchronous spawner (posix_spawn, fork/exec, CreateProcess) starts no new session',
    uid: 'the synchronous spawner cannot change the child\'s user', gid: 'the synchronous spawner cannot change the child\'s group',
  },
};
const EXECFILE = {
  honoured: {
    cwd: row('execFile.cwd'), encoding: row('execFile.encoding'), env: row('execFile.env'), gid: row('spawn.gid'),
    killSignal: row('execFile.killSignal'), maxBuffer: row('execFile.maxBuffer'), shell: row('execFile.shell'),
    signal: row('execFile.signal'), timeout: row('execFile.timeout'), uid: row('spawn.uid'),
    windowsHide: row('spawn.windowsHide'), windowsVerbatimArguments: row('spawn.windowsVerbatimArguments'),
  },
  refused: {},
};

// ---- http / https -------------------------------------------------------------------------------------------------
const NO_SOCKET_OPTION = 'every connection is the engine\'s own tjs.connect, which takes no such socket option';
const HTTP_REQUEST = {
  code: 'ERR_SHIM_HTTP_UNSUPPORTED_OPTION',   // the code this client's refusals carried before the census
  honoured: {
    agent: row('http.request.agent'), auth: row('http.request.auth'), autoSelectFamily: T('node-shim-connect-multiple.test.cjs', 'family 4/6 and autoSelectFamily:false make ONE attempt'),
    autoSelectFamilyAttemptTimeout: T('node-shim-connect-multiple.test.cjs', 'an attempt that hangs past the attempt timeout'),
    defaultPort: row('http.request.defaultPort'), family: T('node-shim-connect-multiple.test.cjs', 'family 4/6 and autoSelectFamily:false make ONE attempt'),
    headers: row('http.request.headers'), host: row('http.request.host'), hostname: row('http.request.hostname'),
    lookup: row('http.request.lookup'),
    method: row('http.request.method'), path: row('http.request.path'), port: row('http.request.port'),
    protocol: row('http.request.protocol'), setHost: row('http.request.setHost'), signal: row('http.request.signal'),
    timeout: row('http.request.timeout'),
  },
  refused: {
    createConnection: 'this client always connects with tjs.connect; net.connect/createConnection are unimplemented',
    socketPath: 'tjs.connect dials TCP only (no unix-domain socket)',
    localAddress: NO_SOCKET_OPTION, localPort: NO_SOCKET_OPTION, hints: 'the engine resolves names itself (no getaddrinfo hints)',
    blockList: NO_SOCKET_OPTION, fd: NO_SOCKET_OPTION, handle: NO_SOCKET_OPTION, onread: NO_SOCKET_OPTION,
    manualStart: NO_SOCKET_OPTION, pauseOnCreate: NO_SOCKET_OPTION, readable: NO_SOCKET_OPTION, allowHalfOpen: NO_SOCKET_OPTION,
    objectMode: 'the response is a byte stream', readableObjectMode: 'the response is a byte stream',
    writableObjectMode: 'the request is a byte stream', typeOfService: NO_SOCKET_OPTION,
    keepAlive: 'the request\'s own socket keep-alive (the agent\'s is applied); tjs.connect takes it only from the agent',
    keepAliveInitialDelay: NO_SOCKET_OPTION, noDelay: 'every connection is opened with TCP_NODELAY (node\'s default)',
    highWaterMark: 'the response stream\'s buffering is the shim\'s own', insecureHTTPParser: 'the shim\'s parser is strict',
    joinDuplicateHeaders: 'duplicate response headers are kept as the shim parses them',
    maxHeaderSize: 'the shim\'s parser has no header-size limit to set', uniqueHeaders: 'no per-header joining rule',
    setDefaultHeaders: 'the shim always sets Host (setHost) and Connection itself',
    httpValidation: 'the shim validates nothing it could be told not to',
  },
};
const HTTPS_REQUEST = {
  code: HTTP_REQUEST.code,
  tls: true,
  honoured: { ...HTTP_REQUEST.honoured },
  refused: { ...HTTP_REQUEST.refused, socket: 'tjs.connect(\'tls\') always makes its own connection; it cannot start TLS over a socket' },
};
const POOLING = 'BACKLOG.md "node-shim http has no connection pool": every request is its own connection (Connection: close); '
  + 'refusing would break the agents the bundle builds by default (keepAlive: true, maxSockets: 50/1), and a pool is not cheap';
// An agent's options are merged into every connection it makes (node's createSocket: the agent's win), so it takes
// net.connect's keys too: those the request honours from its agent are honoured, the socket options it cannot apply
// are refused as the request refuses them, and an agent-wide host, port, timeout or signal is refused.
const SOCKET_KEYS = ['allowHalfOpen', 'blockList', 'fd', 'handle', 'hints', 'keepAliveInitialDelay', 'localAddress', 'localPort',
  'manualStart', 'objectMode', 'onread', 'pauseOnCreate', 'readable', 'readableObjectMode', 'typeOfService', 'writableObjectMode'];
const AGENT_WIDE = 'an agent-wide connection setting this client does not apply; give it on the request';
const HTTP_AGENT = {
  honoured: {
    defaultPort: row('http.Agent.defaultPort'), protocol: row('http.Agent.protocol'),
    proxyEnv: T('node-shim-http-proxy.test.cjs', 'proxy credentials, NO_PROXY, the disable flag, agents and socks'),
    family: row('http.Agent.connect'), autoSelectFamily: row('http.Agent.connect'),
    autoSelectFamilyAttemptTimeout: row('http.Agent.connect'), lookup: row('http.Agent.connect'),
    timeout: row('http.Agent.timeout'),
  },
  refused: {
    noDelay: 'every connection is opened with TCP_NODELAY (node\'s default)',
    ...Object.fromEntries(SOCKET_KEYS.map((k) => [k, HTTP_REQUEST.refused[k]])),
    host: AGENT_WIDE, port: AGENT_WIDE, signal: AGENT_WIDE,
  },
  exempt: {
    keepAlive: POOLING, keepAliveMsecs: POOLING, maxSockets: POOLING, maxFreeSockets: POOLING, maxTotalSockets: POOLING,
    scheduling: POOLING, agentKeepAliveTimeoutBuffer: POOLING,
  },
};
const HTTPS_AGENT = {
  tls: true,
  honoured: { ...HTTP_AGENT.honoured },
  refused: { ...HTTP_AGENT.refused, maxCachedSessions: 'there is no TLS session cache (0, none, asks for nothing)',
    highWaterMark: HTTP_REQUEST.refused.highWaterMark, path: AGENT_WIDE,
    socket: 'tjs.connect(\'tls\') always makes its own connection; it cannot start TLS over a socket' },
  exempt: { ...HTTP_AGENT.exempt },
};

// ---- fs -----------------------------------------------------------------------------------------------------------
const NO_FSYNC = 'BACKLOG.md "node-shim fs has no fsync": the bytes are written, but the durability barrier (fsync) is the '
  + 'shim\'s documented no-op fsyncSync; refusing would fail the bundle\'s own flush:true writes (17 sites in 2.1.330), '
  + 'and honouring it is an engine primitive';
const READ_FILE = {
  honoured: { encoding: row('fs.readFile.encoding'), flag: row('fs.readFile.flag') },
  refused: { buffer: 'node\'s read-into-a-caller-buffer option has no route here' },
};
// node's callback readFile takes no `buffer` (its promise form and readFileSync do)
const READ_FILE_CB = {
  honoured: { ...READ_FILE.honoured, signal: row('fs.readFile.signal') },
  refused: {},
};
const READ_FILE_ASYNC = {
  honoured: { ...READ_FILE.honoured, signal: row('fs.readFile.signal') },
  refused: { ...READ_FILE.refused },
};
const WRITE_FILE = {
  honoured: { encoding: row('fs.writeFile.encoding'), flag: row('fs.writeFile.flag'), mode: row('fs.writeFile.mode') },
  refused: {},
  exempt: { flush: NO_FSYNC },
};
const WRITE_FILE_ASYNC = {
  honoured: { ...WRITE_FILE.honoured, signal: row('fs.writeFile.signal') },
  refused: { ...WRITE_FILE.refused },
  exempt: { ...WRITE_FILE.exempt },
};
const MKDIR = {
  honoured: { mode: T('node-shim-fs-2-1-330.test.cjs', 'fs answers 2.1.330 reaches for'), recursive: row('fs.mkdir.recursive') },
  refused: {},
};
const RM = {
  honoured: { force: row('fs.rm.force'), recursive: row('fs.rm.recursive'), maxRetries: row('fs.rm.maxRetries'),
    retryDelay: row('fs.rm.maxRetries') },
  refused: {},
};
const CP = {
  honoured: {
    dereference: row('fs.cp.dereference'), errorOnExist: row('fs.cp.errorOnExist'), filter: row('fs.cp.filter'),
    force: row('fs.cp.force'), mode: row('fs.cp.mode'), preserveTimestamps: row('fs.cp.preserveTimestamps'),
    recursive: row('fs.cp.recursive'), verbatimSymlinks: row('fs.cp.verbatimSymlinks'),
  },
  refused: {},
};
const WATCH_STUB = 'BACKLOG.md "fs.watch is a never-firing stub": the whole function is a stub (test/fidelity RECIPE C7), '
  + 'and refusing its options would turn the settings/keybindings watchers chokidar builds by default into thrown errors';
const OWN_FILE = 'the stream reads or writes a path or a descriptor; a caller\'s fs implementation or Windows handle has no route here';
const STREAM_COMMON = {
  autoClose: row('fs.stream.autoClose'), start: row('fs.stream.start'),
};

const TABLES = {
  'child_process.spawn': SPAWN,
  'child_process.spawnSync': SPAWNSYNC,
  'child_process.execFileSync': SPAWNSYNC,
  'child_process.execSync': SPAWNSYNC,
  'child_process.execFile': EXECFILE,
  'child_process.exec': EXECFILE,
  'child_process.fork': { absent: 'node-shim provides no fork (there is no IPC channel); child_process.fork is undefined' },

  'http.request': HTTP_REQUEST,
  'https.request': HTTPS_REQUEST,
  'http.Agent': HTTP_AGENT,
  'https.Agent': HTTPS_AGENT,
  'net.connect': { absent: 'net.connect/createConnection throw a branded wall (libexec/node-shim/modules/net.cjs)' },
  'tls.connect': { absent: 'tls.connect throws a branded wall (libexec/node-shim/modules/tls.cjs SOCKET_API)' },

  'fs.readFileSync': READ_FILE,
  'fs.readFile': READ_FILE_CB,
  'fs.promises.readFile': READ_FILE_ASYNC,
  'fs.writeFileSync': WRITE_FILE,
  'fs.writeFile': WRITE_FILE_ASYNC,
  'fs.promises.writeFile': WRITE_FILE_ASYNC,
  'fs.mkdirSync': MKDIR,
  'fs.mkdir': MKDIR,
  'fs.promises.mkdir': MKDIR,
  'fs.rmSync': RM,
  'fs.rm': RM,
  'fs.promises.rm': RM,
  'fs.cpSync': CP,
  'fs.cp': CP,
  'fs.promises.cp': CP,
  'fs.watch': {
    honoured: {},
    refused: {},
    exempt: {
      encoding: WATCH_STUB, ignore: WATCH_STUB, maxQueue: WATCH_STUB, overflow: WATCH_STUB, persistent: WATCH_STUB,
      recursive: WATCH_STUB, signal: WATCH_STUB, throwIfNoEntry: WATCH_STUB,
    },
  },
  'fs.createReadStream': {
    honoured: { ...STREAM_COMMON, end: row('fs.createReadStream.end'), highWaterMark: row('fs.createReadStream.highWaterMark'),
      autoDestroy: row('fs.stream.autoClose'), flags: row('fs.createReadStream.flags'), mode: row('fs.createReadStream.flags'),
      fd: row('fs.createReadStream.fd') },
    refused: { fs: OWN_FILE, windowsHandle: OWN_FILE },
  },
  'fs.createWriteStream': {
    honoured: { ...STREAM_COMMON, encoding: row('fs.createWriteStream.encoding'), flags: row('fs.createWriteStream.flags'),
      mode: row('fs.createWriteStream.mode'), autoDestroy: row('fs.stream.autoClose'), fd: row('fs.createWriteStream.fd') },
    refused: { fs: OWN_FILE, windowsHandle: OWN_FILE },
    exempt: { flush: NO_FSYNC },
  },

  // zlib: the one-shot helpers (gzipSync, inflate, ...) and the decompressing streams (createGunzip, ...) take these
  'zlib.zlib': {
    honoured: {
      level: T('node-shim-zlib-sync.test.cjs', 'zlib one-shot helpers: quaude and node read each other'),
      encoding: row('zlib.encoding'), objectMode: row('zlib.encoding'), writableObjectMode: row('zlib.encoding'),
      flush: row('zlib.flush'), finishFlush: row('zlib.finishFlush'), chunkSize: row('zlib.chunkSize'),
      maxOutputLength: row('zlib.maxOutputLength'),
    },
    refused: {
      dictionary: 'the engine\'s deflate/inflate take no preset dictionary',
      info: 'the one-shot helpers return the buffer only',
      memLevel: 'the engine\'s deflate takes a level only', strategy: 'the engine\'s deflate takes a level only',
      windowBits: 'the engine\'s formats fix their window', rejectGarbageAfterEnd: 'the engine stops at the end of the first member',
    },
  },
  'zlib.brotli': { absent: 'node-shim has no brotli at all (zlib.cjs: deliberately absent, not present-and-throwing)' },
};

// fs.open's flag strings (fs.open/openSync, and the `flag`/`flags` of readFile, writeFile and the streams): the census
// keys are node's own flag strings (stringToFlags); fs.cjs STRING_FLAGS must map every one of them.
// The read-and-append family (the bundle opens its session transcript O_RDWR|O_APPEND by default, reads it and
// appends): fs.cjs pairs the engine's write-only append open with a read-only descriptor (openPath).
TABLES['fs.open:flags'] = {
  honoured: {
    ...Object.fromEntries(['r', 'rs', 'sr', 'r+', 'rs+', 'sr+', 'w', 'wx', 'xw', 'w+', 'wx+', 'xw+', 'a', 'ax', 'xa', 'as', 'sa']
      .map((f) => [f, row('fs.open.flags')])),
    ...Object.fromEntries(['a+', 'ax+', 'xa+', 'as+', 'sa+'].map((f) => [f, row('fs.open.readAppend')])),
  },
  refused: {},
};
module.exports = {
  recordRefusal, TABLES, INERT, refuseOptions, optionError, isSet };
