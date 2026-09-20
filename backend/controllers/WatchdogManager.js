const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

/**
 * Sequent IOplus Hardware Watchdog Manager
 * 
 * The IOplus board has a built-in hardware watchdog that monitors I2C activity.
 * If no I2C reset command is received within the timeout period (default 120s),
 * the board will cut power to the Raspberry Pi and restore it after 10 seconds.
 * 
 * This manager sends periodic reset commands to keep the watchdog alive and
 * prevent unexpected power cycles.
 */
class WatchdogManager {
  constructor(options = {}) {
    this.config = {
      stack: options.stack || 0,              // Board stack level (0 for single board)
      interval: options.interval || 30000,     // Reset interval in ms (30 seconds)
      enabled: options.enabled !== false,      // Enabled by default
      reloadPeriod: options.reloadPeriod || 90 // Watchdog timeout in seconds
    };
    
    this.timer = null;
    this.active = false;
    this.stats = {
      resets: 0,
      failures: 0,
      lastReset: null,
      lastError: null,
      startTime: null
    };
  }

  /**
   * Start watchdog heartbeat
   * This activates the hardware watchdog and begins periodic resets
   */
  async start() {
    if (!this.config.enabled) {
      console.log('[Watchdog] Disabled via config - not starting');
      return false;
    }

    if (this.active) {
      console.warn('[Watchdog] Already active');
      return true;
    }

    try {
      // Step 1: Set the reload period (timeout)
      await this.setReloadPeriod(this.config.reloadPeriod);
      console.log(`[Watchdog] Reload period set to ${this.config.reloadPeriod} seconds`);

      // Step 2: Send first reset - this ACTIVATES the watchdog
      await this.reset();
      console.log('[Watchdog] Hardware watchdog ACTIVATED with initial reset');

      // Step 3: Start periodic resets
      this.timer = setInterval(() => {
        this.reset().catch(err => {
          console.error('[Watchdog] Reset failed:', err.message);
          this.stats.failures++;
          this.stats.lastError = err.message;
          
          // If too many consecutive failures, something is wrong
          if (this.stats.failures > 5) {
            console.error('[Watchdog] ⚠️  Multiple reset failures - watchdog may trigger power cycle!');
          }
        });
      }, this.config.interval);

      this.active = true;
      this.stats.startTime = new Date().toISOString();
      
      console.log(`[Watchdog] ✅ Started successfully`);
      console.log(`[Watchdog] Reset interval: ${this.config.interval / 1000}s`);
      console.log(`[Watchdog] Timeout period: ${this.config.reloadPeriod}s`);
      console.log(`[Watchdog] Safety margin: ${this.config.reloadPeriod - (this.config.interval / 1000)}s`);
      
      return true;

    } catch (error) {
      console.error('[Watchdog] ❌ Failed to start:', error.message);
      this.active = false;
      return false;
    }
  }

  /**
   * Stop watchdog heartbeat
   * WARNING: Once the watchdog is activated, stopping resets will cause power cycle!
   * Only use this during controlled shutdown.
   */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.active = false;
    console.log('[Watchdog] Stopped - WARNING: Board will power cycle if not restarted soon!');
  }

  /**
   * Reset the watchdog (send heartbeat)
   * This must be called periodically to prevent power cycle
   */
  async reset() {
    try {
      const cmd = `ioplus ${this.config.stack} wdtreset`;
      const { stdout, stderr } = await execAsync(cmd);
      
      if (stderr && stderr.trim()) {
        throw new Error(stderr.trim());
      }

      this.stats.resets++;
      this.stats.lastReset = new Date().toISOString();
      this.stats.failures = 0; // Reset failure count on success
      
      // Log every 20th reset to avoid spam (but show we're alive)
      if (this.stats.resets % 20 === 0) {
        const uptime = this.getUptime();
        console.log(`[Watchdog] ❤️  Heartbeat #${this.stats.resets} (uptime: ${uptime})`);
      }

      return true;
    } catch (error) {
      this.stats.failures++;
      this.stats.lastError = error.message;
      throw error;
    }
  }

  /**
   * Set watchdog reload period (timeout in seconds)
   */
  async setReloadPeriod(seconds) {
    if (seconds < 30) {
      throw new Error('Reload period must be at least 30 seconds');
    }
    
    try {
      const cmd = `ioplus ${this.config.stack} wdtsetreload ${seconds}`;
      const { stdout, stderr } = await execAsync(cmd);
      
      if (stderr && stderr.trim()) {
        throw new Error(stderr.trim());
      }

      this.config.reloadPeriod = seconds;
      return true;
    } catch (error) {
      throw new Error(`Failed to set reload period: ${error.message}`);
    }
  }

  /**
   * Get watchdog status from hardware
   */
  async getStatus() {
    try {
      // Get enabled status
      const enabledCmd = `ioplus ${this.config.stack} wdtget`;
      const { stdout: enabledOut } = await execAsync(enabledCmd);
      const hwEnabled = enabledOut.trim() === '1';

      // Get reload period
      const periodCmd = `ioplus ${this.config.stack} wdtgetreload`;
      const { stdout: periodOut } = await execAsync(periodCmd);
      const hwReloadPeriod = parseInt(periodOut.trim());

      // Get reset counter
      const resetCmd = `ioplus ${this.config.stack} wdtgetreset`;
      const { stdout: resetOut } = await execAsync(resetCmd);
      const powerCycles = parseInt(resetOut.trim());

      return {
        managerActive: this.active,
        hardwareEnabled: hwEnabled,
        reloadPeriod: hwReloadPeriod,
        resetInterval: this.config.interval,
        safetyMargin: hwReloadPeriod - (this.config.interval / 1000),
        powerCycles: powerCycles,
        stats: this.stats,
        uptime: this.getUptime()
      };
    } catch (error) {
      console.error('[Watchdog] Failed to get status:', error.message);
      return {
        managerActive: this.active,
        hardwareEnabled: false,
        error: error.message,
        stats: this.stats
      };
    }
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      active: this.active,
      interval: this.config.interval,
      reloadPeriod: this.config.reloadPeriod,
      uptime: this.getUptime()
    };
  }

  /**
   * Get uptime in human-readable format
   */
  getUptime() {
    if (!this.stats.startTime) return 'Not started';
    
    const start = new Date(this.stats.startTime);
    const now = new Date();
    const diffMs = now - start;
    
    const hours = Math.floor(diffMs / (1000 * 60 * 60));
    const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
    const seconds = Math.floor((diffMs % (1000 * 60)) / 1000);
    
    return `${hours}h ${minutes}m ${seconds}s`;
  }

  /**
   * Manually clear power cycle counter on hardware
   */
  async clearPowerCycles() {
    try {
      const cmd = `ioplus ${this.config.stack} wdtclrreset`;
      await execAsync(cmd);
      console.log('[Watchdog] Power cycle counter cleared');
      return true;
    } catch (error) {
      console.error('[Watchdog] Failed to clear counter:', error.message);
      return false;
    }
  }

  /**
   * Check if watchdog is healthy (resets are succeeding)
   */
  isHealthy() {
    if (!this.active) return false;
    if (this.stats.failures > 3) return false;
    
    // Check if last reset was recent
    if (this.stats.lastReset) {
      const lastReset = new Date(this.stats.lastReset);
      const now = new Date();
      const timeSinceReset = now - lastReset;
      
      // If more than 2x the interval has passed, something is wrong
      if (timeSinceReset > (this.config.interval * 2)) {
        return false;
      }
    }
    
    return true;
  }
}

module.exports = WatchdogManager;
