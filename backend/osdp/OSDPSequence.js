/**
 * OSDPSequence.js - OSDP v2.2.2 Sequence Number Management
 * 
 * Per Section 5.9, Table 2:
 * - Sequence cycles: 0 -> 1 -> 2 -> 3 -> 1 -> 2 -> 3 -> ...
 * - Sequence 0 is ONLY for communication startup/reset
 * - Non-zero sequences support error recovery
 * - PD may respond with sequence 0 to force reset
 */

class OSDPSequence {
  constructor() {
    this.sequences = new Map(); // address -> sequence number
    this.lastReceived = new Map(); // address -> last received sequence
    this.resetCallbacks = new Map(); // address -> reset callback
  }

  /**
   * Initialize sequence for an address
   * @param {number} address - PD address
   * @param {Function} onReset - Callback when sequence resets
   */
  init(address, onReset = null) {
    this.sequences.set(address, 0); // Start with 0 for initial connection
    this.lastReceived.set(address, 0);
    
    if (onReset) {
      this.resetCallbacks.set(address, onReset);
    }
  }

  /**
   * Get current sequence number for address
   * @param {number} address - PD address
   * @returns {number} - Current sequence (0-3)
   */
  getCurrent(address) {
    if (!this.sequences.has(address)) {
      this.init(address);
    }
    return this.sequences.get(address);
  }

  /**
   * Get next sequence number for address
   * @param {number} address - PD address
   * @param {boolean} increment - Increment the sequence (default: true)
   * @returns {number} - Next sequence (1-3)
   */
  getNext(address, increment = true) {
    let current = this.getCurrent(address);
    
    // If current is 0, move to 1
    if (current === 0) {
      if (increment) {
        this.sequences.set(address, 1);
      }
      return 1;
    }
    
    // Cycle through 1->2->3->1
    const next = (current % 3) + 1;
    
    if (increment) {
      this.sequences.set(address, next);
    }
    
    return next;
  }

  /**
   * Reset sequence to 0 (for connection startup/loss)
   * @param {number} address - PD address
   */
  reset(address) {
    const oldSequence = this.getCurrent(address);
    this.sequences.set(address, 0);
    this.lastReceived.set(address, 0);
    
    // Call reset callback if registered
    const callback = this.resetCallbacks.get(address);
    if (callback) {
      callback(address, oldSequence);
    }
    
    console.log(`[OSDPSequence] Reset sequence for address ${address} (was ${oldSequence})`);
  }

  /**
   * Repeat current sequence (for retry on error)
   * @param {number} address - PD address
   * @returns {number} - Current sequence (unchanged)
   */
  repeat(address) {
    const current = this.getCurrent(address);
    console.log(`[OSDPSequence] Repeating sequence ${current} for address ${address}`);
    return current;
  }

  /**
   * Validate received sequence number
   * @param {number} address - PD address
   * @param {number} received - Received sequence number
   * @param {boolean} isReply - Is this a reply packet
   * @returns {Object} - { valid: boolean, reason: string }
   */
  validate(address, received, isReply = false) {
    const current = this.getCurrent(address);
    const lastRx = this.lastReceived.get(address) || 0;
    
    // Sequence 0 from PD forces reset
    if (isReply && received === 0) {
      console.log(`[OSDPSequence] PD ${address} requested sequence reset`);
      return {
        valid: true,
        reset: true,
        reason: 'PD requested reset'
      };
    }
    
    // Reply sequence should match command sequence
    if (isReply) {
      if (received === current) {
        this.lastReceived.set(address, received);
        return {
          valid: true,
          reset: false,
          reason: 'Sequence matches'
        };
      } else {
        return {
          valid: false,
          reset: false,
          reason: `Expected sequence ${current}, got ${received}`
        };
      }
    }
    
    // Command sequence validation (when we are the PD)
    // Accept sequence 0 as reset request
    if (received === 0) {
      return {
        valid: true,
        reset: true,
        reason: 'Reset sequence'
      };
    }
    
    // Check if sequence is in valid range (1-3)
    if (received < 1 || received > 3) {
      return {
        valid: false,
        reset: false,
        reason: `Invalid sequence ${received} (must be 0-3)`
      };
    }
    
    // If first command after reset (current=0), accept any 1-3
    if (current === 0) {
      this.lastReceived.set(address, received);
      this.sequences.set(address, received);
      return {
        valid: true,
        reset: false,
        reason: 'First command after reset'
      };
    }
    
    // Check if sequence advanced correctly
    const expected = (lastRx % 3) + 1;
    
    if (received === expected) {
      this.lastReceived.set(address, received);
      this.sequences.set(address, received);
      return {
        valid: true,
        reset: false,
        reason: 'Sequence advanced correctly'
      };
    }
    
    // Check if this is a retry (same sequence as last)
    if (received === lastRx) {
      return {
        valid: true,
        reset: false,
        retry: true,
        reason: 'Retry of last command'
      };
    }
    
    // Sequence error
    return {
      valid: false,
      reset: false,
      reason: `Sequence error: expected ${expected}, got ${received} (last was ${lastRx})`
    };
  }

  /**
   * Handle sequence reset from PD
   * @param {number} address - PD address
   */
  handlePDReset(address) {
    this.reset(address);
  }

  /**
   * Get sequence statistics for address
   * @param {number} address - PD address
   * @returns {Object} - Statistics
   */
  getStats(address) {
    return {
      current: this.getCurrent(address),
      lastReceived: this.lastReceived.get(address) || 0,
      hasCallback: this.resetCallbacks.has(address)
    };
  }

  /**
   * Get all active addresses
   * @returns {Array} - List of addresses
   */
  getActiveAddresses() {
    return Array.from(this.sequences.keys());
  }

  /**
   * Clear all sequences (for shutdown)
   */
  clear() {
    this.sequences.clear();
    this.lastReceived.clear();
    this.resetCallbacks.clear();
  }

  /**
   * Format sequence info for logging
   * @param {number} address - PD address
   * @returns {string} - Formatted info
   */
  toString(address) {
    const current = this.getCurrent(address);
    const lastRx = this.lastReceived.get(address) || 0;
    return `addr=${address} current=${current} lastRx=${lastRx}`;
  }
}

module.exports = OSDPSequence;
