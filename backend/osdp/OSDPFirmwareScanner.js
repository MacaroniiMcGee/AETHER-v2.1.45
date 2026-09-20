// osdp/OSDPFirmwareScanner.js
//
// Sweeps a serial port across an OSDP address range, sending POLL (0x60) to
// each address and recording which addresses replied. Used by the firmware
// wizard's "scan a port" step to discover physical readers without having to
// pre-configure them in osdp-config.json.
//
// Usage:
//   const scanner = new OSDPFirmwareScanner({ portPath: '/dev/ttyACM0', baudRate: 9600 });
//   await scanner.open();
//   const results = await scanner.scan({ fromAddr: 0, toAddr: 15 });
//   await scanner.close();
//
//   // results: [
//   //   { address: 0,  replied: true,  replyCode: 0x40, replyName: 'osdp_ACK', raw: '...' },
//   //   { address: 1,  replied: false, error: 'Reply timeout (>800ms)...' },
//   //   ...
//   // ]

const OSDPCpBase = require('./OSDPCpBase');

const CMD_POLL = 0x60;

// Short per-address timeout — a real PD answers within ~100ms; the rest is
// just a safety margin. 800ms × 127 addresses = ~1.7 minutes worst case for
// a full sweep, which is fine.
const PER_ADDRESS_TIMEOUT_MS = 800;

// Map of common reply codes → friendly names for the UI to display.
const REPLY_NAMES = {
  0x40: 'osdp_ACK',
  0x41: 'osdp_NAK',
  0x45: 'osdp_PDID',
  0x46: 'osdp_PDCAP',
  0x48: 'osdp_LSTATR',
  0x49: 'osdp_ISTATR',
  0x4A: 'osdp_OSTATR',
  0x4B: 'osdp_RSTATR',
  0x50: 'osdp_RAW',
  0x51: 'osdp_FMT',
  0x53: 'osdp_KEYPAD',
  0x76: 'osdp_RMAC_I',
  0x78: 'osdp_CCRYPT',
  0x79: 'osdp_BUSY',
  0x7A: 'osdp_FTSTAT',
};

class OSDPFirmwareScanner extends OSDPCpBase {
  constructor(opts = {}) {
    super({ replyTimeout: PER_ADDRESS_TIMEOUT_MS, ...opts });
  }

  /**
   * Sweep the address range, emitting `address` events per probe.
   *
   * @param {Object}  opts
   * @param {number}  [opts.fromAddr=0]    First address to probe (inclusive)
   * @param {number}  [opts.toAddr=15]     Last address to probe (inclusive). Max 126.
   * @param {number}  [opts.timeoutMs]     Override per-address timeout
   * @returns {Promise<Array<{address, replied, replyCode?, replyName?, raw?, error?}>>}
   */
  async scan({ fromAddr = 0, toAddr = 15, timeoutMs } = {}) {
    if (fromAddr < 0 || fromAddr > 0x7E) throw new Error(`fromAddr out of range: ${fromAddr}`);
    if (toAddr   < 0 || toAddr   > 0x7E) throw new Error(`toAddr out of range: ${toAddr}`);
    if (toAddr < fromAddr)               throw new Error(`toAddr < fromAddr`);

    const results = [];

    for (let addr = fromAddr; addr <= toAddr; addr++) {
      this.setAddress(addr);

      const startedAt = Date.now();
      let row;
      try {
        const reply = await this.sendAndAwait(CMD_POLL, null, null, { timeoutMs });
        // Got *something* back. The reply code may or may not be ACK — record whatever it is.
        row = {
          address:   addr,
          replied:   true,
          replyCode: reply.command,
          replyName: REPLY_NAMES[reply.command] || `unknown 0x${reply.command.toString(16).padStart(2,'0')}`,
          raw:       reply.raw ? reply.raw.toString('hex') : undefined,
          durationMs: Date.now() - startedAt,
        };
      } catch (e) {
        row = {
          address:    addr,
          replied:    false,
          error:      e.message,
          durationMs: Date.now() - startedAt,
        };
      }

      results.push(row);
      this.emit('address', row);
    }

    return results;
  }
}

OSDPFirmwareScanner.REPLY_NAMES = REPLY_NAMES;

module.exports = OSDPFirmwareScanner;
