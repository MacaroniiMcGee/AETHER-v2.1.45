// Integration test: real Express app + real HTTP requests against
// routes-osdp-firmware. The OSDPFirmwareUploader class is replaced via
// require-cache injection so we can exercise the route without a real reader.

const path    = require('path');
const fs      = require('fs');
const http    = require('http');
const assert  = require('assert');
const express = require('express');
const EventEmitter = require('events');

// Pass/fail helper — throws so a failure actually fails the run.
// (`console.assert` only prints, which is why earlier runs reported false PASSes.)
const check = (cond, msg) => assert.ok(cond, msg);

// --- Mock SerialPort BEFORE the route requires it ----------------------------
// reopenEmulatorPort instantiates SerialPort against the configured /dev path,
// which obviously won't exist in CI. We stub the whole module so the constructor
// succeeds against any path.
const serialportPath = require.resolve('serialport');
class FakeSerialPort extends EventEmitter {
  constructor(opts) {
    super();
    this.path     = opts.path;
    this.baudRate = opts.baudRate;
    this.isOpen   = false;
  }
  open(cb)  { this.isOpen = true;  setImmediate(() => cb && cb(null)); }
  close(cb) { this.isOpen = false; setImmediate(() => cb && cb()); }
  set(_o, cb) { setImmediate(() => cb && cb()); }
  write(_b, cb) { setImmediate(() => cb && cb(null)); }
  drain(cb) { setImmediate(() => cb && cb()); }
}
require.cache[serialportPath] = {
  id:      serialportPath,
  exports: { SerialPort: FakeSerialPort },
  loaded:  true,
};

// --- Replace the uploader BEFORE the route requires it -----------------------
const uploaderPath = require.resolve('./osdp/OSDPFirmwareUploader');

let nextUploaderBehavior = 'success';   // 'success' | 'fail' | 'abort'
const uploaderInstances  = [];

class FakeUploader extends EventEmitter {
  static FT_STATUS = { OK: 0, PROCESSED: 1, REBOOTING: 2, FINISHING: 3 };
  constructor(opts) {
    super();
    this.opts = opts;
    this.opened = false;
    this.closed = false;
    this.aborted = false;
    uploaderInstances.push(this);
  }
  async open()  { this.opened = true; }
  async close() { this.closed = true; }
  abort()       { this.aborted = true; }
  async transferFile(buf) {
    this.transferCalledWith = { bufferLength: buf.length };
    this.emit('status', { level: 'info', message: 'starting', ts: Date.now() });
    this.emit('progress', { phase: 'transfer', fragment: 1, totalFragments: 1, bytesSent: buf.length, totalBytes: buf.length, percent: 100, ftStatus: 0, ftDelay: 0 });
    if (nextUploaderBehavior === 'fail') {
      throw new Error('simulated reader error');
    }
    if (nextUploaderBehavior === 'abort') {
      throw new Error('Transfer aborted');
    }
    return { bytesSent: buf.length, fragments: 1, finalStatus: FakeUploader.FT_STATUS.PROCESSED };
  }
}

require.cache[uploaderPath] = { id: uploaderPath, exports: FakeUploader, loaded: true };

// --- Now load the route ------------------------------------------------------
const attachFirmwareRoutes = require('./routes-osdp-firmware.js.new');

// --- Mock OSDPManager --------------------------------------------------------
function makeMockOsdpManager() {
  const readers = new Map();
  readers.set('osdp-reader-1', {
    id: 'osdp-reader-1', name: 'Reader A', address: 0x01,
    enabled: true, serialPort: '/dev/ttyUSB-mock', secureChannel: false,
  });

  // Fake "owned" serial port (so releaseEmulatorPort exercises that branch)
  const fakePort = {
    isOpen: true,
    close(cb) { this.isOpen = false; setImmediate(() => cb && cb()); },
    on() {}, set() {}, write(_b, cb) { cb && cb(null); }, drain(cb) { cb && cb(); },
  };
  const serialPorts = new Map();
  serialPorts.set('/dev/ttyUSB-mock', fakePort);

  return {
    config: { serialPorts: [{ port: '/dev/ttyUSB-mock', baudRate: 9600 }] },
    readers,
    serialPorts,
    getReader(id) { return readers.get(id) || null; },
    handleIncomingData() {},
  };
}

// --- Mock io -----------------------------------------------------------------
function makeMockIo() {
  const events = [];
  return { events, emit: (name, payload) => events.push({ name, payload }) };
}

// --- Server harness ----------------------------------------------------------
async function makeServer(osdpManager, io) {
  const app = express();
  attachFirmwareRoutes(app, osdpManager, io);

  return new Promise((resolve) => {
    const server = http.createServer(app).listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

function makeBinFile(bytes = 1024) {
  const buf = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i++) buf[i] = (i * 7 + 3) & 0xFF;
  return buf;
}

async function postFirmware(baseUrl, { fileBuf, fileName = 'fw.bin', readerId } = {}) {
  const form = new FormData();
  if (fileBuf !== undefined) {
    form.append('firmware', new Blob([fileBuf]), fileName);
  }
  if (readerId !== undefined) form.append('readerId', readerId);
  const res = await fetch(`${baseUrl}/api/osdp/firmware-upload`, { method: 'POST', body: form });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

// --- Tests -------------------------------------------------------------------

async function test_400_when_no_file() {
  const osdp = makeMockOsdpManager();
  const io   = makeMockIo();
  const { server, baseUrl } = await makeServer(osdp, io);
  try {
    const form = new FormData();
    form.append('readerId', 'osdp-reader-1');
    const res = await fetch(`${baseUrl}/api/osdp/firmware-upload`, { method: 'POST', body: form });
    const body = await res.json();
    check(res.status === 400, `expected 400, got ${res.status}`);
    check(/No firmware file/i.test(body.error), `wrong error: ${body.error}`);
    console.log(`TEST PASS  400 when no file uploaded ("${body.error}")`);
  } finally { server.close(); }
}

async function test_400_when_no_readerId() {
  const osdp = makeMockOsdpManager();
  const { server, baseUrl } = await makeServer(osdp, makeMockIo());
  try {
    const { status, body } = await postFirmware(baseUrl, { fileBuf: makeBinFile(100) });
    check(status === 400, `expected 400, got ${status}`);
    check(/readerId/i.test(body.error), `wrong error: ${body.error}`);
    console.log(`TEST PASS  400 when readerId missing ("${body.error}")`);
  } finally { server.close(); }
}

async function test_400_when_not_bin() {
  const osdp = makeMockOsdpManager();
  const { server, baseUrl } = await makeServer(osdp, makeMockIo());
  try {
    const { status, body } = await postFirmware(baseUrl, { fileBuf: makeBinFile(50), fileName: 'fw.exe', readerId: 'osdp-reader-1' });
    check(status === 400, `expected 400, got ${status}`);
    check(/\.bin/i.test(body.error), `wrong error: ${body.error}`);
    console.log(`TEST PASS  400 when filename is not .bin ("${body.error}")`);
  } finally { server.close(); }
}

async function test_404_when_reader_unknown() {
  const osdp = makeMockOsdpManager();
  const { server, baseUrl } = await makeServer(osdp, makeMockIo());
  try {
    const { status, body } = await postFirmware(baseUrl, { fileBuf: makeBinFile(50), readerId: 'no-such-reader' });
    check(status === 404, `expected 404, got ${status}`);
    check(/not found/i.test(body.error), `wrong error: ${body.error}`);
    console.log(`TEST PASS  404 when reader unknown ("${body.error}")`);
  } finally { server.close(); }
}

async function test_503_when_manager_missing() {
  const { server, baseUrl } = await makeServer(null, makeMockIo());
  try {
    const { status, body } = await postFirmware(baseUrl, { fileBuf: makeBinFile(50), readerId: 'osdp-reader-1' });
    check(status === 503, `expected 503, got ${status}`);
    check(/not initialized/i.test(body.error), `wrong error: ${body.error}`);
    console.log(`TEST PASS  503 when osdpManager is null ("${body.error}")`);
  } finally { server.close(); }
}

async function test_happy_path() {
  nextUploaderBehavior = 'success';
  uploaderInstances.length = 0;

  const osdp = makeMockOsdpManager();
  const io   = makeMockIo();
  const { server, baseUrl } = await makeServer(osdp, io);

  const fileBuf = makeBinFile(2048);
  const startedAt = Date.now();
  try {
    const { status, body } = await postFirmware(baseUrl, { fileBuf, readerId: 'osdp-reader-1' });

    check(status === 200, `expected 200, got ${status} body=${JSON.stringify(body)}`);
    check(body.success === true, `success should be true: ${JSON.stringify(body)}`);
    check(body.bytesSent === fileBuf.length, `bytesSent mismatch: ${body.bytesSent}`);
    check(body.finalStatus === 1, `finalStatus should be FT_PROCESSED (1): ${body.finalStatus}`);
    check(body.rebooting === false, `rebooting should be false for PROCESSED: ${body.rebooting}`);
    console.log(`TEST PASS  Happy path returns 200 success with ${body.bytesSent} bytes / ${body.fragments} fragment(s)`);

    // Verify the uploader got the right parameters
    const u = uploaderInstances[0];
    check(u, 'an uploader should have been instantiated');
    check(u.opts.portPath === '/dev/ttyUSB-mock', `wrong portPath: ${u.opts.portPath}`);
    check(u.opts.address  === 0x01,               `wrong address: ${u.opts.address}`);
    check(u.transferCalledWith.bufferLength === fileBuf.length, 'wrong file size passed to transferFile');
    check(u.opened === true && u.closed === true, 'open() and close() should both have been called');
    console.log('TEST PASS  Uploader was opened, called with correct port/addr/file, and closed');

    // Verify Socket.IO events were emitted
    const statusEvents   = io.events.filter(e => e.name === 'osdp_firmware_status');
    const progressEvents = io.events.filter(e => e.name === 'osdp_firmware_progress');
    check(statusEvents.length   >= 1, `expected ≥1 status event, got ${statusEvents.length}`);
    check(progressEvents.length >= 1, `expected ≥1 progress event, got ${progressEvents.length}`);
    check(progressEvents.every(e => e.payload.readerId === 'osdp-reader-1'), 'all events should carry readerId');
    console.log(`TEST PASS  Emitted ${statusEvents.length} status + ${progressEvents.length} progress event(s) over Socket.IO`);

    // Verify port was released and reopened
    check(osdp.serialPorts.has('/dev/ttyUSB-mock'),
      'port should have been reopened in osdpManager.serialPorts');
    console.log('TEST PASS  Emulator port was reclaimed after upload');

    // Verify upload file was cleaned up
    const uploadDir = path.join(__dirname, 'uploads', 'firmware');
    if (fs.existsSync(uploadDir)) {
      const leftover = fs.readdirSync(uploadDir).filter(n => n.startsWith('fw_'));
      check(leftover.length === 0, `upload file not cleaned: ${leftover.join(',')}`);
      console.log('TEST PASS  Uploaded file was cleaned up from disk');
    }

    const elapsed = Date.now() - startedAt;
    console.log(`             (full happy-path round-trip in ${elapsed}ms)`);
  } finally { server.close(); }
}

async function test_failure_path_returns_500_and_cleans_up() {
  nextUploaderBehavior = 'fail';
  uploaderInstances.length = 0;

  const osdp = makeMockOsdpManager();
  const { server, baseUrl } = await makeServer(osdp, makeMockIo());
  try {
    const { status, body } = await postFirmware(baseUrl, { fileBuf: makeBinFile(500), readerId: 'osdp-reader-1' });
    check(status === 500, `expected 500, got ${status}`);
    check(body.success === false, 'success should be false');
    check(/simulated reader error/.test(body.error), `wrong error: ${body.error}`);
    console.log(`TEST PASS  Upload failure returns 500 with the underlying error ("${body.error}")`);

    const u = uploaderInstances[0];
    check(u.closed === true, 'uploader must still be close()d even on failure');
    console.log('TEST PASS  Uploader closed on failure path');

    check(osdp.serialPorts.has('/dev/ttyUSB-mock'),
      'port must be reopened even when upload fails');
    console.log('TEST PASS  Emulator port reclaimed even after failure');
  } finally { server.close(); }
}

async function test_409_when_upload_in_progress() {
  nextUploaderBehavior = 'success';
  uploaderInstances.length = 0;

  // Make transferFile hang so we can race a second request against it
  const origTransfer = FakeUploader.prototype.transferFile;
  FakeUploader.prototype.transferFile = function(buf) {
    this.transferCalledWith = { bufferLength: buf.length };
    return new Promise(resolve => {
      this._resolveTransfer = () => resolve({ bytesSent: buf.length, fragments: 1, finalStatus: 1 });
    });
  };

  const osdp = makeMockOsdpManager();
  const { server, baseUrl } = await makeServer(osdp, makeMockIo());
  try {
    const first  = postFirmware(baseUrl, { fileBuf: makeBinFile(100), readerId: 'osdp-reader-1' });
    // Wait for the route to actually start (file landed, uploader created)
    await new Promise(r => setTimeout(r, 100));
    const second = await postFirmware(baseUrl, { fileBuf: makeBinFile(100), readerId: 'osdp-reader-1' });

    check(second.status === 409, `expected 409, got ${second.status}`);
    check(/in progress/i.test(second.body.error), `wrong error: ${second.body.error}`);
    console.log(`TEST PASS  Second concurrent upload rejected with 409 ("${second.body.error}")`);

    // Let the first one finish
    uploaderInstances[0]._resolveTransfer();
    const firstResult = await first;
    check(firstResult.status === 200, 'first request should still succeed');
    console.log('TEST PASS  First (in-progress) upload still completes after second is rejected');
  } finally {
    FakeUploader.prototype.transferFile = origTransfer;
    server.close();
  }
}

async function test_abort_endpoint() {
  nextUploaderBehavior = 'abort';
  uploaderInstances.length = 0;

  // Hang transferFile until abort() is observed
  const origTransfer = FakeUploader.prototype.transferFile;
  FakeUploader.prototype.transferFile = function(buf) {
    this.transferCalledWith = { bufferLength: buf.length };
    return new Promise((_, reject) => {
      this._abortReject = () => reject(new Error('Transfer aborted'));
    });
  };
  FakeUploader.prototype.abort = function() {
    this.aborted = true;
    if (this._abortReject) this._abortReject();
  };

  const osdp = makeMockOsdpManager();
  const { server, baseUrl } = await makeServer(osdp, makeMockIo());
  try {
    const uploadP = postFirmware(baseUrl, { fileBuf: makeBinFile(100), readerId: 'osdp-reader-1' });
    await new Promise(r => setTimeout(r, 100));

    const abortRes  = await fetch(`${baseUrl}/api/osdp/firmware-abort`, { method: 'POST' });
    const abortBody = await abortRes.json();
    check(abortRes.status === 200, `expected 200 from abort, got ${abortRes.status}`);
    check(abortBody.abortedReaderId === 'osdp-reader-1', 'abort response should include readerId');
    console.log(`TEST PASS  /firmware-abort returns 200 and identifies the aborted reader`);

    const uploadResult = await uploadP;
    check(uploadResult.status === 500, `expected upload to fail with 500, got ${uploadResult.status}`);
    check(/abort/i.test(uploadResult.body.error), `expected aborted error: ${uploadResult.body.error}`);
    console.log('TEST PASS  Aborted upload returns 500 with abort message');
  } finally {
    FakeUploader.prototype.transferFile = origTransfer;
    server.close();
  }
}

async function test_capture_and_transfer_endpoints_return_501() {
  const osdp = makeMockOsdpManager();
  const { server, baseUrl } = await makeServer(osdp, makeMockIo());
  try {
    const cap = await fetch(`${baseUrl}/api/osdp/capture/osdp-reader-1`,  { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const tr  = await fetch(`${baseUrl}/api/osdp/transfer/osdp-reader-1`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    check(cap.status === 501, `capture expected 501, got ${cap.status}`);
    check(tr.status  === 501, `transfer expected 501, got ${tr.status}`);
    console.log('TEST PASS  /capture and /transfer return honest 501 (no longer faking success)');
  } finally { server.close(); }
}

(async () => {
  await test_400_when_no_file();
  await test_400_when_no_readerId();
  await test_400_when_not_bin();
  await test_404_when_reader_unknown();
  await test_503_when_manager_missing();
  await test_happy_path();
  await test_failure_path_returns_500_and_cleans_up();
  await test_409_when_upload_in_progress();
  await test_abort_endpoint();
  await test_capture_and_transfer_endpoints_return_501();
  console.log('\nAll route integration tests passed.');
})().catch(e => {
  console.error('FAIL:', e);
  process.exit(1);
});
