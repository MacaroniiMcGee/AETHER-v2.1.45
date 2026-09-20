// osdp/OSDPFirmwareUploader.js
//
// Native Node.js OSDP firmware uploader (acts as CP).
//
// Implements osdp_FILETRANSFER (CMD 0x7C) per OSDP v2.2 and parses
// osdp_FTSTAT (REPLY 0x7A) responses. No Python subprocess required.
//
// Compatible with WaveLynx / Hanwha readers — the wire format matches what
// the official WaveLynx Python osdp_console emits (FILE_TYPE_OPAQUE = 0x01,
// 110-byte fragments by default).
//
// Usage:
//   const u = new OSDPFirmwareUploader({
//     portPath: '/dev/ttyUSB0',
//     baudRate: 9600,
//     address:  0x00,
//     useCRC:   true,
//   });
//   u.on('progress', p => console.log(p.percent));
//   u.on('status',   s => console.log(s.message));
//   await u.open();
//   try { await u.transferFile(firmwareBuffer); }
//   finally { await u.close(); }

const EventEmitter = require('events');
const { SerialPort } = require('serialport');
const OSDPPacket = require('./OSDPPacket');

// OSDP file-transfer constants
const CMD_FILETRANSFER  = 0x7C;
const CMD_POLL          = 0x60;     // used for leading re-sync POLL
const REPLY_FTSTAT      = 0x7A;
const REPLY_ACK         = 0x40;
const REPLY_NAK         = 0x41;
const REPLY_BUSY        = 0x79;

const FILE_TYPE_OPAQUE  = 0x01;   // generic / firmware

const FT_STATUS = {
  OK:        0,
  PROCESSED: 1,
  REBOOTING: 2,
  FINISHING: 3,
};

// 128-byte safe packet ceiling - 18 bytes overhead = 110 bytes of fragment
// (overhead = 11 bytes file-transfer header + 7 bytes OSDP packet framing
//  [SOM + ADDR + LEN×2 + CTRL + CMND + CRC×2])
const DEFAULT_FRAGMENT_SIZE = 110;

// How long to wait for any single reply before treating the link as dead.
const REPLY_TIMEOUT_MS = 30000;

// Hard cap on time spent polling the reader for final FT_PROCESSED/FT_REBOOTING.
const FINALIZE_TIMEOUT_MS = 60_000;

class OSDPFirmwareUploader extends EventEmitter {
  constructor({
    portPath,
    baudRate = 9600,
    address  = 0x00,
    useCRC   = true,
    fragmentSize = DEFAULT_FRAGMENT_SIZE,
  } = {}) {
    super();
    if (!portPath) throw new Error('portPath is required');
    if (address < 0 || address > 0x7E) throw new Error(`address must be 0x00-0x7E (got ${address})`);

    this.portPath     = portPath;
    this.baudRate     = baudRate;
    this.address      = address;
    this.useCRC       = useCRC;
    this.fragmentSize = Math.max(16, Math.min(fragmentSize, 1024));

    this.port      = null;
    this.rxBuffer  = Buffer.alloc(0);
    this.sequence  = 1;          // CP starts at 1; sequence 0 is reserved for re-sync
    this.aborted   = false;
    this.pending   = null;       // { resolve, reject, timer, expect }
  }

  // --- Port lifecycle ------------------------------------------------------

  async open() {
    if (this.port && this.port.isOpen) return;

    this.port = new SerialPort({
      path:     this.portPath,
      baudRate: this.baudRate,
      dataBits: 8,
      parity:   'none',
      stopBits: 1,
      autoOpen: false,
      rtscts:   false,
      xon:      false,
      xoff:     false,
    });

    await new Promise((resolve, reject) => {
      this.port.open(err => (err ? reject(err) : resolve()));
    });

    this.port.on('data',  d => this._onData(d));
    this.port.on('error', e => this.emit('error', e));

    this._emitStatus('info', `Opened ${this.portPath} @ ${this.baudRate} baud`);
  }

  async close() {
    if (this.pending) {
      this.pending.reject(new Error('Uploader closed mid-transfer'));
      this.pending = null;
    }
    if (this.port && this.port.isOpen) {
      await new Promise(resolve => this.port.close(() => resolve()));
    }
    this.port = null;
    this.rxBuffer = Buffer.alloc(0);
  }

  abort() {
    this.aborted = true;
    if (this.pending) {
      this.pending.reject(new Error('Transfer aborted'));
      this.pending = null;
    }
  }

  // --- Public entry point --------------------------------------------------

  /**
   * Send the entire file to the reader.
   * @param {Buffer} fileBuffer  Firmware bytes.
   * @param {Object} [opts]
   * @param {number} [opts.fileType=FILE_TYPE_OPAQUE]
   * @returns {Promise<{ bytesSent: number, fragments: number, finalStatus: number }>}
   */
  async transferFile(fileBuffer, opts = {}) {
    if (!Buffer.isBuffer(fileBuffer)) throw new Error('fileBuffer must be a Buffer');
    if (fileBuffer.length === 0)      throw new Error('fileBuffer is empty');
    if (!this.port || !this.port.isOpen) throw new Error('Port not open - call open() first');

    const fileType  = opts.fileType ?? FILE_TYPE_OPAQUE;
    const total     = fileBuffer.length;
    const fragSize  = this.fragmentSize;
    const fragCount = Math.ceil(total / fragSize);

    this.aborted = false;
    this._emitStatus('info',
      `Starting transfer: ${total} bytes in ${fragCount} fragments of ${fragSize}B to addr 0x${this.address.toString(16).padStart(2,'0')}`);

    // 0. Leading POLL re-sync.
    // OSDP seq=0 is the "re-sync" control packet. Some PDs interpret a seq=0
    // packet as a pure control message and ignore the embedded command — so
    // sending FILETRANSFER straight away as seq=0 gets NAK'd with code 0x04
    // (sequence number error). A leading POLL absorbs the re-sync slot, then
    // the actual FILETRANSFER fragments ride seq=1, 2, 3, 1, 2, 3...
    //
    // Set sequence to 0 so the first call returns 0 for the POLL; after the
    // POLL we set it back to 0 so the next call returns 1 for fragment 1.
    this.sequence = 0;
    try {
      const resyncPacket = OSDPPacket.buildPacket({
        address:  this.address,
        command:  CMD_POLL,
        data:     Buffer.alloc(0),
        sequence: 0,
        isReply:  false,
        useCRC:   this.useCRC,
      });
      // Send the POLL; we accept ANY reply (ACK is typical, but some readers
      // may say NAK 0x04 here too — that's OK, the next fragment with seq=1
      // is what really matters).
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending = null;
          this._emitStatus('warn', 'Re-sync POLL timed out — proceeding anyway');
          resolve();
        }, 1500);
        this.pending = {
          resolve: (v) => { clearTimeout(timer); resolve(v); },
          reject:  (e) => { clearTimeout(timer); this._emitStatus('warn', `Re-sync POLL got ${e.message} — proceeding anyway`); resolve(); },
          timer,
          expect:  null,   // accept any reply
        };
        this.port.write(resyncPacket, err => {
          if (err) { clearTimeout(timer); this.pending = null; reject(err); }
          else this.port.drain(() => {});
        });
      });
      this._emitStatus('info', 'Re-sync POLL complete, beginning fragments');
    } catch (e) {
      this._emitStatus('warn', `Re-sync POLL failed: ${e.message} — proceeding anyway`);
    }
    this.sequence = 0;     // next _nextSequence() returns 1 (first fragment rides seq=1)

    let offset = 0;
    let fragNo = 0;
    let interFragmentDelayMs = 0;

    // 1. Push all fragments
    for (let i = 0; i < fragCount; i++) {
      if (this.aborted) throw new Error('Aborted');

      const end       = Math.min(offset + fragSize, total);
      const fragment  = fileBuffer.slice(offset, end);
      const ftPayload = this._buildFtPayload(fileType, total, offset, fragment);

      const reply = await this._sendAndAwait(CMD_FILETRANSFER, ftPayload, REPLY_FTSTAT);
      const ft    = this._parseFtStat(reply.data);

      offset += fragment.length;
      fragNo += 1;

      this._emitProgress({
        phase:      'transfer',
        fragment:   fragNo,
        totalFragments: fragCount,
        bytesSent:  offset,
        totalBytes: total,
        percent:    Math.round((offset / total) * 100),
        ftStatus:   ft.status,
        ftDelay:    ft.delay,
      });

      // Reader-requested pause before next fragment
      if (ft.status === FT_STATUS.OK || ft.status === FT_STATUS.FINISHING) {
        interFragmentDelayMs = ft.delay;
      } else if (ft.status < 0) {
        throw new Error(`Reader reported file-transfer error (status ${ft.status}) after fragment ${fragNo}/${fragCount}`);
      } else if (ft.status === FT_STATUS.PROCESSED || ft.status === FT_STATUS.REBOOTING) {
        // Reader is satisfied before we finished iterating - rare but legal.
        this._emitStatus('info', `Reader signalled early completion (status ${ft.status}) after fragment ${fragNo}`);
        return { bytesSent: offset, fragments: fragNo, finalStatus: ft.status };
      }

      if (interFragmentDelayMs > 0) {
        await this._sleep(interFragmentDelayMs + 50);
      }
    }

    // 2. Finalize - poll with zero-length fragments at offset=total until the
    // reader reports PROCESSED or REBOOTING.
    this._emitStatus('info', 'All fragments sent — waiting for reader to finalize…');

    const finalizeStart = Date.now();
    let   finalStatus   = FT_STATUS.FINISHING;
    let   pollDelayMs   = Math.max(interFragmentDelayMs, 200);

    /* eslint-disable no-constant-condition */
    while (true) {
      if (this.aborted) throw new Error('Aborted');
      if (Date.now() - finalizeStart > FINALIZE_TIMEOUT_MS) {
        throw new Error(`Reader did not finalize within ${FINALIZE_TIMEOUT_MS / 1000}s`);
      }

      const finalPayload = this._buildFtPayload(fileType, total, total, Buffer.alloc(0));
      const reply = await this._sendAndAwait(CMD_FILETRANSFER, finalPayload, REPLY_FTSTAT);
      const ft    = this._parseFtStat(reply.data);

      this._emitProgress({
        phase:      'finalize',
        bytesSent:  total,
        totalBytes: total,
        percent:    100,
        ftStatus:   ft.status,
        ftDelay:    ft.delay,
      });

      if (ft.status === FT_STATUS.PROCESSED) {
        this._emitStatus('success', 'Reader reported PROCESSED — firmware accepted');
        finalStatus = ft.status;
        break;
      }
      if (ft.status === FT_STATUS.REBOOTING) {
        this._emitStatus('success', 'Reader reported REBOOTING — firmware accepted, reader is restarting');
        finalStatus = ft.status;
        break;
      }
      if (ft.status < 0) {
        throw new Error(`Reader reported file-transfer error (status ${ft.status}) during finalize`);
      }

      pollDelayMs = ft.delay > 0 ? ft.delay : pollDelayMs;
      await this._sleep(pollDelayMs + 50);
    }

    return { bytesSent: total, fragments: fragNo, finalStatus };
  }

  // --- Wire format helpers -------------------------------------------------

  /**
   * Build the FILETRANSFER data payload:
   *   FileType(1) | Total(LE4) | Offset(LE4) | FragLen(LE2) | Fragment(N)
   */
  _buildFtPayload(fileType, total, offset, fragment) {
    const header = Buffer.alloc(11);
    header[0] = fileType & 0xFF;
    header.writeUInt32LE(total  >>> 0, 1);
    header.writeUInt32LE(offset >>> 0, 5);
    header.writeUInt16LE(fragment.length & 0xFFFF, 9);
    return Buffer.concat([header, fragment]);
  }

  /**
   * Parse FTSTAT (REPLY 0x7A) data:
   *   Action(1) | Delay(LE2) | Status(LE2, signed) | UpdateMsgMax(LE2)
   *
   * Older firmwares sometimes return a shorter payload. We tolerate any
   * length ≥ 5 and fill in missing fields with sensible defaults.
   */
  _parseFtStat(data) {
    if (!data || data.length < 5) {
      throw new Error(`FTSTAT payload too short (${data ? data.length : 0} bytes)`);
    }
    const action       = data[0];
    const delay        = data.readUInt16LE(1);
    const rawStatus    = data.readUInt16LE(3);
    const status       = rawStatus > 0x7FFF ? rawStatus - 0x10000 : rawStatus;   // sign-extend LE16
    const updateMsgMax = data.length >= 7 ? data.readUInt16LE(5) : 0;
    return { action, delay, status, updateMsgMax };
  }

  // --- Low-level RX/TX -----------------------------------------------------

  _onData(chunk) {
    this.rxBuffer = Buffer.concat([this.rxBuffer, chunk]);

    // Walk the buffer looking for OSDP frames.
    /* eslint-disable no-constant-condition */
    while (true) {
      // Drop bytes before the first SOM
      const somIdx = this.rxBuffer.indexOf(0x53);
      if (somIdx < 0) {
        this.rxBuffer = Buffer.alloc(0);
        return;
      }
      if (somIdx > 0) this.rxBuffer = this.rxBuffer.slice(somIdx);

      // Need at least header to read length
      if (this.rxBuffer.length < 5) return;

      const declaredLen = this.rxBuffer.readUInt16LE(2);
      if (declaredLen < 6 || declaredLen > 2048) {
        // Sanity failure - drop one byte and re-sync
        this.rxBuffer = this.rxBuffer.slice(1);
        continue;
      }
      if (this.rxBuffer.length < declaredLen) return;     // wait for more

      const frame = this.rxBuffer.slice(0, declaredLen);
      this.rxBuffer = this.rxBuffer.slice(declaredLen);

      const parsed = OSDPPacket.parsePacket(frame);
      if (!parsed || parsed.error) {
        this._emitStatus('warn', `Bad frame: ${parsed ? parsed.error : 'parse failed'}`);
        continue;
      }

      // Only act on replies addressed to us
      if (!parsed.isReply || parsed.address !== this.address) continue;

      this._handleReply(parsed);
    }
  }

  _handleReply(parsed) {
    if (!this.pending) return;   // unsolicited reply, ignore

    // BUSY → just keep waiting on the timer; do NOT resolve
    if (parsed.command === REPLY_BUSY) {
      this._emitStatus('info', 'Reader BUSY — waiting');
      return;
    }
    // NAK → fail immediately
    if (parsed.command === REPLY_NAK) {
      const code = parsed.data && parsed.data.length > 0 ? parsed.data[0] : 0xFF;
      const err  = new Error(`Reader sent NAK (code 0x${code.toString(16).padStart(2,'0')})`);
      this._settlePending(err, null);
      return;
    }
    // Expected reply
    if (this.pending.expect == null || parsed.command === this.pending.expect) {
      this._settlePending(null, parsed);
      return;
    }
    // Unexpected (e.g. ACK when we wanted FTSTAT)
    this._settlePending(
      new Error(`Unexpected reply 0x${parsed.command.toString(16)} (expected 0x${this.pending.expect.toString(16)})`),
      null
    );
  }

  _settlePending(err, value) {
    if (!this.pending) return;
    const { resolve, reject, timer } = this.pending;
    this.pending = null;
    if (timer) clearTimeout(timer);
    if (err) reject(err); else resolve(value);
  }

  _nextSequence() {
    // OSDP CP sequence rotates 1→2→3→1 (0 reserved for re-sync)
    this.sequence = this.sequence >= 3 ? 1 : this.sequence + 1;
    return this.sequence;
  }

  async _sendAndAwait(command, data, expectReply) {
    if (this.pending) throw new Error('Internal: previous request not finished');

    const seq    = this._nextSequence();
    const packet = OSDPPacket.buildPacket({
      address:  this.address,
      command,
      data,
      sequence: seq,
      isReply:  false,
      useCRC:   this.useCRC,
    });

    const replyPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = null;
        reject(new Error(`Reply timeout (>${REPLY_TIMEOUT_MS}ms) waiting for 0x${expectReply.toString(16)} from addr 0x${this.address.toString(16)}`));
      }, REPLY_TIMEOUT_MS);
      this.pending = { resolve, reject, timer, expect: expectReply };
    });

    // Mark the rejection as handled up-front so an early reject (e.g. NAK
    // arriving before this function returns to its caller) doesn't surface as
    // an unhandled-rejection process exit. The await on `replyPromise` below
    // still propagates the rejection to the caller normally.
    replyPromise.catch(() => {});

    try {
      await new Promise((resolve, reject) => {
        this.port.write(packet, err => (err ? reject(err) : this.port.drain(() => resolve())));
      });
    } catch (writeErr) {
      if (this.pending) {
        if (this.pending.timer) clearTimeout(this.pending.timer);
        this.pending = null;
      }
      throw writeErr;
    }

    return replyPromise;
  }

  // --- Event helpers -------------------------------------------------------

  _emitProgress(p) { this.emit('progress', p); }
  _emitStatus(level, message) { this.emit('status', { level, message, ts: Date.now() }); }

  _sleep(ms) { return new Promise(r => setTimeout(r, Math.max(0, ms))); }
}

OSDPFirmwareUploader.FT_STATUS         = FT_STATUS;
OSDPFirmwareUploader.FILE_TYPE_OPAQUE  = FILE_TYPE_OPAQUE;
OSDPFirmwareUploader.DEFAULT_FRAGMENT_SIZE = DEFAULT_FRAGMENT_SIZE;

module.exports = OSDPFirmwareUploader;
