'use strict';
// node:zlib — the -p bundle require()s zlib in several HTTP/transport modules and
// reads `zlib.constants` at init (destructuring specific Z_*/BROTLI_* values). The
// constants below are the REAL host-node table (byte-identical values), so any
// destructure or comparison the boot performs is correct. Characterized by
// test/node-shim-core.test.cjs (zlib.constants row).
//
// WHAT IS REAL: the four decompressing streams (Gunzip, Inflate, InflateRaw, Unzip and
// their create* forms), over the engine's own inflate; see "DECOMPRESSION STREAMS" below.
// WHAT IS A WALL (loud, deferred): compression and the one-shot helpers. They are
// present so feature-detection matches host node, but INVOKING one throws a branded
// error rather than silently mis-behaving.
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

function unimplemented(name) {
  return function () {
    throw new Error(`node-shim: zlib.${name} not implemented (tjs has no native zlib; the -p mock path sends no compressed bodies)`);
  };
}

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
//   - input that ends mid-stream is not an error here. node reports it ("unexpected end of file") only
//     under the default finishFlush; the bundle's axios passes Z_SYNC_FLUSH, under which node does not.
//   - flush/finishFlush/chunkSize options are accepted and ignored: output is delivered as decoded.
const { Transform } = require('stream');

function zlibError(e) {
  const err = new Error(e && e.message ? e.message : String(e));
  err.errno = constants.Z_DATA_ERROR;
  err.code = 'Z_DATA_ERROR';
  return err;
}

// format: 'gzip' | 'deflate' | 'deflate-raw' (the engine's names), or 'unzip' (gzip or zlib, by header,
// as node's Unzip decides it: gzip magic 1f 8b, else zlib).
class Decompressor extends Transform {
  constructor(format, opts) {
    super(opts || {});
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
        if (value && value.byteLength) this.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
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
    this._step(() => this._feed(chunk), cb);
  }
  _flush(cb) {
    this._step(async () => {
      if (this._head) { const h = this._head; this._head = null; this._open('deflate'); await this._writer.write(h); }
      if (!this._writer) return;
      await this._writer.close();
      await this._drained;
    }, cb);
  }
  close(cb) { if (cb) queueMicrotask(cb); this.destroy(); }
}

const DECOMPRESSORS = { Gunzip: 'gzip', Inflate: 'deflate', InflateRaw: 'deflate-raw', Unzip: 'unzip' };

// Compression and the one-shot helpers stay walls: no bundle path the shim has met needs them yet (the
// 1P event export's gzipSync is queued in BACKLOG.md).
const COMPRESSION_API = [
  'createGzip', 'createDeflate', 'createDeflateRaw',
  'gzip', 'gzipSync', 'gunzip', 'gunzipSync', 'deflate', 'deflateSync', 'inflate', 'inflateSync',
  'deflateRaw', 'deflateRawSync', 'inflateRaw', 'inflateRawSync',
];

// NO BROTLI, DELIBERATELY ABSENT (not present-and-throwing). The engine has no brotli decoder, and a
// function that exists is a promise to every feature-detecting client: the bundle's axios asks for br
// exactly when `typeof zlib.createBrotliDecompress === "function"`, Cloudflare then answers in br, and
// the response is lost. Absent, axios asks for gzip and gets a body this module can decode. The same
// shape as zlib.createZstdDecompress; both are recorded in test/shim-surface/golden.json.
const zlib = { constants };
for (const name of COMPRESSION_API) zlib[name] = unimplemented(name);
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
  zlib[cls] = class { constructor() { throw new Error(`node-shim: zlib.${cls} not implemented (tjs has no native zlib)`); } };
  Object.defineProperty(zlib[cls], 'name', { value: cls });
}
zlib.default = zlib;
module.exports = zlib;
