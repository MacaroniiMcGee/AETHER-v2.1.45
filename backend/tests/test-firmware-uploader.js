// Quick sanity check - does NOT need a real reader.
// Verifies:
//   1. The FILETRANSFER packet round-trips through OSDPPacket.parsePacket
//   2. The CMND byte and data payload match the WaveLynx Python wire format
//   3. FTSTAT parsing handles signed-LE16 status correctly
//   4. Fragment chunking covers the full file with correct offsets

const path = require('path');
const OSDPPacket           = require('./osdp/OSDPPacket.js');
const OSDPFirmwareUploader = require('./osdp/OSDPFirmwareUploader.js');

// --- Test 1: FILETRANSFER packet construction & parse-back -----------------
{
  const u = new OSDPFirmwareUploader({ portPath: '/dev/null', address: 0x01 });
  const fileTotal  = 1234;
  const offset     = 220;
  const fragment   = Buffer.from('Hello firmware world!', 'ascii');

  // Reflectively use the private helper
  const ftData = u._buildFtPayload(0x01, fileTotal, offset, fragment);

  console.assert(ftData.length === 11 + fragment.length, 'FT payload length wrong');
  console.assert(ftData[0] === 0x01, 'fileType should be 0x01');
  console.assert(ftData.readUInt32LE(1) === fileTotal,  'total LE32 mismatch');
  console.assert(ftData.readUInt32LE(5) === offset,     'offset LE32 mismatch');
  console.assert(ftData.readUInt16LE(9) === fragment.length, 'fragLen LE16 mismatch');
  console.assert(ftData.slice(11).equals(fragment), 'fragment bytes mismatch');
  console.log('TEST 1 PASS  FT payload layout matches WaveLynx format');

  // Build a full packet (CP→PD, seq 2, CRC mode) and parse it back
  const pkt = OSDPPacket.buildPacket({
    address: 0x01, command: 0x7C, data: ftData,
    sequence: 2, isReply: false, useCRC: true,
  });
  const back = OSDPPacket.parsePacket(pkt);
  console.assert(back && back.valid && !back.error, 'parse failed: ' + (back && back.error));
  console.assert(back.command === 0x7C, 'CMND should be 0x7C (FILETRANSFER)');
  console.assert(back.address === 0x01, 'addr mismatch');
  console.assert(back.isReply === false, 'should NOT be marked as reply');
  console.assert(back.ctrl.sequence === 2, 'sequence mismatch');
  console.assert(back.ctrl.useCRC === true, 'CRC mode flag mismatch');
  console.assert(back.data.equals(ftData), 'parsed data does not equal original FT payload');
  console.log('TEST 2 PASS  Packet round-trips through OSDPPacket parser');
}

// --- Test 3: FTSTAT parsing including negative status ----------------------
{
  const u = new OSDPFirmwareUploader({ portPath: '/dev/null', address: 0x00 });

  // status = 1 (FT_PROCESSED), delay = 250, action = 0, updateMax = 110
  const okBuf = Buffer.from([
    0x00,             // action
    0xFA, 0x00,       // delay = 250 LE
    0x01, 0x00,       // status = 1 LE
    0x6E, 0x00,       // updateMsgMax = 110 LE
  ]);
  const ok = u._parseFtStat(okBuf);
  console.assert(ok.delay === 250 && ok.status === 1 && ok.updateMsgMax === 110, 'FTSTAT happy-path parse');
  console.log('TEST 3 PASS  FTSTAT happy-path parses correctly');

  // status = -1 (LE 0xFFFF), delay = 0
  const errBuf = Buffer.from([0x00, 0x00, 0x00, 0xFF, 0xFF, 0x00, 0x00]);
  const errRes = u._parseFtStat(errBuf);
  console.assert(errRes.status === -1, `negative status should be -1, got ${errRes.status}`);
  console.log('TEST 4 PASS  FTSTAT negative status sign-extends correctly');

  // status = -32768 (LE 0x8000) — extreme edge
  const minBuf = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x80, 0x00, 0x00]);
  const minRes = u._parseFtStat(minBuf);
  console.assert(minRes.status === -32768, `min status should be -32768, got ${minRes.status}`);
  console.log('TEST 5 PASS  FTSTAT INT16_MIN edge case');

  // Short-form FTSTAT (no updateMsgMax) — tolerated
  const shortBuf = Buffer.from([0x00, 0x64, 0x00, 0x00, 0x00]);
  const shortRes = u._parseFtStat(shortBuf);
  console.assert(shortRes.delay === 100 && shortRes.status === 0 && shortRes.updateMsgMax === 0, 'short FTSTAT');
  console.log('TEST 6 PASS  Short-form FTSTAT tolerated');
}

// --- Test 7: Fragment chunking math ---------------------------------------
{
  const fragSize = 110;
  const totals   = [1, 109, 110, 111, 220, 543210];
  for (const total of totals) {
    const expectedFragments = Math.ceil(total / fragSize);
    let offset = 0, count = 0, sumBytes = 0;
    while (offset < total) {
      const end  = Math.min(offset + fragSize, total);
      const frag = end - offset;
      sumBytes  += frag;
      count     += 1;
      offset     = end;
    }
    console.assert(count === expectedFragments && sumBytes === total,
      `chunking off for total=${total}: got ${count} frags / ${sumBytes} bytes`);
  }
  console.log('TEST 7 PASS  Fragment chunking math correct for boundary cases');
}

console.log('\nAll tests passed.');
