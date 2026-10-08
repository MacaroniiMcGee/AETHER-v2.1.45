// OSDPEnroller.js — the Pi acts as an OSDP controller (ACU) on a USB-RS485
// adapter so you can present cards to a real reader and capture the exact bits.
// Standard (non-secure) operation only: the reader sends osdp_RAW in the clear.
//
// It polls the reader, learns its identity/capabilities, and emits every card
// read with the raw bit string. The bit-map derivation (multi-card diff) and
// format matching live in enrollAnalyze.js so they can be tested on their own.
'use strict';

const EventEmitter = require('events');
const fs = require('fs');
const { SerialPort } = require('serialport');
const OSDPPacket = require('./OSDPPacket');
const { decodeFrame } = require('./trace/osdpDecoder');

// Onboard RS-485 UARTs (Sequent HAT etc.) — these carry OSDP too but don't show
// up in SerialPort.list(), so we add any that exist on disk. Hardware handles
// the transmit direction on these, so leave RTS off.
const ONBOARD_PORTS = ['/dev/ttyAMA0', '/dev/ttyAMA10', '/dev/ttySC0', '/dev/ttySC1'];

const SCAN_ADDRS = [0, 1, 2, 3, 4, 5, 6, 7];
const SCAN_BAUDS = [9600, 19200, 38400, 57600, 115200];
const DIAG_ADDRS = Array.from({ length: 16 }, (_, i) => i);   // 0..15 for the wider diagnostic sweep
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Classify what a port's captured bytes mean, so a swapped/idle line isn't
// masked by our own transmission echoing back on a half-duplex adapter.
//   reply : a real OSDP reply came back (a reader is there)
//   low   : a continuous 0x00 stream — RX held low → A/B (D+/D−) swapped or no bias
//   high  : a continuous 0xFF stream — line idle/floating, nothing driving it
//   echo  : only our own command frames came back (we're hearing our TX)
//   noise : varied bytes that won't frame — wrong baud, or A/B swapped mid-traffic
//   idle  : nothing at all — port opened cleanly but silent
function classifyLine(buf, replies, echoed) {
  if (replies > 0) return 'reply';
  if (!buf.length) return 'idle';
  let allZero = true, allFF = true;
  for (const b of buf) { if (b !== 0x00) allZero = false; if (b !== 0xFF) allFF = false; if (!allZero && !allFF) break; }
  if (allZero) return 'low';
  if (allFF) return 'high';
  if (echoed > 0) return 'echo';
  return 'noise';
}

class OSDPEnroller extends EventEmitter {
  constructor({ identifyCard, releasePort, reopenPort } = {}) {
    super();
    this.identifyCard = identifyCard || (() => null);
    // Coordinate serial-port ownership with the PD emulator: the live OSDP
    // subsystem keeps these ports open, so we borrow a port before using it and
    // hand it back afterwards (same mechanism firmware upload uses).
    this.releasePort = releasePort || null;
    this.reopenPort = reopenPort || null;
    this._borrowed = new Map();     // portPath -> baud to restore
    this.port = null;
    this.portPath = null;
    this.baud = 9600;
    this.address = 0;
    this.seq = 0;                 // start at 0 to reset the PD
    this.rxBuf = Buffer.alloc(0);
    this.pollTimer = null;
    this.active = false;
    this.useRTS = false;
    this.needId = true;
    this.needCap = true;
    this.capTries = 0;            // ask for capabilities a few times, then poll regardless
    this.reads = [];              // captured card reads this session
    this.reader = null;           // { model, firmware, capabilities, online }
    this.lastReplyAt = 0;
    this.stats = { polls: 0, replies: 0, cardReads: 0 };
  }

  // Borrow a port from the PD emulator so we can open it as a controller.
  async _borrow(portPath) {
    if (!this.releasePort || this._borrowed.has(portPath)) return;
    try {
      const info = await this.releasePort(portPath);
      if (info && info.wasOwned) {
        this._borrowed.set(portPath, info.baudRate || 9600);
        this.emit('note', { level: 'info', text: `Borrowed ${portPath} from the OSDP emulator for enrollment.` });
      }
    } catch (e) { this.emit('note', { level: 'warn', text: `Couldn't free ${portPath} from the emulator: ${e.message}` }); }
  }
  // Give a borrowed port back to the emulator.
  async _giveBack(portPath) {
    if (!this._borrowed.has(portPath)) return;
    const baud = this._borrowed.get(portPath);
    this._borrowed.delete(portPath);
    if (this.reopenPort) { try { await this.reopenPort(portPath, baud); } catch { /* emulator will retry */ } }
  }
  async _giveBackAll() { for (const p of [...this._borrowed.keys()]) await this._giveBack(p); }

  async listPorts() {
    const all = await SerialPort.list().catch(() => []);
    const usb = all.filter(p => /tty(USB|ACM)/.test(p.path)).map(p => ({
      path: p.path, manufacturer: p.manufacturer || null, serialNumber: p.serialNumber || null, onboard: false,
    }));
    const seen = new Set(usb.map(p => p.path));
    // Add onboard RS-485 UARTs that exist on disk (they don't appear in the USB list).
    const onboard = [];
    for (const path of ONBOARD_PORTS) {
      if (seen.has(path)) continue;
      try { if (fs.existsSync(path)) onboard.push({ path, manufacturer: 'Onboard RS-485', serialNumber: null, onboard: true }); } catch { /* */ }
    }
    // Onboard first so the HAT bus (e.g. ttyAMA0) is easy to pick.
    return [...onboard, ...usb];
  }

  // Try to find a reader by sweeping addresses (and optionally bauds). When
  // useRTS isn't specified we try both direction-control modes, because some
  // USB-RS485 adapters need RTS to key the transmitter and others must not.
  async scan({ port, baud, useRTS } = {}) {
    const bauds = baud ? [baud] : SCAN_BAUDS;
    const rtsModes = (useRTS === undefined || useRTS === null) ? [false, true] : [!!useRTS];
    await this._borrow(port);
    try {
      for (const rts of rtsModes) {
        for (const b of bauds) {
          const sp = await this._open(port, b, rts).catch(() => null);
          if (!sp) continue;
          this.useRTS = rts;                       // _write() reads this to key the RS-485 driver
          for (const addr of SCAN_ADDRS) {
            const reply = await this._probe(sp, addr).catch(() => null);
            if (reply) { await this._close(sp); return { found: true, port, baud: b, address: addr, useRTS: rts, reply }; }
          }
          await this._close(sp);
        }
      }
      return { found: false };
    } finally { await this._giveBack(port); }
  }

  // Deep diagnostic: for the given port (or every detected port), sweep bauds ×
  // RTS modes, send osdp_ID to broadcast + addresses 0..15, and report the RAW
  // evidence — how many bytes came back, a hex sample, and any frames we could
  // pick out (with whether their CRC/checksum validated). This distinguishes
  // "nothing is talking" from "talking but wrong baud / A-B swapped" from
  // "replied but failed CRC / secure channel".
  async diagnose({ port, baud } = {}) {
    if (this.active) throw new Error('Stop the controller first, then run diagnostics.');
    const ports = port ? [port] : (await this.listPorts()).map(p => p.path);
    if (!ports.length) return { ports: [], attempts: [], found: null, verdict: 'No USB serial adapters found. Check that the RS-485 adapter is plugged in.' };
    const bauds = baud ? [baud] : SCAN_BAUDS;
    const attempts = [];
    let found = null;
    for (const pth of ports) {
      await this._borrow(pth);
      try {
        for (const b of bauds) {
          for (const rts of [false, true]) {
            const att = await this._diagOne(pth, b, rts);
            attempts.push(att);
            if (att.reply && !found) found = { port: pth, baud: b, address: att.reply.address, useRTS: rts, reply: att.reply };
          }
          if (found && found.port === pth) break;   // stop scanning bauds on a port once it answered
        }
      } finally { await this._giveBack(pth); }
    }
    // Per-port summary: the most telling class wins (a reader reply first, then
    // the most actionable fault).
    const CLASS_RANK = ['reply', 'low', 'noise', 'echo', 'high', 'idle'];
    const portSummary = ports.map(p => {
      const atts = attempts.filter(a => a.port === p);
      let cls = 'idle';
      for (const c of CLASS_RANK) if (atts.some(a => a.line === c)) { cls = c; break; }
      const withReply = atts.find(a => a.reply);
      return { port: p, class: cls, replies: atts.reduce((s, a) => s + (a.replies || 0), 0), reply: withReply ? withReply.reply : null };
    });
    return { ports, attempts, found, portSummary, verdict: this._verdict(attempts, found, portSummary) };
  }

  async _diagOne(port, baud, rts) {
    const out = { port, baud, useRTS: rts, bytes: 0, hex: '', frames: [], replies: 0, echoed: 0, reply: null, line: null, error: null };
    let sp;
    try { sp = await this._open(port, baud, rts); } catch (e) { out.error = e.message; return out; }
    this.useRTS = rts;
    const chunks = [];
    const onData = (c) => chunks.push(c);
    sp.on('data', onData);
    try {
      // 1) identify sweep — ID to broadcast + addresses 0..15
      for (const a of [0x7F, ...DIAG_ADDRS]) {
        this._write(sp, OSDPPacket.buildPacket({ address: a, command: 0x61, data: Buffer.from([0]), sequence: 0 }));
        await sleep(16);
      }
      // 2) poll sweep — some readers ignore ID but answer POLL, or only speak on a card read
      for (const a of [0x7F, 0, 1, 2, 3, 4, 5, 6, 7]) {
        this._write(sp, OSDPPacket.buildPacket({ address: a, command: 0x60, data: Buffer.alloc(0), sequence: 1 }));
        await sleep(16);
      }
      await sleep(350);   // listen for a late reply or a card read
    } catch (e) { out.error = e.message; }
    sp.removeListener('data', onData);
    await this._close(sp);
    const buf = Buffer.concat(chunks);
    out.bytes = buf.length;
    out.hex = buf.slice(0, 48).toString('hex').toUpperCase().replace(/(..)(?=.)/g, '$1 ');
    const store = { b: Buffer.from(buf) };
    for (const raw of this._frames(store)) {
      const f = decodeFrame(raw);
      out.frames.push({ address: f.address, isReply: !!f.isReply, name: f.name, checkOk: !!f.checkOk });
      if (f.isReply) out.replies++; else out.echoed++;   // replies matter; commands are our own TX echoing back
      if (!out.reply && f.ok && f.isReply) out.reply = { address: f.address, name: f.name, model: f.decoded && f.decoded.model, firmware: f.decoded && f.decoded.firmware };
    }
    out.line = classifyLine(buf, out.replies, out.echoed);
    return out;
  }

  _verdict(attempts, found, portSummary = []) {
    if (found) return `Reader answered at address ${found.address}, ${found.baud.toLocaleString()} baud${found.useRTS ? ' with RTS toggling on' : ''}. Set those and press Start.`;
    const lockErr = attempts.filter(a => a.error && /lock|resource temporarily|ebusy|in use|cannot open/i.test(a.error));
    if (lockErr.length && lockErr.length >= attempts.length) {
      return 'The port could not be opened — another process is holding it. The OSDP emulator/controller normally owns this adapter; the enroller now tries to borrow it automatically, so if you still see this, either that hand-off failed or a system service (ModemManager, brltty) has the port. Try again, use a separate USB-RS485 adapter for enrollment, or stop the process holding it.';
    }
    const badReply = attempts.some(a => a.frames.some(fr => fr.isReply && !fr.checkOk));
    if (badReply) return 'A reply was received but its CRC/checksum did not validate. The reader may be in secure channel (this tool needs it in standard/clear mode), or using unexpected framing.';
    const nm = p => p.replace('/dev/', '');
    const low   = portSummary.filter(s => s.class === 'low').map(s => nm(s.port));
    const noise = portSummary.filter(s => s.class === 'noise').map(s => nm(s.port));
    const quiet = portSummary.filter(s => ['idle', 'high', 'echo'].includes(s.class)).map(s => nm(s.port));
    if (low.length) return `${low.join(', ')} ${low.length > 1 ? 'are' : 'is'} reading a continuous 0x00 (line held low) — the A/B (D+/D−) pair is almost certainly swapped, or the bus has no bias. Swap A and B on ${low.length > 1 ? 'those adapters' : 'that adapter'} and re-run Diagnose.`;
    if (noise.length) return `${noise.join(', ')}: data is arriving but can't be framed as OSDP — wrong baud, or A/B swapped mid-traffic. Swap A/B (or try another baud) and re-run Diagnose.`;
    if (quiet.length) return `${quiet.join(', ')} ${quiet.length > 1 ? 'are' : 'is'} open and idle, but nothing answered ID or POLL. The reader likely only speaks when a card is presented — press Start on it and tap a card. If still nothing, check power (usually 12 V) and A/B.`;
    return 'No usable data came back on any port. Check the adapter, reader power (usually 12 V), and the A/B wiring.';
  }

  // one ID request, wait for a PDID (or any valid reply)
  async _probe(sp, addr) {
    return new Promise((resolve) => {
      let done = false;
      const buf = { b: Buffer.alloc(0) };
      const onData = (chunk) => {
        buf.b = Buffer.concat([buf.b, chunk]);
        for (const raw of this._frames(buf)) {
          const f = decodeFrame(raw);
          if (f.ok && f.isReply && f.address === addr) { finish(f); return; }
        }
      };
      const finish = (f) => { if (done) return; done = true; sp.removeListener('data', onData); resolve(f ? { address: addr, name: f.name, model: f.decoded && f.decoded.model, firmware: f.decoded && f.decoded.firmware } : null); };
      sp.on('data', onData);
      this._write(sp, OSDPPacket.buildPacket({ address: addr, command: 0x61, data: Buffer.from([0]), sequence: 0 }));
      setTimeout(() => finish(null), 250);
    });
  }

  async start({ port, baud = 9600, address = 0, useRTS = false, pollMs = 150 } = {}) {
    if (this.active) throw new Error('Enroller already running; stop it first');
    this.address = address & 0x7F; this.baud = baud; this.useRTS = useRTS;
    this.seq = 0; this.needId = true; this.needCap = true; this.capTries = 0; this.rxBuf = Buffer.alloc(0);
    this.reads = []; this.reader = { online: false }; this.stats = { polls: 0, replies: 0, cardReads: 0 };
    await this._borrow(port);                     // take the port from the emulator first
    try { this.port = await this._open(port, baud, useRTS); }
    catch (e) { await this._giveBack(port); throw e; }
    this.portPath = port;
    this.port.on('data', chunk => this._onData(chunk));
    this.port.on('error', err => this.emit('error', { message: err.message }));
    this.active = true;
    this.pollTimer = setInterval(() => this._tick(), pollMs);
    this.emit('status', this.getStatus());
    return { success: true, port, baud, address: this.address };
  }

  async stop() {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    if (this.port) { await this._close(this.port); this.port = null; }
    this.active = false;
    await this._giveBackAll();                     // return the port to the emulator
    this.emit('status', this.getStatus());
    return { success: true };
  }

  getStatus() {
    return {
      active: this.active, port: this.portPath, baud: this.baud, address: this.address,
      reader: this.reader, online: !!(this.reader && this.reader.online),
      reads: this.reads.length, readsList: this.reads, stats: this.stats,
      lastReplyAgoMs: this.lastReplyAt ? Date.now() - this.lastReplyAt : null,
    };
  }

  clearReads() { this.reads = []; this.emit('reads', this.reads); }

  // ── serial helpers ──
  _open(path, baud, useRTS) {
    return new Promise((resolve, reject) => {
      const sp = new SerialPort({ path, baudRate: baud, dataBits: 8, parity: 'none', stopBits: 1, autoOpen: false });
      // Always keep a baseline 'error' handler so an async serial error (e.g. an
      // adapter or PTY that doesn't support the RTS ioctl) can't crash the
      // process as an unhandled event. start() adds its own on top to surface it.
      sp.on('error', () => {});
      sp.open(err => err ? reject(err) : resolve(sp));
    });
  }
  _close(sp) { return new Promise(r => { if (sp && sp.isOpen) sp.close(() => r()); else r(); }); }
  _write(sp, buf) {
    if (!sp || !sp.isOpen) return;
    if (this.useRTS) { try { sp.set({ rts: true }); } catch {} }
    sp.write(buf, () => sp.drain(() => { if (this.useRTS) setTimeout(() => { try { sp.set({ rts: false }); } catch {} }, 3); }));
  }

  _frames(store) {
    const out = [];
    while (store.b.length >= 6) {
      const som = store.b.indexOf(0x53);
      if (som < 0) { store.b = Buffer.alloc(0); break; }
      if (som > 0) store.b = store.b.slice(som);
      if (store.b.length < 4) break;
      const len = store.b.readUInt16LE(2);
      if (len < 6 || len > 1440) { store.b = store.b.slice(1); continue; }
      if (store.b.length < len) break;
      out.push(store.b.slice(0, len)); store.b = store.b.slice(len);
    }
    return out;
  }

  _nextSeq() { this.seq = this.seq === 0 ? 1 : (this.seq % 3) + 1; return this.seq; }

  _tick() {
    if (!this.active || !this.port || !this.port.isOpen) return;
    let cmd = 0x60, data = Buffer.alloc(0);           // default: POLL
    if (this.needId) { cmd = 0x61; data = Buffer.from([0]); }
    else if (this.needCap && this.capTries < 4) { cmd = 0x62; data = Buffer.from([0]); this.capTries++; }
    else { this.needCap = false; }                    // done learning — poll for cards from here on
    const seq = this._nextSeq();
    this.stats.polls++;
    this._write(this.port, OSDPPacket.buildPacket({ address: this.address, command: cmd, data, sequence: seq }));
  }

  _onData(chunk) {
    const store = { b: Buffer.concat([this.rxBuf, chunk]) };
    const frames = this._frames(store);
    this.rxBuf = store.b;
    for (const raw of frames) this._onFrame(raw);
  }

  _onFrame(raw) {
    const f = decodeFrame(raw, { identifyCard: this.identifyCard });
    if (!f.ok || !f.isReply) return;
    this.stats.replies++;
    this.lastReplyAt = Date.now();
    if (!this.reader.online) { this.reader.online = true; this.emit('status', this.getStatus()); }

    if (f.name === 'osdp_PDID' && f.decoded) {
      this.needId = false;
      this.reader = { ...this.reader, online: true, vendor: f.decoded.vendor, model: f.decoded.model, version: f.decoded.version, serial: f.decoded.serial, firmware: f.decoded.firmware };
      this.emit('reader', this.reader);
    } else if (f.name === 'osdp_PDCAP' && f.decoded) {
      this.needCap = false;
      this.reader = { ...this.reader, capabilities: f.decoded.capabilities };
      this.emit('reader', this.reader);
    } else if (f.name === 'osdp_RAW' && f.decoded && f.decoded.raw) {
      this._card(f.decoded.raw);
    } else if (f.name === 'osdp_FMT' && f.decoded) {
      this.emit('note', { level: 'warn', text: 'Reader sent character-format card data (osdp_FMT), not raw bits. Set the reader to raw/Wiegand pass-through to enroll the bit structure.' });
    } else if (f.name === 'osdp_KEYPAD') {
      this.emit('note', { level: 'info', text: 'Keypad data received (not a card).' });
    } else if (f.name === 'osdp_NAK' && f.decoded && f.decoded.nak === 0x06) {
      this.emit('note', { level: 'crit', text: 'The reader requires a secure channel. This tool enrolls readers in standard (clear) mode only.' });
    }
  }

  _card(raw) {
    this.stats.cardReads++;
    const rec = {
      id: this.reads.length + 1, ts: Date.now(),
      bits: raw.bitCount, binary: raw.binary, format: raw.format, reader: raw.reader,
      match: raw.wieg || null,
    };
    // ignore an exact duplicate of the immediately previous read within 400 ms (reader repeats)
    const prev = this.reads[this.reads.length - 1];
    if (prev && prev.binary === rec.binary && rec.ts - prev.ts < 400) { prev.count = (prev.count || 1) + 1; this.emit('reads', this.reads); return; }
    rec.count = 1;
    this.reads.push(rec);
    this.emit('card', rec);
    this.emit('reads', this.reads);
  }
}

module.exports = { OSDPEnroller, SCAN_ADDRS, SCAN_BAUDS };
