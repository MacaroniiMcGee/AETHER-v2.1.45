/**
 * NFCOSDPBridge.js - Bridge NFC card reads to OSDP and/or Wiegand outputs
 * 
 * Updated to work with the new libnfc-based PN532Manager.
 * 
 * Features:
 * - Routes NFC card reads to OSDP readers (via RS485)
 * - Routes NFC card reads to Wiegand outputs (GPIO)
 * - Configurable output target (OSDP, Wiegand, or both)
 * - Format conversion (26-bit, 34-bit, etc.)
 */

const EventEmitter = require('events');
const { spawn } = require('child_process');
const path = require('path');

class NFCOSDPBridge extends EventEmitter {
  constructor(options = {}) {
    super();
    
    // Managers (injected or set later)
    this.nfcManager = options.nfcManager || null;
    this.osdpManager = options.osdpManager || null;
    this.wiegandTxPath = options.wiegandTxPath || path.join(__dirname, 'bin', 'wiegand_tx');
    this.io = options.io || null;
    
    this.enabled = false;
    
    // Configuration
    this.config = {
      // Output mode: 'osdp', 'wiegand', 'both', 'none'
      outputMode: 'wiegand',
      
      // OSDP settings
      osdpReaderId: 'reader-0',
      
      // Wiegand settings
      wiegandDoor: 1,              // Door number (1-4)
      wiegandD0: 12,               // GPIO pin for D0
      wiegandD1: 13,               // GPIO pin for D1
      wiegandPulseUs: 50,          // Pulse width in microseconds
      
      // Format settings
      format: 26,                  // Wiegand format (26, 32, 34, 35, 37)
      defaultFacilityCode: 0,      // Default FC if not derived from UID
      
      // Behavior
      autoEnable: true,
      debounceMs: 2000,            // Minimum time between same card reads
      
      ...options.config
    };
    
    this.stats = {
      cardsRead: 0,
      cardsSentOsdp: 0,
      cardsSentWiegand: 0,
      errors: 0,
      lastCard: null,
      lastSent: null,
      lastError: null
    };
    
    this.lastCardTime = 0;
    this.lastCardUid = null;
    
    console.log('[NFC-Bridge] Initialized');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // INITIALIZATION
  // ═══════════════════════════════════════════════════════════════════════

  setNFCManager(nfcManager) {
    this.nfcManager = nfcManager;
    this._attachListeners();
  }

  setOSDPManager(osdpManager) {
    this.osdpManager = osdpManager;
  }

  setIO(io) {
    this.io = io;
  }

  async initialize() {
    if (!this.nfcManager) {
      console.warn('[NFC-Bridge] NFC Manager not set');
      return false;
    }
    
    this._attachListeners();
    
    if (this.config.autoEnable) {
      this.enable();
    }
    
    console.log('[NFC-Bridge] ✓ Initialized');
    console.log(`[NFC-Bridge]   Output mode: ${this.config.outputMode}`);
    console.log(`[NFC-Bridge]   Format: ${this.config.format}-bit`);
    
    return true;
  }

  _attachListeners() {
    if (!this.nfcManager) return;
    
    // Remove existing listeners to avoid duplicates
    this.nfcManager.removeAllListeners('card_read');
    this.nfcManager.removeAllListeners('nfc_card');
    
    // Listen for card reads from PN532Manager
    this.nfcManager.on('card_read', (card) => this._handleCard(card));
    this.nfcManager.on('nfc_card', (card) => this._handleCard(card));
    
    console.log('[NFC-Bridge] ✓ Attached to NFC Manager events');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CONTROL
  // ═══════════════════════════════════════════════════════════════════════

  enable() {
    this.enabled = true;
    console.log('[NFC-Bridge] ✓ Enabled - cards will be routed to outputs');
    this.emit('enabled');
  }

  disable() {
    this.enabled = false;
    console.log('[NFC-Bridge] Disabled');
    this.emit('disabled');
  }

  setConfig(newConfig) {
    this.config = { ...this.config, ...newConfig };
    console.log('[NFC-Bridge] Config updated:', this.config);
    this.emit('configChanged', this.config);
    return this.config;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CARD HANDLING
  // ═══════════════════════════════════════════════════════════════════════

  async _handleCard(cardEvent) {
    if (!this.enabled) {
      return;
    }
    
    // Debounce: ignore same card within debounce period
    const now = Date.now();
    if (cardEvent.uid === this.lastCardUid && (now - this.lastCardTime) < this.config.debounceMs) {
      return;
    }
    
    this.lastCardUid = cardEvent.uid;
    this.lastCardTime = now;
    this.stats.cardsRead++;
    this.stats.lastCard = cardEvent;
    
    console.log(`[NFC-Bridge] 📱 Card: ${cardEvent.uid}`);
    
    try {
      // Convert to Wiegand format
      const converted = this._convertCard(cardEvent);
      
      console.log(`[NFC-Bridge]   → FC: ${converted.facility}, Card: ${converted.card}, Format: W${converted.format}`);
      
      // Route to outputs based on mode
      const results = { osdp: null, wiegand: null };
      
      if (this.config.outputMode === 'osdp' || this.config.outputMode === 'both') {
        results.osdp = await this._sendToOSDP(converted);
      }
      
      if (this.config.outputMode === 'wiegand' || this.config.outputMode === 'both') {
        results.wiegand = await this._sendToWiegand(converted);
      }
      
      this.stats.lastSent = new Date().toISOString();
      
      // Emit success
      this.emit('card_sent', {
        card: cardEvent,
        converted,
        results,
        timestamp: this.stats.lastSent
      });
      
      // Socket.IO broadcast
      if (this.io) {
        this.io.emit('nfc_card_routed', {
          uid: cardEvent.uid,
          facility: converted.facility,
          card: converted.card,
          format: converted.format,
          outputs: results,
          timestamp: this.stats.lastSent
        });
      }
      
    } catch (err) {
      this.stats.errors++;
      this.stats.lastError = err.message;
      console.error('[NFC-Bridge] Error:', err.message);
      this.emit('error', { error: err.message, card: cardEvent });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CONVERSION
  // ═══════════════════════════════════════════════════════════════════════

  _convertCard(card) {
    const uid = card.uid;
    const bytes = card.raw || card.uidBytes || uid.match(/.{2}/g)?.map(b => parseInt(b, 16)) || [];
    const uidInt = parseInt(uid, 16);
    
    let facility = this.config.defaultFacilityCode;
    let cardNumber = 0;
    
    switch (this.config.format) {
      case 26:
        // W26: 8-bit facility, 16-bit card
        facility = bytes[0] || 0;
        cardNumber = ((bytes[1] || 0) << 8) | (bytes[2] || 0);
        facility = facility & 0xFF;
        cardNumber = cardNumber & 0xFFFF;
        break;
        
      case 32:
        // W32: No facility, 32-bit card
        facility = 0;
        cardNumber = uidInt & 0xFFFFFFFF;
        break;
        
      case 34:
        // W34: 16-bit facility, 16-bit card
        facility = ((bytes[0] || 0) << 8) | (bytes[1] || 0);
        cardNumber = ((bytes[2] || 0) << 8) | (bytes[3] || 0);
        facility = facility & 0xFFFF;
        cardNumber = cardNumber & 0xFFFF;
        break;
        
      case 35:
        // W35 HID Corp 1000: 12-bit facility, 20-bit card
        facility = ((bytes[0] || 0) << 4) | ((bytes[1] || 0) >> 4);
        cardNumber = ((bytes[1] & 0x0F) << 16) | ((bytes[2] || 0) << 8) | (bytes[3] || 0);
        facility = facility & 0xFFF;
        cardNumber = cardNumber & 0xFFFFF;
        break;
        
      case 37:
        // W37: 16-bit facility, 19-bit card
        facility = ((bytes[0] || 0) << 8) | (bytes[1] || 0);
        cardNumber = ((bytes[2] || 0) << 11) | ((bytes[3] || 0) << 3);
        facility = facility & 0xFFFF;
        cardNumber = cardNumber & 0x7FFFF;
        break;
        
      default:
        // Default to 26-bit
        facility = bytes[0] || 0;
        cardNumber = ((bytes[1] || 0) << 8) | (bytes[2] || 0);
        facility = facility & 0xFF;
        cardNumber = cardNumber & 0xFFFF;
    }
    
    return {
      uid,
      facility,
      card: cardNumber,
      format: this.config.format,
      uidDecimal: uidInt
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // OUTPUT: WIEGAND
  // ═══════════════════════════════════════════════════════════════════════

  async _sendToWiegand(converted) {
    const { facility, card, format } = converted;
    const { wiegandD0, wiegandD1, wiegandPulseUs } = this.config;
    
    console.log(`[NFC-Bridge] → Wiegand GPIO ${wiegandD0}/${wiegandD1}`);
    
    return new Promise((resolve, reject) => {
      const args = [
        String(wiegandD0),
        String(wiegandD1),
        String(facility),
        String(card),
        String(format),
        String(wiegandPulseUs)
      ];
      
      const proc = spawn(this.wiegandTxPath, args, {
        stdio: ['ignore', 'pipe', 'pipe']
      });
      
      let stdout = '';
      let stderr = '';
      
      proc.stdout.on('data', d => stdout += d.toString());
      proc.stderr.on('data', d => stderr += d.toString());
      
      proc.on('close', (code) => {
        if (code === 0) {
          this.stats.cardsSentWiegand++;
          console.log('[NFC-Bridge] ✓ Wiegand TX complete');
          resolve({ success: true, output: stdout.trim() });
        } else {
          reject(new Error(stderr || `Wiegand TX failed (exit ${code})`));
        }
      });
      
      proc.on('error', (err) => {
        reject(new Error(`Wiegand TX spawn failed: ${err.message}`));
      });
    });
  }

  // ═══════════════════════════════════════════════════════════════════════
  // OUTPUT: OSDP
  // ═══════════════════════════════════════════════════════════════════════

  async _sendToOSDP(converted) {
    if (!this.osdpManager) {
      throw new Error('OSDP Manager not available');
    }
    
    const { facility, card, format } = converted;
    const readerId = this.config.osdpReaderId;
    
    console.log(`[NFC-Bridge] → OSDP Reader: ${readerId}`);
    
    // Try different method names that OSDP managers might use
    let result;
    
    if (typeof this.osdpManager.sendCardRead === 'function') {
      result = await this.osdpManager.sendCardRead(readerId, { facility, card }, format);
    } else if (typeof this.osdpManager.sendCard === 'function') {
      result = await this.osdpManager.sendCard(readerId, { facility, card, format });
    } else if (typeof this.osdpManager.emulateCard === 'function') {
      result = await this.osdpManager.emulateCard(readerId, facility, card, format);
    } else {
      throw new Error('OSDP Manager has no card send method');
    }
    
    if (result && result.success !== false) {
      this.stats.cardsSentOsdp++;
      console.log('[NFC-Bridge] ✓ OSDP card sent');
      return { success: true, result };
    } else {
      throw new Error(result?.error || 'OSDP send failed');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // MANUAL SEND
  // ═══════════════════════════════════════════════════════════════════════

  async sendCard(uid, options = {}) {
    const cardEvent = {
      uid: uid.toUpperCase().replace(/[:\s-]/g, ''),
      raw: uid.replace(/[:\s-]/g, '').match(/.{2}/g)?.map(b => parseInt(b, 16)) || [],
      cardType: 'Manual',
      timestamp: new Date().toISOString()
    };
    
    // Temporarily override config if options provided
    const originalConfig = { ...this.config };
    if (options.format) this.config.format = options.format;
    if (options.outputMode) this.config.outputMode = options.outputMode;
    if (options.wiegandD0) this.config.wiegandD0 = options.wiegandD0;
    if (options.wiegandD1) this.config.wiegandD1 = options.wiegandD1;
    if (options.osdpReaderId) this.config.osdpReaderId = options.osdpReaderId;
    
    try {
      // Force enabled for manual send
      const wasEnabled = this.enabled;
      this.enabled = true;
      
      await this._handleCard(cardEvent);
      
      this.enabled = wasEnabled;
    } finally {
      // Restore original config
      this.config = originalConfig;
    }
    
    return { success: true, uid: cardEvent.uid };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STATUS
  // ═══════════════════════════════════════════════════════════════════════

  getStats() {
    return {
      ...this.stats,
      enabled: this.enabled,
      config: this.config,
      nfcConnected: this.nfcManager?.enabled || this.nfcManager?.state?.connected || false,
      osdpConnected: this.osdpManager?.serialPortOpen || false
    };
  }

  getConfig() {
    return { ...this.config };
  }

  async testConnection() {
    const nfcOk = this.nfcManager && (this.nfcManager.enabled || this.nfcManager.state?.connected);
    const osdpOk = this.osdpManager && this.osdpManager.serialPortOpen;
    
    console.log('[NFC-Bridge] Connection test:');
    console.log(`  NFC: ${nfcOk ? '✓' : '✗'}`);
    console.log(`  OSDP: ${osdpOk ? '✓' : '✗'}`);
    console.log(`  Bridge: ${this.enabled ? 'Enabled' : 'Disabled'}`);
    
    return { nfc: nfcOk, osdp: osdpOk, bridge: this.enabled };
  }
}

module.exports = NFCOSDPBridge;
