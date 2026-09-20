const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

/**
 * Sequent IOplus Controller with I2C Retry Logic
 * Manages relay outputs and opto-isolated/analog inputs
 * 
 * Features:
 * - Automatic I2C retry with exponential backoff
 * - Single board configuration (8 relays, 8 inputs)
 * - Error recovery for I2C bus congestion
 */
class IOplusController {
  constructor(maxBoards = 1) {
    this.maxBoards = maxBoards;
    this.relaysPerBoard = 8;
    this.totalRelays = maxBoards * this.relaysPerBoard;
  }

  /**
   * Execute ioplus command with retry logic
   * Implements exponential backoff to handle I2C bus congestion
   */
  async executeCommand(board, command, retries = 3) {
    // Force board to 0 if only 1 board
    if (this.maxBoards === 1) {
      board = 0;
    }
    
    const cmd = `timeout 5 ioplus ${board} ${command}`;
    let lastError;
    
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        const { stdout, stderr } = await execAsync(cmd);
        if (stderr && stderr.trim()) {
          throw new Error(stderr.trim());
        }
        
        // Success - if this was a retry, log it
        if (attempt > 0) {
          console.log(`[IOplus] Command succeeded on attempt ${attempt + 1}`);
        }
        
        return stdout.trim();
      } catch (error) {
        lastError = error;
        
        // Check for specific error types
        const stack = board;
        if (error.message.includes('No IOplus card detected')) {
          throw new Error(`Board ${stack} not detected`);
        }
        
        // If this is an I2C error and we have retries left, wait and retry
        if (attempt < retries - 1) {
          const backoffMs = Math.min(100 * Math.pow(2, attempt), 500); // 100ms, 200ms, 400ms max
          console.warn(`[IOplus] I2C error on attempt ${attempt + 1}, retrying in ${backoffMs}ms...`);
          await new Promise(resolve => setTimeout(resolve, backoffMs));
        }
      }
    }
    
    // All retries failed
    console.error(`[IOplus] Command failed after ${retries} attempts:`, lastError.message);
    throw new Error(`Command failed after ${retries} attempts: ${lastError.message}`);
  }

  /**
   * Convert logical pin to board and relay
   */
  pinToRelay(pin) {
    // Validate pin is in range for single board
    if (pin < 0 || pin >= this.totalRelays) {
      throw new Error(`Pin ${pin} out of range (0-${this.totalRelays - 1}). You only have 1 board with 8 relays.`);
    }
    
    const board = 0; // Always board 0 for single board
    const relay = pin + 1; // Relays are 1-indexed (1-8)
    
    return { board, relay };
  }

  /**
   * Convert board and relay to logical pin
   */
  relayToPin(board, relay) {
    if (board !== 0) {
      throw new Error(`Board ${board} doesn't exist. Only board 0 is available.`);
    }
    if (relay < 1 || relay > this.relaysPerBoard) {
      throw new Error(`Relay ${relay} out of range (1-${this.relaysPerBoard})`);
    }
    return relay - 1; // Convert to 0-indexed pin
  }

  /**
   * Set relay state (on/off)
   */
  async setRelay(pin, state) {
    const { board, relay } = this.pinToRelay(pin);
    
    try {
      // ioplus uses 'rwrite' for relay write
      await this.executeCommand(board, `rwrite ${relay} ${state ? 1 : 0}`);
      
      console.log(`[IOplus] Relay ${pin} (Board ${board}, Relay ${relay}) -> ${state ? 'ON' : 'OFF'}`);
      
      return {
        success: true,
        pin,
        board,
        relay,
        state
      };
    } catch (error) {
      console.error(`[IOplus] Failed to set relay:`, error.message);
      throw error;
    }
  }

  /**
   * Get relay state
   */
  async getRelay(pin) {
    const { board, relay } = this.pinToRelay(pin);
    
    try {
      const result = await this.executeCommand(board, `rread ${relay}`);
      const state = parseInt(result) === 1;
      
      return {
        success: true,
        pin,
        board,
        relay,
        state
      };
    } catch (error) {
      console.error(`[IOplus] Failed to read relay:`, error.message);
      throw error;
    }
  }

  /**
   * Read opto-isolated input (digital)
   */
  async readOptoInput(pin) {
    const board = 0;
    const input = pin + 1; // Inputs are 1-indexed (1-8)
    
    if (pin < 0 || pin >= 8) {
      throw new Error(`Input pin ${pin} out of range (0-7)`);
    }
    
    try {
      const result = await this.executeCommand(board, `optread ${input}`);
      const state = parseInt(result) === 1;
      
      return {
        success: true,
        pin,
        board,
        input,
        state,
        type: 'opto'
      };
    } catch (error) {
      console.error(`[IOplus] Failed to read opto input:`, error.message);
      throw error;
    }
  }

  /**
   * Pulse relay (turn on, wait, turn off)
   */
  async pulseRelay(pin, durationMs = 500) {
    await this.setRelay(pin, true);
    return new Promise((resolve) => {
      setTimeout(async () => {
        await this.setRelay(pin, false);
        resolve({ success: true, pin, duration: durationMs });
      }, durationMs);
    });
  }

  /**
   * Set all relays
   */
  async setAllRelays(states) {
    if (!Array.isArray(states) || states.length !== this.totalRelays) {
      throw new Error(`Expected array of ${this.totalRelays} states`);
    }
    
    const results = [];
    for (let i = 0; i < states.length; i++) {
      try {
        // Add 50ms delay between operations to reduce I2C load
        if (i > 0) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        const result = await this.setRelay(i, states[i]);
        results.push(result);
      } catch (error) {
        results.push({ success: false, pin: i, error: error.message });
      }
    }
    
    return results;
  }

  /**
   * Get all relay states
   */
  async getAllRelays() {
    const results = [];
    for (let i = 0; i < this.totalRelays; i++) {
      try {
        // Add 50ms delay between reads to reduce I2C load
        if (i > 0) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        const result = await this.getRelay(i);
        results.push(result);
      } catch (error) {
        results.push({ success: false, pin: i, error: error.message });
      }
    }
    
    return results;
  }

  /**
   * Read all opto inputs
   */
  async readAllOptoInputs() {
    const results = [];
    for (let i = 0; i < 8; i++) {
      try {
        // Add 50ms delay between reads to reduce I2C load
        if (i > 0) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        const result = await this.readOptoInput(i);
        results.push(result);
      } catch (error) {
        results.push({ success: false, pin: i, error: error.message });
      }
    }
    
    return results;
  }

  /**
   * Test I2C bus health
   */
  async healthCheck() {
    try {
      // Try to read relay 1 state as a health check
      await this.executeCommand(0, 'rread 1');
      return { 
        healthy: true, 
        message: 'I2C bus responding normally',
        board: 0
      };
    } catch (error) {
      return { 
        healthy: false, 
        message: error.message,
        board: 0
      };
    }
  }
}

module.exports = IOplusController;
