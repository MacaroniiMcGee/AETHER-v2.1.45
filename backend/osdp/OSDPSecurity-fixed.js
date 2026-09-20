// OSDPSecurity-fixed.js - OSDP Secure Channel Implementation
// FIXED VERSION - Corrected per OSDP v2.2.2 specification

const crypto = require('crypto');

class OSDPSecurity {
  constructor() {
    // OSDP Spec Default SCBK-D (Installation Key) per D.7
    this.SCBK_D = Buffer.from('303132333435363738393A3B3C3D3E3F', 'hex');
    
    // Session storage: address -> session data
    this.sessions = new Map();
  }

  initSession(address, customSCBK = null) {
    const scbk = customSCBK || this.SCBK_D;
    const useDefaultKey = !customSCBK;
    
    this.sessions.set(address, {
      address,
      scbk,
      useDefaultKey,
      established: false,
      rndA: null,
      rndB: null,
      sessionKeys: null,
      cMAC: null,  // Command MAC (ICV for R-MAC)
      rMAC: null   // Reply MAC (ICV for C-MAC)
    });
    
    console.log(`[OSDPSecurity] Session initialized for address ${address}`);
    console.log(`[OSDPSecurity] Using ${useDefaultKey ? 'SCBK-D (default)' : 'custom SCBK'}`);
  }

  getSession(address) {
    return this.sessions.get(address);
  }

  isSessionEstablished(address) {
    const session = this.sessions.get(address);
    return session ? session.established : false;
  }

  terminateSession(address) {
    this.sessions.delete(address);
    console.log(`[OSDPSecurity] Session terminated for address ${address}`);
  }

  setSCBK(address, keyBuffer) {
    const session = this.sessions.get(address);
    if (session) {
      session.scbk = keyBuffer;
      session.useDefaultKey = false;
      console.log(`[OSDPSecurity] Set SCBK for address ${address}`);
    } else {
      this.initSession(address, keyBuffer);
    }
  }

  resetToDefault(address) {
    const session = this.sessions.get(address);
    if (session) {
      session.scbk = this.SCBK_D;
      session.useDefaultKey = true;
      session.established = false;
      console.log(`[OSDPSecurity] Reset address ${address} to SCBK-D`);
    } else {
      this.initSession(address, null);
    }
  }

  generateRandom(bytes) {
    return crypto.randomBytes(bytes);
  }

  /**
   * AES-128 Encryption
   * @param {Buffer} plaintext - 16-byte block to encrypt
   * @param {Buffer} key - 16-byte AES key
   * @param {string} mode - 'ecb' or 'cbc'
   * @param {Buffer} iv - IV for CBC mode (optional)
   * @returns {Buffer} - Encrypted data
   */
  aesEncrypt(plaintext, key, mode = 'ecb', iv = null) {
    if (mode === 'ecb') {
      const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
      cipher.setAutoPadding(false);
      return Buffer.concat([cipher.update(plaintext), cipher.final()]);
    } else if (mode === 'cbc') {
      const actualIV = iv || Buffer.alloc(16, 0);
      const cipher = crypto.createCipheriv('aes-128-cbc', key, actualIV);
      cipher.setAutoPadding(false);
      return Buffer.concat([cipher.update(plaintext), cipher.final()]);
    }
    throw new Error(`Unsupported AES mode: ${mode}`);
  }

  /**
   * Derive Session Keys per OSDP v2.2.2 Section D.4.1
   * 
   * CRITICAL: Only uses first 6 bytes of RND.A!
   * 
   * S-ENC  = AES(SCBK, 0x01 || 0x82 || RND.A[0:5] || 0x00 * 8)
   * S-MAC1 = AES(SCBK, 0x01 || 0x01 || RND.A[0:5] || 0x00 * 8)
   * S-MAC2 = AES(SCBK, 0x01 || 0x02 || RND.A[0:5] || 0x00 * 8)
   */
  deriveSessionKeys(scbk, rndA) {
    console.log('[OSDPSecurity] ========================================');
    console.log('[OSDPSecurity] Deriving session keys (FIXED)');
    console.log('[OSDPSecurity] SCBK:', scbk.toString('hex').toUpperCase());
    console.log('[OSDPSecurity] RND.A (full):', rndA.toString('hex').toUpperCase());
    console.log('[OSDPSecurity] RND.A[0:5] (used):', rndA.slice(0, 6).toString('hex').toUpperCase());
    
    // FIXED: Use only first 6 bytes of RND.A per spec D.4.1
    const rndA6 = rndA.slice(0, 6);
    
    // S-ENC: Session Encryption Key
    // Plaintext: 0x01 || 0x82 || RND.A[0:5] || 8 zeros = 16 bytes
    const sEncPlaintext = Buffer.concat([
      Buffer.from([0x01, 0x82]),
      rndA6,
      Buffer.alloc(8, 0)
    ]);
    console.log('[OSDPSecurity] S-ENC plaintext:', sEncPlaintext.toString('hex').toUpperCase());
    const sEnc = this.aesEncrypt(sEncPlaintext, scbk);
    console.log('[OSDPSecurity] S-ENC:', sEnc.toString('hex').toUpperCase());
    
    // S-MAC1: Session MAC Key 1
    const sMac1Plaintext = Buffer.concat([
      Buffer.from([0x01, 0x01]),
      rndA6,
      Buffer.alloc(8, 0)
    ]);
    console.log('[OSDPSecurity] S-MAC1 plaintext:', sMac1Plaintext.toString('hex').toUpperCase());
    const sMac1 = this.aesEncrypt(sMac1Plaintext, scbk);
    console.log('[OSDPSecurity] S-MAC1:', sMac1.toString('hex').toUpperCase());
    
    // S-MAC2: Session MAC Key 2
    const sMac2Plaintext = Buffer.concat([
      Buffer.from([0x01, 0x02]),
      rndA6,
      Buffer.alloc(8, 0)
    ]);
    console.log('[OSDPSecurity] S-MAC2 plaintext:', sMac2Plaintext.toString('hex').toUpperCase());
    const sMac2 = this.aesEncrypt(sMac2Plaintext, scbk);
    console.log('[OSDPSecurity] S-MAC2:', sMac2.toString('hex').toUpperCase());
    
    console.log('[OSDPSecurity] ========================================');
    
    return { sEnc, sMac1, sMac2 };
  }

  /**
   * Generate Client Cryptogram per OSDP v2.2.2 Section D.4.3
   * 
   * ClientCryptogram = AES(S-ENC, RND.A || RND.B)
   */
  generateClientCryptogram(rndA, rndB, sEnc) {
    console.log('[OSDPSecurity] ========================================');
    console.log('[OSDPSecurity] Generating Client Cryptogram (FIXED)');
    console.log('[OSDPSecurity] RND.A:', rndA.toString('hex').toUpperCase());
    console.log('[OSDPSecurity] RND.B:', rndB.toString('hex').toUpperCase());
    console.log('[OSDPSecurity] S-ENC:', sEnc.toString('hex').toUpperCase());
    
    // Per spec D.4.3: ClientCryptogram = ENC(RND.A[8] || RND.B[8], S-ENC)
    const plaintext = Buffer.concat([rndA, rndB]);
    console.log('[OSDPSecurity] Plaintext (RND.A || RND.B):', plaintext.toString('hex').toUpperCase());
    
    const cryptogram = this.aesEncrypt(plaintext, sEnc, 'ecb');
    console.log('[OSDPSecurity] Client Cryptogram:', cryptogram.toString('hex').toUpperCase());
    console.log('[OSDPSecurity] ========================================');
    
    return cryptogram;
  }

  /**
   * Generate Server Cryptogram per OSDP v2.2.2 Section D.4.4
   * 
   * ServerCryptogram = AES(S-ENC, RND.B || RND.A)
   */
  generateServerCryptogram(rndA, rndB, sEnc) {
    console.log('[OSDPSecurity] ========================================');
    console.log('[OSDPSecurity] Generating Server Cryptogram');
    console.log('[OSDPSecurity] RND.A:', rndA.toString('hex').toUpperCase());
    console.log('[OSDPSecurity] RND.B:', rndB.toString('hex').toUpperCase());
    console.log('[OSDPSecurity] S-ENC:', sEnc.toString('hex').toUpperCase());
    
    // Per spec D.4.4: ServerCryptogram = ENC(RND.B[8] || RND.A[8], S-ENC)
    const plaintext = Buffer.concat([rndB, rndA]);
    console.log('[OSDPSecurity] Plaintext (RND.B || RND.A):', plaintext.toString('hex').toUpperCase());
    
    const cryptogram = this.aesEncrypt(plaintext, sEnc, 'ecb');
    console.log('[OSDPSecurity] Server Cryptogram:', cryptogram.toString('hex').toUpperCase());
    console.log('[OSDPSecurity] ========================================');
    
    return cryptogram;
  }

  /**
   * Generate Initial RMAC (RMAC_I) per OSDP v2.2.2 Section D.3.2
   * 
   * CRITICAL FIX: MAC_I is computed by:
   * 1. Encrypting the Server Cryptogram using S-MAC1
   * 2. Then encrypting that result using S-MAC2
   * 
   * RMAC_I = AES(S-MAC2, AES(S-MAC1, ServerCryptogram))
   */
  generateRMAC_I(serverCryptogram, sMac1, sMac2) {
    console.log('[OSDPSecurity] ========================================');
    console.log('[OSDPSecurity] Generating RMAC_I (FIXED)');
    console.log('[OSDPSecurity] Server Cryptogram:', serverCryptogram.toString('hex').toUpperCase());
    console.log('[OSDPSecurity] S-MAC1:', sMac1.toString('hex').toUpperCase());
    console.log('[OSDPSecurity] S-MAC2:', sMac2.toString('hex').toUpperCase());
    
    // Step 1: Encrypt Server Cryptogram with S-MAC1
    const step1 = this.aesEncrypt(serverCryptogram, sMac1, 'ecb');
    console.log('[OSDPSecurity] Step 1 (AES(S-MAC1, ServerCrypto)):', step1.toString('hex').toUpperCase());
    
    // Step 2: Encrypt result with S-MAC2
    const rmacI = this.aesEncrypt(step1, sMac2, 'ecb');
    console.log('[OSDPSecurity] RMAC_I (AES(S-MAC2, Step1)):', rmacI.toString('hex').toUpperCase());
    console.log('[OSDPSecurity] ========================================');
    
    return rmacI;
  }

  /**
   * Generate MAC for message per OSDP v2.2.2 Section D.5
   * 
   * MAC is computed using CBC mode:
   * - S-MAC1 for all blocks except the last
   * - S-MAC2 for the last block
   * - ICV is the previously received MAC from the other party
   */
  generateMAC(message, sMac1, sMac2, icv) {
    console.log('[OSDPSecurity] Generating MAC');
    console.log('[OSDPSecurity] Message length:', message.length);
    console.log('[OSDPSecurity] ICV:', icv.toString('hex').toUpperCase());
    
    // Pad message to 16-byte boundary per D.4.5
    const paddedMessage = this.padForMAC(message);
    console.log('[OSDPSecurity] Padded message length:', paddedMessage.length);
    
    const blockCount = paddedMessage.length / 16;
    let currentICV = Buffer.from(icv);
    
    for (let i = 0; i < blockCount; i++) {
      const block = paddedMessage.slice(i * 16, (i + 1) * 16);
      
      // XOR with ICV
      const xored = Buffer.alloc(16);
      for (let j = 0; j < 16; j++) {
        xored[j] = block[j] ^ currentICV[j];
      }
      
      // Use S-MAC2 for last block, S-MAC1 for all others
      const key = (i === blockCount - 1) ? sMac2 : sMac1;
      currentICV = this.aesEncrypt(xored, key, 'ecb');
    }
    
    console.log('[OSDPSecurity] Full MAC:', currentICV.toString('hex').toUpperCase());
    console.log('[OSDPSecurity] MAC (first 4 bytes):', currentICV.slice(0, 4).toString('hex').toUpperCase());
    
    return currentICV;
  }

  /**
   * Pad message for MAC calculation per D.4.5
   * 
   * If message is not a multiple of 16:
   * - Append 0x80
   * - Append 0x00 until length is multiple of 16
   */
  padForMAC(data) {
    const blockSize = 16;
    const remainder = data.length % blockSize;
    
    if (remainder === 0) {
      // No padding needed for MAC calculation if already aligned
      return data;
    }
    
    // Append 0x80 then zeros to reach next block boundary
    const paddingLength = blockSize - remainder;
    const padding = Buffer.alloc(paddingLength, 0);
    padding[0] = 0x80;
    
    return Buffer.concat([data, padding]);
  }

  /**
   * Pad data for encryption per D.4.5
   * 
   * For DATA field encryption:
   * - Always append 0x80
   * - Append 0x00 until length is multiple of 16
   * - Padding is required even if original length is multiple of 16
   */
  padForEncryption(data) {
    const blockSize = 16;
    
    // Always add 0x80, then pad with zeros
    const withMarker = Buffer.concat([data, Buffer.from([0x80])]);
    const remainder = withMarker.length % blockSize;
    
    if (remainder === 0) {
      return withMarker;
    }
    
    const paddingLength = blockSize - remainder;
    return Buffer.concat([withMarker, Buffer.alloc(paddingLength, 0)]);
  }

  /**
   * Remove encryption padding
   */
  unpadAfterDecryption(data) {
    // Find the 0x80 marker from the end
    for (let i = data.length - 1; i >= 0; i--) {
      if (data[i] === 0x80) {
        return data.slice(0, i);
      }
      if (data[i] !== 0x00) {
        // Invalid padding
        throw new Error('Invalid padding');
      }
    }
    throw new Error('Padding marker not found');
  }

  /**
   * Encrypt data for SCS_17/SCS_18 per D.5.1
   * 
   * Uses CBC mode with S-ENC
   * ICV = one's complement of last received MAC
   */
  encryptData(data, sEnc, lastReceivedMAC) {
    const paddedData = this.padForEncryption(data);
    
    // ICV is one's complement of last received MAC
    const icv = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) {
      icv[i] = ~lastReceivedMAC[i] & 0xFF;
    }
    
    return this.aesEncrypt(paddedData, sEnc, 'cbc', icv);
  }

  /**
   * Decrypt data from SCS_17/SCS_18 per D.5.2
   */
  decryptData(encryptedData, sEnc, lastSentMAC) {
    // ICV is one's complement of last sent MAC
    const icv = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) {
      icv[i] = ~lastSentMAC[i] & 0xFF;
    }
    
    const decipher = crypto.createDecipheriv('aes-128-cbc', sEnc, icv);
    decipher.setAutoPadding(false);
    const decrypted = Buffer.concat([decipher.update(encryptedData), decipher.final()]);
    
    return this.unpadAfterDecryption(decrypted);
  }

  /**
   * Verify MAC
   */
  verifyMAC(message, receivedMac, sMac1, sMac2, icv) {
    const computedMac = this.generateMAC(message, sMac1, sMac2, icv);
    
    // Compare first 4 bytes
    const expected = computedMac.slice(0, 4);
    const actual = receivedMac.slice(0, 4);
    
    return expected.equals(actual);
  }
}

module.exports = OSDPSecurity;
