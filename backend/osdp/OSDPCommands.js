// OSDPCommands-fixed.js - OSDP Command/Reply helpers
// FIXED VERSION - Correct function codes per OSDP v2.2.2 Annex B

class OSDPCommands {
  constructor(opts = {}) {
    this.vendorCode = opts.vendorCode || Buffer.from([0x00, 0x17, 0x66]); // IEEE MA-L
    this.modelNumber = opts.modelNumber ?? 0x01;
    this.version = opts.version ?? 0x01;
    this.serialNumber = opts.serialNumber ?? 0x12345678;
    this.firmwareMajor = opts.firmwareMajor ?? 1;
    this.firmwareMinor = opts.firmwareMinor ?? 0;
    this.firmwareBuild = opts.firmwareBuild ?? 0;
    this.numInputs = opts.numInputs ?? 0;
    this.numOutputs = opts.numOutputs ?? 2;
    this.numLEDs = opts.numLEDs ?? 2;
    this.numReaders = opts.numReaders ?? 1;
    this.rxBufferSize = opts.rxBufferSize ?? 128;
    this.maxMessageSize = opts.maxMessageSize ?? 256;
  }

  /**
   * Build PDID response per Section 7.4
   * 
   * Structure:
   * - Vendor Code: 3 bytes (IEEE MA-L)
   * - Model Number: 1 byte
   * - Version: 1 byte
   * - Serial Number: 4 bytes (little-endian)
   * - Firmware Major: 1 byte
   * - Firmware Minor: 1 byte
   * - Firmware Build: 1 byte
   * 
   * Total: 12 bytes
   * 
   * NOTE: cUID is the first 8 bytes of this response!
   */
  buildPDID() {
    const serial = Buffer.alloc(4);
    serial.writeUInt32LE(this.serialNumber >>> 0, 0);
    
    const fw = Buffer.from([
      this.firmwareMajor & 0xFF,
      this.firmwareMinor & 0xFF,
      this.firmwareBuild & 0xFF
    ]);
    
    return Buffer.concat([
      this.vendorCode,                              // 3 bytes
      Buffer.from([this.modelNumber & 0xFF]),       // 1 byte
      Buffer.from([this.version & 0xFF]),           // 1 byte
      serial,                                       // 4 bytes (LE)
      fw                                            // 3 bytes
    ]);
  }

  /**
   * Extract cUID from PDID per Section 7.4
   * 
   * "The 'cUID', used in certain Secure Channel operations, 
   * is the first 8 bytes of the PDID response."
   */
  buildCUID() {
    const pdid = this.buildPDID();
    return pdid.slice(0, 8);
  }

  /**
   * Build PDCAP response per Section 7.5 and Annex B
   * 
   * Each capability is a 3-byte record:
   * - Function Code: 1 byte
   * - Compliance Level: 1 byte
   * - Number/Count: 1 byte
   * 
   * CRITICAL: Function codes must match Annex B!
   */
  buildPDCAP() {
    const caps = [];

    // Function Code 1 (0x01) - Contact Status Monitoring (B.2)
    // Compliance: 0x00 = not supported
    caps.push(0x01, 0x00, this.numInputs & 0xFF);

    // Function Code 2 (0x02) - Output Control (B.3)
    // Compliance: 0x01 = direct control
    caps.push(0x02, 0x01, this.numOutputs & 0xFF);

    // Function Code 3 (0x03) - Card Data Format (B.4)
    // Compliance: 0x01 = raw bit array
    caps.push(0x03, 0x01, 0x00);

    // Function Code 4 (0x04) - Reader LED Control (B.5)
    // Compliance: 0x02 = timed commands
    caps.push(0x04, 0x02, this.numLEDs & 0xFF);

    // Function Code 5 (0x05) - Reader Audible Output (B.6)
    // Compliance: 0x02 = timed commands
    caps.push(0x05, 0x02, 0x01);

    // Function Code 6 (0x06) - Reader Text Output (B.7)
    // Compliance: 0x00 = not supported (no display)
    caps.push(0x06, 0x00, 0x00);

    // Function Code 7 (0x07) - Time Keeping (B.8) - DEPRECATED
    // Skip or set to 0

    // Function Code 8 (0x08) - Check Character Support (B.9)
    // Compliance: 0x01 = CRC-16 supported
    // Number: 0x00
    caps.push(0x08, 0x01, 0x00);

    // Function Code 9 (0x09) - Communication Security (B.10)
    // THIS IS CRITICAL FOR SECURE CHANNEL!
    // Compliance: bit 0 = AES128 support
    // Number: bit 0 = AES128 key exchange
    caps.push(0x09, 0x01, 0x01);

    // Function Code 10 (0x0A) - Receive Buffer Size (B.11)
    // Compliance: LSB of buffer size
    // Number: MSB of buffer size
    caps.push(0x0A, this.rxBufferSize & 0xFF, (this.rxBufferSize >> 8) & 0xFF);

    // Function Code 11 (0x0B) - Largest Combined Message Size (B.12)
    // For multi-part messages
    // Compliance: LSB of size
    // Number: MSB of size
    caps.push(0x0B, this.maxMessageSize & 0xFF, (this.maxMessageSize >> 8) & 0xFF);

    // Function Code 12 (0x0C) - Smart Card Support (B.13)
    // Compliance: bit 0 = transparent mode, bit 1 = extended packet
    // Number: 0x00
    caps.push(0x0C, 0x00, 0x00);

    // Function Code 13 (0x0D) - Readers (B.14)
    // Compliance: 0x00
    // Number: number of readers
    caps.push(0x0D, 0x00, this.numReaders & 0xFF);

    // Function Code 14 (0x0E) - Biometrics (B.15)
    // Compliance: 0x00 = not supported
    caps.push(0x0E, 0x00, 0x00);

    // Function Code 15 (0x0F) - Secure PIN Entry (B.16)
    // Compliance: 0x00 = not supported
    caps.push(0x0F, 0x00, 0x00);

    // Function Code 16 (0x10) - OSDP Version (B.17)
    // Compliance: 0x04 = OSDP 2.2.2
    // Number: 0x00
    caps.push(0x10, 0x04, 0x00);

    return Buffer.from(caps);
  }

  /**
   * Build NAK response per Section 7.3
   */
  buildNAK(errorCode, additionalData = null) {
    if (additionalData) {
      return Buffer.concat([
        Buffer.from([errorCode & 0xFF]),
        additionalData
      ]);
    }
    return Buffer.from([errorCode & 0xFF]);
  }

  /**
   * Error codes per Table 47
   */
  static NAK_ERRORS = {
    NO_ERROR: 0x00,
    MESSAGE_CHECK_ERROR: 0x01,      // Bad checksum/CRC
    COMMAND_LENGTH_ERROR: 0x02,
    UNKNOWN_COMMAND: 0x03,
    UNEXPECTED_SEQUENCE: 0x04,
    UNSUPPORTED_SECURITY_BLOCK: 0x05,
    ENCRYPTED_REQUIRED: 0x06,
    BIO_TYPE_NOT_SUPPORTED: 0x07,
    BIO_FORMAT_NOT_SUPPORTED: 0x08,
    UNABLE_TO_PROCESS_RECORD: 0x09
  };
}

module.exports = OSDPCommands;
