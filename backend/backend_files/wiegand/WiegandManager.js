// WiegandManager.js
// Manages Wiegand protocol card transmission over GPIO pins
// ENHANCED VERSION - Supports W26, W30, W32, W34, W35, W37, W38, W40, W46, W48, W56, W64

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

/**
 * WiegandManager - Handles Wiegand card credential transmission
 * 
 * Implements:
 * - Multiple Wiegand formats (W26, W30, W32, W34, W35, W37, W38, W40, W46, W48, W56, W64)
 * - Precise GPIO pulse timing
 * - Parity bit calculation
 * - Multi-reader support
 * - Pin reservation management
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
    this.PULSE_WIDTH = 50;      // 50μs pulse width
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
      
      // Initialize all reader pins
      // await this._initializePins(); // DISABLED - was holding GPIO
      
      this.initialized = true;
      console.log(`[WiegandManager] Initialized with ${this.readers.length} readers`);
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
      this.readers = this.config.readers || [];
      
      // Build reserved pins set
      for (const reader of this.readers) {
        if (reader.pins) {
          this.reservedPins.add(Number(reader.pins.d0));
          this.reservedPins.add(Number(reader.pins.d1));
        }
        // Also reserve TX pins if separate from RX pins
        if (reader.txPins) {
          this.reservedPins.add(Number(reader.txPins.d0));
          this.reservedPins.add(Number(reader.txPins.d1));
        }
      }
      
      console.log(`[WiegandManager] Loaded config: ${this.readers.length} readers`);
      console.log(`[WiegandManager] Reserved pins: ${Array.from(this.reservedPins).sort((a,b) => a-b).join(', ')}`);
    } catch (error) {
      throw new Error(`Failed to load config from ${this.configPath}: ${error.message}`);
    }
  }

  /**
   * Verify GPIO tools are available
   */
  async _verifyGPIO() {
    try {
      await execAsync('which gpioset');
      console.log('[WiegandManager] ✓ libgpiod tools available');
    } catch (error) {
      throw new Error('libgpiod tools not found. Install with: sudo apt-get install gpiod');
    }
  }

  /**
   * Initialize all reader GPIO pins as outputs
   */
  async _initializePins() {
    for (const reader of this.readers) {
      if (!reader.pins) continue;
      
      const { d0, d1 } = reader.pins;
      
      try {
        // Set pins to LOW (idle state)
        await this._setGPIO(d0, 0);
        await this._setGPIO(d1, 0);
        console.log(`[WiegandManager] ✓ Reader ${reader.door}: D0=${d0}, D1=${d1} initialized`);
      } catch (error) {
        console.warn(`[WiegandManager] ⚠ Failed to initialize reader ${reader.door}:`, error.message);
      }
    }
  }

  /**
   * Send a card credential in standard format
   * @param {string|number} readerId - Reader ID (door number)
   * @param {number} facility - Facility code
   * @param {number} card - Card number
   * @param {number|null} format - Wiegand format (26, 30, 32, 34, etc.) or null for auto-detect
   */
  async sendCard(readerId, facility, card, format = null) {
    if (!this.initialized) {
      throw new Error('WiegandManager not initialized');
    }

    // Find the reader
    const reader = this.getReader(readerId);
    if (!reader) {
      throw new Error(`Reader "${readerId}" not found`);
    }

    if (!reader.pins && !reader.txPins) {
      throw new Error(`Reader "${readerId}" has no pin configuration`);
    }

    // Use txPins if available (for separate RX/TX configs), otherwise use pins
    const txPins = reader.txPins || reader.pins;

    // Auto-detect format if not specified
    if (format === null) {
      format = 26; // Default to W26
    }

    console.log(`[WiegandManager] Sending to Reader ${reader.door} (${reader.name}):`);
    console.log(`  Format: W${format}`);
    console.log(`  Facility: ${facility}`);
    console.log(`  Card: ${card}`);
    console.log(`  TX GPIO: D0=${txPins.d0}, D1=${txPins.d1}`);

    // Encode the credential into bits
    let bitString;
    try {
      bitString = this._encodeWiegand(format, facility, card);
    } catch (error) {
      throw new Error(`Encoding failed: ${error.message}`);
    }

    console.log(`  Bit String: ${bitString} (${bitString.length} bits)`);

    // Send the pulses using TX pins
    await this._sendWiegandPulses(txPins.d0, txPins.d1, bitString);

    console.log(`[WiegandManager] ✓ Transmission complete`);
    return {
      success: true,
      reader: reader.name,
      format,
      facility,
      card,
      bits: bitString.length
    };
  }

  /**
   * Encode any Wiegand format
   * @param {number} format - Format bit count (26, 30, 32, 34, etc.)
   * @param {number} facility - Facility code
   * @param {number} card - Card number
   * @returns {string} - Bit string
   */
  _encodeWiegand(format, facility, card) {
    switch (format) {
      case 26:
        return this._encodeW26(facility, card);
      case 30:
        return this._encodeW30(facility, card);
      case 32:
        return this._encodeW32(facility, card);
      case 34:
        return this._encodeW34(facility, card);
      case 35:
        return this._encodeW35(facility, card);
      case 37:
        return this._encodeW37(facility, card);
      case 38:
        return this._encodeW38(facility, card);
      case 40:
        return this._encodeW40(facility, card);
      case 46:
        return this._encodeW46(facility, card);
      case 48:
        return this._encodeW48(facility, card);
      case 56:
        return this._encodeW56(facility, card);
      case 64:
        return this._encodeW64(facility, card);
      default:
        throw new Error(`Unsupported Wiegand format: W${format}. Supported: 26, 30, 32, 34, 35, 37, 38, 40, 46, 48, 56, 64`);
    }
  }

  /**
   * Send raw bit string
   * @param {string|number} readerId - Reader ID
   * @param {string} bits - Bit string (e.g., "0101010101...")
   */
  async sendRaw(readerId, bits) {
    if (!this.initialized) {
      throw new Error('WiegandManager not initialized');
    }

    const reader = this.getReader(readerId);
    if (!reader || !reader.pins) {
      throw new Error(`Reader "${readerId}" not found or has no pins`);
    }

    // Validate bit string
    if (typeof bits !== 'string' || !/^[01]+$/.test(bits)) {
      throw new Error('Bits must be a string of 0s and 1s');
    }

    console.log(`[WiegandManager] Sending raw ${bits.length} bits to Reader ${reader.door}`);
    await this._sendWiegandPulses(reader.pins.d0, reader.pins.d1, bits);

    return {
      success: true,
      reader: reader.name,
      bits: bits.length
    };
  }

  // ============================================================
  // ENCODING FUNCTIONS FOR ALL FORMATS
  // ============================================================

  /**
   * Encode 26-bit Wiegand (Standard H10301)
   * Format: [EP][8-bit facility][16-bit card][OP]
   */
  _encodeW26(facility, card) {
    if (facility < 0 || facility > 255) {
      throw new Error('W26: Facility must be 0-255');
    }
    if (card < 0 || card > 65535) {
      throw new Error('W26: Card must be 0-65535');
    }

    const facilityBits = facility.toString(2).padStart(8, '0');
    const cardBits = card.toString(2).padStart(16, '0');
    const dataBits = facilityBits + cardBits;
    
    const firstHalf = dataBits.substring(0, 12);
    const secondHalf = dataBits.substring(12, 24);
    
    const evenParity = this._calculateEvenParity(firstHalf);
    const oddParity = this._calculateOddParity(secondHalf);
    
    return evenParity + dataBits + oddParity;
  }

  /**
   * Encode 30-bit Wiegand
   * Format: [EP][10-bit facility][20-bit card][OP]
   */
  _encodeW30(facility, card) {
    if (facility < 0 || facility > 1023) {
      throw new Error('W30: Facility must be 0-1023');
    }
    if (card < 0 || card > 1048575) {
      throw new Error('W30: Card must be 0-1048575');
    }

    const facilityBits = facility.toString(2).padStart(10, '0');
    const cardBits = card.toString(2).padStart(20, '0');
    const dataBits = facilityBits + cardBits;
    
    const firstHalf = dataBits.substring(0, 15);
    const secondHalf = dataBits.substring(15, 30);
    
    const evenParity = this._calculateEvenParity(firstHalf);
    const oddParity = this._calculateOddParity(secondHalf);
    
    return evenParity + dataBits + oddParity;
  }

  /**
   * Encode 32-bit Wiegand (Raw, no parity)
   * Format: [32-bit card number]
   */
  _encodeW32(facility, card) {
    // W32 is typically just a 32-bit card number, no facility code
    const cardNumber = card; // Use card parameter as the full 32-bit value
    
    if (cardNumber < 0 || cardNumber > 4294967295) {
      throw new Error('W32: Card must be 0-4294967295');
    }

    return cardNumber.toString(2).padStart(32, '0');
  }

  /**
   * Encode 34-bit Wiegand (Corporate 1000)
   * Format: [EP][16-bit facility][16-bit card][OP]
   */
  _encodeW34(facility, card) {
    if (facility < 0 || facility > 65535) {
      throw new Error('W34: Facility must be 0-65535');
    }
    if (card < 0 || card > 65535) {
      throw new Error('W34: Card must be 0-65535');
    }

    const facilityBits = facility.toString(2).padStart(16, '0');
    const cardBits = card.toString(2).padStart(16, '0');
    const dataBits = facilityBits + cardBits;
    
    const firstHalf = dataBits.substring(0, 16);
    const secondHalf = dataBits.substring(16, 32);
    
    const evenParity = this._calculateEvenParity(firstHalf);
    const oddParity = this._calculateOddParity(secondHalf);
    
    return evenParity + dataBits + oddParity;
  }

  /**
   * Encode 35-bit Wiegand (HID Corporate 1000)
   * Format: [EP][01][12-bit facility][20-bit card][OP]
   */
  _encodeW35(facility, card) {
    if (facility < 0 || facility > 4095) {
      throw new Error('W35: Facility must be 0-4095');
    }
    if (card < 0 || card > 1048575) {
      throw new Error('W35: Card must be 0-1048575');
    }

    const facilityBits = facility.toString(2).padStart(12, '0');
    const cardBits = card.toString(2).padStart(20, '0');
    const dataBits = '01' + facilityBits + cardBits; // HID format includes '01' header
    
    // Whole-even parity for W35
    const evenParity = this._calculateEvenParity(dataBits);
    
    return evenParity + dataBits;
  }

  /**
   * Encode 37-bit Wiegand (H10302/H10304)
   * Format: [EP][16-bit facility][19-bit card][OP]
   */
  _encodeW37(facility, card) {
    if (facility < 0 || facility > 65535) {
      throw new Error('W37: Facility must be 0-65535');
    }
    if (card < 0 || card > 524287) {
      throw new Error('W37: Card must be 0-524287');
    }

    const facilityBits = facility.toString(2).padStart(16, '0');
    const cardBits = card.toString(2).padStart(19, '0');
    const dataBits = facilityBits + cardBits;
    
    const firstHalf = dataBits.substring(0, 18);
    const secondHalf = dataBits.substring(18, 35);
    
    const evenParity = this._calculateEvenParity(firstHalf);
    const oddParity = this._calculateOddParity(secondHalf);
    
    return evenParity + dataBits + oddParity;
  }

  /**
   * Encode 38-bit Wiegand
   * Format: [EP][16-bit facility][20-bit card][OP]
   */
  _encodeW38(facility, card) {
    if (facility < 0 || facility > 65535) {
      throw new Error('W38: Facility must be 0-65535');
    }
    if (card < 0 || card > 1048575) {
      throw new Error('W38: Card must be 0-1048575');
    }

    const facilityBits = facility.toString(2).padStart(16, '0');
    const cardBits = card.toString(2).padStart(20, '0');
    const dataBits = facilityBits + cardBits;
    
    const firstHalf = dataBits.substring(0, 18);
    const secondHalf = dataBits.substring(18, 36);
    
    const evenParity = this._calculateEvenParity(firstHalf);
    const oddParity = this._calculateOddParity(secondHalf);
    
    return evenParity + dataBits + oddParity;
  }

  /**
   * Encode 40-bit Wiegand (STID)
   * Format: [EP][16-bit facility][22-bit card][OP]
   */
  _encodeW40(facility, card) {
    if (facility < 0 || facility > 65535) {
      throw new Error('W40: Facility must be 0-65535');
    }
    if (card < 0 || card > 4194303) {
      throw new Error('W40: Card must be 0-4194303');
    }

    const facilityBits = facility.toString(2).padStart(16, '0');
    const cardBits = card.toString(2).padStart(22, '0');
    const dataBits = facilityBits + cardBits;
    
    const firstHalf = dataBits.substring(0, 19);
    const secondHalf = dataBits.substring(19, 38);
    
    const evenParity = this._calculateEvenParity(firstHalf);
    const oddParity = this._calculateOddParity(secondHalf);
    
    return evenParity + dataBits + oddParity;
  }

  /**
   * Encode 46-bit Wiegand
   * Format: [EP][20-bit facility][24-bit card][OP]
   */
  _encodeW46(facility, card) {
    if (facility < 0 || facility > 1048575) {
      throw new Error('W46: Facility must be 0-1048575');
    }
    if (card < 0 || card > 16777215) {
      throw new Error('W46: Card must be 0-16777215');
    }

    const facilityBits = facility.toString(2).padStart(20, '0');
    const cardBits = card.toString(2).padStart(24, '0');
    const dataBits = facilityBits + cardBits;
    
    const firstHalf = dataBits.substring(0, 22);
    const secondHalf = dataBits.substring(22, 44);
    
    const evenParity = this._calculateEvenParity(firstHalf);
    const oddParity = this._calculateOddParity(secondHalf);
    
    return evenParity + dataBits + oddParity;
  }

  /**
   * Encode 48-bit Wiegand (HID Corporate 1000)
   * Format: [EP][22-bit facility][24-bit card][OP]
   */
  _encodeW48(facility, card) {
    if (facility < 0 || facility > 4194303) {
      throw new Error('W48: Facility must be 0-4194303');
    }
    if (card < 0 || card > 16777215) {
      throw new Error('W48: Card must be 0-16777215');
    }

    const facilityBits = facility.toString(2).padStart(22, '0');
    const cardBits = card.toString(2).padStart(24, '0');
    const dataBits = facilityBits + cardBits;
    
    const firstHalf = dataBits.substring(0, 23);
    const secondHalf = dataBits.substring(23, 46);
    
    const evenParity = this._calculateEvenParity(firstHalf);
    const oddParity = this._calculateOddParity(secondHalf);
    
    return evenParity + dataBits + oddParity;
  }

  /**
   * Encode 56-bit Wiegand
   * Format: [EP][24-bit facility][30-bit card][OP]
   */
  _encodeW56(facility, card) {
    if (facility < 0 || facility > 16777215) {
      throw new Error('W56: Facility must be 0-16777215');
    }
    if (card < 0 || card > 1073741823) {
      throw new Error('W56: Card must be 0-1073741823');
    }

    const facilityBits = facility.toString(2).padStart(24, '0');
    const cardBits = card.toString(2).padStart(30, '0');
    const dataBits = facilityBits + cardBits;
    
    const firstHalf = dataBits.substring(0, 27);
    const secondHalf = dataBits.substring(27, 54);
    
    const evenParity = this._calculateEvenParity(firstHalf);
    const oddParity = this._calculateOddParity(secondHalf);
    
    return evenParity + dataBits + oddParity;
  }

  /**
   * Encode 64-bit Wiegand (SEOS)
   * Format: [EP][28-bit facility][34-bit card][OP]
   */
  _encodeW64(facility, card) {
    if (facility < 0 || facility > 268435455) {
      throw new Error('W64: Facility must be 0-268435455');
    }
    if (card < 0 || card > 17179869183) {
      throw new Error('W64: Card must be 0-17179869183');
    }

    const facilityBits = facility.toString(2).padStart(28, '0');
    const cardBits = card.toString(2).padStart(34, '0');
    const dataBits = facilityBits + cardBits;
    
    const firstHalf = dataBits.substring(0, 31);
    const secondHalf = dataBits.substring(31, 62);
    
    const evenParity = this._calculateEvenParity(firstHalf);
    const oddParity = this._calculateOddParity(secondHalf);
    
    return evenParity + dataBits + oddParity;
  }

  // ============================================================
  // PARITY CALCULATION
  // ============================================================

  /**
   * Calculate even parity (count of 1s should be even)
   */
  _calculateEvenParity(bits) {
    const count = (bits.match(/1/g) || []).length;
    return (count % 2 === 0) ? '0' : '1';
  }

  /**
   * Calculate odd parity (count of 1s should be odd)
   */
  _calculateOddParity(bits) {
    const count = (bits.match(/1/g) || []).length;
    return (count % 2 === 1) ? '0' : '1';
  }

  // ============================================================
  // GPIO TRANSMISSION
  // ============================================================

  /**
   * Send Wiegand pulses to GPIO pins
   * @param {number} d0Pin - Data 0 GPIO pin
   * @param {number} d1Pin - Data 1 GPIO pin
   * @param {string} bitString - String of 0s and 1s
   */
  async _sendWiegandPulses(d0Pin, d1Pin, bitString) {
    console.log(`[WiegandManager] Starting transmission of ${bitString.length} bits...`);
    
    for (let i = 0; i < bitString.length; i++) {
      const bit = bitString[i];
      const pin = (bit === '0') ? d0Pin : d1Pin;
      
      try {
        // Send pulse: HIGH for PULSE_WIDTH microseconds
        await this._setGPIO(pin, 1);
        await this._usleep(this.PULSE_WIDTH);
        await this._setGPIO(pin, 0);
        
        // Wait interval before next bit (but not after last bit)
        if (i < bitString.length - 1) {
          await this._usleep(this.PULSE_INTERVAL);
        }
      } catch (error) {
        throw new Error(`Failed to send bit ${i} (${bit}) on GPIO ${pin}: ${error.message}`);
      }
    }
    
    console.log(`[WiegandManager] ✓ Sent ${bitString.length} pulses`);
  }

  /**
   * Set GPIO pin state using gpioset
   * @param {number} pin - GPIO pin number
   * @param {number} value - 0 (LOW) or 1 (HIGH)
   */
  async _setGPIO(pin, value) {
    const cmd = `gpioset -c 0 -z ${pin}=${value}`;
    try {
      await execAsync(cmd);
    } catch (error) {
      throw new Error(`GPIO ${pin} set failed: ${error.message}`);
    }
  }

  /**
   * Microsecond sleep using busy-wait
   * For precise timing < 1ms
   */
  async _usleep(microseconds) {
    const start = process.hrtime.bigint();
    const target = start + BigInt(microseconds * 1000); // Convert to nanoseconds
    
    while (process.hrtime.bigint() < target) {
      // Busy wait for precise timing
    }
  }

  // ============================================================
  // UTILITY METHODS
  // ============================================================

  /**
   * Get reader by ID or door number
   */
  getReader(id) {
    const idStr = String(id);
    return this.readers.find(r => 
      String(r.id) === idStr || 
      String(r.door) === idStr ||
      r.name.includes(idStr)
    );
  }

  /**
   * Get all readers
   */
  getReaders() {
    return this.readers.map(r => ({
      id: r.id,
      door: r.door,
      name: r.name,
      pins: r.pins,
      status: 'online'
    }));
  }

  /**
   * Check if a pin is reserved for Wiegand
   */
  isPinReserved(pin) {
    return this.reservedPins.has(Number(pin));
  }

  /**
   * Get status information
   */
  getStatus() {
    return {
      initialized: this.initialized,
      chip: this.chip,
      readers: this.readers.length,
      reservedPins: Array.from(this.reservedPins).sort((a,b) => a-b),
      formats: ['W26', 'W30', 'W32', 'W34', 'W35', 'W37', 'W38', 'W40', 'W46', 'W48', 'W56', 'W64']
    };
  }

  /**
   * Test reader with default card
   */
  async testReader(readerId) {
    return await this.sendCard(readerId, 123, 12345, 26);
  }
}

module.exports = WiegandManager;
