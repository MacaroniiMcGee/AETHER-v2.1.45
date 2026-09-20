// End-to-end test of OSDPFirmwareUploader against a mock reader.
//
// We replace the SerialPort with a fake that:
//   - Captures every CP→PD packet via port.write()
//   - Builds an FTSTAT reply and feeds it back through uploader._onData()
//   - Tracks the sent fragments to verify offsets and content

const OSDPPacket           = require('./osdp/OSDPPacket.js');
const OSDPFirmwareUploader = require('./osdp/OSDPFirmwareUploader.js');

function buildFtStatReply(address, sequence, useCRC, status, delay = 100) {
  const data = Buffer.alloc(7);
  data[0] = 0x00;                             // action
  data.writeUInt16LE(delay, 1);               // delay
  // signed-LE16
  data.writeUInt16LE(status < 0 ? (status + 0x10000) & 0xFFFF : status & 0xFFFF, 3);
  data.writeUInt16LE(110, 5);                 // updateMsgMax
  return OSDPPacket.buildPacket({
    address, command: 0x7A, data,
    sequence, isReply: true, useCRC,
  });
}

function parseFtPayload(data) {
  return {
    fileType: data[0],
    total:    data.readUInt32LE(1),
    offset:   data.readUInt32LE(5),
    fragLen:  data.readUInt16LE(9),
    fragment: data.slice(11),
  };
}

class MockReader {
  constructor({ address, useCRC, finalizePollCount = 2 }) {
    this.address           = address;
    this.useCRC            = useCRC;
    this.receivedFragments = [];
    this.totalReceived     = 0;
    this.fileTotal         = null;
    this.finalizePollsLeft = finalizePollCount;
    this.isOpen            = true;
    this._dataListeners    = [];
    this._uploader         = null;
  }

  attach(uploader)  { this._uploader = uploader; }
  on(evt, fn)       { if (evt === 'data') this._dataListeners.push(fn); }
  drain(cb)         { setImmediate(cb); }
  close(cb)         { this.isOpen = false; cb && cb(); }

  // Capture writes from the uploader, parse, respond.
  write(buf, cb) {
    setImmediate(() => cb && cb(null));
    setImmediate(() => this._handleCpFrame(buf));
  }

  _handleCpFrame(buf) {
    const parsed = OSDPPacket.parsePacket(buf);
    if (!parsed || parsed.error || parsed.command !== 0x7C) {
      throw new Error(`MockReader got unexpected frame: ${parsed && parsed.error || 'parse fail'}`);
    }

    const ft = parseFtPayload(parsed.data);

    if (this.fileTotal === null) this.fileTotal = ft.total;
    if (ft.total !== this.fileTotal) throw new Error(`total changed mid-transfer: ${ft.total} vs ${this.fileTotal}`);

    let status;
    if (ft.fragLen > 0) {
      // Normal data fragment
      if (ft.offset !== this.totalReceived) {
        throw new Error(`offset gap: expected ${this.totalReceived}, got ${ft.offset}`);
      }
      this.receivedFragments.push(ft.fragment);
      this.totalReceived += ft.fragment.length;

      // Status: OK while there's more to come, FINISHING on the last fragment
      status = this.totalReceived >= this.fileTotal ? 3 /* FT_FINISHING */ : 0 /* FT_OK */;
    } else {
      // Finalization probe (offset === total, fragLen === 0)
      if (ft.offset !== this.fileTotal) {
        throw new Error(`finalize offset wrong: ${ft.offset} vs ${this.fileTotal}`);
      }
      if (this.finalizePollsLeft > 1) {
        this.finalizePollsLeft -= 1;
        status = 3; // FT_FINISHING — keep polling
      } else {
        this.finalizePollsLeft = 0;
        status = 1; // FT_PROCESSED — done
      }
    }

    const reply = buildFtStatReply(this.address, parsed.ctrl.sequence, this.useCRC, status, 5);
    // Hand the reply to the uploader via its serial-port data path
    this._uploader._onData(reply);
  }

  getAssembled() { return Buffer.concat(this.receivedFragments); }
}

// --- Drive the test --------------------------------------------------------

(async () => {
  const fileBuffer = Buffer.alloc(2500);
  for (let i = 0; i < fileBuffer.length; i++) fileBuffer[i] = (i * 37 + 11) & 0xFF;

  const uploader = new OSDPFirmwareUploader({
    portPath: '/dev/null', address: 0x01, useCRC: true, fragmentSize: 110,
  });

  const mock = new MockReader({ address: 0x01, useCRC: true, finalizePollCount: 3 });
  mock.attach(uploader);
  uploader.port = mock;                         // skip real open()

  const progress = [];
  const statuses = [];
  uploader.on('progress', p => progress.push(p));
  uploader.on('status',   s => statuses.push(s));

  const result = await uploader.transferFile(fileBuffer);

  // Verify reader assembled the file byte-perfect
  const assembled = mock.getAssembled();
  console.assert(assembled.length === fileBuffer.length, `length mismatch ${assembled.length} vs ${fileBuffer.length}`);
  console.assert(assembled.equals(fileBuffer), 'reassembled file differs from source');
  console.log('TEST PASS  Reader assembled file byte-perfect');

  // Verify fragment count
  const expectedFragments = Math.ceil(fileBuffer.length / 110);
  console.assert(result.fragments === expectedFragments, `fragment count: got ${result.fragments} expected ${expectedFragments}`);
  console.log(`TEST PASS  Sent expected fragment count: ${result.fragments}`);

  // Verify finalization
  console.assert(result.finalStatus === 1 /* FT_PROCESSED */, `finalStatus should be 1, got ${result.finalStatus}`);
  console.log('TEST PASS  Finalized with FT_PROCESSED');

  // Verify progress events
  const transferProgress = progress.filter(p => p.phase === 'transfer');
  const finalizeProgress = progress.filter(p => p.phase === 'finalize');
  console.assert(transferProgress.length === expectedFragments, `transfer progress events: ${transferProgress.length}`);
  console.assert(finalizeProgress.length >= 1, 'should have at least one finalize progress event');
  console.assert(transferProgress[transferProgress.length - 1].percent === 100, 'final transfer percent should be 100');
  console.log(`TEST PASS  Emitted ${transferProgress.length} transfer + ${finalizeProgress.length} finalize progress events`);

  // Verify success status emitted
  const successMsg = statuses.find(s => s.level === 'success');
  console.assert(successMsg, 'should have emitted a success status');
  console.log(`TEST PASS  Emitted success status: "${successMsg.message}"`);

  console.log('\nFull happy-path end-to-end test passed.');
})().catch(e => {
  console.error('END-TO-END TEST FAILED:', e.message);
  console.error(e.stack);
  process.exit(1);
});
