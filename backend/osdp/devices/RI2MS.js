// backend/osdp/devices/RI2MS.js
// Azure Access RI2MS: 2-port reader interface.
// Total: 2 readers, 8 inputs, 4 outputs.
//
// Card-read replies are NOT generated yet — this device just stays online, accepts
// LED/BUZ/TEXT commands (ACK), and exposes its I/O for IC2 polls and the UI to drive.

const BaseDevice = require('./BaseDevice');

class RI2MS extends BaseDevice {
  constructor(opts = {}) {
    super({ ...opts, model: 'RI2MS' });
    this.numReaders = 2;
    this.numInputs  = 6;     // matches real Azure RI2MS PDCAP (was 8 in earlier guess)
    this.numOutputs = 4;
    this.numLEDs    = 2;
    this.inputs     = Buffer.alloc(this.numInputs);
    this.outputs    = Buffer.alloc(this.numOutputs);

    // Byte-exact identity captured from real Azure RI2MS on the bus.
    this.commands.vendorCode    = Buffer.from([0x00, 0x60, 0xEE]);
    this.commands.modelNumber   = 0x03;
    this.commands.version       = 0x04;
    this.commands.serialNumber  = 0x009C0000 | (this.address & 0xFF);
    this.commands.firmwareMajor = 0x01;
    this.commands.firmwareMinor = 0x1B;
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
    // Byte-exact PDCAP from real Azure RI2MS at addr 10: 6 inputs / 4 outputs / 2 readers.
    return Buffer.from([
      0x08, 0x01, 0x00,
      0x09, 0x01, 0x01,
      0x0A, 0xDC, 0x05,
      0x10, 0x02, 0x00,
      0x01, 0x04, 0x06,   // 6 inputs
      0x02, 0x03, 0x04,   // 4 outputs
      0x07, 0x01, 0x00,
      0x03, 0x01, 0x00,
      0x04, 0x04, 0x01,
      0x05, 0x02, 0x00,
      0x0D, 0x00, 0x04,
    ]);
  }

  // Track LED state per-reader before ACKing so the UI can display it.
  // osdp_LED data: reader#, led#, temp-ctrl-code, ... permanent-ctrl-code, on-color, off-color, ...
  handleLED(packet) {
    const d = packet.data;
    if (d && d.length >= 14) {
      const readerNum = d[0];
      const permOnColor = d[12];   // 0=off 1=red 2=green 3=amber 4=blue
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
      const onTime = d[2];   // 0 = off
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

  // Extend snapshot with reader state so the UI can show LED/buzzer/text
  snapshot() {
    return { ...super.snapshot(), readerState: this.readerState };
  }
}

module.exports = RI2MS;
