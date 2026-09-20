// osdp/OSDPSniffer.js — Pi-as-ACU + tap-mode (piggyback on OSDPManager port).
const EventEmitter = require('events');
const { SerialPort } = require('serialport');

function crc16(buf) {
  let crc = 0x1D0F;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i] << 8;
    for (let j = 0; j < 8; j++) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
    }
  }
  return crc & 0xFFFF;
}

const CMD_NAMES = {
  0x40:'ACK', 0x41:'NAK', 0x45:'PDID', 0x46:'PDCAP',
  0x48:'LSTATR', 0x49:'ISTATR', 0x4A:'OSTATR', 0x4B:'RSTATR',
  0x50:'RAW', 0x53:'KEYPAD', 0x69:'LED', 0x6A:'BUZ',
  0x60:'POLL', 0x61:'ID', 0x62:'CAP', 0x76:'CCRYPT', 0x78:'RMAC_I'
};

const LED_COLOR = {0:'off',1:'red',2:'green',3:'amber',4:'blue',5:'magenta',6:'cyan',7:'white'};
const NAK_ERR = {0x00:'No error',0x01:'Message/CRC error',0x02:'Command length error',
  0x03:'Unknown/unsupported command',0x04:'Unexpected sequence',0x05:'Security block error',
  0x06:'Comm security not met',0x07:'BIO type unsupported',0x08:'BIO format unsupported',
  0x09:'Unable to process command record'};

function decodeLED(d) {
  const recs = [];
  for (let o = 0; o + 14 <= d.length; o += 14) {
    const r = d.slice(o, o + 14), tempCtl = r[2], permCtl = r[9];
    const use = permCtl === 1 ? 'permanent' : tempCtl === 2 ? 'temporary'
              : tempCtl === 1 ? 'cancel-temp' : 'nop';
    let on, off, onC, offC;
    if (permCtl === 1) { on = r[10]; off = r[11]; onC = r[12]; offC = r[13]; }
    else               { on = r[3];  off = r[4];  onC = r[5];  offC = r[6];  }
    const cn = c => LED_COLOR[c] || ('0x' + c.toString(16));
    let g;
    if (use === 'cancel-temp') g = `LED ${r[1]} cancel temp, revert to permanent`;
    else if (use === 'nop')    g = `LED ${r[1]} no-op`;
    else if (onC === offC)     g = `LED ${r[1]} steady ${cn(onC)} (${use})`;
    else g = `LED ${r[1]} blink ${cn(onC)}/${cn(offC)} ${on*100}/${off*100}ms (${use})`;
    recs.push({ reader: r[0], led: r[1], use, onColor: cn(onC), offColor: cn(offC),
                onMs: on*100, offMs: off*100, gloss: g });
  }
  return recs;
}
function decodeBUZ(d) {
  if (d.length < 5) return { gloss: 'BUZ (truncated)' };
  const tone = d[1] === 0 ? 'no-op' : d[1] === 1 ? 'off'
             : d[1] === 2 ? 'default' : ('tone 0x' + d[1].toString(16));
  return { reader: d[0], tone, onMs: d[2]*100, offMs: d[3]*100, count: d[4],
           gloss: `beep ${tone} ${d[2]*100}/${d[3]*100}ms \u00d7${d[4]}` };
}
function wiegand26(d) {
  const card = d.slice(4), bits = [];
  for (let i = 0; i < card.length; i++)
    for (let b = 7; b >= 0; b--) bits.push((card[i] >> b) & 1);
  if (bits.length < 26) return null;
  const x = bits.slice(0, 26);
  const fc = parseInt(x.slice(1, 9).join(''), 2);
  const cn = parseInt(x.slice(9, 25).join(''), 2);
  const eOK = ((x.slice(1,13).reduce((a,v)=>a+v,0) + x[0]) % 2) === 0;
  const oOK = ((x.slice(13,25).reduce((a,v)=>a+v,0) + x[25]) % 2) === 1;
  return { facility: fc, card: cn, parityOK: eOK && oOK };
}
function glossFor(cmd, isReply, d) {
  switch (cmd) {
    case 0x60: return isReply ? '' : 'controller polling reader (keep-alive)';
    case 0x40: return 'reader ACK, nothing pending';
    case 0x41: return 'NAK - ' + (NAK_ERR[d[0]] || ('error 0x' + (d[0]||0).toString(16)));
    case 0x69: { const r = decodeLED(d); return r.length ? r.map(x=>x.gloss).join('  |  ') : 'LED (no record)'; }
    case 0x6A: return decodeBUZ(d).gloss;
    case 0x50: {
      if (d.length < 4) return 'raw card (truncated)';
      const n = d[2] | (d[3] << 8); let e = '';
      if (n === 26) { const w = wiegand26(d); if (w) e = ` -> H10301 facility ${w.facility}, card ${w.card} (parity ${w.parityOK?'OK':'FAIL'})`; }
      return `raw card read - ${n} bits, format 0x${d[1].toString(16)}${e}`;
    }
    case 0x53: return 'keypad entry' + (d.length > 2 ? ': ' + Array.from(d.slice(2)).join('') : '');
    case 0x61: return 'request reader ID';
    case 0x62: return 'request reader capabilities';
    case 0x45: return 'reader ID report';
    case 0x46: return 'reader capability report';
    case 0x76: return isReply ? 'reader crypto response (CCRYPT)' : 'secure channel challenge';
    case 0x78: return 'reply MAC (RMAC_I)';
    default:   return '';
  }
}

class OSDPSniffer extends EventEmitter {
  constructor(opts = {}) {
    super();
    // Lazy lookup so timing doesn't matter (osdpManager may init after sniffer)
    this.getOpenPorts = opts.getOpenPorts || (() => new Map());

    this.active = false;
    this.tapMode = false;
    this.portPath = null;

    // Open-mode state (we own the port)
    this.port = null;

    // Tap-mode state (we borrow OSDPManager's port)
    this.tapPort = null;
    this.tapHandler = null;

    this.baud = 9600;
    this.address = 0;
    this.pollMs = 100;
    this.seq = 1;
    this.pollTimer = null;
    this.rxBuf = Buffer.alloc(0);
    this.stats = { polls: 0, framesRx: 0, errors: 0, lastFrame: null };
  }

  async listPorts() {
    const all = await SerialPort.list();
    const openPorts = this.getOpenPorts();
    return all
      .filter(p => /tty(USB|ACM|AMA)/.test(p.path))
      .map(p => ({
        path: p.path,
        manufacturer: p.manufacturer || null,
        serialNumber: p.serialNumber || null,
        tappable: openPorts.has(p.path),  // true = OSDPManager has it open
        reserved: false                    // we never block — kernel decides
      }));
  }

  buildPoll(addr) {
    const pkt = Buffer.alloc(8);
    pkt[0] = 0x53;
    pkt[1] = addr & 0x7F;
    pkt[2] = 8; pkt[3] = 0;
    pkt[4] = 0x04 | (this.seq & 0x03);
    pkt[5] = 0x60;
    const c = crc16(pkt.slice(0, 6));
    pkt[6] = c & 0xFF; pkt[7] = (c >> 8) & 0xFF;
    this.seq = (this.seq % 3) + 1;
    return pkt;
  }

  async start({ port, baud = 9600, address = 0, pollMs = 100 }) {
    if (this.active) throw new Error('Sniffer already running; stop it first');

    this.address = address & 0x7F;
    this.pollMs = pollMs;
    this.baud = baud;
    this.seq = 1;
    this.rxBuf = Buffer.alloc(0);
    this.stats = { polls: 0, framesRx: 0, errors: 0, lastFrame: null };

    const openPorts = this.getOpenPorts();
    if (openPorts.has(port)) {
      return this._startTap(port, openPorts.get(port));
    }
    return this._startOpen(port);
  }

  async _startTap(portPath, existingPort) {
    this.portPath = portPath;
    this.tapMode = true;
    this.tapPort = existingPort;

    // Attach as ADDITIONAL data listener — does not interfere with OSDPManager
    this.tapHandler = (chunk) => this._onRx(chunk);
    existingPort.on('data', this.tapHandler);

    // Also send polls via the shared port handle so passive PDs respond
    this.pollTimer = setInterval(() => this._sendPollVia(existingPort), this.pollMs);

    this.active = true;
    this.emit('started', { port: portPath, mode: 'tap', address: this.address, pollMs: this.pollMs });
    return { success: true, port: portPath, mode: 'tap', address: this.address, pollMs: this.pollMs };
  }

  async _startOpen(portPath) {
    this.portPath = portPath;
    this.tapMode = false;

    this.port = new SerialPort({
      path: portPath, baudRate: this.baud, dataBits: 8, parity: 'none', stopBits: 1, autoOpen: false
    });
    await new Promise((resolve, reject) => this.port.open(err => err ? reject(err) : resolve()));

    this.port.on('data', chunk => this._onRx(chunk));
    this.port.on('error', err => { this.stats.errors++; this.emit('error', { message: err.message }); });

    this.pollTimer = setInterval(() => this._sendPollOwn(), this.pollMs);
    this.active = true;
    this.emit('started', { port: portPath, mode: 'open', baud: this.baud, address: this.address, pollMs: this.pollMs });
    return { success: true, port: portPath, mode: 'open', baud: this.baud, address: this.address, pollMs: this.pollMs };
  }

  async stop() {
    if (!this.active) return { success: true, alreadyStopped: true };
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }

    if (this.tapMode) {
      if (this.tapPort && this.tapHandler) {
        try { this.tapPort.removeListener('data', this.tapHandler); } catch (e) {}
      }
      this.tapPort = null; this.tapHandler = null; this.tapMode = false;
    } else {
      if (this.port && this.port.isOpen) {
        await new Promise(r => this.port.close(r));
      }
      this.port = null;
    }

    this.active = false;
    this.emit('stopped');
    return { success: true };
  }

  getStatus() {
    return {
      active: this.active,
      mode: this.tapMode ? 'tap' : (this.active ? 'open' : null),
      port: this.portPath, baud: this.baud,
      address: this.address, pollMs: this.pollMs,
      stats: this.stats
    };
  }

  _sendPollOwn() {
    if (!this.active || this.tapMode || !this.port || !this.port.isOpen) return;
    const poll = this.buildPoll(this.address);
    this.port.set({ rts: true }, () => {
      this.port.write(poll, () => {
        this.port.drain(() => {
          this.stats.polls++;
          setTimeout(() => this.port && this.port.set({ rts: false }, () => {}), 4);
        });
      });
    });
  }

  _sendPollVia(port) {
    if (!this.active || !port || !port.isOpen) return;
    const poll = this.buildPoll(this.address);
    port.write(poll, (err) => {
      if (err) { this.stats.errors++; return; }
      this.stats.polls++;
    });
  }

  _onRx(chunk) {
    this.rxBuf = Buffer.concat([this.rxBuf, chunk]);
    while (this.rxBuf.length >= 6) {
      const start = this.rxBuf.indexOf(0x53);
      if (start < 0) { this.rxBuf = Buffer.alloc(0); return; }
      if (start > 0) this.rxBuf = this.rxBuf.slice(start);
      if (this.rxBuf.length < 4) return;
      const len = this.rxBuf.readUInt16LE(2);
      if (len < 6 || len > 256) { this.rxBuf = this.rxBuf.slice(1); continue; }
      if (this.rxBuf.length < len) return;
      const frame = this.rxBuf.slice(0, len);
      this.rxBuf = this.rxBuf.slice(len);
      this._parseFrame(frame);
    }
  }

  _parseFrame(frame) {
    const addr = frame[1] & 0x7F;
    const isReply = (frame[1] & 0x80) !== 0;
    const ctrl = frame[4];
    const cmd = frame[5];
    const data = frame.slice(6, frame.length - 2);
    const cmdName = CMD_NAMES[cmd] || ('0x' + cmd.toString(16).padStart(2,'0').toUpperCase());

    let decoded = null;
    if (cmd === 0x69)      decoded = { led: decodeLED(data) };
    else if (cmd === 0x6A) decoded = decodeBUZ(data);
    else if (cmd === 0x50 && data.length >= 4) {
      decoded = { readerNumber: data[0], formatCode: data[1],
        bitCount: data[2] | (data[3] << 8),
        cardBytes: data.slice(4).toString('hex').toUpperCase() };
      if (decoded.bitCount === 26) Object.assign(decoded, { wiegand: wiegand26(data) });
    }
    else if (cmd === 0x53 && data.length >= 3) {
      decoded = { readerNumber: data[0], keyCount: data[1],
        keys: Array.from(data.slice(2, 2 + data[1])).map(b => '0x' + b.toString(16).padStart(2,'0').toUpperCase()) };
    }
    else if (cmd === 0x41 && data.length) {
      decoded = { errorCode: '0x' + data[0].toString(16), error: NAK_ERR[data[0]] || 'unknown' };
    }

    const gloss = glossFor(cmd, isReply, data);

    const event = {
      ts: new Date().toISOString(), address: addr, isReply,
      sequence: ctrl & 0x03,
      cmd: '0x' + cmd.toString(16).padStart(2,'0').toUpperCase(),
      cmdName, length: frame.length,
      gloss,
      dataHex: data.toString('hex').toUpperCase(),
      fullHex: frame.toString('hex').toUpperCase(),
      decoded
    };
    this.stats.framesRx++; this.stats.lastFrame = event.ts;
    this.emit('frame', event);
  }
}

module.exports = OSDPSniffer;
