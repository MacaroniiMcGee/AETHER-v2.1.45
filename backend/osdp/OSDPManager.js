// OSDPManager.js - Enhanced OSDP Protocol Manager
// FIXED VERSION - Correct routing by address + port + CMAC-I for KEYSET
// FIXED: Session keys now use port:address to prevent cross-reader corruption
// Support for dual address simulation (00 & 01) from one dongle
// Expanded format support with custom format persistence
// Secure Channel support with CBC-MAC

const { exec } = require('child_process');
const EventEmitter = require('events');
const fs = require('fs').promises;
const path = require('path');
const { SerialPort } = require('serialport');
const formatService = require('../lib/formatService');

// --- Format resolution (built-ins + custom) ---
const BUILTIN_FORMAT_BITS = {
  'wiegand26': 26, 'wiegand30': 30, 'wiegand32': 32, 'wiegand34': 34,
  'wiegand35': 35, 'wiegand37': 37, 'wiegand40': 40, 'wiegand48': 48,
  'wiegand56': 56, 'wiegand64': 64,
  'w26': 26, 'w30': 30, 'w32': 32, 'w34': 34, 'w35': 35, 'w37': 37,
  'w40': 40, 'w48': 48, 'w56': 56, 'w64': 64,
  'hid-h10301': 26, 'hid-h10304': 34, 'hid-h10302': 37,
  'hid-corp1000-35': 35, 'hid-corp1000-48': 48,
  'raw32': 32, 'raw36': 36, 'raw37': 37,
};

class OSDPManager extends EventEmitter {
  constructor() {
    super();

    this.configPath = path.join(__dirname, 'osdp-config.json');
    this.customFormatsPath = path.join(__dirname, 'custom-formats.json');
    
    this.config = {
      enabled: true,
      serialPorts: [
        { port: '/dev/ttyACM0', baudRate: 9600 },
        { port: '/dev/ttyACM1', baudRate: 9600 }
      ],
      readers: [
        { 
          id: 'osdp-reader-1', 
          name: 'OSDP Reader 1', 
          address: 0x00, 
          enabled: true, 
          secureChannel: false, 
          capabilities: ['LED','BUZZER','CARD','KEYPAD'],
          serialPort: '/dev/ttyACM0'
        },
        { 
          id: 'osdp-reader-2', 
          name: 'OSDP Reader 2', 
          address: 0x01, 
          enabled: true, 
          secureChannel: false, 
          capabilities: ['LED','BUZZER','CARD','KEYPAD'],
          serialPort: '/dev/ttyACM0'
        }
      ]
    };

    this.customFormats = [];
    this.readers = new Map();
    this.serialPorts = new Map();
    this.secureChannelSessions = new Map();
    this.initialized = false;
    this.stats = { messagesSent: 0, messagesReceived: 0, errors: 0, lastActivity: null };
    this.pendingResponses = new Map();
    this.portStats = new Map();
  }

  // Wire-frame tap — emits structured frame info for passive trace UI
  _emitLedEvent(reader, opts) {
    const defaultLayer = (cn) => ({ controlName: cn, onColor: 'off', offColor: 'off', onTimeMs: 0, offTimeMs: 0 });
    this.emit('led_command', {
      readerId: reader.id,
      address: reader.address,
      readerName: reader.name,
      timestamp: Date.now(),
      temporary: { ...defaultLayer('nop'), timerMs: 0, ...(opts.temporary || {}) },
      permanent: { ...defaultLayer('nop'), ...(opts.permanent || {}) },
    });
  }

  _emitBuzzerEvent(reader, opts) {
    this.emit('buzzer_command', {
      readerId: reader.id,
      address: reader.address,
      readerName: reader.name,
      timestamp: Date.now(),
      toneName: opts.toneName || 'default',
      onTimeMs: opts.onTimeMs || 100,
      offTimeMs: opts.offTimeMs || 0,
      repeatCount: opts.repeatCount || 1,
    });
  }

  _colorName(code) {
    return ['off', 'red', 'green', 'amber', 'blue', 'magenta', 'cyan', 'white'][code] || 'off';
  }

  _emitWireFrame(direction, portPath, buffer) {
    try {
      const hex = buffer.toString('hex').toUpperCase();
      let address = null, command = null, isReply = false, sequence = 0;
      // Find SOM (0x53), skipping optional FF preamble bytes
      let somIdx = -1;
      for (let i = 0; i < Math.min(buffer.length, 8); i++) {
        if (buffer[i] === 0x53) { somIdx = i; break; }
      }
      if (somIdx >= 0 && buffer.length >= somIdx + 5) {
        address = buffer[somIdx + 1] & 0x7F;
        isReply = (buffer[somIdx + 1] & 0x80) !== 0;
        const ctrl = buffer[somIdx + 4];
        sequence = ctrl & 0x03;
        if (buffer.length >= somIdx + 6) command = buffer[somIdx + 5];
      }
      // --- decoded trace file (dev-team comparison log) ---
      try {
        const _af = process.env.OSDP_TRACE_ADDR;
        const _cf = process.env.OSDP_TRACE_CMD;
        const _ao = !_af || _af.split(',').some(a => parseInt(a) === address);
        const _co = !_cf || _cf.split(',').some(c => parseInt(c, 16) === command);
        const _traceOn = process.env.OSDP_TRACE === '1' || _af || _cf;
        if (_traceOn && _ao && _co) {
          const _d = (command === null || command === undefined) ? Buffer.alloc(0)
            : buffer.slice((buffer.indexOf(0x53) >= 0 ? buffer.indexOf(0x53) : 0) + 6, buffer.length - 2);
          const _COL = {0:'off',1:'red',2:'green',3:'amber',4:'blue',5:'magenta',6:'cyan',7:'white'};
          const _NAK = {0:'No error',1:'Msg/CRC error',2:'Cmd length error',3:'Unknown command',
            4:'Unexpected sequence',5:'Security block error',6:'Comm security not met',9:'Cannot process record'};
          const _OUT = {0:'no change',1:'perm OFF',2:'perm ON',3:'OFF timed',4:'ON timed',5:'temp ON',6:'temp OFF'};
          const _cn = c => _COL[c] || ('0x' + (c||0).toString(16));
          let _g = '';
          try {
            if (command === 0x69) {
              const r = [];
              for (let o = 0; o + 14 <= _d.length; o += 14) {
                const x = _d.slice(o, o + 14), pc = x[9], tc = x[2];
                const use = pc === 1 ? 'permanent' : tc === 2 ? 'temporary' : tc === 1 ? 'cancel-temp' : 'nop';
                let on, off, oc, fc;
                if (pc === 1) { on = x[10]; off = x[11]; oc = x[12]; fc = x[13]; }
                else { on = x[3]; off = x[4]; oc = x[5]; fc = x[6]; }
                if (use === 'cancel-temp') r.push('LED ' + x[1] + ' cancel temp -> permanent');
                else if (use === 'nop') r.push('LED ' + x[1] + ' no-op');
                else if (oc === fc || off === 0 || on === 0) {
                  // off-time 0 => the "off" phase never runs; the LED is solid.
                  // on-time 0 => solid in the off-colour. Either way it is not a blink.
                  const _sc = (on === 0) ? fc : oc;
                  r.push('LED ' + x[1] + ' steady ' + _cn(_sc) + ' (' + use + ')');
                }
                else r.push('LED ' + x[1] + ' blink ' + _cn(oc) + '/' + _cn(fc) + ' ' + on*100 + '/' + off*100 + 'ms (' + use + ')');
              }
              _g = r.join(' | ') || 'LED (no record)';
            } else if (command === 0x6A) {
              _g = _d.length >= 5 ? ('beep ' + (_d[1]===0?'no-op':_d[1]===1?'off':_d[1]===2?'default':'tone0x'+_d[1].toString(16)) +
                ' ' + _d[2]*100 + '/' + _d[3]*100 + 'ms x' + _d[4]) : 'BUZ (truncated)';
            } else if (command === 0x68) {
              _g = _d.length >= 2 ? ('output ' + _d[0] + ' -> ' + (_OUT[_d[1]] || 'code 0x'+_d[1].toString(16))) : 'output (truncated)';
            } else if (command === 0x50) {
              if (_d.length >= 4) {
                const n = _d[2] | (_d[3] << 8); let e = '';
                if (n === 26) {
                  const c = _d.slice(4), b = [];
                  for (let i = 0; i < c.length; i++) for (let k = 7; k >= 0; k--) b.push((c[i]>>k)&1);
                  if (b.length >= 26) { const X = b.slice(0,26);
                    const fc = parseInt(X.slice(1,9).join(''),2), cd = parseInt(X.slice(9,25).join(''),2);
                    e = ' -> H10301 facility ' + fc + ' card ' + cd; }
                }
                _g = 'card read ' + n + '-bit, fmt 0x' + (_d[1]||0).toString(16) + e;
              } else _g = 'card (truncated)';
            } else if (command === 0x41) {
              _g = 'NAK - ' + (_NAK[_d[0]] || 'error 0x' + (_d[0]||0).toString(16));
            } else if (command === 0x60) { _g = isReply ? '' : 'poll (keep-alive)'; }
            else if (command === 0x40) { _g = 'ACK, nothing pending'; }
            else if (command === 0x61) { _g = 'request reader ID'; }
            else if (command === 0x62) { _g = 'request capabilities'; }
            else if (command === 0x45) { _g = 'reader ID report'; }
            else if (command === 0x46) { _g = 'capability report'; }
            else if (command === 0x76) { _g = isReply ? 'crypto response (CCRYPT)' : 'secure channel challenge'; }
            else if (command === 0x77) { _g = 'server cryptogram (SCRYPT)'; }
            else if (command === 0x75) { _g = 'set encryption key (KEYSET)'; }
            else if (command === 0x80 || command === 0x7B) { _g = 'manufacturer-specific (vendor payload, not decodable)'; }
            else { _g = this._cmdName(command, isReply); }
          } catch (_) { _g = ''; }

          const _fs = require('fs'); const _p = require('path');
          const _dir = _p.join(__dirname, 'logs');
          if (!this._traceDirOk) { try { _fs.mkdirSync(_dir, { recursive: true }); } catch (_) {} this._traceDirOk = true; }
          const _day = new Date().toISOString().slice(0, 10);
          const _lbl = process.env.OSDP_TRACE_LABEL || '';
          if (this._traceSeq === undefined) this._traceSeq = 0;
          const _n = ++this._traceSeq;
          const _ts = new Date().toISOString();
          const _dir2 = (direction === 'tx' ? 'TX' : 'RX');
          const _ah = '0x' + (address == null ? '--' : address.toString(16).padStart(2, '0'));
          const _ch = '0x' + (command == null ? '--' : command.toString(16).padStart(2, '0').toUpperCase());
          const _nm = this._cmdName(command, isReply);

          const _line = '#' + String(_n).padStart(6, '0') + ' ' + _ts + ' ' + _dir2 +
            ' ' + portPath + ' addr=' + _ah + ' seq=' + sequence +
            (_lbl ? ' [' + _lbl + ']' : '') + ' ' + _nm + ' (' + _ch + ')  ' +
            (_g ? _g : '(no decode)') + '  | ' + hex + '\n';
          _fs.appendFileSync(_p.join(_dir, 'osdp-trace-' + _day + '.log'), _line);

          const _q = s => '"' + String(s).replace(/"/g, '""') + '"';
          const _csvF = _p.join(_dir, 'osdp-trace-' + _day + '.csv');
          if (!this._csvHdr) {
            try { if (!_fs.existsSync(_csvF)) _fs.writeFileSync(_csvF,
              'Seq,Timestamp,Dir,Port,Address,OSDPSeq,Controller,Command,CmdCode,Decode,Hex\n'); } catch (_) {}
            this._csvHdr = true;
          }
          _fs.appendFileSync(_csvF, [_n, _ts, _dir2, portPath, _ah, sequence, _lbl, _nm, _ch, _g, hex]
            .map(_q).join(',') + '\n');
        }
      } catch (_) { /* trace file must never break I/O */ }
      this.emit('wire-frame', {
        ts: new Date().toISOString(),
        direction, portPath, address, isReply, sequence,
        cmd: command, cmdName: this._cmdName(command, isReply),
        length: buffer.length, dataHex: hex, fullHex: hex,
      });
    } catch (e) { /* never let trace tap break the I/O path */ }
  }

  _cmdName(cmd, isReply) {
    if (cmd === null || cmd === undefined) return 'UNK';
    const TX = { 0x60:'POLL', 0x61:'ID', 0x62:'CAP', 0x63:'DIAG', 0x64:'LSTAT',
      0x65:'ISTAT', 0x66:'OSTAT', 0x67:'RSTAT', 0x68:'OUT', 0x69:'LED', 0x6A:'BUZ',
      0x6B:'TEXT', 0x6E:'COMSET', 0x6F:'0x6F',
      0x75:'KEYSET', 0x76:'CHLNG', 0x77:'SCRYPT' };
    const RX = { 0x40:'ACK', 0x41:'NAK', 0x45:'PDID', 0x46:'PDCAP', 0x48:'LSTATR',
      0x49:'ISTATR', 0x4A:'OSTATR', 0x4B:'RSTATR', 0x50:'RAW', 0x53:'KEYPAD',
      0x76:'CCRYPT', 0x78:'RMAC_I' };
    return (isReply ? RX[cmd] : TX[cmd]) || ('0x' + cmd.toString(16).toUpperCase());
  }

  // Generate unique session key from port + address
  // This prevents session state corruption when multiple readers share the same address on different ports
  _sessionKey(portOrReader, address) {
    if (typeof portOrReader === 'object') {
      // Called with reader object
      return (portOrReader.serialPort || '/dev/ttyACM0') + ':' + portOrReader.address;
    }
    // Called with port string and address number
    return portOrReader + ':' + address;
  }

  async initialize() {
    console.log('[OSDP] Initializing Enhanced OSDP Manager...');
    try {
      await this.loadConfig();
      await this.loadCustomFormats();
      await this.checkHardware();
      this.setupReaders();
      await this.initializeSerialPorts();
      this.initialized = true;
      console.log('[OSDP] ✓ Manager initialized successfully');
      console.log(`[OSDP] Serial: ${this.config.serialPort || '/dev/ttyACM0'} @ ${this.config.baudRate || 9600} baud`);
      console.log(`[OSDP] Readers: ${this.readers.size} configured`);
      console.log(`[OSDP] Custom formats loaded: ${this.customFormats.length}`);
      return true;
    } catch (err) {
      console.error('[OSDP] ✗ Initialization failed:', err.message);
      this.initialized = false;
      throw err;
    }
  }

  async loadConfig() {
    try {
      const data = await fs.readFile(this.configPath, 'utf8');
      const loaded = JSON.parse(data);
      this.config = { ...this.config, ...loaded };
      console.log('[OSDP] Configuration loaded from disk');
    } catch (err) {
      if (err.code === 'ENOENT') {
        console.log('[OSDP] No config file found, using defaults');
        await this.saveConfig();
      } else {
        console.error('[OSDP] Error loading config:', err.message);
      }
    }
  }

  async saveConfig() {
    try {
      const dir = path.dirname(this.configPath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(this.configPath, JSON.stringify(this.config, null, 2));
      console.log('[OSDP] Configuration saved to disk');
    } catch (err) {
      console.error('[OSDP] Error saving config:', err.message);
    }
  }

  async loadCustomFormats() {
    try {
      const data = await fs.readFile(this.customFormatsPath, 'utf8');
      this.customFormats = JSON.parse(data);
      console.log(`[OSDP] Loaded ${this.customFormats.length} custom formats`);
    } catch (err) {
      if (err.code === 'ENOENT') {
        console.log('[OSDP] No custom formats file found, starting with empty list');
        this.customFormats = [];
        await this.saveCustomFormats();
      } else {
        console.error('[OSDP] Error loading custom formats:', err.message);
        this.customFormats = [];
      }
    }
  }

  async saveCustomFormats() {
    try {
      const dir = path.dirname(this.customFormatsPath);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(this.customFormatsPath, JSON.stringify(this.customFormats, null, 2));
      console.log('[OSDP] Custom formats saved to disk');
    } catch (err) {
      console.error('[OSDP] Error saving custom formats:', err.message);
    }
  }

  async addCustomFormat(format) {
    const newFormat = {
      id: format.id || `custom-${Date.now()}`,
      name: format.name,
      bitCount: format.bitCount,
      facilityBits: format.facilityBits || 0,
      cardBits: format.cardBits || 0,
      parityType: format.parityType || 'none',
      description: format.description || '',
      createdAt: new Date().toISOString()
    };

    const existingIndex = this.customFormats.findIndex(f => f.name.toLowerCase() === newFormat.name.toLowerCase());
    if (existingIndex >= 0) {
      this.customFormats[existingIndex] = newFormat;
    } else {
      this.customFormats.push(newFormat);
    }

    await this.saveCustomFormats();
    console.log(`[OSDP] Custom format added/updated: ${newFormat.name}`);
    return newFormat;
  }

  async deleteCustomFormat(formatId) {
    const index = this.customFormats.findIndex(f => f.id === formatId);
    if (index >= 0) {
      const deleted = this.customFormats.splice(index, 1)[0];
      await this.saveCustomFormats();
      console.log(`[OSDP] Custom format deleted: ${deleted.name}`);
      return { success: true, deleted };
    }
    throw new Error(`Custom format ${formatId} not found`);
  }

  getCustomFormats() {
    return this.customFormats;
  }

  async checkHardware() {
    const portToCheck = this.config.serialPort || '/dev/ttyACM0';
    try {
      await fs.access(portToCheck);
      console.log(`[OSDP] ✓ Serial port ${portToCheck} detected`);
    } catch {
      console.warn(`[OSDP] ⚠ Serial port ${portToCheck} not found`);
      console.warn('[OSDP] RS485 communication will be simulated');
    }
  }

  handleIncomingData(data, portPath = '/dev/ttyACM0') {
    if (this.debugWire) {
    console.log('[OSDP-DEBUG] RAW DATA RECEIVED:', data.length, 'bytes');
    console.log('[OSDP-DEBUG] HEX:', data.toString('hex').toUpperCase()); 
    const hex = data.toString('hex').toUpperCase();
    console.log(`[OSDP] <<<< RX (${portPath}):`, hex);
    }
    this._emitWireFrame('rx', portPath, data);
    
    this._trackRx(portPath);

    try {
      const OSDPPacket = require('./OSDPPacket');

      let start = -1;
      for (let i = 0; i < data.length; i++) { 
        if (data[i] === 0x53) { start = i; break; } 
      }
      if (start < 0) return;

      let idx = start;
      while (idx < data.length) {
        while (idx < data.length && data[idx] !== 0x53) idx++;
        if (idx >= data.length) break;
        const slice = data.slice(idx);
        const packet = OSDPPacket.parsePacket(slice);
        
        if (packet && !packet.error) {
          this.stats.messagesReceived++;
          this.stats.lastActivity = new Date().toISOString();

          if (this.debugWire) console.log(
            `[OSDP] Command received: 0x${packet.command.toString(16).toUpperCase()} ` +
            `Addr: 0x${packet.address.toString(16).padStart(2, '0')} ` +
            `Seq: ${packet.ctrl.sequence}`
          );

          this.routeCommand(packet, portPath);
          const consumed = packet.rawLength || packet.length || 0;
          idx += (consumed > 0 ? consumed : 1);
        } else {
          idx++;
        }
      }
    } catch (err) {
      console.error('[OSDP] Handler error:', err.message);
    }
  }

  routeCommand(packet, portPath = '/dev/ttyACM0') {
    let reader = Array.from(this.readers.values()).find(
      r => (r.address === packet.address || r.virtualAddress === packet.address) &&
           r.serialPort === portPath &&
           r.enabled
    );

    if (!reader) {
      const addressMatch = Array.from(this.readers.values()).find(
        r => (r.address === packet.address || r.virtualAddress === packet.address) && r.enabled
      );
      
      if (addressMatch) {
        this._wrongPortSeen = this._wrongPortSeen || new Set();
        const _wk = portPath + ':' + packet.address;
        if (!this._wrongPortSeen.has(_wk)) {
          this._wrongPortSeen.add(_wk);
          console.warn(`[OSDP] ⚠ Address 0x${packet.address.toString(16).padStart(2,'0')} on ${portPath} matches ${addressMatch.name} (configured for ${addressMatch.serialPort}) — suppressing further`);
        }
        return;
      }
      
      this._unconfigSeen = this._unconfigSeen || new Set();
      const _uk = portPath + ':' + packet.address;
      if (!this._unconfigSeen.has(_uk)) {
        this._unconfigSeen.add(_uk);
        console.warn(`[OSDP] No reader configured for address 0x${packet.address.toString(16).padStart(2, '0')} on ${portPath} (suppressing further)`);
      }
      return;
    }

    if (this.debugWire) console.log(`[OSDP] Routing to ${reader.name} (Address: 0x${packet.address.toString(16).padStart(2, '0')}) on ${portPath}`);

    // Verify and extract MAC for incoming secure commands
    // SCS_15 (0x15) = MAC only, SCS_17 (0x17) = encrypted + MAC
    if (packet.securityBlock && (packet.securityBlock.type === 0x17 || packet.securityBlock.type === 0x15)) {
      const session = this.secureChannelSessions ? this.secureChannelSessions.get(this._sessionKey(reader)) : null;
      if (session && session.established) {
        this.verifyAndExtractMAC(packet, session, reader);
      }
    }

    switch (packet.command) {
      case 0x60: this.handlePoll(packet, reader); break;                  // osdp_POLL
      case 0x61: this.handleIdRequest(packet, reader); break;             // osdp_ID
      case 0x62: this.handleCapRequest(packet, reader); break;            // osdp_CAP
      case 0x63: this.handleLstatRequest(packet, reader); break;          // osdp_DIAG in spec; kept for legacy panels
      case 0x64: this.handleLstatRequest(packet, reader); break;          // osdp_LSTAT  - Local Status (correct code)
      case 0x65: this.handleIstatRequest(packet, reader); break;          // osdp_ISTAT  - Input Status
      case 0x66: this.handleOstatRequest(packet, reader); break;          // osdp_OSTAT  - Output Status
      case 0x67: this.handleRstatRequest(packet, reader); break;          // osdp_RSTAT  - Reader Status ← WAS FAILING
      case 0x69: this.handleLedCommand(packet, reader); break;            // osdp_LED (0x69)
      case 0x6A: this.handleBuzzerCommand(packet, reader); break;         // osdp_BUZ (0x6A)
      case 0x6E: this.handleLedCommand(packet, reader); break;            // osdp_LED alt mapping
      case 0x6F: this.handleBuzzerCommand(packet, reader); break;         // osdp_BUZ alt mapping
      case 0x68: this.handleOutputCommand(packet, reader); break;         // osdp_OUT  - Output Control
      case 0x6B: this.handleTextCommand(packet, reader); break;           // osdp_TEXT - Reader Text Output
      case 0x75: this.handleKeySet(packet, reader); break;                // osdp_KEYSET
      case 0x76: this.handleChallenge(packet, reader); break;             // osdp_CHLNG
      case 0x77: this.handleServerCryptogram(packet, reader); break;      // osdp_SCRYPT
      default: {
        // Repeated NAKs make real panels drop the PD offline. For an emulator it is
        // safer to ACK a command we do not model than to refuse it outright.
        // Counts are kept so you can see what is falling through here.
        this._unimplCmd = this._unimplCmd || new Map();
        const _k = packet.command;
        this._unimplCmd.set(_k, (this._unimplCmd.get(_k) || 0) + 1);
        if (this._unimplCmd.get(_k) === 1) {
          console.warn(`[OSDP] Unimplemented cmd 0x${_k.toString(16).toUpperCase()} from ACU — ACKing (suppressing further)`);
        }
        const _p = reader.serialPort || portPath;
        if (_k >= 0x60 && _k <= 0x7F) {
          this.sendSecureAck(packet.address, packet.ctrl.sequence, _p, false);
        } else {
          this.sendNak(packet.address, packet.ctrl.sequence, 0x03, _p);
        }
        break;
      }
    }
  }

  async sendRawData(buffer, portPath = '/dev/ttyACM0') {
    if (this.serialPorts && this.serialPorts.size > 0) {
      const port = this.serialPorts.get(portPath);
      if (port && port.isOpen) {
        if (this.debugWire) console.log(`[OSDP] >>>> TX (${portPath}):`, buffer.toString('hex').toUpperCase());
        this._emitWireFrame('tx', portPath, buffer);
        // Probed once at open. Path-name sniffing broke as soon as we moved to
        // /dev/serial/by-id and udev symlinks, and both Waveshare converters do
        // direction control in hardware anyway.
        const _caps = this._portCaps && this._portCaps.get(portPath);
        const isUSB = _caps ? _caps.rts : false;
        return new Promise((resolve, reject) => {
          const doWrite = () => {
            port.write(buffer, err => {
              if (err) {
                console.error('[OSDP] Write error:', err.message);
                this.stats.errors++;
                this._trackError(portPath);
                if (isUSB) port.set({ rts: false }, () => {});
                console.warn('[OSDP] Write failed on ' + portPath + ' (non-fatal, controller will re-poll)');
                resolve();
              } else {
                port.drain(() => {
                  this.stats.messagesSent++;
                  this.stats.lastActivity = new Date().toISOString();
                  this._trackTx(portPath);
                  if (isUSB) {
                    const t = setTimeout(() => port.set({ rts: false }, () => {}), 4);
                    if (t.unref) t.unref();
                  }
                  resolve();
                });
              }
            });
          };
          if (isUSB) {
            port.set({ rts: true }, e => {
              if (e) console.warn('[OSDP] RTS assert failed on ' + portPath + ':', e.message);
              const t = setTimeout(doWrite, 1);
              if (t.unref) t.unref();
            });
          } else {
            doWrite();
          }
        });
      } else {
        console.warn(`[OSDP] Port ${portPath} not open or not found`);
      }
    }
    
    console.warn('[OSDP] No serial ports available (simulation mode)');
  }

  async sendAck(address, sequence, portPath = '/dev/ttyACM0') {
    const OSDPPacket = require('./OSDPPacket');
    const ack = OSDPPacket.buildACK(address, sequence);
    await this.sendRawData(ack, portPath);
  }

  // ── NEW: sendNak — spec-compliant NAK for unknown/unsupported commands ────────
  async sendNak(address, sequence, errorCode, portPath = '/dev/ttyACM0') {
    const OSDPPacket = require('./OSDPPacket');
    const nak = OSDPPacket.buildNAK(address, errorCode, sequence);
    await this.sendRawData(nak, portPath);
  }

  async sendSecureAck(address, sequence, portPath, isSecure) {
    const OSDPPacket = require('./OSDPPacket');
    
    const sessionKey = this._sessionKey(portPath, address);
    if (isSecure && this.secureChannelSessions && this.secureChannelSessions.has(sessionKey)) {
      const session = this.secureChannelSessions.get(sessionKey);
      const ack = this.buildSecurePacket(address, 0x40, Buffer.alloc(0), sequence, session);
      console.log('[OSDP-SC] Sending secure ACK');
      await this.sendRawData(ack, portPath);
    } else {
      const ack = OSDPPacket.buildACK(address, sequence);
      await this.sendRawData(ack, portPath);
    }
  }

  // ── Status Report Handlers ─────────────────────────────────────────────────
  // Per OSDP 2.2 spec: ACU polls these regularly during normal operation.
  // Responding with bare ACK is a protocol violation — each needs its proper reply.

  async handleLstatRequest(packet, reader) {
    // osdp_LSTAT (0x63) → reply osdp_LSTATR (0x48)
    // Byte 0: tamper status  (bit0 = tamper open, bit1 = power fault)
    // Byte 1: tamper input   (0x00 = normal)
    console.log(`[OSDP] Responding to LSTAT (Local Status) for ${reader.name}`);
    const OSDPPacket = require('./OSDPPacket');
    const portPath = reader.serialPort || '/dev/ttyACM0';
    const reply = OSDPPacket.buildPacket({
      address: packet.address,
      command: 0x48,                        // osdp_LSTATR
      data: Buffer.from([0x00, 0x00]),       // nominal: no tamper, no power fault
      sequence: packet.ctrl.sequence,
      isReply: true,
      useCRC: true
    });
    await this.sendRawData(reply, portPath);
  }

  async handleIstatRequest(packet, reader) {
    // osdp_ISTAT (0x65) → reply osdp_ISTATR (0x49)
    // One byte per monitored input; 0x00 = contact closed / normal
    console.log(`[OSDP] Responding to ISTAT (Input Status) for ${reader.name}`);
    const OSDPPacket = require('./OSDPPacket');
    const portPath = reader.serialPort || '/dev/ttyACM0';
    const inputCount = 1; // adjust to match PDCAP Function Code 4 input count
    const reply = OSDPPacket.buildPacket({
      address: packet.address,
      command: 0x49,                              // osdp_ISTATR
      data: Buffer.alloc(inputCount, 0x00),        // all inputs normal
      sequence: packet.ctrl.sequence,
      isReply: true,
      useCRC: true
    });
    await this.sendRawData(reply, portPath);
  }

  async handleOstatRequest(packet, reader) {
    // osdp_OSTAT (0x66) → reply osdp_OSTATR (0x4A)
    // One byte per output; 0x00 = output off / normal
    console.log(`[OSDP] Responding to OSTAT (Output Status) for ${reader.name}`);
    const OSDPPacket = require('./OSDPPacket');
    const portPath = reader.serialPort || '/dev/ttyACM0';
    const outputCount = 1; // adjust to match PDCAP Function Code 5 output count
    const reply = OSDPPacket.buildPacket({
      address: packet.address,
      command: 0x4A,                               // osdp_OSTATR
      data: Buffer.alloc(outputCount, 0x00),        // all outputs normal/off
      sequence: packet.ctrl.sequence,
      isReply: true,
      useCRC: true
    });
    await this.sendRawData(reply, portPath);
  }

  async handleRstatRequest(packet, reader) {
    // osdp_RSTAT (0x67) → reply osdp_RSTATR (0x4B)
    // Byte 0: reader tamper/power status
    //   bit0 = 0: not tampered
    //   bit1 = 0: power OK
    console.log(`[OSDP] Responding to RSTAT (Reader Status) for ${reader.name}`);
    const OSDPPacket = require('./OSDPPacket');
    const portPath = reader.serialPort || '/dev/ttyACM0';
    const reply = OSDPPacket.buildPacket({
      address: packet.address,
      command: 0x4B,                  // osdp_RSTATR
      data: Buffer.from([0x00]),       // nominal: no tamper, no power fault
      sequence: packet.ctrl.sequence,
      isReply: true,
      useCRC: true
    });
    await this.sendRawData(reply, portPath);
  }

  // ──────────────────────────────────────────────────────────────────────────

  // Verify MAC on incoming secure command and extract it for rolling MAC chain
  verifyAndExtractMAC(packet, session, reader) {
    const crypto = require('crypto');
    
    // Try raw bytes first, then try without SCB
    let dataToMac = packet.macInputBytes;
    
    console.log('[OSDP-SC] Raw MAC input (' + (dataToMac ? dataToMac.length : 0) + ' bytes):', 
                dataToMac ? dataToMac.toString('hex').toUpperCase() : 'none');
    console.log('[OSDP-SC] Received MAC:', packet.mac ? packet.mac.toString('hex').toUpperCase() : 'none');
    
    // Try different ICV options - be comprehensive
    const ivCandidates = [];
    
    if (session.lastCMAC) {
      ivCandidates.push({ name: 'last C-MAC', iv: session.lastCMAC });
    }
    if (session.lastRMAC) {
      ivCandidates.push({ name: 'last R-MAC', iv: session.lastRMAC });
    }
    if (session.rmacI) {
      ivCandidates.push({ name: 'R-MAC-I', iv: session.rmacI });
      // Also try complement (~RMAC-I) like we use for KEYSET decryption
      const complement = Buffer.alloc(16);
      for (let i = 0; i < 16; i++) {
        complement[i] = ~session.rmacI[i] & 0xFF;
      }
      ivCandidates.push({ name: '~R-MAC-I', iv: complement });
    }
    if (session.cmacI) {
      ivCandidates.push({ name: 'C-MAC-I', iv: session.cmacI });
      // Also try complement
      const complement = Buffer.alloc(16);
      for (let i = 0; i < 16; i++) {
        complement[i] = ~session.cmacI[i] & 0xFF;
      }
      ivCandidates.push({ name: '~C-MAC-I', iv: complement });
    }
    ivCandidates.push({ name: 'zeros', iv: Buffer.alloc(16, 0) });
    
    // Also try removing SCB from data
    let dataWithoutSCB = null;
    let dataWithoutSCBLen = null;
    let cmdDataOnly = null;
    if (dataToMac && packet.securityBlock) {
      const scbLen = packet.securityBlock.length;
      const before = dataToMac.slice(0, 5);
      const after = dataToMac.slice(5 + scbLen);
      dataWithoutSCB = Buffer.concat([before, after]);
      
      const beforeSCBLen = dataToMac.slice(0, 5);
      const scbType = dataToMac.slice(6, 7);
      const afterSCBType = dataToMac.slice(5 + scbLen);
      dataWithoutSCBLen = Buffer.concat([beforeSCBLen, scbType, afterSCBType]);
      
      cmdDataOnly = dataToMac.slice(5 + scbLen);
    }
    
    let matchingIV = null;
    let computedMAC = null;
    
    const dataSets = [
      { name: 'with SCB', data: dataToMac },
      { name: 'without SCB', data: dataWithoutSCB },
      { name: 'SCB type only', data: dataWithoutSCBLen },
      { name: 'CMD+DATA only', data: cmdDataOnly }
    ].filter(d => d.data);
    
    const keys = [
      { name: 'S-MAC1', key: session.sessionKeys.sMac1 },
      { name: 'S-MAC2', key: session.sessionKeys.sMac2 },
      { name: 'S-ENC', key: session.sessionKeys.sEnc },
      { name: 'SCBK', key: session.scbk }
    ];
    
    console.log('[OSDP-SC] Session keys:');
    console.log('[OSDP-SC]   S-MAC1:', session.sessionKeys.sMac1.toString('hex').toUpperCase());
    console.log('[OSDP-SC]   S-MAC2:', session.sessionKeys.sMac2.toString('hex').toUpperCase());
    console.log('[OSDP-SC]   RMAC-I:', session.rmacI.toString('hex').toUpperCase());
    console.log('[OSDP-SC]   CMAC-I:', session.cmacI.toString('hex').toUpperCase());

    for (const dataSet of dataSets) {
      for (const keyInfo of keys) {
        for (const candidate of ivCandidates) {
          const cbcMac = this.computeCBCMAC(dataSet.data, candidate.iv, keyInfo.key);
          if (packet.mac && cbcMac.slice(0, 4).equals(packet.mac)) {
            matchingIV = { ...candidate, algo: 'CBC-MAC-first4', dataType: dataSet.name, keyName: keyInfo.name };
            computedMAC = cbcMac;
            console.log('[OSDP-SC] ✓ C-MAC verified: ' + dataSet.name + ', ICV=' + candidate.name + 
                        ', key=' + keyInfo.name + ', algo=CBC-MAC-first4');
            break;
          }
          if (packet.mac && cbcMac.slice(12, 16).equals(packet.mac)) {
            matchingIV = { ...candidate, algo: 'CBC-MAC-last4', dataType: dataSet.name, keyName: keyInfo.name };
            computedMAC = cbcMac;
            console.log('[OSDP-SC] ✓ C-MAC verified: ' + dataSet.name + ', ICV=' + candidate.name + 
                        ', key=' + keyInfo.name + ', algo=CBC-MAC-last4');
            break;
          }
          const isoMac = this.computeCBCMACISO(dataSet.data, candidate.iv, keyInfo.key);
          if (packet.mac && isoMac.slice(0, 4).equals(packet.mac)) {
            matchingIV = { ...candidate, algo: 'CBC-MAC-ISO-first4', dataType: dataSet.name, keyName: keyInfo.name };
            computedMAC = isoMac;
            console.log('[OSDP-SC] ✓ C-MAC verified: ' + dataSet.name + ', ICV=' + candidate.name + 
                        ', key=' + keyInfo.name + ', algo=CBC-MAC-ISO-first4');
            break;
          }
          const cbcMacZero = this.computeCBCMAC(dataSet.data, Buffer.alloc(16, 0), keyInfo.key);
          const xorMac = Buffer.alloc(16);
          for (let i = 0; i < 16; i++) {
            xorMac[i] = cbcMacZero[i] ^ candidate.iv[i];
          }
          if (packet.mac && xorMac.slice(0, 4).equals(packet.mac)) {
            matchingIV = { ...candidate, algo: 'CBC-XOR-ICV', dataType: dataSet.name, keyName: keyInfo.name };
            computedMAC = xorMac;
            console.log('[OSDP-SC] ✓ C-MAC verified: ' + dataSet.name + ', ICV=' + candidate.name + 
                        ', key=' + keyInfo.name + ', algo=CBC-XOR-ICV');
            break;
          }
          if (dataSet.data.length <= 16) {
            const padded = Buffer.alloc(16, 0);
            dataSet.data.copy(padded);
            const xored = Buffer.alloc(16);
            for (let i = 0; i < 16; i++) {
              xored[i] = padded[i] ^ candidate.iv[i];
            }
            const crypto = require('crypto');
            const cipher = crypto.createCipheriv('aes-128-ecb', keyInfo.key, null);
            cipher.setAutoPadding(false);
            const simpleMac = cipher.update(xored);
            if (packet.mac && simpleMac.slice(0, 4).equals(packet.mac)) {
              matchingIV = { ...candidate, algo: 'AES-XOR-single', dataType: dataSet.name, keyName: keyInfo.name };
              computedMAC = simpleMac;
              console.log('[OSDP-SC] ✓ C-MAC verified: ' + dataSet.name + ', ICV=' + candidate.name + 
                          ', key=' + keyInfo.name + ', algo=AES-XOR-single');
              break;
            }
          }
          const cmac = this.computeOSDPMAC(dataSet.data, candidate.iv, keyInfo.key);
          if (packet.mac && cmac.slice(0, 4).equals(packet.mac)) {
            matchingIV = { ...candidate, algo: 'CMAC-first4', dataType: dataSet.name, keyName: keyInfo.name };
            computedMAC = cmac;
            console.log('[OSDP-SC] ✓ C-MAC verified: ' + dataSet.name + ', ICV=' + candidate.name + 
                        ', key=' + keyInfo.name + ', algo=CMAC-first4');
            break;
          }
          if (packet.mac && cmac.slice(12, 16).equals(packet.mac)) {
            matchingIV = { ...candidate, algo: 'CMAC-last4', dataType: dataSet.name, keyName: keyInfo.name };
            computedMAC = cmac;
            console.log('[OSDP-SC] ✓ C-MAC verified: ' + dataSet.name + ', ICV=' + candidate.name + 
                        ', key=' + keyInfo.name + ', algo=CMAC-last4');
            break;
          }
        }
        if (matchingIV) break;
      }
      if (matchingIV) break;
    }
    
    if (!matchingIV && dataToMac) {
      for (const candidate of ivCandidates) {
        const retailMac = this.computeRetailMAC(dataToMac, candidate.iv, 
          session.sessionKeys.sMac1, session.sessionKeys.sMac2);
        if (packet.mac && retailMac.slice(0, 4).equals(packet.mac)) {
          matchingIV = { ...candidate, algo: 'Retail-MAC', dataType: 'with SCB' };
          computedMAC = retailMac;
          console.log('[OSDP-SC] ✓ C-MAC verified: Retail MAC, ICV=' + candidate.name);
          break;
        }
        const twoKeyMac = this.computeTwoKeyMAC(dataToMac, candidate.iv, 
          session.sessionKeys.sMac1, session.sessionKeys.sMac2);
        if (packet.mac && twoKeyMac.slice(0, 4).equals(packet.mac)) {
          matchingIV = { ...candidate, algo: 'Two-Key-MAC', dataType: 'with SCB' };
          computedMAC = twoKeyMac;
          console.log('[OSDP-SC] ✓ C-MAC verified: Two-Key MAC, ICV=' + candidate.name);
          break;
        }
        const cbcMac = this.computeAESCBCMAC(dataToMac, candidate.iv, session.sessionKeys.sMac1);
        if (packet.mac && cbcMac.slice(0, 4).equals(packet.mac)) {
          matchingIV = { ...candidate, algo: 'AES-CBC-MAC', dataType: 'with SCB' };
          computedMAC = cbcMac;
          console.log('[OSDP-SC] ✓ C-MAC verified: AES-CBC MAC, ICV=' + candidate.name);
          break;
        }
      }
    }
    
    if (!matchingIV && dataToMac) {
      console.log('[OSDP-SC] ⚠ C-MAC mismatch - tried all combinations');
      console.log('[OSDP-SC] Expected MAC:', packet.mac.toString('hex').toUpperCase());
      
      const testIVs = [
        { name: 'zeros', iv: Buffer.alloc(16, 0) },
        { name: 'RMAC-I', iv: session.rmacI },
        { name: 'CMAC-I', iv: session.cmacI }
      ];
      
      if (session.lastRMAC) {
        testIVs.push({ name: 'lastRMAC', iv: session.lastRMAC });
      }
      
      console.log('[OSDP-SC] Full 16-byte MAC results:');
      for (const testIV of testIVs) {
        const mac1 = this.computeCBCMAC(dataToMac, testIV.iv, session.sessionKeys.sMac1);
        const cbc = this.computeAESCBCMAC(dataToMac, testIV.iv, session.sessionKeys.sMac1);
        const twoKey = this.computeTwoKeyMAC(dataToMac, testIV.iv, session.sessionKeys.sMac1, session.sessionKeys.sMac2);
        const twoKeyV2 = this.computeTwoKeyMACv2(dataToMac, testIV.iv, session.sessionKeys.sMac1, session.sessionKeys.sMac2);
        const mac2 = this.computeCBCMAC(dataToMac, testIV.iv, session.sessionKeys.sMac2);
        const iso = this.computeCBCMACISO(dataToMac, testIV.iv, session.sessionKeys.sMac1);
        const cmac = this.computeOSDPMAC(dataToMac, testIV.iv, session.sessionKeys.sMac1);
        console.log('[OSDP-SC]   ' + testIV.name + ':');
        console.log('[OSDP-SC]     CBC-MAC:  ' + mac1.slice(0,4).toString('hex').toUpperCase());
        console.log('[OSDP-SC]     ISO-MAC:  ' + iso.slice(0,4).toString('hex').toUpperCase());
        console.log('[OSDP-SC]     CMAC:     ' + cmac.slice(0,4).toString('hex').toUpperCase());
        console.log('[OSDP-SC]     Retail:   ' + twoKey.slice(0,4).toString('hex').toUpperCase() + ' (Algo3: E(K1,D(K2,CBC)))');
        console.log('[OSDP-SC]     K2Last:   ' + twoKeyV2.slice(0,4).toString('hex').toUpperCase() + ' (K2 for last block)');
        console.log('[OSDP-SC]     S-MAC2:   ' + mac2.slice(0,4).toString('hex').toUpperCase());
        if (packet.mac) {
          if (twoKey.slice(0,4).equals(packet.mac)) {
            console.log('[OSDP-SC]     ^^^ Retail MAC MATCHES! ^^^');
            matchingIV = testIV.name + '-Retail';
            computedMAC = twoKey;
          }
          if (twoKeyV2.slice(0,4).equals(packet.mac)) {
            console.log('[OSDP-SC]     ^^^ K2Last MAC MATCHES! ^^^');
            matchingIV = testIV.name + '-K2Last';
            computedMAC = twoKeyV2;
          }
        }
      }
      
      if (session.lastCMAC) {
        const macLastC = this.computeCBCMAC(dataToMac, session.lastCMAC, session.sessionKeys.sMac1);
        const isoLastC = this.computeCBCMACISO(dataToMac, session.lastCMAC, session.sessionKeys.sMac1);
        const twoKeyLastC = this.computeTwoKeyMAC(dataToMac, session.lastCMAC, session.sessionKeys.sMac1, session.sessionKeys.sMac2);
        console.log('[OSDP-SC]   lastCMAC:');
        console.log('[OSDP-SC]     CBC-MAC:  ' + macLastC.slice(0,4).toString('hex').toUpperCase());
        console.log('[OSDP-SC]     ISO-MAC:  ' + isoLastC.slice(0,4).toString('hex').toUpperCase());
        console.log('[OSDP-SC]     Two-Key:  ' + twoKeyLastC.slice(0,4).toString('hex').toUpperCase());
        if (twoKeyLastC.slice(0,4).equals(packet.mac)) {
          matchingIV = 'lastCMAC-TwoKey';
          computedMAC = twoKeyLastC;
        }
      }
      
      if (computedMAC === null) {
        const ivForCMAC = session.lastRMAC || session.rmacI || Buffer.alloc(16, 0);
        computedMAC = this.computeTwoKeyMACv2(dataToMac, ivForCMAC, session.sessionKeys.sMac1, session.sessionKeys.sMac2);
        console.log('[OSDP-SC] Computed C-MAC for chain using K2Last, ICV=' + (session.lastRMAC ? 'lastRMAC' : 'RMAC-I'));
      }
    }
    
    session.lastCMAC = computedMAC;
    
    if (packet.mac) {
      session.receivedCMAC = Buffer.concat([packet.mac, Buffer.alloc(12, 0)]);
    }
    
    if (matchingIV === null) {
      console.log('[OSDP-SC] ⚠ C-MAC verification failed, but storing computed MAC for R-MAC chain');
    } else {
      console.log('[OSDP-SC] ✓ C-MAC verified with ICV: ' + matchingIV);
    }
    return true;
  }
  
  computeCBCMAC(data, iv, key) {
    const crypto = require('crypto');
    const padLen = (16 - (data.length % 16)) % 16;
    const paddedData = Buffer.concat([data, Buffer.alloc(padLen, 0)]);
    let mac = iv;
    for (let i = 0; i < paddedData.length; i += 16) {
      const block = paddedData.slice(i, i + 16);
      const xored = Buffer.alloc(16);
      for (let j = 0; j < 16; j++) xored[j] = block[j] ^ mac[j];
      const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
      cipher.setAutoPadding(false);
      mac = cipher.update(xored);
    }
    return mac;
  }
  
  computeCBCMACISO(data, iv, key) {
    const crypto = require('crypto');
    const padLen = 16 - ((data.length + 1) % 16);
    const paddedData = Buffer.concat([data, Buffer.from([0x80]), Buffer.alloc(padLen === 16 ? 0 : padLen, 0)]);
    let mac = iv;
    for (let i = 0; i < paddedData.length; i += 16) {
      const block = paddedData.slice(i, i + 16);
      const xored = Buffer.alloc(16);
      for (let j = 0; j < 16; j++) xored[j] = block[j] ^ mac[j];
      const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
      cipher.setAutoPadding(false);
      mac = cipher.update(xored);
    }
    return mac;
  }
  
  computeRetailMAC(data, iv, k1, k2) {
    const crypto = require('crypto');
    const padLen = (16 - (data.length % 16)) % 16;
    const paddedData = Buffer.concat([data, Buffer.alloc(padLen, 0)]);
    let mac = iv;
    for (let i = 0; i < paddedData.length - 16; i += 16) {
      const block = paddedData.slice(i, i + 16);
      const xored = Buffer.alloc(16);
      for (let j = 0; j < 16; j++) xored[j] = block[j] ^ mac[j];
      const cipher = crypto.createCipheriv('aes-128-ecb', k1, null);
      cipher.setAutoPadding(false);
      mac = cipher.update(xored);
    }
    const lastBlock = paddedData.slice(-16);
    const decipher = crypto.createDecipheriv('aes-128-ecb', k1, null);
    decipher.setAutoPadding(false);
    const decrypted = decipher.update(mac);
    const xored = Buffer.alloc(16);
    for (let j = 0; j < 16; j++) xored[j] = decrypted[j] ^ lastBlock[j];
    const finalCipher = crypto.createCipheriv('aes-128-ecb', k2, null);
    finalCipher.setAutoPadding(false);
    mac = finalCipher.update(xored);
    return mac;
  }
  
  computeAESCBCMAC(data, iv, key) {
    const crypto = require('crypto');
    const padLen = (16 - (data.length % 16)) % 16;
    const paddedData = Buffer.concat([data, Buffer.alloc(padLen, 0)]);
    const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
    cipher.setAutoPadding(false);
    const encrypted = cipher.update(paddedData);
    return encrypted.slice(-16);
  }
  
  computeTwoKeyMAC(data, iv, k1, k2) {
    const crypto = require('crypto');
    const blockSize = 16;
    const remainder = data.length % blockSize;
    let paddedData;
    if (remainder === 0) {
      paddedData = Buffer.concat([data, Buffer.from([0x80]), Buffer.alloc(15, 0)]);
    } else {
      const paddingLength = blockSize - remainder;
      const padding = Buffer.alloc(paddingLength, 0);
      padding[0] = 0x80;
      paddedData = Buffer.concat([data, padding]);
    }
    let mac = Buffer.from(iv);
    const blockCount = paddedData.length / 16;
    for (let i = 0; i < blockCount; i++) {
      const block = paddedData.slice(i * 16, (i + 1) * 16);
      const xored = Buffer.alloc(16);
      for (let j = 0; j < 16; j++) xored[j] = block[j] ^ mac[j];
      const cipher = crypto.createCipheriv('aes-128-ecb', k1, null);
      cipher.setAutoPadding(false);
      mac = cipher.update(xored);
    }
    const decipher = crypto.createDecipheriv('aes-128-ecb', k2, null);
    decipher.setAutoPadding(false);
    const decrypted = decipher.update(mac);
    const finalCipher = crypto.createCipheriv('aes-128-ecb', k1, null);
    finalCipher.setAutoPadding(false);
    const finalMac = finalCipher.update(decrypted);
    return finalMac;
  }
  
  computeTwoKeyMACv2(data, iv, k1, k2) {
    const crypto = require('crypto');
    const blockSize = 16;
    const remainder = data.length % blockSize;
    let paddedData;
    if (remainder === 0) {
      paddedData = data;
    } else {
      const paddingLength = blockSize - remainder;
      const padding = Buffer.alloc(paddingLength, 0);
      padding[0] = 0x80;
      paddedData = Buffer.concat([data, padding]);
    }
    let mac = Buffer.from(iv);
    const blockCount = paddedData.length / 16;
    for (let i = 0; i < blockCount; i++) {
      const block = paddedData.slice(i * 16, (i + 1) * 16);
      const xored = Buffer.alloc(16);
      for (let j = 0; j < 16; j++) xored[j] = block[j] ^ mac[j];
      const key = (i === blockCount - 1) ? k2 : k1;
      const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
      cipher.setAutoPadding(false);
      mac = cipher.update(xored);
    }
    return mac;
  }

  computeOSDPMAC(data, iv, sMac1) {
    const crypto = require('crypto');
    const zero = Buffer.alloc(16, 0);
    const cipher = crypto.createCipheriv('aes-128-ecb', sMac1, null);
    cipher.setAutoPadding(false);
    const L = cipher.update(zero);
    let K1 = this.leftShift(L);
    if (L[0] & 0x80) K1[15] ^= 0x87;
    let K2 = this.leftShift(K1);
    if (K1[0] & 0x80) K2[15] ^= 0x87;
    const blockSize = 16;
    const numBlocks = Math.ceil(data.length / blockSize) || 1;
    const lastBlockComplete = (data.length % blockSize === 0) && data.length > 0;
    let lastBlock;
    if (lastBlockComplete) {
      lastBlock = Buffer.from(data.slice((numBlocks - 1) * blockSize));
      for (let i = 0; i < 16; i++) lastBlock[i] ^= K1[i];
    } else {
      const remainder = data.length % blockSize;
      lastBlock = Buffer.alloc(16, 0);
      if (remainder > 0) data.slice((numBlocks - 1) * blockSize).copy(lastBlock);
      lastBlock[remainder] = 0x80;
      for (let i = 0; i < 16; i++) lastBlock[i] ^= K2[i];
    }
    let mac = iv;
    for (let i = 0; i < numBlocks - 1; i++) {
      const block = data.slice(i * blockSize, (i + 1) * blockSize);
      const xored = Buffer.alloc(16);
      for (let j = 0; j < 16; j++) xored[j] = block[j] ^ mac[j];
      const blockCipher = crypto.createCipheriv('aes-128-ecb', sMac1, null);
      blockCipher.setAutoPadding(false);
      mac = blockCipher.update(xored);
    }
    const xored = Buffer.alloc(16);
    for (let j = 0; j < 16; j++) xored[j] = lastBlock[j] ^ mac[j];
    const finalCipher = crypto.createCipheriv('aes-128-ecb', sMac1, null);
    finalCipher.setAutoPadding(false);
    mac = finalCipher.update(xored);
    return mac;
  }
  
  leftShift(buf) {
    const result = Buffer.alloc(buf.length);
    let carry = 0;
    for (let i = buf.length - 1; i >= 0; i--) {
      const newCarry = (buf[i] & 0x80) ? 1 : 0;
      result[i] = ((buf[i] << 1) | carry) & 0xFF;
      carry = newCarry;
    }
    return result;
  }

  buildSecurePacket(address, command, data, sequence, session) {
    const OSDPPacket = require('./OSDPPacket');
    const crypto = require('crypto');
    
    console.log('[OSDP-SC] Building secure packet:');
    console.log('[OSDP-SC]   Address:', address);
    console.log('[OSDP-SC]   Command:', '0x' + command.toString(16));
    console.log('[OSDP-SC]   Data length:', data ? data.length : 0);
    
    const scbLen = 2;
    const macLen = 4;
    const hasData = data && data.length > 0;
    const scbType = 0x15;  // SCS_15 = MAC only, no encryption
    const dataLen = hasData ? data.length : 0;
    const totalLen = 1 + 1 + 2 + 1 + scbLen + 1 + dataLen + macLen + 2;
    
    const packet = Buffer.alloc(totalLen);
    let offset = 0;
    
    packet[offset++] = 0x53;
    packet[offset++] = address | 0x80;
    packet.writeUInt16LE(totalLen, offset); offset += 2;
    
    const ctrl = 0x04 | 0x08 | ((sequence & 0x03) << 0);
    packet[offset++] = ctrl;
    
    console.log('[OSDP-SC]   Sequence:', sequence & 0x03, '(CTRL=0x' + ctrl.toString(16).toUpperCase() + ')');
    console.log('[OSDP-SC]   SCB: type=0x15 (SCS_15 = MAC only, no encryption)');
    
    packet[offset++] = scbLen;
    packet[offset++] = scbType;
    packet[offset++] = command;
    
    if (hasData) {
      data.copy(packet, offset);
      offset += data.length;
      console.log('[OSDP-SC]   Card data (plaintext):', data.toString('hex').toUpperCase());
    }
    
    const dataToMac = packet.slice(0, offset);
    const dataToMacNoReply = Buffer.from(dataToMac);
    dataToMacNoReply[1] = address;
    const dataNoScbLen = Buffer.concat([
      dataToMac.slice(0, 5),
      dataToMac.slice(6)
    ]);
    
    console.log('[OSDP-SC] R-MAC input (' + dataToMac.length + ' bytes): ' + dataToMac.toString('hex').toUpperCase());
    
    let iv;
    if (session.lastCMAC && Buffer.isBuffer(session.lastCMAC) && session.lastCMAC.length === 16) {
      iv = session.lastCMAC;
      console.log('[OSDP-SC] R-MAC ICV = computed C-MAC:', iv.toString('hex').toUpperCase().slice(0,8) + '...');
    } else if (session.rmacI && !session.firstRMACSent) {
      iv = session.rmacI;
      console.log('[OSDP-SC] R-MAC ICV = RMAC-I (first reply):', iv.toString('hex').toUpperCase().slice(0,8) + '...');
      session.firstRMACSent = true;
    } else if (session.lastRMAC) {
      iv = session.lastRMAC;
      console.log('[OSDP-SC] R-MAC ICV = last R-MAC:', iv.toString('hex').toUpperCase().slice(0,8) + '...');
    } else {
      iv = session.rmacI || Buffer.alloc(16, 0);
      console.log('[OSDP-SC] R-MAC ICV = RMAC-I (fallback):', iv.toString('hex').toUpperCase().slice(0,8) + '...');
    }
    if (!Buffer.isBuffer(iv)) iv = Buffer.alloc(16, 0);
    
    const mac = this.computeTwoKeyMACv2(dataToMac, iv, session.sessionKeys.sMac1, session.sessionKeys.sMac2);
    
    // Diagnostic alternatives
    const cbcMacZeros = this.computeCBCMAC(dataToMac, Buffer.alloc(16, 0), session.sessionKeys.sMac1);
    const cbcMacRmacI = this.computeCBCMAC(dataToMac, session.rmacI || Buffer.alloc(16, 0), session.sessionKeys.sMac1);
    const cmacZeros = this.computeOSDPMAC(dataToMac, Buffer.alloc(16, 0), session.sessionKeys.sMac1);
    const cmacRmacI = this.computeOSDPMAC(dataToMac, session.rmacI || Buffer.alloc(16, 0), session.sessionKeys.sMac1);
    const twoKeyMac = this.computeTwoKeyMAC(dataToMac, Buffer.alloc(16, 0), session.sessionKeys.sMac1, session.sessionKeys.sMac2);
    const twoKeyMacRmacI = this.computeTwoKeyMAC(dataToMac, session.rmacI || Buffer.alloc(16, 0), session.sessionKeys.sMac1, session.sessionKeys.sMac2);
    const twoKeyV2Zeros = this.computeTwoKeyMACv2(dataToMac, Buffer.alloc(16, 0), session.sessionKeys.sMac1, session.sessionKeys.sMac2);
    const twoKeyV2RmacI = this.computeTwoKeyMACv2(dataToMac, session.rmacI || Buffer.alloc(16, 0), session.sessionKeys.sMac1, session.sessionKeys.sMac2);
    
    let retailLastCmac = null;
    let k2LastLastCmac = null;
    if (session.lastCMAC) {
      retailLastCmac = this.computeTwoKeyMAC(dataToMac, session.lastCMAC, session.sessionKeys.sMac1, session.sessionKeys.sMac2);
      k2LastLastCmac = this.computeTwoKeyMACv2(dataToMac, session.lastCMAC, session.sessionKeys.sMac1, session.sessionKeys.sMac2);
    }
    
    console.log('[OSDP-SC] R-MAC alternatives:');
    console.log('[OSDP-SC]   CBC zeros:    ' + cbcMacZeros.slice(0,4).toString('hex').toUpperCase());
    console.log('[OSDP-SC]   CBC RMAC-I:   ' + cbcMacRmacI.slice(0,4).toString('hex').toUpperCase());
    console.log('[OSDP-SC]   Retail zeros: ' + twoKeyMac.slice(0,4).toString('hex').toUpperCase());
    console.log('[OSDP-SC]   Retail RMAC-I:' + twoKeyMacRmacI.slice(0,4).toString('hex').toUpperCase());
    console.log('[OSDP-SC]   K2Last zeros: ' + twoKeyV2Zeros.slice(0,4).toString('hex').toUpperCase());
    console.log('[OSDP-SC]   K2Last RMAC-I:' + twoKeyV2RmacI.slice(0,4).toString('hex').toUpperCase());
    console.log('[OSDP-SC]   CMAC zeros:   ' + cmacZeros.slice(0,4).toString('hex').toUpperCase());
    console.log('[OSDP-SC]   CMAC RMAC-I:  ' + cmacRmacI.slice(0,4).toString('hex').toUpperCase());
    if (retailLastCmac) {
      console.log('[OSDP-SC]   Retail lastC:' + retailLastCmac.slice(0,4).toString('hex').toUpperCase());
      console.log('[OSDP-SC]   K2Last lastC:' + k2LastLastCmac.slice(0,4).toString('hex').toUpperCase());
    }
    console.log('[OSDP-SC] Actual MAC:     ' + mac.slice(0,4).toString('hex').toUpperCase());
    
    session.lastRMAC = mac;
    
    const truncatedMAC = mac.slice(0, 4);
    truncatedMAC.copy(packet, offset);
    offset += 4;
    
    const crc = OSDPPacket.calculateCRC(packet.slice(0, offset));
    packet.writeUInt16LE(crc, offset);
    
    console.log('[OSDP-SC] Secure packet:', packet.toString('hex').toUpperCase());
    console.log('[OSDP-SC] MAC (truncated):', truncatedMAC.toString('hex').toUpperCase());
    
    return packet;
  }

  async handlePoll(packet, reader) {
    const hasCard = reader.lastCard && !reader.lastCard.reported;
    const hasKeypad = reader.status === 'keypad-pending' && reader.lastKeypad;
    console.log(`[OSDP] handlePoll: reader=${reader.name} (id=${reader.id}), status=${reader.status}, hasCard=${hasCard}, hasKeypad=${hasKeypad}`);
    
    const portPath = reader.serialPort || '/dev/ttyACM0';
    const sessionKey = this._sessionKey(reader);
    
    const isSecure = this.secureChannelSessions && 
                     this.secureChannelSessions.has(sessionKey) && 
                     this.secureChannelSessions.get(sessionKey).established;
    
    if (isSecure) {
      console.log(`[OSDP-SC] Secure channel active for ${reader.name}`);
    }
    
    if (reader.lastCard && !reader.lastCard.reported) {
      console.log(`[OSDP] Sending card data for ${reader.name} in poll response`);
      console.log(`[OSDP] lastCard data:`, JSON.stringify(reader.lastCard));
      
      if (!reader.lastCard.bitCount || isNaN(reader.lastCard.bitCount)) {
        console.error(`[OSDP] ERROR: lastCard has invalid bitCount!`);
        reader.lastCard = null;
        await this.sendSecureAck(packet.address, packet.ctrl.sequence, portPath, isSecure);
        return;
      }
      
      const reply = this.buildCardReadReply(packet.address, reader.lastCard, packet.ctrl.sequence, isSecure, reader);
      reader.lastCard.reported = true;
      await this.sendRawData(reply, portPath);
    }
    else if (reader.status === 'keypad-pending' && reader.keypadQueue && reader.keypadQueue.length > 0) {
      // Real OSDP keypads send ONE keypress per osdp_KEYPAD reply.
      // Each press = separate packet [reader#=0, count=1, key]; panel accumulates.
      // Bundling all digits into one reply is silently dropped by Hanwha panels.
      const OSDPPacket = require('./OSDPPacket');
      const nextKey   = reader.keypadQueue.shift();
      const remaining = reader.keypadQueue.length;
      console.log(`[OSDP] ✓✓✓ Sending single keypress 0x${nextKey.toString(16).padStart(2,'0').toUpperCase()} for ${reader.name} (${remaining} remaining)`);
      const payload = Buffer.from([0x00, 0x01, nextKey & 0xFF]);
      let reply = null;
      if (isSecure) {
        const sk = this._sessionKey(reader);
        if (this.secureChannelSessions && this.secureChannelSessions.has(sk)) {
          const session = this.secureChannelSessions.get(sk);
          reply = this.buildSecurePacket(packet.address, 0x53, payload, packet.ctrl.sequence, session);
        }
      }
      if (!reply) {
        reply = OSDPPacket.buildPacket({
          address: packet.address, command: 0x53, data: payload,
          sequence: packet.ctrl.sequence, isReply: true, useCRC: true
        });
      }
      if (remaining === 0) {
        reader.status = 'idle';
        reader.lastKeypad = null;
        console.log(`[OSDP] Keypad queue drained for ${reader.name} — back to idle`);
      }
      await this.sendRawData(reply, portPath);
    }
    else {
      console.log(`[OSDP] Responding to POLL for ${reader.name} (no pending data)`);
      await this.sendSecureAck(packet.address, packet.ctrl.sequence, portPath, isSecure);
    }
  }

  async handleIdRequest(packet, reader) {
    console.log(`[OSDP] Responding to ID request for ${reader.name}`);
    const OSDPCommands = require('./OSDPCommands');
    const OSDPPacket = require('./OSDPPacket');

    const commands = new OSDPCommands({
      vendorCode: Buffer.from([0x00, 0x17, 0x66]),
      modelNumber: 0x01,
      version: 0x01,
      serialNumber: 0x12345678 + reader.address,
      firmwareMajor: 1,
      firmwareMinor: 0,
      firmwareBuild: 0
    });

    const idData = commands.buildPDID();
    const reply = OSDPPacket.buildPacket({
      address: packet.address,
      command: 0x45,
      data: idData,
      sequence: packet.ctrl.sequence,
      isReply: true,
      useCRC: true
    });

    await this.sendRawData(reply, reader.serialPort || '/dev/ttyACM0');
  }

  async handleCapRequest(packet, reader) {
    console.log(`[OSDP] Responding to CAP request for ${reader.name}`);
    const OSDPCommands = require('./OSDPCommands');
    const OSDPPacket = require('./OSDPPacket');

    const commands = new OSDPCommands({});
    const capData = commands.buildPDCAP();
    
    const reply = OSDPPacket.buildPacket({
      address: packet.address,
      command: 0x46,
      data: capData,
      sequence: packet.ctrl.sequence,
      isReply: true,
      useCRC: true
    });

    await this.sendRawData(reply, reader.serialPort || '/dev/ttyACM0');
  }

  async handleLedCommand(packet, reader) {
    console.log(`[OSDP] LED command received for ${reader.name}`);
    // Mirror LED state to InteractiveReader (OSDP §6.16 two-layer LED control)
    try {
      const d = packet.data;
      if (d && d.length >= 14) {
        this._emitLedEvent(reader, {
          temporary: {
            controlName: ['nop','cancel','set'][d[2]] || 'nop',
            onTimeMs:  d[3] * 100,
            offTimeMs: d[4] * 100,
            onColor:   this._colorName(d[5]),
            offColor:  this._colorName(d[6]),
            timerMs:   (d[7] | (d[8] << 8)) * 100,
          },
          permanent: {
            controlName: ['nop','set'][d[9]] || 'nop',
            onTimeMs:  d[10] * 100,
            offTimeMs: d[11] * 100,
            onColor:   this._colorName(d[12]),
            offColor:  this._colorName(d[13]),
          }
        });
      }
    } catch(e) { /* never break LED handling */ }
    const portPath = reader.serialPort || '/dev/ttyACM0';
    const sessionKey = this._sessionKey(reader);
    const isSecure = this.secureChannelSessions && 
                     this.secureChannelSessions.has(sessionKey) && 
                     this.secureChannelSessions.get(sessionKey).established;
    await this.sendSecureAck(packet.address, packet.ctrl.sequence, portPath, isSecure);
  }

  async handleBuzzerCommand(packet, reader) {
    // Mirror buzzer state to InteractiveReader
    try {
      const d = packet.data;
      if (d && d.length >= 5) {
        this._emitBuzzerEvent(reader, {
          toneName:    d[1] === 0 ? 'off' : 'default',
          onTimeMs:    d[2] * 100,
          offTimeMs:   d[3] * 100,
          repeatCount: d[4],
        });
      }
    } catch(e) { /* never break BUZ handling */ }
    console.log(`[OSDP] Buzzer command received for ${reader.name}`);
    const portPath = reader.serialPort || '/dev/ttyACM0';
    const sessionKey = this._sessionKey(reader);
    const isSecure = this.secureChannelSessions && 
                     this.secureChannelSessions.has(sessionKey) && 
                     this.secureChannelSessions.get(sessionKey).established;
    await this.sendSecureAck(packet.address, packet.ctrl.sequence, portPath, isSecure);
  }

  async handleChallenge(packet, reader) {
    console.log(`[OSDP-SC] ===== CHLNG received for ${reader.name} =====`);
    
    const OSDPPacket = require('./OSDPPacket');
    const OSDPCommands = require('./OSDPCommands');
    const OSDPSecurity = require('./OSDPSecurity');
    const crypto = require('crypto');
    
    const portPath = reader.serialPort || '/dev/ttyACM0';
    const sessionKey = this._sessionKey(reader);
    
    if (!this.security) {
      this.security = new OSDPSecurity();
    }
    
    let rndA;
    if (packet.data && packet.data.length >= 8) {
      rndA = packet.data.slice(0, 8);
      console.log('[OSDP-SC] RND.A from packet.data:', rndA.toString('hex').toUpperCase());
    } else {
      console.error('[OSDP-SC] No RND.A found in CHLNG packet data');
      await this.sendAck(packet.address, packet.ctrl.sequence, portPath);
      return;
    }
    
    console.log('[OSDP-SC] RND.A from ACU:', rndA.toString('hex').toUpperCase());
    
    const rndB = crypto.randomBytes(8);
    console.log('[OSDP-SC] RND.B (ours):', rndB.toString('hex').toUpperCase());
    
    let useDefaultKey = true;
    if (packet.securityBlock && packet.securityBlock.data && packet.securityBlock.data.length > 0) {
      useDefaultKey = packet.securityBlock.data[0] === 0x00;
      console.log('[OSDP-SC] SCB flag:', packet.securityBlock.data[0], '- Use default key:', useDefaultKey, 
        `(${packet.securityBlock.data[0] === 0x01 ? 'SCBK' : 'SCBK-D'})`);
    }
    
    let scbk;
    if (!useDefaultKey && reader.scbk && reader.scbkConfigured) {
      scbk = Buffer.isBuffer(reader.scbk) ? reader.scbk : Buffer.from(reader.scbk, 'hex');
      console.log('[OSDP-SC] Using configured SCBK:', scbk.toString('hex').toUpperCase());
    } else {
      scbk = this.security.SCBK_D;
      console.log('[OSDP-SC] Using SCBK-D (default):', scbk.toString('hex').toUpperCase());
    }
    
    const commands = new OSDPCommands({
      vendorCode: Buffer.from([0x00, 0x17, 0x66]),
      modelNumber: 0x01,
      version: 0x01,
      serialNumber: 0x12345678 + reader.address,
      firmwareMajor: 1,
      firmwareMinor: 0,
      firmwareBuild: 0
    });
    const cUID = commands.buildCUID();
    console.log('[OSDP-SC] cUID:', cUID.toString('hex').toUpperCase());
    console.log('[OSDP-SC] Storing session with key:', sessionKey);
    
    const sessionKeys = this.security.deriveSessionKeys(scbk, rndA);
    const clientCryptogram = this.security.generateClientCryptogram(rndA, rndB, sessionKeys.sEnc, cUID);
    
    this.secureChannelSessions.set(sessionKey, {
      rndA: Buffer.from(rndA),
      rndB: Buffer.from(rndB),
      scbk,
      sessionKeys,
      cUID,
      established: false,
      rmacI: null,
      cmacI: null,
      lastCMAC: null,
      lastRMAC: null
    });
    
    const ccryptData = Buffer.alloc(32);
    cUID.copy(ccryptData, 0, 0, 8);
    rndB.copy(ccryptData, 8, 0, 8);
    clientCryptogram.copy(ccryptData, 16, 0, 16);
    console.log('[OSDP-SC] CCRYPT data (cUID+RND.B+Cryptogram):', ccryptData.toString('hex').toUpperCase());
    
    const reply = OSDPPacket.buildPacket({
      address: packet.address,
      command: 0x76,
      data: ccryptData,
      sequence: packet.ctrl.sequence,
      isReply: true,
      useCRC: true,
      securityBlock: { type: 0x12, data: null }
    });
    
    console.log('[OSDP-SC] CCRYPT reply:', reply.toString('hex').toUpperCase());
    await this.sendRawData(reply, portPath);
  }

  async handleServerCryptogram(packet, reader) {
    console.log(`[OSDP-SC] ===== SCRYPT received for ${reader.name} =====`);
    
    const OSDPPacket = require('./OSDPPacket');
    const crypto = require('crypto');
    
    const portPath = reader.serialPort || '/dev/ttyACM0';
    const sessionKey = this._sessionKey(reader);
    
    if (!this.secureChannelSessions || !this.secureChannelSessions.has(sessionKey)) {
      console.error('[OSDP-SC] No session found for this reader (key:', sessionKey, ')');
      await this.sendAck(packet.address, packet.ctrl.sequence, portPath);
      return;
    }
    
    const session = this.secureChannelSessions.get(sessionKey);
    
    let serverCryptogram;
    if (packet.securityBlock && packet.securityBlock.data && packet.securityBlock.data.length >= 16) {
      serverCryptogram = packet.securityBlock.data.slice(0, 16);
    } else if (packet.data && packet.data.length >= 16) {
      serverCryptogram = packet.data.slice(0, 16);
    } else {
      console.error('[OSDP-SC] No server cryptogram found in SCRYPT packet');
      console.log('[OSDP-SC] Packet data:', packet.data ? packet.data.toString('hex') : 'none');
      console.log('[OSDP-SC] Security block:', JSON.stringify(packet.securityBlock));
      await this.sendAck(packet.address, packet.ctrl.sequence, portPath);
      return;
    }
    
    console.log('[OSDP-SC] Server Cryptogram received:', serverCryptogram.toString('hex').toUpperCase());
    
    const expectedCryptogram = this.security.generateServerCryptogram(
      session.rndA, 
      session.rndB, 
      session.sessionKeys.sEnc
    );
    
    console.log('[OSDP-SC] Expected Server Cryptogram:', expectedCryptogram.toString('hex').toUpperCase());
    
    if (!serverCryptogram.equals(expectedCryptogram)) {
      console.error('[OSDP-SC] ❌ Server cryptogram verification FAILED!');
      console.log('[OSDP-SC] This may indicate SCBK mismatch or crypto method mismatch');
      const nak = OSDPPacket.buildNAK(packet.address, 0x05, packet.ctrl.sequence);
      await this.sendRawData(nak, portPath);
      return;
    }
    
    console.log('[OSDP-SC] ✓ Server cryptogram verified!');
    
    const rmacInput = Buffer.alloc(16);
    session.rndA.copy(rmacInput, 0, 0, 8);
    session.rndB.copy(rmacInput, 8, 0, 8);
    const macCipher = crypto.createCipheriv('aes-128-ecb', session.sessionKeys.sMac1, null);
    macCipher.setAutoPadding(false);
    const rmacI = macCipher.update(rmacInput);
    console.log('[OSDP-SC] RMAC-I:', rmacI.toString('hex').toUpperCase());
    
    const cmacInput = Buffer.alloc(16);
    session.rndB.copy(cmacInput, 0, 0, 8);
    session.rndA.copy(cmacInput, 8, 0, 8);
    const cmacCipher = crypto.createCipheriv('aes-128-ecb', session.sessionKeys.sMac1, null);
    cmacCipher.setAutoPadding(false);
    const cmacI = cmacCipher.update(cmacInput);
    console.log('[OSDP-SC] CMAC-I:', cmacI.toString('hex').toUpperCase());
    
    session.established = true;
    session.rmacI = rmacI;
    session.cmacI = cmacI;
    session.lastRMAC = null;
    session.lastCMAC = null;
    session.rmacSent = false;
    reader.secureChannelEstablished = true;
    
    console.log('[OSDP-SC] ✓✓✓ Secure Channel ESTABLISHED for', reader.name, '(key:', sessionKey, ')');
    
    const reply = OSDPPacket.buildPacket({
      address: packet.address,
      command: 0x78,
      data: rmacI,
      sequence: packet.ctrl.sequence,
      isReply: true,
      useCRC: true,
      securityBlock: { type: 0x14, data: null }
    });
    
    console.log('[OSDP-SC] RMAC-I reply:', reply.toString('hex').toUpperCase());
    await this.sendRawData(reply, portPath);
  }

  async handleKeySet(packet, reader) {
    console.log(`[OSDP-SC] ===== KEYSET received for ${reader.name} =====`);
    
    const crypto = require('crypto');
    const portPath = reader.serialPort || '/dev/ttyACM0';
    const sessionKey = this._sessionKey(reader);
    
    const session = this.secureChannelSessions ? this.secureChannelSessions.get(sessionKey) : null;
    const isSecure = session && session.established;
    
    console.log('[OSDP-SC] Raw packet data:', packet.data ? packet.data.toString('hex').toUpperCase() : 'none');
    console.log('[OSDP-SC] Secure session active:', isSecure);
    console.log('[OSDP-SC] Data length:', packet.data ? packet.data.length : 0);
    
    let encryptedData = packet.data;
    if (packet.data && packet.data.length === 36) {
      console.log('[OSDP-SC] Detected possible embedded MAC, trying 32-byte payload');
      encryptedData = packet.data.slice(0, 32);
    } else if (packet.data && packet.data.length > 32) {
      console.log('[OSDP-SC] Data longer than expected, potential MAC at end');
      console.log('[OSDP-SC] Last 4 bytes:', packet.data.slice(-4).toString('hex').toUpperCase());
    }
    
    if (isSecure && encryptedData && encryptedData.length >= 16) {
      try {
        const aesEnc = (key, data) => {
          const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
          cipher.setAutoPadding(false);
          return cipher.update(data);
        };
        
        const deriveKeys8Byte = (scbk, rndA) => {
          const sEncInput = Buffer.alloc(16);
          sEncInput[0] = 0x01; sEncInput[1] = 0x82;
          rndA.copy(sEncInput, 2, 0, 8);
          const sMac1Input = Buffer.alloc(16);
          sMac1Input[0] = 0x01; sMac1Input[1] = 0x01;
          rndA.copy(sMac1Input, 2, 0, 8);
          const sMac2Input = Buffer.alloc(16);
          sMac2Input[0] = 0x01; sMac2Input[1] = 0x02;
          rndA.copy(sMac2Input, 2, 0, 8);
          return {
            sEnc: aesEnc(scbk, sEncInput),
            sMac1: aesEnc(scbk, sMac1Input),
            sMac2: aesEnc(scbk, sMac2Input)
          };
        };
        
        const altKeys = deriveKeys8Byte(session.scbk, session.rndA);
        const rndAB = Buffer.concat([session.rndA, session.rndB]);
        const rndBA = Buffer.concat([session.rndB, session.rndA]);
        const altRmacI = aesEnc(altKeys.sMac1, rndAB);
        const altCmacI = aesEnc(altKeys.sMac1, rndBA);
        
        const rmacIComplement = Buffer.alloc(16);
        for (let i = 0; i < 16; i++) rmacIComplement[i] = ~session.rmacI[i] & 0xFF;
        console.log('[OSDP-SC] ~RMAC-I (one\'s complement):', rmacIComplement.toString('hex').toUpperCase());
        
        const keys = [
          { name: 'S-ENC', key: session.sessionKeys.sEnc },
          { name: 'S-MAC1', key: session.sessionKeys.sMac1 },
          { name: 'Alt-S-ENC (8B)', key: altKeys.sEnc },
          { name: 'Alt-S-MAC1 (8B)', key: altKeys.sMac1 },
          { name: 'SCBK', key: session.scbk }
        ];
        
        const ivs = [
          { name: '~RMAC-I (spec)', iv: rmacIComplement },
          { name: 'zeros', iv: Buffer.alloc(16, 0) },
          { name: 'CMAC-I', iv: session.cmacI },
          { name: 'RMAC-I', iv: session.rmacI },
          { name: 'Alt-CMAC-I (8B)', iv: altCmacI },
          { name: 'Alt-RMAC-I (8B)', iv: altRmacI },
          { name: 'RND.A||RND.B', iv: rndAB },
          { name: 'RND.B||RND.A', iv: rndBA },
          { name: 'AES(S-ENC,0)', iv: aesEnc(session.sessionKeys.sEnc, Buffer.alloc(16, 0)) },
          { name: 'AES(S-MAC1,0)', iv: aesEnc(session.sessionKeys.sMac1, Buffer.alloc(16, 0)) },
          { name: 'AES(Alt-S-ENC,0)', iv: aesEnc(altKeys.sEnc, Buffer.alloc(16, 0)) },
          { name: 'AES(SCBK,0)', iv: aesEnc(session.scbk, Buffer.alloc(16, 0)) },
          { name: 'AES(S-MAC1,CMAC-I)', iv: aesEnc(session.sessionKeys.sMac1, session.cmacI) },
          { name: 'AES(S-MAC1,RMAC-I)', iv: aesEnc(session.sessionKeys.sMac1, session.rmacI) },
          { name: 'SCBK', iv: session.scbk },
          { name: 'cUID-padded', iv: Buffer.concat([session.cUID, Buffer.alloc(8, 0)]) },
          { name: 'RND.A-padded', iv: Buffer.concat([session.rndA, Buffer.alloc(8, 0)]) },
          { name: 'RND.B-padded', iv: Buffer.concat([session.rndB, Buffer.alloc(8, 0)]) },
          { name: 'AES(S-ENC,rndAB)', iv: aesEnc(session.sessionKeys.sEnc, rndAB) },
          { name: 'AES(S-ENC,rndBA)', iv: aesEnc(session.sessionKeys.sEnc, rndBA) },
          { name: 'AES(S-MAC1,rndAB)', iv: aesEnc(session.sessionKeys.sMac1, rndAB) },
          { name: 'AES(S-MAC1,rndBA)', iv: aesEnc(session.sessionKeys.sMac1, rndBA) },
          { name: 'S-ENC', iv: session.sessionKeys.sEnc },
          { name: 'S-MAC1', iv: session.sessionKeys.sMac1 },
          { name: 'S-MAC2', iv: session.sessionKeys.sMac2 },
        ];
        
        let successfulDecrypt = null;
        
        for (const keyOpt of keys) {
          for (const ivOpt of ivs) {
            try {
              const decipher = crypto.createDecipheriv('aes-128-cbc', keyOpt.key, ivOpt.iv);
              decipher.setAutoPadding(false);
              const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
              if (decrypted[0] === 0x01 && decrypted[1] === 0x10) {
                console.log(`[OSDP-SC] ✓✓✓ SUCCESS: Key=${keyOpt.name}, IV=${ivOpt.name}`);
                console.log(`[OSDP-SC] IV value: ${ivOpt.iv.toString('hex').toUpperCase()}`);
                successfulDecrypt = { keyOpt, ivOpt, decrypted };
                break;
              }
            } catch (e) {}
          }
          if (successfulDecrypt) break;
        }
        
        if (!successfulDecrypt) {
          for (const keyOpt of keys) {
            try {
              const decipher = crypto.createDecipheriv('aes-128-ecb', keyOpt.key, null);
              decipher.setAutoPadding(false);
              const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
              if (decrypted[0] === 0x01 && decrypted[1] === 0x10) {
                console.log(`[OSDP-SC] ✓✓✓ SUCCESS: Key=${keyOpt.name}, Mode=ECB`);
                successfulDecrypt = { keyOpt, ivOpt: { name: 'ECB-mode' }, decrypted };
                break;
              }
            } catch (e) {}
          }
        }
        
        if (!successfulDecrypt) {
          console.log('[OSDP-SC] All combinations failed, analyzing...');
          const block1 = encryptedData.slice(0, 16);
          const block2 = encryptedData.length >= 32 ? encryptedData.slice(16, 32) : null;
          const ecb = crypto.createDecipheriv('aes-128-ecb', session.sessionKeys.sEnc, null);
          ecb.setAutoPadding(false);
          const rawDec1 = ecb.update(block1);
          const neededIV0 = rawDec1[0] ^ 0x01;
          const neededIV1 = rawDec1[1] ^ 0x10;
          console.log('[OSDP-SC] ECB Dec(Block1):', rawDec1.toString('hex').toUpperCase());
          console.log('[OSDP-SC] Required IV starts with:', neededIV0.toString(16).padStart(2,'0').toUpperCase() + neededIV1.toString(16).padStart(2,'0').toUpperCase());
          
          let p2WithChaining = null;
          if (block2) {
            const ecb2 = crypto.createDecipheriv('aes-128-ecb', session.sessionKeys.sEnc, null);
            ecb2.setAutoPadding(false);
            const rawDec2 = ecb2.update(block2);
            p2WithChaining = Buffer.alloc(16);
            for (let i = 0; i < 16; i++) p2WithChaining[i] = rawDec2[i] ^ block1[i];
            console.log('[OSDP-SC] P2 (chained correctly):', p2WithChaining.toString('hex').toUpperCase());
          }
          
          if (p2WithChaining && p2WithChaining[2] === 0x80) {
            console.log('[OSDP-SC] ✓ Block 2 has valid padding (0x80 at position 2)');
            const scbkPart1 = rawDec1.slice(2, 16);
            const scbkPart2 = p2WithChaining.slice(0, 2);
            const extractedScbk = Buffer.concat([scbkPart1, scbkPart2]);
            console.log('[OSDP-SC] ✓ Extracting SCBK (assuming IV[2:16]=0):');
            console.log('[OSDP-SC]   Full SCBK:', extractedScbk.toString('hex').toUpperCase());
            console.log('[OSDP-SC] ✓✓✓ Storing extracted SCBK for', reader.name);
            reader.scbk = extractedScbk;
            reader.scbkConfigured = true;
            const cfgReader = this.config.readers.find(r => r.id === reader.id);
            if (cfgReader) {
              cfgReader.scbk = extractedScbk.toString('hex');
              cfgReader.scbkConfigured = true;
              setTimeout(() => this.saveConfig(), 2000);
              console.log('[OSDP-SC] ✓ SCBK saved to config');
            }
          }
          
          for (const ivOpt of ivs) {
            const prefix = ivOpt.iv.slice(0,2).toString('hex').toUpperCase();
            const match = (ivOpt.iv[0] === neededIV0 && ivOpt.iv[1] === neededIV1) ? ' <-- MATCH!' : '';
            console.log(`[OSDP-SC]   ${ivOpt.name}[0:2]: ${prefix}${match}`);
          }
        }
        
        if (successfulDecrypt) {
          const { decrypted } = successfulDecrypt;
          const newScbk = decrypted.slice(2, 18);
          console.log('[OSDP-SC] Decrypted payload:', decrypted.toString('hex').toUpperCase());
          console.log('[OSDP-SC] ✓ New SCBK:', newScbk.toString('hex').toUpperCase());
          reader.scbk = newScbk;
          reader.scbkConfigured = true;
          console.log('[OSDP-SC] ✓ SCBK stored for', reader.name);
          const cfgReader = this.config.readers.find(r => r.id === reader.id);
          if (cfgReader) {
            cfgReader.scbk = newScbk.toString('hex');
            cfgReader.scbkConfigured = true;
            setTimeout(() => this.saveConfig(), 2000);
          }
        } else {
          console.warn('[OSDP-SC] ⚠ Could not decrypt KEYSET');
        }
      } catch (err) {
        console.error('[OSDP-SC] Failed to decrypt KEYSET:', err.message);
      }
    }
    
    await this.sendSecureAck(reader.address, packet.ctrl.sequence, portPath, isSecure);
  }

  async sendCardRead(readerId, cardData, formatId = 'wiegand26') {
    console.log(`[OSDP] sendCardRead called with readerId='${readerId}'`);
    console.log(`[OSDP] Available readers:`, Array.from(this.readers.keys()));
    
    const reader = this.readers.get(readerId);
    if (!reader) {
      console.error(`[OSDP] Reader '${readerId}' not found in readers Map`);
      throw new Error(`Reader ${readerId} not found`);
    }
    if (!reader.enabled) throw new Error(`Reader ${readerId} is disabled`);

    console.log(`[OSDP] Queuing card read for ${reader.name} (Addr: 0x${reader.address.toString(16).padStart(2, '0')})`);
    console.log(`[OSDP] cardData received:`, JSON.stringify(cardData));

    const facility =
      cardData.facilityCode != null ? Number(cardData.facilityCode) :
      cardData.facility     != null ? Number(cardData.facility)     : 0;

    const card =
      cardData.cardNumber != null ? Number(cardData.cardNumber) :
      cardData.card       != null ? Number(cardData.card)       : 0;

    let bitCount = Number(cardData.bitCount);

    if (!bitCount || Number.isNaN(bitCount)) {
      const fmtKey = String(formatId || '').toLowerCase().trim();
      if (BUILTIN_FORMAT_BITS[fmtKey]) {
        bitCount = BUILTIN_FORMAT_BITS[fmtKey];
      } else {
        const match = (this.customFormats || []).find(f =>
          (f.id && String(f.id).toLowerCase() === fmtKey) ||
          (f.name && String(f.name).toLowerCase() === fmtKey)
        );
        if (match?.bitCount) bitCount = Number(match.bitCount);
      }
    }

    if (formatService && typeof formatService.getFormatById === 'function') {
      const sharedFormat = formatService.getFormatById(formatId);
      if (sharedFormat && sharedFormat.bits) {
        bitCount = sharedFormat.bits;
        console.log('[OSDP] Using formatService for', formatId, ':', bitCount, 'bits');
      }
    }

    if (!bitCount || Number.isNaN(bitCount)) {
      throw new Error(`Unknown/unsupported OSDP format '${formatId}'. Define it in custom-formats.json or use a built-in id.`);
    }

    console.log(`[OSDP] Format: ${formatId}, Facility: ${facility}, Card: ${card}, Bits: ${bitCount}`);

    reader.lastCard = {
      facility, card, bitCount,
      format: String(formatId).toLowerCase(),
      timestamp: Date.now(),
      reported: false
    };
    reader.status = 'card-pending';
    reader.lastActivity = new Date().toISOString();

    this.emit('card-queued', {
      readerId: reader.id, readerName: reader.name,
      address: reader.address, cardData: reader.lastCard
    });

    return { success: true, reader: reader.name, address: reader.address };
  }

  buildCardReadReply(address, cardData, sequence, isSecure = false, reader = null) {
    const OSDPPacket = require('./OSDPPacket');
    console.log(`[OSDP] buildCardReadReply called with cardData:`, JSON.stringify(cardData));
    console.log(`[OSDP] Secure mode: ${isSecure}`);
    
    if (!cardData.bitCount || isNaN(cardData.bitCount)) {
      console.error(`[OSDP] ERROR: Invalid cardData received in buildCardReadReply`);
      throw new Error(`Invalid bitCount in cardData: ${cardData.bitCount}.`);
    }
    
    const readerNumber = 0;
    const formatCode = 1;
    const bitCount = cardData.bitCount;
    
    let dataBytes;
    const formatId = cardData.format || 'w' + bitCount;
    
    try {
      const encoded = formatService.encodeCredential(
        formatId, cardData.facility || 0, cardData.card || 0, cardData.issueLevel || 0
      );
      dataBytes = encoded.bytes;
      console.log('[OSDP] Used formatService encoder:', encoded.formatId, '->', encoded.hex);
    } catch (err) {
      console.warn('[OSDP] formatService encoding failed, using legacy:', err.message);
      dataBytes = this._legacyEncode(cardData, bitCount);
    }

    const payload = Buffer.concat([
      Buffer.from([readerNumber, formatCode, bitCount & 0xFF, (bitCount >> 8) & 0xFF]),
      dataBytes
    ]);
    
    console.log(`[OSDP] Card payload (${payload.length} bytes):`, payload.toString('hex').toUpperCase());

    if (isSecure && reader) {
      const sessionKey = this._sessionKey(reader);
      if (this.secureChannelSessions && this.secureChannelSessions.has(sessionKey)) {
        const session = this.secureChannelSessions.get(sessionKey);
        console.log('[OSDP-SC] Building secure card read reply with MAC');
        return this.buildSecurePacket(address, 0x50, payload, sequence, session);
      }
    }

    return OSDPPacket.buildPacket({
      address, command: 0x50, data: payload, sequence, isReply: true, useCRC: true
    });
  }

  _buildWiegandBits(cardData, bitCount) {
    const facility8 = (cardData.facility ?? cardData.facilityCode ?? 0) & 0xFF;
    const card16 = (cardData.card ?? cardData.cardNumber ?? 0) & 0xFFFF;

    if (bitCount === 26) {
      const data24 = (facility8 << 16) | card16;
      const upper12 = (data24 >> 12) & 0xFFF;
      const lower12 = data24 & 0xFFF;
      const p1 = (this._popcnt(upper12) % 2 === 0) ? 0 : 1;
      const p2 = (this._popcnt(lower12) % 2 === 0) ? 1 : 0;
      const val = (p1 << 25) | (data24 << 1) | p2;
      return val >>> 0;
    }

    if (bitCount === 34) {
      const fac16 = (cardData.facility ?? cardData.facilityCode ?? 0) & 0xFFFF;
      const card16b = (cardData.card ?? cardData.cardNumber ?? 0) & 0xFFFF;
      const data32 = (fac16 << 16) | card16b;
      const upper16 = (data32 >> 16) & 0xFFFF;
      const lower16 = data32 & 0xFFFF;
      const p1 = (this._popcnt(upper16) % 2 === 0) ? 0 : 1;
      const p2 = (this._popcnt(lower16) % 2 === 0) ? 1 : 0;
      const val = (p1 << 33) | (data32 << 1) | p2;
      return Number(val);
    }

    if (bitCount === 37) {
      const fac16 = (cardData.facility ?? cardData.facilityCode ?? 0) & 0xFFFF;
      const card19 = (cardData.card ?? cardData.cardNumber ?? 0) & 0x7FFFF;
      const data35 = (BigInt(fac16) << 19n) | BigInt(card19);
      const upper18 = Number((data35 >> 17n) & 0x3FFFFn);
      const p1 = (this._popcnt(upper18) % 2 === 0) ? 0 : 1;
      const lower18 = Number(data35 & 0x3FFFFn);
      const p2 = (this._popcnt(lower18) % 2 === 0) ? 1 : 0;
      const val = (BigInt(p1) << 36n) | (data35 << 1n) | BigInt(p2);
      console.log(`[OSDP] 37-bit H10302: FC=${fac16}, Card=${card19}, EP=${p1}, OP=${p2}`);
      return val;
    }

    const combined = ((facility8 & 0xFF) << 16) | card16;
    if (bitCount >= 32) return combined >>> 0;
    const mask = (1 << bitCount) - 1;
    return combined & mask;
  }

  _popcnt(x) { let n = 0; while (x) { x &= (x - 1); n++; } return n; }

  // Fallback encoder used when formatService.encodeCredential() throws.
  // Was referenced by buildCardReadReply() but never defined, so a format
  // lookup failure produced a TypeError instead of a degraded card read.
  _legacyEncode(cardData, bitCount) {
    const bits = this._buildWiegandBits(cardData, bitCount);
    const big = (typeof bits === 'bigint') ? bits : BigInt(Math.trunc(Number(bits) || 0));
    const byteLen = Math.ceil(bitCount / 8);
    // OSDP raw card data is left-justified in the byte array.
    const shifted = big << BigInt(byteLen * 8 - bitCount);
    const out = Buffer.alloc(byteLen);
    for (let i = byteLen - 1; i >= 0; i--) {
      out[i] = Number((shifted >> BigInt((byteLen - 1 - i) * 8)) & 0xFFn);
    }
    console.warn(`[OSDP] Legacy encode used: ${bitCount}-bit -> ${out.toString('hex').toUpperCase()}`);
    return out;
  }

  setupReaders() {
    this.readers.clear();
    for (const readerCfg of this.config.readers) {
      if (readerCfg.enabled) {
        this.readers.set(readerCfg.id, {
          ...readerCfg,
          status: 'idle', lastCard: null, lastActivity: null,
          ledState: { red: 0, green: 0, amber: 0 }, buzzerState: false
        });
        console.log(`[OSDP] Loaded reader: ${readerCfg.name} (addr=${readerCfg.address}, port=${readerCfg.serialPort}, secure=${readerCfg.secureChannel})`);
      }
    }
  }

  getReaders() {
    return Array.from(this.readers.values()).map(r => ({
      id: r.id, name: r.name, address: r.address, serialPort: r.serialPort,
      virtualAddress: r.virtualAddress, enabled: r.enabled, status: r.status,
      capabilities: r.capabilities, secureChannel: r.secureChannel,
      secureChannelEstablished: r.secureChannelEstablished || false,
      lastActivity: r.lastActivity
    }));
  }

  getReader(readerId) {
    const r = this.readers.get(readerId);
    if (!r) return null;
    return {
      id: r.id, name: r.name, address: r.address, serialPort: r.serialPort,
      virtualAddress: r.virtualAddress, enabled: r.enabled, status: r.status,
      capabilities: r.capabilities, secureChannel: r.secureChannel,
      secureChannelEstablished: r.secureChannelEstablished || false,
      lastCard: r.lastCard, lastActivity: r.lastActivity,
      ledState: r.ledState, buzzerState: r.buzzerState
    };
  }

  getStatus() {
    return {
      initialized: this.initialized,
      serialPort: this.config.serialPort || '/dev/ttyACM0',
      baudRate: this.config.baudRate || 9600,
      readersCount: this.readers.size,
      dualAddressMode: true,
      stats: this.stats
    };
  }

  getStats() {
    return {
      ...this.stats,
      readers: this.readers.size,
      activeReaders: Array.from(this.readers.values()).filter(r => r.enabled).length
    };
  }

  getDetectedInterfaces() {
    // Shape must match what OSDPBusManager/OSDPSection consume:
    // { id, name, port, type, online, baudRate }.  It previously emitted
    // `path` instead of `port`, so every bus rendered blank.
    if (Array.isArray(this.detectedInterfaces) && this.detectedInterfaces.length) {
      return this.detectedInterfaces.map(i => ({
        ...i,
        online: !!(this.serialPorts.get(i.port) || {}).isOpen,
      }));
    }
    const interfaces = [];
    for (const [portPath, port] of this.serialPorts.entries()) {
      interfaces.push({
        id: portPath,
        name: this._ifaceName({ path: portPath }),
        port: portPath,
        type: (portPath.includes('ttyAMA') || portPath.includes('ttySC')) ? 'onboard' : 'usb',
        online: !!port.isOpen,
        baudRate: (this.config.serialPorts || []).find(s => s.port === portPath)?.baudRate || 9600,
        readers: Array.from(this.readers.values())
          .filter(r => r.serialPort === portPath).map(r => r.name),
      });
    }
    return interfaces;
  }

  getUSBHealth() {
    const now = Date.now();
    const results = [];
    for (const [portPath, port] of this.serialPorts.entries()) {
      if (!portPath.includes('ttyACM')) continue;
      const stats = this.portStats.get(portPath) || { lastRx: null, lastTx: null, rxCount: 0, txCount: 0, errors: 0 };
      const lastActivity = stats.lastRx || stats.lastTx;
      const timeSinceActivity = lastActivity ? now - lastActivity : null;
      let health = 'unknown';
      if (!port.isOpen) health = 'offline';
      else if (!lastActivity) health = 'waiting';
      else if (timeSinceActivity < 5000) health = 'online';
      else if (timeSinceActivity < 30000) health = 'idle';
      else health = 'stale';
      const readers = Array.from(this.readers.values())
        .filter(r => r.serialPort === portPath)
        .map(r => ({ id: r.id, name: r.name, address: r.address, secureChannel: r.secureChannelEstablished || false }));
      results.push({
        port: portPath, health, isOpen: port.isOpen, baudRate: port.baudRate || 9600,
        lastRx: stats.lastRx ? new Date(stats.lastRx).toISOString() : null,
        lastTx: stats.lastTx ? new Date(stats.lastTx).toISOString() : null,
        timeSinceActivityMs: timeSinceActivity,
        rxCount: stats.rxCount, txCount: stats.txCount, errors: stats.errors, readers
      });
    }
    return {
      timestamp: new Date().toISOString(),
      devices: results,
      summary: {
        total: results.length,
        online: results.filter(r => r.health === 'online').length,
        offline: results.filter(r => r.health === 'offline').length
      }
    };
  }

  _trackRx(portPath) {
    const stats = this.portStats.get(portPath) || { lastRx: null, lastTx: null, rxCount: 0, txCount: 0, errors: 0 };
    stats.lastRx = Date.now(); stats.rxCount++;
    this.portStats.set(portPath, stats);
  }

  _trackTx(portPath) {
    const stats = this.portStats.get(portPath) || { lastRx: null, lastTx: null, rxCount: 0, txCount: 0, errors: 0 };
    stats.lastTx = Date.now(); stats.txCount++;
    this.portStats.set(portPath, stats);
  }

  _trackError(portPath) {
    const stats = this.portStats.get(portPath) || { lastRx: null, lastTx: null, rxCount: 0, txCount: 0, errors: 0 };
    stats.errors++;
    this.portStats.set(portPath, stats);
  }

  async setLED(readerId, color, state, duration = 0) {
    const r = this.readers.get(readerId);
    if (!r) throw new Error(`Reader ${readerId} not found`);
    if (!r.capabilities.includes('LED')) throw new Error(`Reader ${readerId} does not support LED control`);
    console.log(`[OSDP] (local) ${color} LED ${state} on ${r.name}`);
    r.ledState[color] = state === 'on' ? 1 : 0;
    if (duration > 0) setTimeout(() => { r.ledState[color] = 0; }, duration);
    return { success: true };
  }

  async buzz(readerId, duration = 200) {
    const r = this.readers.get(readerId);
    if (!r) throw new Error(`Reader ${readerId} not found`);
    if (!r.capabilities.includes('BUZZER')) throw new Error(`Reader ${readerId} does not support buzzer control`);
    console.log(`[OSDP] (local) Buzz ${r.name} for ${duration}ms`);
    r.buzzerState = true;
    setTimeout(() => { r.buzzerState = false; }, duration);
    return { success: true };
  }

  async testReader(readerId) {
    const r = this.readers.get(readerId);
    if (!r) throw new Error(`Reader ${readerId} not found`);
    console.log(`[OSDP] Testing reader ${r.name}...`);
    await this.setLED(readerId, 'red', 'on', 300);
    await new Promise(res => setTimeout(res, 350));
    await this.setLED(readerId, 'green', 'on', 300);
    await new Promise(res => setTimeout(res, 350));
    await this.setLED(readerId, 'amber', 'on', 300);
    await this.buzz(readerId, 200);
    r.lastActivity = new Date().toISOString();
    return { success: true, message: 'Reader test complete', readerId: r.id, address: r.address };
  }

  async updateReader(readerId, updates) {
    const r = this.readers.get(readerId);
    if (!r) throw new Error(`Reader ${readerId} not found`);
    Object.assign(r, updates);
    const cfgReader = this.config.readers.find(rr => rr.id === readerId);
    if (cfgReader) { Object.assign(cfgReader, updates); await this.saveConfig(); }
    return this.getReader(readerId);
  }

  async sendKeypadData(readerId, keypadData, format = '8bit', facilityCode = 0) {
    console.log(`[OSDP] sendKeypadData called: readerId=${readerId}, data=${keypadData}, format=${format}`);
    const reader = this.readers.get(readerId);
    if (!reader) throw new Error(`Reader ${readerId} not found`);
    if (!reader.capabilities.includes('KEYPAD')) throw new Error(`Reader ${readerId} does not support keypad`);

    // Build queue of single-byte ASCII keys: digits=0x30..0x39, *=0x7F, #=0x0D (CR).
    // Empirically captured from real Hanwha-compatible keypad — vendor convention,
    // NOT OSDP 2.2 spec form (spec would be 0x00..0x09 for digits, 0x7E for #).
    // handlePoll dequeues one per poll cycle to mimic real keypad behavior.
    const queue = [];
    for (const ch of String(keypadData)) {
      if (ch >= '0' && ch <= '9') queue.push(ch.charCodeAt(0));
      else if (ch === '*')        queue.push(0x7F);
      else if (ch === '#')        queue.push(0x0D);
    }
    if (queue.length === 0) throw new Error('No valid keypad chars in input (expected 0-9, *, #)');
    // auto-append 0x0D (#) if caller didn't include a submit byte — panels need explicit submit
    if (queue[queue.length - 1] !== 0x0D) queue.push(0x0D);

    reader.keypadQueue  = queue;
    reader.lastKeypad   = { data: String(keypadData), format, facilityCode, timestamp: Date.now() };
    reader.status       = 'keypad-pending';
    reader.lastActivity = new Date().toISOString();

    this.emit('keypad-queued', { readerId: reader.id, readerName: reader.name, address: reader.address, keypadData: reader.lastKeypad });
    console.log(`[OSDP] ✓ Keypad queued for ${reader.name}: "${keypadData}" → ${queue.length} keys, sent one-per-poll`);
    return { success: true, reader: reader.name, address: reader.address, format, queued: queue.length };
  }

  buildKeypadReply(address, keypadData, sequence, isSecure = false, reader = null) {
    const OSDPPacket = require('./OSDPPacket');
    const format = keypadData.format || '8bit';
    const data = String(keypadData.data);
    let payload;
    switch (format) {
      case '4bit': payload = this.buildKeypad4Bit(data); break;
      case '8bit': payload = this.buildKeypad8Bit(data); break;
      case '26bit': payload = this.buildKeypad26Bit(data, keypadData.facilityCode || 0); break;
      default: payload = this.buildKeypad8Bit(data);
    }
    if (isSecure && reader) {
      const sessionKey = this._sessionKey(reader);
      if (this.secureChannelSessions && this.secureChannelSessions.has(sessionKey)) {
        const session = this.secureChannelSessions.get(sessionKey);
        return this.buildSecurePacket(address, 0x53, payload, sequence, session);
      }
    }
    return OSDPPacket.buildPacket({ address, command: 0x53, data: payload, sequence, isReply: true, useCRC: true });
  }

  buildKeypad4Bit(data) {
    const keyValues = [];
    for (const char of data) {
      if (char >= '0' && char <= '9') keyValues.push(parseInt(char, 10));
      else if (char === '*') keyValues.push(0x0A);
      else if (char === '#') keyValues.push(0x0B);
    }
    const packedBytes = [];
    for (let i = 0; i < keyValues.length; i += 2) {
      const high = keyValues[i] & 0x0F;
      const low = (i + 1 < keyValues.length) ? (keyValues[i + 1] & 0x0F) : 0;
      packedBytes.push((high << 4) | low);
    }
    console.log(`[OSDP] Building 4-bit keypad: digits="${data}", count=${keyValues.length}`);
    return Buffer.concat([Buffer.from([0, keyValues.length]), Buffer.from(packedBytes)]);
  }

  buildKeypad8Bit(data) {
    const keypadBytes = Buffer.from(String(data), 'utf8');
    console.log(`[OSDP] Building 8-bit keypad: digits="${data}", count=${keypadBytes.length}`);
    return Buffer.concat([Buffer.from([0, keypadBytes.length]), keypadBytes]);
  }

  buildKeypad26Bit(data, facilityCode) {
    const pin = parseInt(data.replace(/[^0-9]/g, ''), 10) || 0;
    const facility8 = facilityCode & 0xFF;
    const card16 = pin & 0xFFFF;
    const data24 = (facility8 << 16) | card16;
    const upper12 = (data24 >> 12) & 0xFFF;
    const lower12 = data24 & 0xFFF;
    const p1 = (this._popcnt(upper12) % 2 === 0) ? 0 : 1;
    const p2 = (this._popcnt(lower12) % 2 === 0) ? 1 : 0;
    const val26 = (p1 << 25) | (data24 << 1) | p2;
    const leftJustified = val26 << (32 - 26);
    const dataBytes = Buffer.alloc(4);
    dataBytes.writeUInt32BE(leftJustified, 0);
    return Buffer.concat([Buffer.from([0, 1, 26, 0]), dataBytes]);
  }

  async addReader(readerConfig) {
    const { name, address, serialPort, secureChannel, enabled, capabilities } = readerConfig;
    if (address < 0 || address > 126) throw new Error('Address must be between 0 and 126');
    const readerId = `osdp-reader-${Date.now()}`;
    const newReader = {
      id: readerId, name, address,
      serialPort: serialPort || '/dev/ttyACM0',
      enabled: enabled !== false,
      secureChannel: secureChannel || false,
      capabilities: capabilities || ['LED', 'BUZZER', 'CARD', 'KEYPAD'],
      status: 'idle', lastCard: null, lastKeypad: null, lastActivity: null,
      ledState: { red: 0, green: 0, amber: 0 }, buzzerState: false
    };
    this.readers.set(readerId, newReader);
    this.config.readers.push(newReader);
    await this.saveConfig();
    console.log(`[OSDP] Added reader: ${name} at address ${address} on ${serialPort}`);
    return newReader;
  }

  async deleteReader(readerId) {
    const reader = this.readers.get(readerId);
    if (!reader) throw new Error(`Reader ${readerId} not found`);
    this.readers.delete(readerId);
    const index = this.config.readers.findIndex(r => r.id === readerId);
    if (index >= 0) { this.config.readers.splice(index, 1); await this.saveConfig(); }
    console.log(`[OSDP] Deleted reader: ${reader.name}`);
    return { success: true, deleted: reader };
  }

  async initializeSerialPorts() {
    console.log('[OSDP] Initializing serial ports...');
    const uniquePorts = new Set();
    if (this.config.serialPorts) this.config.serialPorts.forEach(p => uniquePorts.add(p.port));
    this.config.readers.forEach(r => { if (r.serialPort && r.enabled) uniquePorts.add(r.serialPort); });

    for (const portPath of uniquePorts) {
      try {
        const baudRate = this.config.serialPorts?.find(p => p.port === portPath)?.baudRate || 9600;
        const serialPort = new SerialPort({
          path: portPath, baudRate, dataBits: 8, parity: 'none', stopBits: 1,
          autoOpen: false, rtscts: false, xon: false, xoff: false
        });
        await new Promise((resolve, reject) => {
          serialPort.open(err => {
            if (err) return reject(err);
            console.log(`[OSDP] ✓ Serial port ${portPath} opened @ ${baudRate} baud`);
            this._portCaps = this._portCaps || new Map();
            serialPort.set({ rts: false }, e => {
              this._portCaps.set(portPath, { rts: !e });
              if (e) console.log(`[OSDP] ${portPath}: hardware direction control (no RTS line)`);
            });
            resolve();
          });
        });
        serialPort.on('error', err => console.error(`[OSDP] Serial port ${portPath} error:`, err.message));
        serialPort.on('data', data => this.handleIncomingData(data, portPath));
        this.serialPorts.set(portPath, serialPort);
        console.log(`[OSDP] ✓ ${portPath} configured, listening for OSDP polls`);
      } catch (err) {
        console.warn(`[OSDP] ⚠ Could not open ${portPath}:`, err.message);
        console.warn(`[OSDP] ${portPath} will run in simulation mode`);
      }
    }
    console.log(`[OSDP] ✓ ${this.serialPorts.size} serial port(s) initialized`);
  }


  async changeBaudRate(port, baudRate) {
    const portPath = port || this.config.serialPort || '/dev/ttyACM0';
    console.log(`[OSDP] Changing baud on ${portPath} -> ${baudRate}`);

    // 1) Persist new baud in config + on readers using this port
    if (!Array.isArray(this.config.serialPorts)) this.config.serialPorts = [];
    const entry = this.config.serialPorts.find(p => p.port === portPath);
    if (entry) entry.baudRate = baudRate;
    else this.config.serialPorts.push({ port: portPath, baudRate });
    for (const r of (this.config.readers || [])) {
      if (r.serialPort === portPath) r.baudRate = baudRate;
    }

    // 2) Close the existing handle for just this port
    const existing = this.serialPorts.get(portPath);
    if (existing && existing.isOpen) {
      await new Promise(resolve => existing.close(() => resolve()));
    }
    this.serialPorts.delete(portPath);

    // 3) Reopen this one port at the new baud (mirrors initializeSerialPorts)
    const serialPort = new SerialPort({
      path: portPath, baudRate, dataBits: 8, parity: 'none', stopBits: 1,
      autoOpen: false, rtscts: false, xon: false, xoff: false
    });
    await new Promise((resolve, reject) => {
      serialPort.open(err => {
        if (err) return reject(err);
        console.log(`[OSDP] ✓ ${portPath} reopened @ ${baudRate} baud`);
        serialPort.set({ rts: false }, e => {
          if (e) console.warn(`[OSDP] Could not set RTS on ${portPath}:`, e.message);
        });
        resolve();
      });
    });
    serialPort.on('error', err => console.error(`[OSDP] Serial port ${portPath} error:`, err.message));
    serialPort.on('data', data => this.handleIncomingData(data, portPath));
    this.serialPorts.set(portPath, serialPort);

    // 4) Persist config
    await this.saveConfig();

    console.log(`[OSDP] ✓ Baud change complete on ${portPath}: ${baudRate}`);
    return { success: true, port: portPath, baudRate };
  }
  async resetToDefaultSCBK(readerId) {
    const reader = this.readers.get(readerId);
    if (!reader) {
      const readerByAddr = Array.from(this.readers.values()).find(r => r.address === readerId);
      if (!readerByAddr) throw new Error(`Reader ${readerId} not found`);
      return this.resetToDefaultSCBK(readerByAddr.id);
    }
    console.log(`[OSDP-SC] Resetting ${reader.name} (addr ${reader.address}) to SCBK-D`);
    delete reader.scbk;
    reader.scbkConfigured = false;
    const sessionKey = this._sessionKey(reader);
    if (this.secureChannelSessions && this.secureChannelSessions.has(sessionKey)) {
      this.secureChannelSessions.delete(sessionKey);
      console.log(`[OSDP-SC] Cleared secure session for ${sessionKey}`);
    }
    const cfgReader = this.config.readers.find(r => r.id === reader.id);
    if (cfgReader) {
      delete cfgReader.scbk;
      cfgReader.scbkConfigured = false;
      await this.saveConfig();
      console.log(`[OSDP-SC] Config updated - SCBK removed for ${reader.name}`);
    }
    console.log(`[OSDP-SC] ✓ ${reader.name} will now use SCBK-D (default key) on next CHLNG`);
    return {
      success: true, readerId: reader.id, readerName: reader.name, address: reader.address,
      message: `Reset to SCBK-D. Reader will use default key on next secure channel attempt.`
    };
  }

  async resetAllToDefaultSCBK() {
    const results = [];
    for (const [readerId] of this.readers) {
      try { results.push(await this.resetToDefaultSCBK(readerId)); }
      catch (err) { results.push({ readerId, error: err.message }); }
    }
    return { success: true, results };
  }

  getSCBKStatus() {
    const status = [];
    for (const [readerId, reader] of this.readers) {
      const sessionKey = this._sessionKey(reader);
      status.push({
        readerId: reader.id, readerName: reader.name, address: reader.address,
        serialPort: reader.serialPort, sessionKey,
        hasCustomSCBK: !!reader.scbkConfigured,
        scbkPreview: reader.scbk ? reader.scbk.toString('hex').substring(0, 8) + '...' : 'SCBK-D (default)',
        secureSessionActive: this.secureChannelSessions ? this.secureChannelSessions.has(sessionKey) : false
      });
    }
    return status;
  }

  async releasePort(portPath) {
    const port = this.serialPorts.get(portPath);
    if (!port) return { released: false, reason: 'not_open' };
    try {
      if (port.isOpen) {
        await new Promise(resolve => port.close(() => resolve()));
      }
    } catch (err) {
      console.warn(`[OSDP] Error closing ${portPath} for release:`, err.message);
    }
    this.serialPorts.delete(portPath);
    console.log(`[OSDP] Released ${portPath} (closed + removed from active map)`);
    return { released: true };
  }

  async reacquirePort(portPath) {
    if (this.serialPorts.has(portPath)) return { acquired: false, reason: 'already_open' };
    const baudRate = this.config.serialPorts?.find(p => p.port === portPath)?.baudRate || 9600;
    try {
      const { SerialPort } = require('serialport');
      const serialPort = new SerialPort({
        path: portPath, baudRate, dataBits: 8, parity: 'none', stopBits: 1,
        autoOpen: false, rtscts: false, xon: false, xoff: false
      });
      await new Promise((resolve, reject) => {
        serialPort.open(err => err ? reject(err) : resolve());
      });
      serialPort.set({ rts: false }, e => {
        if (e) console.warn(`[OSDP] RTS warning on ${portPath}:`, e.message);
      });
      serialPort.on('error', err => console.error(`[OSDP] Serial port ${portPath} error:`, err.message));
      serialPort.on('data', data => this.handleIncomingData(data, portPath));
      this.serialPorts.set(portPath, serialPort);
      console.log(`[OSDP] Re-acquired ${portPath} @ ${baudRate} baud`);
      return { acquired: true };
    } catch (err) {
      console.error(`[OSDP] Failed to reacquire ${portPath}:`, err.message);
      return { acquired: false, reason: err.message };
    }
  }

  getReadersOnPort(portPath) {
    return (this.config?.readers || [])
      .filter(r => r.serialPort === portPath)
      .map(r => ({
        id: r.id, name: r.name, address: r.address, enabled: !!r.enabled,
      }));
  }


  // ───────────────────────────────────────────────────────────────────────
  // Methods referenced by routes-osdp.js that were never implemented.
  // Without these, /detect, /security/keyset, /baudrate and the capture
  // endpoints all returned HTTP 500 — which the frontend swallowed silently.
  // ───────────────────────────────────────────────────────────────────────

  _ifaceName(p) {
    const path = p.path || '';
    if (path.includes('ttyAMA') || path.includes('ttySC')) return 'Onboard RS485 (' + path.split('/').pop() + ')';
    const mfr = p.manufacturer || '';
    if (/quad/i.test(p.product || '') || /quad/i.test(p.pnpId || '')) {
      const m = (p.pnpId || '').match(/-if(\d\d)/);
      const ch = m ? (parseInt(m[1], 10) / 2) + 1 : '?';
      return 'Quad RS485 ch' + ch;
    }
    if (mfr) return mfr + ' (' + path.split('/').pop() + ')';
    return path.split('/').pop();
  }

  // Rescan the host for serial interfaces. Backs the "Scan Interfaces" button.
  async detectInterfaces() {
    let list = [];
    try { list = await SerialPort.list(); } catch (e) {
      console.warn('[OSDP] SerialPort.list() failed:', e.message);
    }
    // SerialPort.list() does not always report onboard/HAT UARTs.
    for (const extra of ['/dev/ttyAMA0', '/dev/ttyAMA10', '/dev/ttySC0', '/dev/ttySC1']) {
      try {
        await fs.access(extra);
        if (!list.find(x => x.path === extra)) list.push({ path: extra, manufacturer: 'onboard' });
      } catch { /* not present */ }
    }
    const out = list
      .filter(p => p.path && !/ttyprintk|ttyS[0-9]$/.test(p.path))
      .map(p => {
        const open = this.serialPorts.get(p.path);
        return {
          id: p.pnpId || p.path,
          name: this._ifaceName(p),
          port: p.path,
          type: (p.path.includes('ttyAMA') || p.path.includes('ttySC')) ? 'onboard' : 'usb',
          online: !!(open && open.isOpen),
          baudRate: (this.config.serialPorts || []).find(s => s.port === p.path)?.baudRate || 9600,
          serialNumber: p.serialNumber || null,
          pnpId: p.pnpId || null,
          readers: Array.from(this.readers.values())
            .filter(r => r.serialPort === p.path).map(r => r.name),
        };
      });
    this.detectedInterfaces = out;
    console.log(`[OSDP] Detected ${out.length} interface(s): ` + out.map(i => i.port).join(', '));
    return out;
  }

  async openSerialPort(portPath, baudRate = 9600) {
    if (!Array.isArray(this.config.serialPorts)) this.config.serialPorts = [];
    const entry = this.config.serialPorts.find(p => p.port === portPath);
    if (entry) entry.baudRate = baudRate;
    else this.config.serialPorts.push({ port: portPath, baudRate });
    await this.releasePort(portPath);
    return this.reacquirePort(portPath);
  }

  async assignInterface(readerId, { port, baudRate = 9600 } = {}) {
    const r = this.readers.get(readerId);
    if (!r) throw new Error(`Reader ${readerId} not found`);
    r.serialPort = port;
    r.baudRate = baudRate;
    const cfg = this.config.readers.find(x => x.id === readerId);
    if (cfg) { cfg.serialPort = port; cfg.baudRate = baudRate; }
    if (!this.serialPorts.has(port)) await this.openSerialPort(port, baudRate);
    await this.saveConfig();
    return this.getReader(readerId);
  }

  getSecurityInfo() {
    return {
      scbk: this.getSCBKStatus(),
      activeSessions: Array.from(this.secureChannelSessions.entries()).map(([k, s]) => ({
        sessionKey: k, established: !!s.established,
      })),
    };
  }

  // Route passes an OSDP address, not a reader id.
  async setCustomSCBK(address, keyHex) {
    const hex = String(keyHex).replace(/[^0-9a-fA-F]/g, '');
    if (hex.length !== 32) throw new Error('SCBK must be 32 hex characters (16 bytes)');
    const addr = Number(address);
    const matches = Array.from(this.readers.values()).filter(r => r.address === addr);
    if (matches.length === 0) throw new Error(`No reader configured at address ${addr}`);
    const updated = [];
    for (const reader of matches) {
      reader.scbk = Buffer.from(hex, 'hex');
      reader.scbkConfigured = true;
      const cfg = this.config.readers.find(r => r.id === reader.id);
      if (cfg) { cfg.scbk = hex.toLowerCase(); cfg.scbkConfigured = true; }
      const sk = this._sessionKey(reader);
      if (this.secureChannelSessions.has(sk)) this.secureChannelSessions.delete(sk);
      updated.push({ readerId: reader.id, name: reader.name, port: reader.serialPort });
    }
    await this.saveConfig();
    console.log(`[OSDP-SC] SCBK set for address ${addr} (${updated.length} reader(s))`);
    return { address: addr, updated, note: 'Secure session cleared; new key applies on next CHLNG' };
  }

  async resetToDefaultKey(address) {
    const addr = Number(address);
    const matches = Array.from(this.readers.values()).filter(r => r.address === addr);
    if (matches.length === 0) throw new Error(`No reader configured at address ${addr}`);
    const results = [];
    for (const r of matches) results.push(await this.resetToDefaultSCBK(r.id));
    return { address: addr, results };
  }

  enableCaptureMode()  { this.debugWire = true;  return { success: true, capturing: true }; }
  disableCaptureMode() { this.debugWire = false; return { success: true, capturing: false }; }
  getCapturedPackets() {
    return { capturing: !!this.debugWire, packets: [],
      note: 'Frame capture is delivered live over the osdp-wire-frame socket event.' };
  }
  clearCapturedPackets() { return { success: true, cleared: 0 }; }

  // Output / text handlers — ACK rather than NAK (see routeCommand default).
  async handleOutputCommand(packet, reader) {
    if (this.debugWire) console.log(`[OSDP] Output command for ${reader.name}`);
    await this.sendSecureAck(packet.address, packet.ctrl.sequence,
      reader.serialPort || '/dev/ttyACM0', false);
  }

  async handleTextCommand(packet, reader) {
    if (this.debugWire) console.log(`[OSDP] Text command for ${reader.name}`);
    await this.sendSecureAck(packet.address, packet.ctrl.sequence,
      reader.serialPort || '/dev/ttyACM0', false);
  }

  async close() {
    console.log('[OSDP] Closing serial ports...');
    for (const [portPath, port] of this.serialPorts.entries()) {
      try {
        if (port.isOpen) { await new Promise((resolve) => port.close(resolve)); console.log(`[OSDP] Closed ${portPath}`); }
      } catch (err) { console.error(`[OSDP] Error closing ${portPath}:`, err.message); }
    }
    this.serialPorts.clear();
  }
}

module.exports = OSDPManager;
