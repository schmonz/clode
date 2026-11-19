'use strict';
// HOW each inventoried API is called. The inventory (test/shim-surface/call-sites.cjs, read from the
// carve) says WHICH APIs the bundle calls and WITH WHICH ARGUMENT SHAPES; this table only says what
// to put where the carve passes an expression the scan cannot read, and how to describe what comes
// back. It never decides which APIs are judged: an inventoried API with no driver here, and no reason
// in UNCOVERED, is a finding of the gate (test/node-shim-differential.test.cjs).
//
// A driver:
//   args   the KIND of each argument position (the carve's shape is cut to this length; a callback
//          is added by the `callback` style, not listed). Kinds are sampled from SAMPLES below.
//   style  sync | promise | callback | new | value; default from the name (fs/promises.* promise,
//          fs.*Sync sync, other fs.* callback, everything else sync).
//   post   how to describe the result (exec.cjs post()): fd, filehandle, readstream, writestream,
//          dir, close, sorted, typeof, keys, sign, tmpname; default show().
//   mutates  the call changes the tree: each side runs it in a fresh tree of its own and the tree is
//          compared afterwards.
//   paths  the fixtures a `path` argument takes (default READ_PATHS; a FIFO blocks any open-for-read).
//   keys   per-driver samples for option keys the carve passes as expressions.
//   extra  hand-picked argument lists, ADDED to the carve's shapes (never instead of them).
//   addition  set (with a reason) on a driver for an API the carve does not call: hand-picked.
//   only   the carve platforms that call it (one upstream version carves differently per platform);
//          elsewhere its absence from the inventory is expected. UNCOVERED entries may be
//          { why, only } for the same reason.

const READ_PATHS = ['file', 'empty', 'dir', 'emptydir', 'symlink', 'dirlink', 'dangling', 'missing', 'notdir'];
const STAT_PATHS = [...READ_PATHS, 'fifo', { abs: '/dev/null' }];

// Samples for an argument KIND, used where the carve passes an expression.
const SAMPLES = {
  path: READ_PATHS.map((p) => ({ path: p })),
  statpath: STAT_PATHS.map((p) => (typeof p === 'string' ? { path: p } : p)),
  dest: ['new', 'file', 'emptydir', 'dir', 'missing/x'].map((p) => ({ path: p })),
  newpath: ['new', 'file', 'dir', 'missing/x'].map((p) => ({ path: p })),
  data: [{ v: 'data\n' }, { buf: '00ff0a' }, { v: '' }],
  fdr: [{ fd: 'file:r' }, { fd: 'dir:r' }, { fd: 'bad' }],
  fdw: [{ fd: 'file:r+' }, { fd: 'file:r' }, { fd: 'bad' }, { fd: 'brokenpipe' }],
  fdany: [{ fd: 'file:r' }, { fd: 'file:r+' }, { fd: 'bad' }],
  buffer: [{ buf: '0000000000000000' }],
  offset: [{ v: 0 }, { v: 2 }],
  length: [{ v: 8 }, { v: 3 }],
  position: [{ v: null }, { v: 0 }, { v: 6 }],
  mode: [{ v: 384 }, { v: 493 }],
  flags: [{ v: 'r' }, { v: 'w' }, { v: 'wx' }, { v: 'a' }, { v: 'r+' }],
  enc: [{ v: 'utf8' }, { v: 'base64' }, { v: 'hex' }],
  opts: [{ undef: true }],
  any: [{ undef: true }],
  prefix: [{ path: 'tmp-' }, { path: 'missing/tmp-' }],
  time: [{ v: 1000 }, { v: 1700000000.5 }],
  target: [{ v: 'file' }, { v: 'nowhere' }, { v: '../x' }],
  len: [{ v: 0 }, { v: 3 }],
  int: [{ v: 0 }],
  pathstr: ['', '.', '..', '/', 'a', 'a/b', '/a/b/', 'a//b/../c', './a/./b', '/a/b.c.d', '.hidden', 'a/b.',
    '~/x', 'C:\\a\\b', '/a/b/c.txt', 'file:///x', 'a/b/', '/..', 'x.tar.gz'].map((v) => ({ v })),
  ext: [{ v: '.txt' }, { v: '.gz' }, { v: '' }],
  ip: ['127.0.0.1', '::1', '1.2.3', '256.1.1.1', '::ffff:127.0.0.1', 'fe80::1%en0', '', 'localhost', '01.2.3.4', '2001:db8::'].map((v) => ({ v })),
  fd0: [{ v: 0 }, { v: 1 }, { v: 2 }, { v: 99 }, { v: -1 }],
  errno: [{ v: -2 }, { v: -13 }, { v: -32 }, { v: -9999 }],
  fmt: ['%s', '%d', '%i', '%f', '%j', '%o', '%O', '%%', 'a %s b %d', '%c', 'plain', ''].map((v) => ({ v })),
  fmtarg: [{ v: 'str' }, { v: 42 }, { v: 1.5 }, { obj: { a: { v: 1 }, b: { v: 'x' } } }, { arr: [{ v: 1 }, { v: 'two' }] }, { v: null }, { undef: true }],
  value: [{ v: 1 }, { v: 'a' }, { obj: { a: { v: 1 } } }, { arr: [{ v: 1 }, { v: 2 }] }, { v: null }, { undef: true }, { obj: { a: { arr: [{ v: 1 }] } } }],
  vtstr: ['\u001b[31mred\u001b[0m', 'plain', '\u001b]8;;http://x\u0007link\u001b]8;;\u0007', '\u001b[1;2H', 'a\u009b31mb'].map((v) => ({ v })),
};

// Option values for keys the carve passes as an expression, shared by every driver unless the
// driver's own `keys` says otherwise. A key the carve passes as an expression with no sample here
// is a finding: it means the carve exercises an option the harness cannot.
const KEY_SAMPLES = {
  encoding: { v: 'utf8' },
  flag: { v: 'w' },
  flags: { v: 'w' },
  mode: { v: 384 },
  recursive: { v: true },
  maxRetries: { v: 0 },
  signal: { signal: true },
  end: { v: 3 },
  persistent: { v: false },
  // child_process
  cwd: { cwd: true },
  env: { env: true },
  detached: { v: false },
  shell: { v: false },
  stdio: { v: 'pipe' },
  timeout: { v: 10000 },
  input: { v: 'input\n' },
  killSignal: { v: 'SIGTERM' },
  maxBuffer: { v: 1048576 },
  windowsVerbatimArguments: { v: false },
  argv0: { v: 'argv0-name' },
  // net
  host: { v: '127.0.0.1' },
  port: { v: 1 },
  path: { v: '/nonexistent/diff.sock' },
  // stream
  read: { undef: true },
  // zlib
  chunkSize: { v: 16384 },
  maxOutputLength: { v: 1048576 },
  // fs.createReadStream's fd: an open descriptor of `file`
  fd: { fd: 'file:r' },
};

const D = (args, more = {}) => ({ args, ...more });

const DRIVERS = {
  // ---- fs, sync
  'fs.accessSync': D(['statpath', 'int']),
  'fs.appendFileSync': D(['newpath', 'data', 'opts'], { mutates: true }),
  'fs.chmodSync': D(['path', 'mode'], { mutates: true }),
  'fs.closeSync': D(['fdany']),
  'fs.existsSync': D(['statpath']),
  'fs.fchmodSync': D(['fdany', 'mode'], { mutates: true }),
  'fs.fstatSync': D(['fdany', 'opts']),
  'fs.fsyncSync': D(['fdany']),
  'fs.ftruncateSync': D(['fdany', 'len'], { mutates: true }),
  'fs.lstatSync': D(['statpath', 'opts']),
  'fs.mkdirSync': D(['newpath', 'opts'], { mutates: true, extra: [[{ rel: 'new/sub' }, { obj: { recursive: { v: true } } }]] }),
  'fs.mkdtempSync': D(['prefix', 'opts'], { mutates: true, post: 'tmpname' }),
  'fs.openSync': D(['newpath', 'flags', 'mode'], { mutates: true, post: 'fd' }),
  'fs.readdirSync': D(['path', 'opts'], { post: 'sorted' }),
  'fs.statfsSync': D(['path', 'opts'], { post: 'typeof', only: ['linux'] }),
  // a FIFO path is not in READ_PATHS (opening one for reading blocks without a writer, under node too);
  // the read that cannot pread is judged on a filled pipe's descriptor instead
  'fs.readFileSync': D(['path', 'opts'], { extra: [[{ fd: 'pipe' }, { v: 'utf8' }]] }),
  'fs.readlinkSync': D(['statpath', 'opts']),
  'fs.readSync': D(['fdr', 'buffer', 'offset', 'length', 'position'], { post: 'readsync' }),
  'fs.realpathSync': D(['statpath', 'opts']),
  'fs.renameSync': D(['path', 'dest'], { mutates: true }),
  'fs.rmdirSync': D(['path', 'opts'], { mutates: true }),
  'fs.rmSync': D(['path', 'opts'], { mutates: true }),
  'fs.statSync': D(['statpath', 'opts']),
  'fs.unlinkSync': D(['path'], { mutates: true }),
  'fs.writeFileSync': D(['newpath', 'data', 'opts'], { mutates: true }),
  'fs.writeSync': D(['fdw', 'data', 'position'], { mutates: true }),
  // ---- fs, callback
  'fs.fchmod': D(['fdany', 'mode'], { mutates: true }),
  'fs.fstat': D(['fdany', 'opts']),
  'fs.readFile': D(['path', 'opts']),
  'fs.stat': D(['statpath', 'opts']),
  'fs.unlink': D(['path'], { mutates: true }),
  'fs.writeFile': D(['newpath', 'data', 'opts'], { mutates: true }),
  'fs.createReadStream': D(['path', 'opts'], { post: 'readstream', style: 'sync' }),
  'fs.createWriteStream': D(['newpath', 'opts'], { post: 'writestream', style: 'sync', mutates: true }),
  // ---- fs/promises
  'fs/promises.access': D(['statpath', 'int']),
  'fs/promises.appendFile': D(['newpath', 'data', 'opts'], { mutates: true }),
  'fs/promises.chmod': D(['path', 'mode'], { mutates: true }),
  'fs/promises.copyFile': D(['path', 'dest', 'int'], { mutates: true }),
  'fs/promises.link': D(['path', 'dest'], { mutates: true }),
  'fs/promises.lstat': D(['statpath', 'opts']),
  'fs/promises.lutimes': D(['path', 'time', 'time'], { mutates: true }),
  'fs/promises.mkdir': D(['newpath', 'opts'], { mutates: true, extra: [[{ rel: 'new/sub' }, { obj: { recursive: { v: true } } }]] }),
  'fs/promises.mkdtemp': D(['prefix', 'opts'], { mutates: true, post: 'tmpname' }),
  'fs/promises.open': D(['newpath', 'flags', 'mode'], { mutates: true, post: 'filehandle' }),
  'fs/promises.opendir': D(['path', 'opts'], { post: 'dir' }),
  'fs/promises.readdir': D(['path', 'opts'], { post: 'sorted' }),
  'fs/promises.readFile': D(['path', 'opts']),
  'fs/promises.readlink': D(['statpath', 'opts']),
  'fs/promises.realpath': D(['statpath', 'opts']),
  'fs/promises.rename': D(['path', 'dest'], { mutates: true }),
  'fs/promises.rm': D(['path', 'opts'], { mutates: true }),
  'fs/promises.rmdir': D(['path', 'opts'], { mutates: true }),
  'fs/promises.stat': D(['statpath', 'opts']),
  'fs/promises.statfs': D(['path', 'opts'], { post: 'typeof' }),
  'fs/promises.symlink': D(['target', 'dest', 'any'], { mutates: true }),
  'fs/promises.unlink': D(['path'], { mutates: true }),
  'fs/promises.utimes': D(['path', 'time', 'time'], { mutates: true }),
  'fs/promises.writeFile': D(['newpath', 'data', 'opts'], { mutates: true }),
  // ---- os (no arguments; volatile answers are judged by type or sign)
  'os.arch': D([]),
  'os.availableParallelism': D([], { post: 'sign' }),
  'os.freemem': D([], { post: 'sign' }),
  // run under a deliberate nice (run.cjs DIFF_NICE), so a constant cannot match; and a pid that is no process
  'os.getPriority': D(['int'], { extra: [[{ v: 2147483646 }]] }),
  'os.homedir': D([]),
  'os.hostname': D([]),
  'os.loadavg': D([], { post: 'typeof' }),
  'os.networkInterfaces': D([], { post: 'typeof' }),
  'os.platform': D([]),
  'os.release': D([]),
  'os.tmpdir': D([]),
  'os.totalmem': D([]),
  'os.type': D([]),
  'os.uptime': D([], { post: 'sign' }),
  'os.userInfo': D(['opts']),
  'os.version': D([]),
  // ---- path (property-driven: every sample string, in every position the carve fills)
  'path.basename': D(['pathstr', 'ext'], { extra: [[{ undef: true }], [{ v: 42 }]] }),
  'path.dirname': D(['pathstr'], { extra: [[{ undef: true }]] }),
  'path.extname': D(['pathstr']),
  'path.isAbsolute': D(['pathstr']),
  'path.join': D(['pathstr', 'pathstr', 'pathstr', 'pathstr'], { cap: 120, extra: [[{ undef: true }, { v: 'x' }], []] }),
  'path.normalize': D(['pathstr']),
  'path.parse': D(['pathstr']),
  'path.relative': D(['pathstr', 'pathstr']),
  'path.resolve': D(['pathstr', 'pathstr', 'pathstr'], { cap: 120, extra: [[{ undef: true }, { v: '..' }]] }),
  // ---- process
  'process.cwd': D([]),
  // ---- util
  'util.format': D(['fmt', 'fmtarg', 'fmtarg'], { cap: 80 }),
  'util.formatWithOptions': D(['opts', 'fmt', 'fmtarg'], { extra: [[{ obj: { colors: { v: false } } }, { v: '%s %o' }, { v: 'a' }, { obj: { b: { v: 1 } } }]] }),
  'util.getSystemErrorName': D(['errno']),
  'util.inspect': D(['value', 'opts']),
  'util.isDeepStrictEqual': D(['value', 'value'], { cap: 60 }),
  'util.stripVTControlCharacters': D(['vtstr']),
  // ---- net
  'net.isIP': D(['ip']),
  'net.isIPv4': D(['ip']),
  'net.isIPv6': D(['ip']),
  'net.createServer': D(['opts'], { post: 'close' }),
  // ---- tty
  'tty.isatty': D(['fd0']),
  // ---- zlib
  'zlib.gzipSync': D(['data', 'opts'], { post: 'gzip' }),
  'zlib.deflateSync': D(['data', 'opts'], { post: 'deflate' }),
  'zlib.inflateSync': D(['data', 'opts'], { extra: [[{ buf: '789c4b494c4ae402000694021f' }]] }),
  'zlib.inflateRawSync': D(['data', 'opts'], { extra: [[{ buf: '4b494c4ae40200' }]] }),
};

// Inventoried APIs the table does not drive yet, each with WHY. A reason is a promise to a reader,
// not a pass: the gate lists these by name on every run.
const UNCOVERED = {
  'buffer.SlowBuffer': 'deprecated alias (node 24); feross buffer provides it; behaviour is Buffer.allocUnsafeSlow',
  'child_process.exec': 'callback with a child; a scenario driver is not written yet',
  'child_process.execFile': 'callback with a child; a scenario driver is not written yet',
  'child_process.execFileSync': 'spawns; a scenario driver is not written yet',
  'child_process.execSync': 'spawns through a shell; a scenario driver is not written yet',
  'child_process.spawn': 'returns a live ChildProcess; a scenario driver is not written yet (node-shim-child-process.test.cjs judges it by hand)',
  'child_process.spawnSync': 'spawns; a scenario driver is not written yet (node-shim-child-process.test.cjs judges it by hand)',
  'events.once': 'needs an emitter; a scenario driver is not written yet',
  'events.setMaxListeners': 'needs an emitter or signal; a scenario driver is not written yet',
  'fs.watch': 'event-driven; a scenario driver is not written yet (node-shim-fs-watch.test.cjs judges it by hand)',
  'fs.watchFile': 'event-driven polling; a scenario driver is not written yet',
  'fs.unwatchFile': 'pairs with watchFile; a scenario driver is not written yet',
  'net.connect': 'needs a peer; a scenario driver is not written yet (node-shim-net.test.cjs judges it by hand)',
  'net.createConnection': 'needs a peer; a scenario driver is not written yet (node-shim-net.test.cjs judges it by hand)',
  'os.setPriority': 'changes the scheduling of the running process (judged instead by test/node-shim-os-priority.test.cjs, under nice)',
  'process.exit': 'ends the executor',
  'stream.finished': 'needs a stream; a scenario driver is not written yet (node-shim-stream-finished.test.cjs judges it by hand)',
  'stream.PassThrough': 'a class; a scenario driver is not written yet (node-shim-stream.test.cjs judges it by hand)',
  'stream.pipeline': 'needs streams; a scenario driver is not written yet',
  'stream.Readable': 'a class; a scenario driver is not written yet (node-shim-stream.test.cjs judges it by hand)',
  'stream.Transform': 'a class; a scenario driver is not written yet',
  'tty.ReadStream': 'needs a terminal; node-shim-tty.test.cjs judges it under a pty',
  'util.debuglog': 'its output depends on NODE_DEBUG; a scenario driver is not written yet',
  'util.deprecate': 'its warning is process-global; a scenario driver is not written yet',
  'util.inherits': 'a class wiring helper; a scenario driver is not written yet',
  'util.promisify': 'wraps a callback API; a scenario driver is not written yet',
  'util.TextDecoder': 'a class; a scenario driver is not written yet',
  'zlib.createBrotliDecompress': 'a stream; a scenario driver is not written yet',
  'zlib.createGunzip': 'a stream; a scenario driver is not written yet',
  'zlib.createGzip': 'a stream; a scenario driver is not written yet',
  'zlib.createInflate': 'a stream; a scenario driver is not written yet',
  'zlib.createUnzip': 'a stream; a scenario driver is not written yet',
  'zlib.createZstdDecompress': 'absent from the shim (test/shim-surface/golden.json layer 2)',
  'zlib.deflate': 'callback; a scenario driver is not written yet',
  'zlib.gzip': 'callback; a scenario driver is not written yet',
};

// Values (non-function exports) the carve reads, and how each is described when it is volatile or
// runtime-specific by nature (the executable's path, the pid, the argv): by its type only.
const VALUE_POST = {
  'process.pid': 'sign',
  'process.argv': 'typeof',
  'process.execArgv': 'typeof',
  'process.execPath': 'typeof',
  'process.env': 'typeof',
  'process.stdout': 'typeof',
  'process.stderr': 'typeof',
  'process.stdin': 'typeof',
  'process.versions': 'typeof',
  'process.exitCode': 'show',
  'fs.promises': 'keys',
  'path.win32': 'keys',
  'path.posix': 'keys',
  'util.types': 'keys',
};

module.exports = { READ_PATHS, STAT_PATHS, SAMPLES, KEY_SAMPLES, DRIVERS, UNCOVERED, VALUE_POST };
