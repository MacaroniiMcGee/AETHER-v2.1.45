// osdp/OSDPComset.js — AETHER-COMSET
//
// Changes a reader's OSDP address and/or baud rate with osdp_COMSET (0x6E),
// SIA OSDP 2.2 §6.13, and checks the result.
//
//   1. POLL with sequence 0 (re-sync; some readers, WaveLynx among them,
//      ignore the command carried by a seq-0 packet, so we never send
//      COMSET as the seq-0 frame).
//   2. COMSET: 5 data bytes = new address, new baud (32-bit, low byte first).
//      The reader answers with osdp_COM (0x54) from its OLD address, then
//      switches. If it can't comply, COM carries the values it will use.
//   3. (optional) Close, reopen at the new baud and POLL the new address.
//      If that fails, POLL the old settings once to tell "ignored" from "lost".
//
// Every byte sent and received is kept in `wire` so the UI can show it.

const OSDPCpBase = require('./OSDPCpBase');

const CMD_POLL   = 0x60;
const CMD_COMSET = 0x6E;
const REPLY_ACK  = 0x40;
const REPLY_COM  = 0x54;

const VALID_BAUDS = [9600, 19200, 38400, 57600, 115200, 230400];

const REPLY_NAMES = {
  0x40: 'ACK', 0x41: 'NAK', 0x45: 'PDID', 0x46: 'PDCAP', 0x48: 'LSTATR', 0x49: 'ISTATR',
  0x4A: 'OSTATR', 0x4B: 'RSTATR', 0x50: 'RAW', 0x51: 'FMT', 0x53: 'KEYPAD', 0x54: 'COM',
  0x79: 'BUSY', 0x7A: 'FTSTAT', 0x90: 'MFGREP',
};

const NAK_HINTS = {
  0x01: 'Bad CRC/checksum on our command: check wiring, termination and that the baud matches the reader.',
  0x02: 'Command length error: the reader did not accept a 5-byte COMSET.',
  0x03: 'The reader does not support COMSET over OSDP. Use the vendor\'s config card, app or tool.',
  0x04: 'Sequence number error: another controller may be polling this reader. Disconnect the panel and retry.',
  0x05: 'The reader does not support the security block it received.',
  0x06: 'The reader only accepts this command inside a secure channel. Open a secure session with its key first.',
  0x09: 'The reader refused the values (address or baud out of its range).',
};

const hex = buf => Array.from(buf || [], b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
const sleep = ms => new Promise(r => setTimeout(r, ms));

class OSDPComset extends OSDPCpBase {
  constructor(opts = {}) {
    const broadcast = opts.address === 0x7F;
    super({ replyTimeout: 1500, ...opts, address: broadcast ? 0 : opts.address });
    if (broadcast) this.address = 0x7F;   // base class rejects 0x7F; broadcast is allowed here on purpose
    this.wire = opts.wire || [];          // shared across the change + verify instances
    this.t0   = opts.t0 || Date.now();
  }

  async open() {
    await super.open();
    this.tap();
  }

  // Record TX bytes. Called by open(); tests call it after injecting a mock port.
  tap() {
    if (!this.port || this.port.__comsetTapped) return;
    const write = this.port.write.bind(this.port);
    this.port.write = (buf, cb) => {
      this.wire.push({ t: Date.now() - this.t0, dir: 'tx', baud: this.baudRate, hex: hex(buf) });
      return write(buf, cb);
    };
    this.port.__comsetTapped = true;
  }

  _onData(chunk) {
    const last = this.wire[this.wire.length - 1];
    const now = Date.now() - this.t0;
    // Merge bytes that arrive in pieces into one RX line
    if (last && last.dir === 'rx' && now - last.t < 30) last.hex += ' ' + hex(chunk);
    else this.wire.push({ t: now, dir: 'rx', baud: this.baudRate, hex: hex(chunk) });
    super._onData(chunk);
  }

  async poll(label) {
    const step = { name: label, command: 'POLL' };
    try {
      const r = await this.sendAndAwait(CMD_POLL, null, null);
      step.ok = true;
      step.reply = REPLY_NAMES[r.command] || `0x${r.command.toString(16)}`;
    } catch (e) {
      step.ok = false;
      step.error = e.message;
    }
    return step;
  }

  /** Send COMSET. Returns { steps, com } — com is null unless the reader sent osdp_COM. */
  async change({ newAddress, newBaud }) {
    const steps = [];
    const sync = await this.poll('Re-sync (sequence 0 POLL)');
    steps.push(sync);
    if (!sync.ok) return { steps, com: null, failed: 'resync' };

    const data = Buffer.alloc(5);
    data[0] = newAddress & 0x7F;
    data.writeUInt32LE(newBaud >>> 0, 1);

    const step = { name: 'COMSET', command: 'COMSET 0x6E', dataHex: hex(data) };
    steps.push(step);
    try {
      const r = await this.sendAndAwait(CMD_COMSET, data, null, { timeoutMs: 2000 });
      if (r.command === REPLY_COM && r.data && r.data.length >= 5) {
        const com = { address: r.data[0] & 0x7F, baud: r.data.readUInt32LE(1) };
        step.ok = true;
        step.reply = 'COM';
        step.replyHex = hex(r.data);
        step.matches = com.address === (newAddress & 0x7F) && com.baud === newBaud;
        return { steps, com };
      }
      step.ok = r.command === REPLY_ACK;
      step.reply = REPLY_NAMES[r.command] || `0x${r.command.toString(16)}`;
      step.note = r.command === REPLY_ACK
        ? 'Reader sent ACK instead of COM. It may still have changed; the check below will tell.'
        : 'Unexpected reply to COMSET.';
      return { steps, com: null };
    } catch (e) {
      step.ok = false;
      step.error = e.message;
      const m = /NAK \(code 0x([0-9a-f]{2})\)/i.exec(e.message);
      if (m) {
        step.nak = parseInt(m[1], 16);
        step.hint = NAK_HINTS[step.nak] || null;
      } else if (/timeout/i.test(e.message)) {
        step.hint = 'No reply. The reader may not support COMSET, or it switched without answering. The check below will tell.';
      }
      return { steps, com: null, failed: 'comset' };
    }
  }
}

/** POLL a reader on a fresh port session. Retries, because readers take a moment to switch. */
async function probe({ portPath, baudRate, address, wire, t0, tries = 3, gapMs = 400, label }) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    const cp = new OSDPComset({ portPath, baudRate, address, wire, t0 });
    try {
      await cp.open();
      last = await cp.poll(label);
    } catch (e) {
      last = { name: label, command: 'POLL', ok: false, error: e.message };
    } finally {
      try { await cp.close(); } catch (_) {}
    }
    if (last.ok) return { ...last, attempts: i + 1 };
    await sleep(gapMs);
  }
  return { ...last, attempts: tries };
}

OSDPComset.VALID_BAUDS = VALID_BAUDS;
OSDPComset.NAK_HINTS   = NAK_HINTS;
OSDPComset.probe       = probe;
module.exports = OSDPComset;
