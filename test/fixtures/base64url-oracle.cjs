'use strict';
// Runs under the node-shim loader (tjs). quaude's active Buffer is feross
// `buffer` v6.0.3, which rejects the `base64url` encoding the bundle uses for
// work secrets. Asserts the shim's buffer.cjs base64url shim round-trips and
// matches Node's alphabet (URL-safe, unpadded). Prints RESULT PASS / RESULT FAIL.
const B = require('buffer').Buffer;

const raw = 'hello world? >>> ~/+';
const enc = B.from(raw).toString('base64url');
const dec = B.from(enc, 'base64url').toString();

// Known Node vectors: Buffer.from('>>>').toString('base64url') === 'Pj4-'
const kEnc = B.from('>>>').toString('base64url');
const kDec = B.from('Pj4-', 'base64url').toString();

const ok = dec === raw                 // round-trips
  && !/[+/=]/.test(enc)                // URL-safe alphabet, no padding
  && kEnc === 'Pj4-'                   // matches Node's alphabet
  && kDec === '>>>'
  && B.isEncoding('base64url') === true;

console.log('ENC=' + enc + ' kEnc=' + kEnc + ' kDec=' + kDec);
console.log('RESULT ' + (ok ? 'PASS' : 'FAIL'));
