/**
 * RC522Manager.js - Pi 5 Compatible MFRC522 RFID Reader
 * 
 * Uses Hardware SPI (/dev/spidev0.0):
 *   MOSI = GPIO 10 (Pin 19)
 *   MISO = GPIO 9  (Pin 21)
 *   SCLK = GPIO 11 (Pin 23)
 *   CE0  = GPIO 8  (Pin 24)
 */

const EventEmitter = require('events');
const spi = require('spi-device');

// RC522 Commands
const CMD = {
  IDLE: 0x00,
  TRANSCEIVE: 0x0C,
  AUTHENT: 0x0E,
  RESETPHASE: 0x0F
};

// RC522 Registers
const REG = {
  COMMAND: 0x01,
  COMIEN: 0x02,
  COMIRQ: 0x04,
  ERROR: 0x06,
  FIFODATA: 0x09,
  FIFOLEVEL: 0x0A,
  BITFRAMING: 0x0D,
  MODE: 0x11,
  TXCONTROL: 0x14,
  TXASK: 0x15,
  VERSION: 0x37
};

class RC522Manager extends EventEmitter {
  constructor(options = {}) {
    super();
    
    this.config = {
      spiBus: options.spiBus || 0,
      spiDevice: options.spiDevice || 0,
      spiSpeed: options.spiSpeed || 1000000,
      pollInterval: options.pollInterval || 250,
      debounceMs: options.debounceMs || 2000,
      autoStart: options.autoStart !== false,
      ...options
    };
    
    this.device = null;
    this.polling = false;
    this.pollTimer = null;
    this.connected = false;
    this.lastUid = null;
    this.lastUidTime = 0;
    this.chipVersion = null;
    this.error = null;
    
    this.stats = {
      cardsRead: 0,
      errors: 0,
      startTime: null,
      lastScan: null
    };
  }

  async initialize() {
    return new Promise((resolve, reject) => {
      console.log('[RC522] Initializing on Pi 5 Hardware SPI...');
      
      this.device = spi.open(this.config.spiBus, this.config.spiDevice, (err) => {
        if (err) {
          this.error = err.message;
          console.error('[RC522] Failed to open SPI:', err.message);
          reject(err);
          return;
        }
        
        this.device.setOptions({
          mode: spi.MODE0,
          maxSpeedHz: this.config.spiSpeed
        }, async (err) => {
          if (err) {
            this.error = err.message;
            reject(err);
            return;
          }
          
          try {
            await this.reset();
            this.chipVersion = await this.getVersion();
            
            if (this.chipVersion === 0x00 || this.chipVersion === 0xFF) {
              throw new Error('RC522 not detected - check wiring');
            }
            
            this.connected = true;
            this.error = null;
            this.stats.startTime = new Date().toISOString();
            
            console.log(`[RC522] ✓ Initialized (chip version: 0x${this.chipVersion.toString(16)})`);
            this.emit('connected');
            
            if (this.config.autoStart) {
              this.startPolling();
            }
            
            resolve(true);
          } catch (e) {
            this.error = e.message;
            reject(e);
          }
        });
      });
    });
  }

  write(reg, val) {
    return new Promise((resolve, reject) => {
      const txBuf = Buffer.from([(reg << 1) & 0x7E, val]);
      const rxBuf = Buffer.alloc(2);
      
      this.device.transfer([{ sendBuffer: txBuf, receiveBuffer: rxBuf, byteLength: 2 }], (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  read(reg) {
    return new Promise((resolve, reject) => {
      const txBuf = Buffer.from([((reg << 1) & 0x7E) | 0x80, 0]);
      const rxBuf = Buffer.alloc(2);
      
      this.device.transfer([{ sendBuffer: txBuf, receiveBuffer: rxBuf, byteLength: 2 }], (err) => {
        if (err) reject(err);
        else resolve(rxBuf[1]);
      });
    });
  }

  async reset() {
    await this.write(REG.COMMAND, CMD.RESETPHASE);
    await new Promise(r => setTimeout(r, 50));
    await this.write(REG.TXASK, 0x40);
    await this.write(REG.MODE, 0x3D);
    await this.antennaOn();
  }

  async antennaOn() {
    const val = await this.read(REG.TXCONTROL);
    if ((val & 0x03) !== 0x03) {
      await this.write(REG.TXCONTROL, val | 0x03);
    }
  }

  async getVersion() {
    return await this.read(REG.VERSION);
  }

  async findCard() {
    await this.write(REG.BITFRAMING, 0x07);
    const result = await this.transceive([0x26]);
    
    if (result.status && result.data.length === 2) {
      return { status: true, bitSize: result.data[0] };
    }
    return { status: false };
  }

  async getUid() {
    await this.write(REG.BITFRAMING, 0x00);
    const result = await this.transceive([0x93, 0x20]);
    
    if (result.status && result.data.length === 5) {
      let check = 0;
      for (let i = 0; i < 4; i++) check ^= result.data[i];
      
      if (check === result.data[4]) {
        return { status: true, data: result.data.slice(0, 4) };
      }
    }
    return { status: false };
  }

  async transceive(data) {
    await this.write(REG.COMMAND, CMD.IDLE);
    await this.write(REG.COMIRQ, 0x7F);
    await this.write(REG.FIFOLEVEL, 0x80);
    
    for (const byte of data) {
      await this.write(REG.FIFODATA, byte);
    }
    
    await this.write(REG.COMMAND, CMD.TRANSCEIVE);
    const bitFraming = await this.read(REG.BITFRAMING);
    await this.write(REG.BITFRAMING, 0x80 | bitFraming);
    
    let timeout = 25;
    let irq = 0;
    
    while (timeout > 0) {
      irq = await this.read(REG.COMIRQ);
      if (irq & 0x30) break;
      if (irq & 0x01) return { status: false };
      await new Promise(r => setTimeout(r, 1));
      timeout--;
    }
    
    if (timeout === 0) return { status: false };
    
    const error = await this.read(REG.ERROR);
    if (error & 0x1B) return { status: false };
    
    const n = await this.read(REG.FIFOLEVEL);
    const result = [];
    
    for (let i = 0; i < n; i++) {
      result.push(await this.read(REG.FIFODATA));
    }
    
    return { status: true, data: result };
  }

  startPolling() {
    if (this.polling) return;
    
    this.polling = true;
    console.log(`[RC522] Starting polling (interval: ${this.config.pollInterval}ms)`);
    
    this.pollTimer = setInterval(() => this._pollOnce(), this.config.pollInterval);
    this.emit('polling_started');
  }

  stopPolling() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.polling = false;
    console.log('[RC522] Polling stopped');
    this.emit('polling_stopped');
  }

  async _pollOnce() {
    if (!this.device) return;
    
    try {
      const card = await this.findCard();
      if (!card.status) return;
      
      const uid = await this.getUid();
      if (!uid.status) return;
      
      const uidStr = uid.data.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join('');
      
      // Debounce
      const now = Date.now();
      if (uidStr === this.lastUid && (now - this.lastUidTime) < this.config.debounceMs) {
        return;
      }
      
      this.lastUid = uidStr;
      this.lastUidTime = now;
      this.stats.cardsRead++;
      this.stats.lastScan = new Date().toISOString();
      
      const cardData = {
        uid: uidStr,
        uidFormatted: uid.data.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(':'),
        uidBytes: uid.data,
        type: 'MIFARE',
        reader: 'rc522',
        timestamp: this.stats.lastScan
      };
      
      console.log(`[RC522] Card detected: ${cardData.uidFormatted}`);
      this.emit('card', cardData);
      
    } catch (e) {
      this.stats.errors++;
    }
  }

  async readCard(timeout = 10000) {
    return new Promise((resolve, reject) => {
      const startTime = Date.now();
      
      const check = async () => {
        try {
          const card = await this.findCard();
          if (card.status) {
            const uid = await this.getUid();
            if (uid.status) {
              const uidStr = uid.data.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join('');
              
              resolve({
                uid: uidStr,
                uidFormatted: uid.data.map(b => b.toString(16).padStart(2, '0').toUpperCase()).join(':'),
                uidBytes: uid.data,
                type: 'MIFARE',
                reader: 'rc522',
                timestamp: new Date().toISOString()
              });
              return;
            }
          }
          
          if (Date.now() - startTime > timeout) {
            reject(new Error('Read timeout'));
            return;
          }
          
          setTimeout(check, 100);
        } catch (e) {
          reject(e);
        }
      };
      
      check();
    });
  }

  getStatus() {
    return {
      connected: this.connected,
      polling: this.polling,
      lastUid: this.lastUid,
      lastScan: this.stats.lastScan,
      chipVersion: this.chipVersion ? `0x${this.chipVersion.toString(16)}` : null,
      error: this.error,
      stats: { ...this.stats },
      interface: 'hardware_spi',
      device: `/dev/spidev${this.config.spiBus}.${this.config.spiDevice}`
    };
  }

  stop() {
    this.stopPolling();
    
    if (this.device) {
      this.device.close(() => {});
      this.device = null;
    }
    
    this.connected = false;
    console.log('[RC522] Stopped');
    this.emit('disconnected');
  }
}

module.exports = RC522Manager;
