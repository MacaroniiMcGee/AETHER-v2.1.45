/**
 * formatService.js - UNIFIED Credential Format Service v5.0
 * 
 * THIS IS THE SINGLE SOURCE OF TRUTH FOR ALL FORMAT LOOKUPS
 * 
 * Now supports:
 *   - 113 formats from credential-formats-master.json v5.0
 *   - Complex parity types (interleaved, multi-row, xor-byte)
 *   - Scrambled bit formats
 *   - Issue level fields
 *   - Government multi-field formats (TWIC, PIV)
 *   - BigInt for 64+ bit formats
 * 
 * Usage:
 *   const formatService = require('./formatService');
 *   const fmt = formatService.getFormatById('h10302');
 *   console.log(fmt.facilityBits, fmt.cardBits); // 0, 35
 */

const fs = require('fs');
const path = require('path');

class FormatService {
  constructor() {
    this.formats = [];
    this.formatsById = new Map();
    this.formatsByCategory = new Map();
    this.formatsByBits = new Map();
    this.formatsByParity = new Map();
    this.loadFormats();
  }

  /**
   * Load formats from master JSON file
   */
  loadFormats() {
    // Try multiple paths for the format file
    const possiblePaths = [
      path.join(__dirname, '../config/credential-formats-master.json'),
      path.join(__dirname, 'credential-formats-master.json'),
      path.join(__dirname, '../credential-formats-master.json'),
      '/home/pi/card-reader/config/credential-formats-master.json'
    ];
    
    let loaded = false;
    
    for (const formatFile of possiblePaths) {
      try {
        if (!fs.existsSync(formatFile)) continue;
        
        const data = JSON.parse(fs.readFileSync(formatFile, 'utf8'));
        
        // Filter out section markers
        this.formats = (data.formats || []).filter(fmt => 
          fmt.id && !fmt._section
        );
        
        // Index by ID
        this.formats.forEach(fmt => {
          this.formatsById.set(fmt.id.toLowerCase(), fmt);
          
          // Add aliases
          if (fmt.aliases && Array.isArray(fmt.aliases)) {
            fmt.aliases.forEach(alias => {
              this.formatsById.set(alias.toLowerCase(), fmt);
            });
          }
          
          // Index by category
          const category = fmt.category || 'other';
          if (!this.formatsByCategory.has(category)) {
            this.formatsByCategory.set(category, []);
          }
          this.formatsByCategory.get(category).push(fmt);
          
          // Index by bit count
          const bits = fmt.bits;
          if (!this.formatsByBits.has(bits)) {
            this.formatsByBits.set(bits, []);
          }
          this.formatsByBits.get(bits).push(fmt);
          
          // Index by parity type
          const parity = fmt.parity || 'std';
          if (!this.formatsByParity.has(parity)) {
            this.formatsByParity.set(parity, []);
          }
          this.formatsByParity.get(parity).push(fmt);
        });
        
        console.log(`[FormatService] Loaded ${this.formats.length} credential formats from ${formatFile}`);
        console.log(`[FormatService] Bit count variants: ${this.formatsByBits.size} different bit lengths`);
        console.log(`[FormatService] Parity types: ${Array.from(this.formatsByParity.keys()).join(', ')}`);
        
        loaded = true;
        break;
        
      } catch (err) {
        // Try next path
        continue;
      }
    }
    
    if (!loaded) {
      console.error('[FormatService] Failed to load formats from any path');
      this.formats = [];
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // BASIC LOOKUP FUNCTIONS
  // ═══════════════════════════════════════════════════════════════════════════

  getAllFormats() {
    return this.formats;
  }

  getFormatById(id) {
    if (!id) return null;
    return this.formatsById.get(id.toLowerCase()) || null;
  }

  getFormatsByCategory(category) {
    return this.formatsByCategory.get(category) || [];
  }

  getCategories() {
    return Array.from(this.formatsByCategory.keys());
  }

  getMostCommon() {
    return this.formats.filter(f => f.popularity === 'very-high' || f.popularity === 'high');
  }

  searchFormats(query) {
    const q = query.toLowerCase();
    return this.formats.filter(f => 
      f.name.toLowerCase().includes(q) ||
      (f.description && f.description.toLowerCase().includes(q)) ||
      f.id.toLowerCase().includes(q) ||
      (f.manufacturer && f.manufacturer.toLowerCase().includes(q)) ||
      (f.aliases && f.aliases.some(a => a.toLowerCase().includes(q)))
    );
  }

  getFormatByBits(bits) {
    const variants = this.formatsByBits.get(bits);
    if (!variants || variants.length === 0) return null;
    
    // Prefer standard wiegand format (w26, w34, etc.)
    const standard = variants.find(f => f.id.match(/^w\d+$/));
    if (standard) return standard;
    
    // Then HID formats
    const hid = variants.find(f => f.category === 'hid');
    if (hid) return hid;
    
    return variants[0];
  }

  getFormatVariants(bits) {
    return this.formatsByBits.get(bits) || [];
  }

  hasMultipleVariants(bits) {
    const variants = this.formatsByBits.get(bits);
    return variants && variants.length > 1;
  }

  getSupportedBitCounts() {
    return Array.from(this.formatsByBits.keys()).sort((a, b) => a - b);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SPECIAL FORMAT QUERIES
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get formats with no facility code
   */
  getNoFacilityFormats() {
    return this.formats.filter(f => f.facilityBits === 0);
  }

  /**
   * Check if format has facility code
   */
  hasFacilityCode(formatId) {
    const fmt = this.getFormatById(formatId);
    return fmt ? fmt.facilityBits > 0 : true;
  }

  /**
   * Get formats by parity type
   */
  getFormatsByParity(parityType) {
    return this.formatsByParity.get(parityType) || [];
  }

  /**
   * Get formats with complex parity (not standard)
   */
  getComplexParityFormats() {
    return this.formats.filter(f => 
      f.parity && f.parity !== 'std' && f.parity !== 'none'
    );
  }

  /**
   * Get scrambled bit formats
   */
  getScrambledFormats() {
    return this.formats.filter(f => f.scrambled === true);
  }

  /**
   * Get formats with issue level field
   */
  getIssueLevelFormats() {
    return this.formats.filter(f => f.issueLevel && f.issueLevel > 0);
  }

  /**
   * Get government/PIV formats
   */
  getGovernmentFormats() {
    return this.formats.filter(f => 
      f.category === 'piv' || 
      f.category === 'twic' ||
      f.id.startsWith('piv') ||
      f.id.startsWith('twic') ||
      f.id.startsWith('fascn')
    );
  }

  /**
   * Get formats requiring BigInt (64+ bits)
   */
  getBigIntFormats() {
    return this.formats.filter(f => f.bits >= 64);
  }

  /**
   * Get new formats (added in v5.0)
   */
  getNewFormats() {
    return this.formats.filter(f => f.isNew === true);
  }

  /**
   * Get formats that were fixed in v5.0
   */
  getFixedFormats() {
    return this.formats.filter(f => f.fixedFrom);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // VALIDATION
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Validate a credential against format constraints
   */
  validateCredential(formatId, facility, card, issueLevel = 0) {
    const fmt = this.getFormatById(formatId);
    
    if (!fmt) {
      return { 
        valid: false, 
        error: `Unknown format: ${formatId}`,
        availableFormats: this.formats.slice(0, 10).map(f => f.id)
      };
    }
    
    // Check facility code
    if (fmt.facilityBits === 0) {
      if (facility !== 0 && facility !== undefined && facility !== null) {
        return { 
          valid: false, 
          error: `Format ${formatId} has no facility code. Set facility to 0.`,
          hint: `This is a ${fmt.bits}-bit format where entire data is card number.`,
          hasFacility: false
        };
      }
    }
    
    // Calculate max values
    const maxFacility = this._calculateMax(fmt.facilityBits);
    const maxCard = this._calculateMax(fmt.cardBits);
    const maxIssueLevel = fmt.issueLevel ? this._calculateMax(fmt.issueLevel) : 0;
    
    // Validate facility range
    if (fmt.facilityBits > 0 && (facility < 0 || facility > maxFacility)) {
      return { 
        valid: false, 
        error: `Facility code must be 0-${maxFacility} for ${fmt.name}`,
        maxFacility,
        maxCard
      };
    }
    
    // Validate card range
    if (card < 0 || card > maxCard) {
      return { 
        valid: false, 
        error: `Card number must be 0-${maxCard} for ${fmt.name}`,
        maxFacility,
        maxCard
      };
    }
    
    // Validate issue level if present
    if (fmt.issueLevel && issueLevel > maxIssueLevel) {
      return {
        valid: false,
        error: `Issue level must be 0-${maxIssueLevel} for ${fmt.name}`,
        maxIssueLevel
      };
    }
    
    // Warn about complex formats
    const warnings = [];
    
    if (fmt.parity === 'interleaved') {
      warnings.push('This format uses interleaved parity - ensure encoder supports it');
    }
    if (fmt.parity === 'multi-row') {
      warnings.push('This format uses multi-row parity - complex encoding required');
    }
    if (fmt.parity === 'xor-byte') {
      warnings.push('This format uses XOR checksum - special encoder required');
    }
    if (fmt.scrambled) {
      warnings.push('This format has scrambled bit order - special encoder required');
    }
    if (fmt.bits >= 64) {
      warnings.push('This format requires BigInt handling for full precision');
    }
    
    return { 
      valid: true, 
      maxFacility, 
      maxCard,
      maxIssueLevel,
      hasFacility: fmt.facilityBits > 0,
      hasIssueLevel: (fmt.issueLevel || 0) > 0,
      parity: fmt.parity || 'std',
      format: fmt,
      warnings: warnings.length > 0 ? warnings : undefined
    };
  }

  /**
   * Calculate max value for bit count
   */
  _calculateMax(bits) {
    if (!bits || bits === 0) return 0;
    if (bits > 53) return Number.MAX_SAFE_INTEGER;  // JavaScript limit
    if (bits > 31) return Math.pow(2, bits) - 1;
    return (1 << bits) - 1;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ENCODING PARAMETERS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get format ranges
   */
  getFormatRanges(formatId) {
    const fmt = this.getFormatById(formatId);
    if (!fmt) return null;
    
    return {
      formatId: fmt.id,
      name: fmt.name,
      bits: fmt.bits,
      facilityBits: fmt.facilityBits,
      cardBits: fmt.cardBits,
      issueLevelBits: fmt.issueLevel || 0,
      maxFacility: this._calculateMax(fmt.facilityBits),
      maxCard: this._calculateMax(fmt.cardBits),
      maxIssueLevel: this._calculateMax(fmt.issueLevel || 0),
      hasFacility: fmt.facilityBits > 0,
      hasIssueLevel: (fmt.issueLevel || 0) > 0,
      parity: fmt.parity || 'std',
      scrambled: fmt.scrambled || false,
      fieldOrder: fmt.fieldOrder || 'normal'
    };
  }

  /**
   * Get encoding parameters for a format
   */
  getEncodingParams(formatIdOrBits) {
    let fmt;
    
    if (typeof formatIdOrBits === 'string') {
      fmt = this.getFormatById(formatIdOrBits);
    } else if (typeof formatIdOrBits === 'number') {
      fmt = this.getFormatByBits(formatIdOrBits);
    }
    
    if (!fmt) return null;
    
    return {
      formatId: fmt.id,
      bits: fmt.bits,
      facilityBits: fmt.facilityBits,
      cardBits: fmt.cardBits,
      issueLevelBits: fmt.issueLevel || 0,
      parity: fmt.parity || 'std',
      parityNote: fmt.parityNote || null,
      parityCalc: fmt.parityCalc || null,
      header: fmt.header || null,
      hasFacility: fmt.facilityBits > 0,
      hasIssueLevel: (fmt.issueLevel || 0) > 0,
      layout: fmt.layout || null,
      scrambled: fmt.scrambled || false,
      fieldOrder: fmt.fieldOrder || 'normal',
      bitPositions: fmt.bitPositions || null
    };
  }

  /**
   * Resolve format from various input types
   */
  resolveFormat(input) {
    if (!input) return null;
    
    if (typeof input === 'string') {
      return this.getFormatById(input);
    }
    
    if (typeof input === 'number') {
      return this.getFormatByBits(input);
    }
    
    if (typeof input === 'object') {
      if (input.formatId) return this.getFormatById(input.formatId);
      if (input.format && typeof input.format === 'string') return this.getFormatById(input.format);
      if (input.bits || input.format) return this.getFormatByBits(input.bits || input.format);
    }
    
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SERVICE MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Reload formats from file
   */
  reload() {
    this.formats = [];
    this.formatsById.clear();
    this.formatsByCategory.clear();
    this.formatsByBits.clear();
    this.formatsByParity.clear();
    this.loadFormats();
  }

  /**
   * Get service status
   */
  getStatus() {
    return {
      loaded: this.formats.length > 0,
      totalFormats: this.formats.length,
      categories: this.getCategories(),
      bitCounts: this.getSupportedBitCounts(),
      parityTypes: Array.from(this.formatsByParity.keys()),
      noFacilityFormats: this.getNoFacilityFormats().map(f => f.id),
      complexParityFormats: this.getComplexParityFormats().map(f => f.id),
      scrambledFormats: this.getScrambledFormats().map(f => f.id),
      issueLevelFormats: this.getIssueLevelFormats().map(f => f.id),
      bigIntFormats: this.getBigIntFormats().map(f => f.id),
      multiVariantBitCounts: this.getSupportedBitCounts().filter(b => this.hasMultipleVariants(b))
    };
  }

  /**
   * Print summary to console
   */
  printSummary() {
    console.log('\n=== FORMAT SERVICE SUMMARY (v5.0) ===');
    console.log(`Total formats: ${this.formats.length}`);
    console.log(`Categories: ${this.getCategories().join(', ')}`);
    console.log(`Bit counts: ${this.getSupportedBitCounts().join(', ')}`);
    console.log(`Parity types: ${Array.from(this.formatsByParity.keys()).join(', ')}`);
    
    console.log('\nFormats with NO facility code:');
    this.getNoFacilityFormats().forEach(f => {
      console.log(`  ${f.id}: ${f.bits}-bit, Card:${f.cardBits}`);
    });
    
    console.log('\nComplex parity formats:');
    this.getComplexParityFormats().forEach(f => {
      console.log(`  ${f.id}: ${f.parity}${f.parityNote ? ` - ${f.parityNote}` : ''}`);
    });
    
    console.log('\nScrambled bit formats:');
    this.getScrambledFormats().forEach(f => {
      console.log(`  ${f.id}: ${f.name}`);
    });
    
    console.log('\nFormats with issue level:');
    this.getIssueLevelFormats().forEach(f => {
      console.log(`  ${f.id}: ${f.issueLevel}-bit issue level`);
    });
    
    console.log('\nBit counts with multiple variants:');
    this.getSupportedBitCounts().forEach(bits => {
      const variants = this.getFormatVariants(bits);
      if (variants.length > 1) {
        console.log(`  ${bits}-bit: ${variants.map(v => v.id).join(', ')}`);
      }
    });
    
    console.log('');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MASTER ENCODING FUNCTION - v5.0
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Encode credential to Wiegand bitstream
   * THIS IS THE SINGLE SOURCE OF TRUTH FOR ENCODING
   */
  encodeCredential(formatId, facility, card, issueLevel = 0) {
    const fmt = this.getFormatById(formatId);
    if (!fmt) {
      throw new Error(`Unknown format: ${formatId}`);
    }

    const bits = fmt.bits;
    const facilityBits = fmt.facilityBits || 0;
    const cardBits = fmt.cardBits || (bits - facilityBits - 2);
    const issueLevelBits = fmt.issueLevel || 0;
    const parity = fmt.parity || 'std';

    let fc = BigInt(facility || 0);
    let cn = BigInt(card || 0);
    let il = BigInt(issueLevel || 0);

    // Mask to valid ranges
    if (facilityBits > 0) {
      fc = fc & ((1n << BigInt(facilityBits)) - 1n);
    } else {
      fc = 0n;
    }
    cn = cn & ((1n << BigInt(cardBits)) - 1n);
    if (issueLevelBits > 0) {
      il = il & ((1n << BigInt(issueLevelBits)) - 1n);
    }

    // Build data portion (without parity)
    let dataBits;
    let dataLength;

    if (issueLevelBits > 0 && facilityBits > 0) {
      dataBits = (il << BigInt(facilityBits + cardBits)) | (fc << BigInt(cardBits)) | cn;
      dataLength = issueLevelBits + facilityBits + cardBits;
    } else if (facilityBits > 0) {
      dataBits = (fc << BigInt(cardBits)) | cn;
      dataLength = facilityBits + cardBits;
    } else {
      dataBits = cn;
      dataLength = cardBits;
    }

        // Calculate parity using format-specific ranges if available
    let finalValue;
    
    if (parity === 'none') {
      finalValue = dataBits;
    } else if (parity === 'std') {
      let evenParity, oddParity;
      
      // Check for format-specific parity coverage
      if (fmt.parityEven && fmt.parityEven.covers && fmt.parityOdd && fmt.parityOdd.covers) {
        const epRange = fmt.parityEven.covers.split('-').map(Number);
        const opRange = fmt.parityOdd.covers.split('-').map(Number);
        
        // Convert from 1-indexed output position to 0-indexed data position
        const epStart = epRange[0] - 2;
        const epEnd = epRange[1] - 2;
        const opStart = opRange[0] - 2;
        const opEnd = opRange[1] - 2;
        
        // Count 1s in EP range (from MSB)
        let epCount = 0;
        for (let i = epStart; i <= epEnd && i < dataLength; i++) {
          const bitPos = BigInt(dataLength - 1 - i);
          if ((dataBits >> bitPos) & 1n) epCount++;
        }
        
        // Count 1s in OP range (from MSB)
        let opCount = 0;
        for (let i = opStart; i <= opEnd && i < dataLength; i++) {
          const bitPos = BigInt(dataLength - 1 - i);
          if ((dataBits >> bitPos) & 1n) opCount++;
        }
        
        evenParity = epCount % 2 === 0 ? 0 : 1;
        oddParity = opCount % 2 === 0 ? 1 : 0;
        
        console.log('[FormatService] Parity: EP covers ' + fmt.parityEven.covers + ' (' + epCount + ' ones)->EP=' + evenParity + ', OP covers ' + fmt.parityOdd.covers + ' (' + opCount + ' ones)->OP=' + oddParity);
      } else {
        // Default: split data in half
        const halfBits = Math.floor(dataLength / 2);
        const upperHalf = Number((dataBits >> BigInt(halfBits)) & ((1n << BigInt(dataLength - halfBits)) - 1n));
        const lowerHalf = Number(dataBits & ((1n << BigInt(halfBits)) - 1n));
        
        evenParity = this._popcount(upperHalf) % 2 === 0 ? 0 : 1;
        oddParity = this._popcount(lowerHalf) % 2 === 0 ? 1 : 0;
      }
      
      finalValue = (BigInt(evenParity) << BigInt(bits - 1)) | (dataBits << 1n) | BigInt(oddParity);
    } else {
      console.warn('[FormatService] Complex parity ' + parity + ' not fully implemented for ' + formatId);
      finalValue = dataBits;
    }

    // Convert to bytes (left-justified)
    const bytesNeeded = Math.ceil(bits / 8);
    const leftJustified = finalValue << BigInt((bytesNeeded * 8) - bits);
    
    const bytes = Buffer.alloc(bytesNeeded);
    for (let i = 0; i < bytesNeeded; i++) {
      const shift = BigInt((bytesNeeded - 1 - i) * 8);
      bytes[i] = Number((leftJustified >> shift) & 0xFFn);
    }

    console.log(`[FormatService] Encoded ${fmt.id}: FC=${fc} Card=${cn} -> ${bits}-bit 0x${finalValue.toString(16).toUpperCase()}`);

    return {
      formatId: fmt.id,
      formatName: fmt.name,
      bits: bits,
      facilityBits: facilityBits,
      cardBits: cardBits,
      facility: Number(fc),
      card: Number(cn),
      issueLevel: Number(il),
      value: finalValue,
      valueHex: finalValue.toString(16).toUpperCase().padStart(Math.ceil(bits / 4), '0'),
      bytes: bytes,
      hex: bytes.toString('hex').toUpperCase(),
      binary: finalValue.toString(2).padStart(bits, '0')
    };
  }

  _popcount(n) {
    let count = 0;
    while (n) { n &= (n - 1); count++; }
    return count;
  }

}

module.exports = new FormatService();
