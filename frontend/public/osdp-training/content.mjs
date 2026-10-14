// AETHER OSDP Academy — lessons, knowledge checks, manufacturer steps.
// Facts are taken from the SIA OSDP 2.2.2 reference in spec-data.mjs; page
// numbers are the printed page numbers of that document.

// Each lesson: { tag, title, body: [paragraphs], try, open: page id, ref }
export const lessons = [
  { tag: 'Start here', title: 'A conversation between two devices',
    body: [
      'An access control system decides who may go where. The controller — the spec calls it the ACU (Access Control Unit), field teams often say CP or panel — talks to peripherals (PDs) such as card readers over an RS-485 bus. OSDP is the language of that conversation.',
      'The controller always speaks first and every command gets exactly one reply. The reader reports what happened (a card was read, a key was pressed); the controller decides what it means. A card read is not an access grant, and an LED command is not a door opening.',
    ],
    try: 'Open the capture classroom, load the simulated session and find a POLL and the ACK that answers it. Which one has bit 7 of ADDR set?', open: 'captures', ref: 'p. 11' },
  { tag: 'Bits → bytes', title: 'Read the alphabet before the sentence',
    body: [
      'A bit is 0 or 1. Eight bits make one byte, worth 0–255. Hexadecimal writes a byte as two digits 0–9 and A–F: 53 hex = 5×16 + 3 = 83 decimal = 01010011 binary. Hex 10 is 16, not ten.',
      'Offsets count from zero: offset 0 is the first byte. Numbers longer than a byte are little-endian in OSDP — the low byte comes first — so the length bytes 14 00 mean 0x0014 = 20.',
    ],
    try: 'In the bit bench, set bits 7 and 1 and read the result as an ADDR byte.', open: 'bits', ref: 'p. 11 (byte order)' },
  { tag: 'The envelope', title: 'Every frame has the same outline',
    body: [
      'SOM 0x53 marks the start. ADDR carries a 7-bit address plus the reply flag. LEN (two bytes, low first) is the length of the whole frame from SOM to the last check byte. CTRL holds the sequence number (bits 0–1), the check mode (bit 2: 1 = CRC-16, 0 = checksum) and whether a security block follows (bit 3). Bits 4–7 must be 0.',
      'If CTRL bit 3 is set, a security block (SCB) sits before the command: its first byte is its own length, its second its type. Then comes the command or reply code, the DATA, a 4-byte MAC on secure-session frames, and finally the CRC (2 bytes, low first) or a 1-byte checksum. A 0xFF “mark” byte may precede SOM; it is not counted in LEN.',
    ],
    try: 'Build a POLL to address 2, sequence 1, with CRC. Click each byte and read its job. Then switch to checksum and watch LEN and the trailer change.', open: 'builder', ref: 'pp. 11–15' },
  { tag: 'Who is speaking?', title: 'Direction, address and sequence',
    body: [
      'ADDR bit 7 is 0 on a command and 1 on a reply, and a reply carries the address of the reader that sent it: 0x82 is a reply from address 2. Addresses 0x00–0x7E are normal; 0x7F is the broadcast/configuration address and should only be used with a single reader connected.',
      'The controller counts SQN 1, 2, 3, 1, 2, 3… for each reader; 0 means “start over”. A reply echoes the SQN of its command. A command repeated with the same SQN is a retransmission: the reader should send its previous reply again without acting twice. A reply with SQN 0 (other than BUSY) asks the controller to reset — typical after a reader reboot.',
    ],
    try: 'Load the “Reader reboot” scenario and find the reply that asks for a reset.', open: 'faults', ref: 'pp. 13–14' },
  { tag: 'Trust the bytes', title: 'Integrity before interpretation',
    body: [
      'Checksum mode ends with one byte chosen so that all bytes add to 0 modulo 256. CRC mode ends with a CRC-16 (polynomial 0x1021, start value 0x1D0F), low byte first. A reader that sees bad check bytes answers NAK 0x01 and the controller may resend.',
      'Neither the CRC nor the checksum proves who sent the frame — only that the bytes were not damaged on the way. Check LEN and the trailer before you trust anything the frame says.',
    ],
    try: 'In the fault bench, flip one bit, read the CRC mismatch, then recalculate the trailer. What did recalculating hide?', open: 'faults', ref: 'pp. 13–15; Annex E test vectors, p. 86' },
  { tag: 'Timing', title: 'The bus is shared and half-duplex',
    body: [
      'RS-485 carries one talker at a time. The reader must start its reply less than 200 ms after the command’s last byte (typically under 3 ms). If nothing comes back in time, the controller moves on to the next reader.',
      'Inside a frame, a gap of about 20 ms aborts reception and the receiver waits for the next SOM. A reader treats the link as off-line after 8 seconds without a message it answers; both sides then restart with SQN 0 (and a new Secure Channel handshake if used). After a timeout the controller should resend at most 3 times, then restart the session with SQN 0.',
    ],
    try: 'Load the “Slow reader” scenario. Which replies break the 200 ms rule, and why might capture timestamps exaggerate it?', open: 'faults', ref: 'pp. 12–13' },
  { tag: 'Conversation rules', title: 'What may answer what',
    body: [
      'Each command has an expected reply: ID → PDID, CAP → PDCAP, LED/BUZ/TEXT → ACK, OUT → ACK or OSTATR, COMSET → COM, FILETRANSFER → FTSTAT, MFG → ACK or MFGREP. NAK or BUSY can answer anything.',
      'POLL is how events reach the controller: ACK means nothing to report; otherwise the reader answers with a card read (RAW), keys (KEYPAD), a status change (LSTATR/ISTATR/OSTATR/RSTATR) or vendor data. BUSY means “ask again” — the controller repeats the same command with the same SQN. After any NAK other than 0x01, retrying the same command will not help.',
    ],
    try: 'Run the conversation coach on the simulated session. Every pairing it accepts follows the expected-reply map.', open: 'captures', ref: 'Annex A, pp. 66–67' },
  { tag: 'Discover a reader', title: 'ID and capability conversations',
    body: [
      'ID asks for PDID: vendor OUI (3 bytes), model, version, a 32-bit serial number and firmware major.minor.build. CAP asks for PDCAP: 3-byte records of function, compliance and “number of”.',
      'The meaning of the last two bytes depends on the function. LED control level 4 means red-green-amber; receive buffer size is a 16-bit number spread across both bytes; OSDP version 4 means SIA 2.2.2. A function that is missing is not supported. Never assume a capability the reader did not report.',
    ],
    try: 'Inspect the simulated PDCAP. Find the LED level, the receive buffer size and whether AES-128 is offered.', open: 'captures', ref: '§7.4–7.5, pp. 44–46; Annex B' },
  { tag: 'Make it visible', title: 'LEDs, buzzers, outputs and credentials',
    body: [
      'An LED record is 14 bytes: reader, LED, a temporary part (control, on/off time, on/off colour, 16-bit timer) and a permanent part (control, on/off time, on/off colour). Both parts live in one record; the temporary setting runs for its timer, then the LED returns to its permanent state. BUZ is 5 bytes; OUT records are 4 bytes. Times are in 100 ms units.',
      'RAW reports reader number, format code, a 16-bit bit count and the bits themselves, left-justified. Thirty-two bits need four bytes; 26 bits need four bytes too, with 6 unused bits. A bit count does not identify a card format. KEYPAD sends ASCII key codes; without Secure Channel a PIN is readable on the wire.',
    ],
    try: 'Build an LED command that flashes green for 2 s and then stays red. Then build the same thing as two records for two LEDs.', open: 'builder', ref: '§6.9–6.12, pp. 20–26; §7.10–7.12, pp. 48–52' },
  { tag: 'Secure Channel', title: 'Recognise protection without inventing plaintext',
    body: [
      'Four steps set up a session: CHLNG (SCS_11, controller challenge) → CCRYPT (SCS_12, reader ID, random and cryptogram) → SCRYPT (SCS_13, controller cryptogram) → RMAC_I (SCS_14, accepted 0x01 or rejected 0xFF). Code 0x76 is CHLNG as a command and CCRYPT as a reply.',
      'After that, messages without DATA use SCS_15/16 (MAC only) and messages with DATA use SCS_17/18 (encrypted + MAC). You can still read the envelope, the code and the length; the DATA is ciphertext and the 4-byte MAC needs session keys to check. A plaintext command in the middle of a session ends it. KEYSET belongs only inside an encrypted session or physically secured install mode.',
    ],
    try: 'Load the “Key mismatch” scenario and find the step where the reader refuses.', open: 'faults', ref: 'Annex D, pp. 76–80' },
  { tag: 'File transfer', title: 'Firmware arrives one fragment at a time',
    body: [
      'FILETRANSFER carries a type, the total size, this fragment’s offset and size, then the bytes. Each one is answered by FTSTAT: an action bitmap, a delay the controller must wait, a signed status and an optional new maximum fragment size.',
      'Status 0 means continue, 1 means processed, 2 means “rebooting now — expect a full reset”, 3 means “finishing — send idle fragments”, and negative numbers mean stop. Offsets must increase. This is the exchange behind Aether’s Readers › OSDP › Firmware page.',
    ],
    try: 'Load the “File transfer stall” scenario and decide which side broke the flow.', open: 'faults', ref: '§6.26, §7.25, pp. 34–36, 60–61' },
  { tag: 'Manufacturer workshop', title: 'An extension needs a contract',
    body: [
      'MFG (0x80, command) and MFGREP (0x90, reply) carry vendor-specific exchanges. The first three DATA bytes are the vendor’s IEEE OUI; in a command the next byte is in effect the vendor’s Command_ID; the rest belongs to the vendor’s document for that exact model and firmware.',
      'Never borrow another company’s OUI. An extension needs an assigned identifier, model and firmware scope, command layout, field sizes, byte order, reserved values, expected replies, security requirements and error behaviour.',
    ],
    try: 'Build a fictional extension offline, write its schema, then check a capture against it.', open: 'manufacturer', ref: '§6.19, §7.18, pp. 29–30, 57' },
  { tag: 'Aether OSDP Trace', title: 'Read the bus the way Aether does',
    body: [
      'Readers › OSDP Trace in Aether shows the same traffic in four tabs: Conversation (command and reply pairs), Readers (per-address health), Timeline and Tests (expectation rules such as “LED within 2 s of a card read”). Captures can be saved on the Pi and exported as CSV, text or JSON.',
      'The Academy reads that trace too. Turn on Live from Aether in the capture classroom and it follows the Pi’s trace without sending anything to the bus. You can also import a saved capture or an export file. Aether and the Academy decode from the same SIA 2.2.2 field tables, so a disagreement between them is worth reporting.',
    ],
    try: 'In the capture classroom, switch on Live from Aether, then emulate a card read from Readers › OSDP and watch it arrive.', open: 'captures', ref: 'Aether Readers › OSDP Trace' },
  { tag: 'Support method', title: 'Evidence before diagnosis',
    body: [
      'Record the port, baud, reader model and firmware, timestamps, direction and the full bytes. A failed CRC points to an integrity problem; it does not by itself prove a bad cable. A NAK says why a command was refused. Missing traffic may mean the capture point only hears one side.',
      'Compare before-and-after captures and keep observations separate from hypotheses: “reader 3 stopped answering at 14:02:11 after a COMSET” is an observation; “the reader is broken” is a guess.',
    ],
    try: 'Work through one troubleshooting scenario end to end and export the worksheet.', open: 'faults', ref: '' },
];

// Knowledge checks: { level, q, options, answer, why }
export const levels = ['Foundations', 'Reading the header', 'Conversations', 'Security & timing', 'Vendor & support'];
export const quizzes = [
  { level: 1, q: 'How many bits are in one byte?', options: ['4', '8', '16'], answer: 1, why: 'Eight bits; two hex digits describe one byte.' },
  { level: 1, q: 'What does a reader’s RAW reply establish?', options: ['The door opened', 'A credential was read', 'Access was granted'], answer: 1, why: 'The controller still has to apply its access rules.' },
  { level: 1, q: '0x53 is hexadecimal. What is it in decimal?', options: ['53', '83', '103'], answer: 1, why: '5 × 16 + 3 = 83.' },
  { level: 1, q: 'Who begins every OSDP exchange?', options: ['The reader', 'The controller (ACU)', 'Whoever has data'], answer: 1, why: 'Only the ACU sends spontaneously; each command gets exactly one reply.' },
  { level: 1, q: 'Hex 10 equals…', options: ['10', '16', '2'], answer: 1, why: '1 × 16 + 0 = 16.' },
  { level: 1, q: 'Which byte starts every OSDP frame?', options: ['0xFF', '0x53', '0x7E'], answer: 1, why: 'SOM is 0x53. An optional 0xFF mark may come before it but is not part of the counted frame.' },
  { level: 2, q: 'ADDR 0x82 means…', options: ['Command to address 0x82', 'Reply from address 2', 'Reply from address 128'], answer: 1, why: '0x82 AND 0x7F = 2, and bit 7 is set.' },
  { level: 2, q: 'Length bytes 14 00 describe how many bytes?', options: ['14', '20', '5120'], answer: 1, why: 'Little-endian: 0x0014 = 20.' },
  { level: 2, q: 'CTRL 0x05 means…', options: ['SQN 1, CRC, no SCB', 'SQN 5, checksum', 'Encrypted payload'], answer: 0, why: 'Bits 0–1 = 1, bit 2 = 1, bit 3 = 0.' },
  { level: 2, q: 'Where is the command code when CTRL bit 3 is set?', options: ['Always offset 5', 'Right after the security block', 'After the CRC'], answer: 1, why: 'Offset 5 holds the SCB length; the code follows the SCB.' },
  { level: 2, q: 'CTRL 0x1D — what is wrong?', options: ['Nothing', 'Reserved bit 4 is set', 'Sequence 5 is illegal'], answer: 1, why: '0x1D = 0001 1101: bit 4 is reserved and must be 0.' },
  { level: 2, q: 'LEN counts…', options: ['Only the DATA', 'SOM through the last check byte', 'Everything including the 0xFF mark'], answer: 1, why: 'The whole frame, excluding any leading mark byte.' },
  { level: 3, q: 'A command with SQN 2 gets a reply with SQN 2. Is that a gap?', options: ['Yes', 'No', 'Only for LED'], answer: 1, why: 'A reply echoes its command’s sequence number.' },
  { level: 3, q: 'The controller sends the same command again with the same SQN. What should the reader do?', options: ['Run it again', 'Resend its previous reply without acting twice', 'NAK 0x04'], answer: 1, why: 'Same SQN = retransmission (spec same-sqn-retransmit).' },
  { level: 3, q: 'Which reply is NOT allowed to answer POLL?', options: ['RAW', 'KEYPAD', 'PDCAP'], answer: 2, why: 'PDCAP answers CAP. POLL gets ACK or an event such as RAW, KEYPAD or a status report.' },
  { level: 3, q: 'A reader answers BUSY. What should the controller do?', options: ['Send the same command with the same SQN', 'Send the next command with SQN+1', 'Reset with SQN 0'], answer: 0, why: 'BUSY means “try again”; repeat the original command unchanged.' },
  { level: 3, q: 'After NAK 0x03 (unknown command), retrying…', options: ['Usually fixes it', 'Will not help', 'Is required 3 times'], answer: 1, why: 'Only NAK 0x01 (bad check) is worth retrying.' },
  { level: 3, q: 'A 26-bit RAW read is always H10301.', options: ['True', 'False'], answer: 1, why: 'Several formats use 26 bits. Use a documented format map.' },
  { level: 3, q: 'A PDCAP record’s third byte always means a count of devices.', options: ['True', 'False'], answer: 1, why: 'It depends on the function; for receive buffer size it is the high byte of a number.' },
  { level: 3, q: 'A reply arrives with SQN 0 to an ordinary POLL. Most likely…', options: ['Normal', 'The reader restarted and asks for a sequence reset', 'A CRC error'], answer: 1, why: 'A PD reply with SQN 0 (except BUSY) asks the ACU to reset and clears any secure session.' },
  { level: 4, q: 'The CRC passes on an encrypted frame. Can we read the payload?', options: ['Yes, CRC decrypts it', 'No, the session keys are needed', 'Yes, if the vendor matches'], answer: 1, why: 'Integrity checks neither decrypt nor authenticate.' },
  { level: 4, q: 'Put the Secure Channel steps in order.', options: ['CHLNG → CCRYPT → SCRYPT → RMAC_I', 'CCRYPT → CHLNG → RMAC_I → SCRYPT', 'KEYSET → CHLNG → ACK'], answer: 0, why: 'SCS_11 → SCS_12 → SCS_13 → SCS_14.' },
  { level: 4, q: 'RMAC_I carries status 0xFF in its security block. Meaning?', options: ['Session up', 'Controller cryptogram rejected — keys differ', 'Reader busy'], answer: 1, why: '0x01 = accepted, 0xFF = rejected.' },
  { level: 4, q: 'Inside a session, a command with DATA must use…', options: ['SCS_15', 'SCS_17', 'No security block'], answer: 1, why: 'SCS_15/16 are MAC-only and meant for messages without DATA.' },
  { level: 4, q: 'How long may a reader take to start its reply?', options: ['Under 200 ms (typically < 3 ms)', 'Up to 2 s', 'Up to 8 s'], answer: 0, why: 'REPLY_DELAY is at most 200 ms.' },
  { level: 4, q: 'After how long without traffic does a reader consider itself off-line?', options: ['200 ms', '8 s', '60 s'], answer: 1, why: 'More than 8 s between answered messages.' },
  { level: 4, q: 'NAK 0x06 means…', options: ['Bad CRC', 'Encrypted communication is required for this command', 'Unknown command'], answer: 1, why: 'The reader is configured to require Secure Channel.' },
  { level: 4, q: 'KEYSET is sent in plaintext on a live site. Concern?', options: ['None', 'The new key is exposed on the wire', 'Only the sequence'], answer: 1, why: 'KEYSET belongs inside an encrypted session or physically secured install mode.' },
  { level: 5, q: 'An unknown vendor payload contains 01. What should support report?', options: ['Profile enabled', 'Opaque value 01; find the matching vendor document', 'Firmware version 1'], answer: 1, why: 'Do not turn an undocumented value into a product claim.' },
  { level: 5, q: 'How should a vendor schema be scoped?', options: ['Vendor only', 'Vendor, model, firmware and document revision', 'Any reader using MFG'], answer: 1, why: 'Extensions change across product families and firmware.' },
  { level: 5, q: 'A tap that also sends POLLs to the bus is…', options: ['Passive', 'Active — a second controller', 'Passive at 9600 baud'], answer: 1, why: 'Any transmitted command makes it a participant and can collide with the real controller.' },
  { level: 5, q: 'Which evidence supports a vendor feature claim?', options: ['A byte changed', 'Documented meaning plus repeatable capture and device behaviour', 'An ACK'], answer: 1, why: 'Separate transport acceptance, documented meaning and observed behaviour.' },
  { level: 5, q: 'A capture has only replies, no commands. First suspicion?', options: ['The controller is dead', 'The capture point only hears one direction', 'The reader is in Secure Channel'], answer: 1, why: 'Receive-only taps commonly miss the controller side.' },
  { level: 5, q: 'Aether’s OSDP Trace and the Academy disagree on a field. What next?', options: ['Trust whichever looks right', 'Note the frame bytes and report it — both use the same SIA 2.2.2 tables', 'Ignore it'], answer: 1, why: 'One shared field table means a mismatch is a bug worth reporting with the bytes.' },
];

export const mfgSteps = [
  ['1. Identify', 'Capture PDID; record model, serial, firmware, vendor OUI and controller version. Keep the original bytes.'],
  ['2. Get the contract', 'Get the vendor command document for that exact firmware. Record title, revision and page. An OUI is not a command dictionary.'],
  ['3. Map the layout', 'Define Command_ID, offsets, widths, signedness, byte order, units, enums and bit masks. State reserved fields and exact request and reply lengths.'],
  ['4. Model the exchange', 'Specify the expected MFGREP, ACK or NAK, timeouts, retry limits, Secure Channel needs and whether the change survives a reboot.'],
  ['5. Build offline', 'Build the envelope and payload, check LEN and CRC. Test boundary values, unsupported Command_IDs, bad lengths and reserved bits in an emulator.'],
  ['6. Prove on hardware', 'Use an isolated lab reader on the approved controller path. Capture before and after, confirm the reply and observe the behaviour. One controller in charge of the bus.'],
  ['7. Publish a scoped decoder', 'Add golden request/reply captures, provenance, firmware ranges and regression tests. Keep unknown bytes. Never execute vendor data as code.'],
];
