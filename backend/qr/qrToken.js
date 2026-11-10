// backend/qr/qrToken.js — rotating QR badge codes (AETHER_QR_CREDENTIALS)
//
// A code is "AQ1:" + 39 base32 characters (QR alphanumeric mode, so the symbol
// stays small and reader cameras lock on fast). The 24 bytes behind it are:
//   0..3   badge id        (uint32, big-endian)
//   4..7   time window     (uint32, big-endian) = floor(unix seconds / windowSec)
//   8..23  HMAC-SHA256(badge secret, bytes 0..7), first 16 bytes
// The phone holds the badge secret and makes a new code every window; Aether
// holds the same secret and checks the MAC, the window and the badge's state.
'use strict';

const crypto = require('crypto');

const PREFIX = 'AQ1:';
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOKEN_RE = /AQ1:([A-Z2-7]{39})/i;

function b32encode(buf) {
  let bits = 0, val = 0, out = '';
  for (const b of buf) {
    val = ((val << 8) | b) & 0xFFFF; bits += 8;
    while (bits >= 5) { out += B32[(val >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(val << (5 - bits)) & 31];
  return out;
}

function b32decode(str) {
  let bits = 0, val = 0; const out = [];
  for (const ch of String(str).toUpperCase()) {
    const v = B32.indexOf(ch);
    if (v < 0) return null;
    val = ((val << 5) | v) & 0xFFFF; bits += 5;
    if (bits >= 8) { out.push((val >>> (bits - 8)) & 0xFF); bits -= 8; }
  }
  return Buffer.from(out);
}

function windowOf(windowSec, nowMs = Date.now()) { return Math.floor(nowMs / 1000 / windowSec); }

function mac(secretHex, head) {
  return crypto.createHmac('sha256', Buffer.from(secretHex, 'hex')).update(head).digest().subarray(0, 16);
}

function makeToken(id, secretHex, win) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(id >>> 0, 0); head.writeUInt32BE(win >>> 0, 4);
  return PREFIX + b32encode(Buffer.concat([head, mac(secretHex, head)]));
}

// Find a code inside whatever the reader sent (some readers add a prefix,
// suffix, CR/LF or change case). Returns { id, win, tag, head } or null.
function parseToken(text) {
  const m = TOKEN_RE.exec(String(text || ''));
  if (!m) return null;
  const buf = b32decode(m[1]);
  if (!buf || buf.length < 24) return null;
  return { id: buf.readUInt32BE(0), win: buf.readUInt32BE(4), tag: buf.subarray(8, 24), head: buf.subarray(0, 8), token: PREFIX + m[1].toUpperCase() };
}

function tagOk(secretHex, parsed) {
  const want = mac(secretHex, parsed.head);
  return want.length === parsed.tag.length && crypto.timingSafeEqual(want, parsed.tag);
}

module.exports = { PREFIX, TOKEN_RE, b32encode, b32decode, windowOf, makeToken, parseToken, tagOk };
