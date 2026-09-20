/**
 * OSDPPacket.js - OSDP v2.2.2 Packet Builder and Parser
 * 
 * Handles:
 * - Packet formatting per Section 5.9
 * - CTRL byte with sequence numbers (Section 5.9, Table 2)
 * - Security Control Block (SCB) support
 * - CRC-16 calculation (Annex C)
 * - Message validation
 */

class OSDPPacket {
  // Packet constants
  static SOM = 0x53;
  static BROADCAST_ADDR = 0x7F;
  static REPLY_FLAG = 0x80;
  
  // CTRL byte masks (Table 2)
  static CTRL_SQN_MASK = 0x03;      // Bits 0-1: Sequence number
  static CTRL_CRC_MODE = 0x04;      // Bit 2: 1=CRC-16, 0=checksum
  static CTRL_SCB = 0x08;           // Bit 3: Security Control Block present
  static CTRL_RESERVED = 0xF0;      // Bits 4-7: Must be 0
  
  // CRC-16-CCITT polynomial
  static CRC_POLY = 0x1021;
  static crcTable = null;

  /**
   * Initialize CRC table for fast lookup
   */
  static initCrcTable() {
    if (this.crcTable) return;
    
    this.crcTable = new Uint16Array(256);
    for (let i = 0; i < 256; i++) {
      let crc = i << 8;
      for (let j = 0; j < 8; j++) {
        if (crc & 0x8000) {
          crc = (crc << 1) ^ this.CRC_POLY;
        } else {
          crc = crc << 1;
        }
      }
      this.crcTable[i] = crc & 0xFFFF;
    }
  }

  /**
   * Calculate CRC-16 for buffer
   * @param {Buffer} data - Data to calculate CRC for
   * @returns {number} - 16-bit CRC value
   */
  static calculateCRC(data) {
    this.initCrcTable();
    
    let crc = 0x1D0F; // Initial value per spec
    
    for (let i = 0; i < data.length; i++) {
      const byte = data[i];
      crc = ((crc << 8) ^ this.crcTable[((crc >> 8) ^ byte) & 0xFF]) & 0xFFFF;
    }
    
    return crc;
  }

  /**
   * Calculate 8-bit checksum
   * @param {Buffer} data - Data to calculate checksum for
   * @returns {number} - 8-bit checksum value
   */
  static calculateChecksum(data) {
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      sum += data[i];
    }
    return (-sum) & 0xFF; // Two's complement, 8 bits
  }

  /**
   * Build CTRL byte
   * @param {number} sequence - Sequence number (0-3)
   * @param {boolean} useCRC - Use CRC-16 instead of checksum
   * @param {boolean} hasSecurityBlock - Security block present
   * @returns {number} - CTRL byte value
   */
  static buildControlByte(sequence, useCRC = true, hasSecurityBlock = false) {
    let ctrl = sequence & this.CTRL_SQN_MASK;
    
    if (useCRC) {
      ctrl |= this.CTRL_CRC_MODE;
    }
    
    if (hasSecurityBlock) {
      ctrl |= this.CTRL_SCB;
    }
    
    // Reserved bits must be 0
    ctrl &= ~this.CTRL_RESERVED;
    
    return ctrl;
  }

  /**
   * Parse CTRL byte
   * @param {number} ctrl - CTRL byte value
   * @returns {Object} - Parsed control information
   */
  static parseControlByte(ctrl) {
    return {
      raw: ctrl,  // Store raw byte for MAC computation
      sequence: ctrl & this.CTRL_SQN_MASK,
      useCRC: !!(ctrl & this.CTRL_CRC_MODE),
      hasSecurityBlock: !!(ctrl & this.CTRL_SCB),
      reserved: (ctrl & this.CTRL_RESERVED) >> 4
    };
  }

  /**
   * Build OSDP packet
   * @param {Object} params - Packet parameters
   * @param {number} params.address - PD address (0-126, 127=broadcast)
   * @param {number} params.command - Command/reply code
   * @param {Buffer} params.data - Command/reply data
   * @param {number} params.sequence - Sequence number (0-3)
   * @param {boolean} params.isReply - Is this a reply packet
   * @param {boolean} params.useCRC - Use CRC-16 (default: true)
   * @param {Object} params.securityBlock - Optional security block
   * @param {Buffer} params.mac - Optional MAC (4 bytes for SCS_15-18)
   * @returns {Buffer} - Complete OSDP packet
   */
  static buildPacket({
    address,
    command,
    data = Buffer.alloc(0),
    sequence = 1,
    isReply = false,
    useCRC = true,
    securityBlock = null,
    mac = null
  }) {
    // Validate inputs
    if (address < 0 || address > 127) {
      throw new Error(`Invalid address: ${address} (must be 0-127)`);
    }
    
    if (sequence < 0 || sequence > 3) {
      throw new Error(`Invalid sequence: ${sequence} (must be 0-3)`);
    }
    
    // Calculate packet size
    let packetSize = 6; // SOM(1) + ADDR(1) + LEN(2) + CTRL(1) + CMND(1)
    packetSize += data.length;
    
    if (securityBlock) {
      packetSize += 2; // SEC_BLK_LEN(1) + SEC_BLK_TYPE(1)
      packetSize += securityBlock.data ? securityBlock.data.length : 0;
    }
    
    if (mac) {
      packetSize += 4; // MAC is 4 bytes for SCS_15-18
    }
    
    packetSize += useCRC ? 2 : 1; // CRC(2) or CKSUM(1)
    
    // Build packet buffer
    const packet = Buffer.alloc(packetSize);
    let offset = 0;
    
    // SOM
    packet[offset++] = this.SOM;
    
    // ADDR (set reply flag if needed)
    let addr = address & 0x7F;
    if (isReply) {
      addr |= this.REPLY_FLAG;
    }
    packet[offset++] = addr;
    
    // LEN (LSB first - little endian)
    packet.writeUInt16LE(packetSize, offset);
    offset += 2;
    
    // CTRL
    const ctrl = this.buildControlByte(
      sequence,
      useCRC,
      securityBlock !== null
    );
    packet[offset++] = ctrl;
    
    // Security Block (if present)
    if (securityBlock) {
      const secDataLen = securityBlock.data ? securityBlock.data.length : 0;
      packet[offset++] = 2 + secDataLen; // SEC_BLK_LEN (includes type and length bytes)
      packet[offset++] = securityBlock.type; // SEC_BLK_TYPE
      
      if (securityBlock.data) {
        securityBlock.data.copy(packet, offset);
        offset += securityBlock.data.length;
      }
    }
    
    // CMND/REPLY
    packet[offset++] = command;
    
    // DATA
    if (data.length > 0) {
      data.copy(packet, offset);
      offset += data.length;
    }
    
    // MAC (if present) - goes before CRC/checksum
    if (mac) {
      if (mac.length !== 4) {
        throw new Error(`MAC must be 4 bytes, got ${mac.length}`);
      }
      mac.copy(packet, offset);
      offset += 4;
    }
    
    // CRC or Checksum (calculated on everything except CRC/checksum itself)
    const dataForCheck = packet.slice(0, offset);
    
    if (useCRC) {
      const crc = this.calculateCRC(dataForCheck);
      packet.writeUInt16LE(crc, offset);
    } else {
      const checksum = this.calculateChecksum(dataForCheck);
      packet[offset] = checksum;
    }
    
    return packet;
  }

  /**
   * Parse OSDP packet
   * @param {Buffer} buffer - Raw packet buffer
   * @returns {Object} - Parsed packet or null if invalid
   */
  static parsePacket(buffer) {
    if (!buffer || buffer.length < 6) {
      return { error: 'Packet too short', code: 0x02 };
    }
    
    // Check SOM
    if (buffer[0] !== this.SOM) {
      return { error: 'Invalid SOM', code: 0x02 };
    }
    
    // Parse header
    const address = buffer[1] & 0x7F;
    const isReply = !!(buffer[1] & this.REPLY_FLAG);
    const length = buffer.readUInt16LE(2);
    
    // Verify length
    if (length !== buffer.length) {
      return { error: `Length mismatch: expected ${length}, got ${buffer.length}`, code: 0x02 };
    }
    
    // Parse CTRL
    const ctrlByte = buffer[4];
    const ctrl = this.parseControlByte(ctrlByte);
    
    let offset = 5;
    let securityBlock = null;
    
    // Parse Security Block (if present)
    if (ctrl.hasSecurityBlock) {
      if (offset >= buffer.length - 1) {
        return { error: 'Invalid security block', code: 0x05 };
      }
      
      const secLen = buffer[offset++];
      const secType = buffer[offset++];
      const secDataLen = secLen - 2;
      
      if (offset + secDataLen > buffer.length) {
        return { error: 'Security block data exceeds packet', code: 0x05 };
      }
      
      securityBlock = {
        length: secLen,
        type: secType,
        data: secDataLen > 0 ? buffer.slice(offset, offset + secDataLen) : null
      };
      
      offset += secDataLen;
    }
    
    // Parse command/reply
    if (offset >= buffer.length) {
      return { error: 'No command byte', code: 0x02 };
    }
    
    const command = buffer[offset++];
    
    // Calculate where MAC and CRC/checksum are
    const checkSize = ctrl.useCRC ? 2 : 1;
    let macSize = 0;
    let mac = null;
    
    // Check if this is a secure message with MAC (SCS_15-18)
    if (securityBlock && securityBlock.type >= 0x15 && securityBlock.type <= 0x18) {
      macSize = 4;
    }
    
    // Extract data (everything between command and MAC/CRC)
    const dataEnd = buffer.length - checkSize - macSize;
    const data = offset < dataEnd ? buffer.slice(offset, dataEnd) : Buffer.alloc(0);
    
    // Extract MAC if present
    if (macSize > 0) {
      mac = buffer.slice(dataEnd, dataEnd + macSize);
    }
    
    // Verify CRC/Checksum
    const dataForCheck = buffer.slice(0, buffer.length - checkSize);
    
    if (ctrl.useCRC) {
      const expectedCrc = this.calculateCRC(dataForCheck);
      const actualCrc = buffer.readUInt16LE(buffer.length - 2);
      
      if (expectedCrc !== actualCrc) {
        return { error: `CRC mismatch: expected 0x${expectedCrc.toString(16)}, got 0x${actualCrc.toString(16)}`, code: 0x01 };
      }
    } else {
      const expectedChecksum = this.calculateChecksum(dataForCheck);
      const actualChecksum = buffer[buffer.length - 1];
      
      if (expectedChecksum !== actualChecksum) {
        return { error: `Checksum mismatch: expected 0x${expectedChecksum.toString(16)}, got 0x${actualChecksum.toString(16)}`, code: 0x01 };
      }
    }
    
    // Return parsed packet
    // Store raw bytes for MAC verification (everything except MAC and CRC)
    const macInputEnd = buffer.length - checkSize - macSize;
    const macInputBytes = buffer.slice(0, macInputEnd);
    
    return {
      address,
      isReply,
      length,
      ctrl,
      securityBlock,
      command,
      data,
      mac,
      macInputBytes,  // Raw bytes for MAC verification
      valid: true
    };
  }

  /**
   * Format packet for logging
   * @param {Buffer} packet - Packet buffer
   * @returns {string} - Formatted packet string
   */
  static formatPacket(packet) {
    if (!packet || packet.length === 0) {
      return '(empty)';
    }
    
    const hex = packet.toString('hex').toUpperCase();
    const parts = [];
    
    for (let i = 0; i < hex.length; i += 2) {
      parts.push(hex.substr(i, 2));
    }
    
    return parts.join(' ');
  }

  /**
   * Build NAK reply
   * @param {number} address - PD address
   * @param {number} errorCode - NAK error code (Table 47)
   * @param {number} sequence - Sequence number
   * @returns {Buffer} - NAK packet
   */
  static buildNAK(address, errorCode, sequence = 0) {
    return this.buildPacket({
      address,
      command: 0x41, // osdp_NAK
      data: Buffer.from([errorCode]),
      sequence,
      isReply: true
    });
  }

  /**
   * Build ACK reply
   * @param {number} address - PD address
   * @param {number} sequence - Sequence number
   * @returns {Buffer} - ACK packet
   */
  static buildACK(address, sequence) {
    return this.buildPacket({
      address,
      command: 0x40, // osdp_ACK
      data: Buffer.alloc(0),
      sequence,
      isReply: true
    });
  }

  /**
   * Build BUSY reply
   * @param {number} address - PD address
   * @returns {Buffer} - BUSY packet (always sequence 0)
   */
  static buildBUSY(address) {
    return this.buildPacket({
      address,
      command: 0x79, // osdp_BUSY
      data: Buffer.alloc(0),
      sequence: 0, // BUSY always uses sequence 0
      isReply: true
    });
  }
}

module.exports = OSDPPacket;
