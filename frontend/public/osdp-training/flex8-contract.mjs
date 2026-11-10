// AETHER OSDP Academy — FLEX8-OUT4 fictional teaching contract.
//
// NOT A REAL PRODUCT. Vendor bytes AE 7E 00 are the Academy's fictional, locally administered
// identifier (never a real company's OUI); never send these
// frames to real hardware. Offsets are DATA-relative (DATA[0..2] vendor,
// DATA[3] subcommand). Fields marked `inferred: true` have offsets taken from
// the contract's worked example rather than its text, and the UI must say so.

const FLEX = Array.from({ length: 8 }, (_, n) => `Flex${n + 1}`);
const TAMPERS = ['cover', 'external', 'panel', 'backplane'];
const cap = (s) => s[0].toUpperCase() + s.slice(1);

const contract = {
  name: 'FLEX8-OUT4 I/O expansion panel (fictional training contract)',
  vendorHex: 'AE7E00',
  model: 'FLEX8-OUT4-TRAINING',
  firmware: 'contract rev 1 (simulated)',
  document: 'AETHER training contract FLEX8-OUT4 rev 1 — fictional, not a real product; simulation only',
  fictional: true,
  notes: [
    'Hardware: 8 flex channels (each configured as an input or an output), 4 dedicated outputs OUT1–OUT4, 1 FAI (fire alarm interface) input, and 4 tamper inputs (0 cover, 1 external, 2 panel, 3 backplane).',
    'Four-state input model: one uint8 per input — 0 Normal, 1 Active, 2 Trouble, 3 Shorted.',
    'A separate validity mask says which state bytes apply. Flex channels in output mode or disabled have validity 0, and their state byte must be ignored — it is not "Normal".',
    'Invert flips Normal↔Active only; it never swaps Trouble and Shorted.',
    'Requested and effective output states are distinct: an FAI override or the comms-loss fallback can force the effective state away from what was requested.',
    'Tamper: the present circuit state and the latched alarm are separate facts; a cleared circuit does not clear the latch.',
  ],
  enums: {
    sourceType: { 0: 'Flex input', 1: 'FAI input', 2: 'Tamper input' },
  },
  schemas: [
    {
      name: 'Supervised input state transition', kind: 'event', code: 0x90, subcommand: 0x92, length: 15,
      notes: 'Unsolicited event sent as an MFGREP in answer to a poll.',
      fields: [
        { name: 'Event counter', offset: 4, width: 2, encoding: 'uint', endian: 'little', description: 'Increments per event, modulo 65536.' },
        { name: 'Source type', offset: 6, width: 1, encoding: 'enum', enum: 'sourceType' },
        { name: 'Source index', offset: 7, width: 1, encoding: 'uint',
          description: 'Flex: 0–7 = Flex1–Flex8; FAI: 0; Tamper: 0 cover, 1 external, 2 panel, 3 backplane.',
          indexLabels: { field: 'Source type', map: { 0: FLEX, 1: ['FAI'], 2: TAMPERS.map((t) => `Tamper ${t}`) } } },
        { name: 'Current state', offset: 8, width: 1, encoding: 'state4', validity: { field: 'Validity flags', bit: 0 } },
        { name: 'Previous state', offset: 9, width: 1, encoding: 'state4', validity: { field: 'Validity flags', bit: 1 } },
        { name: 'Validity flags', offset: 10, width: 1, encoding: 'bits', reservedMask: 0xf8,
          bits: [{ bit: 0, name: 'current valid' }, { bit: 1, name: 'previous valid' }, { bit: 2, name: 'latch active' }] },
        { name: 'Device tick', offset: 11, width: 4, encoding: 'uint', endian: 'little', unit: 'ms',
          description: 'Monotonic device tick; wraps; not wall-clock time.' },
      ],
    },
    {
      name: 'Status readback (partial)', kind: 'reply', code: 0x90, subcommand: 0x12, length: 38,
      notes: "Partial: this teaching copy documents only the bytes whose meaning is confirmed by the contract's worked example; the rest are preserved as undocumented.",
      fields: [
        { name: 'Flex input validity', offset: 8, width: 1, encoding: 'bits', inferred: true,
          bits: FLEX.map((name, n) => ({ bit: n, name: `${name} valid` })), description: 'Bit n = Flex n+1 state byte applies.' },
        ...FLEX.map((name, n) => ({ name: `${name} state`, offset: 10 + n, width: 1, encoding: 'state4',
          validity: { field: 'Flex input validity', bit: n } })),
        ...TAMPERS.map((t, n) => ({ name: `Tamper ${t} state`, offset: 25 + n, width: 1, encoding: 'state4', inferred: true,
          validity: { field: 'Tamper validity', bit: n }, description: 'Present circuit state (not the latched alarm).' })),
        { name: 'Tamper validity', offset: 29, width: 1, encoding: 'bits', inferred: true,
          bits: TAMPERS.map((t, n) => ({ bit: n, name: `${cap(t)} valid` })), description: 'Bit n = tamper n state byte applies.' },
      ],
    },
    {
      name: 'Set output activity', kind: 'request', code: 0x80, subcommand: 0x11, length: 14,
      notes: 'Layout not in this teaching copy — bytes preserved.',
      fields: [],
    },
  ],
};

export default contract;

export const examples = [
  { name: 'Supervised input state transition', kind: 'event',
    fullHex: '53 82 17 00 05 90 AE 7E 00 92 01 00 00 02 03 02 03 E8 03 00 00 26 CF',
    expect: 'Flex3 Trouble → Shorted, event counter 1, device tick 1000 ms.' },
  { name: 'Status readback (partial)', kind: 'reply',
    fullHex: '53 82 2E 00 05 90 AE 7E 00 12 03 00 01 00 0F F0 00 01 02 03 00 00 00 00 0F 00 00 00 00 04 00 01 00 02 03 0F 00 00 01 00 00 00 00 00 E2 2D',
    expect: 'Flex1 Normal, Flex2 Active, Flex3 Trouble, Flex4 Shorted, Flex5–8 not applicable (validity clear); tamper cover Active, external Normal, panel Trouble, backplane Shorted.' },
  { name: 'Set output activity', kind: 'request',
    fullHex: '53 02 16 00 05 80 AE 7E 00 11 02 00 00 00 01 01 01 E8 03 00 47 6C',
    expect: 'OUT1 pulse 1000 ms per the contract text; layout not in this teaching copy, so DATA bytes 4–13 stay undocumented.' },
];
