// credentialMap.js — exact bit maps for credential formats, and the one encoder
// both Wiegand and OSDP use.
//
// A map says, for every bit of the frame, what it is:
//   { bits: 37,
//     fields: [{ key: 'facility'|'card'|'issue'|'tech'|'fixed'|..., start, len, value? }],
//     parity: [{ bit, type: 'even'|'odd'|'xor', covers: [positions] }],
//     scramble?: { facility: [positions MSB-first], card: [...] },
//     status: 'verified' | 'defined' | 'custom',
//     source: 'spec' | 'definition' | 'layout' | 'fallback' | 'user' }
// Positions are 1-based; bit 1 is the first bit on the wire (MSB).
// Parity entries are computed in list order, so a later parity bit (e.g. the
// whole-frame parity of Corporate 1000) sees the earlier ones.
//
// status:
//   verified — checked against the published layout (HID and equivalents)
//   defined  — the library's own definition is complete and consistent; sent as defined
//   custom   — the library's definition was incomplete or didn't add up; this map is a
//              best-effort repair. Shown with a "Custom" tag. Also used for user formats.

'use strict';

const range = (a, b) => { const r = []; for (let i = a; i <= b; i++) r.push(i); return r; };

// ── Published layouts ─────────────────────────────────────────────────────────
function std(bits, fields, opts = {}) {
  // Standard Wiegand: EP at bit 1, OP at the last bit, data in between split in
  // half; with an odd number of data bits the middle bit is covered by both.
  const n = bits - 2, half = Math.ceil(n / 2);
  return {
    bits, fields,
    parity: [
      { bit: 1, type: 'even', covers: range(2, 1 + half) },
      { bit: bits, type: 'odd', covers: range(bits - half, bits - 1) },
    ],
    ...opts,
  };
}
function corp1000(bits, fcLen, cnLen) {
  // HID Corporate 1000 (same masks as Proxmark3's C1k35s / C1k48s packers):
  //   35-bit: bit 2 even over 3,4,6,7…33,34;  bit 35 odd over 2,3,5,6…32,33
  //   48-bit: bit 2 even over 4,5,7,8…46,47;  bit 48 odd over 3,4,6,7…45,46
  //   then bit 1 odd over every other bit.
  const ev = bits === 48 ? range(4, 47).filter(p => p % 3 !== 0) : range(3, bits - 1).filter(p => p % 3 !== 2);
  const od = bits === 48 ? range(3, 46).filter(p => p % 3 !== 2) : range(2, bits - 1).filter(p => p % 3 !== 1);
  return {
    bits,
    fields: [{ key: 'facility', start: 3, len: fcLen }, { key: 'card', start: 3 + fcLen, len: cnLen }],
    parity: [
      { bit: 2, type: 'even', covers: ev },
      { bit: bits, type: 'odd', covers: od },
      { bit: 1, type: 'odd', covers: range(2, bits) },
    ],
  };
}
const H26 = () => std(26, [{ key: 'facility', start: 2, len: 8 }, { key: 'card', start: 10, len: 16 }]);
const H34 = () => std(34, [{ key: 'facility', start: 2, len: 16 }, { key: 'card', start: 18, len: 16 }]);
const H37F = () => std(37, [{ key: 'facility', start: 2, len: 16 }, { key: 'card', start: 18, len: 19 }]);
const H37 = () => std(37, [{ key: 'card', start: 2, len: 35 }]);
const RAW = (bits) => ({ bits, fields: [{ key: 'card', start: 1, len: bits }], parity: [] });

const VERIFIED = {
  w26: H26, h10301: H26, awid26: H26,
  w34: H34, h10306: H34, awid34: H34,
  w37: H37F, h10304: H37F, awid37: H37F,
  h10302: H37,
  w35: () => corp1000(35, 12, 20), corp1000_35: () => corp1000(35, 12, 20),
  w48: () => corp1000(48, 22, 23), corp1000_48: () => corp1000(48, 22, 23),
  w32: () => RAW(32), csn32: () => RAW(32), mifare_32: () => RAW(32), wl32_5: () => RAW(32),
  csn56: () => RAW(56), mifare_56: () => RAW(56), csn64: () => RAW(64), csn80: () => RAW(80),
  generic_8: () => RAW(8), generic_16: () => RAW(16),
};

// ── Layout-string parser ──────────────────────────────────────────────────────
// Understands both "[EP][F7-F0][C15-C0][OP]" and "[EP:1][FC:2-9][CN:10-25][OP:26]".
const FIELD_KEYS = [
  [/^(F|S|FC|SITE)$/, 'facility'],
  [/^(C|CN|ID|CSN|CHID)$/, 'card'],
  [/^(I|IL)$/, 'issue'],
  [/^(T|TC)$/, 'tech'],
  [/^A$/, 'agency'],
  [/^(EXP|CS|IS|HMAC|XOR)$/, 'extra'],
];
function keyOf(name) { for (const [re, k] of FIELD_KEYS) if (re.test(name)) return k; return null; }

function parseLayout(layout, bits) {
  if (!layout || !/^\s*\[/.test(layout)) return null;
  const toks = layout.match(/\[[^\]]*\]/g);
  if (!toks || toks.join('') !== layout.replace(/\s+/g, '')) return null;
  const items = []; let rest = -1;
  for (const raw of toks) {
    const t = raw.slice(1, -1);
    let m;
    if (t === '...') return null;
    if ((m = t.match(/^([A-Z]+):(\d+)(?:-(\d+))?$/))) {            // FC:2-9 / EP:1 / OP:34-35
      const len = (m[3] ? +m[3] : +m[2]) - +m[2] + 1;
      if (m[1] === 'EP' || m[1] === 'OP') { for (let i = 0; i < len; i++) items.push({ par: m[1] }); continue; }
      const k = keyOf(m[1]); if (!k) return null;
      items.push({ key: k, len, at: +m[2] }); continue;
    }
    if ((m = t.match(/^0:(\d+)(?:-(\d+))?$/))) { items.push({ key: 'fixed', len: (m[2] ? +m[2] : +m[1]) - +m[1] + 1, value: 0 }); continue; }
    if ((m = t.match(/^([A-Z]+?)(\d+)-\1?0$/)) || (m = t.match(/^([A-Z]+)(\d+)-[A-Z]*0$/))) {  // F7-F0, ID19-ID0
      const k = keyOf(m[1]); if (!k) return null;
      items.push({ key: k, len: +m[2] + 1 }); continue;
    }
    if ((m = t.match(/^X(\d*)$/))) { items.push({ key: 'fixed', len: m[1] ? +m[1] : 1, value: 0 }); continue; }
    if (/^[01]+$/.test(t)) { items.push({ key: 'fixed', len: t.length, value: parseInt(t, 2) }); continue; }
    if ((m = t.match(/^(EP|OP)(\d*)$/)) || (m = t.match(/^(EP|OP)-(whole|inter|pairs)$/))) { items.push({ par: m[1], kind: m[2] || '' }); continue; }
    if ((m = t.match(/^([A-Z]+)-bits$/))) { const k = keyOf(m[1]); if (!k || rest >= 0) return null; rest = items.length; items.push({ key: k, len: 0 }); continue; }
    return null;
  }
  const used = items.reduce((s, i) => s + (i.par ? 1 : i.len), 0);
  if (rest >= 0) { if (used >= bits) return null; items[rest].len = bits - used; }
  else if (used !== bits) return null;
  // place
  let pos = 1; const fields = [], pars = [];
  for (const it of items) {
    if (it.par) { pars.push({ bit: pos, par: it.par, kind: it.kind }); pos += 1; continue; }
    if (it.at && it.at !== pos) return null;
    if (it.len > 0) fields.push({ key: it.key, start: pos, len: it.len, ...(it.value != null ? { value: it.value } : {}) });
    pos += it.len;
  }
  return { fields, pars };
}

// Standard parity for the data between the first and last parity bit
function stdParity(pars, bits) {
  if (pars.length === 0) return [];
  if (pars.length === 1) {
    const p = pars[0];
    return [{ bit: p.bit, type: p.par === 'EP' ? 'even' : 'odd', covers: range(1, bits).filter(x => x !== p.bit) }];
  }
  const a = pars[0].bit, b = pars[pars.length - 1].bit;
  const data = range(a + 1, b - 1).filter(x => !pars.some(p => p.bit === x));
  const half = Math.ceil(data.length / 2);
  const out = [
    { bit: a, type: pars[0].par === 'EP' ? 'even' : 'odd', covers: data.slice(0, half) },
    { bit: b, type: pars[pars.length - 1].par === 'EP' ? 'even' : 'odd', covers: data.slice(data.length - half) },
  ];
  for (const p of pars.slice(1, -1)) out.push({ bit: p.bit, type: p.par === 'EP' ? 'even' : 'odd', covers: data });
  return out;
}
const covers = (s) => { const [a, b] = String(s).split('-').map(Number); return range(a, b || a); };

// ── Build the map for one library format ──────────────────────────────────────
function buildMap(f) {
  const bits = f.bits;
  if (VERIFIED[f.id]) return { ...VERIFIED[f.id](), status: 'verified', source: 'spec' };

  const parsed = parseLayout(f.layout, bits);
  const complexParity = ['interleaved', 'multi-row', 'xor-byte', 'custom'].includes(f.parity);

  if (parsed) {
    // Some layouts name the card field "A" (account); use it as the card number
    if (!parsed.fields.some(q => q.key === 'card')) {
      const a = parsed.fields.find(q => q.key === 'agency' && q.len === f.cardBits);
      if (a) a.key = 'card';
    }
    let parity;
    if (f.parityEven && f.parityOdd && parsed.pars.length === 2) {
      parity = [
        { bit: f.parityEven.bit, type: 'even', covers: covers(f.parityEven.covers) },
        { bit: f.parityOdd.bit, type: 'odd', covers: covers(f.parityOdd.covers) },
      ];
    } else if (f.parity === 'xor-byte') {
      // Honeywell-style: last 8 bits = XOR of the preceding bytes
      const x = parsed.fields.find(q => q.key === 'extra' && q.len === 8 && q.start === bits - 7);
      parity = x ? [{ bit: x.start, type: 'xor', covers: range(1, bits - 8), len: 8 }] : [];
      if (x) parsed.fields.splice(parsed.fields.indexOf(x), 1);
    } else {
      parity = stdParity(parsed.pars, bits);
    }
    const consistent = !complexParity && parsed.pars.every(p => !p.kind) && !(parsed.pars.length > 2);
    return {
      bits, fields: parsed.fields, parity,
      status: consistent ? 'defined' : 'custom', source: 'layout',
      ...(consistent ? {} : { note: `This format uses special parity ("${f.parity}"${parsed.pars.length > 2 ? `, ${parsed.pars.length} parity bits` : ''}); it's approximated with standard parity. Check it in the builder.` }),
    };
  }

  // Scrambled Indala with an explicit bit map (only if the map itself is sound)
  const bp = f.bitPositions;
  if (bp && bp.siteCode && bp.cardNumber && new Set([...bp.siteCode, ...bp.cardNumber]).size === bp.siteCode.length + bp.cardNumber.length) {
    return {
      bits, fields: [], parity: [],
      scramble: { facility: f.bitPositions.siteCode, card: f.bitPositions.cardNumber },
      status: 'custom', source: 'definition', note: 'Scrambled bit order taken from the library definition.',
    };
  }

  // No usable layout: build from the bit counts
  const scrambleBroken = bp && bp.siteCode && bp.cardNumber;
  const fb = f.facilityBits || 0, ib = f.issueLevel || 0;
  const hasPar = f.parity && f.parity !== 'none';
  const pb = hasPar ? 2 : 0;
  let cb = f.cardBits || 0;
  const want = pb + ib + fb + cb;
  let status = 'defined', note;
  if (want !== bits) {
    status = 'custom';
    if (want > bits) { cb = Math.max(0, bits - pb - ib - fb); note = `Library says ${fb}+${f.cardBits} data bits, which doesn't fit ${bits} bits; card number cut to ${cb} bits.`; }
    else note = `Library defines only ${ib + fb + cb} data bits of ${bits - pb}; the unused ${bits - want} bits are sent as 0 before the facility code.`;
  }
  if (scrambleBroken) { status = 'custom'; note = (note ? note + ' ' : '') + 'The library\'s scrambled bit order uses some bits twice, so plain order is used.'; }
  if (complexParity) { status = 'custom'; note = (note ? note + ' ' : '') + `Parity type "${f.parity}" approximated with standard parity.`; }
  const pad = Math.max(0, bits - pb - ib - fb - cb);
  const fields = []; let pos = hasPar ? 2 : 1;
  if (pad) { fields.push({ key: 'fixed', start: pos, len: pad, value: 0 }); pos += pad; }
  if (ib) { fields.push({ key: 'issue', start: pos, len: ib }); pos += ib; }
  if (fb) { fields.push({ key: 'facility', start: pos, len: fb }); pos += fb; }
  if (cb) { fields.push({ key: 'card', start: pos, len: cb }); pos += cb; }
  const m = hasPar ? std(bits, fields) : { bits, fields, parity: [] };
  return { ...m, status, source: 'fallback', ...(note ? { note } : {}) };
}

// ── Validation and ranges ─────────────────────────────────────────────────────
function fieldLen(map, key) {
  if (map.scramble && map.scramble[key]) return map.scramble[key].length;
  return (map.fields || []).filter(x => x.key === key).reduce((s, x) => s + x.len, 0);
}
function ranges(map) {
  const mx = (n) => n <= 0 ? 0 : (n >= 53 ? (2n ** BigInt(n) - 1n).toString() : 2 ** n - 1);
  return {
    facilityBits: fieldLen(map, 'facility'), cardBits: fieldLen(map, 'card'), issueBits: fieldLen(map, 'issue'),
    maxFacility: mx(fieldLen(map, 'facility')), maxCard: mx(fieldLen(map, 'card')), maxIssueLevel: mx(fieldLen(map, 'issue')),
  };
}

function checkMap(map) {
  const errs = [];
  const N = map && map.bits;
  if (!Number.isInteger(N) || N < 1 || N > 256) return ['Total bits must be a whole number from 1 to 256'];
  const isPos = (x) => Number.isInteger(x) && x >= 1 && x <= N;
  for (const f of map.fields || []) {
    if (!f || !isPos(f.start) || !Number.isInteger(f.len) || f.len < 1 || f.start + f.len - 1 > N) return [`Field "${f && (f.label || f.key)}" must lie within bits 1-${N}`];
    if (f.key === 'fixed' && (!Number.isInteger(Number(f.value || 0)) || Number(f.value || 0) < 0 || BigInt(f.value || 0) >= (1n << BigInt(f.len)))) errs.push(`Fixed bits at ${f.start} can't hold the value ${f.value}`);
  }
  for (const p of map.parity || []) {
    const w = p && p.type === 'xor' ? (p.len || 8) : 1;
    if (!p || !isPos(p.bit) || p.bit + w - 1 > N || !Array.isArray(p.covers) || p.covers.length > N) return [`Parity bits must lie within bits 1-${N}`];
    if (!p.covers.every(Number.isInteger)) return ['Parity coverage must be bit numbers'];
  }
  if (map.scramble) for (const list of Object.values(map.scramble)) if (!Array.isArray(list) || list.length > N || !list.every(isPos)) return [`Scrambled bits must lie within 1-${N}`];
  const owner = new Array(N + 1).fill(null);
  const claim = (p, what) => {
    if (p < 1 || p > N) { errs.push(`${what} uses bit ${p}, outside 1-${N}`); return; }
    if (owner[p]) errs.push(`Bit ${p} is used by both ${owner[p]} and ${what}`); else owner[p] = what;
  };
  for (const f of map.fields || []) for (let i = 0; i < f.len; i++) claim(f.start + i, f.label || f.key);
  if (map.scramble) for (const [k, list] of Object.entries(map.scramble)) list.forEach(p => claim(p, k));
  for (const p of map.parity || []) {
    const w = p.type === 'xor' ? (p.len || 8) : 1;
    for (let i = 0; i < w; i++) claim(p.bit + i, `${p.type} parity`);
    for (const c of p.covers || []) if (c < 1 || c > N) errs.push(`Parity at bit ${p.bit} covers bit ${c}, outside the frame`);
  }
  return errs;
}

// ── Encode ────────────────────────────────────────────────────────────────────
function encode(map, values = {}) {
  const N = map.bits;
  const out = new Array(N + 1).fill(0);   // 1-based
  const who = new Array(N + 1).fill('pad');
  const val = (k) => BigInt(values[k] ?? 0);

  const place = (key, start, len, v) => {
    const max = (1n << BigInt(len)) - 1n;
    if (v < 0n || v > max) throw new RangeError(`${label(key)} must be 0-${max} for this format (got ${v})`);
    for (let i = 0; i < len; i++) { out[start + i] = Number((v >> BigInt(len - 1 - i)) & 1n); who[start + i] = key; }
  };

  // split a value across several fields of the same key (MSB part first)
  const byKey = {};
  for (const f of map.fields || []) (byKey[f.key] ||= []).push(f);
  for (const [key, list] of Object.entries(byKey)) {
    if (key === 'fixed') { list.forEach(f => place('fixed', f.start, f.len, BigInt(f.value || 0))); continue; }
    const total = list.reduce((s, f) => s + f.len, 0);
    const v = val(key);
    const max = (1n << BigInt(total)) - 1n;
    if (v < 0n || v > max) throw new RangeError(`${label(key)} must be 0-${max} for this format (got ${v})`);
    let shift = total;
    for (const f of list) { shift -= f.len; place(key, f.start, f.len, (v >> BigInt(shift)) & ((1n << BigInt(f.len)) - 1n)); }
  }
  if (map.scramble) {
    for (const [key, list] of Object.entries(map.scramble)) {
      const v = val(key), n = list.length, max = (1n << BigInt(n)) - 1n;
      if (v < 0n || v > max) throw new RangeError(`${label(key)} must be 0-${max} for this format (got ${v})`);
      list.forEach((p, i) => { out[p] = Number((v >> BigInt(n - 1 - i)) & 1n); who[p] = key; });
    }
  }
  for (const p of map.parity || []) {
    if (p.type === 'xor') {
      const w = p.len || 8; let x = 0;
      for (let i = 0; i + w <= p.covers.length; i += w) {
        let b = 0; for (let j = 0; j < w; j++) b = (b << 1) | out[p.covers[i + j]]; x ^= b;
      }
      for (let j = 0; j < w; j++) { out[p.bit + j] = (x >> (w - 1 - j)) & 1; who[p.bit + j] = 'parity'; }
      continue;
    }
    const ones = p.covers.reduce((s, c) => s + out[c], 0);
    out[p.bit] = p.type === 'even' ? ones % 2 : 1 - (ones % 2);
    who[p.bit] = p.type === 'even' ? 'parity-even' : 'parity-odd';
  }
  const binary = out.slice(1).join('');
  // compress consecutive owners into segments for display
  const segments = [];
  for (let i = 1; i <= N; i++) {
    const last = segments[segments.length - 1];
    if (last && last.key === who[i] && !who[i].startsWith('parity')) { last.len++; last.bits += out[i]; }
    else segments.push({ key: who[i], start: i, len: 1, bits: String(out[i]) });
  }
  return { binary, segments };
}

function label(k) {
  return { facility: 'Facility code', card: 'Card number', issue: 'Issue level', tech: 'Tech code', agency: 'Agency code', fixed: 'Fixed bits' }[k] || k;
}

function toBytes(binary) {
  const n = Math.ceil(binary.length / 8);
  const padded = binary.padEnd(n * 8, '0');           // left-justified, zero padded
  const bytes = Buffer.alloc(n);
  for (let i = 0; i < n; i++) bytes[i] = parseInt(padded.slice(i * 8, i * 8 + 8), 2);
  return bytes;
}

// ── PIN (keypad) frames ───────────────────────────────────────────────────────
const KEY = { '0': 0, '1': 1, '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '*': 10, '#': 11 };
// mode: 'combined' (one frame, 8 bits per key), 'per-key-8' (one 8-bit frame per key),
//       'per-key-4' (one 4-bit frame per key)
function pinFrames(pin, { mode = 'combined', terminator = '#' } = {}) {
  const keys = String(pin).split('').concat(terminator ? [terminator] : []);
  for (const k of keys) if (!(k in KEY)) throw new RangeError(`"${k}" isn't a keypad key (0-9, *, #)`);
  const eight = (k) => { const v = KEY[k]; return (((~v) & 0xF) << 4 | v).toString(2).padStart(8, '0'); };
  const four = (k) => KEY[k].toString(2).padStart(4, '0');
  if (mode === 'per-key-4') return keys.map(four);
  if (mode === 'per-key-8') return keys.map(eight);
  return [keys.map(eight).join('')];
}

// Decode a bit string back into field values, and check the parity, using a map.
// Used by the OSDP trace to name a card read, and by the format analyzer.
function decodeBits(map, binary) {
  if (!map || !binary || binary.length !== map.bits) return null;
  const bit = (p) => binary[p - 1] === '1' ? 1 : 0;
  const readField = (key) => {
    const parts = (map.fields || []).filter(f => f.key === key);
    if (map.scramble && map.scramble[key]) { let v = 0n; map.scramble[key].forEach(p => { v = (v << 1n) | BigInt(bit(p)); }); return v; }
    if (!parts.length) return null;
    let v = 0n;
    for (const f of parts) for (let i = 0; i < f.len; i++) v = (v << 1n) | BigInt(bit(f.start + i));
    return v;
  };
  const fc = readField('facility'), cn = readField('card'), il = readField('issue');
  let parityOk = null;
  for (const p of map.parity || []) {
    if (p.type === 'xor') continue;
    const ones = p.covers.reduce((s, c) => s + bit(c), 0) + bit(p.bit);
    const ok = p.type === 'even' ? ones % 2 === 0 : ones % 2 === 1;
    parityOk = parityOk === null ? ok : parityOk && ok;
  }
  return {
    facility: fc == null ? null : (fc < 9007199254740991n ? Number(fc) : fc.toString()),
    card: cn == null ? null : (cn < 9007199254740991n ? Number(cn) : cn.toString()),
    issue: il == null ? null : Number(il),
    parityOk,
  };
}

module.exports = { buildMap, encode, checkMap, ranges, toBytes, pinFrames, parseLayout, label, decodeBits };
