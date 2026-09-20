// Tests for OSDPFirmwareScanner and OSDPFirmwareIdentifier.
//
// Uses scripted mock ports that emit the right replies in response to the
// CP's transmitted commands. No real hardware required.

const assert = require('assert');
const OSDPPacket = require('./osdp/OSDPPacket');
const OSDPFirmwareScanner = require('./osdp/OSDPFirmwareScanner');
const OSDPFirmwareIdentifier = require('./osdp/OSDPFirmwareIdentifier');

const check = (cond, msg) => assert.ok(cond, msg);

// Helper: build a reply packet
function reply(address, command, data, sequence, useCRC = true) {
  return OSDPPacket.buildPacket({
    address, command, data: data || Buffer.alloc(0),
    sequence, isReply: true, useCRC,
  });
}

// Scripted mock port: replyFn(parsedCpFrame, writeCount) → Buffer (the reply
// to feed back) or null (silent — caller will time out).
class ScriptedMockPort {
  constructor(replyFn) {
    this.isOpen     = true;
    this.replyFn    = replyFn;
    this._writes    = 0;
    this._owner     = null;
  }
  attach(owner) { this._owner = owner; }
  on() {}
  drain(cb) { setImmediate(cb); }
  close(cb) { this.isOpen = false; cb && cb(); }
  write(buf, cb) {
    setImmediate(() => cb && cb(null));
    const parsed = OSDPPacket.parsePacket(buf);
    const replyBuf = this.replyFn(parsed, this._writes++);
    if (replyBuf) setImmediate(() => this._owner._onData(replyBuf));
  }
}

// ── Scanner tests ──────────────────────────────────────────────────────────

async function test_scanner_finds_reader_at_one_address() {
  const scanner = new OSDPFirmwareScanner({ portPath: '/dev/null', baudRate: 9600 });
  const mock = new ScriptedMockPort((cp) => {
    // Only address 5 replies; everyone else stays silent (timeout)
    if (cp && cp.address === 5 && cp.command === 0x60) {
      return reply(5, 0x40, null, cp.ctrl.sequence);
    }
    return null;
  });
  mock.attach(scanner);
  scanner.port = mock;

  const results = await scanner.scan({ fromAddr: 0, toAddr: 7, timeoutMs: 50 });

  check(results.length === 8, `expected 8 results, got ${results.length}`);
  const replied = results.filter(r => r.replied);
  check(replied.length === 1, `expected 1 replier, got ${replied.length}`);
  check(replied[0].address === 5, `wrong address: ${replied[0].address}`);
  check(replied[0].replyCode === 0x40, `wrong reply code: ${replied[0].replyCode}`);
  check(replied[0].replyName === 'osdp_ACK', `wrong reply name: ${replied[0].replyName}`);
  console.log('TEST PASS  Scanner finds reader at correct address, rest silent');
}

async function test_scanner_emits_address_events() {
  const scanner = new OSDPFirmwareScanner({ portPath: '/dev/null', baudRate: 9600 });
  scanner.port = new ScriptedMockPort(() => null);   // all silent
  scanner.port.attach(scanner);

  const events = [];
  scanner.on('address', e => events.push(e));

  await scanner.scan({ fromAddr: 0, toAddr: 3, timeoutMs: 30 });
  check(events.length === 4, `expected 4 events, got ${events.length}`);
  check(events.every(e => !e.replied), 'all should be unreplied');
  console.log(`TEST PASS  Scanner emits per-address events (${events.length} events)`);
}

async function test_scanner_handles_reader_at_address_0() {
  // Edge case — address 0 is the OSDP "broadcast / default install" address
  // and should still work like any other.
  const scanner = new OSDPFirmwareScanner({ portPath: '/dev/null' });
  scanner.port = new ScriptedMockPort((cp) => {
    if (cp.address === 0) return reply(0, 0x40, null, cp.ctrl.sequence);
    return null;
  });
  scanner.port.attach(scanner);

  const results = await scanner.scan({ fromAddr: 0, toAddr: 2, timeoutMs: 30 });
  check(results[0].replied === true, 'address 0 should reply');
  check(results[0].address === 0, 'first result is address 0');
  console.log('TEST PASS  Scanner correctly handles address 0');
}

async function test_scanner_rejects_bad_range() {
  const scanner = new OSDPFirmwareScanner({ portPath: '/dev/null' });
  scanner.port = new ScriptedMockPort(() => null);
  scanner.port.attach(scanner);

  let caught = null;
  try { await scanner.scan({ fromAddr: 10, toAddr: 5 }); } catch (e) { caught = e; }
  check(caught && /toAddr < fromAddr/.test(caught.message), `expected range error: ${caught && caught.message}`);
  console.log('TEST PASS  Scanner rejects reversed range');

  caught = null;
  try { await scanner.scan({ fromAddr: 0, toAddr: 200 }); } catch (e) { caught = e; }
  check(caught && /out of range/.test(caught.message), `expected range error: ${caught && caught.message}`);
  console.log('TEST PASS  Scanner rejects addresses > 0x7E');
}

// ── Identifier tests ───────────────────────────────────────────────────────

function buildPDID({ vendor = 0x00005C, model = 0x42, modelVersion = 0x01,
                     serial = 0x12345678, fwMajor = 4, fwMinor = 2, fwBuild = 3 } = {}) {
  return Buffer.from([
    (vendor >> 16) & 0xFF, (vendor >> 8) & 0xFF, vendor & 0xFF,
    model & 0xFF,
    modelVersion & 0xFF,
    (serial >>> 24) & 0xFF, (serial >>> 16) & 0xFF, (serial >>> 8) & 0xFF, serial & 0xFF,
    fwMajor & 0xFF, fwMinor & 0xFF, fwBuild & 0xFF,
  ]);
}

function buildPDCAP(triples) {
  return Buffer.concat(triples.map(([c, l, n]) => Buffer.from([c, l, n])));
}

async function test_identifier_parses_pdid_correctly() {
  const id = new OSDPFirmwareIdentifier({ portPath: '/dev/null', baudRate: 9600, address: 1 });
  id.port = new ScriptedMockPort((cp, n) => {
    if (n === 0 && cp.command === 0x61) {
      return reply(1, 0x45, buildPDID({
        vendor: 0x00005C, model: 0x07, modelVersion: 0x02,
        serial: 0xDEADBEEF, fwMajor: 4, fwMinor: 2, fwBuild: 255,
      }), cp.ctrl.sequence);
    }
    if (n === 1 && cp.command === 0x62) {
      return reply(1, 0x46, buildPDCAP([
        [22, 1, 0],     // FILE_TRANSFER, compliance 1
        [9,  1, 0],     // COMMUNICATION_SECURITY, AES-128
        [10, 128, 0],   // RECEIVE_BUFFERSIZE = 128
      ]), cp.ctrl.sequence);
    }
    return null;
  });
  id.port.attach(id);

  const info = await id.identify();
  check(info.vendorCode === 0x00005C, `wrong vendor code: ${info.vendorCode.toString(16)}`);
  check(info.vendorName === 'WaveLynx', `wrong vendor name: ${info.vendorName}`);
  check(info.modelNumber === 0x07, `wrong model: ${info.modelNumber}`);
  check(info.modelVersion === 0x02, `wrong model version: ${info.modelVersion}`);
  check(info.serialNumber === 0xDEADBEEF, `wrong serial: ${info.serialNumber.toString(16)}`);
  check(info.serialHex === 'DEADBEEF', `wrong serial hex: ${info.serialHex}`);
  check(info.firmwareString === '4.2.255', `wrong fw string: ${info.firmwareString}`);
  console.log(`TEST PASS  PDID parsed: vendor=${info.vendorName}, fw=${info.firmwareString}, serial=${info.serialHex}`);

  check(info.supportsFiletransfer === true, 'should detect FILETRANSFER support');
  check(info.supportsSecureChannel === true, 'should detect secure-channel support');
  console.log(`TEST PASS  Caps parsed: FILETRANSFER=${info.supportsFiletransfer}, SC=${info.supportsSecureChannel}`);
}

async function test_identifier_handles_unknown_vendor() {
  const id = new OSDPFirmwareIdentifier({ portPath: '/dev/null', address: 0 });
  id.port = new ScriptedMockPort((cp, n) => {
    if (n === 0) return reply(0, 0x45, buildPDID({ vendor: 0x123456 }), cp.ctrl.sequence);
    if (n === 1) return reply(0, 0x46, buildPDCAP([[22, 1, 0]]), cp.ctrl.sequence);
    return null;
  });
  id.port.attach(id);

  const info = await id.identify();
  check(/0x123456/i.test(info.vendorName), `unknown vendor should render as hex: ${info.vendorName}`);
  console.log(`TEST PASS  Unknown vendor renders as hex (${info.vendorName})`);
}

async function test_identifier_detects_no_filetransfer_support() {
  const id = new OSDPFirmwareIdentifier({ portPath: '/dev/null', address: 0 });
  id.port = new ScriptedMockPort((cp, n) => {
    if (n === 0) return reply(0, 0x45, buildPDID({}), cp.ctrl.sequence);
    if (n === 1) return reply(0, 0x46, buildPDCAP([[4, 1, 1], [5, 1, 1]]), cp.ctrl.sequence);  // LED, BUZZER only — no FT
    return null;
  });
  id.port.attach(id);

  const info = await id.identify();
  check(info.supportsFiletransfer === false, 'should NOT report FT support when not in caps');
  console.log('TEST PASS  Identifier reports supportsFiletransfer=false when reader lacks the cap');
}

async function test_identifier_throws_on_short_pdid() {
  const id = new OSDPFirmwareIdentifier({ portPath: '/dev/null', address: 0 });
  id.port = new ScriptedMockPort((cp) => reply(0, 0x45, Buffer.alloc(5), cp.ctrl.sequence));
  id.port.attach(id);

  let caught = null;
  try { await id.identify(); } catch (e) { caught = e; }
  check(caught && /too short/i.test(caught.message), `expected length error: ${caught && caught.message}`);
  console.log(`TEST PASS  Identifier rejects truncated PDID ("${caught.message}")`);
}

// ── Run ────────────────────────────────────────────────────────────────────

(async () => {
  await test_scanner_finds_reader_at_one_address();
  await test_scanner_emits_address_events();
  await test_scanner_handles_reader_at_address_0();
  await test_scanner_rejects_bad_range();
  await test_identifier_parses_pdid_correctly();
  await test_identifier_handles_unknown_vendor();
  await test_identifier_detects_no_filetransfer_support();
  await test_identifier_throws_on_short_pdid();
  console.log('\nAll scanner + identifier tests passed.');
})().catch(e => { console.error('FAIL:', e.stack || e); process.exit(1); });
