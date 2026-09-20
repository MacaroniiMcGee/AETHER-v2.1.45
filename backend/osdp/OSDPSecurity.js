// OSDPSecurity.js - OSDP Secure Channel Implementation
// FIXED VERSION - Corrected per OSDP v2.2.2 specification

const crypto = require('crypto');

class OSDPSecurity {
  constructor() {
    // OSDP Spec Default SCBK-D (Installation Key) per D.7
    this.SCBK_D = Buffer.from('303132333435363738393A3B3C3D3E3F', 'hex');
    
    // Session storage: address -> session data
    this.sessions = new Map();
    
    console.log('[OSDPSecurity] Initialized (OSDP v2.2.2 compliant)');
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
      cMAC: null,
      rMAC: null
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

  // Derive Session Keys - ONLY FIRST 6 BYTES OF RND.A
  deriveSessionKeys(scbk, rndA) {
    console.log('[OSDPSecurity] ========================================');
    console.log('[OSDPSecurity] Deriving session keys');
    console.log('[OSDPSecurity] SCBK:', scbk.toString('hex').toUpperCase());
    console.log('[OSDPSecurity] RND.A (full 8):', rndA.toString('hex').toUpperCase());
    console.log('[OSDPSecurity] RND.A[0:5] (6 used):', rndA.slice(0, 6).toString('hex').toUpperCase());
    
    const rndA6 = rndA.slice(0, 6);
    
    // S-ENC
    const sEncPlaintext = Buffer.concat([Buffer.from([0x01, 0x82]), rndA6, Buffer.alloc(8, 0)]);
    console.log('[OSDPSecurity] S-ENC input:', sEncPlaintext.toString('hex').toUpperCase());
    const sEnc = this.aesEncrypt(sEncPlaintext, scbk);
    console.log('[OSDPSecurity] S-ENC:', sEnc.toString('hex').toUpperCase());
    
    // S-MAC1
    const sMac1Plaintext = Buffer.concat([Buffer.from([0x01, 0x01]), rndA6, Buffer.alloc(8, 0)]);
    const sMac1 = this.aesEncrypt(sMac1Plaintext, scbk);
    console.log('[OSDPSecurity] S-MAC1:', sMac1.toString('hex').toUpperCase());
    
    // S-MAC2
    const sMac2Plaintext = Buffer.concat([Buffer.from([0x01, 0x02]), rndA6, Buffer.alloc(8, 0)]);
    const sMac2 = this.aesEncrypt(sMac2Plaintext, scbk);
    console.log('[OSDPSecurity] S-MAC2:', sMac2.toString('hex').toUpperCase());
    
    console.log('[OSDPSecurity] ========================================');
    return { sEnc, sMac1, sMac2 };
  }

  // Client Cryptogram = AES(S-ENC, RND.A || RND.B)
  generateClientCryptogram(rndA, rndB, sEnc, cUID = null) {
    console.log('[OSDPSecurity] ========================================');
    console.log('[OSDPSecurity] Generating Client Cryptogram');
    console.log('[OSDPSecurity] RND.A:', rndA.toString('hex').toUpperCase());
    console.log('[OSDPSecurity] RND.B:', rndB.toString('hex').toUpperCase());
    console.log('[OSDPSecurity] S-ENC:', sEnc.toString('hex').toUpperCase());
    
    const plaintext = Buffer.concat([rndA, rndB]);
    console.log('[OSDPSecurity] Plaintext (RND.A || RND.B):', plaintext.toString('hex').toUpperCase());
    
    const cryptogram = this.aesEncrypt(plaintext, sEnc, 'ecb');
    console.log('[OSDPSecurity] Client Cryptogram:', cryptogram.toString('hex').toUpperCase());
    console.log('[OSDPSecurity] ========================================');
    return cryptogram;
  }

  // Server Cryptogram = AES(S-ENC, RND.B || RND.A) - REVERSED
  generateServerCryptogram(rndA, rndB, sEnc) {
    console.log('[OSDPSecurity] ========================================');
    console.log('[OSDPSecurity] Generating Server Cryptogram (for verification)');
    
    const plaintext = Buffer.concat([rndB, rndA]);
    console.log('[OSDPSecurity] Plaintext (RND.B || RND.A):', plaintext.toString('hex').toUpperCase());
    
    const cryptogram = this.aesEncrypt(plaintext, sEnc, 'ecb');
    console.log('[OSDPSecurity] Server Cryptogram:', cryptogram.toString('hex').toUpperCase());
    console.log('[OSDPSecurity] ========================================');
    return cryptogram;
  }

  // RMAC_I = AES(S-MAC1, RND.A || RND.B)
  generateRMAC_I(rndA, rndB, sMac1) {
    const plaintext = Buffer.concat([rndA, rndB]);
    const rmacI = this.aesEncrypt(plaintext, sMac1, 'ecb');
    console.log('[OSDPSecurity] RMAC_I:', rmacI.toString('hex').toUpperCase());
    return rmacI;
  }

  generateMAC(data, sMac1, icv) {
    const padLen = (16 - (data.length % 16)) % 16;
    const paddedData = padLen > 0 ? Buffer.concat([data, Buffer.alloc(padLen, 0)]) : data;
    
    let mac = icv || Buffer.alloc(16, 0);
    for (let i = 0; i < paddedData.length; i += 16) {
      const block = paddedData.slice(i, i + 16);
      const xored = Buffer.alloc(16);
      for (let j = 0; j < 16; j++) {
        xored[j] = block[j] ^ mac[j];
      }
      mac = this.aesEncrypt(xored, sMac1, 'ecb');
    }
    return mac;
  }

  verifyMAC(data, receivedMac, sMac1, icv) {
    const computedMac = this.generateMAC(data, sMac1, icv);
    return computedMac.slice(0, 4).equals(receivedMac.slice(0, 4));
  }
}

module.exports = OSDPSecurity;
