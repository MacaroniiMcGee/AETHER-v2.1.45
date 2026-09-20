/**
 * supervisionController.js - Calibrated Supervision Controller
 * For Aether M1.2.2 - IOplus 1K/2K EOL (No Reference Resistor)
 * 
 * CALIBRATED 2026-01-04 from 4-point calibration:
 *   TAMPER:  0.003V (2mV)    -> Short circuit
 *   ALARM:   0.204V (204mV)  -> Sensor triggered  
 *   NORMAL:  0.380V (380mV)  -> Secured
 *   TROUBLE: 3.304V (3304mV) -> Wire cut/open
 *
 * Threshold ranges calculated with safety margins:
 *   TAMPER:  0 - 103mV
 *   ALARM:   104 - 292mV
 *   NORMAL:  293 - 1354mV
 *   TROUBLE: 1355 - 3500mV
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

// Colors for console output
const c = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
};

class SupervisionController {
  constructor() {
    this.maxBoards = 1;
    this.zonesPerBoard = 8;
    this.vcc = 3.3;
    this.eolResistor = 2200;
    this.alarmResistor = 1000;
    
    // ============================================
    // CALIBRATED THRESHOLDS (millivolts)
    // From 4-point calibration on 2026-01-04
    // ============================================
    this.thresholds = {
      // TAMPER: Short circuit (measured 0.003V / 2mV)
      tamperMin: 0,
      tamperMax: 103,
      
      // ALARM: Sensor triggered (measured 0.204V / 204mV)
      alarmMin: 104,
      alarmMax: 292,
      
      // NORMAL: Closed/secured (measured 0.380V / 380mV)
      normalMin: 293,
      normalMax: 1354,
      
      // TROUBLE: Open/wire cut (measured 3.304V / 3304mV)
      troubleMin: 1355,
      troubleMax: 3500
    };
    
    console.log(`${c.cyan}[Supervision]${c.reset} Initialized with calibrated thresholds`);
    console.log(`${c.gray}  TAMPER:  ${this.thresholds.tamperMin}-${this.thresholds.tamperMax}mV${c.reset}`);
    console.log(`${c.gray}  ALARM:   ${this.thresholds.alarmMin}-${this.thresholds.alarmMax}mV${c.reset}`);
    console.log(`${c.gray}  NORMAL:  ${this.thresholds.normalMin}-${this.thresholds.normalMax}mV${c.reset}`);
    console.log(`${c.gray}  TROUBLE: ${this.thresholds.troubleMin}-${this.thresholds.troubleMax}mV${c.reset}`);
  }

  /**
   * Execute ioplus command with timeout
   */
  async executeCommand(board, command, timeout = 5000) {
    try {
      const fullCommand = `timeout ${timeout / 1000} ioplus ${board} ${command}`;
      const { stdout, stderr } = await execAsync(fullCommand);
      if (stderr && !stderr.includes('Warning')) {
        console.warn(`${c.yellow}[Supervision] Warning:${c.reset}`, stderr);
      }
      return stdout.trim();
    } catch (error) {
      throw new Error(`Command failed: ${error.message}`);
    }
  }

  /**
   * Read analog voltage (returns millivolts)
   */
  async readAnalogVoltage(board, channel) {
    if (board >= this.maxBoards) {
      throw new Error(`Board ${board} out of range`);
    }
    if (channel < 1 || channel > 8) {
      throw new Error(`Channel ${channel} out of range (1-8)`);
    }
    
    const output = await this.executeCommand(board, `adcrd ${channel}`);
    const volts = parseFloat(output);
    
    if (isNaN(volts)) {
      throw new Error(`Invalid voltage reading: ${output}`);
    }
    
    return Math.round(volts * 1000);  // Return millivolts
  }

  /**
   * Get supervision state from voltage (millivolts)
   */
  getZoneState(voltage) {
    const t = this.thresholds;
    
    if (voltage >= t.tamperMin && voltage <= t.tamperMax) {
      return 'TAMPER';
    }
    if (voltage >= t.alarmMin && voltage <= t.alarmMax) {
      return 'ALARM';
    }
    if (voltage >= t.normalMin && voltage <= t.normalMax) {
      return 'NORMAL';
    }
    if (voltage >= t.troubleMin && voltage <= t.troubleMax) {
      return 'TROUBLE';
    }
    
    return 'UNKNOWN';
  }

  /**
   * Get severity level for state
   */
  getSeverity(state) {
    const severities = {
      'TAMPER': 'critical',
      'ALARM': 'high',
      'TROUBLE': 'medium',
      'NORMAL': 'none',
      'UNKNOWN': 'medium',
      'ERROR': 'critical'
    };
    return severities[state] || 'medium';
  }

  /**
   * Get color for state (for logging)
   */
  getStateColor(state) {
    const colors = {
      'TAMPER': c.brightRed,
      'ALARM': c.brightYellow,
      'TROUBLE': c.blue,
      'NORMAL': c.brightGreen,
      'UNKNOWN': c.gray,
      'ERROR': c.red
    };
    return colors[state] || c.reset;
  }

  /**
   * Read a single supervision zone
   */
  async readZone(board, channel) {
    try {
      const voltage = await this.readAnalogVoltage(board, channel);
      const state = this.getZoneState(voltage);
      const severity = this.getSeverity(state);
      
      return {
        board,
        channel,
        zone: `${board}-${channel}`,
        voltage,
        volts: (voltage / 1000).toFixed(3),
        state,
        severity,
        isAlarm: state === 'ALARM',
        isTamper: state === 'TAMPER',
        isTrouble: state === 'TROUBLE',
        isNormal: state === 'NORMAL',
        timestamp: Date.now()
      };
    } catch (error) {
      return {
        board,
        channel,
        zone: `${board}-${channel}`,
        voltage: 0,
        volts: '0.000',
        state: 'ERROR',
        severity: 'critical',
        error: error.message,
        timestamp: Date.now()
      };
    }
  }

  /**
   * Read all zones on a board (with safe delays)
   */
  async readAllZones(board = 0) {
    const zones = [];
    
    for (let ch = 1; ch <= this.zonesPerBoard; ch++) {
      const zone = await this.readZone(board, ch);
      zones.push(zone);
      
      // 100ms delay between reads to prevent I2C lockup
      await new Promise(r => setTimeout(r, 100));
    }
    
    return zones;
  }

  /**
   * Get comprehensive status with color-coded output
   */
  async getStatus() {
    try {
      const zones = await this.readAllZones(0);
      
      const summary = {
        total: zones.length,
        normal: zones.filter(z => z.state === 'NORMAL').length,
        alarm: zones.filter(z => z.state === 'ALARM').length,
        tamper: zones.filter(z => z.state === 'TAMPER').length,
        trouble: zones.filter(z => z.state === 'TROUBLE').length,
        unknown: zones.filter(z => z.state === 'UNKNOWN').length,
        error: zones.filter(z => z.state === 'ERROR').length
      };
      
      // Color-coded console output
      console.log(`${c.cyan}[Supervision] Status:${c.reset}`);
      console.log(`  ${c.brightGreen}NORMAL: ${summary.normal}${c.reset}  |  ` +
                  `${c.brightYellow}ALARM: ${summary.alarm}${c.reset}  |  ` +
                  `${c.brightRed}TAMPER: ${summary.tamper}${c.reset}  |  ` +
                  `${c.blue}TROUBLE: ${summary.trouble}${c.reset}`);
      
      return {
        success: true,
        config: 'calibrated-4point',
        eolResistance: this.eolResistor,
        alarmResistance: this.alarmResistor,
        thresholds: this.thresholds,
        boards: [{
          board: 0,
          online: true,
          zones,
          summary
        }],
        timestamp: Date.now()
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        timestamp: Date.now()
      };
    }
  }

  /**
   * Health check
   */
  async healthCheck() {
    try {
      await this.readAnalogVoltage(0, 1);
      return { 
        healthy: true, 
        message: 'Supervision controller OK',
        thresholds: this.thresholds
      };
    } catch (error) {
      return { 
        healthy: false, 
        message: error.message 
      };
    }
  }

  /**
   * Detect available boards
   */
  async detectBoards() {
    const detected = [];
    try {
      await this.readAnalogVoltage(0, 1);
      detected.push(0);
    } catch (error) {
      // Board not present
    }
    return detected;
  }

  /**
   * Calibrate a zone - measure and verify expected voltage
   */
  async calibrateZone(board, channel, expectedState) {
    const zone = await this.readZone(board, channel);
    const stateColor = this.getStateColor(zone.state);
    
    const match = zone.state === expectedState;
    const symbol = match ? `${c.brightGreen}OK${c.reset}` : `${c.brightRed}MISMATCH${c.reset}`;
    
    console.log(`${c.cyan}[Calibration]${c.reset} Zone ${board}-${channel}: ` +
                `${stateColor}${zone.state}${c.reset} (${zone.voltage}mV) ` +
                `Expected: ${expectedState} ${symbol}`);
    
    return {
      board,
      channel,
      expectedState,
      actualState: zone.state,
      voltage: zone.voltage,
      volts: zone.volts,
      calibrated: match,
      message: match 
        ? `Zone calibrated: ${expectedState} at ${zone.volts}V`
        : `Mismatch: expected ${expectedState}, got ${zone.state} at ${zone.volts}V`
    };
  }

  /**
   * Update thresholds dynamically
   */
  setThresholds(newThresholds) {
    this.thresholds = { ...this.thresholds, ...newThresholds };
    console.log(`${c.cyan}[Supervision]${c.reset} Thresholds updated`);
    return this.thresholds;
  }

  /**
   * Get current thresholds with descriptions
   */
  getThresholds() {
    return {
      ...this.thresholds,
      description: {
        tamper: `${this.thresholds.tamperMin}-${this.thresholds.tamperMax}mV (short circuit)`,
        alarm: `${this.thresholds.alarmMin}-${this.thresholds.alarmMax}mV (sensor triggered)`,
        normal: `${this.thresholds.normalMin}-${this.thresholds.normalMax}mV (secured)`,
        trouble: `${this.thresholds.troubleMin}-${this.thresholds.troubleMax}mV (wire cut/open)`
      }
    };
  }
}

module.exports = new SupervisionController();
