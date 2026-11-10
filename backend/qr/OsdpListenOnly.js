// backend/qr/OsdpListenOnly.js — listen-only OSDP tap (AETHER_QR_CREDENTIALS)
//
// For a QR reader that stays wired to the panel: a second RS-485 adapter's A/B
// go onto the same pair, and this class only ever READS. It never writes a
// byte (the existing sniffer sends polls, which would collide with the panel).
// Every reader reply that carries card data (osdp_RAW, osdp_FMT) is emitted as
// a 'read'. Frame counts help tell a wrong baud from a quiet bus.
'use strict';

const EventEmitter = require('events');
const { SerialPort } = require('serialport');
const { decodeFrame } = require('../osdp/trace/osdpDecoder');

class OsdpListenOnly extends EventEmitter {
  constructor({ releasePort, reopenPort } = {}) {
    super();
    this.releasePort = releasePort || null;
    this.reopenPort = reopenPort || null;
    this.port = null; this.portPath = null; this.baud = 9600;
    this.borrowed = null;
    this.buf = Buffer.alloc(0);
    this.stats = this._fresh();
    this.last = null;
  }

  _fresh() { return { bytes: 0, frames: 0, badFrames: 0, commands: 0, replies: 0, cardReads: 0, lastFrameAt: null }; }

  get active() { return !!(this.port && this.port.isOpen); }

  status() {
    return { active: this.active, port: this.portPath, baud: this.baud, stats: this.stats,
      quietMs: this.stats.lastFrameAt ? Date.now() - this.stats.lastFrameAt : null };
  }

  async start({ port, baud = 9600 } = {}) {
    if (!port) throw new Error('Pick the RS-485 adapter that is on the reader-to-panel wires.');
    if (this.active) await this.stop();
    this.baud = Number(baud) || 9600;
    if (this.releasePort) {
      try {
        const info = await this.releasePort(port);
        if (info && info.wasOwned) this.borrowed = { port, baud: info.baudRate || 9600 };
      } catch { /* not the emulator's port */ }
    }
    const sp = new SerialPort({ path: port, baudRate: this.baud, dataBits: 8, parity: 'none', stopBits: 1, autoOpen: false });
    sp.on('error', e => this.emit('error', { message: e.message }));
    try { await new Promise((res, rej) => sp.open(err => err ? rej(err) : res())); }
    catch (e) { await this._giveBack(); throw new Error(`Couldn't open ${port}: ${e.message}`); }
    try { sp.set({ rts: false, dtr: false }); } catch { /* not all adapters */ }
    this.port = sp; this.portPath = port; this.buf = Buffer.alloc(0); this.stats = this._fresh();
    sp.on('data', chunk => this._onData(chunk));
    sp.on('close', () => this.emit('status', this.status()));
    this.emit('status', this.status());
    return this.status();
  }

  async stop() {
    const sp = this.port; this.port = null;
    if (sp && sp.isOpen) await new Promise(r => sp.close(() => r()));
    await this._giveBack();
    this.emit('status', this.status());
    return this.status();
  }

  async _giveBack() {
    const b = this.borrowed; this.borrowed = null;
    if (b && this.reopenPort) { try { await this.reopenPort(b.port, b.baud); } catch { /* emulator retries */ } }
  }

  _onData(chunk) {
    this.stats.bytes += chunk.length;
    this.buf = Buffer.concat([this.buf, chunk]);
    if (this.buf.length > 8192) this.buf = this.buf.subarray(this.buf.length - 4096);
    while (this.buf.length >= 6) {
      const som = this.buf.indexOf(0x53);
      if (som < 0) { this.buf = Buffer.alloc(0); break; }
      if (som > 0) this.buf = this.buf.subarray(som);
      if (this.buf.length < 4) break;
      const len = this.buf.readUInt16LE(2);
      if (len < 6 || len > 1440) { this.buf = this.buf.subarray(1); continue; }
      if (this.buf.length < len) break;
      const raw = this.buf.subarray(0, len);
      let f;
      try { f = decodeFrame(Buffer.from(raw)); } catch { f = null; }
      if (!f || !f.ok) { this.stats.badFrames++; this.buf = this.buf.subarray(1); continue; }
      this.buf = this.buf.subarray(len);
      this._onFrame(f);
    }
  }

  _onFrame(f) {
    this.stats.frames++; this.stats.lastFrameAt = Date.now();
    if (!f.isReply) { this.stats.commands++; return; }
    this.stats.replies++;
    let read = null;
    if (f.name === 'osdp_RAW' && f.decoded && f.decoded.raw) {
      const r = f.decoded.raw;
      read = { address: f.address, osdpFormat: r.format, bitCount: r.bitCount, binary: r.binary };
    } else if (f.name === 'osdp_FMT' && f.decoded) {
      read = { address: f.address, text: f.decoded.fmt };
    }
    if (!read) return;
    // A panel that NAKs a reply makes the reader send the same frame again.
    const key = read.binary || read.text;
    if (this.last && this.last.key === key && Date.now() - this.last.at < 800) return;
    this.last = { key, at: Date.now() };
    this.stats.cardReads++;
    this.emit('read', read);
  }
}

module.exports = { OsdpListenOnly };
