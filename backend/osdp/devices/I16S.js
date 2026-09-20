// backend/osdp/devices/I16S.js
// Azure Access I16S: 16 supervised inputs, no outputs, no readers.
// OSDP capabilities advertise contact-status monitoring on 16 items.

const BaseDevice = require('./BaseDevice');

class I16S extends BaseDevice {
  constructor(opts = {}) {
    // Set counts BEFORE super() so OSDPCommands sees them in PDID/PDCAP
    super({ ...opts, model: 'I16S' });
    this.numInputs  = 16;
    this.numOutputs = 0;
    this.numLEDs    = 0;
    this.numReaders = 0;
    this.inputs     = Buffer.alloc(16);    // 0 = inactive, 1 = active
    // Re-init commands with correct counts (super() ran before subclass fields)
    this.commands.numInputs  = this.numInputs;
    this.commands.numOutputs = this.numOutputs;
    this.commands.numReaders = this.numReaders;
    this.commands.modelNumber = opts.identity?.modelNumber ?? 0x30; // arbitrary model id for I16S
  }

  getCapabilities() {
    // Azure Access I16S: 16 inputs / 0 outputs / 0 reader(s).
    // 11-record PDCAP matching the format captured from real Azure boards on the bus.
    return Buffer.from([
      0x08, 0x01, 0x00,                          // Check chars: CRC supported
      0x09, 0x01, 0x01,                          // Security: AES128 + SCBK-D
      0x0A, 0xDC, 0x05,                          // RX buffer: 1500 bytes (0x05DC)
      0x10, 0x02, 0x00,                          // OSDP version: 2.2
      0x01, 0x04, this.numInputs,                // Inputs, 4-state supervised
      0x02, 0x03, this.numOutputs,               // Outputs (direct+timed+complement)
      0x07, 0x01, 0x00,                          // Time keeping
      0x03, 0x01, 0x00,                          // Card data format
      0x04, 0x04, this.numReaders,               // Reader LEDs (1 per reader)
      0x05, 0x02, this.numReaders,               // Reader buzzers (1 per reader)
      0x0D, 0x00, this.numReaders,               // Readers count
    ]);
  }
}

module.exports = I16S;
