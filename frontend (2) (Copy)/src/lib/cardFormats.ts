// cardFormats.ts
export type CardFormat = {
  id: string;
  label: string;
  frameBits: number;
  facilityBits?: number;
  cardBits?: number;
  parity: 'std' | 'whole-even' | 'whole-odd';
  description?: string;
  isCustom?: boolean;
};

// Fallback formats (used if API fails)
export const CARD_FORMATS_FALLBACK: CardFormat[] = [
  { id:'w26', label:'Wiegand 26 (H10301)', frameBits:26, facilityBits:8, cardBits:16, parity:'std' },
  { id:'w34', label:'Wiegand 34', frameBits:34, facilityBits:16, cardBits:16, parity:'std' },
  { id:'w35c1k', label:'Wiegand 35 (HID Corporate 1000)', frameBits:35, parity:'whole-even' },
  { id:'w37', label:'Wiegand 37 (H10302/H10304)', frameBits:37, parity:'std' },
  { id:'w38', label:'Wiegand 38', frameBits:38, parity:'std' },
  { id:'w40', label:'Wiegand 40', frameBits:40, parity:'std' },
  { id:'w46', label:'Wiegand 46', frameBits:46, parity:'std' },
  { id:'w56', label:'Wiegand 56', frameBits:56, parity:'std' },
  { id:'w64', label:'Wiegand 64', frameBits:64, parity:'std' },
];

/**
 * Fetch formats from API with fallback
 */
export async function fetchCardFormats(): Promise<CardFormat[]> {
  try {
    const response = await fetch('/api/osdp/formats');
    if (!response.ok) {
      throw new Error('API request failed');
    }
    
    const data = await response.json();
    
    if (data.success && data.formats) {
      // Convert API format to CardFormat type
      return data.formats.map(f => ({
        id: f.id,
        label: f.name,
        frameBits: f.bits || f.frameBits,
        facilityBits: f.facilityBits,
        cardBits: f.cardBits,
        parity: f.parity || 'std',
        description: f.description,
        isCustom: f.isCustom
      }));
    }
    
    // Fallback if response invalid
    console.warn('API returned invalid format, using fallback');
    return CARD_FORMATS_FALLBACK;
    
  } catch (error) {
    console.error('Error fetching formats, using fallback:', error);
    return CARD_FORMATS_FALLBACK;
  }
}
