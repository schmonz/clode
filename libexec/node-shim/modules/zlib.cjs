'use strict';
// node:zlib — the -p bundle require()s zlib in several HTTP/transport modules and
// reads `zlib.constants` at init (destructuring specific Z_*/BROTLI_* values). The
// constants below are the REAL host-node table (byte-identical values), so any
// destructure or comparison the boot performs is correct. Characterized by
// test/node-shim-core.test.cjs (zlib.constants row).
//
// WHAT IS REAL: the four decompressing streams (Gunzip, Inflate, InflateRaw, Unzip and
// their create* forms), over the engine's own inflate; see "DECOMPRESSION STREAMS" below. And
// the one-shot helpers, sync and callback (gzipSync/deflateSync/deflateRawSync, their inflating
// siblings, unzipSync, crc32), over the engine's miniz through __tjs_zlib_sync; see "ONE-SHOT".
// WHAT IS A WALL (loud, deferred): the compressing streams (createGzip/createDeflate/
// createDeflateRaw and their classes). They are present so feature-detection matches host node,
// but INVOKING one throws a branded error rather than silently mis-behaving.
// WHAT IS ABSENT: brotli, on purpose (see "NO BROTLI" below), and zstd.
const constants = {"BROTLI_DECODE":8,"BROTLI_DECODER_ERROR_ALLOC_BLOCK_TYPE_TREES":-30,"BROTLI_DECODER_ERROR_ALLOC_CONTEXT_MAP":-25,"BROTLI_DECODER_ERROR_ALLOC_CONTEXT_MODES":-21,"BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_1":-26,"BROTLI_DECODER_ERROR_ALLOC_RING_BUFFER_2":-27,"BROTLI_DECODER_ERROR_ALLOC_TREE_GROUPS":-22,"BROTLI_DECODER_ERROR_DICTIONARY_NOT_SET":-19,"BROTLI_DECODER_ERROR_FORMAT_BLOCK_LENGTH_1":-9,"BROTLI_DECODER_ERROR_FORMAT_BLOCK_LENGTH_2":-10,"BROTLI_DECODER_ERROR_FORMAT_CL_SPACE":-6,"BROTLI_DECODER_ERROR_FORMAT_CONTEXT_MAP_REPEAT":-8,"BROTLI_DECODER_ERROR_FORMAT_DICTIONARY":-12,"BROTLI_DECODER_ERROR_FORMAT_DISTANCE":-16,"BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_META_NIBBLE":-3,"BROTLI_DECODER_ERROR_FORMAT_EXUBERANT_NIBBLE":-1,"BROTLI_DECODER_ERROR_FORMAT_HUFFMAN_SPACE":-7,"BROTLI_DECODER_ERROR_FORMAT_PADDING_1":-14,"BROTLI_DECODER_ERROR_FORMAT_PADDING_2":-15,"BROTLI_DECODER_ERROR_FORMAT_RESERVED":-2,"BROTLI_DECODER_ERROR_FORMAT_SIMPLE_HUFFMAN_ALPHABET":-4,"BROTLI_DECODER_ERROR_FORMAT_SIMPLE_HUFFMAN_SAME":-5,"BROTLI_DECODER_ERROR_FORMAT_TRANSFORM":-11,"BROTLI_DECODER_ERROR_FORMAT_WINDOW_BITS":-13,"BROTLI_DECODER_ERROR_INVALID_ARGUMENTS":-20,"BROTLI_DECODER_ERROR_UNREACHABLE":-31,"BROTLI_DECODER_NEEDS_MORE_INPUT":2,"BROTLI_DECODER_NEEDS_MORE_OUTPUT":3,"BROTLI_DECODER_NO_ERROR":0,"BROTLI_DECODER_PARAM_DISABLE_RING_BUFFER_REALLOCATION":0,"BROTLI_DECODER_PARAM_LARGE_WINDOW":1,"BROTLI_DECODER_RESULT_ERROR":0,"BROTLI_DECODER_RESULT_NEEDS_MORE_INPUT":2,"BROTLI_DECODER_RESULT_NEEDS_MORE_OUTPUT":3,"BROTLI_DECODER_RESULT_SUCCESS":1,"BROTLI_DECODER_SUCCESS":1,"BROTLI_DEFAULT_MODE":0,"BROTLI_DEFAULT_QUALITY":11,"BROTLI_DEFAULT_WINDOW":22,"BROTLI_ENCODE":9,"BROTLI_LARGE_MAX_WINDOW_BITS":30,"BROTLI_MAX_INPUT_BLOCK_BITS":24,"BROTLI_MAX_QUALITY":11,"BROTLI_MAX_WINDOW_BITS":24,"BROTLI_MIN_INPUT_BLOCK_BITS":16,"BROTLI_MIN_QUALITY":0,"BROTLI_MIN_WINDOW_BITS":10,"BROTLI_MODE_FONT":2,"BROTLI_MODE_GENERIC":0,"BROTLI_MODE_TEXT":1,"BROTLI_OPERATION_EMIT_METADATA":3,"BROTLI_OPERATION_FINISH":2,"BROTLI_OPERATION_FLUSH":1,"BROTLI_OPERATION_PROCESS":0,"BROTLI_PARAM_DISABLE_LITERAL_CONTEXT_MODELING":4,"BROTLI_PARAM_LARGE_WINDOW":6,"BROTLI_PARAM_LGBLOCK":3,"BROTLI_PARAM_LGWIN":2,"BROTLI_PARAM_MODE":0,"BROTLI_PARAM_NDIRECT":8,"BROTLI_PARAM_NPOSTFIX":7,"BROTLI_PARAM_QUALITY":1,"BROTLI_PARAM_SIZE_HINT":5,"DEFLATE":1,"DEFLATERAW":5,"GUNZIP":4,"GZIP":3,"INFLATE":2,"INFLATERAW":6,"UNZIP":7,"ZLIB_VERNUM":4880,"ZSTD_CLEVEL_DEFAULT":3,"ZSTD_COMPRESS":10,"ZSTD_DECOMPRESS":11,"ZSTD_btlazy2":6,"ZSTD_btopt":7,"ZSTD_btultra":8,"ZSTD_btultra2":9,"ZSTD_c_chainLog":103,"ZSTD_c_checksumFlag":201,"ZSTD_c_compressionLevel":100,"ZSTD_c_contentSizeFlag":200,"ZSTD_c_dictIDFlag":202,"ZSTD_c_enableLongDistanceMatching":160,"ZSTD_c_hashLog":102,"ZSTD_c_jobSize":401,"ZSTD_c_ldmBucketSizeLog":163,"ZSTD_c_ldmHashLog":161,"ZSTD_c_ldmHashRateLog":164,"ZSTD_c_ldmMinMatch":162,"ZSTD_c_minMatch":105,"ZSTD_c_nbWorkers":400,"ZSTD_c_overlapLog":402,"ZSTD_c_searchLog":104,"ZSTD_c_strategy":107,"ZSTD_c_targetLength":106,"ZSTD_c_windowLog":101,"ZSTD_d_windowLogMax":100,"ZSTD_dfast":2,"ZSTD_e_continue":0,"ZSTD_e_end":2,"ZSTD_e_flush":1,"ZSTD_error_GENERIC":1,"ZSTD_error_checksum_wrong":22,"ZSTD_error_corruption_detected":20,"ZSTD_error_dictionaryCreation_failed":34,"ZSTD_error_dictionary_corrupted":30,"ZSTD_error_dictionary_wrong":32,"ZSTD_error_dstBuffer_null":74,"ZSTD_error_dstSize_tooSmall":70,"ZSTD_error_frameParameter_unsupported":14,"ZSTD_error_frameParameter_windowTooLarge":16,"ZSTD_error_init_missing":62,"ZSTD_error_literals_headerWrong":24,"ZSTD_error_maxSymbolValue_tooLarge":46,"ZSTD_error_maxSymbolValue_tooSmall":48,"ZSTD_error_memory_allocation":64,"ZSTD_error_noForwardProgress_destFull":80,"ZSTD_error_noForwardProgress_inputEmpty":82,"ZSTD_error_no_error":0,"ZSTD_error_parameter_combination_unsupported":41,"ZSTD_error_parameter_outOfBound":42,"ZSTD_error_parameter_unsupported":40,"ZSTD_error_prefix_unknown":10,"ZSTD_error_srcSize_wrong":72,"ZSTD_error_stabilityCondition_notRespected":50,"ZSTD_error_stage_wrong":60,"ZSTD_error_tableLog_tooLarge":44,"ZSTD_error_version_unsupported":12,"ZSTD_error_workSpace_tooSmall":66,"ZSTD_fast":1,"ZSTD_greedy":3,"ZSTD_lazy":4,"ZSTD_lazy2":5,"Z_BEST_COMPRESSION":9,"Z_BEST_SPEED":1,"Z_BLOCK":5,"Z_BUF_ERROR":-5,"Z_DATA_ERROR":-3,"Z_DEFAULT_CHUNK":16384,"Z_DEFAULT_COMPRESSION":-1,"Z_DEFAULT_LEVEL":-1,"Z_DEFAULT_MEMLEVEL":8,"Z_DEFAULT_STRATEGY":0,"Z_DEFAULT_WINDOWBITS":15,"Z_ERRNO":-1,"Z_FILTERED":1,"Z_FINISH":4,"Z_FIXED":4,"Z_FULL_FLUSH":3,"Z_HUFFMAN_ONLY":2,"Z_MAX_CHUNK":null,"Z_MAX_LEVEL":9,"Z_MAX_MEMLEVEL":9,"Z_MAX_WINDOWBITS":15,"Z_MEM_ERROR":-4,"Z_MIN_CHUNK":64,"Z_MIN_LEVEL":-1,"Z_MIN_MEMLEVEL":1,"Z_MIN_WINDOWBITS":8,"Z_NEED_DICT":2,"Z_NO_COMPRESSION":0,"Z_NO_FLUSH":0,"Z_OK":0,"Z_PARTIAL_FLUSH":1,"Z_RLE":3,"Z_STREAM_END":1,"Z_STREAM_ERROR":-2,"Z_SYNC_FLUSH":2,"Z_VERSION_ERROR":-6};
// The table above was snapshotted from host node via JSON, and JSON cannot
// represent Infinity — it serialized to null. node's zlib.constants.Z_MAX_CHUNK
// IS Infinity (a number), so the shim was handing back an object (typeof null)
// where node hands back a number. Restore it here rather than hand-editing the
// generated literal, so a future regeneration cannot silently undo the repair.
//
// The deep-equal test did not catch this because it compared both sides THROUGH
// JSON, where node's Infinity also becomes null — the check was blind to exactly
// the values the snapshot destroys. That blindness is the reusable lesson: a
// fidelity assertion routed through a lossy encoding cannot see what the encoding
// loses.
constants.Z_MAX_CHUNK = Infinity;

// ---- DECOMPRESSION STREAMS: real, over the engine's own inflate --------------------------------------
// The engine's DecompressionStream (miniz underneath) decodes gzip, zlib ('deflate') and raw deflate,
// so the four inflating Transforms are real. They are what an HTTP client pipes a compressed response
// through, and /login needs them: the bundle's axios advertises the encodings this module can decode
// and pipes the response through createUnzip. While these threw, the token exchange's 400 never reached
// the caller, and sign-in said "Couldn't get an answer from the sign-in service".
//
// DIVERGENCES, by name:
//   - errors carry node's code and errno (Z_DATA_ERROR, -3) but the engine's message, not zlib's
//     ("incorrect header check", ...); nothing in the bundle reads the message.
//   - (none for truncation) input that ends mid-stream is node's "unexpected end of file" (Z_BUF_ERROR) under
//     the default finishFlush (Z_FINISH), after the output decoded so far; under Z_SYNC_FLUSH (the bundle's
//     axios passes it) it is not an error, as in node. The engine's inflater does not report a truncation, so
//     under Z_FINISH the stream keeps its compressed input and, at the end, reads it once through the one-shot
//     inflater (which does): a second pass, which the Z_SYNC_FLUSH path the bundle takes never pays.
//   - flush: output is delivered as each write decodes it, which is what every flush mode gives an inflater.
// The options node reads here are honoured or refused by name (internal/options.cjs, 'zlib.zlib').
const { Transform } = require('stream');
const { refuseOptions } = require('../internal/options.cjs');

// node's chunkSize: a number of at least Z_MIN_CHUNK (64); the size no 'data' chunk of a stream exceeds
function chunkSizeOpt(opts) {
  const v = opts && opts.chunkSize !== undefined ? opts.chunkSize : constants.Z_DEFAULT_CHUNK;
  if (typeof v !== 'number' || Number.isNaN(v)) {
    throw Object.assign(new TypeError('The "options.chunkSize" property must be of type number'), { code: 'ERR_INVALID_ARG_TYPE' });
  }
  if (v < constants.Z_MIN_CHUNK) {
    throw Object.assign(new RangeError(`The value of "options.chunkSize" is out of range. It must be >= ${constants.Z_MIN_CHUNK}. Received ${v}`),
      { code: 'ERR_OUT_OF_RANGE' });
  }
  return Math.floor(v);
}
// node's maxOutputLength (the convenience methods only): a longer result is ERR_BUFFER_TOO_LARGE
function maxOutputOpt(opts) {
  const v = opts && opts.maxOutputLength !== undefined ? opts.maxOutputLength : undefined;
  if (v === undefined) return Infinity;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    throw Object.assign(new RangeError(`The value of "options.maxOutputLength" is out of range. It must be >= 1 and <= ${2 ** 53 - 1}. Received ${v}`),
      { code: 'ERR_OUT_OF_RANGE' });
  }
  return v;
}

// node's zlib flush/finishFlush check: an integer from Z_NO_FLUSH to Z_BLOCK
function flushOpt(opts, key, dflt) {
  const v = opts && opts[key] !== undefined ? opts[key] : dflt;
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw Object.assign(new TypeError(`The "options.${key}" property must be of type number`), { code: 'ERR_INVALID_ARG_TYPE' });
  }
  if (v < constants.Z_NO_FLUSH || v > constants.Z_BLOCK) {
    throw Object.assign(new RangeError(`The value of "options.${key}" is out of range. It must be >= ${constants.Z_NO_FLUSH} and <= ${constants.Z_BLOCK}. Received ${v}`),
      { code: 'ERR_OUT_OF_RANGE' });
  }
  return v;
}

function zlibError(e) {
  if (e && typeof e.code === 'string' && e.code.startsWith('Z_')) return e;
  const err = new Error(e && e.message ? e.message : String(e));
  err.errno = constants.Z_DATA_ERROR;
  err.code = 'Z_DATA_ERROR';
  return err;
}

// format: 'gzip' | 'deflate' | 'deflate-raw' (the engine's names), or 'unzip' (gzip or zlib, by header,
// as node's Unzip decides it: gzip magic 1f 8b, else zlib).
class Decompressor extends Transform {
  constructor(format, opts) {
    refuseOptions('zlib.zlib', opts);
    const flush = flushOpt(opts, 'flush', constants.Z_NO_FLUSH);
    const finishFlush = flushOpt(opts, 'finishFlush', constants.Z_FINISH);
    const chunkSize = chunkSizeOpt(opts);
    maxOutputOpt(opts);   // validated as node does; it limits the convenience methods only
    super(opts || {});
    this._chunkSize = chunkSize;
    this._flushMode = flush;
    // Z_FINISH: truncated input is an error, so keep the compressed input for the end-of-stream check
    this._kept = finishFlush === constants.Z_FINISH ? [] : null;
    this._format = format;
    this._head = null;     // unzip only: bytes held until the header can be read
    this._writer = null;
    this._drained = null;  // resolves when the engine stream's readable side has ended
    this._chain = Promise.resolve();  // the shim's Transform does not wait on _transform, so serialize here
    this._failed = null;
    this.bytesWritten = 0;
  }
  _open(format) {
    const ds = new DecompressionStream(format);
    this._writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();
    this._drained = (async () => {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        // no chunk larger than chunkSize, as node's; nothing is held back waiting to fill one (a stream's reader
        // must see each piece as it is decoded)
        if (value && value.byteLength) {
          const b = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
          for (let i = 0; i < b.length; i += this._chunkSize) this.push(b.subarray(i, Math.min(b.length, i + this._chunkSize)));
        }
      }
    })();
    this._drained.catch(() => {});  // its error surfaces through the write that caused it
  }
  _feed(chunk) {
    if (!this._writer) {
      if (this._format === 'unzip') {
        const head = this._head ? Buffer.concat([this._head, chunk]) : chunk;
        if (head.length < 2) { this._head = head; return Promise.resolve(); }
        this._head = null;
        chunk = head;
        this._open(head[0] === 0x1f && head[1] === 0x8b ? 'gzip' : 'deflate');
      } else this._open(this._format);
    }
    return this._writer.write(chunk);
  }
  // Runs fn after every earlier step. The first failure is reported once, through that step's callback
  // (the Transform turns it into 'error'); later steps of a failed stream do nothing, as node's errored
  // stream accepts no more work.
  _step(fn, cb) {
    this._chain = this._chain.then(async () => {
      if (this._failed) return;
      try { await fn(); } catch (e) { this._failed = zlibError(e); cb(this._failed); return; }
      cb();
    });
  }
  _transform(chunk, enc, cb) {
    this.bytesWritten += chunk.length;
    if (this._kept) this._kept.push(Buffer.from(chunk));
    this._step(() => this._feed(chunk), cb);
  }
  _flush(cb) {
    this._step(async () => {
      if (this._head) { const h = this._head; this._head = null; this._open('deflate'); await this._writer.write(h); }
      if (this._writer) {
        await this._writer.close();
        await this._drained;
      }
      if (this._kept) this._checkComplete(Buffer.concat(this._kept));
    }, cb);
  }
  // Under Z_FINISH, the one-shot inflater reads the whole input once more: a truncation it reports is node's
  // "unexpected end of file". (No input at all is node's truncation too.)
  _checkComplete(input) {
    if (typeof globalThis.__tjs_zlib_sync !== 'function') {
      require('../internal/engine-floor-log.cjs').engineFloorLog('node-shim: zlib finishFlush Z_FINISH truncation check '
        + 'skipped: this engine has no __tjs_zlib_sync (it predates txiki-zlib-sync.patch)');
      return;
    }
    if (input.length === 0) throw truncated();
    const u8 = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    const fn = { gzip: ONE_SHOT.gunzip, deflate: ONE_SHOT.inflate, 'deflate-raw': ONE_SHOT.inflateRaw, unzip: ONE_SHOT.unzip }[this._format];
    try { fn(u8); } catch (e) { if (e && e.code === 'Z_BUF_ERROR') throw e; }
  }
  close(cb) { if (cb) queueMicrotask(cb); this.destroy(); }
}

const DECOMPRESSORS = { Gunzip: 'gzip', Inflate: 'deflate', InflateRaw: 'deflate-raw', Unzip: 'unzip' };

// ---- ONE-SHOT: real, over the engine's miniz, synchronously ------------------------------------------
// 2.1.330 gzips every first-party event batch with zlib.gzipSync (and Bun.gzipSync, which comes here). While
// these threw "not implemented" every batch failed to export and piled up on disk as
// <config>/telemetry/1p_failed_events.*.json (a live NetBSD/arm64 --debug log, 2026-11-23: "181 events failed
// to export", 1.9 MB in one session); native sends them. The engine's door to miniz is __tjs_zlib_sync
// (txiki-zlib-sync.patch): raw deflate and zlib, one shot, before the call returns, as node's *Sync does. The
// gzip frame (RFC 1952) is written and read here, as node's zlib writes it: header bytes identical to node's
// (XFL from the level, OS from the platform, zlib's OS_CODE), CRC-32 and ISIZE after; a gunzip reads every
// member and ignores what follows the last one, as node does. The callback forms run the same code and call
// back on a later turn.
//
// DIVERGENCES, by name:
//   - the compressed BYTES are miniz's, not zlib's: a valid stream that node (and this module) inflate to
//     the same input, of a similar size. The zlib header (78 01/5e/9c/da by level) and the gzip header are
//     node's own bytes. windowBits, memLevel and strategy are refused by name unless they ask for node's
//     default (internal/options.cjs): miniz has one window.
//   - a corrupt stream's message: node names the fault ("invalid block type", "invalid distance too far
//     back"); miniz reports only that the data is bad, so the message here is "invalid compressed data". code
//     and errno are node's (Z_DATA_ERROR, -3). The header, checksum, method and truncation errors are node's
//     own words, checked here.
//   - info is refused by name (internal/options.cjs); maxOutputLength is node's cap on the answer, checked after it.
function engineZlib(caller) {
  if (typeof globalThis.__tjs_zlib_sync !== 'function') {
    const e = new Error('node-shim: this engine has no __tjs_zlib_sync (it predates txiki-zlib-sync.patch), so '
      + caller + ' cannot answer; rebuild it: ./build.sh --only engine.compile');
    e.code = 'ERR_CLODE_ENGINE_FLOOR';
    require('../internal/engine-floor-log.cjs').engineFloorLog(e.message);
    throw e;
  }
  return globalThis.__tjs_zlib_sync;
}

const { invalidArgType } = require('../internal/node-errors.cjs');
const asBuffer = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);

// node's zlibBufferSync input check: a string (utf8), or Buffer/TypedArray/DataView/ArrayBuffer bytes.
function inputBytes(buffer, what) {
  if (typeof buffer === 'string') return new Uint8Array(Buffer.from(buffer, 'utf8'));
  if (buffer instanceof ArrayBuffer) return new Uint8Array(buffer);
  if (ArrayBuffer.isView(buffer)) return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  throw invalidArgType(`The "${what}" argument must be of type string or an instance of Buffer, TypedArray, DataView, or ArrayBuffer`, buffer);
}

function levelOf(opts) {
  const level = opts && opts.level !== undefined ? opts.level : constants.Z_DEFAULT_COMPRESSION;
  if (typeof level !== 'number' || !Number.isInteger(level)) {
    throw invalidArgType('The "options.level" property must be of type number', level);
  }
  if (level < -1 || level > 9) {
    throw Object.assign(new RangeError(`The value of "options.level" is out of range. It must be >= -1 and <= 9. Received ${level}`),
      { code: 'ERR_OUT_OF_RANGE' });
  }
  return level;
}

function zError(message, code) {
  return Object.assign(new Error(message), { errno: constants[code], code });
}
const truncated = () => zError('unexpected end of file', 'Z_BUF_ERROR');

// zlib's OS_CODE, as node's bundled zlib writes it into a gzip header (measured: 0x13 on macOS under node 24).
const GZIP_OS = process.platform === 'darwin' ? 0x13 : process.platform === 'win32' ? 0x0a : 0x03;

function gzipBytes(input, level) {
  const z = engineZlib('zlib.gzipSync');
  const body = z('deflate', input, -15, level);
  const crc = z('crc32', input, 0);
  const out = Buffer.allocUnsafe(10 + body.length + 8);
  // zlib's deflate.c: XFL 2 at level 9, 4 at level 0-1 (fastest), else 0
  const xfl = level === 9 ? 2 : (level === 0 || level === 1) ? 4 : 0;
  out.set([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, xfl, GZIP_OS], 0);
  out.set(body, 10);
  out.writeUInt32LE(crc >>> 0, 10 + body.length);
  out.writeUInt32LE(input.length >>> 0, 14 + body.length);
  return out;
}

// One inflate. format 'deflate' (zlib) or 'raw'. Returns { output, consumed }.
function inflateOne(input, format, caller) {
  const z = engineZlib(caller);
  if (format === 'deflate') {
    if (input.length < 2) throw truncated();
    const cmf = input[0], flg = input[1];
    if ((cmf & 0x0f) !== 8 || (cmf >> 4) > 7 || ((cmf << 8) | flg) % 31 !== 0) throw zError('incorrect header check', 'Z_DATA_ERROR');
    // FDICT: zlib reads the 4-byte DICTID first, then asks for the dictionary node was not given
    if (flg & 0x20) throw input.length < 6 ? truncated() : zError('Missing dictionary', 'Z_NEED_DICT');
  }
  let r;
  try {
    r = z('inflate', input, format === 'deflate' ? 15 : -15);
  } catch (e) {
    // miniz says only "bad data". A body that inflates raw means the fault was zlib's Adler-32 trailer.
    if (format === 'deflate') {
      let raw = null;
      try { raw = z('inflate', input.subarray(2), -15); } catch (_) { /* the body itself is bad */ }
      if (raw && raw.ended) throw zError(input.length >= raw.consumed + 6 ? 'incorrect data check' : 'unexpected end of file',
        input.length >= raw.consumed + 6 ? 'Z_DATA_ERROR' : 'Z_BUF_ERROR');
    }
    throw zError('invalid compressed data', 'Z_DATA_ERROR');
  }
  if (!r.ended) throw truncated();
  return r;
}

// RFC 1952: every member, as node's Gunzip reads them (node_zlib.cc): after a member, a non-zero byte starts
// another member (so trailing garbage is an "incorrect header check"); a zero byte ends the input as padding.
function gunzipBytes(input, caller) {
  const z = engineZlib(caller);
  const parts = [];
  let pos = 0;
  for (let first = true; ; first = false) {
    const rest = input.subarray(pos);
    if (!first && (rest.length === 0 || rest[0] === 0)) break;
    if (rest.length < 2) throw truncated();
    if (rest[0] !== 0x1f || rest[1] !== 0x8b) throw zError('incorrect header check', 'Z_DATA_ERROR');
    if (rest.length < 10) throw truncated();
    if (rest[2] !== 8) throw zError('unknown compression method', 'Z_DATA_ERROR');
    const flg = rest[3];
    let h = 10;
    if (flg & 0x04) { if (rest.length < h + 2) throw truncated(); h += 2 + (rest[h] | (rest[h + 1] << 8)); }
    if (flg & 0x08) { while (h < rest.length && rest[h] !== 0) h++; h++; }
    if (flg & 0x10) { while (h < rest.length && rest[h] !== 0) h++; h++; }
    if (flg & 0x02) h += 2;
    if (h > rest.length) throw truncated();
    const r = inflateOne(rest.subarray(h), 'raw', caller);
    const t = h + r.consumed;
    if (rest.length < t + 8) throw truncated();
    const crc = (rest[t] | (rest[t + 1] << 8) | (rest[t + 2] << 16) | (rest[t + 3] << 24)) >>> 0;
    const isize = (rest[t + 4] | (rest[t + 5] << 8) | (rest[t + 6] << 16) | (rest[t + 7] << 24)) >>> 0;
    if (crc !== z('crc32', r.output, 0) || isize !== (r.output.length >>> 0)) throw zError('incorrect data check', 'Z_DATA_ERROR');
    parts.push(r.output);
    pos += t + 8;
  }
  return parts.length === 1 ? asBuffer(parts[0]) : Buffer.concat(parts.map(asBuffer));
}

const ONE_SHOT = {
  gzip: (input, opts) => gzipBytes(input, levelOf(opts)),
  deflate: (input, opts) => asBuffer(engineZlib('zlib.deflateSync')('deflate', input, 15, levelOf(opts))),
  deflateRaw: (input, opts) => asBuffer(engineZlib('zlib.deflateRawSync')('deflate', input, -15, levelOf(opts))),
  gunzip: (input) => gunzipBytes(input, 'zlib.gunzipSync'),
  inflate: (input) => asBuffer(inflateOne(input, 'deflate', 'zlib.inflateSync').output),
  inflateRaw: (input) => asBuffer(inflateOne(input, 'raw', 'zlib.inflateRawSync').output),
  // node's Unzip: gzip by its magic, else zlib
  unzip: (input) => (input[0] === 0x1f && (input.length < 2 || input[1] === 0x8b) ? gunzipBytes(input, 'zlib.unzipSync')
    : asBuffer(inflateOne(input, 'deflate', 'zlib.unzipSync').output)),
};

// One convenience call: options refused or validated first (chunkSize, maxOutputLength), then the work, then node's
// output cap. (chunkSize shapes a stream's chunks; a one-shot answer is one buffer, so it is only validated.)
function runOneShot(fn, buffer, opts) {
  refuseOptions('zlib.zlib', opts);
  chunkSizeOpt(opts);
  const max = maxOutputOpt(opts);
  const out = fn(inputBytes(buffer, 'buffer'), opts);
  if (out.length > max) {
    throw Object.assign(new RangeError(`Cannot create a Buffer larger than ${max} bytes`), { code: 'ERR_BUFFER_TOO_LARGE' });
  }
  return out;
}

function oneShot() {
  const api = {};
  for (const [name, fn] of Object.entries(ONE_SHOT)) {
    api[`${name}Sync`] = function (buffer, opts) { return runOneShot(fn, buffer, opts); };
    Object.defineProperty(api[`${name}Sync`], 'name', { value: `syncBufferWrapper` });
    // node's asyncBufferWrapper: (buffer[, opts], callback); the answer (or the error) arrives on a later turn
    api[name] = function (buffer, opts, callback) {
      if (typeof opts === 'function') { callback = opts; opts = {}; }
      if (typeof callback !== 'function') throw invalidArgType('The "callback" argument must be of type function', callback);
      let result, error = null;
      try { result = runOneShot(fn, buffer, opts); } catch (e) { error = e; }
      setImmediate(() => (error ? callback(error) : callback(null, result)));
    };
  }
  return api;
}

// zlib.crc32(data[, value]) (node 22+): the engine's (miniz's) CRC-32, which is zlib's.
function crc32(data, value = 0) {
  if (typeof data !== 'string' && !ArrayBuffer.isView(data)) {
    throw invalidArgType('The "data" argument must be of type string or an instance of Buffer, TypedArray, or DataView', data);
  }
  if (typeof value !== 'number') throw invalidArgType('The "value" argument must be of type number', value);
  return engineZlib('zlib.crc32')('crc32', inputBytes(data, 'data'), value >>> 0);
}

// NO BROTLI, DELIBERATELY ABSENT (not present-and-throwing). The engine has no brotli decoder, and a
// function that exists is a promise to every feature-detecting client: the bundle's axios asks for br
// exactly when `typeof zlib.createBrotliDecompress === "function"`, Cloudflare then answers in br, and
// the response is lost. Absent, axios asks for gzip and gets a body this module can decode. The same
// shape as zlib.createZstdDecompress; both are recorded in test/shim-surface/golden.json.
const zlib = { constants, crc32, ...oneShot() };
for (const name of ['createGzip', 'createDeflate', 'createDeflateRaw']) {
  zlib[name] = () => { throw new Error(`node-shim: zlib.${name} not implemented (a compressing STREAM; the one-shot helpers are real)`); };
}
for (const [cls, format] of Object.entries(DECOMPRESSORS)) {
  zlib[cls] = class extends Decompressor { constructor(opts) { super(format, opts); } };
  Object.defineProperty(zlib[cls], 'name', { value: cls });
  zlib[`create${cls}`] = (opts) => new zlib[cls](opts);
}
// Node also exposes the Z_*/ZSTD_* constants and the mode enums (DEFLATE/GZIP/…)
// at the TOP LEVEL of the zlib module (legacy, but present), not only under
// zlib.constants. It does NOT hoist the BROTLI_* keys. Deps read e.g.
// `zlib.Z_MIN_CHUNK` / `zlib.Z_FINISH` directly — mirror the real top-level set
// (everything except BROTLI_*) so those reads see the byte-identical value.
for (const [k, v] of Object.entries(constants)) { if (!k.startsWith('BROTLI_') && !(k in zlib)) zlib[k] = v; }
// The compressing stream classes exist on host zlib; expose throw-on-construct constructors
// so `typeof zlib.Deflate === 'function'` feature-detection matches, while an
// actual instantiation fails loud (no compressor yet — same contract as create*).
for (const cls of ['Gzip', 'Deflate', 'DeflateRaw']) {
  zlib[cls] = class { constructor() { throw new Error(`node-shim: zlib.${cls} not implemented (a compressing STREAM; the one-shot helpers are real)`); } };
  Object.defineProperty(zlib[cls], 'name', { value: cls });
}
zlib.default = zlib;
module.exports = zlib;
