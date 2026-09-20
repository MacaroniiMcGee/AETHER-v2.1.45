/**
 * WiegandManager.js - UNIFIED VERSION
 * 
 * THIS VERSION USES formatService.js FOR ALL FORMAT LOOKUPS
 * Supports all 64+ formats including no-facility variants (h10302, wl37_1, etc.)
 * 
 * Changes from original:
 *   - sendCard() now accepts formatId string (e.g., 'h10302') not just bit count
 *   - _encodeWiegand() uses formatService instead of switch statement
 *   - Supports no-facility formats where FC=0
 *   - All 12 individual _encodeW* functions replaced with single generic encoder
 */

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

// UNIFIED: Import formatService for all format lookups
const formatService = require('../lib/formatService');

/**
 * WiegandManager - Handles Wiegand card credential transmission
 * UNIFIED VERSION - Uses formatService for all format definitions
 */
class WiegandManager {
  constructor(configPath = null) {
    this.configPath = configPath || path.join(__dirname, 'wiegand-config.json');
    this.config = null;
    this.readers = [];
    this.reservedPins = new Set();
    this.chip = 'gpiochip0';
    this.initialized = false;
    
    // Wiegand timing constants (in microseconds)
    this.PULSE_WIDTH = 50;       // 50μs pulse width
    this.PULSE_INTERVAL = 2000;  // 2ms between pulses (2000μs)
  }

  /**
   * Initialize the Wiegand manager
   */
  async initialize() {
    console.log('[WiegandManager] Initializing...');
    
    try {
      // Load configuration
      await this._loadConfig();
      
      // Verify libgpiod is available
      await this._verifyGPIO();
      
      this.initialized = true;
      
      // Log format service status
      const status = formatService.getStatus();
      console.log(`[WiegandManager] Initialized with ${this.readers.length} readers`);
      console.log(`[WiegandManager] Format service: ${status.totalFormats} formats loaded`);
      
      return true;
    } catch (error) {
      console.error('[WiegandManager] Initialization failed:', error.message);
      throw error;
    }
  }

  /**
   * Load configuration from file
   */
  async _loadConfig() {
    try {
      const data = await fs.promises.readFile(this.configPath, 'utf8');
      this.config = JSON.parse(data);
      
      this.chip = this.config.chip || 'gpiochip0';
      
      // Accept both "readers" and "emulatedReaders" property names
      const rawReaders = this.config.readers || this.config.emulatedReaders || [];
      
      // Normalize reader structure
      this.readers = rawReaders.map((reader, index) => {
        let doorNum = reader.door;
        if (typeof doorNum === 'string') {
          const match = doorNum.match(/(\d+)/);
          doorNum = match ? parseInt(match[1], 10) : (index + 1);
        }
        
        return {
          ...reader,
          id: reader.id || `reader-${index + 1}`,
          door: doorNum,
          name: reader.name || `Reader ${index + 1}`,
          pins: reader.pins || reader.txPins || null,
          txPins: reader.txPins || reader.pins || null
        };
      });
      
      // Build reserved pins set
      for (const reader of this.readers) {
        if (reader.pins) {
          this.reservedPins.add(Number(reader.pins.d0));
          this.reservedPins.add(Number(reader.pins.d1));
        }
      }
      
      console.log(`[WiegandManager] Loaded config: ${this.readers.length} readers`);
      
    } catch (error) {
      console.error('[WiegandManager] Config load error:', error.message);
      // Create minimal default config
      this.readers = [];
    }
  }

  /**
   * Verify GPIO tools are available
   */
  async _verifyGPIO() {
    try {
      await execAsync('which gpioset');
      console.log('[WiegandManager] GPIO tools verified');
    } catch (error) {
      console.warn('[WiegandManager] Warning: gpioset not found, using wiegand_tx binary');
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  // UNIFIED CARD TRANSMISSION
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * Send a card credential
   * 
   * UNIFIED: Now accepts formatId (string) OR format (number)
   * 
   * @param {string|number} readerId - Reader ID or door number
   * @param {number} facility - Facility code (use 0 for no-FC formats)
   * @param {number} card - Card number
   * @param {string|number|null} format - Format:
   *   - String: format ID ('w37', 'h10302', 'wl37_1') - PREFERRED
   *   - Number: bit count (26, 37, etc.) - uses default variant
   *   - null: defaults to W26
   * 
   * @example
   * // Standard W37 (FC:16, Card:19)
   * await sendCard('reader1', 123, 45678, 'w37');
   * await sendCard('reader1', 123, 45678, 37);  // Same as above
   * 
   * // H10302 - 37-bit with NO facility code
   * await sendCard('reader1', 0, 123456789, 'h10302');
   * 
   * // Wavelynx W37-1 - 37-bit with NO facility code
   * await sendCard('reader1', 0, 987654321, 'wl37_1');
   */
  async sendCard(readerId, facility, card, format = null) {
    if (!this.initialized) {
      throw new Error('WiegandManager not initialized');
    }

    // Find the reader
    const reader = this.getReader(readerId);
    if (!reader) {
      const available = this.readers.map(r => `${r.id}(door=${r.door})`).join(', ');
      throw new Error(`Reader "${readerId}" not found. Available: ${available}`);
    }

    const txPins = reader.txPins || reader.pins;
    if (!txPins) {
      throw new Error(`Reader "${readerId}" has no pin configuration`);
    }

    // Resolve format
    let fmt;
    let formatId;
    
    if (format === null) {
      // Default to W26
      fmt = formatService.getFormatById('w26');
      formatId = 'w26';
    } else if (typeof format === 'string') {
      // Format ID provided (e.g., 'h10302', 'wl37_1')
      fmt = formatService.getFormatById(format);
      if (!fmt) {
        const available = formatService.getAllFormats().slice(0, 10).map(f => f.id).join(', ');
        throw new Error(`Unknown format ID: ${format}. Examples: ${available}...`);
      }
      formatId = fmt.id;
    } else if (typeof format === 'number') {
      // Bit count provided - use default variant
      fmt = formatService.getFormatByBits(format);
      if (!fmt) {
        const supported = formatService.getSupportedBitCounts().join(', ');
        throw new Error(`Unsupported bit count: ${format}. Supported: ${supported}`);
      }
      formatId = fmt.id;
      
      // Warn about multiple variants
      if (formatService.hasMultipleVariants(format)) {
        const variants = formatService.getFormatVariants(format).map(v => v.id).join(', ');
        console.warn(`[WiegandManager] Note: ${format}-bit has variants (${variants}). Using '${formatId}'.`);
      }
    } else {
      throw new Error('Format must be a string (format ID), number (bit count), or null');
    }

    // Validate credential
    const validation = formatService.validateCredential(formatId, facility, card);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    // Handle no-facility formats
    if (fmt.facilityBits === 0 && facility !== 0) {
      console.warn(`[WiegandManager] Warning: Format ${formatId} has no facility code. Ignoring FC=${facility}`);
      facility = 0;
    }

    // Log transmission details
    console.log(`[WiegandManager] === Card Transmission ===`);
    console.log(`  Reader: ${reader.name} (Door ${reader.door})`);
    console.log(`  Format: ${formatId} (${fmt.bits}-bit)`);
    console.log(`  Layout: FC:${fmt.facilityBits} bits, Card:${fmt.cardBits} bits`);
    console.log(`  Has Facility: ${fmt.facilityBits > 0 ? 'Yes' : 'NO - Card only'}`);
    console.log(`  Facility: ${facility}`);
    console.log(`  Card: ${card}`);
    console.log(`  TX GPIO: D0=${txPins.d0}, D1=${txPins.d1}`);

    // Encode the credential
    let bitString;
    try {
      bitString = this._encodeWiegand(fmt, facility, card);
    } catch (error) {
      throw new Error(`Encoding failed: ${error.message}`);
    }

    console.log(`  Bit String: ${bitString} (${bitString.length} bits)`);

    // Send the pulses
    const startTime = Date.now();
    await this._sendWiegandPulses(txPins.d0, txPins.d1, bitString);
    const duration = Date.now() - startTime;

    console.log(`[WiegandManager] ✓ Transmission complete (${duration}ms)`);
    
    return {
      success: true,
      reader: reader.name,
      door: reader.door,
      formatId,
      format: fmt.bits,
      facility,
      card,
      bits: bitString.length,
      hasFacility: fmt.facilityBits > 0,
      duration
    };
  }

  // ════════════════════════════════════════════════════════════════════════════
  // UNIFIED ENCODING - Uses formatService instead of hardcoded functions
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * Encode a Wiegand credential using format from formatService
   * 
   * UNIFIED: Replaces all 12 individual _encodeW* functions
   * 
   * @param {Object} fmt - Format object from formatService
   * @param {number} facility - Facility code
   * @param {number} card - Card number
   * @returns {string} Bit string ready for transmission
   */
  _encodeWiegand(fmt, facility, card) {
    // Build data bits
    let dataBits = '';
    
    // Add header if format has one (e.g., W35/Corp1000 has '01' header)
    if (fmt.header) {
      dataBits += fmt.header;
    }
    
    // Add facility bits (if format has facility code)
    if (fmt.facilityBits > 0) {
      dataBits += facility.toString(2).padStart(fmt.facilityBits, '0');
    }
    
    // Add card bits
    dataBits += card.toString(2).padStart(fmt.cardBits, '0');
    
    // Apply parity based on format type
    const parity = fmt.parity || 'std';
    
    switch (parity) {
      case 'none':
        // No parity - return data as-is
        return dataBits;
        
      case 'whole-even':
        // Single even parity bit at start (or end depending on format)
        const evenParity = this._calculateEvenParity(dataBits);
        return evenParity + dataBits;
        
      case 'whole-odd':
        // Single odd parity bit
        const oddParity = this._calculateOddParity(dataBits);
        return oddParity + dataBits;
        
      case 'std':
      default:
        // Standard Wiegand: even parity on first half, odd parity on second half
        const mid = Math.floor(dataBits.length / 2);
        const firstHalf = dataBits.substring(0, mid);
        const secondHalf = dataBits.substring(mid);
        
        const evenP = this._calculateEvenParity(firstHalf);
        const oddP = this._calculateOddParity(secondHalf);
        
        return evenP + dataBits + oddP;
    }
  }

  /**
   * Send raw bit string (unchanged from original)
   */
  async sendRaw(readerId, bits) {
    if (!this.initialized) {
      throw new Error('WiegandManager not initialized');
    }

    const reader = this.getReader(readerId);
    if (!reader) {
      const available = this.readers.map(r => `${r.id}(door=${r.door})`).join(', ');
      throw new Error(`Reader "${readerId}" not found. Available: ${available}`);
    }
    
    const txPins = reader.txPins || reader.pins;
    if (!txPins) {
      throw new Error(`Reader "${readerId}" has no pins configured`);
    }

    if (typeof bits !== 'string' || !/^[01]+$/.test(bits)) {
      throw new Error('Bits must be a string of 0s and 1s');
    }

    console.log(`[WiegandManager] Sending raw ${bits.length} bits to Reader ${reader.door}`);
    const startTime = Date.now();
    await this._sendWiegandPulses(txPins.d0, txPins.d1, bits);
    const duration = Date.now() - startTime;

    return {
      success: true,
      reader: reader.name,
      bits: bits.length,
      duration
    };
  }

  // ════════════════════════════════════════════════════════════════════════════
  // PARITY CALCULATION
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * Calculate even parity bit
   */
  _calculateEvenParity(bits) {
    let count = 0;
    for (const b of bits) {
      if (b === '1') count++;
    }
    return (count % 2 === 0) ? '0' : '1';
  }

  /**
   * Calculate odd parity bit
   */
  _calculateOddParity(bits) {
    let count = 0;
    for (const b of bits) {
      if (b === '1') count++;
    }
    return (count % 2 === 1) ? '0' : '1';
  }

  // ════════════════════════════════════════════════════════════════════════════
  // GPIO TRANSMISSION
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * Send Wiegand pulses over GPIO
   */
  async _sendWiegandPulses(d0Pin, d1Pin, bitString) {
    const nativePath = path.join(__dirname, 'wiegand_tx');
    if (!fs.existsSync(nativePath)) {
      throw new Error('Wiegand TX binary not found at ' + nativePath);
    }
    if (!/^[01]+$/.test(bitString)) {
      throw new Error('Invalid bit string: must contain only 0s and 1s');
    }
    const cmd = 'sudo ' + nativePath + ' --raw ' + d0Pin + ' ' + d1Pin + ' ' + bitString + ' ' + this.PULSE_WIDTH;
    console.log('[WiegandManager] Exec: ' + cmd);
    try {
      const { stdout, stderr } = await execAsync(cmd, { timeout: 10000 });
      if (stdout && stdout.trim()) console.log('[WiegandManager] ' + stdout.trim());
      if (stderr && stderr.trim()) console.warn('[WiegandManager] wiegand_tx stderr: ' + stderr.trim());
    } catch (error) {
      const detail = (error.stderr || error.message || '').trim();
      throw new Error('wiegand_tx failed on D0=' + d0Pin + ' D1=' + d1Pin + ': ' + detail);
    }
  }

  /**
   * Sleep for microseconds
   */
  async _sleepMicros(us) {
    return new Promise(resolve => setTimeout(resolve, us / 1000));
  }

  // ════════════════════════════════════════════════════════════════════════════
  // READER MANAGEMENT
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * Get reader by ID or door number
   */
  async testReader(readerId) {
    const reader = this.getReader(readerId);
    if (!reader) throw new Error(`Reader "${readerId}" not found`);
    return this.sendCard(reader.id, 123, 45678, 'w26');
  }

  getReader(identifier) {
    if (!identifier && identifier !== 0) return null;
    
    const searchId = String(identifier).toLowerCase();
    const searchNum = parseInt(identifier, 10);
    
    return this.readers.find(r => {
      // Match by id
      if (r.id && r.id.toLowerCase() === searchId) return true;
      // Match by door number
      if (!isNaN(searchNum) && r.door === searchNum) return true;
      // Match by name
      if (r.name && r.name.toLowerCase() === searchId) return true;
      // Match "door X" pattern
      if (searchId.startsWith('door') && r.door === searchNum) return true;
      // Match "reader X" pattern
      const match = searchId.match(/reader[- ]?(\d+)/i);
      if (match && r.door === parseInt(match[1], 10)) return true;
      
      return false;
    });
  }

  /**
   * Get all readers
   */
  getReaders() {
    return this.readers;
  }

  /**
   * Check if a pin is reserved
   */
  isPinReserved(pin) {
    return this.reservedPins.has(Number(pin));
  }

  // ════════════════════════════════════════════════════════════════════════════
  // FORMAT INFORMATION (via formatService)
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * Get all available format IDs
   */
  getAvailableFormats() {
    return formatService.getAllFormats().map(f => ({
      id: f.id,
      name: f.name,
      bits: f.bits,
      facilityBits: f.facilityBits,
      cardBits: f.cardBits,
      hasFacility: f.facilityBits > 0
    }));
  }

  /**
   * Get format details by ID
   */
  getFormatDetails(formatId) {
    return formatService.getFormatById(formatId);
  }

  /**
   * Get all format variants for a bit count
   */
  getFormatVariants(bits) {
    return formatService.getFormatVariants(bits);
  }

  /**
   * Get all formats with no facility code
   */
  getNoFacilityFormats() {
    return formatService.getNoFacilityFormats();
  }

  /**
   * Validate a credential before sending
   */
  validateCredential(formatId, facility, card) {
    return formatService.validateCredential(formatId, facility, card);
  }

  // ════════════════════════════════════════════════════════════════════════════
  // STATUS
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * Get manager status
   */
  getStatus() {
    const fmtStatus = formatService.getStatus();
    
    return {
      initialized: this.initialized,
      readers: this.readers.map(r => ({
        id: r.id,
        door: r.door,
        name: r.name,
        hasPins: !!(r.pins || r.txPins)
      })),
      reservedPins: Array.from(this.reservedPins),
      chip: this.chip,
      // Format service info
      totalFormats: fmtStatus.totalFormats,
      supportedBitCounts: fmtStatus.bitCounts,
      noFacilityFormats: fmtStatus.noFacilityFormats,
      multiVariantBitCounts: fmtStatus.multiVariantBitCounts
    };
  }

  /**
   * Print status summary
   */
  printStatus() {
    console.log('\n=== WIEGAND MANAGER STATUS ===');
    console.log(`Initialized: ${this.initialized}`);
    console.log(`Readers: ${this.readers.length}`);
    this.readers.forEach(r => {
      console.log(`  - ${r.name} (Door ${r.door}): D0=${r.pins?.d0}, D1=${r.pins?.d1}`);
    });
    console.log(`\nFormat Service:`);
    formatService.printSummary();
  }
}

module.exports = WiegandManager;
