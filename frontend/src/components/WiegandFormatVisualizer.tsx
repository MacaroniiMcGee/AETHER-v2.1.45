/**
 * WiegandFormatVisualizer-v5.tsx
 * 
 * Visual Wiegand Format Generator v5.0
 * Supports ALL parity types: standard, interleaved, multi-row, XOR, scrambled
 * Supports issue level formats (K32, Kastle)
 */

import React, { useState, useMemo } from 'react';

interface FormatSpec {
  name: string;
  bits: number;
  structure: BitField[];
  facilityMax: number;
  cardMax: number;
  description: string;
  parity: 'std' | 'none' | 'interleaved' | 'multi-row' | 'xor' | 'scrambled';
  category: string;
  hasIssueLevel?: boolean;
  issueLevelBits?: number;
  maxIssueLevel?: number;
  cardOnly?: boolean;
  warning?: string;
}

interface BitField {
  type: 'parity-even' | 'parity-odd' | 'parity-whole-odd' | 'facility' | 'card' | 'header' | 'oem' | 'issue-level' | 'xor-checksum' | 'multi-row-ep1' | 'multi-row-op' | 'multi-row-x' | 'multi-row-ep2';
  bits: number;
  label: string;
}

const FORMATS: Record<string, FormatSpec> = {
  // Standard Wiegand Formats
  'w26': {
    name: 'W26 - Standard H10301',
    bits: 26,
    facilityMax: 255,
    cardMax: 65535,
    description: 'Most common format. 8-bit facility, 16-bit card.',
    parity: 'std',
    category: 'wiegand',
    structure: [
      { type: 'parity-even', bits: 1, label: 'EP' },
      { type: 'facility', bits: 8, label: 'Facility' },
      { type: 'card', bits: 16, label: 'Card' },
      { type: 'parity-odd', bits: 1, label: 'OP' }
    ]
  },
  'w34': {
    name: 'W34 - Corporate 1000',
    bits: 34,
    facilityMax: 65535,
    cardMax: 65535,
    description: '16-bit facility, 16-bit card with standard parity.',
    parity: 'std',
    category: 'wiegand',
    structure: [
      { type: 'parity-even', bits: 1, label: 'EP' },
      { type: 'facility', bits: 16, label: 'Facility' },
      { type: 'card', bits: 16, label: 'Card' },
      { type: 'parity-odd', bits: 1, label: 'OP' }
    ]
  },
  'w37': {
    name: 'W37 - H10304',
    bits: 37,
    facilityMax: 65535,
    cardMax: 524287,
    description: '16-bit facility, 19-bit card with standard parity.',
    parity: 'std',
    category: 'wiegand',
    structure: [
      { type: 'parity-even', bits: 1, label: 'EP' },
      { type: 'facility', bits: 16, label: 'Facility' },
      { type: 'card', bits: 19, label: 'Card' },
      { type: 'parity-odd', bits: 1, label: 'OP' }
    ]
  },
  'w48': {
    name: 'W48 - HID Extended',
    bits: 48,
    facilityMax: 4194303,
    cardMax: 16777215,
    description: '22-bit facility, 24-bit card with standard parity.',
    parity: 'std',
    category: 'wiegand',
    structure: [
      { type: 'parity-even', bits: 1, label: 'EP' },
      { type: 'facility', bits: 22, label: 'Facility' },
      { type: 'card', bits: 24, label: 'Card' },
      { type: 'parity-odd', bits: 1, label: 'OP' }
    ]
  },

  // Interleaved Parity Formats (v5.0)
  'corp1000_35': {
    name: 'Corporate 1000 35-bit (Interleaved)',
    bits: 35,
    facilityMax: 4095,
    cardMax: 1048575,
    description: 'HID Corporate 1000 with interleaved parity. Whole-frame odd + half parities.',
    parity: 'interleaved',
    category: 'hid',
    warning: 'Interleaved parity - requires special encoding',
    structure: [
      { type: 'parity-whole-odd', bits: 1, label: 'WOP' },
      { type: 'parity-even', bits: 1, label: 'EP' },
      { type: 'header', bits: 2, label: '01' },
      { type: 'facility', bits: 12, label: 'Facility' },
      { type: 'card', bits: 18, label: 'Card' },
      { type: 'parity-odd', bits: 1, label: 'OP' }
    ]
  },
  'corp1000_48': {
    name: 'Corporate 1000 48-bit (Interleaved)',
    bits: 48,
    facilityMax: 4194303,
    cardMax: 1048575,
    description: 'HID Corporate 1000 48-bit with interleaved parity.',
    parity: 'interleaved',
    category: 'hid',
    warning: 'Interleaved parity - requires special encoding',
    structure: [
      { type: 'parity-whole-odd', bits: 1, label: 'WOP' },
      { type: 'parity-even', bits: 1, label: 'EP' },
      { type: 'header', bits: 2, label: '01' },
      { type: 'facility', bits: 22, label: 'Facility' },
      { type: 'card', bits: 20, label: 'Card' },
      { type: 'parity-odd', bits: 1, label: 'OP' }
    ]
  },

  // Multi-Row Parity Formats (v5.0)
  'h10320_clockdata': {
    name: 'H10320 Clock & Data 36-bit (Multi-Row)',
    bits: 36,
    facilityMax: 0,
    cardMax: 4294967295,
    description: '32-bit card number only with multi-row parity (EP1, OP, X, EP2).',
    parity: 'multi-row',
    category: 'hid',
    cardOnly: true,
    warning: 'Multi-row parity - card only, no facility code',
    structure: [
      { type: 'card', bits: 32, label: 'Card' },
      { type: 'multi-row-ep1', bits: 1, label: 'EP1' },
      { type: 'multi-row-op', bits: 1, label: 'OP' },
      { type: 'multi-row-x', bits: 1, label: 'X' },
      { type: 'multi-row-ep2', bits: 1, label: 'EP2' }
    ]
  },
  'keyscan_36': {
    name: 'Keyscan 36-bit (Multi-Row)',
    bits: 36,
    facilityMax: 255,
    cardMax: 16777215,
    description: '8-bit facility, 24-bit card with multi-row parity.',
    parity: 'multi-row',
    category: 'hid',
    warning: 'Multi-row parity',
    structure: [
      { type: 'facility', bits: 8, label: 'Facility' },
      { type: 'card', bits: 24, label: 'Card' },
      { type: 'multi-row-ep1', bits: 1, label: 'EP1' },
      { type: 'multi-row-op', bits: 1, label: 'OP' },
      { type: 'multi-row-x', bits: 1, label: 'X' },
      { type: 'multi-row-ep2', bits: 1, label: 'EP2' }
    ]
  },

  // XOR Checksum Format (v5.0)
  'honeywell_40': {
    name: 'Honeywell 40-bit (XOR Checksum)',
    bits: 40,
    facilityMax: 4095,
    cardMax: 65535,
    description: '4-bit header, 12-bit site, 16-bit card, 8-bit XOR checksum.',
    parity: 'xor',
    category: 'proprietary',
    warning: 'XOR byte checksum - not traditional parity',
    structure: [
      { type: 'header', bits: 4, label: '1111' },
      { type: 'facility', bits: 12, label: 'Site' },
      { type: 'card', bits: 16, label: 'Card' },
      { type: 'xor-checksum', bits: 8, label: 'XOR' }
    ]
  },

  // Scrambled Bit Formats (v5.0)
  'indala27_asc': {
    name: 'Indala ASC 27-bit (Scrambled)',
    bits: 27,
    facilityMax: 8191,
    cardMax: 16383,
    description: '13-bit site, 14-bit card with scrambled bit positions.',
    parity: 'scrambled',
    category: 'indala',
    warning: 'Scrambled bit positions - lookup tables required',
    structure: [
      { type: 'facility', bits: 13, label: 'Site (scrambled)' },
      { type: 'card', bits: 14, label: 'Card (scrambled)' }
    ]
  },
  'tecom27': {
    name: 'TECOM 27-bit (Scrambled)',
    bits: 27,
    facilityMax: 255,
    cardMax: 65535,
    description: '8-bit site, 16-bit card with scrambled interleaved bits.',
    parity: 'scrambled',
    category: 'proprietary',
    warning: 'Scrambled bit positions',
    structure: [
      { type: 'facility', bits: 8, label: 'Site (odd pos)' },
      { type: 'card', bits: 16, label: 'Card (even pos)' },
      { type: 'parity-even', bits: 1, label: 'EP' },
      { type: 'parity-odd', bits: 1, label: 'OP' },
      { type: 'header', bits: 1, label: '0' }
    ]
  },

  // Issue Level Formats (v5.0)
  'k32': {
    name: 'K32 (32-bit with Issue Level)',
    bits: 32,
    facilityMax: 255,
    cardMax: 65535,
    description: '6-bit issue level, 8-bit facility, 16-bit card with standard parity.',
    parity: 'std',
    category: 'proprietary',
    hasIssueLevel: true,
    issueLevelBits: 6,
    maxIssueLevel: 63,
    structure: [
      { type: 'parity-even', bits: 1, label: 'EP' },
      { type: 'issue-level', bits: 6, label: 'Issue Level' },
      { type: 'facility', bits: 8, label: 'Facility' },
      { type: 'card', bits: 16, label: 'Card' },
      { type: 'parity-odd', bits: 1, label: 'OP' }
    ]
  },
  'kastle_32': {
    name: 'Kastle 32-bit (Issue Level)',
    bits: 32,
    facilityMax: 511,
    cardMax: 65535,
    description: '5-bit issue level, 9-bit facility, 16-bit card with standard parity.',
    parity: 'std',
    category: 'proprietary',
    hasIssueLevel: true,
    issueLevelBits: 5,
    maxIssueLevel: 31,
    structure: [
      { type: 'parity-even', bits: 1, label: 'EP' },
      { type: 'issue-level', bits: 5, label: 'Issue Level' },
      { type: 'facility', bits: 9, label: 'Facility' },
      { type: 'card', bits: 16, label: 'Card' },
      { type: 'parity-odd', bits: 1, label: 'OP' }
    ]
  },

  // Card-Only Formats (v5.0)
  'h10302': {
    name: 'H10302 37-bit (Card Only)',
    bits: 37,
    facilityMax: 0,
    cardMax: 34359738367,
    description: '35-bit card number only with standard parity.',
    parity: 'std',
    category: 'hid',
    cardOnly: true,
    structure: [
      { type: 'parity-even', bits: 1, label: 'EP' },
      { type: 'card', bits: 35, label: 'Card' },
      { type: 'parity-odd', bits: 1, label: 'OP' }
    ]
  },
  'casi_40': {
    name: 'CASI Rusco 40-bit (Card Only)',
    bits: 40,
    facilityMax: 0,
    cardMax: 1099511627775,
    description: '40-bit card number only, no parity.',
    parity: 'none',
    category: 'proprietary',
    cardOnly: true,
    structure: [
      { type: 'card', bits: 40, label: 'Card' }
    ]
  },

  // Indala Standard
  'indala26': {
    name: 'Indala 26-bit (12/12)',
    bits: 26,
    facilityMax: 4095,
    cardMax: 4095,
    description: '12-bit facility, 12-bit card with standard parity.',
    parity: 'std',
    category: 'indala',
    structure: [
      { type: 'parity-even', bits: 1, label: 'EP' },
      { type: 'facility', bits: 12, label: 'Facility' },
      { type: 'card', bits: 12, label: 'Card' },
      { type: 'parity-odd', bits: 1, label: 'OP' }
    ]
  },
  'indala29': {
    name: 'Indala 29-bit (No Parity)',
    bits: 29,
    facilityMax: 8191,
    cardMax: 65535,
    description: '13-bit facility, 16-bit card, no parity.',
    parity: 'none',
    category: 'indala',
    structure: [
      { type: 'facility', bits: 13, label: 'Facility' },
      { type: 'card', bits: 16, label: 'Card' }
    ]
  }
};

const COLOR_MAP: Record<string, string> = {
  'parity-even': '#4ade80',
  'parity-odd': '#fbbf24',
  'parity-whole-odd': '#ef4444',
  'facility': '#60a5fa',
  'card': '#a78bfa',
  'header': '#f472b6',
  'oem': '#fb923c',
  'issue-level': '#8b5cf6',
  'xor-checksum': '#06b6d4',
  'multi-row-ep1': '#22c55e',
  'multi-row-op': '#eab308',
  'multi-row-x': '#6b7280',
  'multi-row-ep2': '#22c55e'
};

const PARITY_COLORS: Record<string, string> = {
  'std': '#4ade80',
  'none': '#6b7280',
  'interleaved': '#f59e0b',
  'multi-row': '#ef4444',
  'xor': '#06b6d4',
  'scrambled': '#ec4899'
};

export const WiegandFormatVisualizer: React.FC = () => {
  const [selectedFormatId, setSelectedFormatId] = useState<string>('w26');
  const [facility, setFacility] = useState<number>(123);
  const [card, setCard] = useState<number>(45678);
  const [issueLevel, setIssueLevel] = useState<number>(0);
  const [generatedBits, setGeneratedBits] = useState<string>('');
  const [error, setError] = useState<string>('');

  const format = FORMATS[selectedFormatId];

  // Group formats by parity type
  const formatsByParity = useMemo(() => {
    const groups: Record<string, string[]> = {
      'std': [],
      'interleaved': [],
      'multi-row': [],
      'xor': [],
      'scrambled': [],
      'none': []
    };
    Object.entries(FORMATS).forEach(([id, fmt]) => {
      groups[fmt.parity].push(id);
    });
    return groups;
  }, []);

  const styles = {
    container: {
      padding: '20px',
      fontFamily: 'Arial, sans-serif',
      maxWidth: '1200px',
      margin: '0 auto'
    } as React.CSSProperties,
    card: {
      border: '1px solid #3a3a5a',
      borderRadius: '8px',
      padding: '20px',
      backgroundColor: '#16213e',
      color: '#eee',
      marginBottom: '20px'
    } as React.CSSProperties,
    title: {
      marginTop: 0,
      color: '#00d9ff',
      fontSize: '24px'
    } as React.CSSProperties,
    select: {
      width: '100%',
      padding: '10px',
      border: '1px solid #4a4a6a',
      borderRadius: '4px',
      backgroundColor: '#0f3460',
      color: '#eee',
      fontSize: '14px',
      marginBottom: '10px',
      cursor: 'pointer'
    } as React.CSSProperties,
    input: {
      width: '100%',
      padding: '10px',
      border: '1px solid #4a4a6a',
      borderRadius: '4px',
      backgroundColor: '#0f3460',
      color: '#eee',
      fontSize: '14px'
    } as React.CSSProperties,
    button: {
      padding: '12px 24px',
      backgroundColor: '#00d9ff',
      color: '#000',
      border: 'none',
      borderRadius: '4px',
      fontSize: '16px',
      fontWeight: 'bold',
      cursor: 'pointer',
      transition: 'all 0.2s'
    } as React.CSSProperties,
    bitContainer: {
      display: 'flex',
      flexWrap: 'wrap' as const,
      gap: '2px',
      padding: '20px',
      backgroundColor: '#0f3460',
      borderRadius: '8px',
      marginTop: '20px'
    } as React.CSSProperties,
    legendItem: {
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      marginRight: '20px'
    } as React.CSSProperties,
    legendColor: {
      width: '20px',
      height: '20px',
      borderRadius: '4px'
    } as React.CSSProperties,
    parityBadge: {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '5px',
      padding: '4px 10px',
      borderRadius: '4px',
      fontSize: '12px',
      fontWeight: 'bold'
    } as React.CSSProperties
  };

  // Parity calculation functions
  const calculateEvenParity = (bits: string): string => {
    const count = (bits.match(/1/g) || []).length;
    return (count % 2 === 0) ? '0' : '1';
  };

  const calculateOddParity = (bits: string): string => {
    const count = (bits.match(/1/g) || []).length;
    return (count % 2 === 1) ? '0' : '1';
  };

  const toBinary = (value: number, bits: number): string => {
    return (value >>> 0).toString(2).padStart(bits, '0').slice(-bits);
  };

  const toBinaryBigInt = (value: bigint, bits: number): string => {
    return value.toString(2).padStart(bits, '0').slice(-bits);
  };

  // Encoding functions for each parity type
  const encodeStandard = (fac: number, crd: number, ilBits?: number, il?: number): string => {
    let dataBits = '';
    
    if (ilBits && il !== undefined) {
      dataBits += toBinary(il, ilBits);
    }
    
    const facBits = format.facilityMax > 0 ? Math.ceil(Math.log2(format.facilityMax + 1)) : 0;
    if (facBits > 0) {
      dataBits += toBinary(fac, facBits);
    }
    
    const cardBitsCount = format.bits - (ilBits || 0) - facBits - 2; // -2 for parity
    dataBits += toBinary(crd, cardBitsCount);
    
    const halfLen = Math.ceil(dataBits.length / 2);
    const ep = calculateEvenParity(dataBits.substring(0, halfLen));
    const op = calculateOddParity(dataBits.substring(halfLen));
    
    return ep + dataBits + op;
  };

  const encodeInterleaved35 = (fac: number, crd: number): string => {
    const frame = new Array(35).fill('0');
    
    // Fixed header "01"
    frame[2] = '0';
    frame[3] = '1';
    
    // 12-bit facility
    const facBits = toBinary(fac, 12);
    for (let i = 0; i < 12; i++) {
      frame[4 + i] = facBits[i];
    }
    
    // 18-bit card (positions 16-33)
    const cardBits = toBinary(crd, 18);
    for (let i = 0; i < 18; i++) {
      frame[16 + i] = cardBits[i];
    }
    
    // Even parity on bits 2-17
    frame[1] = calculateEvenParity(frame.slice(2, 18).join(''));
    
    // Odd parity on bits 18-33
    frame[34] = calculateOddParity(frame.slice(18, 34).join(''));
    
    // Whole-frame odd parity on bits 1-34
    frame[0] = calculateOddParity(frame.slice(1, 35).join(''));
    
    return frame.join('');
  };

  const encodeInterleaved48 = (fac: number, crd: number): string => {
    const frame = new Array(48).fill('0');
    
    frame[2] = '0';
    frame[3] = '1';
    
    const facBits = toBinary(fac, 22);
    for (let i = 0; i < 22; i++) {
      frame[4 + i] = facBits[i];
    }
    
    const cardBits = toBinary(crd, 20);
    for (let i = 0; i < 20; i++) {
      frame[26 + i] = cardBits[i];
    }
    
    frame[1] = calculateEvenParity(frame.slice(2, 25).join(''));
    frame[47] = calculateOddParity(frame.slice(25, 47).join(''));
    frame[0] = calculateOddParity(frame.slice(1, 48).join(''));
    
    return frame.join('');
  };

  const encodeMultiRow = (fac: number, crd: number): string => {
    const frame = new Array(36).fill('0');
    
    if (format.cardOnly) {
      // H10320 - card only
      const cardBits = toBinary(crd, 32);
      for (let i = 0; i < 32; i++) {
        frame[i] = cardBits[i];
      }
    } else {
      // Keyscan - facility + card
      const facBits = toBinary(fac, 8);
      for (let i = 0; i < 8; i++) {
        frame[i] = facBits[i];
      }
      const cardBits = toBinary(crd, 24);
      for (let i = 0; i < 24; i++) {
        frame[8 + i] = cardBits[i];
      }
    }
    
    // Multi-row parity calculation
    const ep1Positions = [3, 7, 11, 15, 19, 23, 27, 31];
    const ep1Bits = ep1Positions.map(p => frame[p]).join('');
    frame[32] = calculateEvenParity(ep1Bits);
    
    const opPositions = [1, 5, 9, 13, 17, 21, 25, 29];
    const opBits = opPositions.map(p => frame[p]).join('');
    frame[33] = calculateOddParity(opBits);
    
    frame[34] = '0'; // X bit
    frame[35] = frame[32]; // EP2 = EP1
    
    return frame.join('');
  };

  const encodeXorChecksum = (fac: number, crd: number): string => {
    const frame = new Array(40).fill('0');
    
    // Header "1111"
    frame[0] = '1'; frame[1] = '1'; frame[2] = '1'; frame[3] = '1';
    
    // 12-bit site
    const facBits = toBinary(fac, 12);
    for (let i = 0; i < 12; i++) {
      frame[4 + i] = facBits[i];
    }
    
    // 16-bit card
    const cardBits = toBinary(crd, 16);
    for (let i = 0; i < 16; i++) {
      frame[16 + i] = cardBits[i];
    }
    
    // Calculate XOR checksum
    const bytes: number[] = [];
    for (let b = 0; b < 4; b++) {
      let byte = 0;
      for (let i = 0; i < 8; i++) {
        byte = (byte << 1) | parseInt(frame[b * 8 + i]);
      }
      bytes.push(byte);
    }
    const xorByte = bytes[0] ^ bytes[1] ^ bytes[2] ^ bytes[3];
    const xorBits = toBinary(xorByte, 8);
    for (let i = 0; i < 8; i++) {
      frame[32 + i] = xorBits[i];
    }
    
    return frame.join('');
  };

  const encodeScrambledIndala27 = (fac: number, crd: number): string => {
    const frame = new Array(27).fill('0');
    
    // Site positions (scrambled)
    const sitePositions = [4, 7, 6, 1, 0, 3, 20, 5, 9, 8, 24, 11, 22];
    const facBits = toBinary(fac, 13);
    for (let i = 0; i < 13; i++) {
      if (sitePositions[i] < 27) {
        frame[sitePositions[i]] = facBits[i];
      }
    }
    
    // Card positions (scrambled)
    const cardPositions = [26, 1, 3, 12, 15, 18, 21, 14, 25, 2, 19, 23, 10, 13];
    const cardBits = toBinary(crd, 14);
    for (let i = 0; i < 14; i++) {
      if (cardPositions[i] < 27) {
        frame[cardPositions[i]] = cardBits[i];
      }
    }
    
    return frame.join('');
  };

  const encodeNoParity = (fac: number, crd: number): string => {
    let bits = '';
    
    if (format.facilityMax > 0) {
      const facBitsCount = Math.ceil(Math.log2(format.facilityMax + 1));
      bits += toBinary(fac, facBitsCount);
    }
    
    const cardBitsCount = format.bits - bits.length;
    if (cardBitsCount > 32) {
      bits += toBinaryBigInt(BigInt(crd), cardBitsCount);
    } else {
      bits += toBinary(crd, cardBitsCount);
    }
    
    return bits;
  };

  const generateBits = () => {
    setError('');
    
    // Validate inputs
    if (format.facilityMax > 0 && (facility < 0 || facility > format.facilityMax)) {
      setError(`Facility must be 0-${format.facilityMax.toLocaleString()}`);
      return;
    }
    if (card < 0 || card > format.cardMax) {
      setError(`Card must be 0-${format.cardMax.toLocaleString()}`);
      return;
    }
    if (format.hasIssueLevel && (issueLevel < 0 || issueLevel > (format.maxIssueLevel || 63))) {
      setError(`Issue Level must be 0-${format.maxIssueLevel || 63}`);
      return;
    }

    let bits = '';
    
    try {
      switch (format.parity) {
        case 'std':
          if (format.hasIssueLevel) {
            bits = encodeStandard(facility, card, format.issueLevelBits, issueLevel);
          } else if (format.cardOnly) {
            // Card-only with parity (h10302)
            const cardBits = format.bits - 2;
            const data = toBinary(card, cardBits);
            const halfLen = Math.ceil(data.length / 2);
            const ep = calculateEvenParity(data.substring(0, halfLen));
            const op = calculateOddParity(data.substring(halfLen));
            bits = ep + data + op;
          } else {
            bits = encodeStandard(facility, card);
          }
          break;
          
        case 'interleaved':
          if (format.bits === 35) {
            bits = encodeInterleaved35(facility, card);
          } else if (format.bits === 48) {
            bits = encodeInterleaved48(facility, card);
          }
          break;
          
        case 'multi-row':
          bits = encodeMultiRow(facility, card);
          break;
          
        case 'xor':
          bits = encodeXorChecksum(facility, card);
          break;
          
        case 'scrambled':
          if (selectedFormatId === 'indala27_asc') {
            bits = encodeScrambledIndala27(facility, card);
          } else {
            // TECOM - simplified scrambled
            bits = encodeScrambledIndala27(facility, card);
          }
          break;
          
        case 'none':
          bits = encodeNoParity(facility, card);
          break;
          
        default:
          bits = encodeStandard(facility, card);
      }
      
      setGeneratedBits(bits);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Encoding failed');
    }
  };

  const renderBitStructure = () => {
    let bitIndex = 0;
    return format.structure.map((field, fieldIndex) => {
      const fieldBits = [];
      for (let i = 0; i < field.bits; i++) {
        const bit = generatedBits[bitIndex] || '0';
        fieldBits.push(
          <div
            key={`${fieldIndex}-${i}`}
            style={{
              width: field.bits > 16 ? '24px' : '30px',
              height: '40px',
              backgroundColor: COLOR_MAP[field.type] || '#666',
              color: '#000',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 'bold',
              fontSize: field.bits > 16 ? '14px' : '18px',
              borderRadius: '4px',
              border: '2px solid #000'
            }}
          >
            {bit}
          </div>
        );
        bitIndex++;
      }
      return (
        <div key={fieldIndex} style={{ display: 'flex', gap: '2px' }}>
          {fieldBits}
        </div>
      );
    });
  };

  const renderLegend = () => {
    const uniqueTypes = new Set(format.structure.map(f => f.type));
    const legendMap: Record<string, string> = {
      'parity-even': 'Even Parity',
      'parity-odd': 'Odd Parity',
      'parity-whole-odd': 'Whole-Frame Odd',
      'facility': 'Facility/Site Code',
      'card': 'Card Number',
      'header': 'Header Bits',
      'oem': 'OEM Bit',
      'issue-level': 'Issue Level',
      'xor-checksum': 'XOR Checksum',
      'multi-row-ep1': 'EP1 (Multi-Row)',
      'multi-row-op': 'OP (Multi-Row)',
      'multi-row-x': 'X Bit',
      'multi-row-ep2': 'EP2 (=EP1)'
    };

    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', marginTop: '20px', gap: '10px' }}>
        {Array.from(uniqueTypes).map(type => (
          <div key={type} style={styles.legendItem}>
            <div
              style={{
                ...styles.legendColor,
                backgroundColor: COLOR_MAP[type] || '#666'
              }}
            />
            <span style={{ fontSize: '14px' }}>{legendMap[type] || type}</span>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h3 style={styles.title}>🔢 Wiegand Format Visualizer v5.0</h3>
        <p style={{ color: '#aaa', marginTop: '-10px' }}>
          Visual bit structure generator with ALL parity types
        </p>

        <div style={{ marginTop: '20px' }}>
          <label style={{ display: 'block', marginBottom: '5px', fontSize: '13px', color: '#aaa' }}>
            Select Format
          </label>
          <select
            value={selectedFormatId}
            onChange={(e) => {
              setSelectedFormatId(e.target.value);
              setGeneratedBits('');
              setError('');
              setIssueLevel(0);
            }}
            style={styles.select}
          >
            <optgroup label="Standard Parity">
              {formatsByParity['std'].map(id => (
                <option key={id} value={id}>{FORMATS[id].name}</option>
              ))}
            </optgroup>
            <optgroup label="Interleaved Parity (Corporate 1000)">
              {formatsByParity['interleaved'].map(id => (
                <option key={id} value={id}>{FORMATS[id].name}</option>
              ))}
            </optgroup>
            <optgroup label="Multi-Row Parity (H10320)">
              {formatsByParity['multi-row'].map(id => (
                <option key={id} value={id}>{FORMATS[id].name}</option>
              ))}
            </optgroup>
            <optgroup label="XOR Checksum (Honeywell)">
              {formatsByParity['xor'].map(id => (
                <option key={id} value={id}>{FORMATS[id].name}</option>
              ))}
            </optgroup>
            <optgroup label="Scrambled Bits (Indala ASC)">
              {formatsByParity['scrambled'].map(id => (
                <option key={id} value={id}>{FORMATS[id].name}</option>
              ))}
            </optgroup>
            <optgroup label="No Parity">
              {formatsByParity['none'].map(id => (
                <option key={id} value={id}>{FORMATS[id].name}</option>
              ))}
            </optgroup>
          </select>
        </div>

        {/* Format Info Panel */}
        <div style={{
          padding: '15px',
          backgroundColor: '#2d2d44',
          borderRadius: '4px',
          marginBottom: '20px',
          fontSize: '13px'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
            <strong style={{ color: '#00d9ff' }}>{format.name}</strong>
            <span style={{
              ...styles.parityBadge,
              backgroundColor: PARITY_COLORS[format.parity] + '30',
              color: PARITY_COLORS[format.parity],
              border: `1px solid ${PARITY_COLORS[format.parity]}`
            }}>
              {format.parity.toUpperCase()} PARITY
            </span>
            {format.cardOnly && (
              <span style={{
                ...styles.parityBadge,
                backgroundColor: '#3b82f630',
                color: '#3b82f6',
                border: '1px solid #3b82f6'
              }}>
                CARD-ONLY
              </span>
            )}
            {format.hasIssueLevel && (
              <span style={{
                ...styles.parityBadge,
                backgroundColor: '#8b5cf630',
                color: '#8b5cf6',
                border: '1px solid #8b5cf6'
              }}>
                ISSUE LEVEL
              </span>
            )}
          </div>
          <div style={{ color: '#aaa' }}>{format.description}</div>
          {format.warning && (
            <div style={{ marginTop: '10px', color: '#fbbf24', fontSize: '12px' }}>
              ⚠️ {format.warning}
            </div>
          )}
          <div style={{ marginTop: '10px', display: 'flex', gap: '30px' }}>
            {format.hasIssueLevel && (
              <div>
                <span style={{ color: '#8b5cf6', fontWeight: 'bold' }}>Issue Level: </span>
                <span>0-{format.maxIssueLevel}</span>
              </div>
            )}
            {!format.cardOnly && (
              <div>
                <span style={{ color: '#60a5fa', fontWeight: 'bold' }}>Facility: </span>
                <span>0-{format.facilityMax.toLocaleString()}</span>
              </div>
            )}
            <div>
              <span style={{ color: '#a78bfa', fontWeight: 'bold' }}>Card: </span>
              <span>0-{format.cardMax.toLocaleString()}</span>
            </div>
          </div>
        </div>

        {/* Input Fields */}
        <div style={{ 
          display: 'grid', 
          gridTemplateColumns: format.hasIssueLevel ? '1fr 1fr 1fr' : (format.cardOnly ? '1fr' : '1fr 1fr'),
          gap: '15px', 
          marginBottom: '20px' 
        }}>
          {format.hasIssueLevel && (
            <div>
              <label style={{ display: 'block', marginBottom: '5px', fontSize: '13px', color: '#8b5cf6' }}>
                Issue Level (0-{format.maxIssueLevel})
              </label>
              <input
                type="number"
                min="0"
                max={format.maxIssueLevel}
                value={issueLevel}
                onChange={(e) => setIssueLevel(Number(e.target.value))}
                style={{...styles.input, borderColor: '#8b5cf6'}}
              />
            </div>
          )}
          {!format.cardOnly && (
            <div>
              <label style={{ display: 'block', marginBottom: '5px', fontSize: '13px', color: '#aaa' }}>
                Facility Code (0-{format.facilityMax.toLocaleString()})
              </label>
              <input
                type="number"
                min="0"
                max={format.facilityMax}
                value={facility}
                onChange={(e) => setFacility(Number(e.target.value))}
                style={styles.input}
              />
            </div>
          )}
          <div>
            <label style={{ display: 'block', marginBottom: '5px', fontSize: '13px', color: '#aaa' }}>
              Card Number (0-{format.cardMax.toLocaleString()})
            </label>
            <input
              type="number"
              min="0"
              max={format.cardMax}
              value={card}
              onChange={(e) => setCard(Number(e.target.value))}
              style={styles.input}
            />
          </div>
        </div>

        <button
          onClick={generateBits}
          onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = '#00b8d4'; }}
          onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = '#00d9ff'; }}
          style={styles.button}
        >
          Generate Bit Structure
        </button>

        {error && (
          <div style={{
            marginTop: '15px',
            padding: '10px',
            backgroundColor: '#4d1a1a',
            color: '#ff6b6b',
            borderRadius: '4px',
            fontSize: '14px'
          }}>
            ✗ {error}
          </div>
        )}
      </div>

      {generatedBits && (
        <div style={styles.card}>
          <h4 style={{ marginTop: 0, color: '#00d9ff' }}>Bit Structure Visualization</h4>
          
          <div style={{
            padding: '15px',
            backgroundColor: '#2d2d44',
            borderRadius: '4px',
            marginBottom: '15px',
            fontSize: '13px'
          }}>
            <strong>Binary String:</strong>
            <div style={{
              marginTop: '10px',
              fontFamily: 'monospace',
              fontSize: '16px',
              wordBreak: 'break-all',
              color: '#00d9ff',
              backgroundColor: '#0f3460',
              padding: '10px',
              borderRadius: '4px'
            }}>
              {generatedBits}
            </div>
            <div style={{ marginTop: '10px', color: '#aaa' }}>
              Length: {generatedBits.length} bits
            </div>
          </div>

          <div style={styles.bitContainer}>
            {renderBitStructure()}
          </div>

          {renderLegend()}

          <div style={{ marginTop: '20px' }}>
            <h4 style={{ color: '#00d9ff', marginBottom: '10px' }}>Format Breakdown</h4>
            <div style={{ fontSize: '13px', lineHeight: '1.8' }}>
              {format.structure.map((field, idx) => {
                let startBit = 0;
                for (let i = 0; i < idx; i++) {
                  startBit += format.structure[i].bits;
                }
                const endBit = startBit + field.bits - 1;
                const fieldBits = generatedBits.substring(startBit, startBit + field.bits);
                
                return (
                  <div key={idx} style={{
                    padding: '8px',
                    marginBottom: '5px',
                    backgroundColor: '#2d2d44',
                    borderRadius: '4px',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center'
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <div
                        style={{
                          width: '15px',
                          height: '15px',
                          backgroundColor: COLOR_MAP[field.type] || '#666',
                          borderRadius: '3px'
                        }}
                      />
                      <strong>{field.label}</strong>
                      <span style={{ color: '#aaa' }}>
                        (Bits {startBit}-{endBit}, {field.bits} bit{field.bits > 1 ? 's' : ''})
                      </span>
                    </div>
                    <span style={{
                      fontFamily: 'monospace',
                      color: '#00d9ff',
                      fontSize: '14px'
                    }}>
                      {fieldBits}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default WiegandFormatVisualizer;
