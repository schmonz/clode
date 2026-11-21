'use strict';
// tls.createSecureContext({ ca }) cases, one row per case. Self-contained, so test/node-shim-tls-secure-context.test.cjs
// runs its SOURCE (cases.toString()) under tjs+loader and inside native Bun (scripts/lib/native-oracle.cjs);
// tls-secure-context-native.json is native's answer. C1 and C2 are self-signed P-256 test roots minted for these rows
// (openssl req -x509, CN=clode-test-root-1/2, 100 years); their keys were never kept. The PRIVATE KEY block is not a
// key: native does not decode one (a key block is skipped, not parsed), so a placeholder answers as a real one does.
module.exports = function cases() {
  const C1 = '-----BEGIN CERTIFICATE-----\nMIIBjzCCATWgAwIBAgIUU3EQzrS4oHgXipk+pbWcHAiI9HowCgYIKoZIzj0EAwIw\nHDEaMBgGA1UEAwwRY2xvZGUtdGVzdC1yb290LTEwIBcNMjYxMTIxMTc1ODQwWhgP\nMjEyNjEwMjgxNzU4NDBaMBwxGjAYBgNVBAMMEWNsb2RlLXRlc3Qtcm9vdC0xMFkw\nEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAExAcSi/K3beH7R6AF+y10lEOWs3xvMUV1\nyF1EvT4EwL/DMPx9QdVuvALZndlepEX/YH8DOdWP4rF0VcCAKJMyyqNTMFEwHQYD\nVR0OBBYEFCaT86WUF14IWgV5AqFsQDSCtLqiMB8GA1UdIwQYMBaAFCaT86WUF14I\nWgV5AqFsQDSCtLqiMA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSAAwRQIg\nYlbCnRAReTMsuctkt65UchmQbXy8SgBqrCuN5uEgfoYCIQChwPmV2eRPd4ClXl8M\ntdNkEUrVghmlRIVwV4aNcf2vzw==\n-----END CERTIFICATE-----\n';
  const C2 = '-----BEGIN CERTIFICATE-----\nMIIBjjCCATWgAwIBAgIUYS04dy9AzXAK6jbx3yMjG8A2f80wCgYIKoZIzj0EAwIw\nHDEaMBgGA1UEAwwRY2xvZGUtdGVzdC1yb290LTIwIBcNMjYxMTIxMTc1ODQwWhgP\nMjEyNjEwMjgxNzU4NDBaMBwxGjAYBgNVBAMMEWNsb2RlLXRlc3Qtcm9vdC0yMFkw\nEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAETs5Oe9euW0L6irXPxjZfXdomXmrpgR+g\npkOwcJHxq4yQbWbBo+yj2iYnJEve0cRgW6sdO3YQ0LSkFb4It5UGTaNTMFEwHQYD\nVR0OBBYEFOSaXiuETDu/bALLgZDlApSLi0IjMB8GA1UdIwQYMBaAFOSaXiuETDu/\nbALLgZDlApSLi0IjMA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDRwAwRAIg\nLHmYLBXTYq4GhQMCkROB7BGaePV76zlG8r2EPk5wWsgCIAEJWr4o8aNHaQ+41oZl\n7X7ylgoTgfYmtTUbWuBITA3l\n-----END CERTIFICATE-----\n';
  const tls = require('tls');
  const der = Buffer.from(C1.split('\n').filter((l) => l && !l.startsWith('-----')).join(''), 'base64');
  const pem = (label, b64) => `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
  const KEY = pem('PRIVATE KEY', 'AA==');
  const TRUNC = `${C1.split('\n').slice(0, 4).join('\n')}\n-----END CERTIFICATE-----\n`;
  const CORRUPT = pem('CERTIFICATE', 'not base64 at all !!!');
  const JUNK = pem('CERTIFICATE', Buffer.concat([der, Buffer.from([0])]).toString('base64').replace(/.{64}/g, '$&\n').trim());
  const UNTERMINATED = '-----BEGIN CERTIFICATE-----\nMIIB\n';
  const C = [
    ['one good', { ca: [C1] }], ['good string', { ca: C1 }], ['good buffer', { ca: Buffer.from(C1) }],
    ['good u8', { ca: new Uint8Array(Buffer.from(C1)) }], ['two good in one', { ca: [C1 + C2] }], ['two good entries', { ca: [C1, C2] }],
    ['good with comments', { ca: [`# my root\n${C1}\n# end\n`] }], ['crlf good', { ca: [C1.replace(/\n/g, '\r\n')] }],
    ['no newline at end', { ca: [C1.trimEnd()] }], ['indented', { ca: [C1.split('\n').map((l) => `  ${l}`).join('\n')] }],
    ['trusted cert label', { ca: [C1.replace(/CERTIFICATE/g, 'TRUSTED CERTIFICATE')] }],
    ['x509 cert label', { ca: [C1.replace(/CERTIFICATE/g, 'X509 CERTIFICATE')] }],
    ['empty', { ca: [''] }], ['empty string', { ca: '' }], ['whitespace', { ca: ['\n  \n'] }], ['garbage', { ca: ['garbage'] }],
    ['garbage string', { ca: 'garbage' }], ['empty buffer', { ca: Buffer.alloc(0) }], ['empty buffer in array', { ca: [Buffer.alloc(0)] }],
    ['a key, not a cert', { ca: [KEY] }], ['good plus key in one', { ca: [C1 + KEY] }], ['key then corrupt in one', { ca: [KEY + CORRUPT] }],
    ['key with bad base64', { ca: [pem('PRIVATE KEY', '!!!!')] }],
    ['other pem type', { ca: [pem('FOO', 'AAAA')] }], ['other type, bad base64', { ca: [pem('FOO', '!!!!')] }],
    ['other type bad, then good', { ca: [pem('FOO', '!!!!') + C1] }], ['empty block', { ca: ['-----BEGIN FOO-----\n-----END FOO-----\n'] }],
    ['empty cert block', { ca: ['-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----\n'] }], ['unpadded base64', { ca: [pem('FOO', 'AAA')] }],
    ['truncated', { ca: [TRUNC] }], ['corrupt block', { ca: [CORRUPT] }], ['corrupt string', { ca: CORRUPT }],
    ['empty SEQUENCE as a cert', { ca: [pem('CERTIFICATE', 'MAA=')] }], ['good, one trailing byte', { ca: [JUNK] }],
    ['mismatched END', { ca: [C1.replace('END CERTIFICATE', 'END FOO')] }], ['two BEGINs', { ca: [`-----BEGIN CERTIFICATE-----\n${C1}`] }],
    ['header lines', { ca: [C1.replace('-----\n', '-----\nProc-Type: 4,ENCRYPTED\n\n')] }],
    ['unterminated', { ca: [UNTERMINATED] }], ['good then unterminated', { ca: [C1 + UNTERMINATED] }],
    ['good plus corrupt in one', { ca: [C1 + CORRUPT] }], ['corrupt then good in one', { ca: [CORRUPT + C1] }],
    ['truncated then good in one', { ca: [TRUNC + C1] }], ['good then truncated in one', { ca: [C1 + TRUNC] }],
    ['good then garbage text', { ca: [`${C1}garbage`] }], ['garbage then good', { ca: [`garbage\n${C1}`] }],
    ['good, corrupt entries', { ca: [C1, CORRUPT] }], ['empty then good entries', { ca: ['', C1] }], ['empty array', { ca: [] }],
    ['undefined ca', { ca: undefined }], ['null ca', { ca: null }], ['false', { ca: false }], ['zero', { ca: 0 }],
    ['no options', undefined], ['empty options', {}], ['options null', null], ['options a string', 'nope'], ['options a number', 7],
    ['options an array', [C1]],
    ['number', { ca: 42 }], ['ca true', { ca: true }], ['number in array', { ca: [C1, 42] }], ['garbage then number', { ca: ['garbage', 42] }],
    ['object in array', { ca: [{}] }], ['null in array', { ca: [null] }],
  ];
  const out = [];
  for (const [name, opts] of C) {
    try { const c = tls.createSecureContext(opts); out.push([name, 'ok', typeof c, typeof (c && c.context)]); }
    catch (e) { out.push([name, 'threw', e.name, e.code, e.message]); }
  }
  return out;
};
