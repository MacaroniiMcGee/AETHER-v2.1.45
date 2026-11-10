// AETHER OSDP Academy — simulated traffic and troubleshooting scenarios.
// Every frame here is generated; none of it is a hardware capture. Vendor
// bytes AE 7E 00 are a locally administered value (bit 1 of the first octet
// set), so they can never be a real company's OUI.

import { build, hex } from './protocol.mjs?v=198dc99a';

const BASE = Date.UTC(2026, 9, 14, 12, 0, 0);
const SIM_OUI = [0xae, 0x7e, 0x00];
function track(port = 'SIMULATED') {
  let t = BASE; const out = [];
  const f = (o, gap = 0, extra = {}) => { t += gap; out.push({ fullHex: hex(Array.isArray(o) ? o : build(o)), ts: t, port, origin: 'simulation', ...extra }); return f; };
  f.frames = out;
  return f;
}
const C = (address, command, payload = [], sequence = 1, extra = {}) => ({ address, command, payload, sequence, ...extra });
const R = (address, command, payload = [], sequence = 1, extra = {}) => ({ address, command, payload, sequence, reply: true, ...extra });
const LED_GREEN_THEN_RED = [0, 0, 2, 5, 5, 2, 0, 0x14, 0, 1, 1, 1, 1, 1];
const LED_RED_FLASH = [0, 0, 2, 2, 2, 1, 0, 0x0a, 0, 0, 0, 0, 0, 0];

/** The starter session: discovery, idle polling, a keypad entry, LED/BUZ, a vendor exchange, a NAK, a card read and one protected frame. */
export function simulatedSession() {
  const f = track();
  f(C(2, 0x61, [0], 1))(R(2, 0x45, [...SIM_OUI, 1, 2, 0x39, 0x30, 0, 0, 5, 4, 10], 1), 2)
   (C(2, 0x62, [0], 2), 40)(R(2, 0x46, [1, 1, 4, 2, 4, 2, 4, 5, 1, 5, 2, 0, 8, 1, 0, 9, 1, 1, 10, 0, 2, 13, 0, 1, 16, 4, 0], 2), 3)
   (C(2, 0x60, [], 3), 40)(R(2, 0x40, [], 3), 2)
   (C(2, 0x60, [], 1), 200)(R(2, 0x53, [0, 4, 0x31, 0x32, 0x33, 0x0d], 1), 2)
   (C(2, 0x69, LED_GREEN_THEN_RED, 2), 30)(R(2, 0x40, [], 2), 2)
   (C(2, 0x6a, [0, 2, 2, 2, 3], 3), 30)(R(2, 0x40, [], 3), 2)
   (C(2, 0x80, [...SIM_OUI, 1, 1], 1), 40)(R(2, 0x90, [...SIM_OUI, 1, 0], 1), 3)
   (C(2, 0x6b, [0, 1, 0, 1, 1, 5, 0x48, 0x45, 0x4c, 0x4c, 0x4f], 2), 40)(R(2, 0x41, [3], 2), 2)
   (C(2, 0x60, [], 3), 200)(R(2, 0x50, [0, 1, 26, 0, 0x81, 0x23, 0x45, 0x40], 3), 2)
   (C(2, 0x69, LED_RED_FLASH, 1), 30)(R(2, 0x40, [], 1), 2)
   (C(2, 0x69, [], 2, { scb: [2, 0x17], payload: Array(16).fill(0xaa), mac: [0x12, 0x34, 0x56, 0x78] }), 40, { note: 'Structurally valid SCS_17 envelope with made-up ciphertext and MAC.' })
   (R(2, 0x40, [], 2, { scb: [2, 0x16], mac: [0x9a, 0xbc, 0xde, 0xf0] }), 2);
  return f.frames;
}

/**
 * Troubleshooting scenarios. Each: { id, title, symptom, ask, frames(), observe, causes, next }.
 * The coach (analyzer.mjs) runs on the frames; the learner writes their own reasoning first.
 */
export const scenarios = [
  { id: 'dead', title: 'Reader not answering', symptom: 'Panel shows reader 3 off-line after a ceiling job.',
    ask: 'What does the controller do, and what does the reader do?',
    frames() { const f = track('/dev/ttyUSB0'); f(C(3, 0x60, [], 1))(C(3, 0x60, [], 1), 210)(C(3, 0x60, [], 1), 210)(C(3, 0x60, [], 1), 210)(C(3, 0x60, [], 1), 210)(C(3, 0x60, [], 0), 400)(C(3, 0x61, [0], 0), 210); return f.frames; },
    observe: 'Only commands. The controller retries the same POLL with SQN 1, then restarts with SQN 0 and asks for ID. Nothing answers at address 3.',
    causes: ['Reader unpowered or still booting', 'Address changed (DIP switch, COMSET, factory reset)', 'Baud mismatch', 'A/B swapped or open circuit after the ceiling work', 'Capture point only hears the controller side'],
    next: ['Measure reader power at the reader', 'Check the reader’s address and baud against the panel', 'With only this reader connected, try ID to 0x7F', 'Check A/B polarity and continuity'] },
  { id: 'noise', title: 'Noisy line', symptom: 'Intermittent “reader off-line” events on a long run.',
    ask: 'Which frames are damaged, and who noticed?',
    frames() {
      const f = track('/dev/ttyUSB0'); f(C(1, 0x60, [], 1))(R(1, 0x40, [], 1), 3);
      const bad = build(C(1, 0x60, [], 2)); bad[6] ^= 0x10; f(bad, 40)(R(1, 0x41, [1], 2), 3)(C(1, 0x60, [], 2), 40)(R(1, 0x40, [], 2), 3);
      const badR = build(R(1, 0x40, [], 3)); badR[5] ^= 0x01; f(C(1, 0x60, [], 3), 40)(badR, 3)(C(1, 0x60, [], 3), 40)(R(1, 0x40, [], 3), 3);
      return f.frames;
    },
    observe: 'One command and one reply fail their CRC. The reader answered the bad command with NAK 0x01 and the controller correctly resent it with the same SQN; the controller resent after the bad reply too.',
    causes: ['Missing or extra termination (120 Ω at both ends only)', 'No common ground / reference between devices', 'Cable not twisted pair, or shared with power', 'Stub or star wiring', 'Baud rate slightly off on one device'],
    next: ['Check termination and bias at each end', 'Confirm twisted, shielded cable and a shared reference', 'Compare error rate at a lower baud', 'Capture closer to the reader to see where damage starts'] },
  { id: 'twins', title: 'Two readers, one address', symptom: 'After adding a second reader, both readers flicker on- and off-line.',
    ask: 'How many devices answer the controller?',
    frames() {
      const f = track('/dev/ttyUSB0');
      f(C(1, 0x60, [], 1))(R(1, 0x40, [], 1), 3)(R(1, 0x50, [0, 1, 26, 0, 0x01, 0x23, 0x45, 0x00], 1), 1)
       (C(1, 0x61, [0], 2), 40)(R(1, 0x45, [...SIM_OUI, 1, 1, 1, 0, 0, 0, 2, 0, 1], 2), 3)(R(1, 0x45, [...SIM_OUI, 2, 1, 9, 0, 0, 0, 3, 1, 0], 2), 1);
      return f.frames;
    },
    observe: 'Each command gets two replies from address 1, and the two PDIDs carry different models and serial numbers.',
    causes: ['Both readers set to the same address', 'A replacement reader shipped at the same default address'],
    next: ['Disconnect one reader and read its PDID', 'Give each reader a unique address (COMSET or its own tool)', 'Update the panel’s reader list'] },
  { id: 'secure-required', title: 'Secure Channel required', symptom: 'LEDs never change, but cards read fine.',
    ask: 'What does the reader say about the LED command?',
    frames() { const f = track(); f(C(2, 0x60, [], 1))(R(2, 0x50, [0, 1, 26, 0, 0x01, 0x23, 0x45, 0x00], 1), 2)(C(2, 0x69, LED_GREEN_THEN_RED, 2), 30)(R(2, 0x41, [6], 2), 2)(C(2, 0x60, [], 3), 200)(R(2, 0x40, [], 3), 2); return f.frames; },
    observe: 'The card read arrives, the controller sends LED, and the reader refuses it with NAK 0x06.',
    causes: ['Reader configured to require Secure Channel, panel talking in plaintext', 'Panel’s secure setting lost after a replacement', 'Reader expects an installed key the panel does not have'],
    next: ['Compare the panel’s Secure Channel setting for this reader with the reader’s configuration', 'Check PDCAP function 9 for AES-128 support', 'If the site requires security, install the key in physically secured install mode'] },
  { id: 'key', title: 'Key mismatch', symptom: 'After a panel replacement, a secure reader never comes on-line.',
    ask: 'At which step does the handshake fail?',
    frames() {
      const f = track(); const rnd = [0xb0, 0xb1, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7];
      f(C(0, 0x76, rnd, 1, { scb: [3, 0x11, 1] }))(R(0, 0x76, [...SIM_OUI, 0, 1, 2, 3, 4, 0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, ...Array(16).fill(0x5c)], 1, { scb: [3, 0x12, 1] }), 3)
       (C(0, 0x77, Array(16).fill(0x3a), 2, { scb: [3, 0x13, 1] }), 20)(R(0, 0x78, Array(16).fill(0), 2, { scb: [3, 0x14, 0xff] }), 3)
       (C(0, 0x76, rnd, 0, { scb: [3, 0x11, 1] }), 600);
      return f.frames;
    },
    observe: 'CHLNG → CCRYPT → SCRYPT complete, then RMAC_I carries status 0xFF: the reader rejected the controller’s cryptogram. The controller starts over with SQN 0.',
    causes: ['Panel and reader hold different SCBKs', 'Reader still on the default key (SCBK-D) while the panel uses a site key, or the reverse', 'Session or context problem (stale challenge, interrupted handshake) or an implementation fault — a rejected cryptogram does not by itself prove a key mismatch'],
    next: ['Confirm which key each side is configured for', 'Re-key the reader in physically secured install mode', 'Never paste key values into tickets or captures'] },
  { id: 'reboot', title: 'Reader reboot', symptom: 'Short burst of off-line/on-line events with no wiring change.',
    ask: 'Which reply tells you the reader restarted?',
    frames() { const f = track(); f(C(5, 0x60, [], 1))(R(5, 0x40, [], 1), 2)(C(5, 0x60, [], 2), 200)(R(5, 0x40, [], 2), 2)(C(5, 0x60, [], 3), 200)(R(5, 0x40, [], 0), 2)(C(5, 0x61, [0], 0), 40)(R(5, 0x45, [...SIM_OUI, 1, 2, 0x39, 0x30, 0, 0, 5, 4, 10], 0), 2)(C(5, 0x62, [0], 1), 40)(R(5, 0x46, [4, 4, 1, 5, 2, 0, 8, 1, 0], 1), 2); return f.frames; },
    observe: 'A POLL with SQN 3 is answered with SQN 0. The controller restarts the sequence and rediscovers the reader (ID, CAP).',
    causes: ['Reader power dip or brown-out', 'Reader watchdog reset or firmware fault', 'Reader rebooting after a configuration or firmware change'],
    next: ['Check supply voltage under load (LED + buzzer + card field)', 'Look for a pattern in time (e.g. when a lock fires on the same supply)', 'Compare the firmware in PDID with the known-good version'] },
  { id: 'slow', title: 'Slow reader', symptom: 'Card reads feel sluggish; panel logs occasional timeouts.',
    ask: 'How long does the reader take to answer?',
    frames() { const f = track(); f(C(4, 0x60, [], 1))(R(4, 0x40, [], 1), 6)(C(4, 0x60, [], 2), 200)(R(4, 0x40, [], 2), 230)(C(4, 0x60, [], 3), 200)(R(4, 0x40, [], 3), 260)(C(4, 0x60, [], 1), 200)(R(4, 0x40, [], 1), 9); return f.frames; },
    observe: 'Two replies start well after the 200 ms limit; the others are quick.',
    causes: ['Reader busy (card field, display, firmware task)', 'RS-485 converter turnaround delay', 'Capture tool buffering — timestamps include transmission and USB latency'],
    next: ['Capture with a dedicated passive adapter close to the reader', 'Compare with a second reader of the same model and firmware', 'Check the panel’s reply timeout configuration'] },
  { id: 'denied', title: 'Card read, door stays locked', symptom: 'User badge beeps and shows red.',
    ask: 'Is this a reader fault?',
    frames() { const f = track(); f(C(2, 0x60, [], 1))(R(2, 0x50, [0, 1, 26, 0, 0x3d, 0x9f, 0xfe, 0x00], 1), 2)(C(2, 0x69, LED_RED_FLASH, 2), 25)(R(2, 0x40, [], 2), 2)(C(2, 0x6a, [0, 2, 1, 1, 3], 3), 10)(R(2, 0x40, [], 3), 2)(C(2, 0x60, [], 1), 200)(R(2, 0x40, [], 1), 2); return f.frames; },
    observe: 'The reader delivered a 26-bit card read. The controller answered with a red flash and three beeps. Protocol-wise everything worked.',
    causes: ['Credential not enrolled, expired or outside its schedule', 'Card format on the panel does not match the card', 'Wrong facility code'],
    next: ['Check the panel’s event log for the reason (for example “credential not found”)', 'Decode the bits with the site’s documented format in Readers › Card Formats', 'Do not swap the reader for a denied card'] },
  { id: 'gap', title: 'Missing frames', symptom: 'Trace shows sequence warnings.',
    ask: 'Is the controller broken?',
    frames() { const f = track(); f(C(6, 0x60, [], 1))(R(6, 0x40, [], 1), 2)(C(6, 0x60, [], 3), 400)(R(6, 0x40, [], 3), 2)(C(6, 0x60, [], 1), 200)(R(6, 0x40, [], 1), 2); return f.frames; },
    observe: 'SQN jumps from 1 to 3. The reply echoes 3 and the conversation continues normally.',
    causes: ['The capture dropped a frame (USB buffer, sniffer restart)', 'Less likely: the controller skipped a value'],
    next: ['Check whether the capture tool reports dropped bytes', 'Capture again with a dedicated adapter', 'Only blame the controller if it repeats in a clean capture'] },
  { id: 'ft', title: 'File transfer stall', symptom: 'Firmware update stops at 0%.',
    ask: 'Which side broke the file-transfer rules?',
    frames() {
      const f = track(); const frag = (off, n, seq, gap) => f(C(2, 0x7c, [1, 0x00, 0x10, 0, 0, off & 255, off >> 8, 0, 0, n, 0, ...Array(n).fill(0xee)], seq), gap);
      frag(0, 64, 1, 0); f(R(2, 0x7a, [0, 0xf4, 0x01, 0, 0, 0, 0], 1), 5); frag(64, 64, 2, 100); f(R(2, 0x7a, [0, 0, 0, 0xfd, 0xff, 0, 0], 2), 5); frag(128, 64, 3, 30);
      return f.frames;
    },
    observe: 'The reader asked for a 500 ms pause; the controller sent the next fragment after about 100 ms. The reader then reported status −3 (data unacceptable) and the controller kept going.',
    causes: ['Controller ignoring FtDelay', 'Wrong firmware file for this reader model', 'Controller ignoring a negative status'],
    next: ['Confirm the file matches the reader model and current firmware path', 'Check the tool honours FtDelay', 'Abort and restart the transfer from offset 0'] },
  { id: 'rx-only', title: 'Only one direction', symptom: 'New capture adapter shows replies but no commands.',
    ask: 'What can you conclude?',
    frames() { const f = track('/dev/ttyUSB1'); f(R(2, 0x40, [], 1))(R(2, 0x40, [], 2), 200)(R(2, 0x40, [], 3), 200)(R(2, 0x50, [0, 1, 26, 0, 0x01, 0x23, 0x45, 0x00], 1), 200); return f.frames; },
    observe: 'Only replies — never a command. The bus clearly works (replies are valid and in sequence).',
    causes: ['Capture point on the receive side of a converter', 'Sniffer only listens to one pair', 'Commands filtered by the tool'],
    next: ['Move the capture to the shared A/B pair', 'Do not report “controller silent” from this capture'] },
];
