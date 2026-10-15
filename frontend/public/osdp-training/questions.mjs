// AETHER OSDP Academy — question bank (v3).
//
// Every question has a STABLE id and a version; progress is stored against
// `${id}@${v}`, so reordering or adding questions never moves anyone's record.
// Bump `v` when a question's meaning or answer changes.
//
// kinds
//   choice  options[], answer = index
//   value   accept = [{ t: 'hex'|'dec'|'bin'|'bytes'|'num'|'text', v, tol? }] — any match is correct
//   frame   construct a whole frame; `expect` = hex; graded field by field
// optional
//   frames   [{ label, hex, ts? }] shown with the question (built here with build(), so check bytes are real)
//   evidence { prompt, pick: [[frameIndex, byteOffset], …] } — learner clicks the supporting bytes
//   headerOnly  true when the bytes shown are not a complete, validated frame
//   gen      generator id(s) for "try a variant" (generators.mjs)
//   hint     shown on request in Practice (never in Assessment)
// stage: recognize · calculate · construct · investigate · explain

import { build, hex } from './protocol.mjs?v=198dc99a';

export const SKILLS = {
  'number-base': 'Number bases & hex',
  'byte-count': 'Counting bytes & offsets',
  endianness: 'Little-endian values',
  'bit-ops': 'Bits & masks',
  layers: 'Addresses & layers',
  'evidence-limits': 'What evidence proves',
  'addr-byte': 'ADDR byte',
  'ctrl-byte': 'CTRL byte',
  length: 'LEN & frame length',
  'scb-offsets': 'Security block & offsets',
  framing: 'Frame boundaries & integrity',
  construct: 'Building frames',
  sequence: 'Sequence numbers',
  pairing: 'Command ↔ reply pairing',
  'file-transfer': 'File transfer',
  secure: 'Secure Channel',
  keys: 'Key handling',
  timing: 'Timing',
  capture: 'Capture method',
  vendor: 'Vendor extensions',
  'io-states': 'Four-state inputs & outputs',
  support: 'Support & escalation',
};
export const STAGES = ['recognize', 'calculate', 'construct', 'investigate', 'explain'];
export const levels = ['Foundations', 'Reading the header', 'Conversations', 'Security & timing', 'Vendor & support'];

// ── helpers ────────────────────────────────────────────────────────────────
const F = (o) => hex(build(o));
const C = (id, level, skills, stage, q, options, answer, why, extra = {}) => ({ id, v: 1, level, skills, stage, kind: 'choice', q, options, answer, why, ...extra });
const V = (id, level, skills, stage, q, accept, why, extra = {}) => ({ id, v: 1, level, skills, stage, kind: 'value', q, accept, why, ...extra });
const hexA = (v) => ({ t: 'hex', v });
const decA = (v) => ({ t: 'dec', v });
const YES_NO_WHY = (no) => (no ? ['No', 'Yes'] : ['Yes', 'No']);

// ── the original 34 knowledge checks (ids are stable; k = original) ────────
const original = [
  C('k1-01', 1, ['number-base'], 'recognize', 'How many bits are in one byte?', ['4', '8', '16'], 1, 'Eight bits; two hex digits describe one byte.'),
  C('k1-02', 1, ['evidence-limits'], 'explain', 'What does a reader’s RAW reply establish?', ['The door opened', 'A credential was read', 'Access was granted'], 1, 'The controller still has to apply its access rules.'),
  C('k1-03', 1, ['number-base'], 'calculate', '0x53 is hexadecimal. What is it in decimal?', ['53', '83', '103'], 1, '5 × 16 + 3 = 83.', { gen: 'hexToDec' }),
  C('k1-04', 1, ['layers'], 'recognize', 'Who begins every OSDP exchange?', ['The reader', 'The controller (ACU)', 'Whoever has data'], 1, 'Only the ACU sends spontaneously; each command gets exactly one reply.'),
  C('k1-05', 1, ['number-base'], 'calculate', 'Hex 10 equals…', ['10', '16', '2'], 1, '1 × 16 + 0 = 16.', { gen: 'hexToDec' }),
  C('k1-06', 1, ['framing'], 'recognize', 'Which byte starts every OSDP frame?', ['0xFF', '0x53', '0x7E'], 1, 'SOM is 0x53. An optional 0xFF mark may come before it but is not part of the counted frame.'),
  C('k2-01', 2, ['addr-byte'], 'calculate', 'ADDR 0x82 means…', ['Command to address 0x82', 'Reply from address 2', 'Reply from address 128'], 1, '0x82 AND 0x7F = 2, and bit 7 is set.', { gen: 'addrDecode' }),
  C('k2-02', 2, ['length', 'endianness'], 'calculate', 'Length bytes 14 00 describe how many bytes?', ['14', '20', '5120'], 1, 'Little-endian: 0x0014 = 20.', { gen: 'lenDecode' }),
  C('k2-03', 2, ['ctrl-byte'], 'calculate', 'CTRL 0x05 means…', ['SQN 1, CRC, no SCB', 'SQN 5, checksum', 'Encrypted payload'], 0, 'Bits 0–1 = 1, bit 2 = 1, bit 3 = 0.', { gen: 'ctrlDecode' }),
  C('k2-04', 2, ['scb-offsets'], 'recognize', 'Where is the command code when CTRL bit 3 is set?', ['Always offset 5', 'Right after the security block', 'After the CRC'], 1, 'Offset 5 holds the SCB length; the code follows the SCB.', { gen: 'scbOffset' }),
  C('k2-05', 2, ['ctrl-byte'], 'investigate', 'CTRL 0x1D — what is wrong?', ['Nothing', 'Reserved bit 4 is set', 'Sequence 5 is illegal'], 1, '0x1D = 0001 1101: bit 4 is reserved and must be 0.'),
  C('k2-06', 2, ['length'], 'recognize', 'LEN counts…', ['Only the DATA', 'SOM through the last check byte', 'Everything including the 0xFF mark'], 1, 'The whole frame, excluding any leading mark byte.'),
  C('k3-01', 3, ['sequence'], 'explain', 'A command with SQN 2 gets a reply with SQN 2. Is that a gap?', ['Yes', 'No', 'Only for LED'], 1, 'A reply echoes its command’s sequence number.'),
  C('k3-02', 3, ['sequence'], 'explain', 'The controller sends the same command again with the same SQN. What should the reader do?', ['Run it again', 'Resend its previous reply without acting twice', 'NAK 0x04'], 1, 'Same SQN and same bytes = retransmission (spec same-sqn-retransmit).'),
  C('k3-03', 3, ['pairing'], 'recognize', 'Which reply is NOT allowed to answer POLL?', ['RAW', 'KEYPAD', 'PDCAP'], 2, 'PDCAP answers CAP. POLL gets ACK or an event such as RAW, KEYPAD or a status report.'),
  C('k3-04', 3, ['pairing', 'sequence'], 'explain', 'A reader answers BUSY. What should the controller do?', ['Send the same command with the same SQN', 'Send the next command with SQN+1', 'Reset with SQN 0'], 0, 'BUSY means “try again”; repeat the original command unchanged.'),
  C('k3-05', 3, ['pairing'], 'explain', 'After NAK 0x03 (unknown command), retrying…', ['Usually fixes it', 'Will not help', 'Is required 3 times'], 1, 'Only NAK 0x01 (bad check) is worth retrying.'),
  C('k3-06', 3, ['evidence-limits'], 'explain', 'A 26-bit RAW read is always H10301.', ['True', 'False'], 1, 'Several formats use 26 bits. Use a documented format map.'),
  C('k3-07', 3, ['evidence-limits'], 'explain', 'A PDCAP record’s third byte always means a count of devices.', ['True', 'False'], 1, 'It depends on the function; for receive buffer size it is the high byte of a number.'),
  C('k3-08', 3, ['sequence'], 'investigate', 'A reply arrives with SQN 0 to an ordinary POLL. Most likely…', ['Normal', 'The reader restarted and asks for a sequence reset', 'A CRC error'], 1, 'A PD reply with SQN 0 (except BUSY) asks the ACU to reset and clears any secure session.'),
  C('k4-01', 4, ['secure'], 'explain', 'The CRC passes on an encrypted frame. Can we read the payload?', ['Yes, CRC decrypts it', 'No, the session keys are needed', 'Yes, if the vendor matches'], 1, 'Integrity checks neither decrypt nor authenticate.'),
  C('k4-02', 4, ['secure'], 'recognize', 'Put the Secure Channel steps in order.', ['CHLNG → CCRYPT → SCRYPT → RMAC_I', 'CCRYPT → CHLNG → RMAC_I → SCRYPT', 'KEYSET → CHLNG → ACK'], 0, 'SCS_11 → SCS_12 → SCS_13 → SCS_14.'),
  { ...C('k4-03', 4, ['secure'], 'explain', 'RMAC_I carries status 0xFF in its security block. What does that establish?', ['The session is up', 'The reader rejected the controller’s cryptogram', 'The reader is busy'], 1, '0x01 = accepted, 0xFF = rejected. A key mismatch is one possible cause; a reset between steps or an implementation fault can also produce it.'), v: 2 },
  C('k4-04', 4, ['secure'], 'recognize', 'Inside a session, a command with DATA must use…', ['SCS_15', 'SCS_17', 'No security block'], 1, 'SCS_15/16 are MAC-only and meant for messages without DATA.'),
  C('k4-05', 4, ['timing'], 'recognize', 'How long may a reader take to start its reply?', ['Under 200 ms (typically < 3 ms)', 'Up to 2 s', 'Up to 8 s'], 0, 'REPLY_DELAY is at most 200 ms.'),
  C('k4-06', 4, ['timing'], 'recognize', 'After how long without traffic does a reader consider itself off-line?', ['200 ms', '8 s', '60 s'], 1, 'More than 8 s between answered messages.'),
  C('k4-07', 4, ['secure'], 'recognize', 'NAK 0x06 means…', ['Bad CRC', 'Encrypted communication is required for this command', 'Unknown command'], 1, 'The reader is configured to require Secure Channel.'),
  C('k4-08', 4, ['keys'], 'explain', 'KEYSET is sent in plaintext on a live site. Concern?', ['None', 'The new key is exposed on the wire', 'Only the sequence'], 1, 'KEYSET belongs inside an encrypted session or physically secured install mode.'),
  C('k5-01', 5, ['vendor'], 'explain', 'An unknown vendor payload contains 01. What should support report?', ['Profile enabled', 'Opaque value 01; find the matching vendor document', 'Firmware version 1'], 1, 'Do not turn an undocumented value into a product claim.'),
  C('k5-02', 5, ['vendor'], 'recognize', 'How should a vendor schema be scoped?', ['Vendor only', 'Vendor, model, firmware and document revision', 'Any reader using MFG'], 1, 'Extensions change across product families and firmware.'),
  C('k5-03', 5, ['capture'], 'explain', 'A tap that also sends POLLs to the bus is…', ['Passive', 'Active — a second controller', 'Passive at 9600 baud'], 1, 'Any transmitted command makes it a participant and can collide with the real controller.'),
  C('k5-04', 5, ['vendor', 'evidence-limits'], 'explain', 'Which evidence supports a vendor feature claim?', ['A byte changed', 'Documented meaning plus repeatable capture and device behaviour', 'An ACK'], 1, 'Separate transport acceptance, documented meaning and observed behaviour.'),
  C('k5-05', 5, ['capture'], 'investigate', 'A capture has only replies, no commands. First suspicion?', ['The controller is dead', 'The capture point only hears one direction', 'The reader is in Secure Channel'], 1, 'Receive-only taps commonly miss the controller side.'),
  C('k5-06', 5, ['support'], 'explain', 'Aether’s OSDP Trace and the Academy disagree on a field. What next?', ['Trust whichever looks right', 'Note the frame bytes and report it — both use the same SIA 2.2.2 tables', 'Ignore it'], 1, 'One shared field table means a mismatch is a bug worth reporting with the bytes.'),
];
/** Index order of the original v2.1 array — used once to migrate old progress. */
export const LEGACY_ORDER = original.map((q) => q.id);

// ── Section 1: Foundations ─────────────────────────────────────────────────
const s1 = [
  V('s1-01', 1, ['number-base'], 'calculate', 'Convert decimal 96 to hexadecimal.', [hexA('60')], '96 = 6 × 16 + 0 → 0x60.', { gen: 'decToHex' }),
  V('s1-02', 1, ['number-base'], 'calculate', 'Convert hexadecimal A5 to decimal.', [decA(165)], 'A = 10: 10 × 16 + 5 = 165.', { gen: 'hexToDec' }),
  V('s1-03', 1, ['number-base'], 'calculate', 'Convert binary 10000010 to hexadecimal.', [hexA('82')], 'Split into nibbles: 1000 = 8, 0010 = 2 → 0x82.', { gen: 'binToHex' }),
  V('s1-04', 1, ['number-base'], 'calculate', 'Write hexadecimal 0F as eight binary bits.', [{ t: 'bin', v: '00001111' }], '0 = 0000, F = 1111 → 00001111. Keep the leading zeros: a byte always has eight bits.', { gen: 'hexToBin' }),
  V('s1-05', 1, ['number-base'], 'recognize', 'What is the largest unsigned value one byte can hold?', [decA(255), hexA('FF')], 'Eight bits all set: 1111 1111 = 255 = 0xFF.'),
  V('s1-06', 1, ['byte-count'], 'calculate', 'How many bytes does the hex string 53 02 08 00 05 60 contain?', [decA(6)], 'Two hex digits per byte; six pairs.', { headerOnly: true, gen: 'countBytes' }),
  V('s1-07', 1, ['byte-count'], 'calculate', 'A field occupies offsets 6–9 inclusive. How many bytes is it?', [decA(4)], 'Inclusive range: 9 − 6 + 1 = 4.', { gen: 'inclusiveRange' }),
  V('s1-08', 1, ['byte-count', 'bit-ops'], 'calculate', 'How many bytes are needed to store 37 credential bits?', [decA(5)], '⌈37 ÷ 8⌉ = 5 bytes (40 bits), with three unused storage bits.', { gen: 'bitsToBytes' }),
  V('s1-09', 1, ['byte-count', 'bit-ops'], 'calculate', 'How many bytes are needed to store 48 credential bits?', [decA(6)], '48 ÷ 8 = 6 exactly.', { gen: 'bitsToBytes' }),
  V('s1-10', 1, ['endianness'], 'construct', 'Encode decimal 500 as two little-endian bytes.', [{ t: 'bytes', v: 'F4 01' }], '500 = 0x01F4. Little-endian puts the low byte first: F4 01.', { gen: 'leEncode' }),
  V('s1-11', 1, ['endianness'], 'calculate', 'Decode little-endian bytes 00 02.', [decA(512)], 'Low byte 00, high byte 02: 0x0200 = 2 × 256 = 512.', { gen: 'leDecode' }),
  C('s1-12', 1, ['number-base'], 'explain', 'Why does hexadecimal 20 differ from decimal 20?', ['It doesn’t — the digits are the same', 'Different number bases: 0x20 equals decimal 32', '0x20 is a character, not a number'], 1, 'Same digits, different base: 2 × 16 + 0 = 32.'),
  V('s1-13', 1, ['bit-ops'], 'calculate', 'Set bit 7 in byte 02. What is the result (hex)?', [hexA('82')], 'Bit 7 is worth 0x80: 0x02 OR 0x80 = 0x82.', { gen: 'bitSet' }),
  V('s1-14', 1, ['bit-ops'], 'calculate', 'Clear bit 7 in byte 85. What remains (hex)?', [hexA('05')], '0x85 AND 0x7F = 0x05.', { gen: 'bitClear' }),
  C('s1-15', 1, ['layers'], 'explain', 'A reader uses OSDP address 2. Does that necessarily mean door 2?', ['Yes — address and door are the same', 'No — device address and application door assignment are separate', 'Only on a single-door controller'], 1, 'The address selects a device on the bus; which door it serves is controller configuration.'),
  C('s1-16', 1, ['layers'], 'explain', 'Does a reader’s OSDP address identify its IP address?', ['Yes, it is the last octet', 'No — they belong to different communication layers', 'Only when the reader is PoE'], 1, 'OSDP addresses live on the RS-485 link; IP addresses on an Ethernet network.'),
  C('s1-17', 1, ['layers'], 'explain', 'What is the difference between the reader number in a payload and the PD address in the header?', ['They are the same number written twice', 'The address selects the peripheral; the reader number identifies a reader associated with that peripheral', 'The reader number is the IP address'], 1, 'One PD can serve more than one reader head; the payload’s reader number says which.'),
  C('s1-18', 1, ['evidence-limits'], 'explain', 'A valid KEYPAD reply reaches the controller. Does this establish that the PIN was accepted?', ['Yes', 'No — it establishes that the key data was reported'], 1, 'The controller still decides whether the PIN is valid.'),
  C('s1-19', 1, ['layers'], 'explain', 'What is the difference between electrical RS-485 communication and OSDP?', ['None', 'RS-485 provides the electrical interface; OSDP defines the messages and exchanges', 'OSDP is the cable; RS-485 is the software'], 1, 'Layers: RS-485 moves bits on wires; OSDP gives them meaning.'),
  C('s1-20', 1, ['capture', 'evidence-limits'], 'explain', 'Why must a simulated trace be labelled separately from a hardware capture?', ['It needn’t be', 'It demonstrates constructed behaviour, not observed device behaviour', 'Simulated traces have no CRC'], 1, 'Evidence about real devices must come from real devices.'),
];

// ── Section 2: Reading the header ──────────────────────────────────────────
const s2 = [
  C('s2-01', 2, ['addr-byte'], 'recognize', 'Decode ADDR 05.', ['Command to peripheral address 5', 'Reply from peripheral address 5', 'Command to address 0x85'], 0, 'Bit 7 clear = command; bits 0–6 = 5.', { gen: 'addrDecode' }),
  C('s2-02', 2, ['addr-byte'], 'recognize', 'Decode ADDR 85.', ['Command to address 133', 'Reply from peripheral address 5', 'Broadcast'], 1, 'Bit 7 set = reply; 0x85 AND 0x7F = 5.', { gen: 'addrDecode' }),
  V('s2-03', 2, ['addr-byte'], 'construct', 'Construct the ADDR byte (hex) for a reply from address 17 decimal.', [hexA('91')], '17 = 0x11; set bit 7 for a reply: 0x11 OR 0x80 = 0x91.', { gen: 'addrConstruct' }),
  C('s2-04', 2, ['ctrl-byte'], 'calculate', 'Decode CTRL 06.', ['Sequence 2, CRC, no security block', 'Sequence 6, checksum', 'Sequence 2, checksum, security block'], 0, '0110: bits 0–1 = 2, bit 2 = 1 (CRC), bit 3 = 0.', { gen: 'ctrlDecode' }),
  C('s2-05', 2, ['ctrl-byte'], 'calculate', 'Decode CTRL 0B.', ['Sequence 3, CRC, no security block', 'Sequence 3, checksum, security block present', 'Sequence 11'], 1, '1011: bits 0–1 = 3, bit 2 = 0 (checksum), bit 3 = 1 (SCB).', { gen: 'ctrlDecode' }),
  C('s2-06', 2, ['ctrl-byte'], 'calculate', 'Decode CTRL 0C.', ['Sequence 0, CRC, security block present', 'Sequence 3, checksum', 'Reserved bits set'], 0, '1100: sequence 0, CRC, security block.', { gen: 'ctrlDecode' }),
  V('s2-07', 2, ['ctrl-byte', 'bit-ops'], 'construct', 'Change CTRL 05 to use checksum while preserving its sequence. New CTRL (hex)?', [hexA('01')], 'Clear bit 2 (CRC flag): 0x05 AND NOT 0x04 = 0x01. The check trailer must then be recalculated.', { gen: 'ctrlModify' }),
  V('s2-08', 2, ['ctrl-byte', 'bit-ops'], 'construct', 'Add the security-block flag to CTRL 06. New CTRL (hex)?', [hexA('0E')], 'Set bit 3: 0x06 OR 0x08 = 0x0E. Actual SCB bytes must also be supplied after CTRL.', { gen: 'ctrlModify' }),
  V('s2-09', 2, ['ctrl-byte', 'bit-ops'], 'calculate', 'Which mask (hex) extracts the sequence from a CTRL byte?', [hexA('03')], 'Sequence lives in bits 0–1: CTRL AND 0x03. For CTRL 0F the result is sequence 3.'),
  V('s2-10', 2, ['length', 'endianness'], 'calculate', 'Decode LEN bytes 2C 01.', [decA(300)], '0x012C = 1 × 256 + 44 = 300 bytes.', { gen: 'lenDecode' }),
  V('s2-11', 2, ['length', 'endianness'], 'construct', 'Encode a total frame length of 260 bytes as the two LEN bytes.', [{ t: 'bytes', v: '04 01' }], '260 = 0x0104 → low byte 04, high byte 01.', { gen: 'leEncode' }),
  V('s2-12', 2, ['length'], 'calculate', 'A CRC frame has no SCB and five payload bytes. What is its total length?', [decA(13)], 'Five header bytes (SOM, ADDR, LEN×2, CTRL) + one code + five payload + two CRC = 13.', { gen: 'frameLength' }),
  C('s2-13', 2, ['length', 'ctrl-byte'], 'explain', 'The same frame switches to checksum. What changes?', ['Only the trailer', 'CTRL bit 2 clears, total length becomes 12, and the trailer is recalculated', 'Nothing — LEN excludes the trailer'], 1, 'The trailer shrinks from 2 bytes to 1, LEN follows, and every changed byte changes the check value.'),
  V('s2-14', 2, ['scb-offsets'], 'calculate', 'The SCB begins at offset 5 and declares length 3. At what offset is the command code?', [decA(8)], 'The SCB occupies offsets 5, 6 and 7; the code follows at 8.', { gen: 'scbOffset' }),
  V('s2-15', 2, ['scb-offsets'], 'calculate', 'In that frame, at what offset does the payload begin?', [decA(9)], 'Code at 8, payload from 9.', { gen: 'scbOffset' }),
  V('s2-16', 2, ['length', 'framing'], 'calculate', 'A physical capture contains a leading FF plus a frame whose LEN is 12. How many captured bytes are present (assuming nothing else)?', [decA(13)], 'LEN counts SOM through the last check byte; the FF mark is extra: 12 + 1 = 13.'),
  C('s2-17', 2, ['framing', 'evidence-limits'], 'investigate', 'LEN declares 20, but the record contains 18 bytes. What can you conclude?', ['The frame is fine', 'A length discrepancy exists; truncation or corruption needs investigation', 'The reader is faulty'], 1, 'Record the discrepancy; its cause is not yet known.'),
  C('s2-18', 2, ['framing'], 'explain', 'A byte 53 appears inside payload data. Does it automatically start another packet?', ['Yes', 'No — parsing must respect the current frame boundaries'], 1, 'SOM is only meaningful where a frame can start; inside a frame LEN decides.'),
  C('s2-19', 2, ['secure', 'scb-offsets'], 'explain', 'In a protected frame, should the four MAC bytes be decoded as application payload?', ['Yes', 'No — they are a separate authentication trailer'], 1, 'The MAC sits between the DATA and the check bytes.'),
  { id: 's2-20', v: 1, level: 2, skills: ['construct', 'addr-byte', 'ctrl-byte', 'length'], stage: 'construct', kind: 'frame',
    q: 'Build a CRC POLL to address 5, sequence 2. Type the whole frame in hex (use the Frame builder or the CRC calculator for the last two bytes).',
    expect: F({ address: 5, sequence: 2, command: 0x60 }), gen: 'buildPoll',
    why: 'SOM 53 · ADDR 05 (command to 5) · LEN 08 00 (eight bytes) · CTRL 06 (SQN 2, CRC) · CMD 60 (POLL) · then the CRC-16, low byte first.' },
];

// ── Section 3: Conversations (mostly multi-frame, with evidence) ───────────
const poll = (a, s, extra = {}) => F({ address: a, sequence: s, command: 0x60, ...extra });
const ack = (a, s) => F({ address: a, reply: true, sequence: s, command: 0x40 });
const ledA = F({ address: 2, sequence: 2, command: 0x69, payload: [0, 0, 1, 0, 0, 2, 0, 0, 0, 1, 0, 0, 1, 0] });
const ledB = F({ address: 2, sequence: 2, command: 0x69, payload: [0, 0, 1, 0, 0, 2, 0, 0, 0, 1, 0, 0, 2, 0] });
const diffAt = (a, b) => { const x = a.split(' '), y = b.split(' '); const out = []; x.forEach((v, i) => { if (v !== y[i] && i < x.length - 2) out.push(i); }); return out; };
const ftstat = (a, s, status) => F({ address: a, reply: true, sequence: s, command: 0x7a, payload: [0, 0, 0, status & 255, (status >> 8) & 255, 0, 0] });
const ftReq = (a, s, total, off, frag) => F({ address: a, sequence: s, command: 0x7c, payload: [1, total & 255, (total >> 8) & 255, 0, 0, off & 255, (off >> 8) & 255, 0, 0, frag & 255, frag >> 8, ...Array(frag).fill(0xaa)] });

const s3 = [
  V('s3-01', 3, ['sequence'], 'calculate', 'One transaction uses sequence 3. What sequence normally follows for the next new command to that reader?', [decA(1)], 'SQN cycles 1, 2, 3, 1…; 0 is only for a (re)start.',
    { frames: [{ label: 'command', hex: poll(2, 3) }, { label: 'reply', hex: ack(2, 3) }], evidence: { prompt: 'Click the byte that carries the command’s sequence number.', pick: [[0, 4]] }, gen: 'nextSequence' }),
  C('s3-02', 3, ['sequence'], 'investigate', 'Readers at addresses 2 and 3 have different current sequences. Is that inherently wrong?', ['Yes — one bus, one sequence', 'No — sequence state is maintained separately for each peripheral'], 1, 'Each PD has its own SQN counter.',
    { frames: [{ label: 'to 2', hex: poll(2, 1) }, { label: 'from 2', hex: ack(2, 1) }, { label: 'to 3', hex: poll(3, 3) }, { label: 'from 3', hex: ack(3, 3) }], evidence: { prompt: 'Click the two bytes that show the commands go to different readers.', pick: [[0, 1], [2, 1]] } }),
  C('s3-03', 3, ['sequence', 'capture'], 'explain', 'Address 2 exists on two independent ports. Should their sequence histories be combined?', ['Yes — same address', 'No — port/bus identity must distinguish them'], 1, 'State is per port + address; the same address on another bus is another device.'),
  C('s3-04', 3, ['sequence'], 'investigate', 'The same sequence appears twice, but the command bytes differ. Is this a clean retransmission?', ['Yes', 'No — flag the changed request for investigation'], 1, 'A retransmission repeats the request unchanged; changed bytes under the same SQN are a different request.',
    { frames: [{ label: 'LED #1', hex: ledA }, { label: 'LED #2', hex: ledB }], evidence: { prompt: 'Click the payload byte(s) that differ between the two commands.', pick: diffAt(ledA, ledB).map((o) => [1, o]) } }),
  C('s3-05', 3, ['pairing', 'addr-byte'], 'investigate', 'A POLL to address 4 receives an ACK from address 5. What is the observed mismatch?', ['None', 'The reply address differs from the command address', 'The sequence is wrong'], 1, 'Command ADDR 04, reply ADDR 85 → reply from 5.',
    { frames: [{ label: 'command', hex: poll(4, 1) }, { label: 'reply', hex: ack(5, 1) }], evidence: { prompt: 'Click the two bytes that show the mismatch.', pick: [[0, 1], [1, 1]] } }),
  C('s3-06', 3, ['pairing', 'evidence-limits'], 'explain', 'Does that mismatched address prove two devices share an address?', ['Yes', 'No — several explanations, including capture problems, remain possible'], 1, 'An address conflict is one hypothesis; misconfiguration, a faulty device or a capture artefact are others.'),
  C('s3-07', 3, ['pairing'], 'explain', 'An OUT command receives OSTATR. Should this automatically be rejected as an unexpected reply?', ['Yes', 'No — the expected-reply rules permit it'], 1, 'OUT → ACK or OSTATR.',
    { frames: [{ label: 'OUT', hex: F({ address: 2, sequence: 1, command: 0x68, payload: [1, 5, 0x32, 0] }) }, { label: 'reply', hex: F({ address: 2, reply: true, sequence: 1, command: 0x4a, payload: [0, 1] }) }], evidence: { prompt: 'Click the reply code byte.', pick: [[1, 5]] } }),
  C('s3-08', 3, ['pairing'], 'investigate', 'A COMSET request receives COM. What should support inspect next?', ['Nothing — COM means success', 'The reported configuration and subsequent communication at the intended address/baud', 'The CRC of the COMSET'], 1, 'COM reports the settings the reader will use; prove them by talking to it there.',
    { frames: [{ label: 'COMSET', hex: F({ address: 2, sequence: 1, command: 0x6e, payload: [3, 0x80, 0x25, 0, 0] }) }, { label: 'COM', hex: F({ address: 2, reply: true, sequence: 1, command: 0x54, payload: [3, 0x80, 0x25, 0, 0] }) }], evidence: { prompt: 'Click the COM bytes that report the new address and baud (5 bytes).', pick: [[1, 6], [1, 7], [1, 8], [1, 9], [1, 10]] } }),
  C('s3-09', 3, ['pairing'], 'investigate', 'A RAW reply is followed by LED and BUZ commands. Reconstruct the sequence of actions.', ['The controller granted access', 'A credential was reported, then the controller requested visual and audible indications', 'The reader opened the door'], 1, 'RAW = credential data reported; LED/BUZ = controller asked for feedback.',
    { frames: [{ label: 'POLL', hex: poll(2, 1) }, { label: 'RAW', hex: F({ address: 2, reply: true, sequence: 1, command: 0x50, payload: [0, 1, 26, 0, 0x12, 0x34, 0x56, 0x40] }) }, { label: 'LED', hex: F({ address: 2, sequence: 2, command: 0x69, payload: [0, 0, 2, 2, 2, 2, 0, 20, 0, 1, 1, 0, 1, 1] }) }, { label: 'ACK', hex: ack(2, 2) }, { label: 'BUZ', hex: F({ address: 2, sequence: 3, command: 0x6a, payload: [0, 2, 2, 2, 1] }) }, { label: 'ACK', hex: ack(2, 3) }],
      evidence: { prompt: 'Click the three code bytes that tell the story (credential, visual, audible).', pick: [[1, 5], [2, 5], [4, 5]] } }),
  C('s3-10', 3, ['evidence-limits'], 'explain', 'Does that sequence alone establish the reason for the access decision?', ['Yes', 'No — correlate it with controller/application events'], 1, 'The bus shows indications, not the controller’s reasoning.'),
  C('s3-11', 3, ['pairing', 'capture'], 'investigate', 'One command is followed by two replies. What should the coach highlight?', ['Nothing', 'An apparent extra reply, with capture duplication and other explanations still considered', 'Proof of an address conflict'], 1, 'One command, one reply — but a duplicated capture record looks the same.',
    { frames: [{ label: 'POLL', hex: poll(2, 1) }, { label: 'reply', hex: ack(2, 1) }, { label: 'reply', hex: ack(2, 1) }] }),
  C('s3-12', 3, ['pairing', 'capture', 'timing'], 'investigate', 'A capture ends immediately after a command. Should the final transaction be graded as a timeout?', ['Yes', 'No — mark it pending / capture-ended unless there is enough timing evidence'], 1, 'Absence of a reply in a capture that stops is not evidence of a missing reply.',
    { frames: [{ label: 'POLL', hex: poll(2, 1) }, { label: 'ACK', hex: ack(2, 1) }, { label: 'POLL (last)', hex: poll(2, 2) }] }),
  C('s3-13', 3, ['pairing'], 'investigate', 'After COMSET, the device stops replying at its old address. What is the next check?', ['Replace the reader', 'Look for communication at the newly configured address and baud', 'Resend COMSET'], 1, 'Silence at the old settings is expected after a successful change.'),
  C('s3-14', 3, ['file-transfer', 'timing'], 'investigate', 'FTSTAT requests a 500 ms delay. The next fragment starts after 100 ms. What is wrong?', ['Nothing', 'The requested delay was not honoured — if the timestamps accurately represent the relevant boundaries', 'The reader is too slow'], 1, 'FtDelay asks the controller to wait; check the timestamp semantics before concluding.'),
  V('s3-15', 3, ['file-transfer', 'endianness'], 'calculate', 'Decode the signed FTSTAT status bytes FD FF.', [decA(-3)], 'Little-endian 0xFFFD; as a signed 16-bit value that is −3.',
    { frames: [{ label: 'FTSTAT', hex: ftstat(2, 1, -3) }], evidence: { prompt: 'Click the two status bytes.', pick: [[0, 9], [0, 10]] }, gen: 'signed16' }),
  V('s3-16', 3, ['file-transfer', 'endianness'], 'calculate', 'Decode the signed FTSTAT status bytes FF FF.', [decA(-1)], '0xFFFF as signed 16-bit = −1.', { gen: 'signed16' }),
  V('s3-17', 3, ['file-transfer'], 'calculate', 'A file fragment starts at offset 64 and contains 32 bytes. Where would the next contiguous fragment begin?', [decA(96)], '64 + 32 = 96.',
    { frames: [{ label: 'FILETRANSFER', hex: ftReq(2, 1, 256, 64, 32) }], evidence: { prompt: 'Click the offset bytes (4) and the fragment-size bytes (2).', pick: [[0, 11], [0, 12], [0, 13], [0, 14], [0, 15], [0, 16]] }, gen: 'fragmentNext' }),
  C('s3-18', 3, ['file-transfer'], 'investigate', 'A file claims 100 total bytes; a fragment begins at 90 and carries 20. What fails validation?', ['Nothing', 'The fragment extends beyond the declared file size', 'The offset must be even'], 1, '90 + 20 = 110 > 100.', { gen: 'fragmentOverflow' }),
  C('s3-19', 3, ['file-transfer'], 'explain', 'FTSTAT reports that the device is rebooting. What communication change should the controller expect?', ['None', 'A communication/session reset and re-establishment as applicable', 'A faster baud rate'], 1, 'Status 2: expect SQN 0 and, if used, a new Secure Channel handshake.'),
  C('s3-20', 3, ['pairing', 'evidence-limits'], 'investigate', 'A reader reports no text-display capability, then rejects TEXT. What evidence supports the diagnosis?', ['Only the NAK', 'The capability report and the rejected TEXT transaction agree', 'The reader model name'], 1, 'Two independent observations that point the same way.'),
];

// ── Section 4: Security and timing ─────────────────────────────────────────
const s4 = [
  C('s4-01', 4, ['secure'], 'recognize', 'In an SCS_17 frame, what is visible and what is opaque?', ['Everything is encrypted', 'Header, SCB, command, length and trailers are identifiable; the application data is ciphertext', 'Only the CRC is visible'], 1, 'Encryption covers DATA; the envelope stays readable.'),
  C('s4-02', 4, ['secure', 'evidence-limits'], 'explain', 'A MAC is present. Has the Academy necessarily verified it?', ['Yes', 'No — presence and verification are separate'], 1, 'Verification needs the session keys; the Academy shows MACs but cannot check them.'),
  C('s4-03', 4, ['secure', 'framing'], 'explain', 'Can an observer alter a plaintext frame and recalculate its CRC?', ['No', 'Yes — CRC does not provide cryptographic authentication'], 1, 'Anyone can compute a CRC.'),
  C('s4-04', 4, ['secure', 'capture'], 'explain', 'A capture begins halfway through an established secure session. Must the coach declare the handshake invalid?', ['Yes', 'No — the establishment exchange may be outside the capture window'], 1, 'Missing evidence is not negative evidence.'),
  C('s4-05', 4, ['secure', 'capture'], 'investigate', 'A capture contains only SCRYPT and RMAC_I. Does that prove all four handshake steps were captured?', ['Yes', 'No'], 1, 'Only steps 3 and 4 are present; steps 1–2 are outside the capture.'),
  C('s4-06', 4, ['secure'], 'investigate', 'RMAC_I has an unsupported acceptance-status value. Should the coach display “Secure Channel up”?', ['Yes', 'No — report the unsupported value and withhold that conclusion'], 1, 'Only 0x01 means accepted.'),
  C('s4-07', 4, ['secure', 'evidence-limits'], 'explain', 'A reader rejects a cryptogram. Does this prove the configured base keys differ?', ['Yes', 'No — key mismatch is a hypothesis; session/context or implementation problems can also cause rejection'], 1, 'State the observation, then list causes.'),
  C('s4-08', 4, ['keys'], 'explain', 'Why should a device’s unique SCBK differ from a session key?', ['They are the same thing', 'They serve different roles: the base key supports establishment; session keys protect one session', 'Session keys are longer'], 1, 'Session keys are derived per session from the base key and the exchanged randoms.'),
  C('s4-09', 4, ['keys'], 'explain', 'What is the concern when normal operation still uses the default installation key?', ['None', 'Protection relies on a known default rather than a device-specific secret', 'It is slower'], 1, 'SCBK-D is public; it is for installation only.'),
  C('s4-10', 4, ['keys', 'support'], 'explain', 'A capture contains plaintext KEYSET material. What should happen before sharing it?', ['Nothing', 'Redact the secret and follow the organisation’s key-handling process', 'Zip it'], 1, 'Treat the capture as containing a credential.'),
  V('s4-11', 4, ['timing'], 'calculate', 'A 20-byte frame at 9600 baud, 8N1. Approximately how long is its transmission, in ms?', [{ t: 'num', v: 20.83, tol: 0.06 }], '8N1 = 10 bits per byte: 20 × 10 ÷ 9600 s = 20.83 ms.', { gen: 'frameTime' }),
  V('s4-12', 4, ['timing'], 'calculate', 'How long does that frame take at 19200 baud, 8N1 (ms)?', [{ t: 'num', v: 10.42, tol: 0.06 }], 'Twice the baud, half the time: ≈ 10.42 ms.', { gen: 'frameTime' }),
  C('s4-13', 4, ['timing', 'capture'], 'explain', 'Two complete-frame timestamps differ by 210 ms. Does that alone prove a 210 ms reply-start delay?', ['Yes', 'No — timestamp placement, frame duration and buffering affect the result'], 1, 'Know what each timestamp marks before subtracting.'),
  C('s4-14', 4, ['timing'], 'recognize', 'Which boundaries are needed to measure reply turnaround accurately?', ['Start of command to start of reply', 'End of the command’s last byte to start of the reply’s first byte', 'End of reply to next command'], 1, 'That gap is what REPLY_DELAY limits.'),
  C('s4-15', 4, ['timing', 'capture'], 'explain', 'What must be recorded before grading a capture against a timing limit?', ['Nothing', 'Baud, framing, timestamp semantics, acquisition point and relevant buffering uncertainty', 'Only the baud'], 1, 'Without these, a timing grade is a guess.'),
  C('s4-16', 4, ['timing', 'capture'], 'explain', 'USB buffering releases several packets together. What might happen to apparent timing?', ['Nothing', 'Packets may appear clustered or delayed relative to wire timing', 'They are dropped'], 1, 'The host timestamps arrival, not wire time.'),
  C('s4-17', 4, ['capture'], 'explain', 'What is the operational risk of a training “tap” sending its own polls on a live controller bus?', ['None', 'Competing transmissions and conflicting sequence/session state', 'Higher baud'], 1, 'Two controllers on one bus collide and confuse readers.'),
  C('s4-18', 4, ['secure'], 'explain', 'The reader restarts during a secure session. Can the controller assume the previous session remains usable?', ['Yes', 'No — it must re-establish the required state'], 1, 'A restart clears session keys.'),
  C('s4-19', 4, ['capture', 'layers'], 'explain', 'The browser disconnects while the controller remains connected to the reader. Is that necessarily an OSDP outage?', ['Yes', 'No — the viewer connection and the device bus are separate'], 1, 'Losing the view is not losing the bus.'),
  C('s4-20', 4, ['secure', 'evidence-limits'], 'explain', 'Why should session establishment and MAC verification have separate status indicators?', ['They needn’t', 'Observing an exchange does not mean the viewer verified the cryptographic protection'], 1, 'Two different claims need two different indicators.'),
];

// ── Section 5: Vendor and support (FLEX8-OUT4 = fictional training contract) ─
const FLEX8_EVENT = '53 82 17 00 05 90 AE 7E 00 92 01 00 00 02 03 02 03 E8 03 00 00 26 CF';
const FLEX8_STATUS = '53 82 2E 00 05 90 AE 7E 00 12 03 00 01 00 0F F0 00 01 02 03 00 00 00 00 0F 00 00 00 00 04 00 01 00 02 03 0F 00 00 01 00 00 00 00 00 E2 2D';
export const FLEX8_FRAMES = { event: FLEX8_EVENT, status: FLEX8_STATUS };
const s5 = [
  C('s5-01', 5, ['vendor', 'pairing'], 'recognize', 'Code 80 appears in a controller command and in a peripheral reply. Must both mean MFG?', ['Yes', 'No — command 80 is MFG; reply 80 is PIVDATAR'], 1, 'The ADDR reply bit decides which table applies (Annex A direction collisions at 76 and 80).'),
  C('s5-02', 5, ['vendor'], 'recognize', 'In the training MFG request, what occupies DATA offsets 0–3?', ['Four vendor bytes', 'Three vendor-identifier bytes followed by the vendor subcommand', 'Length and CRC'], 1, 'OUI (3) then Command_ID.'),
  C('s5-03', 5, ['vendor', 'byte-count'], 'investigate', 'A schema field starts at DATA +4. Is that necessarily full-frame offset 4?', ['Yes', 'No — payload-relative and frame-relative offsets differ'], 1, 'DATA starts after the code (offset 6 without an SCB).'),
  V('s5-04', 5, ['vendor', 'endianness'], 'calculate', 'A vendor field is two bytes, little-endian: E8 03. Decode it.', [decA(1000)], '0x03E8 = 1000; apply units only if the schema defines them.', { gen: 'leDecode' }),
  C('s5-05', 5, ['vendor'], 'explain', 'The vendor identifier matches, but the firmware is outside the schema’s scope. What should the decoder do?', ['Decode anyway', 'Withhold the scoped interpretation and preserve the bytes', 'Discard the frame'], 1, 'Scope is part of the contract.'),
  C('s5-06', 5, ['vendor'], 'explain', 'Two schema fields overlap without a documented union/alias. What should validation report?', ['Nothing', 'An ambiguous or invalid layout', 'Use the first field'], 1, 'Overlaps must be declared on purpose.'),
  C('s5-07', 5, ['vendor'], 'explain', 'A reserved vendor bit is set. Should the decoder silently clear it?', ['Yes', 'No — preserve and flag it'], 1, 'Never hide bytes the device actually sent.'),
  C('s5-08', 5, ['vendor'], 'explain', 'Why does a useful vendor schema need enums and bit masks in addition to offsets?', ['It doesn’t', 'Offsets locate values; enums and masks explain their meaning'], 1, 'Location without meaning is just a hex dump.'),
  C('s5-09', 5, ['vendor', 'evidence-limits'], 'explain', 'An MFG request receives ACK. Has a configuration change necessarily survived reboot?', ['Yes', 'No — persistence requires separate documented behaviour and verification'], 1, 'ACK = accepted on the wire, nothing more.'),
  V('s5-10', 5, ['io-states'], 'recognize', 'In the FLEX8-OUT4 training contract, an input is Normal. What encoded value (hex) represents it?', [hexA('00')], 'Four-state model: 00 Normal, 01 Active, 02 Trouble, 03 Shorted.'),
  C('s5-11', 5, ['io-states'], 'recognize', 'What do 01, 02 and 03 represent in that same contract?', ['Active, Trouble, Shorted', 'Open, Closed, Fault', 'Low, Medium, High'], 0, 'One uint8 per input — not a one-bit mask.'),
  C('s5-12', 5, ['io-states'], 'explain', 'Can an unsupervised contact always distinguish Active from Shorted?', ['Yes', 'No — hardware and supervision topology determine that ability'], 1, 'Without EOL supervision a closure and a short look alike.'),
  C('s5-13', 5, ['io-states', 'vendor'], 'investigate', 'Flex5 is configured as an output. Its input-state byte is 00, with input validity clear. What should appear?', ['Normal', 'Not applicable / invalid input measurement — not Normal', 'Trouble'], 1, 'Validity 0 means the byte is ignored.',
    { frames: [{ label: 'status reply (fictional)', hex: FLEX8_STATUS }], evidence: { prompt: 'Click Flex5’s state byte (DATA+14) and the validity mask byte (DATA+8).', pick: [[0, 20], [0, 14]] } }),
  C('s5-14', 5, ['io-states'], 'investigate', 'Flex3 changes from Trouble to Shorted. Is a Boolean “fault active” enough to preserve the transition?', ['Yes', 'No — both are faults, but their classifications differ'], 1, 'Collapsing to a boolean loses the transition.',
    { frames: [{ label: 'transition event (fictional)', hex: FLEX8_EVENT }], evidence: { prompt: 'Click the current-state and previous-state bytes (DATA+8, DATA+9).', pick: [[0, 14], [0, 15]] } }),
  C('s5-15', 5, ['io-states'], 'explain', 'Does inverting an input justify changing Shorted into Normal?', ['Yes', 'No — fault classification stays distinct from contact polarity'], 1, 'Invert flips Normal↔Active only.'),
  C('s5-16', 5, ['io-states'], 'explain', 'The master requests OUT1 Active, but FAI forces its effective state Inactive. Which values should status expose?', ['Only the effective state', 'Both requested and effective output states, plus the applicable override', 'Only the request'], 1, 'Requested ≠ effective whenever an override exists.'),
  C('s5-17', 5, ['io-states'], 'explain', 'A physical tamper returns to Normal while its alarm remains latched. Is the status contradictory?', ['Yes', 'No — present circuit state and latched alarm state are separate'], 1, 'The latch records history until cleared.'),
  C('s5-18', 5, ['io-states'], 'explain', 'A circuit fault occurs on the FAI input. Must it universally behave like an asserted fire contact?', ['Yes', 'No — follow the explicitly defined hardware/product policy'], 1, 'Fault handling is a documented policy decision.'),
  C('s5-19', 5, ['support', 'evidence-limits'], 'explain', 'A credential works after disabling and re-enabling it. Does the trace alone prove the original fault was in the reader?', ['Yes', 'No — investigate controller synchronisation and application evidence as well'], 1, 'The re-enable changed controller state too.'),
  C('s5-20', 5, ['support'], 'recognize', 'What must accompany an escalated decoder discrepancy?', ['A screenshot', 'Original frame bytes, direction, port/address, model/firmware, capture context, expected interpretation and its source', 'The decoder version'], 1, 'Someone else must be able to reproduce it.'),
];

// ── evidence drills (reading real bytes) ───────────────────────────────────
const e2 = [
  C('e2-01', 2, ['addr-byte'], 'investigate', 'This frame is a reply. Which byte tells you?', ['SOM', 'ADDR (bit 7 set)', 'CTRL'], 1, 'ADDR bit 7 = reply.',
    { frames: [{ label: 'frame', hex: ack(3, 2) }], evidence: { prompt: 'Click that byte.', pick: [[0, 1]] }, gen: 'evidenceField' }),
  C('e2-02', 2, ['length'], 'investigate', 'Where is the length of this frame?', ['Offsets 2–3', 'Offset 5', 'The last two bytes'], 0, 'LEN low at 2, high at 3.',
    { frames: [{ label: 'frame', hex: F({ address: 2, sequence: 1, command: 0x6a, payload: [0, 2, 2, 2, 1] }) }], evidence: { prompt: 'Click both LEN bytes.', pick: [[0, 2], [0, 3]] }, gen: 'evidenceField' }),
  C('e2-03', 2, ['scb-offsets'], 'investigate', 'This frame has a security block. Where is the command code?', ['Offset 5', 'Right after the security block', 'Offset 4'], 1, 'Read the SCB length at offset 5, then skip it.',
    { frames: [{ label: 'frame', hex: F({ address: 2, sequence: 1, command: 0x76, scb: [3, 0x11, 1], payload: [1, 2, 3, 4, 5, 6, 7, 8] }) }], evidence: { prompt: 'Click the command code byte.', pick: [[0, 8]] }, gen: 'evidenceField' }),
];

export const questions = [...original, ...s1, ...s2, ...s3, ...s4, ...s5, ...e2];
export const byId = new Map(questions.map((q) => [q.id, q]));
export const key = (q) => `${q.id}@${q.v}`;

// ── grading ────────────────────────────────────────────────────────────────
const clean = (s) => String(s ?? '').trim();
export function normHex(s) {
  const t = clean(s).replace(/^0x/i, '').replace(/h$/i, '').replace(/[\s_]/g, '').toUpperCase();
  return /^[0-9A-F]+$/.test(t) ? t.replace(/^0+(?=.)/, '').padStart(2, '0') : null;
}
export function normBytes(s) {
  const parts = clean(s).replace(/0x/gi, '').split(/[\s,;:-]+/).filter(Boolean);
  if (parts.length === 1 && parts[0].length > 2 && parts[0].length % 2 === 0) return parts[0].match(/../g).map((x) => x.toUpperCase());
  if (!parts.every((p) => /^[0-9a-f]{1,2}$/i.test(p))) return null;
  return parts.map((p) => p.toUpperCase().padStart(2, '0'));
}
function matchOne(a, input) {
  const s = clean(input);
  if (!s) return false;
  switch (a.t) {
    case 'hex': { const n = normHex(s); return n != null && n === normHex(a.v); }
    case 'dec': { const t = s.replace(/[\s,]/g, '').replace(/^\+/, '').replace(/^−/, '-'); return /^-?\d+$/.test(t) && Number(t) === a.v; }
    case 'bin': { const t = s.replace(/[\s_]/g, '').replace(/^0b/i, ''); return /^[01]+$/.test(t) && t.padStart(8, '0') === a.v && t.length === 8; }
    case 'bytes': { const b = normBytes(s); return !!b && b.join(' ') === a.v.toUpperCase(); }
    case 'num': { const t = Number(s.replace(/\s*ms$/i, '').replace(/^≈\s*/, '').replace(',', '.')); return Number.isFinite(t) && Math.abs(t - a.v) <= (a.tol ?? 0); }
    case 'text': return s.toLowerCase() === String(a.v).toLowerCase();
    default: return false;
  }
}

/** Grade a frame-construction answer field by field. */
export function gradeFrame(expectHex, input) {
  const want = expectHex.split(' ');
  const got = normBytes(input) || [];
  const names = (n) => (n === 0 ? 'SOM' : n === 1 ? 'ADDR' : n <= 3 ? 'LEN' : n === 4 ? 'CTRL' : n === 5 ? 'CMD' : n >= want.length - 2 ? 'CRC' : 'DATA');
  const groups = [];
  want.forEach((w, i) => {
    const g = names(i);
    let last = groups[groups.length - 1];
    if (!last || last.name !== g) groups.push(last = { name: g, want: [], got: [] });
    last.want.push(w); last.got.push(got[i] ?? '··');
  });
  for (const g of groups) g.ok = g.want.join(' ') === g.got.join(' ');
  return { ok: got.length === want.length && groups.every((g) => g.ok), groups, extra: Math.max(0, got.length - want.length) };
}

/** grade(question, answer) → { ok, detail? }. answer: index for choice, string otherwise. */
export function grade(q, answer) {
  if (q.kind === 'choice') return { ok: answer === q.answer };
  if (q.kind === 'value') return { ok: q.accept.some((a) => matchOne(a, answer)) };
  if (q.kind === 'frame') { const r = gradeFrame(q.expect, answer); return { ok: r.ok, detail: r }; }
  return { ok: false };
}

/** Evidence: exact set of [frame, offset] pairs. */
export function gradeEvidence(q, picks) {
  const want = new Set((q.evidence?.pick || []).map(([f, o]) => `${f}:${o}`));
  const got = new Set(picks.map(([f, o]) => `${f}:${o}`));
  const missing = [...want].filter((x) => !got.has(x)), extra = [...got].filter((x) => !want.has(x));
  return { ok: !missing.length && !extra.length, missing, extra };
}

export const expectedText = (q) => q.kind === 'choice' ? q.options[q.answer]
  : q.kind === 'value' ? q.accept.map((a) => (a.t === 'hex' ? `0x${normHex(a.v)}` : a.t === 'num' ? `≈ ${a.v}` : String(a.v))).join(' or ')
  : q.kind === 'frame' ? q.expect : '';
