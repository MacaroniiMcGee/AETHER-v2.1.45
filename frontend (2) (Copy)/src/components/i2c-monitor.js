#!/usr/bin/env node
/**
 * I2C Bus Monitor for IOplus Board
 * 
 * Monitors I2C health, logs all operations, detects failures,
 * and provides real-time diagnostics via console and optional web interface.
 * 
 * Usage:
 *   node i2c-monitor.js                    # Console mode
 *   node i2c-monitor.js --web              # With web dashboard on port 3002
 *   node i2c-monitor.js --log              # Log to file
 *   node i2c-monitor.js --web --log        # Both
 * 
 * Run with: sudo node i2c-monitor.js
 */

const { exec, spawn } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const execAsync = promisify(exec);

// Configuration
const CONFIG = {
  i2cBus: 1,
  ioplusAddress: 0x28,
  pollInterval: 2000,        // Health check every 2 seconds
  commandTimeout: 3000,      // 3 second timeout for commands
  maxConsecutiveFailures: 3, // Alert after 3 failures
  logFile: './i2c-monitor.log',
  webPort: 3002,
  historySize: 1000,         // Keep last 1000 events
};

// State
const state = {
  healthy: true,
  lastSuccessTime: Date.now(),
  lastFailureTime: null,
  consecutiveFailures: 0,
  totalCommands: 0,
  totalFailures: 0,
  totalSuccesses: 0,
  currentVoltage: null,
  boardDetected: false,
  history: [],
  commandLog: [],
  startTime: Date.now(),
};

// Colors for console
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

// Logging
let logStream = null;

function log(level, message, data = null) {
  const timestamp = new Date().toISOString();
  const entry = {
    timestamp,
    level,
    message,
    data,
  };
  
  // Add to history
  state.history.push(entry);
  if (state.history.length > CONFIG.historySize) {
    state.history.shift();
  }
  
  // Console output with colors
  let color = colors.reset;
  let symbol = ' ';
  switch (level) {
    case 'error': color = colors.red; symbol = '✗'; break;
    case 'warn': color = colors.yellow; symbol = '!'; break;
    case 'success': color = colors.green; symbol = '✓'; break;
    case 'info': color = colors.cyan; symbol = 'ℹ'; break;
    case 'debug': color = colors.gray; symbol = '·'; break;
    case 'command': color = colors.blue; symbol = '>'; break;
  }
  
  const logLine = `${colors.gray}[${timestamp.split('T')[1].split('.')[0]}]${colors.reset} ${color}${symbol}${colors.reset} ${message}`;
  console.log(logLine);
  if (data) {
    console.log(`  ${colors.gray}${JSON.stringify(data)}${colors.reset}`);
  }
  
  // File logging
  if (logStream) {
    logStream.write(`[${timestamp}] [${level.toUpperCase()}] ${message}${data ? ' ' + JSON.stringify(data) : ''}\n`);
  }
}

// I2C Operations
async function i2cDetect() {
  try {
    const { stdout } = await execAsync(`timeout 5 i2cdetect -y ${CONFIG.i2cBus}`, { timeout: 6000 });
    const detected = stdout.includes('28');
    return { detected, raw: stdout };
  } catch (error) {
    return { detected: false, error: error.message };
  }
}

async function ioplusCommand(cmd, timeout = CONFIG.commandTimeout) {
  const startTime = Date.now();
  const fullCmd = `timeout ${Math.ceil(timeout/1000)} ioplus 0 ${cmd}`;
  
  state.totalCommands++;
  
  const entry = {
    timestamp: new Date().toISOString(),
    command: cmd,
    startTime,
  };
  
  try {
    log('command', `Executing: ioplus 0 ${cmd}`);
    const { stdout, stderr } = await execAsync(fullCmd, { timeout: timeout + 1000 });
    
    const duration = Date.now() - startTime;
    entry.duration = duration;
    entry.success = true;
    entry.result = stdout.trim();
    
    state.totalSuccesses++;
    state.consecutiveFailures = 0;
    state.lastSuccessTime = Date.now();
    state.healthy = true;
    
    log('success', `Command completed in ${duration}ms`, { result: stdout.trim() });
    
    state.commandLog.push(entry);
    if (state.commandLog.length > 100) state.commandLog.shift();
    
    return { success: true, result: stdout.trim(), duration };
  } catch (error) {
    const duration = Date.now() - startTime;
    entry.duration = duration;
    entry.success = false;
    entry.error = error.message;
    
    state.totalFailures++;
    state.consecutiveFailures++;
    state.lastFailureTime = Date.now();
    
    if (state.consecutiveFailures >= CONFIG.maxConsecutiveFailures) {
      state.healthy = false;
    }
    
    log('error', `Command FAILED after ${duration}ms`, { error: error.message, consecutive: state.consecutiveFailures });
    
    state.commandLog.push(entry);
    if (state.commandLog.length > 100) state.commandLog.shift();
    
    return { success: false, error: error.message, duration };
  }
}

// Health Check
async function healthCheck() {
  log('info', '--- Health Check ---');
  
  // 1. Check I2C bus detection
  const detection = await i2cDetect();
  state.boardDetected = detection.detected;
  
  if (!detection.detected) {
    log('error', 'IOplus board NOT DETECTED on I2C bus!');
    state.healthy = false;
    return { healthy: false, reason: 'Board not detected' };
  }
  log('success', 'IOplus board detected at 0x28');
  
  // 2. Try reading relay state
  const relayRead = await ioplusCommand('relrd 1');
  if (!relayRead.success) {
    log('error', 'Failed to read relay state');
    return { healthy: false, reason: 'Relay read failed' };
  }
  
  // 3. Try reading opto input
  const optoRead = await ioplusCommand('optrd 1');
  if (!optoRead.success) {
    log('error', 'Failed to read opto input');
    return { healthy: false, reason: 'Opto read failed' };
  }
  
  // 4. Try reading ADC (this might be what's causing issues)
  const adcRead = await ioplusCommand('adcrd 1');
  if (!adcRead.success) {
    log('warn', 'ADC read failed - analog inputs may not be available');
  } else {
    state.currentVoltage = parseFloat(adcRead.result);
    log('info', `ADC Channel 1: ${adcRead.result}mV`);
  }
  
  log('success', '--- Health Check PASSED ---');
  return { healthy: true };
}

// Stress Test
async function stressTest(iterations = 10, delayMs = 100) {
  log('warn', `Starting stress test: ${iterations} iterations, ${delayMs}ms delay`);
  
  const results = {
    total: iterations,
    successes: 0,
    failures: 0,
    avgDuration: 0,
    maxDuration: 0,
    minDuration: Infinity,
    durations: [],
  };
  
  for (let i = 0; i < iterations; i++) {
    const result = await ioplusCommand('relrd 1');
    
    if (result.success) {
      results.successes++;
      results.durations.push(result.duration);
      results.maxDuration = Math.max(results.maxDuration, result.duration);
      results.minDuration = Math.min(results.minDuration, result.duration);
    } else {
      results.failures++;
      log('error', `Stress test failure at iteration ${i + 1}`);
      
      if (results.failures >= 3) {
        log('error', 'Stress test ABORTED - too many failures');
        break;
      }
    }
    
    if (delayMs > 0) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  
  if (results.durations.length > 0) {
    results.avgDuration = Math.round(results.durations.reduce((a, b) => a + b, 0) / results.durations.length);
  }
  
  log('info', 'Stress test complete', results);
  return results;
}

// Burst Test (simulates what the frontend does)
async function burstTest(commands = 8, delayMs = 0) {
  log('warn', `Starting burst test: ${commands} commands, ${delayMs}ms delay`);
  
  const startTime = Date.now();
  const promises = [];
  
  for (let i = 0; i < commands; i++) {
    const cmd = i < 4 ? `relrd ${(i % 4) + 1}` : `optrd ${((i - 4) % 4) + 1}`;
    
    if (delayMs > 0 && i > 0) {
      await new Promise(r => setTimeout(r, delayMs));
    }
    
    promises.push(ioplusCommand(cmd));
  }
  
  const results = await Promise.all(promises);
  const totalDuration = Date.now() - startTime;
  
  const successes = results.filter(r => r.success).length;
  const failures = results.filter(r => !r.success).length;
  
  log('info', `Burst test complete: ${successes}/${commands} succeeded in ${totalDuration}ms`, {
    failures,
    avgPerCommand: Math.round(totalDuration / commands),
  });
  
  return { successes, failures, totalDuration, results };
}

// Monitor Loop
async function startMonitoring() {
  log('info', '=== I2C Monitor Started ===');
  log('info', `Polling interval: ${CONFIG.pollInterval}ms`);
  log('info', `IOplus address: 0x${CONFIG.ioplusAddress.toString(16)}`);
  
  // Initial health check
  await healthCheck();
  
  // Continuous monitoring
  setInterval(async () => {
    const detection = await i2cDetect();
    
    if (!detection.detected && state.boardDetected) {
      log('error', '!!! BOARD WENT OFFLINE !!!');
      state.healthy = false;
      state.boardDetected = false;
      
      // Try to diagnose
      log('info', 'Attempting to diagnose...');
      
      // Check if I2C module is loaded
      try {
        const { stdout } = await execAsync('lsmod | grep i2c_bcm');
        if (!stdout.includes('i2c_bcm2835')) {
          log('error', 'I2C kernel module not loaded!');
        }
      } catch (e) {}
      
    } else if (detection.detected && !state.boardDetected) {
      log('success', '!!! BOARD CAME BACK ONLINE !!!');
      state.boardDetected = true;
      state.healthy = true;
      state.consecutiveFailures = 0;
    }
    
    // Quick relay read to confirm communication
    if (state.boardDetected) {
      const result = await ioplusCommand('relrd 1');
      if (!result.success) {
        log('warn', 'Communication issue detected');
      }
    }
    
  }, CONFIG.pollInterval);
}

// Web Dashboard
function startWebServer() {
  const http = require('http');
  
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    
    if (req.url === '/status') {
      res.end(JSON.stringify({
        ...state,
        uptime: Date.now() - state.startTime,
        config: CONFIG,
      }));
    } else if (req.url === '/health') {
      healthCheck().then(result => {
        res.end(JSON.stringify(result));
      });
    } else if (req.url === '/history') {
      res.end(JSON.stringify(state.history.slice(-100)));
    } else if (req.url === '/commands') {
      res.end(JSON.stringify(state.commandLog));
    } else if (req.url === '/stress') {
      stressTest(20, 50).then(result => {
        res.end(JSON.stringify(result));
      });
    } else if (req.url === '/burst') {
      burstTest(8, 0).then(result => {
        res.end(JSON.stringify(result));
      });
    } else if (req.url === '/reset') {
      exec('sudo rmmod i2c_bcm2835 && sudo modprobe i2c_bcm2835', (err, stdout, stderr) => {
        res.end(JSON.stringify({ success: !err, stdout, stderr, error: err?.message }));
      });
    } else if (req.url === '/' || req.url === '/dashboard') {
      res.setHeader('Content-Type', 'text/html');
      res.end(getDashboardHTML());
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  });
  
  server.listen(CONFIG.webPort, () => {
    log('info', `Web dashboard available at http://localhost:${CONFIG.webPort}`);
  });
}

function getDashboardHTML() {
  return `<!DOCTYPE html>
<html>
<head>
  <title>I2C Monitor</title>
  <style>
    body { font-family: monospace; background: #1a1a2e; color: #eee; padding: 20px; }
    .status { padding: 20px; border-radius: 8px; margin: 10px 0; }
    .healthy { background: #0f5132; border: 1px solid #198754; }
    .unhealthy { background: #842029; border: 1px solid #dc3545; }
    .stat { display: inline-block; margin: 10px 20px; }
    .stat-value { font-size: 24px; font-weight: bold; }
    .stat-label { font-size: 12px; color: #aaa; }
    button { background: #0d6efd; color: white; border: none; padding: 10px 20px; margin: 5px; cursor: pointer; border-radius: 4px; }
    button:hover { background: #0b5ed7; }
    .log { background: #000; padding: 10px; height: 300px; overflow-y: auto; font-size: 12px; border-radius: 4px; }
    .log-entry { margin: 2px 0; }
    .error { color: #ff6b6b; }
    .success { color: #51cf66; }
    .warn { color: #ffd43b; }
    .info { color: #74c0fc; }
  </style>
</head>
<body>
  <h1>I2C Bus Monitor - IOplus</h1>
  
  <div id="status" class="status healthy">
    <h2>Status: <span id="health">Checking...</span></h2>
    <div class="stat"><div class="stat-value" id="total">0</div><div class="stat-label">Total Commands</div></div>
    <div class="stat"><div class="stat-value" id="success">0</div><div class="stat-label">Successes</div></div>
    <div class="stat"><div class="stat-value" id="failures">0</div><div class="stat-label">Failures</div></div>
    <div class="stat"><div class="stat-value" id="consecutive">0</div><div class="stat-label">Consecutive Failures</div></div>
    <div class="stat"><div class="stat-value" id="uptime">0s</div><div class="stat-label">Uptime</div></div>
  </div>
  
  <div>
    <button onclick="refresh()">Refresh</button>
    <button onclick="healthCheck()">Health Check</button>
    <button onclick="stressTest()">Stress Test</button>
    <button onclick="burstTest()">Burst Test</button>
    <button onclick="resetI2C()" style="background:#dc3545">Reset I2C</button>
  </div>
  
  <h3>Event Log</h3>
  <div id="log" class="log"></div>
  
  <script>
    function refresh() {
      fetch('/status').then(r => r.json()).then(data => {
        document.getElementById('health').textContent = data.healthy ? 'HEALTHY' : 'UNHEALTHY';
        document.getElementById('status').className = 'status ' + (data.healthy ? 'healthy' : 'unhealthy');
        document.getElementById('total').textContent = data.totalCommands;
        document.getElementById('success').textContent = data.totalSuccesses;
        document.getElementById('failures').textContent = data.totalFailures;
        document.getElementById('consecutive').textContent = data.consecutiveFailures;
        document.getElementById('uptime').textContent = Math.round(data.uptime/1000) + 's';
        
        const log = document.getElementById('log');
        log.innerHTML = data.history.slice(-50).reverse().map(e => 
          '<div class="log-entry ' + e.level + '">[' + e.timestamp.split('T')[1].split('.')[0] + '] ' + e.message + '</div>'
        ).join('');
      });
    }
    
    function healthCheck() {
      fetch('/health').then(r => r.json()).then(data => {
        alert(data.healthy ? 'Health check PASSED' : 'Health check FAILED: ' + data.reason);
        refresh();
      });
    }
    
    function stressTest() {
      alert('Running stress test...');
      fetch('/stress').then(r => r.json()).then(data => {
        alert('Stress test: ' + data.successes + '/' + data.total + ' passed, avg ' + data.avgDuration + 'ms');
        refresh();
      });
    }
    
    function burstTest() {
      alert('Running burst test...');
      fetch('/burst').then(r => r.json()).then(data => {
        alert('Burst test: ' + data.successes + '/8 passed in ' + data.totalDuration + 'ms');
        refresh();
      });
    }
    
    function resetI2C() {
      if (confirm('Reset I2C bus?')) {
        fetch('/reset').then(r => r.json()).then(data => {
          alert(data.success ? 'I2C reset sent' : 'Reset failed: ' + data.error);
          refresh();
        });
      }
    }
    
    refresh();
    setInterval(refresh, 2000);
  </script>
</body>
</html>`;
}

// Main
async function main() {
  const args = process.argv.slice(2);
  
  console.log('\n' + colors.cyan + '╔════════════════════════════════════════════╗' + colors.reset);
  console.log(colors.cyan + '║     I2C Bus Monitor for IOplus Board       ║' + colors.reset);
  console.log(colors.cyan + '╚════════════════════════════════════════════╝' + colors.reset + '\n');
  
  // Initialize logging
  if (args.includes('--log')) {
    logStream = fs.createWriteStream(CONFIG.logFile, { flags: 'a' });
    log('info', `Logging to ${CONFIG.logFile}`);
  }
  
  // Start web server if requested
  if (args.includes('--web')) {
    startWebServer();
  }
  
  // Interactive commands
  if (args.includes('--stress')) {
    await stressTest(50, 50);
    process.exit(0);
  }
  
  if (args.includes('--burst')) {
    await burstTest(8, 0);
    process.exit(0);
  }
  
  if (args.includes('--health')) {
    await healthCheck();
    process.exit(0);
  }
  
  // Start monitoring
  await startMonitoring();
  
  // Handle shutdown
  process.on('SIGINT', () => {
    log('info', 'Shutting down monitor...');
    if (logStream) logStream.end();
    process.exit(0);
  });
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
