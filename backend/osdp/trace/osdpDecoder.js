// osdpDecoder.js — the single OSDP decoder.
//
// Everything that turns OSDP bytes into words goes through here: the live trace,
// saved captures, the exports, the health/timeline views. Fix a decode in one
// place and every surface gets it. Backed by the SIA OSDP 2.2.2 field tables in
// osdp-spec-2.2.2.json.
'use strict';

const SPEC = require('./osdp-spec-2.2.2.json');

// ── lookups built once from the spec ──
const CMD = new Map();   // code -> command def
const REP = new Map();   // code -> reply def
for (const c of SPEC.commands) CMD.set(parseInt(c.code, 16), c);
for (const r of SPEC.replies) REP.set(parseInt(r.code, 16), r);
const EN = SPEC.enums;

const hex = (b) => Buffer.isBuffer(b) ? b.toString('hex').toUpperCase() : '';
const h2 = (n) => '0x' + (n & 0xFF).toString(16).toUpperCase().padStart(2, '0');
const u16 = (buf, o) => buf[o] | (buf[o + 1] << 8);
const u32 = (buf, o) => (buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16) | (buf[o + 3] << 24)) >>> 0;

// enum lookup that understands the spec's "0x01-0x7F" range keys
function enumText(table, val) {
  if (!table || !table.values) return null;
  const key = h2(val);
  if (table.values[key] != null) return table.values[key];
  for (const [k, v] of Object.entries(table.values)) {
    const m = k.match(/^0x([0-9A-Fa-f]+)-0x([0-9A-Fa-f]+)$/);
    if (m && val >= parseInt(m[1], 16) && val <= parseInt(m[2], 16)) return v;
  }
  return null;
}
const enumRef = (path) => path && path.startsWith('enums.') ? EN[path.slice(6)] : null;

// ── CRC-16 / checksum (spec 5.9) ──
function crc16(buf, len) {
  let crc = 0x1D0F;
  for (let i = 0; i < len; i++) {
    crc ^= buf[i] << 8;
    for (let b = 0; b < 8; b++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
  }
  return crc & 0xFFFF;
}
function checksum(buf, len) {
  let s = 0; for (let i = 0; i < len; i++) s = (s + buf[i]) & 0xFF;
  return (-s) & 0xFF;
}

const COLOR_NAMES = EN.ledColor.values;
const ledColor = (v) => (COLOR_NAMES[h2(v)] || `colour ${v}`).replace(/ \(.*\)/, '').toLowerCase();
const t100 = (v) => v === 0 ? '0' : v * 100 >= 1000 ? `${(v * 100 / 1000).toFixed(v % 10 ? 1 : 0)} s` : `${v * 100} ms`;

// ── per-message plain-English builders ──
// Each returns { summary, fields:[{name,value,hex?}], decoded:{...} } given the
// data bytes (after the header/SCB, before the check bytes) and the frame meta.
const BUILD = {
  osdp_POLL: () => ({ summary: 'Poll — anything to report?' }),
  osdp_ACK: () => ({ summary: 'Acknowledged — nothing to report' }),
  osdp_BUSY: () => ({ summary: 'Busy — ask again shortly' }),

  osdp_NAK: (d) => {
    const code = d[0];
    const why = enumText(EN.nakErrorCode, code) || 'unknown error';
    const hint = NAK_HINT[code];
    return { summary: `Refused: ${why} (NAK ${h2(code)})`, hint, fields: [{ name: 'Error code', value: `${h2(code)} — ${why}` }], decoded: { nak: code } };
  },

  osdp_LED: (d) => {
    const recs = []; const n = Math.floor(d.length / 14);
    for (let i = 0; i < n; i++) {
      const o = i * 14, r = d[o], led = d[o + 1];
      const tmp = d[o + 2], tOn = d[o + 3], tOff = d[o + 4], tOnC = d[o + 5], tOffC = d[o + 6], tTimer = u16(d, o + 7);
      const perm = d[o + 9], pOn = d[o + 10], pOff = d[o + 11], pOnC = d[o + 12], pOffC = d[o + 13];
      let parts = [];
      if (tmp === 0x02) {
        const flash = tOn && tOff && tOnC !== tOffC;
        parts.push(flash ? `flash ${ledColor(tOnC)}/${ledColor(tOffC)} (${t100(tOn)} on, ${t100(tOff)} off)` : `show ${ledColor(tOnC)}`);
        parts.push(tTimer ? `for ${t100(tTimer)}` : 'until changed');
      } else if (tmp === 0x01) parts.push('cancel temporary, show permanent now');
      if (perm === 0x01) {
        const pflash = pOn && pOff && pOnC !== pOffC;
        parts.push(`then steady ${pflash ? `${ledColor(pOnC)}/${ledColor(pOffC)}` : ledColor(pOnC)}`);
      }
      recs.push({ reader: r, led, text: parts.join(', ') || 'no change' });
    }
    const s = recs.length === 1
      ? `LED: reader ${recs[0].reader} LED ${recs[0].led} — ${recs[0].text}`
      : `LED: ${recs.length} commands — ` + recs.map(r => `L${r.led} ${r.text}`).join('; ');
    return { summary: s, decoded: { led: recs } };
  },

  osdp_BUZ: (d) => {
    const r = d[0], tone = d[1], on = d[2], off = d[3], count = d[4];
    const toneT = tone === 0x02 ? 'beep' : tone <= 0x01 ? 'silent' : `tone ${tone}`;
    const s = tone <= 0x01 ? `Buzzer off (reader ${r})`
      : count === 1 ? `Buzzer: one ${toneT} (${t100(on)})`
      : `Buzzer: ${toneT} ×${count || '∞'} (${t100(on)} on, ${t100(off)} off)`;
    return { summary: s, decoded: { buzzer: { reader: r, tone, on, off, count } } };
  },

  osdp_TEXT: (d) => {
    const r = d[0], cmd = d[1], tt = d[2], row = d[3], col = d[4], len = d[5];
    const str = d.slice(6, 6 + len).toString('ascii');
    const perm = cmd === 0x01 || cmd === 0x02;
    return { summary: `Display “${str}” on reader ${r} (${perm ? 'permanent' : `temporary ${tt}s`}, row ${row} col ${col})`, decoded: { text: str } };
  },

  osdp_OUT: (d) => {
    const recs = []; const n = Math.floor(d.length / 4);
    for (let i = 0; i < n; i++) { const o = i * 4; recs.push({ output: d[o], code: d[o + 1], timer: u16(d, o + 2) }); }
    const one = recs[0] || {};
    const ct = enumText(EN.outputControlCode, one.code) || '';
    const s = recs.length === 1
      ? `Output ${one.output}: ${/ON/.test(ct) ? 'ON' : /OFF/.test(ct) ? 'OFF' : ct}${one.timer ? ` for ${t100(one.timer)}` : ''}`
      : `Set ${recs.length} outputs`;
    return { summary: s, decoded: { outputs: recs } };
  },

  osdp_COMSET: (d) => ({ summary: `Change reader to address ${d[0]} at ${u32(d, 1).toLocaleString()} baud`, decoded: { address: d[0], baud: u32(d, 1) } }),
  osdp_COM: (d) => ({ summary: `Reader now at address ${d[0]}, ${u32(d, 1).toLocaleString()} baud`, decoded: { address: d[0], baud: u32(d, 1) } }),

  osdp_ID: () => ({ summary: 'Identify yourself (make, model, serial, firmware)' }),
  osdp_PDID: (d) => {
    const vendor = `${h2(d[0]).slice(2)}:${h2(d[1]).slice(2)}:${h2(d[2]).slice(2)}`;
    const serial = u32(d, 5), fw = `${d[9]}.${d[10]}.${d[11]}`;
    return { summary: `I am: vendor ${vendor}, model ${d[3]} v${d[4]}, serial ${serial}, firmware ${fw}`, decoded: { vendor, model: d[3], version: d[4], serial, firmware: fw } };
  },

  osdp_CAP: () => ({ summary: 'What can you do? (capabilities)' }),
  osdp_PDCAP: (d) => {
    const caps = []; const codes = EN.pdcapFunctionCodes.codes;
    for (let i = 0; i + 2 < d.length; i += 3) {
      const fc = d[i], comp = d[i + 1], num = d[i + 2];
      const def = codes[String(fc)];
      caps.push({ fn: fc, name: def ? def.name : `function ${fc}`, compliance: comp, num, detail: def && def.compliance ? enumText({ values: def.compliance }, comp) : null });
    }
    const named = caps.map(c => c.name + (c.num > 1 ? ` ×${c.num}` : '')).join(', ');
    return { summary: `Supports: ${named}`, decoded: { capabilities: caps } };
  },

  osdp_LSTAT: () => ({ summary: 'Report tamper and power status' }),
  osdp_LSTATR: (d) => {
    const tamper = d[0], power = d[1];
    const bits = [];
    if (tamper) bits.push('TAMPER'); if (power) bits.push('POWER FAIL');
    return { summary: bits.length ? `Local status: ${bits.join(', ')}` : 'Local status: normal (no tamper, power OK)', hint: bits.length ? 'Check the enclosure tamper switch and the power supply.' : undefined, decoded: { tamper, power } };
  },
  osdp_ISTAT: () => ({ summary: 'Report input states' }),
  osdp_ISTATR: (d) => {
    const inputs = [...d].map((v, i) => ({ input: i, state: enumText(EN.inputStatus, v) || v }));
    const active = inputs.filter(x => /Active|Short|Open|Fault/.test(String(x.state)));
    return { summary: active.length ? `Inputs: ${active.map(a => `#${a.input} ${String(a.state).split(' ')[0]}`).join(', ')}` : `Inputs: all normal (${inputs.length})`, decoded: { inputs } };
  },
  osdp_OSTAT: () => ({ summary: 'Report output states' }),
  osdp_OSTATR: (d) => {
    const outs = [...d].map((v, i) => ({ output: i, on: v === 1 }));
    return { summary: `Outputs: ${outs.filter(o => o.on).length} of ${outs.length} on`, decoded: { outputs: outs } };
  },
  osdp_RSTAT: () => ({ summary: 'Report attached-reader tamper status' }),
  osdp_RSTATR: (d) => {
    const rs = [...d].map((v, i) => ({ reader: i, state: enumText(EN.readerTamperStatus, v) || v }));
    const bad = rs.filter(r => !/Normal/.test(String(r.state)));
    return { summary: bad.length ? `Reader status: ${bad.map(b => `#${b.reader} ${b.state}`).join(', ')}` : 'Reader status: all normal', decoded: { readers: rs } };
  },

  osdp_RAW: (d, ctx) => {
    const reader = d[0], fmt = d[1], bitCount = u16(d, 2);
    const cardBytes = d.slice(4);
    const bits = [];
    for (let i = 0; i < bitCount; i++) bits.push((cardBytes[i >> 3] >> (7 - (i & 7))) & 1);
    const binary = bits.join('');
    let wieg = null;
    if (ctx && ctx.identifyCard) wieg = ctx.identifyCard(binary);
    const fmtName = enumText(EN.rawCardFormatCode, fmt) || `format ${fmt}`;
    let s = `Card read: ${bitCount}-bit`;
    if (wieg && wieg.facility != null) s += `, FC ${wieg.facility}, card ${wieg.card}${wieg.parityOk === false ? ' (parity FAIL)' : wieg.parityOk ? ' (parity OK)' : ''}`;
    else s += ` (${fmtName})`;
    return { summary: s, decoded: { raw: { reader, format: fmt, bitCount, binary, wieg } } };
  },
  osdp_FMT: (d) => {
    const str = d.slice(3).toString('ascii');
    return { summary: `Card read (character format): “${str}”`, decoded: { fmt: str } };
  },
  osdp_KEYPAD: (d) => {
    const reader = d[0], count = d[1];
    const keys = [...d.slice(2, 2 + count)].map(k => KEY_ASCII[k] || String.fromCharCode(k));
    return { summary: `Keypad: ${keys.join('')} (${count} key${count === 1 ? '' : 's'})`, decoded: { keypad: keys } };
  },

  osdp_FILETRANSFER: (d) => {
    const type = d[0], total = u32(d, 1), off = u32(d, 5), frag = u16(d, 9);
    if (frag === 0 && off === 0 && total === 0) return { summary: 'File transfer: idle keep-alive' };
    return { summary: `File transfer: ${frag} bytes at ${off.toLocaleString()} of ${total.toLocaleString()} (${Math.round(off / total * 100) || 0}%)`, decoded: { fileTransfer: { type, total, offset: off, frag } } };
  },
  osdp_FTSTAT: (d) => {
    const detail = (d[3] | (d[4] << 8)) << 16 >> 16;
    const dt = enumText({ values: EN.ftStatusDetail.values }, detail) || (detail >= 0 ? 'in progress' : 'error');
    return { summary: `File transfer status: ${dt}`, decoded: { ftDetail: detail } };
  },
  osdp_ACURXSIZE: (d) => ({ summary: `Controller can receive up to ${u16(d, 0)} bytes` }),
  osdp_KEEPACTIVE: (d) => ({ summary: `Keep the card session alive ${u16(d, 0)} ms` }),
  osdp_MFG: (d) => ({ summary: `Vendor-specific command (OUI ${h2(d[0]).slice(2)}:${h2(d[1]).slice(2)}:${h2(d[2]).slice(2)})`, decoded: { vendor: [d[0], d[1], d[2]] } }),
  osdp_MFGREP: (d) => ({ summary: `Vendor-specific reply (OUI ${h2(d[0]).slice(2)}:${h2(d[1]).slice(2)}:${h2(d[2]).slice(2)})` }),

  // Secure channel — described, not decrypted
  osdp_KEYSET: () => ({ summary: 'Set a new secure-channel key (encrypted)', secure: true }),
  osdp_CHLNG: () => ({ summary: 'Secure channel: controller starts a session (sends challenge)', secure: true }),
  osdp_CCRYPT: () => ({ summary: 'Secure channel: reader answers the challenge', secure: true }),
  osdp_SCRYPT: () => ({ summary: 'Secure channel: controller proves the shared key', secure: true }),
  osdp_RMAC_I: () => ({ summary: 'Secure channel: session established', secure: true }),
};

const NAK_HINT = {
  0x01: 'A byte was corrupted (bad checksum/CRC). Usually noise, wiring or a baud-rate mismatch.',
  0x02: 'The command length was wrong for this command.',
  0x03: 'The reader doesn’t support this command.',
  0x04: 'Sequence numbers are out of step — often after a reset or a missed reply.',
  0x05: 'The reader doesn’t support that secure-channel block.',
  0x06: 'This command must be sent inside a secure channel.',
  0x07: 'That biometric type isn’t supported.',
  0x08: 'That biometric format isn’t supported.',
  0x09: 'One or more command records had bad values (e.g. an LED/output number that doesn’t exist).',
};
const KEY_ASCII = { 0x7F: '*', 0x0D: '#', 0x41: 'A', 0x42: 'B', 0x43: 'C', 0x44: 'D' };

// ── frame decoder ──
// Accepts a full frame Buffer (SOM..check). ctx may provide { identifyCard }.
function decodeFrame(buf, ctx = {}) {
  const f = { ok: false, errors: [], warnings: [] };
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  f.hex = hex(buf);
  if (buf.length < 6 || buf[0] !== 0x53) { f.errors.push('Not an OSDP frame (no SOM 0x53)'); f.summary = 'Malformed frame'; return f; }

  const addrByte = buf[1];
  f.address = addrByte & 0x7F;
  f.isReply = (addrByte & 0x80) !== 0;
  f.broadcast = f.address === 0x7F;
  const len = u16(buf, 2);
  f.length = len;
  if (len !== buf.length) f.warnings.push(`Length says ${len} bytes but frame is ${buf.length}`);
  const ctrl = buf[4];
  f.sequence = ctrl & 0x03;
  f.useCRC = (ctrl & 0x04) !== 0;
  f.hasSCB = (ctrl & 0x08) !== 0;
  if (ctrl & 0xF0) f.warnings.push(`Reserved control bits set (${h2(ctrl)})`);

  // integrity
  const checkLen = f.useCRC ? 2 : 1;
  const bodyEnd = buf.length - checkLen;
  if (f.useCRC) {
    const got = u16(buf, bodyEnd), want = crc16(buf, bodyEnd);
    f.checkOk = got === want; f.check = 'CRC-16';
    const hx = (n) => n.toString(16).toUpperCase().padStart(4, '0');
    if (!f.checkOk) f.errors.push(`CRC mismatch (got 0x${hx(got)}, expected 0x${hx(want)})`);
  } else {
    const got = buf[bodyEnd], want = checksum(buf, bodyEnd);
    f.checkOk = got === want; f.check = 'checksum';
    if (!f.checkOk) f.errors.push(`Checksum mismatch (got ${h2(got)}, expected ${h2(want)})`);
  }

  // SCB
  let p = 5;
  if (f.hasSCB) {
    const sblen = buf[p], stype = buf[p + 1];
    f.scb = { length: sblen, type: stype, typeName: enumText(EN.securityBlock ? { values: EN.securityBlock } : { values: SPEC_SCB() }, stype) };
    f.secureType = stype;
    p += sblen;
  }
  const code = buf[p];
  f.code = code;
  const def = f.isReply ? REP.get(code) : CMD.get(code);
  f.name = def ? def.name : (f.isReply ? `reply ${h2(code)}` : `command ${h2(code)}`);
  f.section = def ? def.section : null;
  f.description = def ? def.description : null;

  // MAC (secure session frames carry a 4-byte MAC before the check bytes)
  let dataEnd = bodyEnd;
  const encrypted = f.secureType === 0x17 || f.secureType === 0x18;
  const macFrame = f.secureType >= 0x15 && f.secureType <= 0x18;
  if (macFrame) { f.mac = hex(buf.slice(bodyEnd - 4, bodyEnd)); dataEnd = bodyEnd - 4; }
  const data = buf.slice(p + 1, dataEnd);
  f.dataHex = hex(data);

  if (encrypted) {
    f.summary = `${def ? def.name.replace('osdp_', '') : 'Secure message'} — encrypted (${data.length} bytes)`;
    f.encrypted = true;
  } else {
    const builder = def && BUILD[def.name];
    try {
      const r = builder ? builder(data, ctx) : { summary: def ? def.description : `Unknown ${f.isReply ? 'reply' : 'command'} ${h2(code)}` };
      Object.assign(f, r);
    } catch (e) { f.summary = def ? def.description : 'Undecoded'; f.warnings.push('Decode error: ' + e.message); }
  }
  if (f.hasSCB && !f.summary) f.summary = f.scb.typeName;
  f.ok = f.errors.length === 0;
  return f;
}
function SPEC_SCB() { const o = {}; for (const [k, v] of Object.entries(EN.securityBlockType ? EN.securityBlockType.values : {})) o[k] = v; return o; }
// securityBlockType lives under enums in the trimmed spec
if (!EN.securityBlock && EN.securityBlockType) EN.securityBlock = EN.securityBlockType.values;

module.exports = { decodeFrame, crc16, checksum, SPEC };
