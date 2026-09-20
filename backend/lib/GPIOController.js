// GPIOController.js - GPIO controller with state tracking and protection
const EventEmitter = require('events');

class GPIOController extends EventEmitter {
  constructor(chip = 'gpiochip0') {
    super();
    this.chip = chip;
    this.states = new Map();
    this.reservedPins = new Set();
    this.pinLabels = new Map();
    this.activeProcesses = new Map();
    
    // Track pin changes for history
    this.changeHistory = [];
    this.maxHistorySize = 1000;
    
    // Safety features
    this.protectedPins = new Set();
    this.pulseTimeouts = new Map();
  }
  
  // ========== PIN RESERVATION ==========
  
  reservePin(pin, owner) {
    if (this.reservedPins.has(pin)) {
      const currentOwner = this.getPinOwner(pin);
      if (currentOwner !== owner) {
        throw new Error(`GPIO ${pin} is reserved by ${currentOwner}`);
      }
    }
    
    this.reservedPins.add(pin);
    this.pinLabels.set(pin, owner);
    console.log(`[GPIO] Pin ${pin} reserved for ${owner}`);
  }
  
  releasePin(pin, owner) {
    const currentOwner = this.getPinOwner(pin);
    if (currentOwner === owner) {
      this.reservedPins.delete(pin);
      this.pinLabels.delete(pin);
      console.log(`[GPIO] Pin ${pin} released by ${owner}`);
    }
  }
  
  isPinReserved(pin) {
    return this.reservedPins.has(pin);
  }
  
  getPinOwner(pin) {
    return this.pinLabels.get(pin);
  }
  
  protectPin(pin, reason = 'Protected') {
    this.protectedPins.add(pin);
    this.pinLabels.set(pin, reason);
  }
  
  // ========== GPIO OPERATIONS ==========
  
  async write(pin, value) {
    // Validate inputs
    pin = Number(pin);
    value = Number(value);
    
    if (!Number.isInteger(pin) || pin < 0 || pin > 27) {
      throw new Error(`Invalid GPIO pin: ${pin}`);
    }
    
    if (value !== 0 && value !== 1) {
      throw new Error(`Invalid GPIO value: ${value}`);
    }
    
    // Check if pin is protected
    if (this.protectedPins.has(pin)) {
      throw new Error(`GPIO ${pin} is protected (${this.getPinOwner(pin)})`);
    }
    
    // Check if pin is reserved
    if (this.reservedPins.has(pin)) {
      const owner = this.getPinOwner(pin);
      console.log(`[GPIO] Warning: Writing to reserved pin ${pin} (${owner})`);
    }
    
    // Get previous state
    const previousValue = this.states.get(pin);
    
    // Execute GPIO write using gpioset
    try {
      await this.executeGPIO(pin, value);
      
      // Update state
      this.states.set(pin, value);
      
      // Record change
      if (previousValue !== value) {
        this.recordChange(pin, value, previousValue);
      }
      
      // Emit events
      this.emit('gpio_change', { pin, value, previousValue });
      
      return { success: true, pin, value };
      
    } catch (err) {
      console.error(`[GPIO] Write failed for pin ${pin}:`, err);
      throw err;
    }
  }
  
  async read(pin) {
    pin = Number(pin);
    
    if (!Number.isInteger(pin) || pin < 0 || pin > 27) {
      throw new Error(`Invalid GPIO pin: ${pin}`);
    }
    
    // Return cached state if available
    if (this.states.has(pin)) {
      return this.states.get(pin);
    }
    
    // Otherwise read from hardware
    try {
      const value = await this.executeGPIORead(pin);
      this.states.set(pin, value);
      return value;
    } catch (err) {
      console.error(`[GPIO] Read failed for pin ${pin}:`, err);
      return 0; // Default to low
    }
  }
  
  async pulse(pin, duration = 500) {
    // Cancel any existing pulse
    if (this.pulseTimeouts.has(pin)) {
      clearTimeout(this.pulseTimeouts.get(pin));
      this.pulseTimeouts.delete(pin);
    }
    
    // Set high
    await this.write(pin, 1);
    
    // Schedule low
    const timeout = setTimeout(async () => {
      try {
        await this.write(pin, 0);
        this.pulseTimeouts.delete(pin);
      } catch (err) {
        console.error(`[GPIO] Pulse completion failed for pin ${pin}:`, err);
      }
    }, duration);
    
    this.pulseTimeouts.set(pin, timeout);
    
    return { success: true, pin, duration };
  }
  
  // ========== LOW-LEVEL GPIO EXECUTION ==========
  
  executeGPIO(pin, value) {
    return new Promise((resolve, reject) => {
      const { spawn } = require('child_process');
      
      // Kill any existing process for this pin
      if (this.activeProcesses.has(pin)) {
        try {
          this.activeProcesses.get(pin).kill('SIGTERM');
        } catch (err) {
          // Process may already be dead
        }
        this.activeProcesses.delete(pin);
      }
      
      // Spawn gpioset
      const args = [`${this.chip}`, `${pin}=${value}`];
      const proc = spawn('gpioset', args, {
        stdio: ['ignore', 'pipe', 'pipe']
      });
      
      let stderr = '';
      
      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      
      proc.on('error', (err) => {
        this.activeProcesses.delete(pin);
        reject(new Error(`GPIO execution failed: ${err.message}`));
      });
      
      proc.on('exit', (code) => {
        this.activeProcesses.delete(pin);
        
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`GPIO failed with code ${code}: ${stderr.trim()}`));
        }
      });
      
      // Keep process alive for persistent state
      this.activeProcesses.set(pin, proc);
      
      // For gpioset to take effect immediately
      setTimeout(() => resolve(), 10);
    });
  }
  
  executeGPIORead(pin) {
    return new Promise((resolve, reject) => {
      const { spawn } = require('child_process');
      
      const args = [`${this.chip}`, `${pin}`];
      const proc = spawn('gpioget', args, {
        stdio: ['ignore', 'pipe', 'pipe']
      });
      
      let stdout = '';
      let stderr = '';
      
      proc.stdout.on('data', (data) => {
        stdout += data.toString();
      });
      
      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });
      
      proc.on('error', (err) => {
        reject(new Error(`GPIO read failed: ${err.message}`));
      });
      
      proc.on('exit', (code) => {
        if (code === 0) {
          const value = parseInt(stdout.trim()) || 0;
          resolve(value);
        } else {
          reject(new Error(`GPIO read failed with code ${code}: ${stderr.trim()}`));
        }
      });
    });
  }
  
  // ========== STATE TRACKING ==========
  
  recordChange(pin, value, previousValue) {
    const change = {
      pin,
      value,
      previousValue,
      timestamp: Date.now(),
      owner: this.getPinOwner(pin) || 'Unknown'
    };
    
    this.changeHistory.unshift(change);
    
    // Trim history
    if (this.changeHistory.length > this.maxHistorySize) {
      this.changeHistory = this.changeHistory.slice(0, this.maxHistorySize);
    }
    
    // Emit change event
    this.emit('state_change', change);
  }
  
  getState(pin) {
    if (pin !== undefined) {
      return this.states.get(pin) || 0;
    }
    return Object.fromEntries(this.states);
  }
  
  getAllStates() {
    const states = {};
    for (const [pin, value] of this.states) {
      states[pin] = {
        value,
        owner: this.getPinOwner(pin),
        reserved: this.reservedPins.has(pin),
        protected: this.protectedPins.has(pin)
      };
    }
    return states;
  }
  
  getHistory(options = {}) {
    const { limit = 100, pin, since } = options;
    
    let filtered = this.changeHistory;
    
    if (pin !== undefined) {
      filtered = filtered.filter(change => change.pin === pin);
    }
    
    if (since) {
      filtered = filtered.filter(change => change.timestamp >= since);
    }
    
    return filtered.slice(0, limit);
  }
  
  // ========== BULK OPERATIONS ==========
  
  async writeMultiple(pinValues) {
    const results = [];
    
    for (const { pin, value } of pinValues) {
      try {
        await this.write(pin, value);
        results.push({ pin, value, success: true });
      } catch (err) {
        results.push({ pin, value, success: false, error: err.message });
      }
    }
    
    return results;
  }
  
  async setPattern(startPin, endPin, pattern) {
    const operations = [];
    
    for (let pin = startPin; pin <= endPin; pin++) {
      const bitIndex = pin - startPin;
      const value = (pattern >> bitIndex) & 1;
      operations.push({ pin, value });
    }
    
    return this.writeMultiple(operations);
  }
  
  // ========== CLEANUP ==========
  
  cleanup() {
    // Kill all active processes
    for (const [pin, proc] of this.activeProcesses) {
      try {
        proc.kill('SIGTERM');
      } catch (err) {
        // Process may already be dead
      }
    }
    this.activeProcesses.clear();
    
    // Clear pulse timeouts
    for (const timeout of this.pulseTimeouts.values()) {
      clearTimeout(timeout);
    }
    this.pulseTimeouts.clear();
    
    console.log('[GPIO] Controller cleaned up');
  }
  
  // ========== STATUS & MONITORING ==========
  
  getStatus() {
    return {
      chip: this.chip,
      totalPins: 28,
      activePins: this.states.size,
      reservedPins: this.reservedPins.size,
      protectedPins: this.protectedPins.size,
      activeProcesses: this.activeProcesses.size,
      activePulses: this.pulseTimeouts.size,
      historySize: this.changeHistory.length,
      pins: this.getAllStates()
    };
  }
  
  // ========== DOOR-SPECIFIC HELPERS ==========
  
  configureDoorPins(doorId, pins) {
    const { lock, dps, rex, aux } = pins;
    
    if (lock !== undefined) {
      this.reservePin(lock, `Door${doorId}_Lock`);
    }
    if (dps !== undefined) {
      this.reservePin(dps, `Door${doorId}_DPS`);
    }
    if (rex !== undefined) {
      this.reservePin(rex, `Door${doorId}_REX`);
    }
    if (aux !== undefined) {
      this.reservePin(aux, `Door${doorId}_AUX`);
    }
  }
  
  async lockDoor(doorId, lockPin) {
    await this.write(lockPin, 1);
    this.emit('door_locked', { doorId, pin: lockPin });
  }
  
  async unlockDoor(doorId, lockPin, duration) {
    await this.write(lockPin, 0);
    this.emit('door_unlocked', { doorId, pin: lockPin });
    
    if (duration) {
      setTimeout(async () => {
        await this.lockDoor(doorId, lockPin);
      }, duration);
    }
  }
}

module.exports = GPIOController;
