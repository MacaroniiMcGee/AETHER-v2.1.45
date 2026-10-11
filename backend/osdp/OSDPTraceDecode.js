// osdp/OSDPTraceDecode.js
//
// Lenient OSDP frame decoder for the bus trace logger.
//
// Unlike OSDPPacket.parsePacket(), this never rejects a frame: a bad CRC, a
// short payload or an unknown code is recorded with a flag instead, because
// those are exactly the frames a reader manufacturer needs to see.

const OSDPPacket = require('./OSDPPacket');

const COMMANDS = {
  0x60: 'POLL', 0x61: 'ID', 0x62: 'CAP', 0x64: 'LSTAT', 0x65: 'ISTAT', 0x66: 'OSTAT',
  0x67: 'RSTAT', 0x68: 'OUT', 0x69: 'LED', 0x6A: 'BUZ', 0x6B: 'TEXT', 0x6C: 'RMODE',
  0x6D: 'TDSET', 0x6E: 'COMSET', 0x6F: 'DATA', 0x70: 'XMIT', 0x71: 'PROMPT', 0x72: 'SPE',
  0x73: 'BIOREAD', 0x74: 'BIOMATCH', 0x75: 'KEYSET', 0x76: 'CHLNG', 0x77: 'SCRYPT',
  0x7B: 'ACURXSIZE', 0x7C: 'FILETRANSFER', 0x80: 'MFG', 0xA1: 'XWR', 0xA2: 'ABORT',
  0xA3: 'PIVDATA', 0xA4: 'GENAUTH', 0xA5: 'CRAUTH', 0xA7: 'KEEPACTIVE',
};

const REPLIES = {
  0x40: 'ACK', 0x41: 'NAK', 0x45: 'PDID', 0x46: 'PDCAP', 0x48: 'LSTATR', 0x49: 'ISTATR',
  0x4A: 'OSTATR', 0x4B: 'RSTATR', 0x50: 'RAW', 0x51: 'FMT', 0x53: 'KEYPAD', 0x54: 'COM',
  0x57: 'BIOREADR', 0x58: 'BIOMATCHR', 0x76: 'CCRYPT', 0x78: 'RMAC_I', 0x79: 'BUSY',
  0x7A: 'FTSTAT', 0x80: 'PIVDATAR', 0x81: 'GENAUTHR', 0x82: 'CRAUTHR', 0x83: 'MFGSTATR',
  0x84: 'MFGERRR', 0x90: 'MFGREP', 0xB1: 'XRD',
};

const NAK_REASONS = {
  0x00: 'no error', 0x01: 'message check (CRC/checksum) error', 0x02: 'command length error',
  0x03: 'unknown/unsupported command', 0x04: 'unexpected sequence number',
  0x05: 'security block not supported', 0x06: 'communication security conditions not met',
  0x07: 'BIO type not supported', 0x08: 'BIO format not supported',
  0x09: 'unable to process command record',
};

const SCS_TYPES = {
  0x11: 'SCS_11 (CHLNG)', 0x12: 'SCS_12 (CCRYPT)', 0x13: 'SCS_13 (SCRYPT)', 0x14: 'SCS_14 (RMAC_I)',
  0x15: 'SCS_15 (MAC, plain cmd)', 0x16: 'SCS_16 (MAC, plain reply)',
  0x17: 'SCS_17 (MAC, encrypted cmd)', 0x18: 'SCS_18 (MAC, encrypted reply)',
};

// osdp_FTSTAT status values (signed 16-bit)
const FT_STATUS = {
  0: 'OK, send next', 1: 'PROCESSED (file accepted)', 2: 'REBOOTING (file accepted)',
  3: 'FINISHING (still processing)', [-1]: 'ABORT (transfer aborted by PD)',
  [-2]: 'UNRECOGNIZED file contents', [-3]: 'MALFORMED file contents',
};

const hex = (buf, sep = ' ') =>
  Array.from(buf || [], b => b.toString(16).padStart(2, '0')).join(sep);
const h2 = n => '0x' + (n & 0xFF).toString(16).padStart(2, '0').toUpperCase();
const h4 = n => '0x' + (n & 0xFFFF).toString(16).padStart(4, '0').toUpperCase();

function codeName(code, isReply) {
  const t = isReply ? REPLIES : COMMANDS;
  return t[code] || `${isReply ? 'REPLY' : 'CMD'} ${h2(code)}`;
}

function ftActionText(a) {
  const bits = [];
  if (a & 0x01) bits.push('interleave OK');
  if (a & 0x02) bits.push('leave secure channel');
  if (a & 0x04) bits.push('poll response available');
  return bits.length ? `${h2(a)} (${bits.join(', ')})` : h2(a);
}

// Decode the command/reply payload into { summary, fields }.
function describePayload(code, isReply, d) {
  const f = {};
  if (!isReply) {
    switch (code) {
      case 0x60: return { summary: 'poll', fields: f };
      case 0x61: return { summary: 'request PD ID', fields: f };
      case 0x62: return { summary: 'request PD capabilities', fields: f };
      case 0x7C: {
        if (d.length < 11) return { summary: `FILETRANSFER header truncated (${d.length} bytes)`, fields: f, flag: 'short-payload' };
        f.fileType = d[0];
        f.totalSize = d.readUInt32LE(1);
        f.offset = d.readUInt32LE(5);
        f.fragLen = d.readUInt16LE(9);
        f.actualFragBytes = d.length - 11;
        const pct = f.totalSize ? ((f.offset + f.fragLen) / f.totalSize * 100).toFixed(1) : '?';
        let s = f.fragLen === 0 && f.offset >= f.totalSize
          ? `finalize poll (offset ${f.offset} = total, 0 bytes)`
          : `type ${h2(f.fileType)} offset ${f.offset.toLocaleString('en-US')} / ${f.totalSize.toLocaleString('en-US')}, ${f.fragLen} bytes (${pct}%)`;
        let flag;
        if (f.actualFragBytes !== f.fragLen) { s += ` — header says ${f.fragLen} bytes but ${f.actualFragBytes} present`; flag = 'length-mismatch'; }
        return { summary: s, fields: f, flag };
      }
      case 0x6E: {
        if (d.length >= 5) { f.newAddress = d[0]; f.newBaud = d.readUInt32LE(1); return { summary: `set address ${h2(d[0])}, baud ${f.newBaud}`, fields: f }; }
        break;
      }
      case 0x75: return { summary: `set secure-channel key (type ${h2(d[0] || 0)}, ${d[1] || 0} bytes, key not shown)`, fields: f, redact: true };
      case 0x76: return { summary: 'secure-channel challenge', fields: f };
      case 0x77: return { summary: 'secure-channel server cryptogram', fields: f };
      case 0x7B: if (d.length >= 2) return { summary: `ACU receive size ${d.readUInt16LE(0)}`, fields: f }; break;
      case 0x80: if (d.length >= 3) { f.vendor = hex(d.slice(0, 3), ':'); return { summary: `manufacturer command, vendor ${f.vendor}, ${d.length - 3} data bytes`, fields: f }; } break;
      case 0xA2: return { summary: 'abort current operation', fields: f };
      case 0xA7: if (d.length >= 2) return { summary: `keep active ${d.readUInt16LE(0)} ms`, fields: f }; break;
      case 0x69: return { summary: `LED control (${Math.floor(d.length / 14)} record)`, fields: f };
      case 0x6A: return { summary: d.length >= 5 ? `buzzer tone ${d[1]} on ${d[2] * 100}ms off ${d[3] * 100}ms ×${d[4]}` : 'buzzer', fields: f };
      default: break;
    }
  } else {
    switch (code) {
      case 0x40: return { summary: 'ACK', fields: f };
      case 0x41: {
        f.nakCode = d.length ? d[0] : null;
        f.nakReason = f.nakCode == null ? 'no reason byte' : (NAK_REASONS[f.nakCode] || 'vendor/unknown reason');
        if (d.length > 1) f.nakExtra = hex(d.slice(1));
        return { summary: `NAK ${f.nakCode == null ? '' : h2(f.nakCode)} — ${f.nakReason}${f.nakExtra ? ` (extra: ${f.nakExtra})` : ''}`, fields: f, flag: 'nak' };
      }
      case 0x79: return { summary: 'PD busy, will answer later', fields: f, flag: 'busy' };
      case 0x7A: {
        if (d.length < 5) return { summary: `FTSTAT truncated (${d.length} bytes)`, fields: f, flag: 'short-payload' };
        f.action = d[0];
        f.delayMs = d.readUInt16LE(1);
        const raw = d.readUInt16LE(3);
        f.status = raw > 0x7FFF ? raw - 0x10000 : raw;
        f.statusText = FT_STATUS[f.status] || (f.status < 0 ? 'vendor error' : 'vendor status');
        if (d.length >= 7) f.updateMsgMax = d.readUInt16LE(5);
        const s = `status ${f.status} ${f.statusText}, delay ${f.delayMs} ms, action ${ftActionText(f.action)}` +
                  (f.updateMsgMax != null ? `, max msg ${f.updateMsgMax}` : '');
        return { summary: s, fields: f, flag: f.status < 0 ? 'ft-error' : undefined };
      }
      case 0x45: {
        if (d.length >= 12) {
          f.vendor = hex(d.slice(0, 3), ':'); f.model = d[3]; f.version = d[4];
          f.serial = d.readUInt32LE(5).toString(16).toUpperCase().padStart(8, '0');
          f.firmware = `${d[9]}.${d[10]}.${d[11]}`;
          return { summary: `vendor ${f.vendor} model ${f.model} v${f.version} serial ${f.serial} firmware ${f.firmware}`, fields: f };
        }
        break;
      }
      case 0x46: {
        const caps = [];
        for (let o = 0; o + 3 <= d.length; o += 3) caps.push(`${d[o]}:${d[o + 1]}/${d[o + 2]}`);
        f.capabilities = caps;
        return { summary: `${caps.length} capabilities (func:compliance/count) ${caps.join(' ')}`, fields: f };
      }
      case 0x54: if (d.length >= 5) return { summary: `comms now address ${h2(d[0])} baud ${d.readUInt32LE(1)}`, fields: f }; break;
      case 0x76: return { summary: 'secure-channel client cryptogram', fields: f };
      case 0x78: return { summary: 'secure-channel initial reply MAC', fields: f };
      case 0x90: if (d.length >= 3) return { summary: `manufacturer reply, vendor ${hex(d.slice(0, 3), ':')}, ${d.length - 3} data bytes`, fields: f }; break;
      case 0x50: if (d.length >= 4) return { summary: `card read ${d[2] | (d[3] << 8)} bits`, fields: f }; break;
      default: break;
    }
  }
  return { summary: d.length ? `${d.length} data bytes` : '', fields: f };
}

/**
 * Decode one complete frame. Never throws.
 * @param {Buffer} buf  bytes from SOM through CRC/checksum
 */
function decodeFrame(buf) {
  const fr = { len: buf.length };
  try {
    fr.addr = buf[1] & 0x7F;
    fr.reply = !!(buf[1] & 0x80);
    fr.declaredLen = buf.readUInt16LE(2);
    const ctrl = buf[4];
    fr.ctrl = ctrl;
    fr.seq = ctrl & 0x03;
    fr.crcMode = (ctrl & 0x04) ? 'crc16' : 'checksum';
    const hasScb = !!(ctrl & 0x08);
    let o = 5;
    const checkSize = (ctrl & 0x04) ? 2 : 1;

    // integrity first: it's valid regardless of how the rest parses
    const body = buf.slice(0, buf.length - checkSize);
    if (checkSize === 2) {
      const exp = OSDPPacket.calculateCRC(body);
      const act = buf.readUInt16LE(buf.length - 2);
      fr.checkOk = exp === act;
      if (!fr.checkOk) fr.checkDetail = `CRC expected ${h4(exp)} got ${h4(act)}`;
    } else {
      const exp = OSDPPacket.calculateChecksum(body);
      const act = buf[buf.length - 1];
      fr.checkOk = exp === act;
      if (!fr.checkOk) fr.checkDetail = `checksum expected ${h2(exp)} got ${h2(act)}`;
    }

    let macSize = 0;
    if (hasScb) {
      const sl = buf[o], st = buf[o + 1];
      fr.scb = { len: sl, type: st, name: SCS_TYPES[st] || `SCS ${h2(st)}` };
      if (st >= 0x15 && st <= 0x18) macSize = 4;
      o += Math.max(sl, 2);
    }
    if (o >= buf.length - checkSize - macSize) {
      fr.name = 'MALFORMED'; fr.summary = 'no command/reply byte'; fr.flags = ['malformed'];
      return fr;
    }
    fr.code = buf[o++];
    const dataEnd = buf.length - checkSize - macSize;
    const data = buf.slice(o, Math.max(o, dataEnd));
    fr.dataLen = data.length;
    if (macSize) fr.mac = hex(buf.slice(dataEnd, dataEnd + 4));
    fr.name = codeName(fr.code, fr.reply);

    const flags = [];
    if (!fr.checkOk) flags.push('bad-check');
    if (fr.declaredLen !== buf.length) flags.push('length-mismatch');

    const encrypted = fr.scb && (fr.scb.type === 0x17 || fr.scb.type === 0x18) && data.length > 0;
    if (encrypted) {
      fr.summary = `encrypted payload, ${data.length} bytes`;
      fr.encrypted = true;
    } else {
      const d = describePayload(fr.code, fr.reply, data);
      fr.summary = d.summary;
      if (Object.keys(d.fields).length) fr.fields = d.fields;
      if (d.flag) flags.push(d.flag);
      if (d.redact) fr.redact = true;
    }
    if (flags.length) fr.flags = flags;
  } catch (e) {
    fr.name = fr.name || 'MALFORMED';
    fr.summary = `decode error: ${e.message}`;
    fr.flags = (fr.flags || []).concat('malformed');
  }
  return fr;
}

module.exports = { decodeFrame, codeName, hex, h2, h4, NAK_REASONS, FT_STATUS, COMMANDS, REPLIES };
