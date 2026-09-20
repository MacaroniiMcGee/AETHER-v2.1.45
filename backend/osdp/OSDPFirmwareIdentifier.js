// osdp/OSDPFirmwareIdentifier.js
//
// Queries a reader for its identity (osdp_ID → osdp_PDID reply) and
// capabilities (osdp_CAP → osdp_PDCAP reply). Returns a structured object
// the UI can display before the user commits to a firmware push.
//
// PDID layout (per OSDP v2.2 §6.2.10):
//   bytes 0..2   vendor code (24-bit, MSB first)
//   byte 3       model
//   byte 4       version
//   bytes 5..8   serial (32-bit, MSB first)
//   bytes 9..11  firmware version (major.minor.build)
//
// PDCAP returns a list of {function-code, compliance-level, num-instances}
// triples — we walk those and surface the ones the wizard cares about
// (FILETRANSFER support, communication security support, etc.).

const OSDPCpBase = require('./OSDPCpBase');

const CMD_POLL  = 0x60;     // osdp_POLL  (used for re-sync before queries)
const CMD_ID    = 0x61;     // osdp_ID
const CMD_CAP   = 0x62;     // osdp_CAP
const REPLY_PDID  = 0x45;
const REPLY_PDCAP = 0x46;

// Capability function codes we care about (subset; OSDP defines many more).
const CAP = {
  CONTACT_STATUS_MONITORING:   1,
  OUTPUT_CONTROL:              2,
  CARD_DATA_FORMAT:            3,
  READER_LED_CONTROL:          4,
  READER_AUDIBLE_OUTPUT:       5,
  READER_TEXT_OUTPUT:          6,
  TIME_KEEPING:                7,
  CHECK_CHARACTER_SUPPORT:     8,
  COMMUNICATION_SECURITY:      9,  // 1=AES-128, 2=secure channel default
  RECEIVE_BUFFERSIZE:         10,
  LARGEST_COMBINED_MSG_SIZE:  11,
  SMARTCARD_SUPPORT:          12,
  READERS:                    13,
  BIOMETRICS:                 14,
  SECURE_PIN_ENTRY_SUPPORT:   15,
  OSDP_VERSION:               16,
  CARDHOLDER_AUTHENTICATION:  17,
  KEY_RETRIEVAL:              18,
  AUDIT_REPORT_SUPPORT:       19,
  FILE_TRANSFER:              22,
};

class OSDPFirmwareIdentifier extends OSDPCpBase {
  constructor(opts = {}) {
    super({ replyTimeout: 2000, ...opts });
  }

  /**
   * One-shot identify: re-sync the link with a POLL, then send osdp_ID and
   * parse PDID, then osdp_CAP and parse PDCAP. Caller is responsible for
   * open()/close() around this — typical usage is inside the route handler
   * that releases the port from OSDPManager first.
   *
   * Note on the leading POLL: many PDs (WaveLynx readers among them)
   * interpret a seq=0 packet as a pure re-sync control message and ignore
   * the embedded command, replying with only an ACK. Sending osdp_ID
   * straight away as the seq=0 packet therefore loses the actual query.
   * A leading POLL absorbs the re-sync, after which osdp_ID rides seq=1
   * and the PDID reply comes back as expected.
   *
   * @returns {Promise<{...}>}  see field list below
   */
  async identify() {
    // 1. Re-sync POLL → ACK
    await this.sendAndAwait(CMD_POLL, null, null, { timeoutMs: 1500 });

    // 2. Try osdp_ID. Some readers don't implement it and reply with bare
    //    ACK. Treat that as "reader alive, identity unavailable" rather than
    //    a hard failure — the user can still attempt FILETRANSFER, which is
    //    a separate capability.
    let id, pdidUnavailable = false, unavailableReason = null;
    try {
      const pdidReply = await this.sendAndAwait(CMD_ID, Buffer.from([0x00]), REPLY_PDID);
      id = this._parsePDID(pdidReply.data);
    } catch (e) {
      if (/Unexpected reply 0x40/.test(e.message)) {
        pdidUnavailable = true;
        unavailableReason = 'Reader returned ACK instead of PDID — osdp_ID not implemented by this PD';
      } else if (/Reader sent NAK \(code 0x03\)/.test(e.message)) {
        pdidUnavailable = true;
        unavailableReason = 'Reader NAKed osdp_ID with "unknown command" (NAK 0x03)';
      } else {
        throw e;
      }
    }

    // 3. Try osdp_CAP. If osdp_ID failed it probably will too, but worth trying —
    //    some readers implement one but not the other.
    let caps = [], capsUnavailable = false;
    try {
      const capReply = await this.sendAndAwait(CMD_CAP, Buffer.from([0x00]), REPLY_PDCAP);
      caps = this._parsePDCAP(capReply.data);
    } catch (e) {
      if (/Unexpected reply 0x40|Reader sent NAK \(code 0x03\)/.test(e.message)) {
        capsUnavailable = true;
      } else {
        throw e;
      }
    }

    const ftCap = caps.find(c => c.code === CAP.FILE_TRANSFER);
    const secCap = caps.find(c => c.code === CAP.COMMUNICATION_SECURITY);
    const rxBufCap = caps.find(c => c.code === CAP.RECEIVE_BUFFERSIZE);

    // Build the result. When identity is unavailable we still return a
    // success-ish record (the reader IS confirmed alive) but flag what's
    // missing so the UI can warn the user.
    const result = {
      identityAvailable:     !pdidUnavailable,
      capabilitiesAvailable: !capsUnavailable,
      unavailableReason,

      // PDID fields — null when unavailable
      vendorCode:      id ? id.vendorCode : null,
      vendorName:      id ? id.vendorName : null,
      modelNumber:     id ? id.modelNumber : null,
      modelVersion:    id ? id.modelVersion : null,
      serialNumber:    id ? id.serialNumber : null,
      serialHex:       id ? id.serialHex : null,
      firmwareVersion: id ? id.firmwareVersion : null,
      firmwareString:  id ? id.firmwareString : null,

      // PDCAP fields
      capabilities:          caps,
      supportsFiletransfer:  capsUnavailable ? null : !!(ftCap && ftCap.level > 0),
      supportsSecureChannel: capsUnavailable ? null : !!(secCap && secCap.level > 0),
      maxReceiveBufferSize:  rxBufCap ? (rxBufCap.level | (rxBufCap.numItems << 8)) : null,
    };

    return result;
  }

  _parsePDID(data) {
    if (!data || data.length < 12) {
      throw new Error(`PDID payload too short (${data ? data.length : 0} bytes, expected ≥12)`);
    }
    // Vendor code is 3 bytes, MSB first
    const vendorCode = (data[0] << 16) | (data[1] << 8) | data[2];
    const modelNumber = data[3];
    const modelVersion = data[4];
    // Serial is 4 bytes, MSB first
    const serialNumber = ((data[5] << 24) | (data[6] << 16) | (data[7] << 8) | data[8]) >>> 0;
    const fwMajor = data[9];
    const fwMinor = data[10];
    const fwBuild = data[11];

    const serialHex = data.slice(5, 9).toString('hex').toUpperCase();
    const firmwareString = `${fwMajor}.${fwMinor}.${fwBuild}`;

    return {
      vendorCode,
      vendorName: VENDOR_NAMES[vendorCode] || `0x${vendorCode.toString(16).padStart(6,'0').toUpperCase()}`,
      modelNumber,
      modelVersion,
      serialNumber,
      serialHex,
      firmwareVersion: { major: fwMajor, minor: fwMinor, build: fwBuild },
      firmwareString,
    };
  }

  _parsePDCAP(data) {
    if (!data) return [];
    const caps = [];
    for (let i = 0; i + 2 < data.length; i += 3) {
      const code = data[i];
      const level = data[i + 1];
      const numItems = data[i + 2];
      if (code === 0) continue;     // padding / sentinel
      caps.push({
        code, level, numItems,
        name: CAP_NAMES[code] || `unknown-${code}`,
      });
    }
    return caps;
  }
}

// Friendly names for OSDP vendor codes seen in the wild. List can grow.
const VENDOR_NAMES = {
  0x00005C: 'WaveLynx',
  0x0000B6: 'HID Global',
  0x00006A: 'Mercury Security',
  0x0000A2: 'Allegion',
  0x000049: 'Idesco',
  0x0000F0: 'Suprema',
  0x000071: 'Schneider Electric',
};

const CAP_NAMES = Object.fromEntries(
  Object.entries(CAP).map(([k, v]) => [v, k.toLowerCase().replace(/_/g, '-')])
);

OSDPFirmwareIdentifier.CAP        = CAP;
OSDPFirmwareIdentifier.VENDOR_NAMES = VENDOR_NAMES;

module.exports = OSDPFirmwareIdentifier;
