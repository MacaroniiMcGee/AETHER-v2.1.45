// AETHER OSDP Academy — generated question variants.
//
// A generator turns random parameters into a fresh question with a computed
// answer. Every generated question keeps its `params` so tests can recompute the
// answer independently (tests/generators.test.mjs checks thousands of them).
// Generated questions are never stored by id — progress is recorded per skill.

import { build, hex, crc } from './protocol.mjs?v=198dc99a';

const hx = (n) => (n & 255).toString(16).toUpperCase().padStart(2, '0');

/** Small seeded PRNG so a variant can be reproduced from its seed. */
export function rng(seed = (Math.random() * 2 ** 31) >>> 0) {
  let s = (Math.imul((seed >>> 0) ^ 0x9e3779b9, 0x85ebca6b) >>> 0) || 1;  // scramble so nearby seeds differ
  const next = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
  for (let k = 0; k < 4; k++) next();
  return { seed, next, int: (a, b) => a + Math.floor(next() * (b - a + 1)), pick: (arr) => arr[Math.floor(next() * arr.length)] };
}

const base = (name, r, level, skills, stage, rest) => ({ id: `g-${name}-${r.seed}`, v: 1, generated: true, gen: name, level, skills, stage, ...rest });
const value = (accept) => ({ kind: 'value', accept });
const choice = (options, answer) => ({ kind: 'choice', options, answer });
/** Shuffle options deterministically, keeping track of the right one. */
function shuffled(r, correct, wrong) {
  const all = [correct, ...wrong.filter((w) => w !== correct)].filter((x, i, a) => a.indexOf(x) === i);
  for (let i = all.length - 1; i > 0; i--) { const j = Math.floor(r.next() * (i + 1)); [all[i], all[j]] = [all[j], all[i]]; }
  return choice(all, all.indexOf(correct));
}

export const GENERATORS = {
  decToHex(r) { const n = r.int(16, 255); return base('decToHex', r, 1, ['number-base'], 'calculate', { q: `Convert decimal ${n} to hexadecimal.`, ...value([{ t: 'hex', v: hx(n) }]), why: `${n} = ${n >> 4} × 16 + ${n & 15} → 0x${hx(n)}.`, params: { n } }); },
  hexToDec(r) { const n = r.int(16, 255); return base('hexToDec', r, 1, ['number-base'], 'calculate', { q: `Convert hexadecimal ${hx(n)} to decimal.`, ...value([{ t: 'dec', v: n }]), why: `${hx(n)[0]} × 16 + ${hx(n)[1]} = ${n}.`, params: { n } }); },
  binToHex(r) { const n = r.int(1, 255); const b = n.toString(2).padStart(8, '0'); return base('binToHex', r, 1, ['number-base'], 'calculate', { q: `Convert binary ${b} to hexadecimal.`, ...value([{ t: 'hex', v: hx(n) }]), why: `${b.slice(0, 4)} = ${hx(n)[0]}, ${b.slice(4)} = ${hx(n)[1]} → 0x${hx(n)}.`, params: { n } }); },
  hexToBin(r) { const n = r.int(0, 255); const b = n.toString(2).padStart(8, '0'); return base('hexToBin', r, 1, ['number-base'], 'calculate', { q: `Write hexadecimal ${hx(n)} as eight binary bits.`, ...value([{ t: 'bin', v: b }]), why: `Each hex digit is four bits: ${hx(n)[0]} = ${b.slice(0, 4)}, ${hx(n)[1]} = ${b.slice(4)}.`, params: { n } }); },
  countBytes(r) { const n = r.int(3, 12); const s = Array.from({ length: n }, () => hx(r.int(0, 255))).join(' '); return base('countBytes', r, 1, ['byte-count'], 'calculate', { q: `How many bytes does the hex string ${s} contain?`, ...value([{ t: 'dec', v: n }]), why: 'Two hex digits per byte.', params: { s } }); },
  inclusiveRange(r) { const a = r.int(0, 20), w = r.int(1, 8); return base('inclusiveRange', r, 1, ['byte-count'], 'calculate', { q: `A field occupies offsets ${a}–${a + w - 1} inclusive. How many bytes is it?`, ...value([{ t: 'dec', v: w }]), why: `${a + w - 1} − ${a} + 1 = ${w}.`, params: { a, b: a + w - 1 } }); },
  bitsToBytes(r) { const n = r.int(9, 80); const by = Math.ceil(n / 8); return base('bitsToBytes', r, 1, ['byte-count', 'bit-ops'], 'calculate', { q: `How many bytes are needed to store ${n} credential bits?`, ...value([{ t: 'dec', v: by }]), why: `⌈${n} ÷ 8⌉ = ${by}${by * 8 - n ? ` (${by * 8 - n} unused bit${by * 8 - n === 1 ? '' : 's'})` : ''}.`, params: { n } }); },
  leEncode(r) { const n = r.int(256, 65535); return base('leEncode', r, 1, ['endianness'], 'construct', { q: `Encode decimal ${n} as two little-endian bytes.`, ...value([{ t: 'bytes', v: `${hx(n)} ${hx(n >> 8)}` }]), why: `${n} = 0x${hx(n >> 8)}${hx(n)}; low byte first: ${hx(n)} ${hx(n >> 8)}.`, params: { n } }); },
  leDecode(r) { const n = r.int(256, 65535); return base('leDecode', r, 1, ['endianness'], 'calculate', { q: `Decode little-endian bytes ${hx(n)} ${hx(n >> 8)}.`, ...value([{ t: 'dec', v: n }]), why: `0x${hx(n >> 8)}${hx(n)} = ${n >> 8} × 256 + ${n & 255} = ${n}.`, params: { lo: n & 255, hi: n >> 8 } }); },
  bitSet(r) { const v = r.int(0, 255), b = r.int(0, 7); return base('bitSet', r, 1, ['bit-ops'], 'calculate', { q: `Set bit ${b} in byte ${hx(v)}. What is the result (hex)?`, ...value([{ t: 'hex', v: hx(v | (1 << b)) }]), why: `Bit ${b} is worth 0x${hx(1 << b)}: 0x${hx(v)} OR 0x${hx(1 << b)} = 0x${hx(v | (1 << b))}.`, params: { v, b } }); },
  bitClear(r) { const v = r.int(0, 255), b = r.int(0, 7); return base('bitClear', r, 1, ['bit-ops'], 'calculate', { q: `Clear bit ${b} in byte ${hx(v)}. What remains (hex)?`, ...value([{ t: 'hex', v: hx(v & ~(1 << b)) }]), why: `0x${hx(v)} AND 0x${hx(~(1 << b))} = 0x${hx(v & ~(1 << b))}.`, params: { v, b } }); },
  addrDecode(r) { const a = r.int(0, 126), rep = r.next() < 0.5, v = a | (rep ? 0x80 : 0); const right = `${rep ? 'Reply from' : 'Command to'} address ${a}`;
    return base('addrDecode', r, 2, ['addr-byte'], 'recognize', { q: `Decode ADDR ${hx(v)}.`, ...shuffled(r, right, [`${rep ? 'Command to' : 'Reply from'} address ${a}`, `${rep ? 'Reply from' : 'Command to'} address ${v}`, `Command to address ${a ^ 1}`]), why: `Bit 7 ${rep ? 'set = reply' : 'clear = command'}; 0x${hx(v)} AND 0x7F = ${a}.`, params: { v } }); },
  addrConstruct(r) { const a = r.int(0, 126), rep = r.next() < 0.6; return base('addrConstruct', r, 2, ['addr-byte'], 'construct', { q: `Construct the ADDR byte (hex) for a ${rep ? 'reply from' : 'command to'} address ${a} decimal.`, ...value([{ t: 'hex', v: hx(a | (rep ? 0x80 : 0)) }]), why: `${a} = 0x${hx(a)}${rep ? `; set bit 7 for a reply: 0x${hx(a | 0x80)}` : '; bit 7 stays clear for a command'}.`, params: { a, rep } }); },
  ctrlDecode(r) { const sq = r.int(0, 3), c = r.next() < 0.6, s = r.next() < 0.4; const v = sq | (c ? 4 : 0) | (s ? 8 : 0);
    const txt = (q, cc, ss) => `Sequence ${q}, ${cc ? 'CRC' : 'checksum'}, ${ss ? 'security block present' : 'no security block'}`;
    return base('ctrlDecode', r, 2, ['ctrl-byte'], 'calculate', { q: `Decode CTRL ${hx(v)}.`, ...shuffled(r, txt(sq, c, s), [txt(sq, !c, s), txt(sq, c, !s), txt((sq + 1) & 3, c, s)]), why: `${v.toString(2).padStart(4, '0')}: bits 0–1 = ${sq}, bit 2 = ${c ? 1 : 0}, bit 3 = ${s ? 1 : 0}.`, params: { v } }); },
  ctrlModify(r) { const v = r.int(0, 15), op = r.pick(['toChecksum', 'toCrc', 'addScb', 'removeScb']);
    const out = op === 'toChecksum' ? v & ~4 : op === 'toCrc' ? v | 4 : op === 'addScb' ? v | 8 : v & ~8;
    const say = { toChecksum: 'Change it to use checksum', toCrc: 'Change it to use CRC', addScb: 'Add the security-block flag', removeScb: 'Remove the security-block flag' }[op];
    return base('ctrlModify', r, 2, ['ctrl-byte', 'bit-ops'], 'construct', { q: `CTRL is ${hx(v)}. ${say}, keeping everything else. New CTRL (hex)?`, ...value([{ t: 'hex', v: hx(out) }]), why: `${op.includes('Scb') ? 'Bit 3' : 'Bit 2'} only: 0x${hx(v)} → 0x${hx(out)}.`, params: { v, op } }); },
  lenDecode(r) { const n = r.int(7, 1440); return base('lenDecode', r, 2, ['length', 'endianness'], 'calculate', { q: `Decode LEN bytes ${hx(n)} ${hx(n >> 8)}.`, ...value([{ t: 'dec', v: n }]), why: `0x${hx(n >> 8)}${hx(n)} = ${n} bytes.`, params: { lo: n & 255, hi: n >> 8 } }); },
  frameLength(r) { const d = r.int(0, 30), c = r.next() < 0.6, scb = r.pick([0, 0, 3]); const n = 5 + scb + 1 + d + (c ? 2 : 1);
    return base('frameLength', r, 2, ['length'], 'calculate', { q: `A ${c ? 'CRC' : 'checksum'} frame has ${scb ? `a ${scb}-byte security block` : 'no security block'} and ${d} payload byte${d === 1 ? '' : 's'}. What is its total length?`, ...value([{ t: 'dec', v: n }]), why: `5 header${scb ? ` + ${scb} SCB` : ''} + 1 code + ${d} payload + ${c ? 2 : 1} check = ${n}.`, params: { d, c, scb } }); },
  scbOffset(r) { const n = r.int(2, 6), which = r.pick(['code', 'payload']); const v = 5 + n + (which === 'payload' ? 1 : 0);
    return base('scbOffset', r, 2, ['scb-offsets'], 'calculate', { q: `The security block begins at offset 5 and declares length ${n}. At what offset is the ${which === 'code' ? 'command code' : 'first payload byte'}?`, ...value([{ t: 'dec', v }]), why: `SCB occupies offsets 5–${4 + n}; code at ${5 + n}${which === 'payload' ? `, payload from ${6 + n}` : ''}.`, params: { n, which } }); },
  buildPoll(r) { const a = r.int(0, 126), s = r.int(1, 3), cmode = r.next() < 0.75; const expect = hex(build({ address: a, sequence: s, command: 0x60, crcMode: cmode }));
    return base('buildPoll', r, 2, ['construct', 'addr-byte', 'ctrl-byte', 'length'], 'construct', { kind: 'frame', q: `Build a ${cmode ? 'CRC' : 'checksum'} POLL to address ${a}, sequence ${s}. Type the whole frame in hex.`, expect, why: `53 · ${hx(a)} · ${hx(cmode ? 8 : 7)} 00 · ${hx(s | (cmode ? 4 : 0))} · 60 · then the ${cmode ? 'CRC-16 (low byte first)' : 'checksum'}.`, params: { a, s, cmode } }); },
  nextSequence(r) { const s = r.int(0, 3); const n = s === 0 ? 1 : (s % 3) + 1; return base('nextSequence', r, 3, ['sequence'], 'calculate', { q: `The last command to a reader used SQN ${s}${s === 0 ? ' (a restart)' : ''}. What SQN does the next new command normally use?`, ...value([{ t: 'dec', v: n }]), why: 'SQN cycles 1, 2, 3, 1…; after 0 comes 1.', params: { s } }); },
  signed16(r) { const v = r.int(-6, 3); const u = v & 0xffff; return base('signed16', r, 3, ['file-transfer', 'endianness'], 'calculate', { q: `Decode the signed FTSTAT status bytes ${hx(u)} ${hx(u >> 8)}.`, ...value([{ t: 'dec', v }]), why: `0x${hx(u >> 8)}${hx(u)}${v < 0 ? ` has its top bit set: ${u} − 65536 = ${v}` : ` = ${v}`}.`, params: { lo: u & 255, hi: u >> 8 } }); },
  fragmentNext(r) { const off = r.int(0, 64) * 16, sz = r.int(1, 16) * 8; return base('fragmentNext', r, 3, ['file-transfer'], 'calculate', { q: `A file fragment starts at offset ${off} and contains ${sz} bytes. Where would the next contiguous fragment begin?`, ...value([{ t: 'dec', v: off + sz }]), why: `${off} + ${sz} = ${off + sz}.`, params: { off, sz } }); },
  fragmentOverflow(r) { const total = r.int(4, 40) * 10, off = r.int(0, total), sz = r.int(1, 60); const over = off + sz > total;
    return base('fragmentOverflow', r, 3, ['file-transfer'], 'investigate', { q: `A file claims ${total} total bytes; a fragment begins at ${off} and carries ${sz}. Does it fit?`, ...shuffled(r, over ? 'No — it extends beyond the declared file size' : 'Yes — it ends within the file', [over ? 'Yes — it ends within the file' : 'No — it extends beyond the declared file size']), why: `${off} + ${sz} = ${off + sz} ${over ? '>' : '≤'} ${total}.`, params: { total, off, sz } }); },
  frameTime(r) { const n = r.int(7, 60), baud = r.pick([9600, 19200, 38400, 57600, 115200]); const ms = Math.round((n * 10 / baud) * 1e5) / 100;
    return base('frameTime', r, 4, ['timing'], 'calculate', { q: `A ${n}-byte frame at ${baud} baud, 8N1. How long is its transmission, in ms (2 decimals)?`, ...value([{ t: 'num', v: ms, tol: 0.06 }]), why: `${n} × 10 bits ÷ ${baud} = ${ms} ms.`, params: { n, baud } }); },
  evidenceField(r) {
    const field = r.pick(['ADDR', 'LEN', 'CTRL', 'CMD', 'CRC']);
    const a = r.int(1, 30), rep = r.next() < 0.5;
    // spec-valid messages only: [code, DATA]
    const [code, payload] = rep ? r.pick([[0x40, []], [0x41, [r.int(1, 6)]], [0x48, [r.int(0, 1), r.int(0, 1)]], [0x4a, Array.from({ length: r.int(1, 4) }, () => r.int(0, 1))]])
      : r.pick([[0x60, []], [0x61, [0]], [0x62, [0]], [0x64, []], [0x68, [r.int(0, 3), r.pick([1, 2, 5, 6]), r.int(0, 255), r.int(0, 3)]]]);
    const b = build({ address: a, reply: rep, sequence: r.int(1, 3), command: code, payload });
    const pick = field === 'ADDR' ? [[0, 1]] : field === 'LEN' ? [[0, 2], [0, 3]] : field === 'CTRL' ? [[0, 4]] : field === 'CMD' ? [[0, 5]] : [[0, b.length - 2], [0, b.length - 1]];
    const what = { ADDR: 'the address byte', LEN: 'both length bytes', CTRL: 'the control byte', CMD: `the ${rep ? 'reply' : 'command'} code`, CRC: 'both CRC bytes' }[field];
    return base('evidenceField', r, 2, ['framing'], 'recognize', { kind: 'evidence-only', q: `Click ${what} in this frame.`, frames: [{ label: 'frame', hex: hex(b) }], evidence: { prompt: `Click ${what}.`, pick }, why: `${field} sits at offset${pick.length > 1 ? 's' : ''} ${pick.map((p) => p[1]).join(' and ')}.`, params: { field, len: b.length } });
  },
};

/** Skill → generators that test it (for remediation and review). */
export const BY_SKILL = (() => {
  const m = {};
  for (const [name, g] of Object.entries(GENERATORS)) { const q = g(rng(1)); for (const s of q.skills) (m[s] ||= []).push(name); }
  return m;
})();

export function generate(name, seed) { const g = GENERATORS[name]; if (!g) throw Error(`No generator ${name}`); return g(rng(seed)); }
export function variantFor(skillOrGen, seed) {
  const names = GENERATORS[skillOrGen] ? [skillOrGen] : BY_SKILL[skillOrGen] || [];
  if (!names.length) return null;
  const r = rng(seed);
  return generate(names[Math.floor(r.next() * names.length)], (r.next() * 2 ** 31) >>> 0);
}
export { crc };
