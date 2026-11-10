// AETHER OSDP Academy — protocol core.
//
// Wire framing (build/parse), integrity (CRC-16 / checksum), the security block,
// and a field decoder driven by the SIA OSDP 2.2.2 machine-readable reference
// that Aether's own OSDP Trace decoder uses (spec-data.mjs). Every field name,
// enum value and page reference shown to a learner comes from that one table.
//
// Nothing here transmits anything. This module has no DOM or network access.

import SPEC from './spec-data.mjs?v=198dc99a';
export { SPEC };

export const EN = SPEC.enums;
export const hx = (n) => (n & 255).toString(16).padStart(2, '0').toUpperCase();
export const hex = (b) => Array.from(b, hx).join(' ');
export const h2 = (n) => '0x' + hx(n);

/** Parse "53 00 08 00", "0x53,0x00", "5300…" into bytes. Throws on odd or non-hex input. */
export function bytes(s) {
  if (typeof s !== 'string') throw Error('Expected a hex string');
  const t = s.replace(/0x/gi, '').replace(/[\s,;:-]/g, '');
  if (!/^(?:[\da-f]{2})*$/i.test(t)) throw Error('Use complete two-digit hex bytes, for example 53 00 08 00.');
  return t.match(/../g)?.map((x) => parseInt(x, 16)) || [];
}

/** CRC-16/AUG-CCITT as used by OSDP: poly 0x1021, init 0x1D0F, no reflection (spec 5.9, Annex E). */
export function crc(b) {
  let c = 0x1d0f;
  for (const x of b) {
    c ^= x << 8;
    for (let i = 0; i < 8; i++) c = (c & 0x8000 ? (c << 1) ^ 0x1021 : c << 1) & 0xffff;
  }
  return c;
}
/** 8-bit checksum: the byte that makes the sum of the whole message 0 modulo 256. */
export const checksum = (b) => -b.reduce((a, x) => a + x, 0) & 255;

// ── message dictionary (direction-aware) ───────────────────────────────────
export const CMD = new Map(); // code -> spec definition (CP → PD)
export const REP = new Map(); // code -> spec definition (PD → CP)
for (const c of SPEC.commands) CMD.set(parseInt(c.code, 16), c);
for (const r of SPEC.replies) REP.set(parseInt(r.code, 16), r);
export const short = (name) => String(name || '').replace(/^osdp_/, '');

// Short human titles. Definitions, layouts and page numbers come from the spec data.
const TITLE = {
  POLL: 'Poll', ID: 'Request identification', CAP: 'Request capabilities', LSTAT: 'Request local status',
  ISTAT: 'Request input status', OSTAT: 'Request output status', RSTAT: 'Request reader tamper status',
  OUT: 'Output control', LED: 'Reader LED control', BUZ: 'Reader buzzer control', TEXT: 'Reader text output',
  COMSET: 'Set address and baud', BIOREAD: 'Scan and send biometric', BIOMATCH: 'Scan and match biometric',
  KEYSET: 'Set encryption key', CHLNG: 'Secure Channel challenge', SCRYPT: 'Server cryptogram',
  ACURXSIZE: 'Controller receive size', FILETRANSFER: 'File transfer fragment', MFG: 'Manufacturer command',
  XWR: 'Extended write (smart card)', ABORT: 'Abort operation', PIVDATA: 'Get PIV data', GENAUTH: 'General authenticate',
  CRAUTH: 'Challenge/response authenticate', KEEPACTIVE: 'Keep reader active',
  ACK: 'Acknowledge', NAK: 'Negative acknowledge', PDID: 'Device identification', PDCAP: 'Device capabilities',
  LSTATR: 'Local status report', ISTATR: 'Input status report', OSTATR: 'Output status report', RSTATR: 'Reader tamper report',
  RAW: 'Card data (raw bits)', FMT: 'Card data (formatted, deprecated)', KEYPAD: 'Keypad data', COM: 'Communication settings',
  BIOREADR: 'Biometric data', BIOMATCHR: 'Biometric match result', CCRYPT: 'Client cryptogram', RMAC_I: 'Initial reply MAC',
  BUSY: 'Busy', FTSTAT: 'File transfer status', PIVDATAR: 'PIV data', GENAUTHR: 'Authentication response',
  CRAUTHR: 'Challenge response', MFGSTATR: 'Manufacturer status (deprecated)', MFGERRR: 'Manufacturer error (deprecated)',
  MFGREP: 'Manufacturer reply', XRD: 'Extended read (smart card)',
};

export function defFor(code, reply) { return (reply ? REP : CMD).get(code) || null; }

/** [SHORT, title, description, def] for a code in a direction. */
export function entryFor(code, reply) {
  const d = defFor(code, reply);
  if (!d) {
    const other = defFor(code, !reply);
    return ['UNKNOWN', `Unknown ${reply ? 'reply' : 'command'} ${h2(code)}`,
      other ? `${h2(code)} is ${short(other.name)} only in the ${reply ? 'command' : 'reply'} direction. Check the ADDR reply bit.`
        : 'Not assigned in SIA OSDP 2.2.2 Annex A. Reserved codes should be answered with NAK 0x03; vendor data belongs in MFG/MFGREP.', null];
  }
  const n = short(d.name);
  return [n, TITLE[n] || n, d.description, d];
}

/** Legacy table keyed by code: commands first, then reply-only codes. */
export const commands = {};
for (const [k, d] of CMD) commands[k] = entryFor(k, false).slice(0, 3);
for (const [k, d] of REP) if (!commands[k]) commands[k] = entryFor(k, true).slice(0, 3);

const CAPS = EN.pdcapFunctionCodes.codes;
export const caps = ['Unused', ...Array.from({ length: 16 }, (_, i) => CAPS[String(i + 1)]?.name || 'Reserved')];
export const nak = Array.from({ length: 10 }, (_, i) => EN.nakErrorCode.values[h2(i)]);
export const SCB_TYPES = EN.securityBlockType.values;
export const TIMING = SPEC.packet.timing;
export const BEHAVIORS = Object.fromEntries(SPEC.behaviors.map((b) => [b.id, b]));
export const pageRef = (p) => (p == null ? '' : Array.isArray(p) ? `pp. ${p[0]}–${p[p.length - 1]}` : `p. ${p}`);

/** Look up an enum value. Understands "0x01-0x7F" and "-32768..-4" range keys. */
export function enumText(table, val) {
  const vals = table && (table.values || table);
  if (!vals || typeof vals !== 'object') return null;
  if (vals[h2(val)] != null) return vals[h2(val)];
  if (vals[String(val)] != null) return vals[String(val)];
  for (const [k, v] of Object.entries(vals)) {
    let m = k.match(/^0x([0-9a-f]+)\s*-\s*0x([0-9a-f]+)$/i);
    if (m && val >= parseInt(m[1], 16) && val <= parseInt(m[2], 16)) return v;
    m = k.match(/^(-?\d+)\.\.(-?\d+)$/);
    if (m && val >= +m[1] && val <= +m[2]) return v;
  }
  return null;
}
const enumRef = (path) => (path && path.startsWith('enums.') ? EN[path.slice(6)] : null);

// ── build ──────────────────────────────────────────────────────────────────
/**
 * Build a frame. address 0–127, sequence 0–3, scb = full security block bytes
 * ([LEN, TYPE, ...DATA]). mac = 4 bytes appended after the payload (training only:
 * the builder never computes a real MAC).
 */
export function build({ address = 0, reply = false, sequence = 1, command = 0x60, payload = [], crcMode = true, scb = [], mac = [] } = {}) {
  if (!Number.isInteger(address) || address < 0 || address > 127) throw Error('Address must be 0–127');
  if (!Number.isInteger(sequence) || sequence < 0 || sequence > 3) throw Error('Sequence must be 0–3');
  if (!Number.isInteger(command) || command < 0 || command > 255) throw Error('Code must be one byte');
  for (const x of [...payload, ...scb, ...mac]) if (!Number.isInteger(x) || x < 0 || x > 255) throw Error('Every byte must be 0–255');
  if (scb.length && (scb.length < 2 || scb[0] !== scb.length)) throw Error('Security block: first byte must equal its own length (at least 2)');
  const len = 6 + scb.length + payload.length + mac.length + (crcMode ? 2 : 1);
  if (len > 65535) throw Error('Frame exceeds the 16-bit length field');
  const b = [0x53, address | (reply ? 0x80 : 0), len & 255, len >> 8, sequence | (crcMode ? 4 : 0) | (scb.length ? 8 : 0), ...scb, command, ...payload, ...mac];
  if (crcMode) { const c = crc(b); b.push(c & 255, c >> 8); } else b.push(checksum(b));
  return b;
}

// ── parse ──────────────────────────────────────────────────────────────────
/**
 * Parse one complete frame (an optional leading FF mark is allowed).
 * Throws only when the bytes cannot be laid out as a frame at all; everything
 * else (bad check, length mismatch, reserved bits…) is reported in `issues`
 * (integrity/structure) or `warnings` (protocol-rule observations).
 */
export function parse(input) {
  const raw = typeof input === 'string' ? bytes(input) : Array.from(input);
  const marked = raw[0] === 0xff;
  const b = marked ? raw.slice(1) : raw;
  const issues = [], warnings = [];
  if (b.length < 7) throw Error(`Truncated: ${b.length} bytes. The smallest frame (checksum mode, no data) is 7 bytes.`);
  if (b[0] !== 0x53) throw Error(`First byte is ${h2(b[0])}; a frame starts with SOM 0x53 (an optional 0xFF mark may come before it).`);
  const length = b[2] | (b[3] << 8), ctrl = b[4];
  const crcMode = !!(ctrl & 4), trailer = crcMode ? 2 : 1, end = b.length - trailer;
  if (length !== b.length) issues.push(`LEN says ${length} bytes but ${b.length} were captured`);
  if (length < 7 || length > 1440) warnings.push(`LEN ${length} is outside the 7–1440 range a receiver must handle (spec frame-integrity rule)`);
  if (ctrl & 0xf0) issues.push(`Reserved CTRL bits 4–7 are set (${h2(ctrl)}); they shall be 0`);
  let at = 5, sb = [], type = null;
  if (ctrl & 8) {
    const n = b[5];
    if (n < 2 || 5 + n >= end) throw Error(`Security block length ${n} is invalid or runs past the end of the frame`);
    sb = b.slice(5, 5 + n); type = sb[1]; at += n;
  }
  const command = b[at], reply = !!(b[1] & 0x80);
  const authenticated = type >= 0x15 && type <= 0x18, encrypted = type === 0x17 || type === 0x18;
  let dataEnd = end;
  if (authenticated) { dataEnd -= 4; if (dataEnd < at + 1) throw Error('Secure-session frame is too short to hold its 4-byte MAC'); }
  const payload = b.slice(at + 1, dataEnd), mac = authenticated ? b.slice(dataEnd, end) : [];
  const ok = crcMode ? crc(b.slice(0, end)) === (b[end] | (b[end + 1] << 8)) : (b.reduce((a, x) => a + x, 0) & 255) === 0;
  if (!ok) {
    const want = crcMode ? crc(b.slice(0, end)) : checksum(b.slice(0, end));
    issues.push(crcMode ? `CRC mismatch: frame carries ${hx(b[end])} ${hx(b[end + 1])}, bytes compute to ${hx(want & 255)} ${hx(want >> 8)}`
      : `Checksum mismatch: frame carries ${hx(b[end])}, bytes compute to ${hx(want)}`);
  }
  const entry = entryFor(command, reply);
  const def = entry[3];
  const address = b[1] & 0x7f;
  // protocol-rule observations (spec behaviors)
  if (type != null) {
    const scbName = enumText(EN.securityBlockType, type);
    if (!scbName) warnings.push(`Security block type ${h2(type)} is not defined (SCS_11–SCS_18 only)`);
    else if ((type & 1) === (reply ? 1 : 0)) warnings.push(`${scbName.split(' ')[0]} belongs to the ${type & 1 ? 'controller → reader' : 'reader → controller'} direction, but ADDR says ${reply ? 'reply' : 'command'}`);
    if ((type === 0x15 || type === 0x16) && payload.length) warnings.push('SCS_15/16 carry a MAC but no encryption; messages with DATA must use SCS_17/18 (spec scs15-with-data)');
    const hs = { 0x11: 0x76, 0x12: 0x76, 0x13: 0x77, 0x14: 0x78 };
    if (hs[type] != null && hs[type] !== command) warnings.push(`${short(scbName.split(' ')[0])} normally carries ${short((reply ? REP : CMD).get(hs[type])?.name || h2(hs[type]))}`);
  }
  if (reply && command === 0x79 && (ctrl & 3) !== 0) warnings.push('BUSY should be sent with sequence 0 (spec busy-handling)');
  if (reply && command === 0x79 && type != null) warnings.push('BUSY is never sent inside the secure channel (spec busy-handling)');
  if (!reply && address === 0x7f) warnings.push('Address 0x7F is the broadcast/configuration address; use it only with a single reader on the bus');
  if (def?.deprecated) warnings.push(`${short(def.name)} is deprecated in 2.2.2`);
  const fields = b.map((v, i) => ({
    offset: i, value: v,
    name: i === 0 ? 'SOM' : i === 1 ? 'ADDR' : i === 2 ? 'LEN low' : i === 3 ? 'LEN high' : i === 4 ? 'CTRL'
      : i < at ? (i === 5 ? 'SCB LEN' : i === 6 ? 'SCB TYPE' : 'SCB DATA')
      : i === at ? (reply ? 'REPLY' : 'CMD')
      : i >= end ? (crcMode ? (i === end ? 'CRC low' : 'CRC high') : 'CHECKSUM')
      : i >= dataEnd ? 'MAC' : encrypted ? 'CIPHERTEXT' : 'DATA',
  }));
  return { b, marked, length, ctrl, command, cmdOffset: at, reply, address, sequence: ctrl & 3, crcMode, sb, type,
    encrypted, authenticated, payload, mac, entry, def, name: entry[0], fields, ok, issues, warnings, macVerified: false };
}

// ── field decoder ─────────────────────────────────────────────────────────
const le = (d, o, n) => { let v = 0; for (let i = n - 1; i >= 0; i--) v = v * 256 + (d[o + i] ?? 0); return v; };
const UNITS = (n, u) => !u ? String(n)
  : u === '100 ms' ? `${n} × 100 ms = ${n === 0 ? '0' : n * 100 >= 1000 ? `${(n / 10).toString()} s` : `${n * 100} ms`}`
  : `${n} ${u}`;
const ledColor = (v) => (enumText(EN.ledColor, v) || `colour ${v}`).replace(/ \(.*\)/, '').toLowerCase();
const ms100 = (n) => (n * 100 >= 1000 ? `${n / 10} s` : `${n * 100} ms`);

/** Plain-English explanation of one PDCAP record using Annex B compliance tables. */
export function capExplain(f, c, n) {
  const def = CAPS[String(f)];
  if (!def) return `Function ${f} is not defined in Annex B (reserved). Compliance ${c}, number ${n}.`;
  const lim = (x) => (typeof x === 'string' ? x : '');
  if (f === 10 || f === 11) return `${c | (n << 8)} bytes (compliance ${hx(c)} is the low byte, number ${hx(n)} the high byte)`;
  if (f === 9) return `AES-128 encryption ${c & 1 ? 'supported' : 'not supported'}; key-exchange bit 0 ${n & 1 ? 'set (AES-128)' : 'clear'}${(c | n) & 0xfe ? '; reserved bits set' : ''}`;
  if (f === 12) return `Transparent mode (XRW_MODE 1) ${c & 1 ? 'yes' : 'no'}; extended packet mode ${c & 2 ? 'yes' : 'no'}${n ? '; number should be 00' : ''}`;
  if (f === 13) return `${n} downstream reader${n === 1 ? '' : 's'} attached${c ? '; compliance should be 00' : ''}`;
  const comp = def.compliance && typeof def.compliance === 'object' ? enumText(def.compliance, c) : null;
  const num = lim(def.numberOf);
  const numText = /must be 0x00/i.test(num) ? (n ? `number is ${n} but must be 00` : '') : /ignored/i.test(num) ? 'number ignored' : num ? `${num.replace(/\.$/, '')}: ${n}` : `number ${n}`;
  return [comp ? `Level ${c}: ${comp.replace(/\.$/, '')}` : `Compliance ${c} (not listed in Annex B)`, numText].filter(Boolean).join('; ');
}

/**
 * Decode DATA with the spec field tables.
 * Returns { rows:[{off, abs, size, name, hex, value, meaning, record, group}], notes:[], warnings:[] }.
 */
export function decodeFields(p) {
  const d = p.payload, rows = [], notes = [], warnings = [];
  const def = p.def;
  if (p.encrypted) {
    notes.push(`Encrypted payload (${d.length} bytes): it cannot be decoded without the session keys. The CRC proves the bytes arrived intact, not who sent them; the MAC is not verified here.`);
    return { rows, notes, warnings };
  }
  if (!def) { if (d.length) notes.push('Unknown code: payload kept as opaque bytes.'); d.forEach((v, i) => rows.push(row(i, 1, 'Byte', hx(v), 'meaning unknown'))); return { rows, notes, warnings }; }
  const base = p.cmdOffset + 1;
  function row(off, size, name, value, meaning = '', extra = {}) {
    return { off, abs: base + off, size, name, hex: hex(d.slice(off, off + size)), value, meaning, ...extra };
  }
  const known = {};
  let shift = 0; // bytes of first-fragment-only fields that a continuation fragment leaves out
  function one(f, off, rec) {
    if (!rec) off -= shift;
    let size = f.size;
    if (typeof size === 'string') {
      const m = size.match(/var\s*\((.+)\)/);
      size = m && known[m[1]] != null ? known[m[1]] : d.length - off;
    }
    if (f.firstFragmentOnly && known.OFFSET) { shift += f.size; return 0; }
    if (off >= d.length) { if (!f.optional && size !== 0) warnings.push(`Missing field “${f.name}” at DATA +${off}`); return size || 0; }
    if (off + size > d.length) { warnings.push(`“${f.name}” needs ${size} byte(s) at DATA +${off}; only ${d.length - off} captured`); size = d.length - off; }
    const t = f.type || '', slice = d.slice(off, off + size);
    let value = hex(slice), meaning = f.description || '';
    if (/^u?int(8|16|32)/.test(t)) {
      let v = size === 1 ? slice[0] : le(d, off, size);
      if (/signed/.test(t) && size === 2 && v & 0x8000) v -= 65536;
      known[f.name] = v; value = UNITS(v, f.units);
      const en = enumRef(f.enumRef); if (en) meaning = enumText(en, v) || meaning;
    } else if (t === 'enum') {
      const v = slice[0]; known[f.name] = v;
      let table = f.values ? { values: f.values } : enumRef(f.enumRef);
      if (f.enumRef === 'enums.pdcapFunctionCodes') { meaning = CAPS[String(v)]?.name || 'Reserved function code'; value = `${v}`; }
      else {
        if (f.name === 'XWR_PCMND') table = known.XRW_MODE === 1 ? EN.xwrMode1Commands : EN.xwrMode0Commands;
        if (f.name === 'XRD_REPLY') table = known.XRW_MODE === 0 ? EN.xrdMode0Replies : null;
        const txt = table ? enumText(table, v) : null;
        value = h2(v); meaning = txt || (table ? 'Value not listed in the spec table' : meaning);
      }
    } else if (t === 'ASCII') {
      value = `“${slice.map((x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : '·')).join('')}”`;
    } else if (t === 'bitstring') {
      const n = known['Bit Count'] ?? slice.length * 8;
      value = slice.map((x) => x.toString(2).padStart(8, '0')).join('').slice(0, n).replace(/(.{8})/g, '$1 ').trim();
      meaning = `${n} card bits, left-justified (MSB first)`;
    } else if (t === 'enum[]') {
      value = slice.map((x) => `${hx(x)}${x >= 32 && x < 127 ? ` '${String.fromCharCode(x)}'` : ''}`).join(', ');
      meaning = slice.map((x) => enumText(enumRef(f.enumRef), x) || 'not a standard key code').join(' · ');
    } else if (t === 'bitfield') {
      const v = slice[0];
      const bits = enumRef(f.enumRef)?.bits || {};
      meaning = Object.entries(bits).map(([k, m]) => { const bit = +k.match(/bit(\d)/)[1]; return `${k.split(' ')[0]}=${(v >> bit) & 1}: ${m[(v >> bit) & 1]}`; }).join('; ');
      value = h2(v);
    }
    rows.push(row(off, size, f.name, value, meaning, { record: rec, group: f.group }));
    return size;
  }
  if (def.record) {
    const rs = def.recordSize;
    if (!d.length && !['osdp_ISTATR', 'osdp_OSTATR', 'osdp_RSTATR', 'osdp_PDCAP'].includes(def.name)) warnings.push(`${short(def.name)} needs at least one ${rs}-byte record`);
    if (d.length % rs) warnings.push(`DATA is ${d.length} bytes, not a multiple of the ${rs}-byte record (a reader should answer NAK 0x09)`);
    for (let r = 0; r * rs < d.length; r++) {
      for (const f of def.record) one(f, r * rs + f.offset, r + 1);
      const rec = d.slice(r * rs, r * rs + rs);
      if (def.name === 'osdp_PDCAP' && rec.length === 3) {
        const why = capExplain(rec[0], rec[1], rec[2]);
        notes.push(`Record ${r + 1} · ${CAPS[String(rec[0])]?.name || `function ${rec[0]}`}: ${why}`);
        rows[rows.length - 2].meaning = rows[rows.length - 1].meaning = `Annex B: ${why}`;
      }
      if (def.name === 'osdp_LED' && rec.length === 14) notes.push(`Record ${r + 1}: ${ledSentence(rec)}`);
      if (def.name === 'osdp_OUT' && rec.length === 4) notes.push(`Record ${r + 1}: output ${rec[0]} → ${enumText(EN.outputControlCode, rec[1]) || 'unknown control code'}${rec[2] | rec[3] ? `, timer ${ms100(rec[2] | (rec[3] << 8))}` : ''}`);
      if (def.name === 'osdp_ISTATR') notes.push(`Input ${r}: ${(enumText(EN.inputStatus, rec[0]) || 'unknown').split(' - ')[0]}`);
      if (def.name === 'osdp_OSTATR') notes.push(`Output ${r}: ${enumText(EN.outputStatus, rec[0]) || 'unknown'}`);
      if (def.name === 'osdp_RSTATR') notes.push(`Reader ${r}: ${enumText(EN.readerTamperStatus, rec[0]) || 'unknown'}`);
    }
  } else {
    let end = 0;
    for (const f of def.fields || []) { const s = one(f, f.offset, null); end = Math.max(end, f.offset - shift + (s || 0)); }
    if (shift) notes.push('Continuation fragment (OFFSET > 0): Algorithm and Key are only in the first fragment, so the challenge data starts at +6.');
    if (d.length > end && (def.fields || []).length) warnings.push(`${d.length - end} extra byte(s) after the last defined field`);
    if (d.length && !(def.fields || []).length) warnings.push(`${short(def.name)} has no DATA field in 2.2.2, but ${d.length} byte(s) were sent`);
  }
  // message-specific explanations
  const n = def.name;
  if (n === 'osdp_PDID' && d.length >= 12) notes.push(`Vendor OUI ${hex(d.slice(0, 3))}, model ${d[3]}, version ${d[4]}, serial ${le(d, 5, 4)} (0x${le(d, 5, 4).toString(16).toUpperCase()}), firmware ${d[9]}.${d[10]}.${d[11]}`);
  if (n === 'osdp_PDID' && d.length !== 12) warnings.push('A standard PDID block is 12 bytes');
  if (n === 'osdp_RAW' && d.length >= 4) {
    const bits = d[2] | (d[3] << 8), need = Math.ceil(bits / 8), got = d.length - 4;
    notes.push(`${bits} card bits need ${need} data byte(s); ${got} captured. ${bits === 26 ? '26 bits is common for H10301, but the bit count alone does not identify a card format.' : 'Use a documented card format map before naming facility or card numbers.'}`);
    if (need !== got) warnings.push(`RAW declares ${bits} bits (${need} bytes) but carries ${got} data bytes`);
  }
  if (n === 'osdp_KEYPAD' && d.length >= 2) {
    if (d[1] !== d.length - 2) warnings.push(`Digit count ${d[1]} does not match the ${d.length - 2} key byte(s) present`);
    notes.push('Key bytes are ASCII: 0x30–0x39 are digits, 0x7F is * (clear), 0x0D is # (enter). Without Secure Channel a PIN is readable on the wire.');
  }
  if ((n === 'osdp_COM' || n === 'osdp_COMSET') && d.length >= 5) {
    const baud = le(d, 1, 4);
    notes.push(`Address ${d[0]}, ${baud} baud${[9600, 19200, 38400, 57600, 115200, 230400].includes(baud) ? '' : ' (unusual rate — check it)'}`);
    if (n === 'osdp_COMSET') notes.push('The new address and baud take effect after the reader answers with osdp_COM; expect the next traffic at the new settings (spec comset-change).');
    if (d[0] > 0x7e) warnings.push('Address must be 0x00–0x7E');
  }
  if (n === 'osdp_NAK' && d.length) { const h = NAK_HINT[d[0]]; if (h) notes.push(h); }
  if (n === 'osdp_FILETRANSFER' && d.length >= 11) {
    const size = le(d, 1, 4), off = le(d, 5, 4), frag = d[9] | (d[10] << 8), got = d.length - 11;
    notes.push(`Fragment ${off}–${off + frag - 1} of a ${size}-byte file (${size ? Math.round(((off + frag) / size) * 100) : 0}% sent after this one)`);
    if (frag !== got) warnings.push(`FtFragmentSize says ${frag} bytes but ${got} follow`);
    if (off + frag > size) warnings.push('Fragment runs past the declared file size');
  }
  if (n === 'osdp_FTSTAT' && d.length >= 7) {
    let st = d[3] | (d[4] << 8); if (st & 0x8000) st -= 65536;
    notes.push(`Status ${st}: ${enumText(EN.ftStatusDetail, st) || 'not listed'}. Wait ${d[1] | (d[2] << 8)} ms before the next fragment.`);
  }
  if ((n === 'osdp_MFG' || n === 'osdp_MFGREP') && d.length >= 3) notes.push(`Vendor OUI ${hex(d.slice(0, 3))}${d.length > 3 ? `, first vendor byte ${n === 'osdp_MFG' ? '(the Command_ID) ' : ''}${h2(d[3])}` : ''}. Everything after the OUI is defined by that vendor's document for the exact model and firmware.`);
  if (n === 'osdp_KEYSET') notes.push('KEYSET carries a key. It belongs inside an encrypted session or physically secured installation mode (spec keyset-context). The Academy never builds one.');
  if (n === 'osdp_BUZ' && d.length >= 2 && d[1] === 0) warnings.push('Tone code 0x00 is deprecated; use 0x01 for off');
  return { rows, notes, warnings };
}

export function ledSentence(r) {
  const parts = [];
  const tTimer = r[7] | (r[8] << 8);
  if (r[2] === 2) {
    const flash = r[3] && r[4] && r[5] !== r[6];
    parts.push(`temporary ${flash ? `flash ${ledColor(r[5])}/${ledColor(r[6])} (${ms100(r[3])} on, ${ms100(r[4])} off)` : `steady ${ledColor(r[5])}`} ${tTimer ? `for ${ms100(tTimer)}` : 'until changed'}`);
  } else if (r[2] === 1) parts.push('cancel temporary, show permanent now');
  else parts.push('temporary unchanged');
  if (r[9] === 1) {
    const flash = r[10] && r[11] && r[12] !== r[13];
    parts.push(`permanent ${flash ? `flash ${ledColor(r[12])}/${ledColor(r[13])}` : `steady ${ledColor(r[12])}`}`);
  } else parts.push('permanent unchanged');
  return `reader ${r[0]}, LED ${r[1]}: ${parts.join('; ')}`;
}

const NAK_HINT = {
  1: 'NAK 0x01: the reader saw bad check bytes. The controller may resend the same command. Look at noise, termination, baud and wiring before anything else.',
  2: 'NAK 0x02: wrong length for that command, or larger than the reader’s receive buffer (PDCAP function 10).',
  3: 'NAK 0x03: the reader does not implement this command. Check PDCAP and the reader’s documentation; retrying will not help.',
  4: 'NAK 0x04: unexpected sequence number. The controller and reader disagree on SQN; the controller usually restarts with SQN 0.',
  5: 'NAK 0x05: the reader does not support the security block it received (Secure Channel mismatch).',
  6: 'NAK 0x06: this reader requires Secure Channel for that command. On SQN 0 inside a session it means the reader reset the secure channel.',
  7: 'NAK 0x07: biometric type not supported.', 8: 'NAK 0x08: biometric format not supported.',
  9: 'NAK 0x09: a record had invalid parameters (for example an LED or output number that does not exist). Extra bytes, if any, are per-record completion codes.',
};

/** Legacy flat list of lines (kept for tests and simple displays). */
export function detail(p) {
  const r = decodeFields(p);
  const out = [...r.notes.map((s) => (p.encrypted ? s : `Note: ${s}`)), ...r.warnings.map((s) => `Check: ${s}`),
    ...r.rows.map((x) => `DATA +${x.off} · ${x.hex} · ${x.record ? `Record ${x.record} / ` : ''}${x.name}: ${x.value}${x.meaning ? ` — ${x.meaning}` : ''}`)];
  return out.length ? out : ['No payload bytes.'];
}

/** One plain-English line for lists. */
export function summary(p) {
  const d = p.payload, n = p.name;
  if (p.encrypted) return `${n} — encrypted (${d.length} bytes)`;
  switch (n) {
    case 'POLL': return 'Poll — anything to report?';
    case 'ACK': return 'Acknowledged — nothing to report';
    case 'BUSY': return 'Busy — ask again shortly';
    case 'NAK': return `Refused: ${(enumText(EN.nakErrorCode, d[0] ?? 0) || 'unknown').split(' (')[0]}`;
    case 'ID': return 'Who are you? (request PDID)';
    case 'CAP': return 'What can you do? (request PDCAP)';
    case 'PDID': return d.length >= 12 ? `Identity: OUI ${hex(d.slice(0, 3))}, model ${d[3]}, fw ${d[9]}.${d[10]}.${d[11]}` : 'Identity (short block)';
    case 'PDCAP': return `Capabilities: ${Math.floor(d.length / 3)} function record(s)`;
    case 'LED': return d.length >= 14 ? `LED ${ledSentence(d.slice(0, 14))}` : 'LED (incomplete record)';
    case 'BUZ': return d.length >= 5 ? `Buzzer: ${(enumText(EN.buzzerToneCode, d[1]) || 'tone').toLowerCase()}, ${ms100(d[2])} on / ${ms100(d[3])} off × ${d[4] || '∞'}` : 'Buzzer (short)';
    case 'RAW': return d.length >= 4 ? `Card read: ${d[2] | (d[3] << 8)} bits` : 'Card read (short)';
    case 'KEYPAD': return `Keypad: ${d.slice(2).map((x) => (x === 0x7f ? '*' : x === 0x0d ? '#' : x >= 32 && x < 127 ? String.fromCharCode(x) : '?')).join('')}`;
    case 'OUT': return `Output control: ${Math.floor(d.length / 4)} record(s)`;
    case 'MFG': case 'MFGREP': return `${n === 'MFG' ? 'Vendor command' : 'Vendor reply'} OUI ${hex(d.slice(0, 3))}`;
    case 'COMSET': return d.length >= 5 ? `Change to address ${d[0]}, ${le(d, 1, 4)} baud` : 'COMSET (short)';
    case 'COM': return d.length >= 5 ? `Now address ${d[0]}, ${le(d, 1, 4)} baud` : 'COM (short)';
    case 'CHLNG': return 'Secure Channel step 1: controller challenge';
    case 'CCRYPT': return 'Secure Channel step 2: reader cryptogram';
    case 'SCRYPT': return 'Secure Channel step 3: controller cryptogram';
    case 'RMAC_I': return `Secure Channel step 4: ${p.sb[2] === 0x01 ? 'cryptogram accepted (MACs not verified here)' : p.sb[2] === 0xff ? 'cryptogram rejected' : `unsupported status ${h2(p.sb[2])}`}`;
    case 'FILETRANSFER': return d.length >= 11 ? `File fragment at ${le(d, 5, 4)} of ${le(d, 1, 4)} bytes` : 'File transfer (short)';
    case 'FTSTAT': { if (d.length < 7) return 'File transfer status (short)'; let s = d[3] | (d[4] << 8); if (s & 0x8000) s -= 65536; return `File transfer status ${s}`; }
    default: return entryFor(p.command, p.reply)[1];
  }
}

/** Spec examples for a message, as {bytes, meaning}. */
export const examplesFor = (def) => (def?.examples || (def?.example ? [def.example] : [])).filter((e) => e && typeof e === 'object' && e.bytes);
