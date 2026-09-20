/**
 * IOplusNative.js - Direct I2C communication with Sequent Microsystems IOplus board
 * 
 * NO PROCESS SPAWNING - uses native i2c-bus library for maximum speed
 * 
 * Install: npm install i2c-bus
 * 
 * IOplus Register Map (from Sequent Microsystems):
 *   0x00 - Relay state read (bitmask)
 *   0x01 - Relay state write (bitmask)
 *   0x03 - Opto inputs read (bitmask)
 *   0x04-0x13 - ADC channels (2 bytes each, little-endian)
 */

const i2c = require('i2c-bus');

// IOplus register addresses
const REGISTERS = {
  RELAY_READ: 0x00,
  RELAY_WRITE: 0x01,
  OPTO_READ: 0x03,
  ADC_BASE: 0x04,      // ADC channels start here (2 bytes each)
  ADC_BYTES: 2,        // Bytes per ADC channel
};

// Default I2C address for IOplus (can be changed with board jumpers)
const DEFAULT_ADDRESS = 0x28;

class IOplusNative {
  constructor(options = {}) {
    this.busNumber = options.busNumber || 1;
    this.address = options.address || DEFAULT_ADDRESS;
    this.bus = null;
    this.isOpen = false;
    this.relaysPerBoard = 8;
    this.totalRelays = 8;
    
    // Queue for serializing I2C operations
    this.queue = [];
    this.processing = false;
    
    // Minimum delay between operations (microseconds worth, but we use ms)
    this.minDelayMs = options.minDelayMs || 50;  // 5ms between ops - very fast!
    
    // Stats
    this.stats = {
      operations: 0,
      errors: 0,
      lastOperation: null,
      avgResponseTime: 0
    };
  }

  /**
   * Open the I2C bus
   */
  async open() {
    if (this.isOpen) return;
    
    return new Promise((resolve, reject) => {
      this.bus = i2c.open(this.busNumber, (err) => {
        if (err) {
          console.error(`[IOplusNative] Failed to open I2C bus ${this.busNumber}:`, err.message);
          reject(err);
        } else {
          this.isOpen = true;
          console.log(`[IOplusNative] I2C bus ${this.busNumber} opened, device at 0x${this.address.toString(16)}`);
          resolve();
        }
      });
    });
  }

  /**
   * Close the I2C bus
   */
  async close() {
    if (!this.isOpen || !this.bus) return;
    
    return new Promise((resolve) => {
      this.bus.close(() => {
        this.isOpen = false;
        console.log('[IOplusNative] I2C bus closed');
        resolve();
      });
    });
  }

  /**
   * Queue an I2C operation (serializes access)
   */
  async queueOperation(operation) {
    return new Promise((resolve, reject) => {
      this.queue.push({ operation, resolve, reject });
      this.processQueue();
    });
  }

  /**
   * Process queued operations
   */
  async processQueue() {
    if (this.processing || this.queue.length === 0) return;
    
    this.processing = true;
    
    while (this.queue.length > 0) {
      const { operation, resolve, reject } = this.queue.shift();
      const startTime = Date.now();
      
      try {
        const result = await operation();
        this.stats.operations++;
        this.stats.lastOperation = Date.now();
        
        // Update avg response time
        const elapsed = Date.now() - startTime;
        this.stats.avgResponseTime = (this.stats.avgResponseTime * 0.9) + (elapsed * 0.1);
        
        resolve(result);
      } catch (err) {
        this.stats.errors++;
        reject(err);
      }
      
      // Small delay between operations
      if (this.queue.length > 0 && this.minDelayMs > 0) {
        await this.delay(this.minDelayMs);
      }
    }
    
    this.processing = false;
  }

  delay(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  /**
   * Write a byte to a register
   */
  writeByte(register, value) {
    return new Promise((resolve, reject) => {
      if (!this.isOpen) {
        return reject(new Error('I2C bus not open'));
      }
      
      this.bus.writeByte(this.address, register, value, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  /**
   * Read a byte from a register
   */
  readByte(register) {
    return new Promise((resolve, reject) => {
      if (!this.isOpen) {
        return reject(new Error('I2C bus not open'));
      }
      
      this.bus.readByte(this.address, register, (err, byte) => {
        if (err) reject(err);
        else resolve(byte);
      });
    });
  }

  /**
   * Read a word (2 bytes) from a register
   */
  readWord(register) {
    return new Promise((resolve, reject) => {
      if (!this.isOpen) {
        return reject(new Error('I2C bus not open'));
      }
      
      this.bus.readWord(this.address, register, (err, word) => {
        if (err) reject(err);
        else resolve(word);
      });
    });
  }

  // ============================================
  // RELAY OPERATIONS
  // ============================================

  /**
   * Set a single relay (pin 0-7)
   */
  async setRelay(pin, state) {
    if (pin < 0 || pin >= this.totalRelays) {
      throw new Error(`Pin ${pin} out of range (0-${this.totalRelays - 1})`);
    }
    
    return this.queueOperation(async () => {
      // Read current state
      const current = await this.readByte(REGISTERS.RELAY_READ);
      
      // Modify the bit for this relay
      const bit = 1 << pin;
      const newState = state ? (current | bit) : (current & ~bit);
      
      // Write new state
      await this.writeByte(REGISTERS.RELAY_WRITE, newState);
      
      return {
        success: true,
        pin,
        relay: pin + 1,
        board: 0,
        state: !!state
      };
    });
  }

  /**
   * Get a single relay state (pin 0-7)
   */
  async getRelay(pin) {
    if (pin < 0 || pin >= this.totalRelays) {
      throw new Error(`Pin ${pin} out of range (0-${this.totalRelays - 1})`);
    }
    
    return this.queueOperation(async () => {
      const current = await this.readByte(REGISTERS.RELAY_READ);
      const bit = 1 << pin;
      const state = (current & bit) !== 0;
      
      return {
        success: true,
        pin,
        relay: pin + 1,
        board: 0,
        state
      };
    });
  }

  /**
   * Set all relays at once (bitmask or array)
   */
  async setAllRelays(states) {
    let bitmask;
    
    if (Array.isArray(states)) {
      if (states.length !== this.totalRelays) {
        throw new Error(`Expected array of ${this.totalRelays} states`);
      }
      bitmask = 0;
      for (let i = 0; i < states.length; i++) {
        if (states[i]) bitmask |= (1 << i);
      }
    } else if (typeof states === 'number') {
      bitmask = states & 0xFF;
    } else {
      throw new Error('States must be array or bitmask number');
    }
    
    return this.queueOperation(async () => {
      await this.writeByte(REGISTERS.RELAY_WRITE, bitmask);
      
      return {
        success: true,
        bitmask,
        states: Array.from({ length: 8 }, (_, i) => !!(bitmask & (1 << i)))
      };
    });
  }

  /**
   * Get all relay states
   */
  async getAllRelays() {
    return this.queueOperation(async () => {
      const bitmask = await this.readByte(REGISTERS.RELAY_READ);
      
      const results = [];
      for (let i = 0; i < this.totalRelays; i++) {
        results.push({
          success: true,
          pin: i,
          relay: i + 1,
          board: 0,
          state: !!(bitmask & (1 << i))
        });
      }
      
      return results;
    });
  }

  /**
   * Pulse a relay
   */
  async pulseRelay(pin, durationMs = 500) {
    await this.setRelay(pin, true);
    await this.delay(durationMs);
    await this.setRelay(pin, false);
    
    return { success: true, pin, duration: durationMs };
  }

  // ============================================
  // OPTO INPUT OPERATIONS
  // ============================================

  /**
   * Read a single opto input (pin 0-7)
   */
  async readOptoInput(pin) {
    if (pin < 0 || pin >= 8) {
      throw new Error(`Opto input pin ${pin} out of range (0-7)`);
    }
    
    return this.queueOperation(async () => {
      const bitmask = await this.readByte(REGISTERS.OPTO_READ);
      const bit = 1 << pin;
      const state = (bitmask & bit) !== 0;
      
      return {
        success: true,
        pin,
        input: pin + 1,
        board: 0,
        state,
        type: 'opto'
      };
    });
  }

  /**
   * Read all opto inputs
   */
  async readAllOptoInputs() {
    return this.queueOperation(async () => {
      const bitmask = await this.readByte(REGISTERS.OPTO_READ);
      
      const results = [];
      for (let i = 0; i < 8; i++) {
        results.push({
          success: true,
          pin: i,
          input: i + 1,
          board: 0,
          state: !!(bitmask & (1 << i)),
          type: 'opto'
        });
      }
      
      return results;
    });
  }

  /**
   * Fast opto read (no queue, for monitoring) - use with caution
   */
  async readOptoInputFast(pin) {
    if (pin < 0 || pin >= 8) {
      throw new Error(`Opto input pin ${pin} out of range (0-7)`);
    }
    
    const bitmask = await this.readByte(REGISTERS.OPTO_READ);
    const bit = 1 << pin;
    
    return { pin, state: (bitmask & bit) !== 0 };
  }

  // ============================================
  // ANALOG INPUT OPERATIONS
  // ============================================

  /**
   * Read a single analog input (pin 0-7)
   */
  async readAnalogInput(pin) {
    if (pin < 0 || pin >= 8) {
      throw new Error(`Analog input pin ${pin} out of range (0-7)`);
    }
    
    return this.queueOperation(async () => {
      const register = REGISTERS.ADC_BASE + (pin * REGISTERS.ADC_BYTES);
      const raw = await this.readWord(register);
      
      // Convert to voltage (IOplus uses 3.3V reference, 12-bit ADC)
      // Actual conversion may vary - check Sequent docs
      const volts = (raw / 4095.0) * 3.3;
      const millivolts = Math.round(volts * 1000);
      
      return {
        success: true,
        pin,
        channel: pin + 1,
        board: 0,
        raw,
        volts: parseFloat(volts.toFixed(3)),
        millivolts,
        type: 'analog'
      };
    });
  }

  /**
   * Read all analog inputs
   */
  async readAllAnalogInputs() {
    return this.queueOperation(async () => {
      const results = [];
      
      for (let pin = 0; pin < 8; pin++) {
        const register = REGISTERS.ADC_BASE + (pin * REGISTERS.ADC_BYTES);
        const raw = await this.readWord(register);
        const volts = (raw / 4095.0) * 3.3;
        
        results.push({
          success: true,
          pin,
          channel: pin + 1,
          board: 0,
          raw,
          volts: parseFloat(volts.toFixed(3)),
          millivolts: Math.round(volts * 1000),
          type: 'analog'
        });
      }
      
      return results;
    });
  }

  /**
   * Fast analog read (no queue, for monitoring) - use with caution
   */
  async readAnalogInputFast(pin) {
    if (pin < 0 || pin >= 8) {
      throw new Error(`Analog pin ${pin} out of range (0-7)`);
    }
    
    const register = REGISTERS.ADC_BASE + (pin * REGISTERS.ADC_BYTES);
    const raw = await this.readWord(register);
    const volts = (raw / 4095.0) * 3.3;
    
    return { pin, volts, millivolts: Math.round(volts * 1000) };
  }

  // ============================================
  // UTILITY
  // ============================================

  /**
   * Health check
   */
  async healthCheck() {
    try {
      await this.queueOperation(async () => {
        await this.readByte(REGISTERS.RELAY_READ);
      });
      
      return {
        healthy: true,
        message: 'I2C bus responding normally',
        board: 0,
        address: `0x${this.address.toString(16)}`,
        stats: this.stats
      };
    } catch (err) {
      return {
        healthy: false,
        message: err.message,
        board: 0,
        address: `0x${this.address.toString(16)}`,
        stats: this.stats
      };
    }
  }

  /**
   * Pin to relay conversion (for compatibility)
   */
  pinToRelay(pin) {
    if (pin < 0 || pin >= this.totalRelays) {
      throw new Error(`Pin ${pin} out of range (0-${this.totalRelays - 1})`);
    }
    return { board: 0, relay: pin + 1 };
  }

  /**
   * Get stats
   */
  getStats() {
    return {
      ...this.stats,
      queueLength: this.queue.length,
      processing: this.processing,
      isOpen: this.isOpen,
      address: `0x${this.address.toString(16)}`,
      minDelayMs: this.minDelayMs
    };
  }
}

module.exports = IOplusNative;
