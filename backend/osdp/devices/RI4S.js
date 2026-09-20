// backend/osdp/devices/RI4S.js
// Azure Access RI4S: 4-port reader interface.
// Each port: 1 reader (LED/buzzer/text), 3 supervised inputs (DPS + REX + AUX), 2 outputs (strike + AUX relay).
// Total: 4 readers, 12 inputs, 8 outputs.

const BaseDevice = require('./BaseDevice');

class RI4S extends BaseDevice {
  constructor(opts = {}) {
    super({ ...opts, model: 'RI4S' });
    this.numReaders = 4;
    this.numInputs  = 12;
    this.numOutputs = 8;
    this.numLEDs    = 4;
    this.inputs     = Buffer.alloc(this.numInputs);
    this.outputs    = Buffer.alloc(this.numOutputs);

    // Byte-exact identity captured from real Azure RI4S on the bus.
    this.commands.vendorCode    = Buffer.from([0x00, 0x60, 0xEE]);
    this.commands.modelNumber   = 0x04;
    this.commands.version       = 0x03;
    // Unique serial per emulator address; high half matches real Azure format (009C....).
    this.commands.serialNumber  = 0x009C0000 | (this.address & 0xFF);
    this.commands.firmwareMajor = 0x01;
    this.commands.firmwareMinor = 0x1A;
    this.commands.firmwareBuild = 0x00;
    this.commands.numInputs     = this.numInputs;
    this.commands.numOutputs    = this.numOutputs;
    this.commands.numReaders    = this.numReaders;
    this.commands.numLEDs       = this.numLEDs;

    this.readerState = Array.from({ length: this.numReaders }, () => ({
      ledColor: 'off', buzzerOn: false, text: '',
    }));
  }

  getCapabilities() {
    // Byte-exact PDCAP from real Azure RI4S at addr 8: 12 inputs / 8 outputs / 4 readers.
    return Buffer.from([
      0x08, 0x01, 0x00,
      0x09, 0x01, 0x01,
      0x0A, 0xDC, 0x05,
      0x10, 0x02, 0x00,
      0x01, 0x04, 0x0C,   // 12 inputs
      0x02, 0x03, 0x08,   // 8 outputs
      0x07, 0x01, 0x00,
      0x03, 0x01, 0x00,
      0x04, 0x04, 0x01,
      0x05, 0x02, 0x00,
      0x0D, 0x00, 0x04,
    ]);
  }

  handleLED(packet) {
    const d = packet.data;
    if (d && d.length >= 14) {
      const readerNum = d[0];
      const permOnColor = d[12];
      const colors = ['off', 'red', 'green', 'amber', 'blue', 'magenta', 'cyan', 'white'];
      if (readerNum < this.numReaders) {
        this.readerState[readerNum].ledColor = colors[permOnColor] || 'off';
        this.emit('reader-state', { address: this.address, readerNum, state: this.readerState[readerNum] });
      }
    }
    return this._ack();
  }

  handleBUZ(packet) {
    const d = packet.data;
    if (d && d.length >= 5) {
      const readerNum = d[0];
      const onTime = d[2];
      if (readerNum < this.numReaders) {
        this.readerState[readerNum].buzzerOn = onTime > 0;
        this.emit('reader-state', { address: this.address, readerNum, state: this.readerState[readerNum] });
      }
    }
    return this._ack();
  }

  handleTEXT(packet) {
    const d = packet.data;
    if (d && d.length >= 6) {
      const readerNum = d[0];
      const textLen = d[5];
      const text = d.length >= 6 + textLen ? d.slice(6, 6 + textLen).toString('ascii') : '';
      if (readerNum < this.numReaders) {
        this.readerState[readerNum].text = text;
        this.emit('reader-state', { address: this.address, readerNum, state: this.readerState[readerNum] });
      }
    }
    return this._ack();
  }

  snapshot() {
    return { ...super.snapshot(), readerState: this.readerState };
  }
}

module.exports = RI4S;
