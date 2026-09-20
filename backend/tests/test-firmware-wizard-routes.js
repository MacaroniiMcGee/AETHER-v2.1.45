// Tests for the new wizard-support endpoints:
//   POST /api/osdp/firmware-scan
//   POST /api/osdp/firmware-identify
//   GET/POST/DELETE /api/osdp/firmware-library
//   GET  /api/osdp/firmware-history

const path = require('path');
const fs = require('fs');
const http = require('http');
const assert = require('assert');
const express = require('express');
const EventEmitter = require('events');

const check = (cond, msg) => assert.ok(cond, msg);

// --- Mock SerialPort BEFORE the route requires it ----------------------------
const serialportPath = require.resolve('serialport');
class FakeSerialPort extends EventEmitter {
  constructor(opts) {
    super();
    this.path = opts.path;
    this.baudRate = opts.baudRate;
    this.isOpen = false;
  }
  open(cb) { this.isOpen = true; setImmediate(() => cb && cb(null)); }
  close(cb) { this.isOpen = false; setImmediate(() => cb && cb()); }
  set(_o, cb) { setImmediate(() => cb && cb()); }
  write(_b, cb) { setImmediate(() => cb && cb(null)); }
  drain(cb) { setImmediate(() => cb && cb()); }
}
require.cache[serialportPath] = { id: serialportPath, exports: { SerialPort: FakeSerialPort }, loaded: true };

// --- Mock Scanner + Identifier ----------------------------------------------
const scannerPath = require.resolve('./osdp/OSDPFirmwareScanner');
const identifierPath = require.resolve('./osdp/OSDPFirmwareIdentifier');

let mockScanReturn = [];
let mockIdentifyReturn = null;
let mockIdentifyThrow = null;

class FakeScanner extends EventEmitter {
  constructor(opts) { super(); this.opts = opts; }
  async open() {}
  async close() {}
  async scan() { return mockScanReturn; }
}
class FakeIdentifier extends EventEmitter {
  constructor(opts) { super(); this.opts = opts; }
  async open() {}
  async close() {}
  async identify() {
    if (mockIdentifyThrow) throw mockIdentifyThrow;
    return mockIdentifyReturn;
  }
}
require.cache[scannerPath]    = { id: scannerPath,    exports: FakeScanner,    loaded: true };
require.cache[identifierPath] = { id: identifierPath, exports: FakeIdentifier, loaded: true };

// --- Load route ---
const attachFirmwareRoutes = require('./routes-osdp-firmware');

function makeMockOsdpManager() {
  const readers = new Map();
  return {
    config: { serialPorts: [] },
    readers,
    serialPorts: new Map(),
    getReader(id) { return readers.get(id) || null; },
    getReaders() { return Array.from(readers.values()); },
    handleIncomingData() {},
  };
}

async function makeServer(osdpManager) {
  const app = express();
  attachFirmwareRoutes(app, osdpManager, { emit: () => {} });
  return new Promise(resolve => {
    const server = http.createServer(app).listen(0, '127.0.0.1', () => {
      resolve({ server, baseUrl: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

// --- Test data dir cleanup ---
const dataDir = path.join(__dirname, 'data');
const libraryDir = path.join(dataDir, 'firmware-library');
const libraryIndex = path.join(dataDir, 'firmware-library.json');
const historyFile = path.join(dataDir, 'firmware-history.json');

function cleanDataDir() {
  if (fs.existsSync(libraryDir)) {
    for (const f of fs.readdirSync(libraryDir)) try { fs.unlinkSync(path.join(libraryDir, f)); } catch {}
  }
  for (const f of [libraryIndex, historyFile]) try { fs.unlinkSync(f); } catch {}
}

// ── Scan tests ─────────────────────────────────────────────────────────────

async function test_scan_returns_per_address_results() {
  mockScanReturn = [
    { address: 0, replied: false, error: 'timeout' },
    { address: 1, replied: true, replyCode: 0x40, replyName: 'osdp_ACK' },
    { address: 2, replied: false, error: 'timeout' },
  ];
  const { server, baseUrl } = await makeServer(makeMockOsdpManager());
  try {
    const res = await fetch(`${baseUrl}/api/osdp/firmware-scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port: 'ttyACM0', baud: 9600, fromAddr: 0, toAddr: 2 }),
    });
    const body = await res.json();
    check(res.status === 200, `expected 200, got ${res.status}`);
    check(body.success === true, 'success should be true');
    check(body.replyCount === 1, `replyCount should be 1, got ${body.replyCount}`);
    check(body.results.length === 3, `expected 3 results, got ${body.results.length}`);
    check(body.port === '/dev/ttyACM0', `port should be normalized, got ${body.port}`);
    console.log('TEST PASS  Scan endpoint returns per-address results with reply count');
  } finally { server.close(); }
}

async function test_scan_rejects_missing_port() {
  const { server, baseUrl } = await makeServer(makeMockOsdpManager());
  try {
    const res = await fetch(`${baseUrl}/api/osdp/firmware-scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baud: 9600 }),
    });
    const body = await res.json();
    check(res.status === 400, `expected 400, got ${res.status}`);
    check(/port/i.test(body.error), `wrong error: ${body.error}`);
    console.log(`TEST PASS  Scan rejects missing port (${body.error})`);
  } finally { server.close(); }
}

async function test_scan_rejects_bad_address_range() {
  const { server, baseUrl } = await makeServer(makeMockOsdpManager());
  try {
    const res = await fetch(`${baseUrl}/api/osdp/firmware-scan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port: 'ttyACM0', fromAddr: 50, toAddr: 10 }),
    });
    const body = await res.json();
    check(res.status === 400, `expected 400, got ${res.status}`);
    console.log(`TEST PASS  Scan rejects reversed address range (${body.error})`);
  } finally { server.close(); }
}

// ── Identify tests ─────────────────────────────────────────────────────────

async function test_identify_returns_pdid_and_caps() {
  mockIdentifyReturn = {
    vendorCode: 0x00005C,
    vendorName: 'WaveLynx',
    modelNumber: 7,
    modelVersion: 2,
    serialNumber: 0xDEADBEEF,
    serialHex: 'DEADBEEF',
    firmwareVersion: { major: 4, minor: 2, build: 3 },
    firmwareString: '4.2.3',
    capabilities: [{ code: 22, level: 1, numItems: 0, name: 'file-transfer' }],
    supportsFiletransfer: true,
    supportsSecureChannel: false,
    maxReceiveBufferSize: 128,
  };
  mockIdentifyThrow = null;
  const { server, baseUrl } = await makeServer(makeMockOsdpManager());
  try {
    const res = await fetch(`${baseUrl}/api/osdp/firmware-identify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port: 'ttyACM0', baud: 9600, address: 0 }),
    });
    const body = await res.json();
    check(res.status === 200, `expected 200, got ${res.status}; body=${JSON.stringify(body)}`);
    check(body.vendorName === 'WaveLynx', `wrong vendor: ${body.vendorName}`);
    check(body.firmwareString === '4.2.3', `wrong fw: ${body.firmwareString}`);
    check(body.supportsFiletransfer === true, 'should support FT');
    check(body.scbkConfigured === false, 'should report no SCBK configured');
    console.log(`TEST PASS  Identify returns PDID + caps + scbkConfigured (vendor=${body.vendorName}, fw=${body.firmwareString})`);
  } finally { server.close(); }
}

async function test_identify_rejects_bad_address() {
  const { server, baseUrl } = await makeServer(makeMockOsdpManager());
  try {
    const res = await fetch(`${baseUrl}/api/osdp/firmware-identify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port: 'ttyACM0', address: 999 }),
    });
    check(res.status === 400, `expected 400, got ${res.status}`);
    console.log('TEST PASS  Identify rejects out-of-range address');
  } finally { server.close(); }
}

async function test_identify_reports_identifier_errors() {
  mockIdentifyThrow = new Error('Reply timeout (>2000ms) waiting for 0x45 from addr 0x05');
  const { server, baseUrl } = await makeServer(makeMockOsdpManager());
  try {
    const res = await fetch(`${baseUrl}/api/osdp/firmware-identify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ port: 'ttyACM0', address: 5 }),
    });
    const body = await res.json();
    check(res.status === 500, `expected 500, got ${res.status}`);
    check(/timeout/i.test(body.error), `wrong error: ${body.error}`);
    console.log(`TEST PASS  Identify forwards underlying timeout error to client (${body.error})`);
  } finally {
    mockIdentifyThrow = null;
    server.close();
  }
}

// ── Library tests ──────────────────────────────────────────────────────────

async function test_library_lifecycle() {
  cleanDataDir();
  const { server, baseUrl } = await makeServer(makeMockOsdpManager());
  try {
    // 1. List - should be empty
    let res = await fetch(`${baseUrl}/api/osdp/firmware-library`);
    let body = await res.json();
    check(body.success && body.entries.length === 0, 'library should start empty');
    console.log('TEST PASS  Library starts empty');

    // 2. Upload a bin
    const fileBuf = Buffer.from('fake-firmware-bytes-here-12345');
    const form = new FormData();
    form.append('firmware', new Blob([fileBuf]), 'test_firmware.bin');
    form.append('metadata', JSON.stringify({ model: 'CWL1', version: 'v04.02.03', notes: 'test' }));
    res = await fetch(`${baseUrl}/api/osdp/firmware-library`, { method: 'POST', body: form });
    body = await res.json();
    check(res.status === 200 && body.success, `upload failed: ${JSON.stringify(body)}`);
    check(body.entry.model === 'CWL1', `metadata not stored: ${JSON.stringify(body.entry)}`);
    check(body.entry.version === 'v04.02.03', 'version not stored');
    check(body.entry.sha256.length === 64, 'sha256 should be 64 hex chars');
    const newId = body.entry.id;
    console.log(`TEST PASS  Library accepts new bin with metadata (id=${newId}, sha=${body.entry.sha256.slice(0,12)}…)`);

    // 3. List - should have 1
    res = await fetch(`${baseUrl}/api/osdp/firmware-library`);
    body = await res.json();
    check(body.entries.length === 1, `expected 1 entry, got ${body.entries.length}`);
    check(body.entries[0].id === newId, 'id mismatch');
    console.log('TEST PASS  Library list returns the new entry');

    // 4. Try to upload identical bytes — should reject as duplicate
    const form2 = new FormData();
    form2.append('firmware', new Blob([fileBuf]), 'different_name.bin');
    res = await fetch(`${baseUrl}/api/osdp/firmware-library`, { method: 'POST', body: form2 });
    body = await res.json();
    check(res.status === 409, `expected 409, got ${res.status}`);
    check(body.existingId === newId, 'should point to existing entry');
    console.log('TEST PASS  Library rejects duplicate (same SHA-256)');

    // 5. Delete
    res = await fetch(`${baseUrl}/api/osdp/firmware-library/${newId}`, { method: 'DELETE' });
    body = await res.json();
    check(res.status === 200 && body.success, 'delete should succeed');
    console.log('TEST PASS  Library delete removes the entry');

    // 6. Confirm gone
    res = await fetch(`${baseUrl}/api/osdp/firmware-library`);
    body = await res.json();
    check(body.entries.length === 0, 'should be empty again');
    console.log('TEST PASS  Library is empty after delete');

    // 7. Delete non-existent
    res = await fetch(`${baseUrl}/api/osdp/firmware-library/no-such-id`, { method: 'DELETE' });
    check(res.status === 404, `expected 404, got ${res.status}`);
    console.log('TEST PASS  Library delete returns 404 for unknown id');
  } finally { server.close(); cleanDataDir(); }
}

// ── History tests ──────────────────────────────────────────────────────────

async function test_history_starts_empty() {
  cleanDataDir();
  const { server, baseUrl } = await makeServer(makeMockOsdpManager());
  try {
    const res = await fetch(`${baseUrl}/api/osdp/firmware-history`);
    const body = await res.json();
    check(res.status === 200 && body.success, 'history GET should succeed');
    check(Array.isArray(body.entries) && body.entries.length === 0, 'should be empty');
    check(body.total === 0, 'total should be 0');
    console.log('TEST PASS  History endpoint returns empty list when no uploads yet');
  } finally { server.close(); cleanDataDir(); }
}

async function test_history_respects_limit_query() {
  cleanDataDir();
  // Pre-populate history file with 5 fake entries
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(historyFile, JSON.stringify([
    { ts: 5, result: 'success' }, { ts: 4, result: 'failure' },
    { ts: 3, result: 'success' }, { ts: 2, result: 'success' },
    { ts: 1, result: 'failure' },
  ]));

  const { server, baseUrl } = await makeServer(makeMockOsdpManager());
  try {
    const res = await fetch(`${baseUrl}/api/osdp/firmware-history?limit=2`);
    const body = await res.json();
    check(body.entries.length === 2, `limit=2 should return 2, got ${body.entries.length}`);
    check(body.total === 5, `total should report 5, got ${body.total}`);
    check(body.entries[0].ts === 5, 'newest first');
    console.log('TEST PASS  History honors ?limit= and reports correct total');
  } finally { server.close(); cleanDataDir(); }
}

// ── Run ─────────────────────────────────────────────────────────────────────

(async () => {
  await test_scan_returns_per_address_results();
  await test_scan_rejects_missing_port();
  await test_scan_rejects_bad_address_range();
  await test_identify_returns_pdid_and_caps();
  await test_identify_rejects_bad_address();
  await test_identify_reports_identifier_errors();
  await test_library_lifecycle();
  await test_history_starts_empty();
  await test_history_respects_limit_query();
  console.log('\nAll wizard-endpoint tests passed.');
})().catch(e => { console.error('FAIL:', e.stack || e); process.exit(1); });
