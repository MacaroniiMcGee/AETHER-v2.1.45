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
const cmap = require('./credentialMap');

// User-built formats (Readers → Format builder) live here, beside the library
const USER_FORMATS_FILE = path.join(__dirname, '../data/custom-formats-user.json');
// Formats someone has confirmed on a real controller (removes the UNVERIFIED tag)
const CONFIRMED_FILE = path.join(__dirname, '../data/format-confirmations.json');

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
        // Give every format an exact bit map; its field sizes and ranges win
        // over the library's summary numbers (which don't always add up)
        this.formats.forEach(fmt => this._attachMap(fmt));
        // Add user-built formats
        this._loadUserFormats().forEach(fmt => this.formats.push(fmt));
        // Mark the ones confirmed on a controller
        const confirmed = this.getConfirmations();
        this.formats.forEach(fmt => {
          fmt.libraryStatus = fmt.status;
          if (fmt.status !== 'verified' && confirmed[fmt.id]) { fmt.status = 'confirmed'; fmt.confirmedAt = confirmed[fmt.id]; }
        });
        
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

  _attachMap(fmt, map) {
    const m = map || cmap.buildMap(fmt);
    const r = cmap.ranges(m);
    if (!fmt.library) fmt.library = { facilityBits: fmt.facilityBits, cardBits: fmt.cardBits, issueLevel: fmt.issueLevel || 0 };
    fmt.map = m;
    fmt.status = m.status;
    if (m.note) fmt.statusNote = m.note;
    fmt.facilityBits = r.facilityBits;
    fmt.cardBits = r.cardBits;
    fmt.issueLevel = r.issueBits || undefined;
    fmt.maxFacility = r.maxFacility;
    fmt.maxCard = r.maxCard;
    fmt.maxIssueLevel = r.maxIssueLevel;
    fmt.hasParity = (m.parity || []).length > 0;
    return fmt;
  }

  _loadUserFormats() {
    try {
      if (!fs.existsSync(USER_FORMATS_FILE)) return [];
      const list = JSON.parse(fs.readFileSync(USER_FORMATS_FILE, 'utf8')).formats || [];
      return list.filter(u => u && u.id && u.map && cmap.checkMap(u.map).length === 0).map(u => this._userToFormat(u));
    } catch (e) {
      console.error('[FormatService] Could not read user formats:', e.message);
      return [];
    }
  }

  _userToFormat(u) {
    const fmt = {
      id: u.id, name: u.name, category: 'custom', bits: u.map.bits,
      parity: (u.map.parity || []).length ? 'custom' : 'none',
      description: u.description || 'Built in the format builder',
      usage: 'Custom format', popularity: 'custom', manufacturer: 'Custom',
      user: true, createdAt: u.createdAt, updatedAt: u.updatedAt,
    };
    return this._attachMap(fmt, { ...u.map, status: 'custom', source: 'user' });
  }

  getUserFormats() {
    try { return fs.existsSync(USER_FORMATS_FILE) ? (JSON.parse(fs.readFileSync(USER_FORMATS_FILE, 'utf8')).formats || []) : []; }
    catch { return []; }
  }

  /** Save (create or replace) a user format. Returns the stored entry. */
  saveUserFormat(def) {
    const map = {
      bits: Number(def.map && def.map.bits),
      fields: ((def.map && def.map.fields) || []).map(f => ({
        key: String(f.key), start: Number(f.start), len: Number(f.len),
        ...(f.key === 'fixed' ? { value: Number(f.value || 0) } : {}), ...(f.label ? { label: String(f.label).slice(0, 40) } : {}),
      })),
      parity: ((def.map && def.map.parity) || []).map(p => ({
        bit: Number(p.bit), type: p.type === 'even' ? 'even' : p.type === 'xor' ? 'xor' : 'odd',
        covers: (p.covers || []).map(Number).filter(Number.isInteger), ...(p.type === 'xor' ? { len: Number(p.len || 8) } : {}),
      })),
    };
    const errs = cmap.checkMap(map);
    if (!def.name || !String(def.name).trim()) errs.unshift('Name is required');
    if (errs.length) { const e = new Error(errs.join('; ')); e.status = 400; throw e; }
    const list = this.getUserFormats();
    const slug = String(def.name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'format';
    let id = def.id && String(def.id).startsWith('user_') && list.some(x => x.id === def.id) ? def.id : `user_${slug}_${map.bits}`;
    if (!(def.id && id === def.id)) {                     // new format: never overwrite another one
      let n = 2; const baseId = id;
      while (list.some(x => x.id === id)) id = `${baseId}_${n++}`;
    }
    const now = new Date().toISOString();
    const prev = list.find(x => x.id === id);
    const entry = { id, name: String(def.name).trim().slice(0, 60), description: def.description ? String(def.description).slice(0, 200) : '', map, createdAt: prev ? prev.createdAt : now, updatedAt: now };
    const next = list.filter(x => x.id !== id).concat(entry);
    fs.mkdirSync(path.dirname(USER_FORMATS_FILE), { recursive: true });
    fs.writeFileSync(USER_FORMATS_FILE, JSON.stringify({ version: 1, formats: next }, null, 2));
    this.reload();
    return entry;
  }

  deleteUserFormat(id) {
    const list = this.getUserFormats();
    const next = list.filter(x => x.id !== id);
    if (next.length === list.length) return false;
    fs.writeFileSync(USER_FORMATS_FILE, JSON.stringify({ version: 1, formats: next }, null, 2));
    this.reload();
    return true;
  }

  getConfirmations() {
    try { return fs.existsSync(CONFIRMED_FILE) ? (JSON.parse(fs.readFileSync(CONFIRMED_FILE, 'utf8')).confirmed || {}) : {}; }
    catch { return {}; }
  }

  /** Mark a format as confirmed on a real controller (or undo). */
  setConfirmed(id, yes) {
    const fmt = this.getFormatById(id);
    if (!fmt) { const e = new Error('Format not found'); e.status = 404; throw e; }
    const c = this.getConfirmations();
    if (yes) c[fmt.id] = new Date().toISOString(); else delete c[fmt.id];
    fs.mkdirSync(path.dirname(CONFIRMED_FILE), { recursive: true });
    fs.writeFileSync(CONFIRMED_FILE, JSON.stringify({ version: 1, confirmed: c }, null, 2));
    this.reload();
    return this.getFormatById(fmt.id);
  }

  /** Encode with an arbitrary map (used by the builder's live preview). */
  encodeMap(map, values) {
    const errs = cmap.checkMap(map);
    if (errs.length) { const e = new Error(errs.join('; ')); e.status = 400; throw e; }
    const { binary, segments } = cmap.encode(map, values);
    return { bits: map.bits, binary, segments, hex: cmap.toBytes(binary).toString('hex').toUpperCase() };
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
    const map = fmt.map || this._attachMap(fmt).map;
    const { binary, segments } = cmap.encode(map, { facility: facility || 0, card: card || 0, issue: issueLevel || 0 });
    const value = BigInt('0b' + binary);
    const bytes = cmap.toBytes(binary);
    console.log(`[FormatService] Encoded ${fmt.id}: FC=${facility} Card=${card}${issueLevel ? ` IL=${issueLevel}` : ''} -> ${fmt.bits}-bit ${binary}`);
    return {
      formatId: fmt.id,
      formatName: fmt.name,
      status: fmt.status,
      bits: fmt.bits,
      facilityBits: fmt.facilityBits,
      cardBits: fmt.cardBits,
      facility: Number(facility || 0),
      card: String(card || 0),
      issueLevel: Number(issueLevel || 0),
      value,
      valueHex: value.toString(16).toUpperCase().padStart(Math.ceil(fmt.bits / 4), '0'),
      bytes,
      hex: bytes.toString('hex').toUpperCase(),
      binary,
      segments,
    };
  }

  _popcount(n) {
    let count = 0;
    while (n) { n &= (n - 1); count++; }
    return count;
  }

}

module.exports = new FormatService();
