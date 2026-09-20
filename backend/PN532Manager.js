// PN532Manager.js — safer PN532 init with backoff, i2c checks, and opt-out
// Replaces previous implementation to avoid endless python shim spawns.

const { spawn, exec } = require('child_process');
const EventEmitter = require('events');
const fs = require('fs');

class PN532Manager extends EventEmitter {
  constructor(io, options = {}) {
    super();
    this.io = io;
    this.options = options || {};
    // addresses to probe before attempting node-native init or shim
    this.probeAddresses = this.options.addresses || [0x24, 0x48];
    this.pythonScript = this.options.pythonScript || 'pn532_shim.py';
    this.pythonProc = null;
    this.nodePn532 = null;
    this.backoff = { retries: 0, maxRetries: 6, baseMs: 500, maxMs: 60000 };
    this.shimStarting = false;
    this.disabled = (process.env.DISABLE_PN532 === '1') || !!this.options.disabled;
    this.lastError = null;
    this.initialized = false;
  }

  log(...args) { console.log('[PN532Manager]', ...args); }
  warn(...args) { console.warn('[PN532Manager]', ...args); }
  error(...args) { console.error('[PN532Manager]', ...args); }

  async initialize() {
    if (this.disabled) {
      this.log('Initialization skipped — PN532 disabled via env/config.');
      return false;
    }

    this.log('Starting initialization sequence (probe addresses:', this.probeAddresses.map(a=> '0x'+a.toString(16)).join(', ')+')');

    try {
      const found = await this._probeI2cAddresses();
      if (!found) {
        this.warn('No PN532 address detected on I2C bus; will NOT spawn python shim.');
        this.initialized = false;
        return false;
      }
    } catch (err) {
      this.error('I2C probe failed:', err && err.message ? err.message : err);
      // continue: probe failure -> try shim but with backoff
    }

    // Try node-native PN532 first (if package available)
    if (this._tryNativeInit()) {
      this.initialized = true;
      return true;
    }

    // Native init failed -> use Python shim but with backoff + capped retries
    await this._ensurePythonShim();
    return this.initialized;
  }

  _tryNativeInit() {
    try {
      // Attempt to require a Node PN532 driver (if installed)
      const NodePN532 = require('pn532'); // common module name; if not present this throws
      this.nodePn532 = NodePN532; // we won't try to use it here (init is hardware-specific)
      this.log('Node PN532 module available. Attempting native init...');
      // (user-specific init omitted here — keep safe default)
      // If you have a known init flow, do it and set this.initialized = true on success.
      // Example: this.node = new NodePN532(...); this.initialized = true;
      // For now, just return false to proceed to shim (prevents accidental mismatched init).
      this.warn('Native node PN532: available but no auto-init implemented here; falling back to shim.');
      return false;
    } catch (err) {
      this.log('Node PN532 module not available / native init not attempted.');
      return false;
    }
  }

  _probeI2cAddresses() {
    return new Promise((resolve, reject) => {
      // Use i2cdetect output to detect any of the probeAddresses on the i2c buses
      // We try /dev/i2c-1 by default; if multiple are present we'll scan 1,13,14 (common on your system)
      const buses = [1,13,14];
      let anyFound = false;
      let probes = buses.length;
      buses.forEach(bus => {
        exec(`i2cdetect -y ${bus}`, { timeout: 4000 }, (err, stdout, stderr) => {
          if (!err && stdout) {
            const s = stdout.toLowerCase();
            for (const addr of this.probeAddresses) {
              const hex = addr.toString(16).padStart(2,'0');
              if (s.indexOf(hex) !== -1) {
                anyFound = true;
                this.log(`i2cdetect: found 0x${hex} on /dev/i2c-${bus}`);
              }
            }
          } else {
            // non-fatal - just record it
            //this.warn('i2cdetect failed for bus', bus, err ? err.message : '');
          }
          probes -= 1;
          if (probes === 0) resolve(anyFound);
        });
      });
      // safety timeout
      setTimeout(() => {
        resolve(anyFound);
      }, 4500);
    });
  }

  async _ensurePythonShim() {
    if (this.disabled) return;
    if (this.shimStarting) {
      this.log('Python shim start already in progress; skipping duplicate start.');
      return;
    }

    // cap retries
    if (this.backoff.retries >= this.backoff.maxRetries) {
      this.error(`Python shim retry limit reached (${this.backoff.maxRetries}). Not starting further attempts.`);
      return;
    }

    this.shimStarting = true;
    const delay = Math.min(this.backoff.baseMs * (2 ** this.backoff.retries), this.backoff.maxMs);
    this.log(`Scheduling python shim spawn in ${delay} ms (attempt ${this.backoff.retries + 1}/${this.backoff.maxRetries})`);
    await new Promise(r => setTimeout(r, delay));

    // before starting, double-check presence of i2c device nodes
    const hasI2cNodes = fs.existsSync('/dev/i2c-1') || fs.existsSync('/dev/i2c-13') || fs.existsSync('/dev/i2c-14');
    if (!hasI2cNodes) {
      this.warn('No /dev/i2c-* nodes found; skipping python shim spawn.');
      this.shimStarting = false;
      this.backoff.retries++;
      return;
    }

    this._spawnPythonShim();
  }

  _spawnPythonShim() {
    try {
      this.log('Spawning python shim:', this.pythonScript);
      // give full path if needed, but running from backend dir should work
      this.pythonProc = spawn('python3', [this.pythonScript], { stdio: ['ignore','pipe','pipe'], detached: false });

      this.pythonProc.stdout.on('data', data => {
        const txt = data.toString().trim();
        this.log('[PY-OUT]', txt);
      });

      this.pythonProc.stderr.on('data', data => {
        const txt = data.toString().trim();
        this.error('[PY-ERR]', txt);
      });

      this.pythonProc.on('exit', (code, sig) => {
        this.warn(`python shim exited (code=${code} signal=${sig})`);
        this.pythonProc = null;
        this.shimStarting = false;
        // if exit code indicates I2C missing (3 in your logs), backoff and retry; else still backoff
        this.backoff.retries++;
        if (this.backoff.retries <= this.backoff.maxRetries) {
          this.log(`Will attempt restart (#${this.backoff.retries + 1}) after backoff`);
          // schedule another attempt
          setTimeout(() => this._ensurePythonShim().catch(e=>this.error(e)), Math.min(this.backoff.baseMs * (2 ** this.backoff.retries), this.backoff.maxMs));
        } else {
          this.error('Max python shim retries reached; no further restarts.');
        }
      });

      this.pythonProc.on('error', err => {
        this.error('Failed to spawn python shim:', err && err.message ? err.message : err);
        this.pythonProc = null;
        this.shimStarting = false;
        this.backoff.retries++;
      });

      // mark initialized as true only if shim spawned successfully
      this.initialized = true;
      this.log('Python shim spawned (pid=' + (this.pythonProc.pid || 'unknown') + ')');
    } catch (err) {
      this.error('Exception while spawning python shim:', err && err.message ? err.message : err);
      this.shimStarting = false;
      this.backoff.retries++;
    }
  }

  stop() {
    this.log('Stopping PN532 manager...');
    if (this.pythonProc && this.pythonProc.pid) {
      try {
        this.log('Killing python shim pid', this.pythonProc.pid);
        this.pythonProc.kill('SIGTERM');
      } catch (e) {
        this.error('Error killing python shim:', e && e.message ? e.message : e);
      }
      this.pythonProc = null;
    }
    // if any node-native resource needs closing, do it here
    this.initialized = false;
  }
}

module.exports = PN532Manager;
