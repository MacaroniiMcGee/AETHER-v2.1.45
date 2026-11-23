// trace/redact.js — keep secrets out of everything Event Trace stores or shows.   AETHER_TRACE
//
// Two layers:
//   scrub(value)        deep copy with secrets replaced by "[redacted …]" — what the page, exports and the
//                       events file get. Covers secret-looking keys at any depth, Bearer/Basic values inside
//                       any string (also inside arrays such as MQTT "RequestHeader": ["Authorization:Bearer …"]),
//                       bare JWTs, AWS presigned-URL parameters and cookies.
//   Vault               the original payloads, one file per run (mode 600), read only through reveal(), and
//                       every reveal is appended to the run's reveal log. allowRaw=false turns reveal off.
'use strict';

const fs = require('fs');
const path = require('path');

const SECRET_KEY = /pass(word)?|passwd|secret|token|cookie|authori[sz]ation|^auth$|signature|api[-_]?key|private[-_]?key|session[-_]?id|^sid$|jwt|credentials?secret|^pin$|^pincode$|x-amz-(security-token|signature|credential)/i;
const JWT = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
const BEARER = /\b(Bearer|Basic|Digest)\s+[A-Za-z0-9._~+/=-]{8,}[^\s"',]*/gi;
const AMZ = /([?&]X-Amz-(?:Security-Token|Signature|Credential)=)[^&\s"]+/gi;
const COOKIE = /\b((?:Set-)?Cookie\s*:\s*)[^\r\n"]+/gi;

function scrubString(s) {
  if (typeof s !== 'string' || s.length < 8) return s;
  return s
    .replace(BEARER, (_m, kind) => `${kind} [redacted]`)
    .replace(JWT, m => `[redacted JWT ${m.length}]`)
    .replace(AMZ, (_m, k) => `${k}[redacted]`)
    .replace(COOKIE, (_m, k) => `${k}[redacted]`);
}

/** Deep copy with secrets removed. Never throws; depth-limited. */
function scrub(v, depth = 0) {
  if (depth > 24) return '[too deep]';
  if (typeof v === 'string') return scrubString(v);
  if (Array.isArray(v)) return v.map(x => scrub(x, depth + 1));
  if (v && typeof v === 'object') {
    if (Buffer.isBuffer(v)) return `[${v.length} bytes]`;
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (SECRET_KEY.test(k) && x !== null && x !== undefined && x !== '' && typeof x !== 'boolean') {
        out[k] = typeof x === 'string' ? `[redacted ${x.length}]` : '[redacted]';
      } else out[k] = scrub(x, depth + 1);
    }
    return out;
  }
  return v;
}

/** True when scrub() would change something (the page offers "Show plain text" only then). */
function hasSecrets(v) {
  try { return JSON.stringify(scrub(v)) !== JSON.stringify(v); } catch { return false; }
}

class Vault {
  /** @param {string} dir run folder */
  constructor(dir) {
    this.file = path.join(dir, 'vault.jsonl');
    this.log = path.join(dir, 'reveals.log');
    this.index = new Map();   // event id -> raw (kept in memory for the live run; file is the durable copy)
    this.dir = dir;
  }
  put(id, raw) {
    if (raw === undefined) return;
    this.index.set(id, raw);
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify({ id, raw }) + '\n', { mode: 0o600 });
      try { fs.chmodSync(this.file, 0o600); } catch { /* */ }
    } catch { /* never break the feed */ }
  }
  get(id) {
    if (this.index.has(id)) return this.index.get(id);
    try {
      for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
        if (!line || !line.includes(`"id":${JSON.stringify(id)}`)) continue;
        const j = JSON.parse(line);
        if (j.id === id) return j.raw;
      }
    } catch { /* */ }
    return undefined;
  }
  /** Return the plain payload and record who asked. */
  reveal(id, who) {
    const raw = this.get(id);
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(this.log, `${new Date().toISOString()}\t${who || '?'}\t${id}\t${raw === undefined ? 'missing' : 'shown'}\n`, { mode: 0o600 });
    } catch { /* */ }
    return raw;
  }
  reveals() {
    try {
      return fs.readFileSync(this.log, 'utf8').split('\n').filter(Boolean).map(l => { const [at, who, id, what] = l.split('\t'); return { at, who, id, what }; });
    } catch { return []; }
  }
}

module.exports = { scrub, scrubString, hasSecrets, Vault };
