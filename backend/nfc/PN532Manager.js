/**
 * PN532Manager.js - NFC Reader Manager using libnfc
 * 
 * FIXED VERSION - Polling disabled by default to prevent I2C bus saturation
 * 
 * The original version had autoStart: true and pollInterval: 500ms which
 * caused overnight lockups by continuously hammering the I2C bus.
 * 
 * Requirements:
 *   sudo apt install libnfc-bin libnfc-dev
 *   
 * Config file /etc/nfc/libnfc.conf:
 *   device.name = "PN532 over I2C"
 *   device.connstring = "pn532_i2c:/dev/i2c-1"
 */

const { spawn, execSync } = require('child_process');
const EventEmitter = require('events');

class PN532Manager extends EventEmitter {
  constructor(io, options = {}) {
    super();
    
    this.io = io;
    this.options = {
      pollInterval: 2000,       // ms between poll attempts (was 500 - too aggressive!)
      pollTimeout: 3,           // seconds for each nfc-poll (was 5)
      autoStart: false,         // ⚠️ DISABLED - was causing overnight lockups
      maxConsecutiveErrors: 10, // Stop polling after this many errors
      ...options
    };
    
    this.state = {
      connected: false,
      polling: false,
      enabled: false,
      lastUid: null,
      lastCard: null,
      lastScan: null,
      error: null
    };
    
    this.pollProcess = null;
    this.shouldPoll = false;
    this.consecutiveErrors = 0;
    
    this.stats = {
      cardsRead: 0,
      errors: 0,
      pollCycles: 0,
      startTime: null
    };
    
    // Only auto-start if explicitly enabled
    if (this.options.autoStart) {
      console.log('[PN532Manager] ⚠️ Auto-start enabled - this may cause I2C bus issues over time');
      this.init();
    } else {
      console.log('[PN532Manager] Initialized (polling disabled - use startPolling() to enable)');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // INITIALIZATION
  // ═══════════════════════════════════════════════════════════════════════

  async init() {
    console.log('[PN532Manager] Initializing with libnfc...');
    
    // Check if libnfc is installed
    try {
      execSync('which nfc-poll', { stdio: 'pipe' });
    } catch (err) {
      console.error('[PN532Manager] ✗ libnfc not installed. Run: sudo apt install libnfc-bin');
      this.state.error = 'libnfc not installed';
      return false;
    }
    
    // Check for NFC device
    const connected = this._checkConnection();
    
    if (connected) {
      console.log('[PN532Manager] ✓ PN532 detected via libnfc');
      this.state.enabled = true;
      this.stats.startTime = new Date().toISOString();
      
      // ⚠️ DO NOT auto-start polling - let user/API control it
      // this.startPolling();  // DISABLED
      console.log('[PN532Manager] ✓ Ready (polling NOT started - call startPolling() or POST /api/nfc/polling/start)');
      
      this.emit('ready');
      return true;
    } else {
      console.error('[PN532Manager] ✗ No NFC device found');
      this.state.error = 'No NFC device found';
      this.emit('error', new Error('No NFC device found'));
      return false;
    }
  }

  _checkConnection() {
    try {
      const result = execSync('nfc-scan-device 2>&1', { timeout: 5000 }).toString();
      this.state.connected = result.includes('NFC device') || result.includes('PN532') || result.includes('pn532');
      this.state.error = null;
      return this.state.connected;
    } catch (err) {
      this.state.connected = false;
      this.state.error = 'Device check failed';
      return false;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // POLLING
  // ═══════════════════════════════════════════════════════════════════════

  startPolling() {
    if (this.shouldPoll) {
      console.log('[PN532Manager] Already polling');
      return { success: true, message: 'Already polling' };
    }
    
    this.shouldPoll = true;
    this.state.enabled = true;
    this.consecutiveErrors = 0;
    console.log(`[PN532Manager] ✓ Started polling (interval: ${this.options.pollInterval}ms)`);
    
    this._pollLoop();
    return { success: true, message: 'Polling started' };
  }

  stopPolling() {
    this.shouldPoll = false;
    this.state.polling = false;
    
    if (this.pollProcess) {
      try {
        this.pollProcess.kill('SIGTERM');
      } catch (e) {}
      this.pollProcess = null;
    }
    
    console.log('[PN532Manager] Polling stopped');
    return { success: true, message: 'Polling stopped' };
  }

  async _pollLoop() {
    while (this.shouldPoll) {
      // Check if we've hit too many consecutive errors
      if (this.consecutiveErrors >= this.options.maxConsecutiveErrors) {
        console.error(`[PN532Manager] ✗ Too many errors (${this.consecutiveErrors}), stopping polling`);
        this.shouldPoll = false;
        this.state.error = 'Too many consecutive errors';
        this.emit('polling_stopped', { reason: 'errors', count: this.consecutiveErrors });
        break;
      }
      
      try {
        this.stats.pollCycles++;
        const card = await this._pollOnce();
        
        if (card) {
          this.consecutiveErrors = 0; // Reset on success
          this._handleCard(card);
          // Debounce: wait before next poll to avoid reading same card repeatedly
          await this._sleep(2000);
        }
      } catch (err) {
        // Timeout or no card - normal, just continue
        if (!err.message?.includes('timeout') && !err.message?.includes('No card')) {
          console.error('[PN532Manager] Poll error:', err.message);
          this.stats.errors++;
          this.consecutiveErrors++;
        }
      }
      
      // Delay between polls - this is critical for I2C bus health
      await this._sleep(this.options.pollInterval);
    }
    
    this.state.polling = false;
  }

  _pollOnce() {
    return new Promise((resolve, reject) => {
      this.state.polling = true;
      
      const proc = spawn('timeout', [String(this.options.pollTimeout), 'nfc-poll'], {
        stdio: ['ignore', 'pipe', 'pipe']
      });
      
      this.pollProcess = proc;
      let stdout = '';
      let stderr = '';
      
      proc.stdout.on('data', (data) => { stdout += data.toString(); });
      proc.stderr.on('data', (data) => { stderr += data.toString(); });
      
      proc.on('close', (code) => {
        this.state.polling = false;
        this.pollProcess = null;
        
        if (code === 124) {
          // Timeout - no card
          reject(new Error('timeout'));
          return;
        }
        
        const card = this._parseNfcOutput(stdout);
        if (card) {
          resolve(card);
        } else {
          reject(new Error('No card detected'));
        }
      });
      
      proc.on('error', (err) => {
        this.state.polling = false;
        this.pollProcess = null;
        reject(err);
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // MANUAL READ (for API calls)
  // ═══════════════════════════════════════════════════════════════════════

  async readCard(timeout = 10000) {
    // Temporarily stop continuous polling
    const wasPolling = this.shouldPoll;
    if (wasPolling) {
      this.stopPolling();
      await this._sleep(200);
    }
    
    return new Promise((resolve, reject) => {
      this.state.polling = true;
      
      const timeoutSec = Math.ceil(timeout / 1000);
      const proc = spawn('timeout', [String(timeoutSec), 'nfc-poll'], {
        stdio: ['ignore', 'pipe', 'pipe']
      });
      
      let stdout = '';
      
      proc.stdout.on('data', (data) => { stdout += data.toString(); });
      
      proc.on('close', (code) => {
        this.state.polling = false;
        
        // Restart continuous polling if it was running
        if (wasPolling) {
          this.startPolling();
        }
        
        if (code === 124) {
          reject(new Error('No card detected within timeout'));
          return;
        }
        
        const card = this._parseNfcOutput(stdout);
        if (card) {
          this._handleCard(card);
          resolve(card);
        } else {
          reject(new Error('Failed to read card'));
        }
      });
      
      proc.on('error', (err) => {
        this.state.polling = false;
        if (wasPolling) {
          this.startPolling();
        }
        reject(err);
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CARD HANDLING
  // ═══════════════════════════════════════════════════════════════════════

  _handleCard(card) {
    this.stats.cardsRead++;
    this.state.lastUid = card.uid;
    this.state.lastCard = card;
    this.state.lastScan = new Date().toISOString();
    
    console.log(`[PN532Manager] 📱 Card: ${card.uid} (${card.type})`);
    
    // Build event data compatible with NFCOSDPBridge
    const eventData = {
      uid: card.uid,
      cardType: card.type,
      cardNumber: parseInt(card.uid, 16),
      raw: card.uidBytes,
      uidBytes: card.uidBytes,
      atqa: card.atqa,
      sak: card.sak,
      timestamp: this.state.lastScan
    };
    
    // Emit events
    this.emit('card_read', eventData);      // For NFCOSDPBridge
    this.emit('nfc_card', eventData);       // Alternative event name
    this.emit('cardScanned', eventData);    // For NFCService compatibility
    
    // Emit via Socket.IO
    if (this.io && this.io.emit) {
      this.io.emit('nfc-card', eventData);
      this.io.emit('nfc_card_scanned', eventData);
    }
    
    return eventData;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PARSING
  // ═══════════════════════════════════════════════════════════════════════

  _parseNfcOutput(output) {
    const card = {
      uid: null,
      uidBytes: [],
      type: 'Unknown',
      atqa: null,
      sak: null
    };
    
    // Parse UID
    const uidMatch = output.match(/UID[^:]*:\s*([0-9a-fA-F\s]+)/);
    if (uidMatch) {
      const uidHex = uidMatch[1].trim().replace(/\s+/g, '');
      card.uid = uidHex.toUpperCase();
      card.uidBytes = uidHex.match(/.{2}/g)?.map(b => parseInt(b, 16)) || [];
    }
    
    // Parse ATQA
    const atqaMatch = output.match(/ATQA[^:]*:\s*([0-9a-fA-F\s]+)/);
    if (atqaMatch) {
      card.atqa = atqaMatch[1].trim().replace(/\s+/g, '').toUpperCase();
    }
    
    // Parse SAK
    const sakMatch = output.match(/SAK[^:]*:\s*([0-9a-fA-F\s]+)/);
    if (sakMatch) {
      card.sak = sakMatch[1].trim().replace(/\s+/g, '').toUpperCase();
    }
    
    // Determine card type from SAK
    if (card.sak) {
      card.type = this._getCardType(card.sak);
    }
    
    if (!card.uid || card.uid.length < 8) {
      return null;
    }
    
    return card;
  }

  _getCardType(sak) {
    const sakInt = parseInt(sak, 16);
    const types = {
      0x08: 'MIFARE Classic 1K',
      0x09: 'MIFARE Mini',
      0x18: 'MIFARE Classic 4K',
      0x00: 'MIFARE Ultralight / NTAG',
      0x20: 'MIFARE Plus / DESFire',
      0x28: 'JCOP',
      0x98: 'MIFARE Pro',
      0x88: 'MIFARE Classic 1K (Infineon)',
    };
    return types[sakInt] || `Unknown (SAK: ${sak})`;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CONFIGURATION
  // ═══════════════════════════════════════════════════════════════════════

  setConfig(newConfig) {
    if (newConfig.pollInterval !== undefined) {
      this.options.pollInterval = Math.max(1000, newConfig.pollInterval); // Minimum 1 second
    }
    if (newConfig.pollTimeout !== undefined) {
      this.options.pollTimeout = Math.max(1, Math.min(10, newConfig.pollTimeout));
    }
    if (newConfig.maxConsecutiveErrors !== undefined) {
      this.options.maxConsecutiveErrors = newConfig.maxConsecutiveErrors;
    }
    
    console.log('[PN532Manager] Config updated:', this.options);
    return this.options;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // UTILITY
  // ═══════════════════════════════════════════════════════════════════════

  _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════════

  getLastUid() {
    return this.state.lastUid;
  }

  getLastCard() {
    return this.state.lastCard;
  }

  getStatus() {
    return {
      connected: this.state.connected,
      enabled: this.state.enabled,
      polling: this.shouldPoll,
      activelyPolling: this.state.polling,
      lastUid: this.state.lastUid,
      lastScan: this.state.lastScan,
      error: this.state.error,
      config: this.options,
      stats: this.stats,
      consecutiveErrors: this.consecutiveErrors
    };
  }

  isConnected() {
    return this.state.connected;
  }

  isPolling() {
    return this.shouldPoll;
  }

  // Compatibility getter for NFCOSDPBridge
  get enabled() {
    return this.state.enabled && this.state.connected;
  }

  stop() {
    console.log('[PN532Manager] Stopping...');
    this.stopPolling();
    this.removeAllListeners();
  }

  // Alias for backward compatibility
  close() {
    this.stop();
  }
}

module.exports = PN532Manager;
