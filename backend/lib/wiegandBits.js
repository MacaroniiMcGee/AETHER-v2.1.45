/**
 * wiegandBits-v5.js - Enhanced Wiegand Bit Manipulation Library v5.0
 * 
 * COMPLETE SUPPORT FOR ALL CREDENTIAL FORMATS:
 * - Standard Wiegand (26, 30, 32, 34, 37, 38, 40, 46, 48, 56, 64)
 * - Corporate 1000 35/48-bit (interleaved parity)
 * - H10320 36-bit Clock & Data (multi-row parity)
 * - Honeywell 40-bit (XOR checksum)
 * - Indala ASC 27-bit (scrambled bits)
 * - TECOM 27-bit (scrambled bits)
 * - Issue Level formats (K32, Kastle)
 * - Card-only formats (H10302, CASI 40, Keyscan 36)
 * - BigInt support for 64+ bit formats
 */

// ============================================================
// BASIC PARITY FUNCTIONS
// ============================================================

function parityEven(bits) {
  let count = 0;
  for (const b of bits) if (b) count++;
  return (count % 2) === 0;
}

function parityOdd(bits) {
  return !parityEven(bits);
}

function countOnes(bits) {
  let count = 0;
  for (const b of bits) if (b) count++;
  return count;
}

// ============================================================
// BIT CONVERSION UTILITIES
// ============================================================

function bitsFromHexOrBin(raw) {
  const out = [];
  if (!raw) return out;
  if (/^0x/i.test(raw)) {
    const hex = raw.slice(2);
    for (const ch of hex) {
      const v = parseInt(ch, 16);
      if (Number.isNaN(v)) throw new Error("bad hex");
      out.push((v & 8) ? 1 : 0, (v & 4) ? 1 : 0, (v & 2) ? 1 : 0, (v & 1) ? 1 : 0);
    }
  } else {
    for (const ch of raw.replace(/[\s_]/g, "")) {
      if (ch !== "0" && ch !== "1") throw new Error("bad bit char");
      out.push(ch === "1" ? 1 : 0);
    }
  }
  return out;
}

function intToBits(value, numBits) {
  const bits = [];
  for (let i = numBits - 1; i >= 0; i--) {
    bits.push(((value >> i) & 1) ? 1 : 0);
  }
  return bits;
}

function bigIntToBits(value, numBits) {
  const bits = [];
  const bigVal = BigInt(value);
  for (let i = BigInt(numBits - 1); i >= 0n; i--) {
    bits.push(((bigVal >> i) & 1n) ? 1 : 0);
  }
  return bits;
}

function bitsToInt(bits) {
  let value = 0;
  for (const b of bits) {
    value = (value << 1) | (b ? 1 : 0);
  }
  return value;
}

function bitsToBigInt(bits) {
  let value = 0n;
  for (const b of bits) {
    value = (value << 1n) | (b ? 1n : 0n);
  }
  return value;
}

function formatBits(bits) {
  return bits.map(b => b ? "1" : "0").join("");
}

// ============================================================
// STANDARD WIEGAND ENCODING
// ============================================================

/**
 * Compose data bits from facility and card (no parity yet)
 */
function composeData({ format = 26, facility = 0, card = 0, facilityBits, cardBits, issueLevel = 0, issueLevelBits = 0 }) {
  // Format-specific defaults
  if (facilityBits == null || cardBits == null) {
    switch (format) {
      case 26: facilityBits = 8; cardBits = 16; break;
      case 30: facilityBits = 10; cardBits = 18; break;
      case 32: facilityBits = 0; cardBits = 32; break;
      case 34: facilityBits = 16; cardBits = 16; break;
      case 35: facilityBits = 12; cardBits = 20; break;  // Corp1000
      case 36: facilityBits = 0; cardBits = 32; break;   // H10320 card-only
      case 37: facilityBits = 16; cardBits = 19; break;
      case 38: facilityBits = 16; cardBits = 20; break;
      case 40: facilityBits = 16; cardBits = 22; break;
      case 46: facilityBits = 20; cardBits = 24; break;
      case 48: facilityBits = 22; cardBits = 24; break;
      case 56: facilityBits = 24; cardBits = 30; break;
      case 64: facilityBits = 28; cardBits = 34; break;
      default: throw new Error(`Unsupported format: ${format}`);
    }
  }

  const data = [];
  
  // Issue level bits (for K32, Kastle, etc.)
  if (issueLevelBits > 0) {
    for (let i = issueLevelBits - 1; i >= 0; i--) {
      data.push(((issueLevel >> i) & 1) ? 1 : 0);
    }
  }
  
  // Facility bits
  for (let i = facilityBits - 1; i >= 0; i--) {
    data.push(((facility >> i) & 1) ? 1 : 0);
  }
  
  // Card bits (use BigInt for large values)
  if (cardBits > 32) {
    const bigCard = BigInt(card);
    for (let i = BigInt(cardBits - 1); i >= 0n; i--) {
      data.push(((bigCard >> i) & 1n) ? 1 : 0);
    }
  } else {
    for (let i = cardBits - 1; i >= 0; i--) {
      data.push(((card >> i) & 1) ? 1 : 0);
    }
  }
  
  return { data, facilityBits, cardBits, issueLevelBits };
}

/**
 * Apply standard even/odd half parity
 */
function applyStandardParity(data, frameBits = null) {
  const left = Math.floor(data.length / 2);
  const evenParity = parityEven(data.slice(0, left)) ? 0 : 1;
  const oddParity = parityOdd(data.slice(left)) ? 0 : 1;
  const frame = [evenParity, ...data, oddParity];
  
  if (frameBits && frame.length !== frameBits) {
    throw new Error(`Frame length ${frame.length} doesn't match expected ${frameBits}`);
  }
  return frame;
}

/**
 * Apply whole-frame parity (even or odd)
 */
function applyWholeParity(data, type = 'even') {
  const isEven = parityEven(data);
  const pbit = (type === 'even') ? (isEven ? 0 : 1) : (isEven ? 1 : 0);
  return [...data, pbit];
}

/**
 * No parity - just pad if needed
 */
function applyNoParity(data, frameBits = null) {
  let frame = data.slice();
  if (frameBits && frameBits > frame.length) {
    const pad = Array(frameBits - frame.length).fill(0);
    frame = pad.concat(frame);
  }
  return frame;
}

// ============================================================
// INTERLEAVED PARITY (Corporate 1000 35/48-bit)
// ============================================================

/**
 * Corporate 1000 35-bit Format
 * Layout: [OP-whole][EP][01][F11-F0][C19-C0][OP]
 */
function applyInterleavedParity35(facility, card) {
  const frame = new Array(35).fill(0);
  
  // Fixed header "01" at positions 2-3
  frame[2] = 0;
  frame[3] = 1;
  
  // 12-bit facility code at positions 4-15
  for (let i = 0; i < 12; i++) {
    frame[4 + i] = ((facility >> (11 - i)) & 1) ? 1 : 0;
  }
  
  // 20-bit card number at positions 16-35
  for (let i = 0; i < 20; i++) {
    frame[16 + i] = ((card >> (19 - i)) & 1) ? 1 : 0;
  }
  
  // Even parity on left half (bits 2-17)
  frame[1] = parityEven(frame.slice(2, 18)) ? 0 : 1;
  
  // Odd parity on right half (bits 18-33)
  frame[34] = parityOdd(frame.slice(18, 34)) ? 0 : 1;
  
  // Whole-frame odd parity (bits 1-34)
  frame[0] = parityOdd(frame.slice(1, 35)) ? 0 : 1;
  
  return frame;
}

/**
 * Corporate 1000 48-bit Format
 */
function applyInterleavedParity48(facility, card) {
  const frame = new Array(48).fill(0);
  
  frame[2] = 0;
  frame[3] = 1;
  
  for (let i = 0; i < 22; i++) {
    frame[4 + i] = ((facility >> (21 - i)) & 1) ? 1 : 0;
  }
  
  for (let i = 0; i < 20; i++) {
    frame[26 + i] = ((card >> (19 - i)) & 1) ? 1 : 0;
  }
  
  frame[1] = parityEven(frame.slice(2, 25)) ? 0 : 1;
  frame[47] = parityOdd(frame.slice(25, 47)) ? 0 : 1;
  frame[0] = parityOdd(frame.slice(1, 48)) ? 0 : 1;
  
  return frame;
}

// ============================================================
// MULTI-ROW PARITY (H10320 36-bit Clock & Data)
// ============================================================

/**
 * H10320 36-bit Clock & Data Format
 * Card-only format
 */
function applyMultiRowParity(card) {
  const frame = new Array(36).fill(0);
  
  for (let i = 0; i < 32; i++) {
    frame[i] = ((card >> (31 - i)) & 1) ? 1 : 0;
  }
  
  const ep1Positions = [3, 7, 11, 15, 19, 23, 27, 31];
  const ep1Bits = ep1Positions.map(p => frame[p]);
  frame[32] = parityEven(ep1Bits) ? 0 : 1;
  
  const opPositions = [1, 5, 9, 13, 17, 21, 25, 29];
  const opBits = opPositions.map(p => frame[p]);
  frame[33] = parityOdd(opBits) ? 0 : 1;
  
  frame[34] = 0;
  frame[35] = frame[32];
  
  return frame;
}

/**
 * Keyscan 36-bit with facility code
 */
function applyKeyscanParity(facility, card) {
  const frame = new Array(36).fill(0);
  
  for (let i = 0; i < 8; i++) {
    frame[i] = ((facility >> (7 - i)) & 1) ? 1 : 0;
  }
  
  for (let i = 0; i < 24; i++) {
    frame[8 + i] = ((card >> (23 - i)) & 1) ? 1 : 0;
  }
  
  const ep1Positions = [3, 7, 11, 15, 19, 23, 27, 31];
  const ep1Bits = ep1Positions.map(p => frame[p]);
  frame[32] = parityEven(ep1Bits) ? 0 : 1;
  
  const opPositions = [1, 5, 9, 13, 17, 21, 25, 29];
  const opBits = opPositions.map(p => frame[p]);
  frame[33] = parityOdd(opBits) ? 0 : 1;
  
  frame[34] = 0;
  frame[35] = frame[32];
  
  return frame;
}

// ============================================================
// XOR CHECKSUM (Honeywell 40-bit)
// ============================================================

function applyXorChecksum(facility, card) {
  const frame = new Array(40).fill(0);
  
  frame[0] = 1; frame[1] = 1; frame[2] = 1; frame[3] = 1;
  
  for (let i = 0; i < 12; i++) {
    frame[4 + i] = ((facility >> (11 - i)) & 1) ? 1 : 0;
  }
  
  for (let i = 0; i < 16; i++) {
    frame[16 + i] = ((card >> (15 - i)) & 1) ? 1 : 0;
  }
  
  const bytes = [];
  for (let b = 0; b < 4; b++) {
    let byte = 0;
    for (let i = 0; i < 8; i++) {
      byte = (byte << 1) | frame[b * 8 + i];
    }
    bytes.push(byte);
  }
  
  const xorByte = bytes[0] ^ bytes[1] ^ bytes[2] ^ bytes[3];
  
  for (let i = 0; i < 8; i++) {
    frame[32 + i] = ((xorByte >> (7 - i)) & 1) ? 1 : 0;
  }
  
  return frame;
}

// ============================================================
// SCRAMBLED BIT ENCODING
// ============================================================

function encodeIndalaAsc27(facility, card) {
  const frame = new Array(27).fill(0);
  
  const sitePositions = [4, 7, 6, 1, 0, 3, 20, 5, 9, 8, 24, 11, 22];
  for (let i = 0; i < 13 && i < sitePositions.length; i++) {
    if (sitePositions[i] < 27) {
      frame[sitePositions[i]] = ((facility >> (12 - i)) & 1) ? 1 : 0;
    }
  }
  
  const cardPositions = [26, 1, 3, 12, 15, 18, 21, 14, 25, 2, 19, 23, 10, 13];
  for (let i = 0; i < 14; i++) {
    if (cardPositions[i] < 27) {
      frame[cardPositions[i]] = ((card >> (13 - i)) & 1) ? 1 : 0;
    }
  }
  
  return frame;
}

function encodeTecom27(facility, card) {
  const frame = new Array(27).fill(0);
  
  const sitePositions = [1, 3, 5, 7, 9, 11, 13, 15];
  for (let i = 0; i < 8; i++) {
    if (sitePositions[i] < 27) {
      frame[sitePositions[i]] = ((facility >> (7 - i)) & 1) ? 1 : 0;
    }
  }
  
  const cardPositions = [0, 2, 4, 6, 8, 10, 12, 14, 16, 17, 18, 19, 20, 21, 22, 23];
  for (let i = 0; i < 16; i++) {
    if (cardPositions[i] < 27) {
      frame[cardPositions[i]] = ((card >> (15 - i)) & 1) ? 1 : 0;
    }
  }
  
  frame[24] = parityEven(frame.slice(0, 12)) ? 0 : 1;
  frame[25] = parityOdd(frame.slice(12, 24)) ? 0 : 1;
  frame[26] = 0;
  
  return frame;
}

// ============================================================
// ISSUE LEVEL FORMATS
// ============================================================

function encodeK32(facility, card, issueLevel = 0) {
  const data = [];
  
  for (let i = 5; i >= 0; i--) {
    data.push(((issueLevel >> i) & 1) ? 1 : 0);
  }
  
  for (let i = 7; i >= 0; i--) {
    data.push(((facility >> i) & 1) ? 1 : 0);
  }
  
  for (let i = 15; i >= 0; i--) {
    data.push(((card >> i) & 1) ? 1 : 0);
  }
  
  return applyStandardParity(data);
}

function encodeKastle32(facility, card, issueLevel = 0) {
  const data = [];
  
  for (let i = 4; i >= 0; i--) {
    data.push(((issueLevel >> i) & 1) ? 1 : 0);
  }
  
  for (let i = 8; i >= 0; i--) {
    data.push(((facility >> i) & 1) ? 1 : 0);
  }
  
  for (let i = 15; i >= 0; i--) {
    data.push(((card >> i) & 1) ? 1 : 0);
  }
  
  return applyStandardParity(data);
}

// ============================================================
// CARD-ONLY FORMATS
// ============================================================

function encodeH10302CardOnly(card) {
  const data = [];
  const bigCard = BigInt(card);
  
  for (let i = 34n; i >= 0n; i--) {
    data.push(((bigCard >> i) & 1n) ? 1 : 0);
  }
  
  const left = 18;
  const evenParity = parityEven(data.slice(0, left)) ? 0 : 1;
  const oddParity = parityOdd(data.slice(left)) ? 0 : 1;
  
  return [evenParity, ...data, oddParity];
}

function encodeCasi40(card) {
  const frame = [];
  const bigCard = BigInt(card);
  
  for (let i = 39n; i >= 0n; i--) {
    frame.push(((bigCard >> i) & 1n) ? 1 : 0);
  }
  
  return frame;
}

// ============================================================
// INDALA STANDARD FORMATS
// ============================================================

function encodeIndala26(facility, card) {
  const data = [];
  
  for (let i = 11; i >= 0; i--) {
    data.push(((facility >> i) & 1) ? 1 : 0);
  }
  
  for (let i = 11; i >= 0; i--) {
    data.push(((card >> i) & 1) ? 1 : 0);
  }
  
  return applyStandardParity(data);
}

function encodeIndala29(facility, card) {
  const frame = [];
  
  for (let i = 12; i >= 0; i--) {
    frame.push(((facility >> i) & 1) ? 1 : 0);
  }
  
  for (let i = 15; i >= 0; i--) {
    frame.push(((card >> i) & 1) ? 1 : 0);
  }
  
  return frame;
}

// ============================================================
// UNIFIED PARITY APPLICATION
// ============================================================

function applyParity(data, parity = "std", frameBits = null) {
  if (parity === "none") {
    return applyNoParity(data, frameBits);
  }
  
  if (parity === "whole-even") {
    return applyWholeParity(data, 'even');
  }
  
  if (parity === "whole-odd") {
    return applyWholeParity(data, 'odd');
  }
  
  return applyStandardParity(data, frameBits);
}

// ============================================================
// FORMAT-BASED ENCODING (v5.0 Master Function)
// ============================================================

function encodeByFormat(formatId, facility, card, issueLevel = 0) {
  const fmt = formatId.toLowerCase();
  
  // Standard Wiegand formats
  if (fmt === 'w26' || fmt === 'wiegand26' || fmt === 'h10301') {
    const { data } = composeData({ format: 26, facility, card });
    return applyStandardParity(data);
  }
  
  if (fmt === 'w30' || fmt === 'wiegand30') {
    const { data } = composeData({ format: 30, facility, card });
    return applyStandardParity(data);
  }
  
  if (fmt === 'w32' || fmt === 'wiegand32') {
    return intToBits(card, 32);
  }
  
  if (fmt === 'w34' || fmt === 'wiegand34') {
    const { data } = composeData({ format: 34, facility, card });
    return applyStandardParity(data);
  }
  
  if (fmt === 'w37' || fmt === 'wiegand37' || fmt === 'h10304') {
    const { data } = composeData({ format: 37, facility, card });
    return applyStandardParity(data);
  }
  
  if (fmt === 'w38' || fmt === 'wiegand38') {
    const { data } = composeData({ format: 38, facility, card });
    return applyStandardParity(data);
  }
  
  if (fmt === 'w40' || fmt === 'wiegand40' || fmt === 'stid_40') {
    const { data } = composeData({ format: 40, facility, card });
    return applyStandardParity(data);
  }
  
  if (fmt === 'w46' || fmt === 'wiegand46') {
    const { data } = composeData({ format: 46, facility, card });
    return applyStandardParity(data);
  }
  
  if (fmt === 'w48' || fmt === 'wiegand48') {
    const { data } = composeData({ format: 48, facility, card });
    return applyStandardParity(data);
  }
  
  if (fmt === 'w56' || fmt === 'wiegand56') {
    const { data } = composeData({ format: 56, facility, card });
    return applyStandardParity(data);
  }
  
  if (fmt === 'w64' || fmt === 'wiegand64' || fmt === 'seos_64') {
    const { data } = composeData({ format: 64, facility, card });
    return applyStandardParity(data);
  }
  
  // Corporate 1000 (Interleaved Parity)
  if (fmt === 'w35' || fmt === 'corp1000_35' || fmt === 'corporate1000_35') {
    return applyInterleavedParity35(facility, card);
  }
  
  if (fmt === 'corp1000_48' || fmt === 'corporate1000_48') {
    return applyInterleavedParity48(facility, card);
  }
  
  // H10320 / Keyscan (Multi-row Parity)
  if (fmt === 'h10320' || fmt === 'h10320_clockdata') {
    return applyMultiRowParity(card);
  }
  
  if (fmt === 'keyscan_36' || fmt === 'keyscan36') {
    return applyKeyscanParity(facility, card);
  }
  
  // Honeywell (XOR Checksum)
  if (fmt === 'honeywell_40' || fmt === 'hid_honeywell_40' || fmt === 'p10001') {
    return applyXorChecksum(facility, card);
  }
  
  // Scrambled formats
  if (fmt === 'indala27_asc' || fmt === 'indala_asc27') {
    return encodeIndalaAsc27(facility, card);
  }
  
  if (fmt === 'tecom27' || fmt === 'tecom_27') {
    return encodeTecom27(facility, card);
  }
  
  // Issue Level formats
  if (fmt === 'k32') {
    return encodeK32(facility, card, issueLevel);
  }
  
  if (fmt === 'kastle_32' || fmt === 'kastle32') {
    return encodeKastle32(facility, card, issueLevel);
  }
  
  // Card-only formats
  if (fmt === 'h10302' || fmt === 'h10302_cardonly') {
    return encodeH10302CardOnly(card);
  }
  
  if (fmt === 'casi_40' || fmt === 'casi40') {
    return encodeCasi40(card);
  }
  
  // Indala standard formats
  if (fmt === 'indala26' || fmt === 'indala_26') {
    return encodeIndala26(facility, card);
  }
  
  if (fmt === 'indala29' || fmt === 'indala_29') {
    return encodeIndala29(facility, card);
  }
  
  throw new Error(`Unknown format: ${formatId}`);
}

// ============================================================
// FORMAT METADATA QUERIES (v5.0)
// ============================================================

function getFormatInfo(formatId) {
  const fmt = formatId.toLowerCase();
  
  const formatInfo = {
    'w26': { bits: 26, parity: 'std', facilityBits: 8, cardBits: 16, category: 'wiegand' },
    'w30': { bits: 30, parity: 'std', facilityBits: 10, cardBits: 18, category: 'wiegand' },
    'w32': { bits: 32, parity: 'none', facilityBits: 0, cardBits: 32, category: 'wiegand' },
    'w34': { bits: 34, parity: 'std', facilityBits: 16, cardBits: 16, category: 'wiegand' },
    'w35': { bits: 35, parity: 'interleaved', facilityBits: 12, cardBits: 20, category: 'wiegand', warning: 'Interleaved parity' },
    'w37': { bits: 37, parity: 'std', facilityBits: 16, cardBits: 19, category: 'wiegand' },
    'w38': { bits: 38, parity: 'std', facilityBits: 16, cardBits: 20, category: 'wiegand' },
    'w40': { bits: 40, parity: 'std', facilityBits: 16, cardBits: 22, category: 'wiegand' },
    'w46': { bits: 46, parity: 'std', facilityBits: 20, cardBits: 24, category: 'wiegand' },
    'w48': { bits: 48, parity: 'std', facilityBits: 22, cardBits: 24, category: 'wiegand' },
    'w56': { bits: 56, parity: 'std', facilityBits: 24, cardBits: 30, category: 'wiegand' },
    'w64': { bits: 64, parity: 'std', facilityBits: 28, cardBits: 34, category: 'wiegand' },
    'corp1000_35': { bits: 35, parity: 'interleaved', facilityBits: 12, cardBits: 20, category: 'hid', warning: 'Interleaved parity' },
    'corp1000_48': { bits: 48, parity: 'interleaved', facilityBits: 22, cardBits: 20, category: 'hid', warning: 'Interleaved parity' },
    'h10320': { bits: 36, parity: 'multi-row', facilityBits: 0, cardBits: 32, category: 'hid', warning: 'Multi-row parity, card-only' },
    'h10320_clockdata': { bits: 36, parity: 'multi-row', facilityBits: 0, cardBits: 32, category: 'hid', warning: 'Multi-row parity, card-only' },
    'keyscan_36': { bits: 36, parity: 'multi-row', facilityBits: 8, cardBits: 24, category: 'hid', warning: 'Multi-row parity' },
    'honeywell_40': { bits: 40, parity: 'xor', facilityBits: 12, cardBits: 16, category: 'proprietary', warning: 'XOR checksum' },
    'hid_honeywell_40': { bits: 40, parity: 'xor', facilityBits: 12, cardBits: 16, category: 'proprietary', warning: 'XOR checksum' },
    'indala27_asc': { bits: 27, parity: 'scrambled', facilityBits: 13, cardBits: 14, category: 'indala', warning: 'Scrambled bit positions' },
    'tecom27': { bits: 27, parity: 'scrambled', facilityBits: 8, cardBits: 16, category: 'proprietary', warning: 'Scrambled bit positions' },
    'k32': { bits: 32, parity: 'std', facilityBits: 8, cardBits: 16, issueLevelBits: 6, category: 'proprietary', hasIssueLevel: true },
    'kastle_32': { bits: 32, parity: 'std', facilityBits: 9, cardBits: 16, issueLevelBits: 5, category: 'proprietary', hasIssueLevel: true },
    'h10302': { bits: 37, parity: 'std', facilityBits: 0, cardBits: 35, category: 'hid', cardOnly: true },
    'casi_40': { bits: 40, parity: 'none', facilityBits: 0, cardBits: 40, category: 'proprietary', cardOnly: true },
    'indala26': { bits: 26, parity: 'std', facilityBits: 12, cardBits: 12, category: 'indala' },
    'indala29': { bits: 29, parity: 'none', facilityBits: 13, cardBits: 16, category: 'indala' },
  };
  
  return formatInfo[fmt] || null;
}

function requiresIssueLevel(formatId) {
  const info = getFormatInfo(formatId);
  return info && info.hasIssueLevel;
}

function isCardOnly(formatId) {
  const info = getFormatInfo(formatId);
  return info && (info.cardOnly || info.facilityBits === 0);
}

function getFormatWarning(formatId) {
  const info = getFormatInfo(formatId);
  return info ? info.warning : null;
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
  parityEven,
  parityOdd,
  countOnes,
  bitsFromHexOrBin,
  intToBits,
  bigIntToBits,
  bitsToInt,
  bitsToBigInt,
  formatBits,
  composeData,
  applyParity,
  applyStandardParity,
  applyWholeParity,
  applyNoParity,
  applyInterleavedParity35,
  applyInterleavedParity48,
  applyMultiRowParity,
  applyKeyscanParity,
  applyXorChecksum,
  encodeIndalaAsc27,
  encodeTecom27,
  encodeK32,
  encodeKastle32,
  encodeH10302CardOnly,
  encodeCasi40,
  encodeIndala26,
  encodeIndala29,
  encodeByFormat,
  getFormatInfo,
  requiresIssueLevel,
  isCardOnly,
  getFormatWarning,
};
