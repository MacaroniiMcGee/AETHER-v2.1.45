/**
 * formatConverter.js - Convert between format structures v5.0
 * 
 * Handles conversion between:
 *   - Master JSON format (credential-formats-master.json)
 *   - Frontend format structure
 *   - OSDP format structure
 *   - Custom format structure
 * 
 * Now supports:
 *   - Issue level fields
 *   - Complex parity types
 *   - Scrambled formats
 *   - Government multi-field formats
 */

/**
 * Parity type mapping between different systems
 */
const PARITY_MAP = {
  // From master to frontend
  'std': 'std',
  'none': 'none',
  'whole-even': 'whole-even',
  'whole-odd': 'whole-odd',
  'interleaved': 'interleaved',
  'multi-row': 'multi-row',
  'xor-byte': 'xor-byte',
  'custom': 'custom',
  
  // Aliases
  'standard': 'std',
  'even-odd': 'std',
  'wiegand': 'std'
};

/**
 * Normalize parity type string
 */
function normalizeParity(parity) {
  if (!parity) return 'std';
  const normalized = String(parity).toLowerCase().trim();
  return PARITY_MAP[normalized] || normalized;
}

/**
 * Calculate max value for bit count
 */
function calculateMax(bits) {
  if (!bits || bits === 0) return 0;
  if (bits > 53) return Number.MAX_SAFE_INTEGER;
  if (bits > 31) return Math.pow(2, bits) - 1;
  return (1 << bits) - 1;
}

/**
 * Convert master JSON format to frontend format structure
 * 
 * @param {Object} masterFormat - Format from credential-formats-master.json
 * @returns {Object} Frontend-compatible format
 */
function masterToFrontend(masterFormat) {
  if (!masterFormat || !masterFormat.id) return null;
  
  return {
    id: masterFormat.id.toLowerCase(),
    name: masterFormat.name,
    bits: masterFormat.bits,
    frameBits: masterFormat.bits,
    facilityBits: masterFormat.facilityBits || 0,
    cardBits: masterFormat.cardBits || 0,
    issueLevelBits: masterFormat.issueLevel || 0,
    hasParity: masterFormat.hasParity !== false && masterFormat.parity !== 'none',
    parity: normalizeParity(masterFormat.parity),
    parityNote: masterFormat.parityNote || null,
    description: masterFormat.description || '',
    layout: masterFormat.layout || null,
    usage: masterFormat.usage || '',
    manufacturer: masterFormat.manufacturer || null,
    category: masterFormat.category || 'other',
    popularity: masterFormat.popularity || 'low',
    
    // Feature flags
    hasFacility: (masterFormat.facilityBits || 0) > 0,
    hasIssueLevel: (masterFormat.issueLevel || 0) > 0,
    isScrambled: masterFormat.scrambled === true,
    isReversedOrder: masterFormat.fieldOrder === 'reversed',
    requiresBigInt: masterFormat.bits >= 64,
    isComplex: ['interleaved', 'multi-row', 'xor-byte', 'custom'].includes(masterFormat.parity),
    
    // Ranges
    maxFacility: calculateMax(masterFormat.facilityBits || 0),
    maxCard: calculateMax(masterFormat.cardBits || masterFormat.bits),
    maxIssueLevel: calculateMax(masterFormat.issueLevel || 0),
    
    // Metadata
    isCustom: false,
    isNew: masterFormat.isNew === true,
    fixedFrom: masterFormat.fixedFrom || null,
    
    // Aliases for compatibility
    aliases: masterFormat.aliases || [],
    equivalent: masterFormat.equivalent || null
  };
}

/**
 * Convert legacy Wiegand format to frontend format structure
 * 
 * @param {Object} wiegandFormat - Legacy wiegand format
 * @returns {Object} Frontend-compatible format
 */
function wiegandToFrontend(wiegandFormat) {
  if (!wiegandFormat) return null;
  
  return {
    id: (wiegandFormat.id || '').toLowerCase(),
    name: wiegandFormat.name,
    bits: wiegandFormat.bits,
    frameBits: wiegandFormat.bits,
    facilityBits: wiegandFormat.facilityBits || 0,
    cardBits: wiegandFormat.cardBits || 0,
    hasParity: wiegandFormat.hasParity !== false,
    parity: normalizeParity(wiegandFormat.parity || (wiegandFormat.hasParity ? 'std' : 'none')),
    description: wiegandFormat.description || '',
    layout: wiegandFormat.layout || null,
    usage: wiegandFormat.usage || '',
    
    // Feature flags
    hasFacility: (wiegandFormat.facilityBits || 0) > 0,
    hasIssueLevel: false,
    isScrambled: false,
    isComplex: false,
    
    // Ranges
    maxFacility: wiegandFormat.facilityRange?.max || calculateMax(wiegandFormat.facilityBits || 0),
    maxCard: wiegandFormat.cardRange?.max || calculateMax(wiegandFormat.cardBits || wiegandFormat.bits),
    
    // Metadata
    isCustom: false
  };
}

/**
 * Convert OSDP format to frontend format structure
 * 
 * @param {Object} osdpFormat - OSDP format object
 * @returns {Object} Frontend-compatible format
 */
function osdpToFrontend(osdpFormat) {
  if (!osdpFormat) return null;
  
  const bits = osdpFormat.bitLength || osdpFormat.bits || osdpFormat.bitCount;
  
  return {
    id: osdpFormat.id,
    name: osdpFormat.name,
    bits: bits,
    frameBits: bits,
    facilityBits: osdpFormat.facilityBits || 0,
    cardBits: osdpFormat.cardBits || 0,
    hasParity: osdpFormat.hasParity !== false,
    parity: normalizeParity(osdpFormat.parity || osdpFormat.parityType),
    description: osdpFormat.description || '',
    manufacturer: osdpFormat.manufacturer || null,
    
    // Feature flags
    hasFacility: (osdpFormat.facilityBits || 0) > 0,
    
    // Ranges
    maxFacility: calculateMax(osdpFormat.facilityBits || 0),
    maxCard: calculateMax(osdpFormat.cardBits || bits),
    
    // Metadata
    isCustom: osdpFormat.isCustom || false
  };
}

/**
 * Convert frontend format to master JSON structure
 * 
 * @param {Object} frontendFormat - Frontend format object
 * @returns {Object} Master JSON compatible format
 */
function frontendToMaster(frontendFormat) {
  if (!frontendFormat) return null;
  
  return {
    id: frontendFormat.id,
    name: frontendFormat.name,
    category: frontendFormat.category || 'custom',
    bits: frontendFormat.bits || frontendFormat.frameBits,
    facilityBits: frontendFormat.facilityBits || 0,
    cardBits: frontendFormat.cardBits || 0,
    maxFacility: frontendFormat.maxFacility || calculateMax(frontendFormat.facilityBits || 0),
    maxCard: frontendFormat.maxCard || calculateMax(frontendFormat.cardBits || frontendFormat.bits),
    hasParity: frontendFormat.hasParity !== false,
    parity: normalizeParity(frontendFormat.parity),
    description: frontendFormat.description || '',
    layout: frontendFormat.layout || null,
    usage: frontendFormat.usage || '',
    popularity: frontendFormat.popularity || 'low'
  };
}

/**
 * Convert custom format to frontend structure
 * 
 * @param {Object} customFormat - Custom format definition
 * @returns {Object} Frontend-compatible format
 */
function customToFrontend(customFormat) {
  if (!customFormat) return null;
  
  const bits = customFormat.bitCount || customFormat.bits;
  
  return {
    id: customFormat.id,
    name: customFormat.name,
    bits: bits,
    frameBits: bits,
    facilityBits: customFormat.facilityBits || 0,
    cardBits: customFormat.cardBits || 0,
    hasParity: customFormat.hasParity !== false && customFormat.parityType !== 'none',
    parity: normalizeParity(customFormat.parityType || customFormat.parity),
    description: customFormat.description || '',
    
    // Feature flags
    hasFacility: (customFormat.facilityBits || 0) > 0,
    
    // Ranges
    maxFacility: calculateMax(customFormat.facilityBits || 0),
    maxCard: calculateMax(customFormat.cardBits || bits),
    
    // Metadata
    isCustom: true
  };
}

/**
 * Get all formats from multiple sources, merged and deduplicated
 * 
 * @param {Array} masterFormats - Formats from credential-formats-master.json
 * @param {Array} wiegandFormats - Legacy wiegand formats (optional)
 * @param {Array} osdpFormats - OSDP formats (optional)
 * @param {Array} customFormats - User custom formats (optional)
 * @returns {Array} Merged and deduplicated formats
 */
function getAllFormats(masterFormats, wiegandFormats, osdpFormats, customFormats) {
  const formats = [];
  const seenIds = new Set();
  
  // Priority 1: Master formats (highest priority, most accurate)
  if (masterFormats && Array.isArray(masterFormats)) {
    for (const fmt of masterFormats) {
      // Skip section markers
      if (fmt._section) continue;
      
      const converted = masterToFrontend(fmt);
      if (converted && !seenIds.has(converted.id)) {
        formats.push(converted);
        seenIds.add(converted.id);
      }
    }
  }
  
  // Priority 2: OSDP formats (only add if not already present)
  if (osdpFormats && Array.isArray(osdpFormats)) {
    for (const fmt of osdpFormats) {
      const converted = osdpToFrontend(fmt);
      if (converted && !seenIds.has(converted.id)) {
        formats.push(converted);
        seenIds.add(converted.id);
      }
    }
  }
  
  // Priority 3: Legacy Wiegand formats (only add if not already present)
  if (wiegandFormats && Array.isArray(wiegandFormats)) {
    for (const fmt of wiegandFormats) {
      const converted = wiegandToFrontend(fmt);
      if (converted && !seenIds.has(converted.id)) {
        formats.push(converted);
        seenIds.add(converted.id);
      }
    }
  }
  
  // Priority 4: Custom formats (always add, marked as custom)
  if (customFormats && Array.isArray(customFormats)) {
    for (const fmt of customFormats) {
      const converted = customToFrontend(fmt);
      if (converted) {
        // Custom formats can override existing with same ID
        const existingIndex = formats.findIndex(f => f.id === converted.id);
        if (existingIndex >= 0) {
          formats[existingIndex] = converted;
        } else {
          formats.push(converted);
        }
      }
    }
  }
  
  return formats;
}

/**
 * Get format by ID from merged formats
 * 
 * @param {string} formatId - Format ID to find
 * @param {Array} allFormats - Array of merged formats
 * @returns {Object|null} Found format or null
 */
function getFormatById(formatId, allFormats) {
  if (!formatId || !allFormats) return null;
  
  const id = formatId.toLowerCase();
  return allFormats.find(f => 
    f.id === id || 
    (f.aliases && f.aliases.includes(id)) ||
    f.equivalent === id
  ) || null;
}

/**
 * Get formats by bit count
 * 
 * @param {number} bits - Bit count
 * @param {Array} allFormats - Array of merged formats
 * @returns {Array} Formats with matching bit count
 */
function getFormatsByBits(bits, allFormats) {
  if (!bits || !allFormats) return [];
  return allFormats.filter(f => f.bits === bits || f.frameBits === bits);
}

/**
 * Group formats by category
 * 
 * @param {Array} allFormats - Array of merged formats
 * @returns {Object} Formats grouped by category
 */
function groupByCategory(allFormats) {
  if (!allFormats) return {};
  
  const groups = {};
  for (const fmt of allFormats) {
    const category = fmt.category || 'other';
    if (!groups[category]) {
      groups[category] = [];
    }
    groups[category].push(fmt);
  }
  return groups;
}

/**
 * Filter formats by feature
 * 
 * @param {Array} allFormats - Array of merged formats
 * @param {Object} filters - Filter criteria
 * @returns {Array} Filtered formats
 */
function filterFormats(allFormats, filters = {}) {
  if (!allFormats) return [];
  
  return allFormats.filter(fmt => {
    if (filters.hasFacility !== undefined && fmt.hasFacility !== filters.hasFacility) return false;
    if (filters.hasIssueLevel !== undefined && fmt.hasIssueLevel !== filters.hasIssueLevel) return false;
    if (filters.isScrambled !== undefined && fmt.isScrambled !== filters.isScrambled) return false;
    if (filters.isComplex !== undefined && fmt.isComplex !== filters.isComplex) return false;
    if (filters.isCustom !== undefined && fmt.isCustom !== filters.isCustom) return false;
    if (filters.category && fmt.category !== filters.category) return false;
    if (filters.parity && fmt.parity !== filters.parity) return false;
    if (filters.minBits && fmt.bits < filters.minBits) return false;
    if (filters.maxBits && fmt.bits > filters.maxBits) return false;
    return true;
  });
}

/**
 * Get format summary for display
 * 
 * @param {Object} format - Format object
 * @returns {Object} Summary object for display
 */
function getFormatSummary(format) {
  if (!format) return null;
  
  return {
    id: format.id,
    name: format.name,
    bits: format.bits,
    description: format.description || '',
    features: {
      hasFacility: format.hasFacility,
      hasIssueLevel: format.hasIssueLevel || false,
      isScrambled: format.isScrambled || false,
      isComplex: format.isComplex || false,
      parity: format.parity
    },
    ranges: format.hasFacility ? {
      facility: `0-${format.maxFacility}`,
      card: `0-${format.maxCard}`
    } : {
      card: `0-${format.maxCard}`
    },
    warnings: []
      .concat(format.isScrambled ? ['Scrambled bit order'] : [])
      .concat(format.isComplex ? [`Complex parity: ${format.parity}`] : [])
      .concat(format.requiresBigInt ? ['Requires BigInt handling'] : [])
      .concat(format.parityNote ? [format.parityNote] : [])
  };
}

module.exports = {
  // Conversion functions
  masterToFrontend,
  wiegandToFrontend,
  osdpToFrontend,
  frontendToMaster,
  customToFrontend,
  
  // Aggregation
  getAllFormats,
  
  // Query functions
  getFormatById,
  getFormatsByBits,
  groupByCategory,
  filterFormats,
  getFormatSummary,
  
  // Utilities
  normalizeParity,
  calculateMax,
  
  // Constants
  PARITY_MAP
};
