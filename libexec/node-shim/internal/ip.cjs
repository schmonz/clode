'use strict';
// node-shim's ONE IP-literal test: node's net.isIPv4/isIPv6/isIP, as node writes them (lib/internal/net.js, the
// same two regular expressions), for every shim module that asks "is this an address?". There were four answers
// (latent-capabilities audit, D7, and two it did not list): net.cjs's hand-written split (no leading zeros, but a
// zone id of '%' or with a second '%' passed, and a non-string never coerced), http.cjs's no_proxy range check
// (accepted '01.2.3.4', so NO_PROXY=1.2.3.0-1.2.3.9 bypassed the proxy for a host node sends through it),
// connect-multiple's ipFamily (any run of hex digits, ':' and '.') and dns.lookup's literal shortcut (took
// '999.1.1.1' for an address). test/node-shim-ip.test.cjs holds this file to host node's net, case for case.
//
// Like node's, each tests String(s): a number, null or an object with a toString is coerced, never refused.
const V4_SEG = '(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])';
const V4_STR = `(?:${V4_SEG}\\.){3}${V4_SEG}`;
const IPV4_RE = new RegExp(`^${V4_STR}$`);
const V6_SEG = '(?:[0-9a-fA-F]{1,4})';
const IPV6_RE = new RegExp('^(?:'
  + `(?:${V6_SEG}:){7}(?:${V6_SEG}|:)|`
  + `(?:${V6_SEG}:){6}(?:${V4_STR}|:${V6_SEG}|:)|`
  + `(?:${V6_SEG}:){5}(?::${V4_STR}|(?::${V6_SEG}){1,2}|:)|`
  + `(?:${V6_SEG}:){4}(?:(?::${V6_SEG}){0,1}:${V4_STR}|(?::${V6_SEG}){1,3}|:)|`
  + `(?:${V6_SEG}:){3}(?:(?::${V6_SEG}){0,2}:${V4_STR}|(?::${V6_SEG}){1,4}|:)|`
  + `(?:${V6_SEG}:){2}(?:(?::${V6_SEG}){0,3}:${V4_STR}|(?::${V6_SEG}){1,5}|:)|`
  + `(?:${V6_SEG}:){1}(?:(?::${V6_SEG}){0,4}:${V4_STR}|(?::${V6_SEG}){1,6}|:)|`
  + `(?::(?:(?::${V6_SEG}){0,5}:${V4_STR}|(?::${V6_SEG}){1,7}|:))`
  + ')(?:%[0-9a-zA-Z-.:]{1,})?$');

const isIPv4 = (s) => IPV4_RE.exec(s) !== null;
const isIPv6 = (s) => IPV6_RE.exec(s) !== null;
const isIP = (s) => (isIPv4(s) ? 4 : isIPv6(s) ? 6 : 0);

module.exports = { isIPv4, isIPv6, isIP };
