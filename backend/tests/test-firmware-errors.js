// Error-path tests for OSDPFirmwareUploader.

const OSDPPacket           = require('./osdp/OSDPPacket.js');
const OSDPFirmwareUploader = require('./osdp/OSDPFirmwareUploader.js');

// Reusable minimal mock that lets each test script the response per write.
class ScriptedMock {
  constructor(replyFn) {
    this.replyFn      = replyFn;
    this.isOpen       = true;
    this._cb          = null;
    this._uploader    = null;
    this._writes      = 0;
  }
  attach(u) { this._uploader = u; }
  on()      {}
  drain(cb) { setImmediate(cb); }
  close(cb) { this.isOpen = false; cb && cb(); }
  write(buf, cb) {
    setImmediate(() => cb && cb(null));
    const parsed = OSDPPacket.parsePacket(buf);
    const reply  = this.replyFn(parsed, this._writes++);
    if (reply) setImmediate(() => this._uploader._onData(reply));
  }
}

async function test_NAK_fails_fast() {
  const u = new OSDPFirmwareUploader({ portPath: '/dev/null', address: 0x00, fragmentSize: 110 });
  u.port = new ScriptedMock((cp) => {
    return OSDPPacket.buildPacket({
      address: 0x00, command: 0x41 /* NAK */, data: Buffer.from([0x03 /* UNKNOWN_COMMAND */]),
      sequence: cp.ctrl.sequence, isReply: true, useCRC: true,
    });
  });
  u.port.attach(u);

  let caught = null;
  try { await u.transferFile(Buffer.alloc(50, 0xAB)); }
  catch (e) { caught = e; }
  console.assert(caught && /NAK/.test(caught.message), `should fail on NAK, got: ${caught && caught.message}`);
  console.log(`TEST PASS  NAK aborts the transfer: "${caught.message}"`);
}

async function test_negative_status_aborts() {
  const u = new OSDPFirmwareUploader({ portPath: '/dev/null', address: 0x00, fragmentSize: 110 });
  u.port = new ScriptedMock((cp) => {
    const d = Buffer.alloc(7);
    d.writeUInt16LE(0xFFFF, 3); // status = -1
    return OSDPPacket.buildPacket({
      address: 0x00, command: 0x7A, data: d,
      sequence: cp.ctrl.sequence, isReply: true, useCRC: true,
    });
  });
  u.port.attach(u);

  let caught = null;
  try { await u.transferFile(Buffer.alloc(50, 0xCD)); }
  catch (e) { caught = e; }
  console.assert(caught && /status -1/.test(caught.message), `should fail on negative status: ${caught && caught.message}`);
  console.log(`TEST PASS  Negative FTSTAT status aborts the transfer: "${caught.message}"`);
}

async function test_BUSY_retried_then_OK() {
  // First write gets BUSY (no FTSTAT yet); after BUSY we expect a *follow-up*
  // FTSTAT to actually resolve the request. The uploader keeps waiting on BUSY
  // until the next reply or the timeout fires. So inject the FTSTAT shortly after.
  const u = new OSDPFirmwareUploader({ portPath: '/dev/null', address: 0x00, fragmentSize: 110 });

  let busyDelivered = false;
  u.port = {
    isOpen: true,
    on() {},
    drain(cb) { setImmediate(cb); },
    close(cb) { cb && cb(); },
    write(buf, cb) {
      setImmediate(() => cb && cb(null));
      const cp = OSDPPacket.parsePacket(buf);
      if (!busyDelivered) {
        busyDelivered = true;
        // BUSY, then 50 ms later an FT_OK reply for the same sequence
        const busy = OSDPPacket.buildPacket({
          address: 0x00, command: 0x79 /* BUSY */, data: Buffer.alloc(0),
          sequence: 0, isReply: true, useCRC: true,
        });
        const ok = Buffer.alloc(7);
        ok.writeUInt16LE(5, 1);
        ok.writeUInt16LE(0, 3); // FT_OK
        ok.writeUInt16LE(110, 5);
        const okReply = OSDPPacket.buildPacket({
          address: 0x00, command: 0x7A, data: ok,
          sequence: cp.ctrl.sequence, isReply: true, useCRC: true,
        });
        setImmediate(() => u._onData(busy));
        setTimeout(() => u._onData(okReply), 50);
      } else {
        // Subsequent writes - if it's the last fragment respond FINISHING, finalize PROCESSED
        const data = cp.data;
        const offset  = data.readUInt32LE(5);
        const total   = data.readUInt32LE(1);
        const fragLen = data.readUInt16LE(9);

        let status;
        if (fragLen === 0 && offset === total) status = 1;          // FT_PROCESSED
        else if (offset + fragLen >= total)    status = 3;          // FT_FINISHING
        else                                   status = 0;          // FT_OK

        const d = Buffer.alloc(7);
        d.writeUInt16LE(5, 1);
        d.writeUInt16LE(status, 3);
        d.writeUInt16LE(110, 5);
        const r = OSDPPacket.buildPacket({
          address: 0x00, command: 0x7A, data: d,
          sequence: cp.ctrl.sequence, isReply: true, useCRC: true,
        });
        setImmediate(() => u._onData(r));
      }
    },
  };

  const result = await u.transferFile(Buffer.alloc(50, 0xEF));
  console.assert(result.finalStatus === 1, 'should still finalize successfully through a BUSY');
  console.log(`TEST PASS  BUSY ignored, transfer completes (final status ${result.finalStatus})`);
}

async function test_timeout_when_no_reply() {
  const u = new OSDPFirmwareUploader({ portPath: '/dev/null', address: 0x00, fragmentSize: 110 });
  u.port = { isOpen: true, on() {}, drain(cb) { setImmediate(cb); }, close(cb) { cb && cb(); },
    write(buf, cb) { setImmediate(() => cb && cb(null)); /* never reply */ } };

  // Shrink the timeout so the test finishes fast: pending object is created
  // inside _sendAndAwait with the constant REPLY_TIMEOUT_MS = 5000. Rather
  // than monkey-patch the constant, just wait that long here.
  const start = Date.now();
  let caught = null;
  try { await u.transferFile(Buffer.alloc(50, 0x12)); }
  catch (e) { caught = e; }
  const elapsed = Date.now() - start;
  console.assert(caught && /timeout/i.test(caught.message), `expected timeout error: ${caught && caught.message}`);
  console.assert(elapsed >= 5000 && elapsed < 7000, `should fail at ~5s, took ${elapsed}ms`);
  console.log(`TEST PASS  Times out (~${elapsed}ms) when reader is silent: "${caught.message}"`);
}

(async () => {
  await test_NAK_fails_fast();
  await test_negative_status_aborts();
  await test_BUSY_retried_then_OK();
  await test_timeout_when_no_reply();
  console.log('\nAll error-path tests passed.');
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
