// backend/osdp/OSDPDeviceEmulator.js
// Multi-address OSDP PD (Peripheral Device) emulator.
// Listens on a serial port, parses incoming CP polls, dispatches by address byte,
// and writes the PD reply back on the same wire. Emits Socket.IO events for the UI.

const { SerialPort } = require('serialport');
const OSDPPacket = require('./OSDPPacket');

const I16S    = require('./devices/I16S');
const O8S     = require('./devices/O8S');
const IO168S  = require('./devices/IO168S');
const RI2MS   = require('./devices/RI2MS');
const RI4S    = require('./devices/RI4S');
const formatService = require('../lib/formatService');

const MODEL_REGISTRY = {
  'I16S':   I16S,
  'O8S':    O8S,
  'IO168S': IO168S,
  'RI2MS':  RI2MS,
  'RI4S':   RI4S,
};

class OSDPDeviceEmulator {
  /**
   * @param {Object} opts
   * @param {Function} opts.emit  Socket.IO bridge: emit(eventName, payload)
   * @param {Function} opts.log   logger: log(level, msg)
   */
  constructor({ emit = () => {}, log = () => {} } = {}) {
    this.emit = emit;
    this.log  = log;

    this.port    = null;       // SerialPort instance
    this.portPath = null;
    this.baud    = 9600;
    this.devices = new Map();  // address (0-127) → device instance
    this.rxBuf   = Buffer.alloc(0);
    this.running = false;

    // Stats
    this.framesIn  = 0;
    this.framesOut = 0;
    this.startedAt = 0;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────
  /**
   * @param {Object} cfg
   * @param {string} cfg.port        e.g. '/dev/ttyUSB0'
   * @param {number} cfg.baud        9600 | 19200 | 38400 | 57600 | 115200
   * @param {Array}  cfg.devices     [{address, model, identity?}, ...]
   */
  async start(cfg) {
    if (this.running) throw new Error('Emulator already running');
    if (!cfg.port) throw new Error('port required');

    this.portPath = cfg.port;
    this.baud     = cfg.baud || 9600;

    // Only replace the device map if the caller explicitly provided a non-empty list.
    // If cfg.devices is omitted or [], keep whatever was already configured via addDevice().
    if (Array.isArray(cfg.devices) && cfg.devices.length > 0) {
      this.devices.clear();
      for (const d of cfg.devices) {
        this._addDevice(d.address, d.model, d.identity);
      }
    }

    this.port = new SerialPort({
      path: this.portPath,
      baudRate: this.baud,
      autoOpen: false,
      lock: false,
      lock: false,
    });

    await new Promise((resolve, reject) => {
      this.port.open(err => err ? reject(err) : resolve());
    });

    this.port.on('data', chunk => this._onData(chunk));
    this.port.on('error', err => {
      this.log('error', `[Emulator] Port error: ${err.message}`);
      this.emit('emulator-error', { error: err.message });
    });
    this.port.on('close', () => {
      this.running = false;
      this.emit('emulator-stopped', {});
    });

    this.running   = true;
    this.startedAt = Date.now();
    this.framesIn  = 0;
    this.framesOut = 0;

    this.log('info', `[Emulator] Started on ${this.portPath} @ ${this.baud}, ${this.devices.size} device(s)`);
    this.emit('emulator-started', this.status());
  }

  async stop() {
    if (!this.running) return;
    this.running = false;
    if (this.port && this.port.isOpen) {
      await new Promise(r => this.port.close(() => r()));
    }
    this.port = null;
    this.rxBuf = Buffer.alloc(0);
    this.log('info', `[Emulator] Stopped`);
    this.emit('emulator-stopped', {});
  }

  // ── Device CRUD ───────────────────────────────────────────────────────
  _addDevice(address, model, identity = {}) {
    const Cls = MODEL_REGISTRY[model];
    if (!Cls) throw new Error(`Unknown model: ${model}`);
    if (address < 0 || address > 126) throw new Error(`Invalid address: ${address}`);
    let dev;
    dev = new Cls({
      address, identity,
      emit: (evt, payload) => {
        this.emit(evt, payload);
        // BaseDevice isn't an EventEmitter; it calls this injected emit directly.
        // Mirror output/input state changes as a full snapshot for the UI.
        if (evt === 'output-changed' || evt === 'input-changed' || evt === 'tamper-changed' || evt === 'powerfail-changed') {
          this.emit('emulator-device-update', dev.snapshot());
        }
      },
    });
    this.devices.set(address & 0x7F, dev);
    return dev;
  }

  addDevice(address, model, identity = {}) {
    if (this.devices.has(address & 0x7F)) throw new Error(`Address ${address} already configured`);
    const dev = this._addDevice(address, model, identity);
    this.emit('emulator-device-added', dev.snapshot());
    return dev;
  }

  removeDevice(address) {
    const a = address & 0x7F;
    const dev = this.devices.get(a);
    if (!dev) return false;
    this.devices.delete(a);
    this.emit('emulator-device-removed', { address: a });
    return true;
  }

  getDevice(address) { return this.devices.get(address & 0x7F) || null; }

  setInput(address, idx, value) {
    const dev = this.getDevice(address);
    if (!dev) return false;
    const ok = dev.setInput(idx, value);
    if (ok) this.emit('emulator-device-update', dev.snapshot());
    return ok;
  }

  /** Trigger or clear a tamper alarm on a specific emulated board. */
  setTamper(address, active) {
    const dev = this.devices.get(address);
    if (!dev) return { success: false, error: `No device at address ${address}` };
    if (typeof dev.setTamper !== 'function') return { success: false, error: 'Device does not support tamper' };
    const changed = dev.setTamper(!!active);
    return { success: true, address, tamperActive: dev.tamperActive, changed };
  }

  /** Trigger or clear a power-fail alarm on a specific emulated board. */
  setPowerFail(address, active) {
    const dev = this.devices.get(address);
    if (!dev) return { success: false, error: `No device at address ${address}` };
    if (typeof dev.setPowerFail !== 'function') return { success: false, error: 'Device does not support power-fail' };
    const changed = dev.setPowerFail(!!active);
    return { success: true, address, powerFailActive: dev.powerFailActive, changed };
  }

  /** Queue a card swipe on a specific reader port of an emulated board. */
  queueCardRead(address, port, formatId, facility, card, issueLevel = 0) {
    const dev = this.devices.get(address);
    if (!dev) return { success: false, error: `No device at address ${address}` };
    if (typeof dev.queueCardRead !== 'function') {
      return { success: false, error: `Device at ${address} does not have readers` };
    }
    if (port < 0 || port >= (dev.numReaders || 0)) {
      return { success: false, error: `Reader port ${port} out of range (0..${(dev.numReaders||1)-1})` };
    }

    // Encode credential — formatService returns { value, bits, bytes, hex, ... }.
    // We pass enc.bytes + enc.bits straight through, matching OSDPManager.buildCardReadReply.
    let enc;
    try {
      enc = formatService.encodeCredential(formatId, facility, card, issueLevel);
    } catch (e) {
      return { success: false, error: `Encode failed: ${e.message}` };
    }
    if (!enc || !enc.bytes || typeof enc.bits !== 'number') {
      return { success: false, error: `Encoder returned unexpected shape (keys: ${enc ? Object.keys(enc).join(',') : 'null'})` };
    }

    // formatCode = 1 mirrors the existing /api/osdp/card-read path (Wiegand-format specific).
    const ok = dev.queueCardRead(port, enc.bytes, enc.bits, 1);
    return {
      success: ok,
      address, port,
      format: formatId,
      facility, card, issueLevel,
      bitCount: enc.bits,
    };
  }

  /** Queue a PIN / keypad entry on a specific reader port. keys: "1234#" or array of byte values. */
  queueKeypadKeys(address, port, keys) {
    const dev = this.devices.get(address);
    if (!dev) return { success: false, error: `No device at address ${address}` };
    if (typeof dev.queueKeypadKeys !== 'function') {
      return { success: false, error: `Device at ${address} does not have readers` };
    }
    if (port < 0 || port >= (dev.numReaders || 0)) {
      return { success: false, error: `Reader port ${port} out of range` };
    }

    // Accept either a string ("1234#") or an array of byte values.
    // For strings, send ASCII bytes ('0'..'9'=0x30..0x39, '*'=0x2A, '#'=0x23, BS=0x7F).
    const keyBytes = typeof keys === 'string'
      ? Array.from(keys).map(c => c.charCodeAt(0) & 0xFF)
      : (Array.isArray(keys) ? keys.map(k => k & 0xFF) : []);

    if (keyBytes.length === 0) {
      return { success: false, error: 'No keys to send' };
    }

    const ok = dev.queueKeypadKeys(port, keyBytes);
    return { success: ok, address, port, count: keyBytes.length };
  }

  // ── Wire handling ─────────────────────────────────────────────────────
  _onData(chunk) {
    this.rxBuf = Buffer.concat([this.rxBuf, chunk]);
    this._drainBuffer();
  }

  _drainBuffer() {
    // Find SOM (0x53), validate length, attempt parse, advance.
    while (this.rxBuf.length >= 6) {
      const somIdx = this.rxBuf.indexOf(0x53);
      if (somIdx < 0) { this.rxBuf = Buffer.alloc(0); return; }
      if (somIdx > 0) this.rxBuf = this.rxBuf.slice(somIdx);
      if (this.rxBuf.length < 6) return;

      const length = this.rxBuf.readUInt16LE(2);
      if (length < 6 || length > 1500) {
        // Bad length — skip the SOM and try again
        this.rxBuf = this.rxBuf.slice(1);
        continue;
      }
      if (this.rxBuf.length < length) return;   // wait for more bytes

      const frame = this.rxBuf.slice(0, length);
      this.rxBuf  = this.rxBuf.slice(length);
      this._handleFrame(frame);
    }
  }

  _handleFrame(frame) {
    this.framesIn++;
    require('fs').appendFile('/tmp/emu-rx.log', `[Emu-RX] addr=${frame[1] & 0x7F} cmd=0x${frame[5].toString(16).padStart(2,'0')} hex=${frame.toString('hex').toUpperCase()}\n`, ()=>{});
    const packet = OSDPPacket.parsePacket(frame);
    if (!packet || packet.error) {
      this.log('warn', `[Emulator] Bad frame: ${packet?.error || 'unknown'}`);
      this.emit('emulator-frame', { direction: 'in', addr: frame[1] & 0x7F, ok: false, error: packet?.error, hex: frame.toString('hex') });
      return;
    }

    // Broadcast address (0x7F) — every PD reads but typically only address-0 responds
    const addr = packet.address;
    const dev  = this.devices.get(addr);

    this.emit('emulator-frame', {
      direction: 'in',
      addr,
      cmd: packet.command,
      seq: packet.sequence,
      hex: frame.toString('hex'),
      handled: !!dev,
    });

    if (!dev) return;  // not our address, ignore silently (matches real PD behavior)

    const reply = dev.handlePacket(packet);
    if (!reply) return;

    // Write reply. For USB-RS485 (ttyACM/ttyUSB) we MUST assert RTS HIGH to switch
    // the transceiver into TX mode, write, drain, then drop RTS back to RX.
    // Without this, bytes hit the UART buffer but never leave the transceiver —
    // IC2 sees silence, retries osdp_ID forever.
    const isUSB = this.portPath && (this.portPath.includes('ttyACM') || this.portPath.includes('ttyUSB'));
    const doWrite = () => {
      if (!this.running || !this.port?.isOpen) return;
      require('fs').appendFile('/tmp/emu-tx.log', `[Emu-TX] addr=${addr} cmd=0x${reply[5].toString(16).padStart(2,'0')} len=${reply.length} hex=${reply.toString('hex').toUpperCase()}\n`, ()=>{}); this.port.write(reply, err => {
        if (err) {
          this.log('error', `[Emulator] Write failed: ${err.message}`);
          if (isUSB) this.port.set({ rts: false }, () => {});
          return;
        }
        this.port.drain(() => {
          this.framesOut++;
          this.emit('emulator-frame', {
            direction: 'out',
            addr,
            hex: reply.toString('hex'),
          });
          this.emit('emulator-device-update', dev.snapshot());
          if (isUSB) {
            const t = setTimeout(() => this.port.set({ rts: false }, () => {}), 4);
            if (t.unref) t.unref();
          }
        });
      });
    };
    if (isUSB) {
      this.port.set({ rts: true }, () => {
        const t = setTimeout(doWrite, 1);
        if (t.unref) t.unref();
      });
    } else {
      setTimeout(doWrite, 1);
    }
  }

  // ── Status snapshot ──────────────────────────────────────────────────
  status() {
    return {
      running:   this.running,
      port:      this.portPath,
      baud:      this.baud,
      uptime:    this.running ? Date.now() - this.startedAt : 0,
      framesIn:  this.framesIn,
      framesOut: this.framesOut,
      devices:   Array.from(this.devices.values()).map(d => d.snapshot()),
    };
  }
}

// Singleton
module.exports = new OSDPDeviceEmulator();
module.exports.OSDPDeviceEmulator = OSDPDeviceEmulator;
module.exports.MODEL_REGISTRY = MODEL_REGISTRY;
