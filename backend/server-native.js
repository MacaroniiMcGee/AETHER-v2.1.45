/**
 * server.js - NATIVE I2C VERSION
 * 
 * Uses direct I2C communication instead of spawning ioplus CLI
 * This is MUCH faster - no process overhead per command
 * 
 * Run with: sudo node server.js
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { spawn, execFile, exec } = require('child_process');
const { promisify } = require('util');
const EventEmitter = require('events');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');

const execAsync = promisify(exec);

// Use native I2C controller
const IOplusNative = require('./IOplusNative');

// ============================================
// Express & Socket.IO Setup
// ============================================

let ServerLogger;
try {
  ServerLogger = require('./serverLogger');
} catch (e) {
  ServerLogger = null;
}

const AutomationManager = require('./automation/AutomationManager');
const WiegandManager = require('./wiegand/WiegandManager');
const OSDPManager = require('./osdp/OSDPManager');

// Log routes
let logRoutes = null;
let logSystemEvent = () => {};
let logAccessEvent = () => {};
let logSecurityEvent = () => {};
try {
  const _logs = require('./routes/logs');
  logRoutes = _logs.router || null;
  logSystemEvent = _logs.logSystemEvent || logSystemEvent;
  logAccessEvent = _logs.logAccessEvent || logAccessEvent;
  logSecurityEvent = _logs.logSecurityEvent || logSecurityEvent;
} catch (e) {}

// NFC - DISABLED by default
let PN532Manager = null;
try {
  PN532Manager = require('./nfc/PN532Manager');
} catch (e) {}

// Format API
const formatRoutes = require('./routes/formats');

// Supervision routes
let supervisionRoutes = null;
try {
  supervisionRoutes = require('./routes/supervision-routes');
} catch (e) {}

// ---- Global config ----
const CHIP = 'gpiochip0';
const I2C_ADDRESS = parseInt(process.env.IOPLUS_ADDRESS || '0x31', 16);
const I2C_BUS = parseInt(process.env.I2C_BUS || '1', 10);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET","POST","PUT","PATCH","DELETE"] } });

app.use(cors());
app.use(express.json());
app.use('/api/formats', formatRoutes);

app.use((req, res, next) => {
  req.io = io;
  next();
});

if (logRoutes) {
  app.use('/api/logs', logRoutes);
}

if (supervisionRoutes) {
  app.use('/api/supervision', supervisionRoutes);
}

// ============================================
// Initialize NATIVE IOplus Controller
// ============================================
const ioplus = new IOplusNative({
  busNumber: I2C_BUS,
  address: I2C_ADDRESS,
  minDelayMs: 5  // Only 5ms between operations!
});

// Open I2C bus on startup
(async () => {
  try {
    await ioplus.open();
    console.log('[Server] Native I2C controller ready');
    console.log(`[Server] I2C Bus: ${I2C_BUS}, Address: 0x${I2C_ADDRESS.toString(16)}`);
    console.log('[Server] Min delay between commands: 5ms (was ~200ms with CLI)');
  } catch (err) {
    console.error('[Server] CRITICAL: Failed to open I2C bus:', err.message);
    console.error('[Server] Make sure you run with sudo and I2C is enabled');
    process.exit(1);
  }
})();

// ============================================
// InputMonitor Class - Uses native I2C
// ============================================
class InputMonitor extends EventEmitter {
  constructor(controller, io, options = {}) {
    super();
    
    this.controller = controller;
    this.io = io;
    this.enabled = false;
    this.polling = false;
    this.pollInterval = null;
    
    this.config = {
      pollIntervalMs: options.pollIntervalMs || 500,  // Can poll faster now!
      enableOpto: options.enableOpto !== false,
      enableAnalog: options.enableAnalog !== false,
      optoChannels: 8,
      analogChannels: 8
    };
    
    this.thresholds = {
      tamperMin: 0, tamperMax: 103,
      alarmMin: 104, alarmMax: 292,
      normalMin: 293, normalMax: 1354,
      troubleMin: 1355, troubleMax: 3500
    };
    
    this.optoConfig = { 0: 'NO', 1: 'NO', 2: 'NO', 3: 'NO', 4: 'NO', 5: 'NO', 6: 'NO', 7: 'NO' };
    this.optoStates = new Map();
    this.analogStates = new Map();
    this.lastPollTime = 0;
    
    console.log('[InputMonitor] Initialized (native I2C mode)');
  }

  getOptoSupervisionState(pin, rawState) {
    const config = this.optoConfig[pin] || 'NO';
    const isHigh = rawState === 1 || rawState === true;
    
    if (config === 'NC') {
      return { state: isHigh ? 'NORMAL' : 'ACTIVE', severity: isHigh ? 'none' : 'high', config: 'NC' };
    } else {
      return { state: isHigh ? 'ACTIVE' : 'NORMAL', severity: isHigh ? 'high' : 'none', config: 'NO' };
    }
  }

  getSupervisionState(millivolts) {
    const t = this.thresholds;
    if (millivolts >= t.tamperMin && millivolts <= t.tamperMax) return { state: 'TAMPER', severity: 'critical' };
    if (millivolts >= t.alarmMin && millivolts <= t.alarmMax) return { state: 'ALARM', severity: 'high' };
    if (millivolts >= t.normalMin && millivolts <= t.normalMax) return { state: 'NORMAL', severity: 'none' };
    if (millivolts >= t.troubleMin && millivolts <= t.troubleMax) return { state: 'TROUBLE', severity: 'medium' };
    return { state: 'UNKNOWN', severity: 'medium' };
  }

  async pollOnce() {
    if (!this.enabled || this.polling) return;
    
    this.polling = true;
    const timestamp = Date.now();
    
    try {
      // Read ALL opto inputs in one I2C operation
      if (this.config.enableOpto) {
        try {
          const optoResults = await this.controller.readAllOptoInputs();
          
          for (const result of optoResults) {
            const pin = result.pin;
            const currentState = result.state ? 1 : 0;
            const previousEntry = this.optoStates.get(pin);
            const previousState = previousEntry?.rawState;
            
            const supervision = this.getOptoSupervisionState(pin, currentState);
            
            if (previousState !== currentState) {
              this.optoStates.set(pin, { rawState: currentState, supervisionState: supervision.state, config: supervision.config });
              
              const event = {
                type: 'opto', pin,
                state: supervision.state === 'ACTIVE' ? 1 : 0,
                rawState: currentState,
                supervisionState: supervision.state,
                severity: supervision.severity,
                config: supervision.config,
                timestamp
              };
              
              this.io.emit('input_state_change', event);
              this.emit('opto_change', event);
            }
          }
        } catch (err) {
          // Ignore read errors during polling
        }
      }
      
      // Read analog inputs
      if (this.config.enableAnalog) {
        try {
          const analogResults = await this.controller.readAllAnalogInputs();
          
          for (const result of analogResults) {
            const channel = result.pin;
            const millivolts = result.millivolts;
            const supervision = this.getSupervisionState(millivolts);
            const previousState = this.analogStates.get(channel);
            
            if (!previousState || previousState.state !== supervision.state) {
              this.analogStates.set(channel, { voltage: millivolts, state: supervision.state });
              
              const event = {
                type: 'analog', pin: channel,
                state: supervision.state === 'ALARM' ? 1 : 0,
                voltage: millivolts,
                volts: result.volts,
                supervisionState: supervision.state,
                severity: supervision.severity,
                timestamp
              };
              
              this.io.emit('input_state_change', event);
              this.emit('analog_change', event);
            }
          }
        } catch (err) {
          // Ignore read errors during polling
        }
      }
      
      this.lastPollTime = timestamp;
      
    } finally {
      this.polling = false;
    }
  }

  start() {
    if (this.enabled) return;
    
    this.enabled = true;
    console.log('[InputMonitor] Starting...');
    
    setTimeout(() => this.pollOnce(), 500);
    
    this.pollInterval = setInterval(() => {
      this.pollOnce().catch(() => {});
    }, this.config.pollIntervalMs);
    
    console.log(`[InputMonitor] Running (${this.config.pollIntervalMs}ms interval)`);
  }

  stop() {
    if (!this.enabled) return;
    
    this.enabled = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    console.log('[InputMonitor] Stopped');
  }

  getStates() {
    return {
      opto: Object.fromEntries(this.optoStates),
      analog: Object.fromEntries(this.analogStates),
      optoConfig: this.optoConfig,
      isRunning: this.enabled,
      lastPollTime: this.lastPollTime,
      config: this.config
    };
  }

  setOptoConfig(pin, type) {
    if (pin < 0 || pin >= 8) throw new Error(`Invalid pin: ${pin}`);
    if (type !== 'NO' && type !== 'NC') throw new Error(`Invalid type: ${type}`);
    this.optoConfig[pin] = type;
    return this.optoConfig;
  }

  setAllOptoConfig(config) {
    this.optoConfig = { ...this.optoConfig, ...config };
    return this.optoConfig;
  }

  setThresholds(t) {
    this.thresholds = { ...this.thresholds, ...t };
    return this.thresholds;
  }

  setConfig(c) {
    const wasRunning = this.enabled;
    if (wasRunning) this.stop();
    this.config = { ...this.config, ...c };
    if (wasRunning) this.start();
    return this.config;
  }
}

// Initialize InputMonitor
const inputMonitor = new InputMonitor(ioplus, io, {
  pollIntervalMs: 500,  // Fast polling now!
  enableOpto: true,
  enableAnalog: true
});

// ---- Native Wiegand binary ----
const WIEGAND_TX_PATH = path.join(__dirname, 'bin', 'wiegand_tx');
const ALT_WIEGAND_TX_PATH = path.join(__dirname, 'wiegand', 'wiegand_tx');
const RESOLVED_WIEGAND_TX_PATH = fs.existsSync(WIEGAND_TX_PATH) ? WIEGAND_TX_PATH
  : (fs.existsSync(ALT_WIEGAND_TX_PATH) ? ALT_WIEGAND_TX_PATH : WIEGAND_TX_PATH);

const wiegandHistory = [];
const MAX_HISTORY = 100;

// ---- Sequences dir ----
const SEQUENCES_DIR = path.join(__dirname, 'data', 'sequences');
(async () => {
  try { await fsp.mkdir(SEQUENCES_DIR, { recursive: true }); } catch (e) {}
})();

function safeId(str='') { return String(str).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64) || String(Date.now()); }
async function loadJson(file) { return JSON.parse(await fsp.readFile(file, 'utf8')); }

class GPIOEventEmitter extends EventEmitter {}
const gpioEvents = new GPIOEventEmitter();

// Initialize systems
let automationManager = null;
let wiegandManager = null;
let osdpManager = null;
let nfcManager = null;
let nfcBridge = null;

const logger = ServerLogger ? new ServerLogger({ style: 'modern', useColors: true, useBox: true }) : null;

async function initializeSystems() {
  try {
    wiegandManager = new WiegandManager();
    await wiegandManager.initialize();
    console.log('[Wiegand] Initialized');
  } catch (err) {
    console.error('[Wiegand] Failed:', err.message);
    wiegandManager = null;
  }

  try {
    osdpManager = new OSDPManager();
    await osdpManager.initialize();
    console.log('[OSDP] Initialized');
    
    if (osdpManager && typeof osdpManager.on === 'function') {
      osdpManager.on('card_read', (data) => {
        io.emit('osdp_card_read', data);
      });
    }
  } catch (err) {
    console.error('[OSDP] Failed:', err.message);
    osdpManager = null;
  }

  // NFC is DISABLED by default
  const enableNfc = String(process.env.ENABLE_PN532 || '').trim() === '1';
  if (!enableNfc) {
    console.log('[NFC] Disabled (set ENABLE_PN532=1 to enable)');
    nfcManager = null;
  }

  try {
    automationManager = new AutomationManager(gpioEvents, wiegandManager);
    await automationManager.initialize();
    console.log('[Automation] Initialized');
  } catch (err) {
    console.error('[Automation] Failed:', err.message);
    automationManager = null;
  }
}

initializeSystems().catch(console.error);

// Request logging
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString().substr(11, 8)}] ${req.method} ${req.url}`);
  next();
});

// GPIO state tracking (for direct GPIO, not IOplus)
const procs = new Map();
const states = new Map();

function killProc(pin) {
  const p = procs.get(pin);
  if (p && !p.killed) {
    try { process.kill(p.pid, 'SIGKILL'); } catch (e) {}
  }
  procs.delete(pin);
}

function holdLevel(pin, value) {
  if (wiegandManager && typeof wiegandManager.isPinReserved === 'function' && wiegandManager.isPinReserved(pin)) {
    throw new Error(`GPIO ${pin} is RESERVED for Wiegand`);
  }

  killProc(pin);
  const p = spawn('gpioset', ['-c', CHIP, `${pin}=${value}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  procs.set(pin, p);
  states.set(pin, value);
  gpioEvents.emit('gpio_change', { pin, value, timestamp: Date.now() });
}

async function pulse(pin, msec = 300) {
  holdLevel(pin, 1);
  await new Promise(r => setTimeout(r, msec));
  holdLevel(pin, 0);
}

gpioEvents.on('gpio_action', (data) => {
  try { holdLevel(data.pin, data.value); } catch (e) {}
});

// ============================================
// GPIO API ROUTES (using native I2C)
// ============================================

app.post('/api/gpio/write', async (req, res) => {
  const { pin, value } = req.body;
  if (pin === undefined || value === undefined) {
    return res.status(400).json({ error: 'Missing pin or value' });
  }
  
  try {
    const result = await ioplus.setRelay(pin, value === 1 || value === true);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/gpio/read/:pin', async (req, res) => {
  const pin = parseInt(req.params.pin);
  if (isNaN(pin)) return res.status(400).json({ error: 'Invalid pin' });
  
  try {
    const result = await ioplus.getRelay(pin);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/gpio/input/:pin', async (req, res) => {
  const pin = parseInt(req.params.pin);
  if (isNaN(pin)) return res.status(400).json({ error: 'Invalid pin' });
  
  try {
    const result = await ioplus.readOptoInput(pin);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/gpio/pulse', async (req, res) => {
  const { pin, duration = 500 } = req.body;
  if (pin === undefined) return res.status(400).json({ error: 'Missing pin' });
  
  try {
    const result = await ioplus.pulseRelay(pin, duration);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/gpio/set', async (req, res) => {
  const { pin, value } = req.body;
  if (pin === undefined || value === undefined) {
    return res.status(400).json({ error: 'Missing pin or value' });
  }
  
  try {
    const result = await ioplus.setRelay(pin, value === 1 || value === true);
    io.emit('gpio_state_change', { pin, value });
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/gpio/states', async (req, res) => {
  try {
    const relays = await ioplus.getAllRelays();
    const s = {};
    relays.forEach(r => s[r.pin] = r.state ? 1 : 0);
    res.json({ success: true, states: s });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/gpio/health', async (req, res) => {
  try {
    const health = await ioplus.healthCheck();
    res.json({ success: true, ...health });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/gpio/stats', (req, res) => {
  res.json({ success: true, stats: ioplus.getStats() });
});

// Bulk relay operations (FAST!)
app.post('/api/gpio/relays/all', async (req, res) => {
  const { states } = req.body;
  if (!states) return res.status(400).json({ error: 'Missing states' });
  
  try {
    const result = await ioplus.setAllRelays(states);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/gpio/relays/all', async (req, res) => {
  try {
    const results = await ioplus.getAllRelays();
    res.json({ success: true, relays: results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================
// InputMonitor API Routes
// ============================================

app.get('/api/inputs/status', (req, res) => {
  res.json(inputMonitor.getStates());
});

app.post('/api/inputs/start', (req, res) => {
  inputMonitor.start();
  res.json({ success: true, message: 'Started' });
});

app.post('/api/inputs/stop', (req, res) => {
  inputMonitor.stop();
  res.json({ success: true, message: 'Stopped' });
});

app.post('/api/inputs/config', (req, res) => {
  const config = inputMonitor.setConfig(req.body);
  res.json({ success: true, config });
});

app.post('/api/inputs/thresholds', (req, res) => {
  const thresholds = inputMonitor.setThresholds(req.body);
  res.json({ success: true, thresholds });
});

app.post('/api/inputs/opto-config', (req, res) => {
  try {
    if (req.body.config) {
      res.json({ success: true, optoConfig: inputMonitor.setAllOptoConfig(req.body.config) });
    } else if (req.body.pin !== undefined && req.body.type) {
      res.json({ success: true, optoConfig: inputMonitor.setOptoConfig(req.body.pin, req.body.type) });
    } else {
      res.status(400).json({ error: 'Provide { pin, type } or { config }' });
    }
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/api/inputs/opto-config', (req, res) => {
  res.json({ success: true, optoConfig: inputMonitor.optoConfig });
});

app.get('/api/gpio/inputs/all', async (req, res) => {
  try {
    const states = inputMonitor.getStates();
    
    const opto = [];
    for (let pin = 0; pin < 8; pin++) {
      const data = states.opto[pin] || { rawState: 0, supervisionState: 'UNKNOWN', config: 'NO' };
      opto.push({
        pin, channel: pin,
        rawState: data.rawState || 0,
        state: data.supervisionState === 'ACTIVE' ? 1 : 0,
        supervisionState: data.supervisionState || 'UNKNOWN',
        config: states.optoConfig?.[pin] || 'NO',
        type: 'opto'
      });
    }
    
    const analog = [];
    for (let channel = 0; channel < 8; channel++) {
      const data = states.analog[channel] || { voltage: 0, state: 'UNKNOWN' };
      analog.push({
        pin: channel, channel,
        voltage: data.voltage || 0,
        volts: (data.voltage || 0) / 1000,
        supervisionState: data.state || 'UNKNOWN',
        state: data.state === 'ALARM' ? 1 : 0,
        type: 'analog'
      });
    }
    
    res.json({ success: true, opto, analog, optoConfig: states.optoConfig });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ---- Health ----
app.get(['/api/health', '/health'], async (req, res) => {
  let i2cHealth = { healthy: false };
  try {
    i2cHealth = await ioplus.healthCheck();
  } catch (e) {}
  
  res.json({
    success: true,
    driver: 'native-i2c',
    chip: CHIP,
    i2cBus: I2C_BUS,
    i2cAddress: `0x${I2C_ADDRESS.toString(16)}`,
    i2cHealthy: i2cHealth.healthy,
    i2cStats: ioplus.getStats(),
    automationEnabled: !!automationManager,
    wiegandEnabled: !!wiegandManager,
    osdpEnabled: !!osdpManager,
    nfcEnabled: !!(nfcManager && nfcManager.enabled),
    inputMonitorRunning: inputMonitor.enabled,
    nativeTransmitter: fs.existsSync(RESOLVED_WIEGAND_TX_PATH),
    timestamp: new Date().toISOString()
  });
});

// ============================================
// Sequences API (abbreviated)
// ============================================

app.get('/api/emulations', async (_req, res) => {
  try {
    const files = (await fsp.readdir(SEQUENCES_DIR)).filter(f => f.endsWith('.json'));
    const items = [];
    for (const f of files) {
      try {
        const j = await loadJson(path.join(SEQUENCES_DIR, f));
        items.push({ id: j.id, name: j.name, stepsCount: j.steps?.length || 0 });
      } catch (_) {}
    }
    res.json({ success: true, items });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================
// Automation API (abbreviated)
// ============================================

app.get('/api/automation/rules', (req, res) => {
  if (!automationManager) return res.status(503).json({ error: 'Not initialized' });
  res.json({ success: true, rules: automationManager.getRules() });
});

app.get('/api/automation/stats', (req, res) => {
  if (!automationManager) return res.status(503).json({ error: 'Not initialized' });
  res.json({ success: true, stats: automationManager.getStats() });
});

// ============================================
// Wiegand API (abbreviated)
// ============================================

const WIEGAND_CONFIG = {
  ok: true, chip: CHIP,
  doors: [
    { door: 1, name: 'Door 1', d0: 23, d1: 24, readerId: 'reader1' },
    { door: 2, name: 'Door 2', d0: 22, d1: 23, readerId: 'reader2' }
  ]
};

app.get('/api/wiegand/config', (_req, res) => res.json(WIEGAND_CONFIG));

app.get('/api/wiegand/status', (req, res) => {
  if (!wiegandManager) return res.status(503).json({ error: 'Not initialized' });
  res.json({ success: true, status: wiegandManager.getStatus() });
});

app.post('/api/wiegand/send', async (req, res) => {
  if (!wiegandManager) return res.status(503).json({ error: 'Not initialized' });
  try {
    const { readerId, facility, card, format } = req.body;
    const result = await wiegandManager.sendCard(readerId, facility, card, format);
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ============================================
// OSDP API (abbreviated)
// ============================================

app.get('/api/osdp/status', (req, res) => {
  if (!osdpManager) return res.status(503).json({ error: 'Not initialized' });
  res.json({ success: true, status: osdpManager.getStatus() });
});

app.get('/api/osdp/readers', (req, res) => {
  if (!osdpManager) return res.status(503).json({ error: 'Not initialized' });
  res.json({ success: true, readers: osdpManager.getReaders() });
});

app.post('/api/osdp/card-read', async (req, res) => {
  if (!osdpManager) return res.status(503).json({ error: 'Not initialized' });
  try {
    const { readerId, facility, card, format, bitCount } = req.body;
    const result = await osdpManager.sendCardRead(readerId, { facility, card, bitCount }, format || 'wiegand26');
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ============================================
// NFC API (abbreviated)
// ============================================

app.get('/api/nfc/status', (req, res) => {
  if (!nfcManager) return res.json({ success: true, enabled: false });
  res.json({ success: true, enabled: nfcManager.enabled, status: nfcManager.getStatus() });
});

// ---- Socket.IO ----
io.on('connection', (socket) => {
  console.log('[Socket] Connected:', socket.id);
  
  socket.on('set_gpio', async ({ pin, value, pulseMs }) => {
    try {
      if (pulseMs > 0) {
        await ioplus.pulseRelay(pin, pulseMs);
      } else {
        await ioplus.setRelay(pin, value ? true : false);
      }
      io.emit('gpio_state_change', { pin, value: value ? 1 : 0 });
    } catch (e) {
      console.error('[Socket] GPIO error:', e.message);
    }
  });
  
  socket.on('disconnect', () => console.log('[Socket] Disconnected:', socket.id));
});

// ---- Cleanup ----
process.on('SIGINT', async () => {
  console.log('\n[Cleanup] Shutting down...');
  inputMonitor.stop();
  await ioplus.close();
  procs.forEach((p) => { try { process.kill(p.pid, 'SIGKILL'); } catch (e) {} });
  process.exit(0);
});

process.on('SIGTERM', async () => {
  inputMonitor.stop();
  await ioplus.close();
  process.exit(0);
});

// ---- Start Server ----
const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('╔════════════════════════════════════════╗');
  console.log('║   GPIO Server - NATIVE I2C VERSION     ║');
  console.log('╠════════════════════════════════════════╣');
  console.log(`║  Port: ${PORT}                            ║`);
  console.log(`║  I2C Bus: ${I2C_BUS}                           ║`);
  console.log(`║  I2C Addr: 0x${I2C_ADDRESS.toString(16).padStart(2, '0')}                        ║`);
  console.log('║  Min Delay: 5ms (was ~200ms)           ║');
  console.log('╚════════════════════════════════════════╝');
  console.log('');
  
  // Start InputMonitor after delay
  setTimeout(() => {
    inputMonitor.start();
    console.log('[Server] InputMonitor started');
  }, 2000);
});

module.exports = { app, server, ioplus, inputMonitor };
