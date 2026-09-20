/**
 * 4-Hour I2C Stress Test with Logging
 * Runs continuous I2C operations and logs all failures
 * 
 * Usage: sudo node stress-test-4hr.js
 * Logs: ./logs/i2c-stress-TIMESTAMP.log
 */

const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');

const execAsync = promisify(exec);

// Configuration
const DURATION_HOURS = 4;
const DURATION_MS = DURATION_HOURS * 60 * 60 * 1000;
const DELAY_BETWEEN_OPS_MS = 150;  // Match your queue setting
const LOG_INTERVAL_MS = 60000;     // Log stats every minute
const CONCURRENT_WORKERS = 1;

// Setup logging
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const logFile = path.join(logsDir, `i2c-stress-${timestamp}.log`);
const csvFile = path.join(logsDir, `i2c-stress-${timestamp}.csv`);

// Stats
const stats = {
  startTime: Date.now(),
  operations: { success: 0, fail: 0 },
  byType: {
    relayWrite: { success: 0, fail: 0, totalMs: 0 },
    relayRead: { success: 0, fail: 0, totalMs: 0 },
    optoRead: { success: 0, fail: 0, totalMs: 0 },
    adcRead: { success: 0, fail: 0, totalMs: 0 }
  },
  errors: [],
  consecutiveFailures: 0,
  maxConsecutiveFailures: 0,
  lastSuccess: Date.now(),
  longestFailureGap: 0,
  hourlyStats: []
};

// Logging functions
function log(message, level = 'INFO') {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level}] ${message}`;
  console.log(line);
  fs.appendFileSync(logFile, line + '\n');
}

function logError(type, details, error) {
  const ts = new Date().toISOString();
  const errObj = {
    time: ts,
    type,
    details,
    error: error.substring(0, 200),
    consecutiveFailures: stats.consecutiveFailures
  };
  stats.errors.push(errObj);
  
  const line = `[${ts}] [ERROR] ${type} - ${JSON.stringify(details)} - ${error}`;
  fs.appendFileSync(logFile, line + '\n');
  
  // CSV format for easy analysis
  fs.appendFileSync(csvFile, `${ts},${type},${stats.consecutiveFailures},"${error.replace(/"/g, '""').substring(0, 100)}"\n`);
}

// Execute ioplus command
async function ioplusCmd(cmd) {
  const start = Date.now();
  try {
    const { stdout, stderr } = await execAsync(`timeout 3 ioplus 0 ${cmd}`, { timeout: 5000 });
    const elapsed = Date.now() - start;
    
    if (stderr && stderr.trim()) {
      throw new Error(stderr.trim());
    }
    
    return { success: true, result: stdout.trim(), elapsed };
  } catch (error) {
    const elapsed = Date.now() - start;
    return { success: false, error: error.message || String(error), elapsed };
  }
}

// Test operations
async function testRelayWrite(relay, state) {
  const result = await ioplusCmd(`relwr ${relay} ${state}`);
  const type = 'relayWrite';
  
  if (result.success) {
    stats.byType[type].success++;
    stats.byType[type].totalMs += result.elapsed;
    stats.operations.success++;
    stats.consecutiveFailures = 0;
    stats.lastSuccess = Date.now();
  } else {
    stats.byType[type].fail++;
    stats.operations.fail++;
    stats.consecutiveFailures++;
    if (stats.consecutiveFailures > stats.maxConsecutiveFailures) {
      stats.maxConsecutiveFailures = stats.consecutiveFailures;
    }
    logError(type, { relay, state }, result.error);
  }
  return result;
}

async function testRelayRead(relay) {
  const result = await ioplusCmd(`relrd ${relay}`);
  const type = 'relayRead';
  
  if (result.success) {
    stats.byType[type].success++;
    stats.byType[type].totalMs += result.elapsed;
    stats.operations.success++;
    stats.consecutiveFailures = 0;
    stats.lastSuccess = Date.now();
  } else {
    stats.byType[type].fail++;
    stats.operations.fail++;
    stats.consecutiveFailures++;
    if (stats.consecutiveFailures > stats.maxConsecutiveFailures) {
      stats.maxConsecutiveFailures = stats.consecutiveFailures;
    }
    logError(type, { relay }, result.error);
  }
  return result;
}

async function testOptoRead(input) {
  const result = await ioplusCmd(`optrd ${input}`);
  const type = 'optoRead';
  
  if (result.success) {
    stats.byType[type].success++;
    stats.byType[type].totalMs += result.elapsed;
    stats.operations.success++;
    stats.consecutiveFailures = 0;
    stats.lastSuccess = Date.now();
  } else {
    stats.byType[type].fail++;
    stats.operations.fail++;
    stats.consecutiveFailures++;
    if (stats.consecutiveFailures > stats.maxConsecutiveFailures) {
      stats.maxConsecutiveFailures = stats.consecutiveFailures;
    }
    logError(type, { input }, result.error);
  }
  return result;
}

async function testAdcRead(channel) {
  const result = await ioplusCmd(`adcrd ${channel}`);
  const type = 'adcRead';
  
  if (result.success) {
    stats.byType[type].success++;
    stats.byType[type].totalMs += result.elapsed;
    stats.operations.success++;
    stats.consecutiveFailures = 0;
    stats.lastSuccess = Date.now();
  } else {
    stats.byType[type].fail++;
    stats.operations.fail++;
    stats.consecutiveFailures++;
    if (stats.consecutiveFailures > stats.maxConsecutiveFailures) {
      stats.maxConsecutiveFailures = stats.consecutiveFailures;
    }
    logError(type, { channel }, result.error);
  }
  return result;
}

// Random test
async function runRandomTest() {
  const testType = Math.floor(Math.random() * 4);
  const channel = Math.floor(Math.random() * 8) + 1;
  
  switch (testType) {
    case 0: return testRelayWrite(channel, Math.random() > 0.5 ? 1 : 0);
    case 1: return testRelayRead(channel);
    case 2: return testOptoRead(channel);
    case 3: return testAdcRead(channel);
  }
}

// Print and log periodic stats
function logPeriodicStats() {
  const elapsed = (Date.now() - stats.startTime) / 1000;
  const hours = Math.floor(elapsed / 3600);
  const mins = Math.floor((elapsed % 3600) / 60);
  const secs = Math.floor(elapsed % 60);
  
  const total = stats.operations.success + stats.operations.fail;
  const failRate = total > 0 ? ((stats.operations.fail / total) * 100).toFixed(3) : 0;
  const opsPerSec = (total / elapsed).toFixed(1);
  const gap = Date.now() - stats.lastSuccess;
  
  if (gap > stats.longestFailureGap) {
    stats.longestFailureGap = gap;
  }
  
  const hourlyEntry = {
    time: new Date().toISOString(),
    elapsed: `${hours}h ${mins}m ${secs}s`,
    total,
    success: stats.operations.success,
    fail: stats.operations.fail,
    failRate: `${failRate}%`,
    opsPerSec,
    consecutiveFailures: stats.consecutiveFailures,
    maxConsecutiveFailures: stats.maxConsecutiveFailures
  };
  
  stats.hourlyStats.push(hourlyEntry);
  
  const statusLine = `[${hours}h ${mins}m ${secs}s] Ops: ${total} | Success: ${stats.operations.success} | Fail: ${stats.operations.fail} (${failRate}%) | Rate: ${opsPerSec}/s | ConsecFail: ${stats.consecutiveFailures} (max: ${stats.maxConsecutiveFailures})`;
  
  log(statusLine, 'STATS');
  
  // Also write to console without log formatting for visibility
  console.log('\n' + '='.repeat(80));
  console.log('PERIODIC STATUS UPDATE');
  console.log('='.repeat(80));
  console.log(`Time Elapsed: ${hours}h ${mins}m ${secs}s`);
  console.log(`Total Operations: ${total}`);
  console.log(`Success: ${stats.operations.success} | Fail: ${stats.operations.fail}`);
  console.log(`Failure Rate: ${failRate}%`);
  console.log(`Ops/sec: ${opsPerSec}`);
  console.log(`Current Consecutive Failures: ${stats.consecutiveFailures}`);
  console.log(`Max Consecutive Failures: ${stats.maxConsecutiveFailures}`);
  console.log(`Longest Gap Without Success: ${stats.longestFailureGap}ms`);
  console.log(`Errors logged: ${stats.errors.length}`);
  console.log('='.repeat(80) + '\n');
}

// Final report
function generateFinalReport() {
  const elapsed = (Date.now() - stats.startTime) / 1000;
  const hours = Math.floor(elapsed / 3600);
  const mins = Math.floor((elapsed % 3600) / 60);
  
  const report = `
================================================================================
I2C STRESS TEST - FINAL REPORT
================================================================================
Test Duration: ${hours}h ${mins}m
Start Time: ${new Date(stats.startTime).toISOString()}
End Time: ${new Date().toISOString()}
Log File: ${logFile}
CSV File: ${csvFile}

SUMMARY
-------
Total Operations: ${stats.operations.success + stats.operations.fail}
Successful: ${stats.operations.success}
Failed: ${stats.operations.fail}
Failure Rate: ${((stats.operations.fail / (stats.operations.success + stats.operations.fail)) * 100).toFixed(4)}%
Operations/sec: ${((stats.operations.success + stats.operations.fail) / elapsed).toFixed(2)}

BREAKDOWN BY OPERATION TYPE
---------------------------
Relay Write: ${stats.byType.relayWrite.success} success, ${stats.byType.relayWrite.fail} fail (avg ${stats.byType.relayWrite.success > 0 ? (stats.byType.relayWrite.totalMs / stats.byType.relayWrite.success).toFixed(1) : 'N/A'}ms)
Relay Read:  ${stats.byType.relayRead.success} success, ${stats.byType.relayRead.fail} fail (avg ${stats.byType.relayRead.success > 0 ? (stats.byType.relayRead.totalMs / stats.byType.relayRead.success).toFixed(1) : 'N/A'}ms)
Opto Read:   ${stats.byType.optoRead.success} success, ${stats.byType.optoRead.fail} fail (avg ${stats.byType.optoRead.success > 0 ? (stats.byType.optoRead.totalMs / stats.byType.optoRead.success).toFixed(1) : 'N/A'}ms)
ADC Read:    ${stats.byType.adcRead.success} success, ${stats.byType.adcRead.fail} fail (avg ${stats.byType.adcRead.success > 0 ? (stats.byType.adcRead.totalMs / stats.byType.adcRead.success).toFixed(1) : 'N/A'}ms)

FAILURE ANALYSIS
----------------
Total Errors: ${stats.errors.length}
Max Consecutive Failures: ${stats.maxConsecutiveFailures}
Longest Gap Without Success: ${stats.longestFailureGap}ms

${stats.errors.length > 0 ? `FIRST 10 ERRORS:
${stats.errors.slice(0, 10).map((e, i) => `${i + 1}. [${e.time}] ${e.type} - ${e.error.substring(0, 80)}`).join('\n')}

LAST 10 ERRORS:
${stats.errors.slice(-10).map((e, i) => `${i + 1}. [${e.time}] ${e.type} - ${e.error.substring(0, 80)}`).join('\n')}` : 'NO ERRORS RECORDED'}

VERDICT
-------
${stats.operations.fail === 0 ? '✓ PASSED - No I2C failures in 4 hours!' : 
  stats.operations.fail / (stats.operations.success + stats.operations.fail) < 0.001 ? '⚠ MARGINAL - <0.1% failure rate' :
  stats.operations.fail / (stats.operations.success + stats.operations.fail) < 0.01 ? '⚠ WARNING - <1% failure rate' :
  '✗ FAILED - >1% failure rate - I2C bus needs attention'}

================================================================================
`;
  
  console.log(report);
  fs.appendFileSync(logFile, report);
  
  // Also save JSON stats
  const jsonFile = path.join(logsDir, `i2c-stress-${timestamp}.json`);
  fs.writeFileSync(jsonFile, JSON.stringify({
    config: { durationHours: DURATION_HOURS, delayMs: DELAY_BETWEEN_OPS_MS },
    stats,
    report: report.split('\n')
  }, null, 2));
  
  console.log(`\nFull logs saved to:`);
  console.log(`  Log: ${logFile}`);
  console.log(`  CSV: ${csvFile}`);
  console.log(`  JSON: ${jsonFile}`);
}

// Main
async function main() {
  console.log('================================================================================');
  console.log('I2C 4-HOUR STRESS TEST');
  console.log('================================================================================');
  console.log(`Start Time: ${new Date().toISOString()}`);
  console.log(`Duration: ${DURATION_HOURS} hours`);
  console.log(`Delay between ops: ${DELAY_BETWEEN_OPS_MS}ms`);
  console.log(`Log file: ${logFile}`);
  console.log(`CSV file: ${csvFile}`);
  console.log('================================================================================\n');
  
  log(`Starting ${DURATION_HOURS}-hour stress test`);
  log(`Configuration: delay=${DELAY_BETWEEN_OPS_MS}ms, workers=${CONCURRENT_WORKERS}`);
  
  // Initialize CSV
  fs.writeFileSync(csvFile, 'timestamp,operation,consecutive_failures,error\n');
  
  const endTime = Date.now() + DURATION_MS;
  let running = true;
  
  // Periodic stats logger
  const statsInterval = setInterval(logPeriodicStats, LOG_INTERVAL_MS);
  
  // Progress indicator
  const progressInterval = setInterval(() => {
    const remaining = Math.max(0, endTime - Date.now());
    const remainingHrs = Math.floor(remaining / 3600000);
    const remainingMins = Math.floor((remaining % 3600000) / 60000);
    const total = stats.operations.success + stats.operations.fail;
    const failRate = total > 0 ? ((stats.operations.fail / total) * 100).toFixed(2) : '0.00';
    process.stdout.write(`\rRunning... ${remainingHrs}h ${remainingMins}m remaining | Ops: ${total} | Fail: ${stats.operations.fail} (${failRate}%)    `);
  }, 1000);
  
  // Worker
  async function worker() {
    while (running && Date.now() < endTime) {
      await runRandomTest();
      await new Promise(r => setTimeout(r, DELAY_BETWEEN_OPS_MS));
    }
  }
  
  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\n\nReceived SIGINT - generating report...');
    running = false;
  });
  
  process.on('SIGTERM', () => {
    console.log('\n\nReceived SIGTERM - generating report...');
    running = false;
  });
  
  // Start workers
  const workers = [];
  for (let i = 0; i < CONCURRENT_WORKERS; i++) {
    workers.push(worker());
  }
  
  await Promise.all(workers);
  
  // Cleanup
  clearInterval(statsInterval);
  clearInterval(progressInterval);
  
  log('Stress test completed');
  
  // Turn off all relays
  console.log('\n\nCleaning up - turning off all relays...');
  for (let i = 1; i <= 8; i++) {
    await ioplusCmd(`relwr ${i} 0`);
    await new Promise(r => setTimeout(r, 100));
  }
  
  // Generate report
  generateFinalReport();
}

// Run
main().catch(err => {
  console.error('Stress test crashed:', err);
  log(`CRASH: ${err.message}`, 'FATAL');
  process.exit(1);
});
