// backend/osdp/devices/BaseDevice.js
// Common OSDP Peripheral Device (PD) state machine.
// Subclasses (I16S, O8S, IO168S, RI2MS, RI4S) extend this and override I/O / reader handlers.
// Wire framing is delegated to ../OSDPPacket; this class is purely application-level.
//
// Command codes are per OSDP v2.2 Annex B.

const OSDPPacket = require('../OSDPPacket');
const OSDPCommands = require('../OSDPCommands');

// ────────────────────────────────────────────────────────────────────────
// Command (CP → PD) and Reply (PD → CP) codes used by this emulator.
// We list them as constants here rather than magic numbers in the switch.
const CMD = {
  POLL:    0x60,
  ID:      0x61,
  CAP:     0x62,
  LSTAT:   0x64,
  ISTAT:   0x65,
  OSTAT:   0x66,
  RSTAT:   0x67,
  OUT:     0x68,
  LED:     0x69,
  BUZ:     0x6A,
  TEXT:    0x6B,
  COMSET:  0x6E,
  KEEPALIVE: 0x79,
  CHLNG:   0x76,
  SCRYPT:  0x77,
};

const REPLY = {
  ACK:     0x40,
  NAK:     0x41,
  PDID:    0x45,
  PDCAP:   0x46,
  LSTATR:  0x48,
  ISTATR:  0x49,
  OSTATR:  0x4A,
  RSTATR:  0x4B,
  RAW:     0x50,
  KEYPAD:  0x53,
  COM:     0x54,
};

// NAK error codes (Annex B Table 9)
const NAK = {
  BAD_CHECKSUM:        0x01,
  COMMAND_LENGTH:      0x02,
  UNKNOWN_COMMAND:     0x03,
  UNEXPECTED_SEQUENCE: 0x04,
  SECURITY_REQUIRED:   0x05,
  ENCRYPTION_REQUIRED: 0x06,
  BIO_TYPE:            0x07,
  BIO_FORMAT:          0x08,
  UNABLE_TO_PROCESS:   0x09,
};

class BaseDevice {
  /**
   * @param {Object} opts
   * @param {number} opts.address       OSDP address 0-126
   * @param {string} opts.model         'I16S' | 'O8S' | 'IO168S' | 'RI2MS' | 'RI4S'
   * @param {Object} opts.identity      vendor/model/serial overrides for PDID
   * @param {Function} opts.emit        callback to publish device events to Socket.IO
   */
  constructor({ address, model, identity = {}, emit = () => {} }) {
    this.address = address & 0x7F;
    this.model   = model;
    this.online  = true;
    this.emit    = emit;

    // Sequence handling — PD echoes CP's sequence in replies
    this.lastSeq = 0;

    // Stats
    this.pollCount     = 0;
    this.lastPollAt    = 0;
    this.lastCommand   = null;
    this.lastReplyAt   = 0;

    // Local status (tamper + power-fail) — surfaced via LSTATR.
    this.tamperActive = false;
    this.powerFailActive = false;
    this.pendingLocalStatusChange = false;

    // Card / keypad event queue for reader ports — drained on POLL.
    // Pushed by queueCardRead() / queueKeypadKeys() (subclasses with readers only).
    this.pendingCardReads = [];

    // Pre-built reply helper with our identity
    this.commands = new OSDPCommands({
      vendorCode:    identity.vendorCode || Buffer.from([0x00, 0x17, 0x66]),
      modelNumber:   identity.modelNumber ?? 0x01,
      version:       identity.version ?? 0x01,
      serialNumber:  identity.serialNumber ?? (0x12340000 | this.address),
      firmwareMajor: identity.firmwareMajor ?? 1,
      firmwareMinor: identity.firmwareMinor ?? 0,
      firmwareBuild: identity.firmwareBuild ?? 0,
      numInputs:     this.numInputs ?? 0,
      numOutputs:    this.numOutputs ?? 0,
      numLEDs:       this.numLEDs ?? 0,
      numReaders:    this.numReaders ?? 0,
    });
  }

  // ─── Override points for subclasses ────────────────────────────────────
  /** Return Buffer for osdp_PDCAP reply payload (capability list) */
  getCapabilities() {
    // Default: minimal CAP entries. Subclasses extend.
    // Each entry: [Function, Compliance, NumOfItems]  (3 bytes per cap)
    return Buffer.from([
      0x01, 0x01, 0x01,  // Contact Status Monitoring, simple
      0x02, 0x01, 0x01,  // Output Control, simple
      0x04, 0x00, 0x00,  // Card Data Format, none
      0x09, 0x00, 0x00,  // CRC, disabled (we use checksum by default)
      0x0A, 0x00, 0x00,  // Smart Card, none
    ]);
  }

  /** Handle osdp_ISTAT — subclasses with inputs override */
  handleIStat(_packet) {
    if (!this.numInputs) return this._nak(NAK.UNKNOWN_COMMAND);
    const states = Buffer.alloc(this.numInputs);
    for (let i = 0; i < this.numInputs; i++) states[i] = this.inputs[i] ? 1 : 0;
    return this._reply(REPLY.ISTATR, states);
  }

  /** Handle osdp_OSTAT — subclasses with outputs override */
  handleOStat(_packet) {
    if (!this.numOutputs) return this._nak(NAK.UNKNOWN_COMMAND);
    const states = Buffer.alloc(this.numOutputs);
    for (let i = 0; i < this.numOutputs; i++) states[i] = this.outputs[i] ? 1 : 0;
    return this._reply(REPLY.OSTATR, states);
  }

  /** Handle osdp_OUT — control an output. Payload: outputNum, code, timer_LSB, timer_MSB */
  handleOutput(packet) {
    if (!this.numOutputs) return this._nak(NAK.UNKNOWN_COMMAND);
    const d = packet.data;
    if (!d || d.length < 4) return this._nak(NAK.COMMAND_LENGTH);
    const outNum    = d[0];
    const code      = d[1];
    const timer     = d[2] | (d[3] << 8);   // 100ms units, 0=permanent
    if (outNum >= this.numOutputs) return this._nak(NAK.UNABLE_TO_PROCESS);

    // Output control codes per Annex B Table 14:
    //  0 = perm off  | 1 = perm on  | 2 = temp on (timer) | 3 = temp off (timer)
    //  4 = perm off no override | 5 = perm on no override | 6/7 = same w/timer
    // Azure semantics (empirically observed from real RI4S at addr=8):
    //   TEMP-ON  (code 2) -> relay HIGH  (door unlocked)
    //   PERM-ON  (code 1) -> relay LOW   (door locked - "return to secure state")
    //   PERM-OFF (code 0/4) -> relay LOW
    // The IC2 enforces the door's grant time: it sends TEMP-ON when access is
    // granted and PERM-ON when the grant time expires. We just follow its timing.
    // Only auto-revert if IC2 explicitly delegated timing via a non-zero timer field.
    const isAzurePulse = (code === 2 || code === 6);
    const newState = isAzurePulse ? 1 : 0;
    this.outputs[outNum] = newState;
    if (timer > 0 && (code === 2 || code === 3 || code === 6 || code === 7)) {
      // Auto-revert after timer
      clearTimeout(this._outputTimers?.[outNum]);
      this._outputTimers = this._outputTimers || {};
      this._outputTimers[outNum] = setTimeout(() => {
        this.outputs[outNum] = !newState;
        this.emit('output-changed', { address: this.address, outNum, state: this.outputs[outNum], auto: true });
      }, timer * 100);
    }
    this.emit('output-changed', { address: this.address, outNum, state: newState, auto: false });

    // Reply with full output status (OSTATR)
    return this.handleOStat();
  }

  /** Handle osdp_LED — readers override. Default: ACK */
  handleLED(_packet)  { return this._ack(); }
  handleBUZ(_packet)  { return this._ack(); }
  handleTEXT(_packet) { return this._ack(); }

  // ─── External helpers used by frontend ─────────────────────────────────
  /** Programmatically toggle an input (simulating a sensor change) */
  setInput(idx, value) {
    if (idx < 0 || idx >= this.numInputs) return false;
    const oldVal = this.inputs[idx] ? 1 : 0;
    const newVal = value ? 1 : 0;
    this.inputs[idx] = newVal;
    if (oldVal !== newVal) {
      this.pendingInputChange = true;   // ← will push ISTATR on next POLL reply
    }
    return true;
  }

  // ─── Main dispatch ─────────────────────────────────────────────────────
  /**
   * @param {Object} packet — parsed by OSDPPacket.parsePacket
   * @returns {Buffer | null} reply packet bytes (already framed), or null to stay silent
   */
  handlePacket(packet) {
    if (!this.online) return null;

    this.lastSeq     = packet.ctrl?.sequence ?? packet.sequence ?? 0;
    this.lastUseCRC  = packet.ctrl?.useCRC   ?? packet.useCRC   ?? false; 
    this.lastCommand = packet.command;
    this.lastPollAt  = Date.now();
    this.pollCount++;

    let reply;
    switch (packet.command) {
      case CMD.POLL:    reply = this._handlePoll(packet); break;
      case CMD.ID:      reply = this._handleId(packet);   break;
      case CMD.CAP:     reply = this._handleCap(packet);  break;
      case CMD.LSTAT:   reply = this._handleLStat(packet); break;
      case CMD.ISTAT:   reply = this.handleIStat(packet); break;
      case CMD.OSTAT:   reply = this.handleOStat(packet); break;
      case 0x67: {  // RSTAT — reader status request
        // Reply with one byte per reader (0x01 = normal). Boards with zero
        // readers (I16S/O8S/IO168S) reply with an empty RSTATR which Azure
        // boards seem to accept; if not we'll need a numReaders > 0 guard.
        const n = this.numReaders || 0;
        const payload = Buffer.alloc(n, 0x01);
        reply = this._reply(0x4B, payload);  // 0x4B = RSTATR
        break;
      }
      case CMD.OUT:     reply = this.handleOutput(packet); break;
      case CMD.LED:     reply = this.handleLED(packet);   break;
      case CMD.BUZ:     reply = this.handleBUZ(packet);   break;
      case CMD.TEXT:    reply = this.handleTEXT(packet);  break;
      case CMD.COMSET:  reply = this._handleComSet(packet); break;
      case CMD.KEEPALIVE: reply = this._ack(); break;
      case 0x80: {
        // Vendor mfg_cmd. Real Azure boards are SELECTIVE in how they reply:
        //   sub 0x15 -> 0x90 mfg_reply echoing vendor+sub (observed from real RI4S at addr 8)
        //   all other subs (0x16, 0x17, 0x04, 0x14, 0x1F...) -> plain ACK
        // Replying ACK to 0x15, or 0x90 to everything, both cause IC2 to abandon discovery.
        const mdata = packet.data || Buffer.alloc(0);
        const sub = mdata.length >= 4 ? mdata[3] : 0x00;
        if (sub === 0x15) {
          reply = this._reply(0x90, mdata.slice(0, 4));
        } else {
          reply = this._ack();
        }
        break;
      }   // mfg_cmd — ACK like real Azure boards
      default:
        // Unknown / unsupported: NAK with code 0x03
        reply = this._nak(NAK.UNKNOWN_COMMAND);
    }

    this.lastReplyAt = Date.now();
    return reply;
  }

  // ─── Internal handlers ─────────────────────────────────────────────────
  _handlePoll() {
    // If an input changed since last POLL, push the new state instead of plain ACK.
    // The IC2 sees the input report on the very next poll cycle (<250ms typically).
    // Card-read / keypad queue — drain ONE entry per POLL, highest priority.
    // Subclasses with readers (RI4S, RI2MS) populate this via queueCardRead/Keys.
    if (this.pendingCardReads && this.pendingCardReads.length > 0) {
      const entry = this.pendingCardReads.shift();
      if (entry.type === 'card') {
        // OSDP 0x50 RAW reply — payload layout matches OSDPManager.buildCardReadReply
        // exactly so IC2 sees identical wire frames from emulated boards and Pi-side readers.
        const payload = Buffer.concat([
          Buffer.from([
            entry.readerNum & 0xFF,
            entry.formatCode & 0xFF,
            entry.bitCount & 0xFF,
            (entry.bitCount >> 8) & 0xFF,
          ]),
          entry.bytes,
        ]);
        return this._reply(0x50, payload);
      }
      if (entry.type === 'keys') {
        // OSDP 0x53 KEYPAD reply: [readerNum, count, ...key bytes]
        const count = entry.keys.length;
        const payload = Buffer.alloc(2 + count);
        payload[0] = entry.readerNum & 0xFF;
        payload[1] = count & 0xFF;
        for (let i = 0; i < count; i++) payload[2 + i] = entry.keys[i] & 0xFF;
        return this._reply(0x53, payload);
      }
    }

    // Local status change (tamper or power-fail) — push LSTATR on next POLL.
    // Triggered by setTamper() / setPowerFail() setting pendingLocalStatusChange.
    if (this.pendingLocalStatusChange) {
      this.pendingLocalStatusChange = false;
      return this._reply(REPLY.LSTATR, Buffer.from([
        this.tamperActive    ? 0x01 : 0x00,
        this.powerFailActive ? 0x01 : 0x00,
      ]));
    }
    if (this.pendingInputChange && this.numInputs > 0) {
      this.pendingInputChange = false;
      const states = Buffer.alloc(this.numInputs);
      for (let i = 0; i < this.numInputs; i++) states[i] = this.inputs[i] ? 1 : 0;
      return this._reply(REPLY.ISTATR, states);
    }
    return this._ack();
  }

  _handleId() {
    // PDID payload from OSDPCommands
    return this._reply(REPLY.PDID, this.commands.buildPDID());
  }

  _handleCap() {
    return this._reply(REPLY.PDCAP, this.getCapabilities());
  }

  _handleLStat() {
    this.pendingLocalStatusChange = false;
    return this._reply(REPLY.LSTATR, Buffer.from([
      this.tamperActive    ? 0x01 : 0x00,
      this.powerFailActive ? 0x01 : 0x00,
    ]));
  }

  _handleComSet(packet) {
    // CP wants to change our address / baud. Reply COM with new params (then switch).
    const d = packet.data;
    if (!d || d.length < 5) return this._nak(NAK.COMMAND_LENGTH);
    const newAddr = d[0];
    const newBaud = d[1] | (d[2] << 8) | (d[3] << 16) | (d[4] << 24);
    this.emit('com-set', { address: this.address, newAddr, newBaud });
    // Reply mirrors back the accepted settings, then dispatcher applies them.
    const reply = this._reply(REPLY.COM, Buffer.from([
      newAddr & 0xFF,
      newBaud & 0xFF, (newBaud >> 8) & 0xFF, (newBaud >> 16) & 0xFF, (newBaud >> 24) & 0xFF
    ]));
    // Defer address change until after reply is on the wire
    setImmediate(() => { this.address = newAddr & 0x7F; });
    return reply;
  }

  // ─── Reply framing helpers ─────────────────────────────────────────────
  _ack() {
    return OSDPPacket.buildACK(this.address, this.lastSeq);
  }

  _nak(errorCode) {
    return OSDPPacket.buildNAK(this.address, errorCode, this.lastSeq);
  }

  _reply(command, data) {
    return OSDPPacket.buildPacket({
      address: this.address,
      command,
      data,
      sequence: this.lastSeq,
      useCRC: this.lastUseCRC,
      isReply: true,
      useCRC: this.lastUseCRC,
    });
  }

  setTamper(active) {
    const v = !!active;
    if (this.tamperActive === v) return false;
    this.tamperActive = v;
    this.pendingLocalStatusChange = true;
    if (typeof this.emit === 'function') this.emit('tamper-changed', v);
    return true;
  }

  setPowerFail(active) {
    const v = !!active;
    if (this.powerFailActive === v) return false;
    this.powerFailActive = v;
    this.pendingLocalStatusChange = true;
    if (typeof this.emit === 'function') this.emit('powerfail-changed', v);
    return true;
  }

  // ─── Reader event queue ──────────────────────────────────────────────
  // Subclasses with readers (numReaders > 0) accept queued card and keypad
  // events. The next POLL drains one entry and surfaces it to IC2 via
  // 0x50 RAW (card) or 0x53 KEYPAD (PIN).
  queueCardRead(readerNum, bytes, bitCount, formatCode = 1) {
    // Accepts pre-encoded bytes (Buffer or array), matching the byte layout
    // that OSDPManager.buildCardReadReply uses. formatCode defaults to 1
    // (Wiegand-26 specific) which is what the existing card-read path uses.
    if (!this.numReaders || readerNum >= this.numReaders) return false;
    if (!bytes || !bytes.length || !bitCount) return false;
    this.pendingCardReads.push({
      type: 'card',
      readerNum: readerNum | 0,
      formatCode: formatCode | 0,
      bitCount: bitCount | 0,
      bytes: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes),
    });
    if (typeof this.emit === 'function') {
      this.emit('reader-card-queued', { readerNum, bitCount });
    }
    return true;
  }

  queueKeypadKeys(readerNum, keys) {
    if (!this.numReaders || readerNum >= this.numReaders) return false;
    if (!Array.isArray(keys) || keys.length === 0) return false;
    this.pendingCardReads.push({
      type: 'keys',
      readerNum: readerNum | 0,
      keys: keys.map(k => k & 0xFF),
    });
    if (typeof this.emit === 'function') {
      this.emit('reader-keys-queued', { readerNum, count: keys.length });
    }
    return true;
  }

  // ─── Snapshot for UI ──────────────────────────────────────────────────
  snapshot() {
    return {
      address:    this.address,
      model:      this.model,
      online:     this.online,
      pollCount:  this.pollCount,
      lastPollAt: this.lastPollAt,
      lastCommand: this.lastCommand,
      numInputs:  this.numInputs,
      numOutputs: this.numOutputs,
      inputs:     this.numInputs  ? Array.from(this.inputs)  : null,
      outputs:    this.numOutputs ? Array.from(this.outputs) : null,
      tamperActive:    this.tamperActive,
      powerFailActive: this.powerFailActive,
    };
  }
}

module.exports = BaseDevice;
module.exports.CMD = CMD;
module.exports.REPLY = REPLY;
module.exports.NAK = NAK;
