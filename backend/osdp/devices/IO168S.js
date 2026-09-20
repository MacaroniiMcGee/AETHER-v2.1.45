// backend/osdp/devices/IO168S.js
// Azure Access IO168S: 16 supervised inputs + 8 relay outputs.

const BaseDevice = require('./BaseDevice');

class IO168S extends BaseDevice {
  constructor(opts = {}) {
    super({ ...opts, model: 'IO168S' });
    this.numInputs  = 16;
    this.numOutputs = 8;
    this.numLEDs    = 0;
    this.numReaders = 0;
    this.inputs     = Buffer.alloc(16);
    this.outputs    = Buffer.alloc(8);
    this.commands.numInputs  = this.numInputs;
    this.commands.numOutputs = this.numOutputs;
    this.commands.numReaders = this.numReaders;
    this.commands.modelNumber = opts.identity?.modelNumber ?? 0x30;
  }

  getCapabilities() {
    // 11-record PDCAP matching real Azure Access boards captured from bus.
    // The 0x0D (Readers) record is REQUIRED — IC2 rejects PDCAP without it.
    return Buffer.from([
      0x08, 0x01, 0x00,             // Check chars: CRC supported
      0x09, 0x01, 0x01,             // Security: AES128 + SCBK-D
      0x0A, 0xDC, 0x05,             // RX buffer: 1500 bytes (0x05DC)
      0x10, 0x02, 0x00,             // OSDP version: 2.2
      0x01, 0x04, this.numInputs,   // 16 four-state supervised inputs
      0x02, 0x03, this.numOutputs,  // 8 outputs (direct + timed + complement)
      0x07, 0x01, 0x00,             // Time keeping supported
      0x03, 0x01, 0x00,             // Card data format
      0x04, 0x00, 0x00,             // Reader LEDs: 0 (no readers on IO168S)
      0x05, 0x00, 0x00,             // Reader buzzer: 0
      0x0D, 0x00, 0x00,             // Readers: 0  ← critical, was missing
    ]);
  }
}

module.exports = IO168S;
