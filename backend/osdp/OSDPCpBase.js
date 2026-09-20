// osdp/OSDPCpBase.js
//
// Shared CP-mode serial plumbing. Used by:
//   - OSDPFirmwareUploader  (sends FILETRANSFER)
//   - OSDPFirmwareScanner   (sweeps addresses sending POLL)
//   - OSDPFirmwareIdentifier (sends osdp_ID + osdp_CAP)
//
// Handles port open/close, byte-stream framing, expected-reply matching,
// CP sequence rotation (1→2→3→1, 0 reserved for re-sync), BUSY suppression,
// and timeout management.

const EventEmitter = require('events');
const { SerialPort } = require('serialport');
const OSDPPacket = require('./OSDPPacket');

const REPLY_BUSY = 0x79;
const REPLY_NAK  = 0x41;

class OSDPCpBase extends EventEmitter {
  constructor({
    portPath,
    baudRate     = 9600,
    address      = 0x00,
    useCRC       = true,
    replyTimeout = 5000,
  } = {}) {
    super();
    if (!portPath) throw new Error('portPath is required');
    if (address < 0 || address > 0x7E) throw new Error(`address must be 0x00-0x7E (got ${address})`);

    this.portPath     = portPath;
    this.baudRate     = baudRate;
    this.address      = address & 0x7F;
    this.useCRC       = useCRC;
    this.replyTimeout = replyTimeout;

    this.port     = null;
    this.rxBuffer = Buffer.alloc(0);
    this.sequence = 1;
    this._needSync = true;      // first send returns seq=0 (OSDP re-sync packet)
    this.pending  = null;       // { resolve, reject, timer, expect }
  }

  // --- Port lifecycle ------------------------------------------------------

  async open() {
    if (this.port && this.port.isOpen) return;

    this.port = new SerialPort({
      path: this.portPath, baudRate: this.baudRate,
      dataBits: 8, parity: 'none', stopBits: 1,
      autoOpen: false, rtscts: false, xon: false, xoff: false,
    });

    await new Promise((resolve, reject) => {
      this.port.open(err => err ? reject(err) : resolve());
    });

    this.port.on('data',  d => this._onData(d));
    this.port.on('error', e => this.emit('error', e));
  }

  async close() {
    if (this.pending) {
      this.pending.reject(new Error('CP closed mid-operation'));
      this.pending = null;
    }
    if (this.port && this.port.isOpen) {
      await new Promise(resolve => this.port.close(() => resolve()));
    }
    this.port = null;
    this.rxBuffer = Buffer.alloc(0);
  }

  // Set the address for the next operation without reopening the port — used
  // by scanners that sweep across addresses on the same open port.
  setAddress(addr) {
    if (addr < 0 || addr > 0x7E) throw new Error(`address out of range: ${addr}`);
    this.address = addr & 0x7F;
    this.sequence = 1;
    this._needSync = true;       // new address → fresh conversation → re-sync
    this.rxBuffer = Buffer.alloc(0);   // drop any stale bytes between addresses
  }

  // --- Send / await reply --------------------------------------------------

  // OSDP sequence handling:
  //   - First message to a new PD (or after open()) uses seq=0 — the "re-sync"
  //     packet, which PDs must accept regardless of their internal state.
  //   - Subsequent messages rotate 1 → 2 → 3 → 1 → 2 → 3 → … (seq 0 is reserved
  //     for re-sync and not used after the first message).
  // Without this, a PD that already has an established sequence with another CP
  // will NAK our first message with code 0x04 (sequence number error).
  _nextSequence() {
    if (this._needSync) {
      this._needSync = false;
      this.sequence = 0;         // next call increments to 1, starting the 1-2-3 rotation
      return 0;
    }
    this.sequence = this.sequence >= 3 ? 1 : this.sequence + 1;
    return this.sequence;
  }

  async sendAndAwait(command, data, expectReply, { timeoutMs } = {}) {
    if (this.pending) throw new Error('Internal: previous request not finished');
    if (!this.port || !this.port.isOpen) throw new Error('Port not open');

    const seq    = this._nextSequence();
    const packet = OSDPPacket.buildPacket({
      address: this.address, command,
      data:    data || Buffer.alloc(0),
      sequence: seq, isReply: false, useCRC: this.useCRC,
    });

    const timeout = timeoutMs != null ? timeoutMs : this.replyTimeout;
    const expectLabel = expectReply == null
      ? 'any reply'
      : `0x${expectReply.toString(16).padStart(2,'0')}`;
    const replyPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new Error(`Reply timeout (>${timeout}ms) waiting for ${expectLabel} from addr 0x${this.address.toString(16).padStart(2,'0')}`));
      }, timeout);
      this.pending = { resolve, reject, timer, expect: expectReply };
    });

    // Mark rejection as handled so an early reject doesn't crash node;
    // the await on replyPromise below still propagates normally.
    replyPromise.catch(() => {});

    try {
      await new Promise((resolve, reject) => {
        this.port.write(packet, err => err ? reject(err) : this.port.drain(() => resolve()));
      });
    } catch (e) {
      if (this.pending) {
        if (this.pending.timer) clearTimeout(this.pending.timer);
        this.pending = null;
      }
      throw e;
    }

    return replyPromise;
  }

  // --- RX framing ----------------------------------------------------------

  _onData(chunk) {
    this.rxBuffer = Buffer.concat([this.rxBuffer, chunk]);

    /* eslint-disable no-constant-condition */
    while (true) {
      const somIdx = this.rxBuffer.indexOf(0x53);
      if (somIdx < 0) { this.rxBuffer = Buffer.alloc(0); return; }
      if (somIdx > 0) this.rxBuffer = this.rxBuffer.slice(somIdx);

      if (this.rxBuffer.length < 5) return;
      const declaredLen = this.rxBuffer.readUInt16LE(2);
      if (declaredLen < 6 || declaredLen > 2048) {
        this.rxBuffer = this.rxBuffer.slice(1);
        continue;
      }
      if (this.rxBuffer.length < declaredLen) return;

      const frame = this.rxBuffer.slice(0, declaredLen);
      this.rxBuffer = this.rxBuffer.slice(declaredLen);

      const parsed = OSDPPacket.parsePacket(frame);
      if (!parsed || parsed.error) {
        this.emit('frame-error', parsed ? parsed.error : 'parse failed');
        continue;
      }
      if (!parsed.isReply || parsed.address !== this.address) continue;

      this._handleReply(parsed);
    }
  }

  _handleReply(parsed) {
    if (!this.pending) return;

    if (parsed.command === REPLY_BUSY) {
      this.emit('busy');
      return;       // keep waiting
    }
    if (parsed.command === REPLY_NAK) {
      const code = parsed.data && parsed.data.length > 0 ? parsed.data[0] : 0xFF;
      this._settle(new Error(`Reader sent NAK (code 0x${code.toString(16).padStart(2,'0')})`), null);
      return;
    }
    if (this.pending.expect == null || parsed.command === this.pending.expect) {
      this._settle(null, parsed);
      return;
    }
    this._settle(
      new Error(`Unexpected reply 0x${parsed.command.toString(16)} (expected 0x${this.pending.expect.toString(16)})`),
      null
    );
  }

  _settle(err, value) {
    if (!this.pending) return;
    const { resolve, reject, timer } = this.pending;
    this.pending = null;
    if (timer) clearTimeout(timer);
    if (err) reject(err); else resolve(value);
  }
}

OSDPCpBase.REPLY_BUSY = REPLY_BUSY;
OSDPCpBase.REPLY_NAK  = REPLY_NAK;

module.exports = OSDPCpBase;
