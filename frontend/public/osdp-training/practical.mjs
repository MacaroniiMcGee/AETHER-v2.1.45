// AETHER OSDP Academy — mixed final practical.
// One simulated capture combining discovery, credential data, outputs, a damaged
// frame, a vendor event (FLEX8-OUT4 fictional contract) and a partially captured
// Secure Channel exchange. Simulated: constructed behaviour, not observed hardware.

import { build, hex } from './protocol.mjs?v=198dc99a';

const A = 3;
const F = (o) => hex(build({ address: A, ...o }));
const bad = (o) => { const b = build({ address: A, ...o }); b[b.length - 1] ^= 0x5a; return hex(b); };
const R16 = (s) => Array.from({ length: 16 }, (_, i) => (i * 37 + s) & 255);

const frames = [
  { label: 'command', hex: F({ sequence: 1, command: 0x61, payload: [0] }) },
  { label: 'reply', hex: F({ reply: true, sequence: 1, command: 0x45, payload: [0xae, 0x7e, 0x00, 7, 1, 0x39, 0x30, 0, 0, 2, 4, 17] }) },
  { label: 'command', hex: F({ sequence: 2, command: 0x62, payload: [0] }) },
  { label: 'reply', hex: F({ reply: true, sequence: 2, command: 0x46, payload: [1, 1, 2, 4, 4, 1, 9, 1, 1, 10, 0x80, 0x00] }) },
  { label: 'command', hex: F({ sequence: 3, command: 0x60 }) },
  { label: 'reply', hex: F({ reply: true, sequence: 3, command: 0x50, payload: [0, 1, 26, 0, 0x12, 0x34, 0x56, 0x40] }) },
  { label: 'command', hex: F({ sequence: 1, command: 0x69, payload: [0, 0, 2, 2, 2, 2, 0, 20, 0, 1, 1, 0, 1, 1] }) },
  { label: 'reply', hex: F({ reply: true, sequence: 1, command: 0x40 }) },
  { label: 'command', hex: F({ sequence: 2, command: 0x68, payload: [1, 5, 0x32, 0x00] }) },
  { label: 'reply', hex: F({ reply: true, sequence: 2, command: 0x4a, payload: [0, 1] }) },
  { label: 'command', hex: bad({ sequence: 3, command: 0x60 }) },
  { label: 'reply', hex: F({ reply: true, sequence: 3, command: 0x41, payload: [0x01] }) },
  { label: 'command', hex: F({ sequence: 3, command: 0x60 }) },
  { label: 'reply', hex: F({ reply: true, sequence: 3, command: 0x90, payload: [0xae, 0x7e, 0x00, 0x92, 1, 0, 0, 2, 3, 2, 3, 0xe8, 3, 0, 0] }) },
  { label: 'command', hex: F({ sequence: 1, command: 0x77, scb: [3, 0x13, 1], payload: R16(5) }) },
  { label: 'reply', hex: F({ reply: true, sequence: 1, command: 0x78, scb: [3, 0x14, 1], payload: R16(9) }) },
];

const T = (id, skills, stage, q, rest) => ({ id, v: 1, level: 5, skills, stage, practical: true, q, ...rest });
const tasks = [
  T('p-01', ['addr-byte'], 'recognize', 'Which reader address is under test (decimal)?', { kind: 'value', accept: [{ t: 'dec', v: 3 }], why: 'Commands carry ADDR 03; replies carry 83 (bit 7 set).' }),
  T('p-02', ['vendor', 'byte-count'], 'investigate', 'Frame 2 (PDID) starts its DATA with the vendor identifier. Which three bytes is it?', { kind: 'value', accept: [{ t: 'bytes', v: 'AE 7E 00' }], why: 'PDID DATA: vendor code (3 bytes), model, version, serial (4), firmware (3). AE 7E 00 is the Academy’s fictional identifier.' }),
  T('p-03', ['byte-count', 'endianness'], 'calculate', 'How many credential bits does the RAW reply (frame 6) report?', { kind: 'value', accept: [{ t: 'dec', v: 26 }], why: 'RAW: reader 00, format 01, bit count 1A 00 = 26 (little-endian), then the bits.' }),
  T('p-04', ['evidence-limits', 'pairing'], 'explain', 'What does the sequence RAW → LED → OUT establish?', { kind: 'choice', options: ['Access was granted', 'A credential was reported, then the controller requested an indication and drove an output', 'The door opened'], answer: 1, why: 'The bus shows reports and requests, not the access decision or the door’s physical state.' }),
  T('p-05', ['endianness', 'pairing'], 'calculate', 'Frame 9 is OUT 01 05 32 00 (output number 01, control code 05). For how many seconds is that output turned on?', { kind: 'value', accept: [{ t: 'num', v: 5, tol: 0.001 }], why: 'Timer 32 00 = 50 (little-endian) in 100 ms units = 5 s.' }),
  T('p-06', ['framing', 'pairing'], 'investigate', 'One POLL was answered with NAK. What error code (hex) did the reader send?', { kind: 'value', accept: [{ t: 'hex', v: '01' }], why: 'NAK 0x01 = message check character(s) error — frame 11’s CRC does not match its bytes.' }),
  T('p-07', ['sequence', 'pairing'], 'explain', 'After that NAK, what did the controller correctly do?', { kind: 'choice', options: ['Resent the same command with the same SQN', 'Restarted with SQN 0', 'Moved on with SQN 1'], answer: 0, why: 'Frame 13 repeats POLL with SQN 3 — a valid retransmission of an identical request.' }),
  T('p-08', ['io-states', 'vendor'], 'investigate', 'Frame 14 is a FLEX8-OUT4 (fictional) transition event. What did the input do?', { kind: 'choice', options: ['Flex3: Trouble → Shorted', 'Flex2: Normal → Active', 'Flex3: Shorted → Trouble'], answer: 0, why: 'Source type 00 (Flex), index 02 (Flex3), current 03 Shorted, previous 02 Trouble, validity 03 (both valid).' }),
  T('p-09', ['secure', 'evidence-limits'], 'explain', 'What can you conclude from the SCRYPT → RMAC_I (status 01) pair at the end?', { kind: 'choice', options: ['A session was established and its MACs were verified', 'The reader accepted the controller’s cryptogram; CHLNG/CCRYPT are outside this capture and no MAC was verified', 'The keys differ'], answer: 1, why: 'Status 01 = accepted. Earlier steps are not in the capture, and observing an exchange is not verifying it.' }),
  T('p-10', ['support'], 'explain', 'You escalate the vendor event to the panel’s maker. What must go with it?', { kind: 'choice', options: ['A screenshot of the Academy', 'The original frame bytes, direction, port/address, model/firmware, capture context, your interpretation and its source document', 'Only the decoded state names'], answer: 1, why: 'Enough for someone else to reproduce your reading.' }),
];

export const practical = {
  title: 'Final practical — reader 3 on a lab bus',
  brief: 'A controller identifies reader 3, reads its capabilities, handles a card read, drives an LED and an output, recovers from a damaged frame, receives a vendor I/O event and finishes a Secure Channel exchange. Work out what the evidence establishes — and what it does not.',
  frames, tasks,
};
