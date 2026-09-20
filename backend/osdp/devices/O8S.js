// backend/osdp/devices/O8S.js
// Azure Access O8S: 8 relay outputs, no inputs, no readers.

const BaseDevice = require('./BaseDevice');

class O8S extends BaseDevice {
  constructor(opts = {}) {
    super({ ...opts, model: 'O8S' });
    this.numInputs  = 0;
    this.numOutputs = 8;
    this.numLEDs    = 0;
    this.numReaders = 0;
    this.outputs    = Buffer.alloc(8);
    this.commands.numInputs  = this.numInputs;
    this.commands.numOutputs = this.numOutputs;
    this.commands.numReaders = this.numReaders;
    this.commands.modelNumber = opts.identity?.modelNumber ?? 0x30;
  }

  getCapabilities() {
    // Azure Access O8S: 0 inputs / 8 outputs / 0 reader(s).
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

module.exports = O8S;
