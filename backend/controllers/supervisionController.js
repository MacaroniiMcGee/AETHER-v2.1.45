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
const fs = require('fs');
const path = require('path');
const execAsync = promisify(exec);
const i2cBus = require('../lib/i2cBus');

// Where applied calibrations are stored. Lives in backend/data, which nodemon
// ignores (*.json), so saving a calibration does not restart the server.
const CALIBRATION_FILE = path.join(__dirname, '..', 'data', 'supervision-calibration.json');

// The four wiring states captured during a calibration, in voltage order.
const CAL_STATES = ['TAMPER', 'ALARM', 'NORMAL', 'TROUBLE'];

// Two neighbouring states closer than this (mV) can't be told apart reliably.
const MIN_STATE_SEPARATION_MV = 50;
// Spread (max - min) across one capture above this suggests a loose wire or noise.
const MAX_SAMPLE_SPREAD_MV = 40;

// 1000 -> "1k", 2200 -> "2.2k", 4500 -> "4.5k", 470 -> "470"
function fmtOhms(ohms) {
  const n = Number(ohms);
  if (!Number.isFinite(n) || n <= 0) return '?';
  if (n >= 1e6) return `${+(n / 1e6).toFixed(2)}M`;
  if (n >= 1000) return `${+(n / 1000).toFixed(2)}k`;
  return String(Math.round(n));
}

function newId() {
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function cleanName(name) {
  const n = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!n) throw new Error('Profile name is required');
  return n;
}

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

    // Built-in factory profile, used until a calibration is saved and as the
    // fallback when a zone's profile is deleted. It can't be edited or deleted.
    this.factoryProfile = {
      id: 'factory',
      name: `Factory ${fmtOhms(this.alarmResistor)}/${fmtOhms(this.eolResistor)}`,
      builtIn: true,
      eolResistor: this.eolResistor,
      alarmResistor: this.alarmResistor,
      thresholds: { ...this.thresholds },
      calibrationDate: '2026-01-04T12:00:00.000Z',
      measurements: {
        TAMPER: { volts: 0.003, millivolts: 3 },
        ALARM: { volts: 0.204, millivolts: 204 },
        NORMAL: { volts: 0.380, millivolts: 380 },
        TROUBLE: { volts: 3.304, millivolts: 3304 }
      }
    };

    // Saved profiles (one per resistor pair / wiring type), the default profile,
    // and which zones use a non-default profile. See loadCalibrationStore().
    this.store = { version: 2, defaultProfileId: 'factory', profiles: [], zoneProfiles: {}, history: [] };
    this.calibrationSession = null;
    this.loadCalibrationStore();
    this.syncDefaultProfile();

    const def = this.getDefaultProfile();
    console.log(`${c.cyan}[Supervision]${c.reset} Initialized, default profile "${def.name}" (${this.store.profiles.length} saved, ${Object.keys(this.store.zoneProfiles).length} zone overrides)`);
    console.log(`${c.gray}  TAMPER:  ${this.thresholds.tamperMin}-${this.thresholds.tamperMax}mV${c.reset}`);
    console.log(`${c.gray}  ALARM:   ${this.thresholds.alarmMin}-${this.thresholds.alarmMax}mV${c.reset}`);
    console.log(`${c.gray}  NORMAL:  ${this.thresholds.normalMin}-${this.thresholds.normalMax}mV${c.reset}`);
    console.log(`${c.gray}  TROUBLE: ${this.thresholds.troubleMin}-${this.thresholds.troubleMax}mV${c.reset}`);
  }

  // ============================================
  // CALIBRATION PROFILES
  // ============================================
  //
  // File: backend/data/supervision-calibration.json
  // {
  //   version: 2,
  //   defaultProfileId: "p-...",           // used by every zone without an override
  //   profiles: [ { id, name, eolResistor, alarmResistor, thresholds, measurements, ... } ],
  //   zoneProfiles: { "0-3": "p-..." },    // per-zone overrides
  //   history: [ { at, action, profileId, name } ]
  // }

  loadCalibrationStore() {
    try {
      if (!fs.existsSync(CALIBRATION_FILE)) return;
      const saved = JSON.parse(fs.readFileSync(CALIBRATION_FILE, 'utf8'));

      if (saved && saved.version === 2) {
        this.store = {
          version: 2,
          defaultProfileId: saved.defaultProfileId || 'factory',
          profiles: Array.isArray(saved.profiles) ? saved.profiles.filter(p => p && p.id && p.thresholds) : [],
          zoneProfiles: saved.zoneProfiles && typeof saved.zoneProfiles === 'object' ? saved.zoneProfiles : {},
          history: Array.isArray(saved.history) ? saved.history : []
        };
      } else if (saved && saved.current && saved.current.thresholds && !saved.current.reset) {
        // Older single-calibration file: keep it as a profile and make it the default.
        const cur = saved.current;
        const profile = {
          id: newId(),
          name: `${fmtOhms(cur.alarmResistor)}/${fmtOhms(cur.eolResistor)}`,
          eolResistor: cur.eolResistor,
          alarmResistor: cur.alarmResistor,
          thresholds: { ...this.factoryProfile.thresholds, ...cur.thresholds },
          measurements: cur.measurements || null,
          calibrationDate: cur.calibrationDate,
          board: cur.board, channel: cur.channel,
          technician: cur.technician || null, notes: cur.notes || null
        };
        this.store.profiles = [profile];
        this.store.defaultProfileId = profile.id;
        this.addHistory('migrated', profile);
      }

      // Drop references to profiles that no longer exist.
      if (!this.getProfile(this.store.defaultProfileId)) this.store.defaultProfileId = 'factory';
      for (const [zone, id] of Object.entries(this.store.zoneProfiles)) {
        if (!this.getProfile(id)) delete this.store.zoneProfiles[zone];
      }
    } catch (error) {
      console.warn(`${c.yellow}[Supervision]${c.reset} Could not load ${CALIBRATION_FILE}: ${error.message}`);
    }
  }

  /** Write the store atomically (temp file + rename). */
  saveCalibrationStore() {
    this.store.history = this.store.history.slice(0, 50);
    fs.mkdirSync(path.dirname(CALIBRATION_FILE), { recursive: true });
    const tmp = `${CALIBRATION_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.store, null, 2));
    fs.renameSync(tmp, CALIBRATION_FILE);
  }

  addHistory(action, profile, extra = {}) {
    this.store.history.unshift({
      at: new Date().toISOString(),
      action,
      profileId: profile ? profile.id : null,
      name: profile ? profile.name : null,
      ...extra
    });
  }

  /** Keep the legacy fields (thresholds, eolResistor, ...) pointing at the default profile. */
  syncDefaultProfile() {
    const def = this.getDefaultProfile();
    this.thresholds = { ...def.thresholds };
    this.eolResistor = def.eolResistor;
    this.alarmResistor = def.alarmResistor;
    this.calibration = def.builtIn ? null : def;
  }

  getProfiles() {
    return [this.factoryProfile, ...this.store.profiles];
  }

  getProfile(id) {
    if (!id) return null;
    return this.getProfiles().find(p => p.id === id) || null;
  }

  getDefaultProfile() {
    return this.getProfile(this.store.defaultProfileId) || this.factoryProfile;
  }

  /** Profile a zone uses: its override if it has one, otherwise the default. */
  getZoneProfile(board, channel) {
    const id = this.store.zoneProfiles[`${board}-${channel}`];
    return this.getProfile(id) || this.getDefaultProfile();
  }

  findProfileByName(name) {
    const n = String(name || '').trim().toLowerCase();
    return this.getProfiles().find(p => p.name.trim().toLowerCase() === n) || null;
  }

  requireEditableProfile(id) {
    const p = this.getProfile(id);
    if (!p) throw new Error(`Profile ${id} not found`);
    if (p.builtIn) throw new Error('The factory profile can’t be changed. Save a new profile instead.');
    return p;
  }

  renameProfile(id, name) {
    const p = this.requireEditableProfile(id);
    const clean = cleanName(name);
    const clash = this.findProfileByName(clean);
    if (clash && clash.id !== id) throw new Error(`A profile named "${clean}" already exists`);
    const old = p.name;
    p.name = clean;
    this.addHistory('renamed', p, { from: old });
    this.saveCalibrationStore();
    return p;
  }

  setDefaultProfile(id) {
    const p = this.getProfile(id);
    if (!p) throw new Error(`Profile ${id} not found`);
    this.store.defaultProfileId = p.id;
    this.addHistory('set-default', p);
    this.syncDefaultProfile();
    this.saveCalibrationStore();
    return p;
  }

  deleteProfile(id) {
    const p = this.requireEditableProfile(id);
    this.store.profiles = this.store.profiles.filter(x => x.id !== id);
    const unassigned = [];
    for (const [zone, pid] of Object.entries(this.store.zoneProfiles)) {
      if (pid === id) { delete this.store.zoneProfiles[zone]; unassigned.push(zone); }
    }
    if (this.store.defaultProfileId === id) this.store.defaultProfileId = 'factory';
    this.addHistory('deleted', p, { unassignedZones: unassigned });
    this.syncDefaultProfile();
    this.saveCalibrationStore();
    return { deleted: p, unassignedZones: unassigned };
  }

  /**
   * Point a zone at a profile. Passing null/'default' makes it follow the default.
   */
  assignZoneProfile(board, channel, profileId) {
    this.checkZone(board, channel);
    const key = `${board}-${channel}`;
    if (!profileId || profileId === 'default') {
      delete this.store.zoneProfiles[key];
    } else {
      const p = this.getProfile(profileId);
      if (!p) throw new Error(`Profile ${profileId} not found`);
      this.store.zoneProfiles[key] = p.id;
    }
    this.saveCalibrationStore();
    return { zone: key, profile: this.getZoneProfile(board, channel), override: !!this.store.zoneProfiles[key] };
  }

  checkZone(board, channel) {
    if (!Number.isInteger(board) || board < 0 || board >= this.maxBoards) {
      throw new Error(`Board ${board} out of range (0-${this.maxBoards - 1})`);
    }
    if (!Number.isInteger(channel) || channel < 1 || channel > this.zonesPerBoard) {
      throw new Error(`Channel ${channel} out of range (1-${this.zonesPerBoard})`);
    }
  }

  // ============================================
  // 4-POINT CALIBRATION (replaces 4point.sh)
  // ============================================

  /**
   * Take several ADC readings on one channel and average them.
   * Individual failed reads are skipped; it only fails if every read fails.
   */
  async sampleVoltage(board, channel, samples = 5, delayMs = 100) {
    const n = Math.max(1, Math.min(50, parseInt(samples, 10) || 5));
    const readings = [];
    const errors = [];

    for (let i = 0; i < n; i++) {
      try {
        readings.push(await this.readAnalogVoltage(board, channel));
      } catch (error) {
        errors.push(error.message);
      }
      if (i < n - 1) await new Promise(r => setTimeout(r, delayMs));
    }

    if (readings.length === 0) {
      throw new Error(`No valid ADC readings on board ${board} channel ${channel}: ${errors[0] || 'unknown error'}`);
    }

    const sum = readings.reduce((a, b) => a + b, 0);
    const millivolts = Math.round(sum / readings.length);
    const min = Math.min(...readings);
    const max = Math.max(...readings);

    return {
      millivolts,
      volts: parseFloat((millivolts / 1000).toFixed(3)),
      min,
      max,
      spread: max - min,
      readings,
      samplesRequested: n,
      samplesOk: readings.length,
      failedReads: errors.length
    };
  }

  /**
   * Work out threshold bands from the four measured voltages (millivolts).
   * Same maths as 4point.sh so results match the terminal tool:
   *   boundary TAMPER|ALARM  = halfway between them
   *   boundary ALARM|NORMAL  = halfway between them
   *   boundary NORMAL|TROUBLE = one third of the way from NORMAL to TROUBLE
   *     (TROUBLE sits near the rail, so the band is kept closer to NORMAL)
   * Returns the thresholds plus any problems found with the measurements.
   */
  computeThresholds(mv) {
    const errors = [];
    const warnings = [];

    for (const s of CAL_STATES) {
      if (typeof mv[s] !== 'number' || isNaN(mv[s])) errors.push(`${s} has not been measured`);
    }
    if (errors.length) return { thresholds: null, errors, warnings };

    for (let i = 1; i < CAL_STATES.length; i++) {
      const lo = CAL_STATES[i - 1];
      const hi = CAL_STATES[i];
      const gap = mv[hi] - mv[lo];
      if (gap <= 0) {
        errors.push(`${hi} (${mv[hi]}mV) should read higher than ${lo} (${mv[lo]}mV). Check the wiring for each step.`);
      } else if (gap < MIN_STATE_SEPARATION_MV) {
        errors.push(`${lo} and ${hi} are only ${gap}mV apart (need ${MIN_STATE_SEPARATION_MV}mV). Check the resistor values.`);
      }
    }
    if (errors.length) return { thresholds: null, errors, warnings };

    const tamperMax = Math.floor(mv.TAMPER + (mv.ALARM - mv.TAMPER) / 2);
    const alarmMax = Math.floor(mv.ALARM + (mv.NORMAL - mv.ALARM) / 2);
    const normalMax = Math.floor(mv.NORMAL + (mv.TROUBLE - mv.NORMAL) / 3);
    const troubleMax = Math.max(3500, mv.TROUBLE + 200);

    const thresholds = {
      tamperMin: 0,
      tamperMax,
      alarmMin: tamperMax + 1,
      alarmMax,
      normalMin: alarmMax + 1,
      normalMax,
      troubleMin: normalMax + 1,
      troubleMax
    };

    if (mv.TAMPER > 150) warnings.push(`TAMPER read ${mv.TAMPER}mV; a dead short usually reads near 0mV.`);
    if (mv.TROUBLE < this.vcc * 1000 * 0.8) warnings.push(`TROUBLE read ${mv.TROUBLE}mV; an open loop usually reads close to ${Math.round(this.vcc * 1000)}mV.`);

    return { thresholds, errors, warnings };
  }

  /**
   * Begin a new 4-point calibration on one channel.
   * options.profileId = recalibrate an existing profile (keeps its name and resistors
   * unless new values are passed).
   */
  startCalibration(board, channel, options = {}) {
    this.checkZone(board, channel);

    let target = null;
    if (options.profileId) {
      target = this.requireEditableProfile(options.profileId);
    }

    const eol = Number(options.eolResistor) || (target && target.eolResistor) || this.eolResistor;
    const alarm = Number(options.alarmResistor) || (target && target.alarmResistor) || this.alarmResistor;

    this.calibrationSession = {
      id: `cal-${Date.now()}`,
      board,
      channel,
      eolResistor: eol,
      alarmResistor: alarm,
      targetProfileId: target ? target.id : null,
      suggestedName: target ? target.name : `${fmtOhms(alarm)}/${fmtOhms(eol)}`,
      samples: Math.max(1, Math.min(50, parseInt(options.samples, 10) || 5)),
      technician: options.technician ? String(options.technician).slice(0, 80) : null,
      notes: options.notes ? String(options.notes).slice(0, 500) : null,
      startedAt: new Date().toISOString(),
      points: {}
    };
    console.log(`${c.cyan}[Calibration]${c.reset} Started on zone ${board}-${channel} (${this.calibrationSession.suggestedName})`);
    return this.getCalibrationSession();
  }

  /**
   * Measure one of the four states for the calibration in progress.
   * Re-capturing a state overwrites the previous reading for it.
   */
  async captureCalibrationPoint(state, samples) {
    const session = this.calibrationSession;
    if (!session) throw new Error('No calibration in progress. Start one first.');
    const key = String(state || '').toUpperCase();
    if (!CAL_STATES.includes(key)) {
      throw new Error(`Unknown state "${state}". Use one of ${CAL_STATES.join(', ')}.`);
    }

    const result = await this.sampleVoltage(session.board, session.channel, samples || session.samples);
    const warnings = [];
    if (result.spread > MAX_SAMPLE_SPREAD_MV) {
      warnings.push(`Readings varied by ${result.spread}mV. Check for a loose connection and re-capture.`);
    }
    if (result.failedReads > 0) {
      warnings.push(`${result.failedReads} of ${result.samplesRequested} reads failed.`);
    }

    session.points[key] = { ...result, warnings, capturedAt: new Date().toISOString() };
    const stateColor = this.getStateColor(key);
    console.log(`${c.cyan}[Calibration]${c.reset} ${stateColor}${key}${c.reset}: ${result.millivolts}mV (spread ${result.spread}mV)`);
    return { state: key, point: session.points[key], session: this.getCalibrationSession() };
  }

  /**
   * Current session with a live preview of the thresholds it would produce.
   */
  getCalibrationSession() {
    const session = this.calibrationSession;
    if (!session) return null;
    const mv = {};
    for (const s of CAL_STATES) {
      if (session.points[s]) mv[s] = session.points[s].millivolts;
    }
    const captured = CAL_STATES.filter(s => session.points[s]);
    const preview = captured.length === CAL_STATES.length ? this.computeThresholds(mv) : null;
    return {
      ...session,
      captured,
      remaining: CAL_STATES.filter(s => !session.points[s]),
      complete: captured.length === CAL_STATES.length,
      preview
    };
  }

  /**
   * Save the captured calibration as a named profile.
   * options:
   *   name         profile name, e.g. "1k/2.2k" (defaults to the resistor pair)
   *   profileId    overwrite this existing profile instead of creating a new one
   *   makeDefault  use it for every zone without an override
   *   assignZone   make the test zone use this profile
   */
  applyCalibration(options = {}) {
    const session = this.getCalibrationSession();
    if (!session) throw new Error('No calibration in progress.');
    if (!session.complete) throw new Error(`Still need to capture: ${session.remaining.join(', ')}`);
    if (!session.preview || !session.preview.thresholds) {
      throw new Error(`Calibration can't be applied: ${(session.preview && session.preview.errors || []).join(' ')}`);
    }

    const name = cleanName(options.name || session.suggestedName);
    const overwriteId = options.profileId || null;
    let profile = overwriteId ? this.requireEditableProfile(overwriteId) : null;

    const clash = this.findProfileByName(name);
    if (clash && (!profile || clash.id !== profile.id)) {
      throw new Error(clash.builtIn
        ? `"${name}" is the factory profile's name. Pick another name.`
        : `A profile named "${name}" already exists. Choose it to overwrite, or pick another name.`);
    }

    const measurements = {};
    for (const s of CAL_STATES) {
      const p = session.points[s];
      measurements[s] = { volts: p.volts, millivolts: p.millivolts, spread: p.spread, samples: p.samplesOk };
    }

    const data = {
      name,
      eolResistor: session.eolResistor,
      alarmResistor: session.alarmResistor,
      thresholds: { ...session.preview.thresholds },
      measurements,
      warnings: session.preview.warnings,
      calibrationDate: new Date().toISOString(),
      board: session.board,
      channel: session.channel,
      technician: session.technician,
      notes: session.notes
    };

    let action;
    if (profile) {
      data.previousThresholds = { ...profile.thresholds };
      Object.assign(profile, data);
      action = 'recalibrated';
    } else {
      profile = { id: newId(), ...data };
      this.store.profiles.push(profile);
      action = 'created';
    }

    // First saved profile becomes the default unless told otherwise.
    const makeDefault = options.makeDefault !== undefined
      ? !!options.makeDefault
      : this.store.defaultProfileId === 'factory' && this.store.profiles.length === 1;
    if (makeDefault) this.store.defaultProfileId = profile.id;
    if (options.assignZone) this.store.zoneProfiles[`${session.board}-${session.channel}`] = profile.id;

    this.addHistory(action, profile, { zone: `${session.board}-${session.channel}`, makeDefault });
    this.syncDefaultProfile();
    this.saveCalibrationStore();
    this.calibrationSession = null;
    console.log(`${c.brightGreen}[Calibration]${c.reset} Profile "${profile.name}" ${action}${makeDefault ? ' (default)' : ''}`);
    return profile;
  }

  cancelCalibration() {
    const had = !!this.calibrationSession;
    this.calibrationSession = null;
    return had;
  }

  /**
   * Go back to the factory profile as default and clear zone overrides.
   * Saved profiles are kept.
   */
  resetCalibrationToDefaults() {
    this.store.defaultProfileId = 'factory';
    this.store.zoneProfiles = {};
    this.addHistory('reset', this.factoryProfile);
    this.syncDefaultProfile();
    this.saveCalibrationStore();
    this.calibrationSession = null;
    return this.factoryProfile;
  }

  getCalibrationInfo() {
    return {
      states: CAL_STATES,
      thresholds: this.thresholds,
      eolResistor: this.eolResistor,
      alarmResistor: this.alarmResistor,
      vcc: this.vcc,
      maxBoards: this.maxBoards,
      zonesPerBoard: this.zonesPerBoard,
      defaultProfileId: this.getDefaultProfile().id,
      profiles: this.getProfiles(),
      zoneProfiles: { ...this.store.zoneProfiles },
      session: this.getCalibrationSession(),
      history: this.store.history.slice(0, 15)
    };
  }

  /**
   * Execute ioplus command with timeout
   */
  async executeCommand(board, command, timeout = 5000) {
    try {
      // Shared bus gate: supervision ADC reads used to run the ioplus CLI
      // directly, overlapping relay/input commands from the GPIO queue.
      return await i2cBus.run([board, ...String(command).split(/\s+/)], { source: 'supervision', timeoutMs: timeout, allowStderr: true });
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
  getZoneState(voltage, board, channel) {
    // Zones can use their own profile (e.g. a 3k/4.5k door on a 1k/2.2k panel).
    // Zones without an override use this.thresholds (the default profile, which
    // setThresholds() can still tweak at runtime).
    const overrideId = board !== undefined && channel !== undefined
      ? this.store.zoneProfiles[`${board}-${channel}`]
      : null;
    const override = overrideId ? this.getProfile(overrideId) : null;
    const t = override ? override.thresholds : this.thresholds;
    
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
      const state = this.getZoneState(voltage, board, channel);
      const severity = this.getSeverity(state);
      const profile = this.getZoneProfile(board, channel);
      
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
        profileId: profile.id,
        profileName: profile.name,
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
  /**
   * Cached status. A full scan is 8 ADC reads on the I2C bus; every viewer
   * (VMS stream, Tools preview, other browsers) used to trigger its own.
   * Now one scan is shared by everyone asking within STATUS_TTL_MS, and
   * callers arriving mid-scan wait for that scan instead of starting another.
   */
  async getStatus() {
    const STATUS_TTL_MS = 5000;
    const now = Date.now();
    if (this._statusCache && now - this._statusCache.at < STATUS_TTL_MS) return this._statusCache.value;
    if (this._statusInFlight) return this._statusInFlight;
    this._statusInFlight = this._scanStatus()
      .then(value => { this._statusCache = { at: Date.now(), value }; return value; })
      .finally(() => { this._statusInFlight = null; });
    return this._statusInFlight;
  }

  async _scanStatus() {
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
